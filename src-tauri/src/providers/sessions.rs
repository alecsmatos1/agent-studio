//! Host-local bindings to CLI-owned transcripts. Never accept a transcript ID or
//! path from a renderer/relay, and never put native transcripts in workspace sync.
use super::RunRequest;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

pub(crate) const STALE_HISTORY: &str =
    "This conversation changed in another window or on another device. Wait for it to sync, then send again.";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    #[serde(default)]
    history_revision: u64,
    version: u32,
    scope: String,
    // Version 2 also records the account and location parts of the scope separately, so a
    // deliberate account switch (same computer and folder, another profile) can be told
    // apart from a chat that was moved. Version 1 bindings carry only the combined scope.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    account: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    location: String,
    id: String,
    history: Vec<String>,
    instructions: String,
    received: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    shared_context: String,
    /// Whether its session has the current rule for pages, in its first message or the reply's
    /// context. A binding written before 2026-11-03 has not, and its transcript says otherwise.
    #[serde(default)]
    pages_rule: bool,
}
impl Record {
    /// Whether the session may still hold the earlier rule for pages.
    fn before_pages_rule(&self) -> bool {
        !self.received || !self.pages_rule
    }
}

#[derive(Clone)]
pub struct Session {
    path: PathBuf,
    // An OS lock is released even if the app crashes. Clones retain ownership.
    _lock: Arc<File>,
    record: Record,
    pub resumed: bool,
    pub retry: bool,
    /// The selected account differs from the bound one: fork its latest native history
    /// into the selected profile, preserving the source and the conversation's folder.
    pub switched_account: bool,
    /// A rewind or file Undo replaced the history since the binding was written.
    pub history_rewritten: bool,
    pub instructions_changed: bool,
    /// The session began under the earlier rule for pages, so this reply's context carries the
    /// current one (`artifacts::pages_rule_changed`), once.
    pub pages_rule_changed: bool,
    pub shared_context_changed: bool,
    pub unconfirmed_message: Option<usize>,
    transfer_from: Option<Record>,
    transfer_file: Option<Arc<tempfile::TempPath>>,
    pub transfer_path: Option<String>,
    /// The first reply of a chat imported from a CLI session, which forks that session.
    import: Option<crate::imports::Record>,
    /// The imported session is no longer on this computer, so the reply starts a new session
    /// from the imported messages.
    pub import_missing: bool,
    /// The bound Claude transcript is gone, deleted by Claude Code's cleanup or by hand, so the
    /// reply starts a new session from the saved messages (`verify_transcript`).
    pub transcript_missing: bool,
}

struct Identity {
    scope: String,
    account: String,
    location: String,
}

fn fingerprint(value: &impl Serialize) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "Cannot encode session identity")?;
    Ok(uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, &bytes).to_string())
}
/// The fingerprints a binding written before the image store recorded for this history: each
/// image with its bytes inline as base64, read from the image store. `None` when the history has
/// no images or this computer does not hold one of them.
fn inline_history(root: &Path, request: &RunRequest) -> Option<Vec<String>> {
    if request
        .messages
        .iter()
        .all(|message| message.images.is_empty())
    {
        return None;
    }
    let images = root.join("images");
    request
        .messages
        .iter()
        .map(|message| {
            let mut inline = message.clone();
            for image in &mut inline.images {
                if image.data.is_none() {
                    let bytes = crate::chat_images::read(&images, image.hash.as_deref()?).ok()?;
                    image.data = Some(STANDARD.encode(bytes));
                }
                image.hash = None;
                image.bytes = None;
            }
            fingerprint(&inline).ok()
        })
        .collect()
}

fn inherited_profile(provider: &str) -> Option<String> {
    std::env::var_os(if provider == "codex" {
        "CODEX_HOME"
    } else {
        "CLAUDE_CONFIG_DIR"
    })
    .map(|p| p.to_string_lossy().into_owned())
}

/// The combined scope. Its encoding must stay stable: version 1 bindings compare against it.
pub(crate) fn scope(
    provider: &str,
    location: Option<&crate::folders::ChatLocation>,
) -> Result<String, String> {
    let profile = crate::profiles::current();
    fingerprint(&serde_json::json!({
        "provider": provider, "connection": profile.id,
        "profile": profile.root, "isolated": profile.isolated,
        "distribution": profile.distribution, "folderDistribution": profile.folder_distribution,
        "namespace": profile.namespace, "location": location,
        "inheritedProfile": inherited_profile(provider),
    }))
}

/// The part of the scope that must not change for a conversation: provider, execution
/// environment, app installation namespace, and folder. Accounts are excluded on purpose.
pub(crate) fn location_scope(
    provider: &str,
    location: Option<&crate::folders::ChatLocation>,
) -> Result<String, String> {
    let profile = crate::profiles::current();
    fingerprint(&serde_json::json!({
        "provider": provider, "distribution": profile.distribution,
        "folderDistribution": profile.folder_distribution,
        "namespace": profile.namespace, "location": location,
    }))
}

fn identity(
    provider: &str,
    location: Option<&crate::folders::ChatLocation>,
) -> Result<Identity, String> {
    let profile = crate::profiles::current();
    Ok(Identity {
        scope: scope(provider, location)?,
        account: fingerprint(&serde_json::json!({
            "connection": profile.id, "profile": profile.root, "isolated": profile.isolated,
            "inheritedProfile": inherited_profile(provider),
        }))?,
        location: location_scope(provider, location)?,
    })
}

fn valid(record: &Record) -> bool {
    matches!(record.version, 1 | 2)
        && uuid::Uuid::parse_str(&record.id).is_ok()
        && !record.history.is_empty()
        && (record.version == 1 || (!record.account.is_empty() && !record.location.is_empty()))
}

/// A version 2 binding for the same computer and folder under another account.
// A terminal login turned into a separate profile keeps its connection id while its earlier
// native history stays in the terminal directory, so that directory is also a transfer source.
/// Whether two profile roots are the same directory, as two accounts linked to this computer's
/// Claude directory report it.
fn same_directory(a: &Path, b: &Path) -> bool {
    let normal = |p: &Path| {
        let text = p.to_string_lossy().replace('/', "\\");
        let text = text.trim_end_matches('\\').to_string();
        if cfg!(windows) {
            text.to_lowercase()
        } else {
            text
        }
    };
    normal(a) == normal(b)
}
fn source_variants(profile: crate::profiles::Profile) -> Vec<crate::profiles::Profile> {
    let mut variants = vec![profile.clone()];
    if profile.isolated {
        variants.push(crate::profiles::Profile {
            root: None,
            isolated: false,
            shared_source: None,
            shared_error: None,
            ..profile
        });
    }
    variants
}

fn other_account(record: &Record, identity: &Identity) -> bool {
    record.version >= 2
        && record.scope != identity.scope
        && record.location == identity.location
        && record.account != identity.account
}

/// Read an existing binding without creating a session, taking its run lock, or changing history.
pub fn bound_id(
    root: &Path,
    conversation: &str,
    provider: &str,
    location: Option<&crate::folders::ChatLocation>,
) -> Result<Option<String>, String> {
    use std::io::Read;
    let conversation =
        uuid::Uuid::parse_str(conversation).map_err(|_| "Invalid conversation id")?;
    let file = match File::open(
        root.join("native-sessions")
            .join(format!("{conversation}.json")),
    ) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read the native session binding".into()),
    };
    let mut bytes = Vec::new();
    (&file)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read the native session binding")?;
    let record: Record =
        serde_json::from_slice(&bytes).map_err(|_| "The native session binding is unreadable")?;
    let identity = identity(provider, location)?;
    if !valid(&record) {
        return Err("The native session binding is unreadable".into());
    }
    if other_account(&record, &identity) {
        return Err("This conversation's native session belongs to its previously selected account. Send a message to start a session for the selected account.".into());
    }
    if record.scope != identity.scope {
        return Err(
            "The native session does not match this conversation's account, computer, and folder"
                .into(),
        );
    }
    Ok(Some(record.id))
}

impl Session {
    pub fn prepare(root: &Path, request: &RunRequest) -> Result<Option<Self>, String> {
        let Some(conversation) = &request.conversation_id else {
            return Ok(None);
        };
        if !request.tools_enabled()
            || !matches!(request.agent.provider.as_str(), "claude" | "codex")
        {
            return Ok(None);
        }
        let conversation =
            uuid::Uuid::parse_str(conversation).map_err(|_| "Invalid conversation id")?;
        let identity = identity(&request.agent.provider, request.location.as_ref())?;
        let history = request
            .messages
            .iter()
            .map(fingerprint)
            .collect::<Result<Vec<_>, _>>()?;
        let instructions = fingerprint(&request.agent.instructions)?;
        let shared_context = if request.shared_context.source.is_empty() {
            String::new()
        } else {
            fingerprint(&request.shared_context)?
        };
        let directory = root.join("native-sessions");
        std::fs::create_dir_all(&directory)
            .map_err(|_| "Cannot create native session directory")?;
        let path = directory.join(format!("{conversation}.json"));
        let lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join(format!("{conversation}.lock")))
            .map_err(|_| "Cannot open native session lock")?;
        lock.try_lock().map_err(|_| {
            "This conversation is already running in another app window. Wait for it to finish."
        })?;
        let mut previous: Option<Record> = match std::fs::read(&path) {
            Ok(bytes) => Some(serde_json::from_slice(&bytes).map_err(|_| {
                "Native session binding is unreadable. It was preserved; start a new conversation."
            })?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("Cannot read native session binding".into()),
        };
        // A binding written before the image store fingerprinted each image with its bytes
        // inline. A history that continues it once its images read as they were then is the same
        // history, and the binding records references from this reply on.
        if let Some(previous) = previous.as_mut() {
            if !history.starts_with(&previous.history) {
                if let Some(inline) = inline_history(root, request) {
                    if inline.starts_with(&previous.history) {
                        previous.history = history[..previous.history.len()].to_vec();
                    }
                }
            }
        }
        // A chat imported from a CLI session has no binding until its first reply binds one.
        let import = match &previous {
            Some(_) => None,
            None => crate::imports::record(root, &conversation.to_string())?,
        };
        if import
            .as_ref()
            .is_some_and(|i| i.source.provider != request.agent.provider)
        {
            return Err("This chat was imported for another agent.".into());
        }
        let mut switched_account = false;
        let mut history_rewritten = false;
        if import.is_some() {
            // Its first reply forks the imported session, unless a rewind since the import
            // replaced the history that session holds.
            if request.history_revision > 0 {
                history_rewritten = true;
            } else {
                switched_account = true;
            }
        }
        if let Some(previous) = &previous {
            if !valid(previous) {
                return Err("Native session binding is invalid. It was preserved; start a new conversation.".into());
            }
            if previous.scope != identity.scope {
                // A version 2 binding proves only the account changed. Version 1 bindings
                // cannot tell an account switch from a moved chat, so they require the
                // renderer's explicit account-switch request instead of guessing.
                if !(other_account(previous, &identity)
                    || (previous.version == 1 && request.account_switch))
                {
                    return Err("This conversation's native session belongs to a different account, computer, or folder. Start a new conversation there.".into());
                }
                switched_account = true;
            }
            if request.history_revision < previous.history_revision {
                return Err(STALE_HISTORY.into());
            }
            let continues = history.starts_with(&previous.history);
            // Ordinary follow-ups add the previous final answer (or answered
            // question context after interruption), followed by one human input.
            let unseen = continues
                && history.len() > previous.history.len()
                && request.messages[previous.history.len()..request.messages.len() - 1]
                    .iter()
                    .any(|m| {
                        m.role != "assistant"
                            && !m
                                .text
                                .starts_with("\n\nUser question responses (earlier context):\n")
                            && !m.text.starts_with(
                                "\n\nUser steering accepted during this reply (earlier context):\n",
                            )
                    });
            if request.history_revision == previous.history_revision {
                if !continues {
                    return Err("This conversation's history differs from its native session. Start a new conversation to keep the histories separate.".into());
                }
                if unseen {
                    return Err("This conversation has messages the native session has not received. Start a new conversation to include the saved history.".into());
                }
            } else {
                // Rewind and file Undo advance the history revision. Unless the retained
                // history still continues exactly what the native session received (Undo
                // rewind), its transcript holds discarded context: it is neither resumed nor
                // carried to another account, and a fresh session gets the retained messages.
                history_rewritten = !continues || unseen;
            }
        }
        if request.compact && history_rewritten {
            return Err("Send a message before compacting. After a rewind or file Undo, the next reply starts a new native session.".into());
        }
        if request.compact && (previous.is_none() || switched_account) {
            return Err("Send a message with this account first to establish its native session before compacting.".into());
        }
        // Retrying the same request under another account still continues the earlier
        // attempt's work instead of treating it as a new independent task.
        let retry = previous.as_ref().is_some_and(|p| p.history == history);
        let previous = previous.filter(|_| !history_rewritten);
        let import = import.filter(|_| switched_account);
        let transfer_from = previous.clone().filter(|_| switched_account).or_else(|| {
            import.as_ref().map(|import| Record {
                history_revision: 0,
                version: 2,
                scope: String::new(),
                account: String::new(),
                location: String::new(),
                id: import.session.clone(),
                history: vec![],
                instructions: String::new(),
                received: true,
                shared_context: String::new(),
                pages_rule: true,
            })
        });
        let shared_context_changed = previous
            .as_ref()
            .is_some_and(|p| p.shared_context != shared_context);
        // Allocate a destination identity; prepare_transfer must succeed before sending.
        let previous = previous.filter(|_| !switched_account);
        Ok(Some(Self {
            path,
            _lock: Arc::new(lock),
            resumed: previous.is_some(),
            retry,
            switched_account,
            history_rewritten,
            shared_context_changed,
            transfer_from,
            transfer_file: None,
            transfer_path: None,
            import,
            import_missing: false,
            transcript_missing: false,
            instructions_changed: previous
                .as_ref()
                .is_some_and(|p| !p.received || p.instructions != instructions),
            pages_rule_changed: previous.as_ref().is_some_and(Record::before_pages_rule),
            unconfirmed_message: previous
                .as_ref()
                .filter(|p| !p.received)
                .map(|p| p.history.len() - 1),
            record: Record {
                history_revision: request.history_revision,
                version: 2,
                scope: identity.scope,
                account: identity.account,
                location: identity.location,
                id: previous
                    .map(|p| p.id)
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                history,
                instructions,
                received: false,
                shared_context,
                pages_rule: true,
            },
        }))
    }

    pub fn id(&self) -> &str {
        &self.record.id
    }
    pub fn transfer_id(&self) -> Option<&str> {
        self.transfer_path
            .as_ref()
            .and(self.transfer_from.as_ref())
            .map(|record| record.id.as_str())
    }

    /// Resolve the previous profile from the host's registry, never a caller-supplied path.
    /// The caller releases its old parked process before taking this immutable snapshot.
    pub async fn prepare_transfer(
        &mut self,
        app: &tauri::AppHandle,
        request: &RunRequest,
    ) -> Result<(), String> {
        use tauri::Manager;
        let Some(previous) = self.transfer_from.as_ref() else {
            return Ok(());
        };
        if let Some(import) = self.import.clone() {
            return self.prepare_import(app, request, import).await;
        }
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "Cannot locate app data")?;
        let bytes = crate::saved::bytes(&root).map_err(|_| "Cannot read account registry")?;
        let workspace: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "Cannot read account registry")?;
        let provider = &request.agent.provider;
        let selected = crate::profiles::current();
        let mut candidates = vec![None];
        candidates.extend(
            workspace["fleet"]["connections"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| c["id"].as_str().map(|id| Some(id.to_string()))),
        );
        let mut source = None;
        'connections: for connection in candidates {
            let Ok(mut profile) = crate::profiles::resolve(app, provider, connection.as_deref())
            else {
                continue;
            };
            profile.folder_distribution = selected.folder_distribution.clone();
            for variant in source_variants(profile) {
                let matches = crate::profiles::scope(variant.clone(), async {
                    identity(provider, request.location.as_ref())
                        .is_ok_and(|i| i.scope == previous.scope)
                })
                .await;
                if matches {
                    source = Some(
                        crate::profiles::scope(variant, async {
                            crate::context::native_profile_root(provider).await
                        })
                        .await?,
                    );
                    break 'connections;
                }
            }
        }
        let source = source.ok_or("The previous account profile is unavailable. Reconnect it before transferring this chat; its saved history was preserved.")?;
        let target = crate::context::native_profile_root(provider).await?;
        // Accounts linked to the same Claude directory (`linking`) read the same transcripts: the
        // chosen account continues the session where it is, and nothing is copied.
        if provider == "claude" && same_directory(&source, &target) {
            self.record.id = previous.id.clone();
            self.resumed = true;
            self.instructions_changed = true;
            self.pages_rule_changed = previous.before_pages_rule();
            self.unconfirmed_message = (!previous.received).then_some(previous.history.len() - 1);
            return Ok(());
        }
        if provider == "claude" {
            // A transcript Claude Code's cleanup deleted leaves the saved messages to continue.
            let (config, id) = (source.clone(), previous.id.clone());
            let present =
                tokio::task::spawn_blocking(move || claude_transcript(&config, &id, None))
                    .await
                    .ok()
                    .flatten();
            if present == Some(false) {
                self.transfer_from = None;
                self.start_over();
                return Ok(());
            }
        }
        let snapshot = snapshot_off_thread(source, target, provider, &previous.id, None).await?;
        let native =
            crate::shared_context::native_path(&snapshot, selected.distribution.as_deref())?;
        self.transfer_path = Some(native);
        self.transfer_file = Some(Arc::new(snapshot));
        self.resumed = true;
        // Refresh conversation instructions while leaving provider-native history intact.
        self.instructions_changed = true;
        self.pages_rule_changed = previous.before_pages_rule();
        self.unconfirmed_message = (!previous.received).then_some(previous.history.len() - 1);
        Ok(())
    }

    /// Whether this reply is the first of a chat imported from a CLI session.
    pub fn imported(&self) -> Option<&str> {
        self.import.as_ref().map(|i| i.source.provider.as_str())
    }

    /// Forks an imported chat's session from the source the import recorded on this computer,
    /// into the selected account's profile, leaving the original as it was. A session that is
    /// no longer there leaves this reply to start a new one from the imported messages.
    async fn prepare_import(
        &mut self,
        app: &tauri::AppHandle,
        request: &RunRequest,
        import: crate::imports::Record,
    ) -> Result<(), String> {
        let source = match crate::imports::source_root(app, &import.source).await {
            Ok(source) => source,
            Err(_) => return self.import_unavailable(),
        };
        let target = crate::context::native_profile_root(&request.agent.provider).await?;
        self.fork_import(source, target, request, import).await
    }

    /// Copies the imported session from its source profile into the selected one, where the
    /// reply forks it.
    pub(crate) async fn fork_import(
        &mut self,
        source: PathBuf,
        target: PathBuf,
        request: &RunRequest,
        import: crate::imports::Record,
    ) -> Result<(), String> {
        let provider = &request.agent.provider;
        let selected = crate::profiles::current();
        let found = {
            let (source, provider, id) = (source.clone(), provider.clone(), import.session.clone());
            let path = import.path.clone();
            tokio::task::spawn_blocking(move || match path {
                // The very transcript the chat was imported from.
                Some(relative) => Ok(crate::imports::transcript_in(
                    &source,
                    &source.join(relative),
                    &id,
                )),
                None => crate::native_instructions::find_record(&source, &provider, &id),
            })
            .await
            .map_err(|_| "Cannot read the imported session")??
        };
        let Some(found) = found else {
            return self.import_unavailable();
        };
        let snapshot =
            snapshot_off_thread(source, target, provider, &import.session, Some(found)).await?;
        self.transfer_path = Some(crate::shared_context::native_path(
            &snapshot,
            selected.distribution.as_deref(),
        )?);
        self.transfer_file = Some(Arc::new(snapshot));
        self.resumed = true;
        self.instructions_changed = !request.agent.instructions.trim().is_empty();
        Ok(())
    }

    fn import_unavailable(&mut self) -> Result<(), String> {
        self.transfer_from = None;
        self.import_missing = true;
        Ok(())
    }

    /// Claude Code deletes a transcript some time after its last write (`retention`), and the
    /// Claude app, the terminal or the user may as well. A reply that would resume a Claude session
    /// whose transcript is gone starts a new session from the saved messages instead, as after a
    /// rewind, and reports whether it did. Only a transcript known to be missing counts: when the
    /// profile's transcripts cannot be read, the CLI resumes as before. `cwd` is the folder the
    /// CLI runs in, which names the transcript's folder.
    pub async fn verify_transcript(
        &mut self,
        exe: &crate::providers::Executable,
        cwd: Option<String>,
    ) -> bool {
        if exe.provider != "claude" || !self.resumed || self.transfer_path.is_some() {
            return false;
        }
        let Ok(config) = crate::context::resolved_profile_root(exe).await else {
            return false;
        };
        let id = self.id().to_string();
        let present =
            tokio::task::spawn_blocking(move || claude_transcript(&config, &id, cwd.as_deref()))
                .await
                .ok()
                .flatten();
        if present != Some(false) {
            return false;
        }
        self.start_over();
        true
    }

    /// A new native session, bootstrapped from the saved messages, replaces the bound one.
    fn start_over(&mut self) {
        self.resumed = false;
        self.transcript_missing = true;
        self.instructions_changed = false;
        self.pages_rule_changed = false;
        self.shared_context_changed = false;
        self.unconfirmed_message = None;
        self.record.id = uuid::Uuid::new_v4().to_string();
    }

    // Persist immediately when the provider confirms its parent identity, before
    // forwarding further output, so stopped/failed replies can resume as well.
    pub fn bind(&self, id: &str, received: bool) -> Result<(), String> {
        uuid::Uuid::parse_str(id)
            .map_err(|_| "The provider returned an invalid native session identity")?;
        if self.resumed && self.transfer_path.is_none() && id != self.id() {
            return Err(
                "The provider did not resume the requested native session. The reply was stopped."
                    .into(),
            );
        }
        let mut record = self.record.clone();
        record.id = id.into();
        record.received = received;
        let mut file = tempfile::NamedTempFile::new_in(self.path.parent().unwrap())
            .map_err(|_| "Cannot prepare native session binding")?;
        file.write_all(
            &serde_json::to_vec(&record).map_err(|_| "Cannot encode native session binding")?,
        )
        .map_err(|_| "Cannot save native session binding")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "Cannot flush native session binding")?;
        file.persist(&self.path)
            .map_err(|_| "Cannot replace native session binding")?;
        Ok(())
    }
}

/// A transcript, or the recorded prefix of a history ancestor, validated as it is copied into
/// the destination profile.
struct Transcript {
    path: PathBuf,
    copy: tempfile::NamedTempFile,
    len: u64,
    base: Option<(String, u64)>,
    prefix: bool,
}
/// `path` names the transcript when the caller already found it; otherwise it is found by id.
/// The copy streams, so an account switch or an import carries a session whole, however long.
fn read_transcript(
    source: &Path,
    target: &Path,
    provider: &str,
    id: &str,
    path: Option<PathBuf>,
    prefix: Option<u64>,
) -> Result<Transcript, String> {
    use std::io::{BufRead, BufReader, BufWriter, Read};
    let path = match path {
        Some(path) => path,
        None => crate::native_instructions::find_record(source, provider, id)?.ok_or(
            "The previous native transcript or its history ancestor is unavailable. No display-history fallback was sent.",
        )?,
    };
    if prefix == Some(0) {
        return Err("The native history boundary is invalid".into());
    }
    let mut copy = tempfile::Builder::new()
        .prefix("studio-transfer-")
        .suffix(".jsonl")
        .tempfile_in(target)
        .map_err(|_| "Cannot prepare the native transcript snapshot")?;
    let file = File::open(&path).map_err(|_| "Cannot read the bound native transcript")?;
    let mut reader = BufReader::with_capacity(1024 * 1024, file.take(prefix.unwrap_or(u64::MAX)));
    let mut writer = BufWriter::with_capacity(1024 * 1024, copy.as_file_mut());
    let mut line = Vec::new();
    let mut len = 0u64;
    let mut verified = false;
    let mut base = None;
    loop {
        line.clear();
        let read = reader
            .read_until(b'\n', &mut line)
            .map_err(|_| "Cannot read the bound native transcript")?;
        if read == 0 {
            break;
        }
        len += read as u64;
        if !line.ends_with(b"\n") {
            if prefix.is_some_and(|size| len != size) {
                return Err(
                    "The native history ancestor is shorter than its recorded boundary".into(),
                );
            }
            return Err(
                "The native transcript has an unfinished record. Retry after its writer finishes."
                    .into(),
            );
        }
        if !line.iter().all(u8::is_ascii_whitespace) {
            let record: serde_json::Value = serde_json::from_slice(&line).map_err(|_| {
                "The native transcript is malformed; no partial history was transferred"
            })?;
            if provider == "codex" && record["type"] == "session_meta" {
                if verified || record["payload"]["id"] != id {
                    return Err("The native transcript identity does not match its binding".into());
                }
                verified = true;
                let meta = &record["payload"];
                if !meta["history_base"].is_null() {
                    let parent = meta["history_base"]["thread_id"]
                        .as_str()
                        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                        .ok_or("The native history ancestor identity is invalid")?;
                    let end = meta["history_base"]["end_byte_offset"]
                        .as_u64()
                        .ok_or("The native history ancestor boundary is invalid")?;
                    if meta["history_mode"] != "paginated"
                        || meta["history_base"]["end_ordinal_exclusive"]
                            .as_u64()
                            .is_none()
                        || meta["forked_from_id"]
                            .as_str()
                            .is_some_and(|id| id != parent)
                    {
                        return Err(
                            "The native history lineage is unsupported or inconsistent".into()
                        );
                    }
                    base = Some((parent.into(), end));
                }
            } else if provider == "claude" {
                if let Some(session) = record["sessionId"].as_str() {
                    if session != id {
                        return Err(
                            "The native transcript identity does not match its binding".into()
                        );
                    }
                    verified = true;
                }
            }
        }
        writer
            .write_all(&line)
            .map_err(|_| "Cannot write the native transcript snapshot")?;
    }
    if prefix.is_some_and(|size| len != size) {
        return Err("The native history ancestor is shorter than its recorded boundary".into());
    }
    if len == 0 {
        return Err(
            "The native transcript has an unfinished record. Retry after its writer finishes."
                .into(),
        );
    }
    if !verified {
        return Err("The native transcript has no verified session identity".into());
    }
    writer
        .flush()
        .map_err(|_| "Cannot write the native transcript snapshot")?;
    drop(writer);
    copy.as_file()
        .sync_all()
        .map_err(|_| "Cannot flush the native transcript snapshot")?;
    Ok(Transcript {
        path,
        copy,
        len,
        base,
        prefix: prefix.is_some(),
    })
}

/// Whether a file already in the destination holds exactly the copied transcript, or begins
/// with the copied prefix of an ancestor.
fn same_history(existing: &Path, record: &Transcript) -> Result<bool, String> {
    use std::io::{BufReader, Read};
    let unreadable = "Cannot inspect the existing native transcript";
    let file = File::open(existing).map_err(|_| unreadable)?;
    let size = file.metadata().map_err(|_| unreadable)?.len();
    if size < record.len || (!record.prefix && size != record.len) {
        return Ok(false);
    }
    let mut left = BufReader::new(file.take(record.len));
    let mut right = BufReader::new(File::open(record.copy.path()).map_err(|_| unreadable)?);
    let (mut a, mut b) = (vec![0; 64 * 1024], vec![0; 64 * 1024]);
    loop {
        let read = left.read(&mut a).map_err(|_| unreadable)?;
        if read == 0 {
            return Ok(right.read(&mut b[..1]).map_err(|_| unreadable)? == 0);
        }
        right.read_exact(&mut b[..read]).map_err(|_| unreadable)?;
        if a[..read] != b[..read] {
            return Ok(false);
        }
    }
}

fn transcript_snapshot(
    source: &Path,
    target: &Path,
    provider: &str,
    id: &str,
    path: Option<PathBuf>,
) -> Result<tempfile::TempPath, String> {
    std::fs::create_dir_all(target).map_err(|_| "Cannot access the selected profile")?;
    let current = read_transcript(source, target, provider, id, path, None)?;
    let mut records = vec![current];
    let mut visited = std::collections::HashSet::from([id.to_string()]);
    while let Some((parent, end)) = records.last().and_then(|r| r.base.clone()) {
        if !visited.insert(parent.clone()) {
            return Err("The native history lineage is cyclic".into());
        }
        let record = read_transcript(source, target, provider, &parent, None, Some(end))?;
        records.push(record);
    }
    if provider == "codex" {
        // Native forks retain paginated ancestry. Keep each verified ancestor in the
        // destination profile for later resume/fork, including only its recorded prefix.
        // The random snapshot remains temporary; CLI-owned imported rollouts remain.
        let source_root = source
            .canonicalize()
            .map_err(|_| "Cannot resolve source profile")?;
        let mut imports = Vec::new();
        for record in records.iter().rev() {
            let relative = record
                .path
                .strip_prefix(&source_root)
                .map_err(|_| "Transcript is outside its source profile")?;
            let destination = target.join(relative);
            if destination.exists() {
                // A chat continuing in the profile it came from forks its own rollout.
                if destination.canonicalize().ok().as_ref() == Some(&record.path) {
                    continue;
                }
                if !same_history(&destination, record)? {
                    return Err("A different transcript already exists in the selected profile. Both copies were preserved.".into());
                }
            } else {
                imports.push((destination, record));
            }
        }
        // Validate the entire lineage and existing destinations before writing any import.
        for (destination, record) in imports {
            std::fs::create_dir_all(destination.parent().unwrap())
                .map_err(|_| "Cannot prepare native session storage")?;
            let mut file = tempfile::NamedTempFile::new_in(destination.parent().unwrap())
                .map_err(|_| "Cannot stage native history")?;
            std::io::copy(
                &mut File::open(record.copy.path()).map_err(|_| "Cannot write native history")?,
                file.as_file_mut(),
            )
            .map_err(|_| "Cannot write native history")?;
            file.as_file()
                .sync_all()
                .map_err(|_| "Cannot flush native history")?;
            file.persist_noclobber(&destination).map_err(|_| {
                "Cannot stage the native transcript without replacing existing history"
            })?;
        }
    }
    Ok(records.swap_remove(0).copy.into_temp_path())
}

/// Copies a transcript off the async runtime: an imported session can be hundreds of megabytes.
async fn snapshot_off_thread(
    source: PathBuf,
    target: PathBuf,
    provider: &str,
    id: &str,
    path: Option<PathBuf>,
) -> Result<tempfile::TempPath, String> {
    let (provider, id) = (provider.to_string(), id.to_string());
    tokio::task::spawn_blocking(move || transcript_snapshot(&source, &target, &provider, &id, path))
        .await
        .map_err(|_| "Cannot copy the native transcript".to_string())?
}

/// Whether the Claude profile at `config` holds the transcript of session `id`, kept as
/// `projects/<folder>/<id>.jsonl` where the folder is named after the one the CLI ran in, every
/// character but ASCII letters and digits turned into `-`. That name is tried first, then every
/// project folder, since a folder can be moved or named differently. `None` when the projects
/// folder cannot be read.
fn claude_transcript(config: &Path, id: &str, cwd: Option<&str>) -> Option<bool> {
    let projects = config.join("projects");
    let name = format!("{id}.jsonl");
    if let Some(cwd) = cwd {
        let folder: String = cwd
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        // Claude Code shortens longer names with a hash this does not compute.
        if folder.len() <= 200 && projects.join(folder).join(&name).is_file() {
            return Some(true);
        }
    }
    for entry in std::fs::read_dir(&projects).ok()? {
        if entry.ok()?.path().join(&name).is_file() {
            return Some(true);
        }
    }
    Some(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_transfers_keep_paginated_ancestors_and_their_exact_recorded_prefixes() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let parent = uuid::Uuid::new_v4().to_string();
        let child = uuid::Uuid::new_v4().to_string();
        let directory = source.path().join("sessions/2026/09/20");
        std::fs::create_dir_all(&directory).unwrap();
        let name = |id: &str| format!("rollout-2026-09-20-{id}.jsonl");
        let ancestor = format!(
            "{}\n{}\n",
            json!({"type":"session_meta","payload":{"id":parent}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","output":"tool-only context"}})
        );
        let source_bytes = format!(
            "{ancestor}{}\n",
            json!({"type":"response_item","payload":{"type":"message","content":"later branch content excluded"}})
        );
        std::fs::write(directory.join(name(&parent)), &source_bytes).unwrap();
        let leaf = format!(
            "{}\n",
            json!({"type":"session_meta","payload":{"id":child,"history_mode":"paginated","forked_from_id":parent,"history_base":{"thread_id":parent,"end_byte_offset":ancestor.len(),"end_ordinal_exclusive":2}}})
        );
        std::fs::write(directory.join(name(&child)), &leaf).unwrap();
        let temporary =
            transcript_snapshot(source.path(), target.path(), "codex", &child, None).unwrap();
        drop(temporary);
        let imported = target.path().join("sessions/2026/09/20");
        assert_eq!(
            std::fs::read_to_string(imported.join(name(&parent))).unwrap(),
            ancestor
        );
        assert_eq!(
            std::fs::read_to_string(imported.join(name(&child))).unwrap(),
            leaf
        );
        assert_eq!(
            std::fs::read_to_string(directory.join(name(&parent))).unwrap(),
            source_bytes
        );
        // A subsequent transfer can resolve the entire native lineage from the recipient.
        let next = tempfile::tempdir().unwrap();
        transcript_snapshot(target.path(), next.path(), "codex", &child, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(next.path().join("sessions/2026/09/20").join(name(&parent)))
                .unwrap(),
            ancestor
        );
        // Existing longer original histories are preserved when returning to their account.
        transcript_snapshot(target.path(), source.path(), "codex", &child, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(directory.join(name(&parent))).unwrap(),
            source_bytes
        );
        std::fs::remove_file(directory.join(name(&parent))).unwrap();
        let missing_target = tempfile::tempdir().unwrap();
        assert!(
            transcript_snapshot(source.path(), missing_target.path(), "codex", &child, None,)
                .unwrap_err()
                .contains("ancestor is unavailable")
        );
        assert_eq!(std::fs::read_dir(missing_target.path()).unwrap().count(), 0);
    }

    #[test]
    fn codex_rejects_cyclic_or_incomplete_lineage_before_importing_anything() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let directory = source.path().join("sessions/2026/09/20");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("rollout-2026-09-20-{id}.jsonl"));
        let row = json!({"type":"session_meta","payload":{"id":id,"history_mode":"paginated","history_base":{"thread_id":id,"end_byte_offset":1,"end_ordinal_exclusive":1}}});
        std::fs::write(path, format!("{row}\n")).unwrap();
        assert!(
            transcript_snapshot(source.path(), target.path(), "codex", &id, None,)
                .unwrap_err()
                .contains("cyclic")
        );
        assert_eq!(std::fs::read_dir(target.path()).unwrap().count(), 0);
    }

    #[test]
    fn account_transfer_snapshots_only_the_bound_complete_transcript() {
        for provider in ["codex", "claude"] {
            let source = tempfile::tempdir().unwrap();
            let target = tempfile::tempdir().unwrap();
            let id = uuid::Uuid::new_v4().to_string();
            let parent = source.path().join(if provider == "codex" {
                "sessions/2026/09/20"
            } else {
                "projects/fixture"
            });
            std::fs::create_dir_all(&parent).unwrap();
            let path = parent.join(if provider == "codex" {
                format!("rollout-2026-09-20-{id}.jsonl")
            } else {
                format!("{id}.jsonl")
            });
            let record = if provider == "codex" {
                json!({"type":"session_meta","payload":{"id":id}})
            } else {
                json!({"type":"user","sessionId":id,"message":{"content":"fixture"}})
            };
            let bytes = format!("{record}\n");
            std::fs::write(&path, &bytes).unwrap();
            std::fs::write(target.path().join("auth.json"), "do-not-copy-or-change").unwrap();
            let snapshot =
                transcript_snapshot(source.path(), target.path(), provider, &id, None).unwrap();
            assert_eq!(std::fs::read(&snapshot).unwrap(), bytes.as_bytes());
            assert_eq!(std::fs::read(&path).unwrap(), bytes.as_bytes());
            assert_eq!(
                std::fs::read_to_string(target.path().join("auth.json")).unwrap(),
                "do-not-copy-or-change"
            );
            let snapshot_path = snapshot.to_path_buf();
            drop(snapshot);
            assert!(!snapshot_path.exists());
            std::fs::write(&path, record.to_string()).unwrap();
            assert!(
                transcript_snapshot(source.path(), target.path(), provider, &id, None,)
                    .unwrap_err()
                    .contains("unfinished")
            );
            std::fs::write(&path, "{broken}\n").unwrap();
            assert!(
                transcript_snapshot(source.path(), target.path(), provider, &id, None,)
                    .unwrap_err()
                    .contains("malformed")
            );
            let foreign = bytes.replace(&id, &uuid::Uuid::new_v4().to_string());
            std::fs::write(&path, foreign).unwrap();
            assert!(
                transcript_snapshot(source.path(), target.path(), provider, &id, None,)
                    .unwrap_err()
                    .contains("identity")
            );
        }
    }

    #[tokio::test]
    async fn transferred_sessions_keep_native_context_and_disable_removed_shared_sources() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let a = profile("claude");
        let mut b = a.clone();
        b.id = uuid::Uuid::new_v4().to_string();
        r.shared_context.source = "shared-source".into();
        crate::profiles::scope(a, async {
            let s = Session::prepare(root.path(), &r).unwrap().unwrap();
            s.bind(s.id(), true).unwrap();
        })
        .await;
        r.messages.extend([
            message("assistant", "READY"),
            message("user", "Recall tool output"),
        ]);
        r.shared_context = Default::default();
        let mut switched = crate::profiles::scope(b, async {
            Session::prepare(root.path(), &r).unwrap().unwrap()
        })
        .await;
        switched.resumed = true;
        switched.transfer_path = Some("host-owned-snapshot.jsonl".into());
        assert!(switched.shared_context_changed);
        r.native_session = Some(switched);
        let context = r.native_context().unwrap();
        assert!(context.contains("sharing is now disabled"));
        assert!(!context.contains("READY") && !context.contains("earlier context only"));
        assert!(!r.native_image_message(0));
        let returned = uuid::Uuid::new_v4().to_string();
        r.native_session
            .as_ref()
            .unwrap()
            .bind(&returned, false)
            .unwrap();
        assert_eq!(saved(r.native_session.as_ref().unwrap()).id, returned);
    }

    #[tokio::test]
    async fn a_terminal_login_made_separate_is_detected_as_an_account_switch_with_its_old_source() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let terminal = profile("codex");
        let mut separate = terminal.clone();
        separate.root = Some(PathBuf::from("C:/profiles/codex/separate"));
        separate.isolated = true;
        crate::profiles::scope(terminal.clone(), async {
            let s = Session::prepare(root.path(), &r).unwrap().unwrap();
            s.bind(s.id(), true).unwrap();
        })
        .await;
        r.messages
            .extend([message("assistant", "READY"), message("user", "Continue")]);
        let switched = crate::profiles::scope(separate.clone(), async {
            Session::prepare(root.path(), &r).unwrap().unwrap()
        })
        .await;
        assert!(switched.switched_account);
        let variants = source_variants(separate.clone());
        assert_eq!(variants.len(), 2);
        assert!(variants[1].root.is_none() && !variants[1].isolated);
        assert_eq!(variants[1].id, separate.id);
        let previous = saved(&switched).scope;
        let reproduced = crate::profiles::scope(variants[1].clone(), async {
            identity(&r.agent.provider, None).unwrap().scope
        })
        .await;
        assert_eq!(reproduced, previous);
        assert_eq!(source_variants(terminal).len(), 1);
    }
    #[test]
    fn a_binding_from_before_the_image_store_continues_once_its_images_are_references() {
        let root = tempfile::tempdir().unwrap();
        let png = STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=")
            .unwrap();
        let mut r = request();
        r.messages[0] = serde_json::from_value(json!({"role":"user","text":"Look","images":[{"id":uuid::Uuid::new_v4(),"name":"shot.png","mediaType":"image/png","data":STANDARD.encode(&png)}]})).unwrap();
        // A reply sent while images traveled inline records the binding.
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        session.bind(session.id(), true).unwrap();
        let bound = session.id().to_string();
        drop(session);
        // The image then moves into the store, and the next reply names it by hash.
        let stored = crate::chat_images::store(&root.path().join("images"), &png).unwrap();
        let image = &mut r.messages[0].images[0];
        (image.data, image.hash, image.bytes) =
            (None, Some(stored.hash.clone()), Some(stored.bytes));
        r.messages.push(message("assistant", "A small square"));
        r.messages.push(message("user", "And now?"));
        let resumed = Session::prepare(root.path(), &r).unwrap().unwrap();
        assert!(resumed.resumed);
        assert_eq!(resumed.id(), bound);
        resumed.bind(resumed.id(), true).unwrap();
        drop(resumed);
        // The binding now records references, so it continues without the bytes.
        std::fs::remove_file(root.path().join("images").join(&stored.hash)).unwrap();
        r.messages.push(message("assistant", "Still a square"));
        r.messages.push(message("user", "Once more"));
        let again = Session::prepare(root.path(), &r).unwrap().unwrap();
        assert!(again.resumed);
        assert_eq!(again.id(), bound);
    }
    fn imported(root: &Path, request: &RunRequest, provider: &str) -> String {
        let session = uuid::Uuid::new_v4().to_string();
        crate::imports::write_record(
            root,
            request.conversation_id.as_deref().unwrap(),
            &crate::imports::Record {
                version: 1,
                source: crate::imports::Source {
                    provider: provider.into(),
                    environment_id: uuid::Uuid::new_v4().to_string(),
                    connection_id: None,
                },
                session: session.clone(),
                imported_at: 1,
                path: None,
            },
        )
        .unwrap();
        session
    }
    #[test]
    fn an_imported_chat_forks_its_own_session_on_its_first_reply_only() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        r.messages = vec![
            message("user", "Imported question"),
            message("assistant", "Imported answer"),
            message("user", "Next"),
        ];
        let source = imported(root.path(), &r, "claude");
        let mut first = Session::prepare(root.path(), &r).unwrap().unwrap();
        assert!(first.switched_account && !first.resumed && !first.history_rewritten);
        assert_eq!(first.imported(), Some("claude"));
        assert_ne!(first.id(), source, "The fork gets its own session");
        // As prepare_transfer leaves it once the source transcript is copied.
        first.resumed = true;
        first.transfer_path = Some("host-owned-snapshot.jsonl".into());
        assert_eq!(first.transfer_id(), Some(source.as_str()));
        r.native_session = Some(first);
        let context = r.native_context().unwrap();
        assert!(
            context.contains("began in Claude Code")
                && context.contains(super::super::visualize::GUIDANCE)
        );
        assert!(!context.contains("Imported question") && !context.contains("Imported answer"));
        assert_eq!(r.native_user_text(), "Next");
        let first = r.native_session.take().unwrap();
        let fork = uuid::Uuid::new_v4().to_string();
        first.bind(&fork, true).unwrap();
        drop(first);
        // Later replies resume the fork; the import no longer applies.
        r.messages
            .extend([message("assistant", "Answer"), message("user", "More")]);
        let later = Session::prepare(root.path(), &r).unwrap().unwrap();
        assert!(later.resumed && !later.switched_account && later.imported().is_none());
        assert_eq!(later.id(), fork);
    }
    #[test]
    fn an_imported_codex_thread_keeps_its_own_tools_and_a_rewind_starts_over() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        r.agent.provider = "codex".into();
        imported(root.path(), &r, "codex");
        let mut session = Session::prepare(root.path(), &r).unwrap().unwrap();
        session.resumed = true;
        session.transfer_path = Some("host-owned-snapshot.jsonl".into());
        r.native_session = Some(session);
        let context = r.native_context().unwrap();
        assert!(context.contains("began in Codex"));
        assert!(!context.contains(super::super::visualize::GUIDANCE));
        // Naming a fence's shell needs no tool, so the thread learns it too.
        assert!(context.contains(crate::console::GUIDANCE));
        // A rewind before the first reply replaced the history the imported session holds.
        let mut rewound = request();
        imported(root.path(), &rewound, "claude");
        rewound.history_revision = 1;
        let fresh = Session::prepare(root.path(), &rewound).unwrap().unwrap();
        assert!(fresh.history_rewritten && !fresh.switched_account && !fresh.resumed);
        assert!(fresh.imported().is_none());
        // An import belongs to its own agent.
        let mut other = request();
        imported(root.path(), &other, "claude");
        other.agent.provider = "codex".into();
        assert!(Session::prepare(root.path(), &other).is_err());
    }
    #[tokio::test]
    async fn an_import_forks_within_its_own_profile_and_starts_over_when_the_session_is_gone() {
        for provider in ["claude", "codex"] {
            let root = tempfile::tempdir().unwrap();
            let store = tempfile::tempdir().unwrap();
            let mut r = request();
            r.agent.provider = provider.into();
            r.messages = vec![
                message("user", "Earlier question"),
                message("assistant", "Earlier answer"),
                message("user", "Next"),
            ];
            let id = imported(root.path(), &r, provider);
            let (folder, name, record) = if provider == "codex" {
                (
                    "sessions/2026/09/20",
                    format!("rollout-2026-09-20-{id}.jsonl"),
                    json!({"type":"session_meta","payload":{"id":id}}),
                )
            } else {
                (
                    "projects/C--work",
                    format!("{id}.jsonl"),
                    json!({"type":"user","sessionId":id,"message":{"content":"Imported"}}),
                )
            };
            let directory = store.path().join(folder);
            std::fs::create_dir_all(&directory).unwrap();
            let original = format!("{record}\n");
            std::fs::write(directory.join(&name), &original).unwrap();
            let import = crate::imports::record(root.path(), r.conversation_id.as_deref().unwrap())
                .unwrap()
                .unwrap();
            let mut session = Session::prepare(root.path(), &r).unwrap().unwrap();
            // Continuing with the account whose profile holds the chat.
            session
                .fork_import(
                    store.path().to_path_buf(),
                    store.path().to_path_buf(),
                    &r,
                    import.clone(),
                )
                .await
                .unwrap();
            assert!(session.resumed && !session.import_missing);
            assert_eq!(session.transfer_id(), Some(id.as_str()));
            let snapshot = session.transfer_path.clone().unwrap();
            assert_eq!(std::fs::read_to_string(&snapshot).unwrap(), original);
            // The original stays as it was, with no second copy beside it.
            assert_eq!(
                std::fs::read_to_string(directory.join(&name)).unwrap(),
                original
            );
            assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
            drop(session);
            assert!(!Path::new(&snapshot).exists(), "The copy is temporary");
            // A session no longer on this computer leaves the reply to start over.
            std::fs::remove_file(directory.join(&name)).unwrap();
            let mut gone = Session::prepare(root.path(), &r).unwrap().unwrap();
            gone.fork_import(
                store.path().to_path_buf(),
                store.path().to_path_buf(),
                &r,
                import,
            )
            .await
            .unwrap();
            assert!(gone.import_missing && !gone.resumed && gone.transfer_id().is_none());
            r.native_session = Some(gone);
            assert!(r.native_context().unwrap().contains("Earlier question"));
        }
    }
    #[tokio::test]
    async fn a_moved_claude_session_forks_the_very_file_it_was_imported_from() {
        let root = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        for (folder, text) in [("C--old", "Old copy"), ("C--new", "Imported copy")] {
            let directory = store.path().join("projects").join(folder);
            std::fs::create_dir_all(&directory).unwrap();
            let record = json!({"type":"user","sessionId":id,"message":{"content":text}});
            std::fs::write(directory.join(format!("{id}.jsonl")), format!("{record}\n")).unwrap();
        }
        let source = crate::imports::Source {
            provider: "claude".into(),
            environment_id: uuid::Uuid::new_v4().to_string(),
            connection_id: None,
        };
        for (path, found) in [
            (format!("projects/C--new/{id}.jsonl"), true),
            ("projects/../escape.jsonl".to_string(), false),
            (
                format!("projects/C--new/{}.jsonl", uuid::Uuid::new_v4()),
                false,
            ),
        ] {
            let mut r = request();
            r.messages = vec![
                message("user", "Earlier question"),
                message("assistant", "Earlier answer"),
                message("user", "Next"),
            ];
            let record = crate::imports::Record {
                version: 1,
                source: source.clone(),
                session: id.clone(),
                imported_at: 1,
                path: Some(path),
            };
            let conversation = r.conversation_id.clone().unwrap();
            crate::imports::write_record(root.path(), &conversation, &record).unwrap();
            let mut session = Session::prepare(root.path(), &r).unwrap().unwrap();
            session
                .fork_import(
                    store.path().to_path_buf(),
                    store.path().to_path_buf(),
                    &r,
                    record,
                )
                .await
                .unwrap();
            assert_eq!(session.resumed, found);
            assert_eq!(session.import_missing, !found);
            if found {
                let copy =
                    std::fs::read_to_string(session.transfer_path.as_ref().unwrap()).unwrap();
                assert!(copy.contains("Imported copy") && !copy.contains("Old copy"));
            }
        }
    }
    fn request() -> RunRequest {
        serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"conversationId":uuid::Uuid::new_v4(),"agent":{"provider":"claude","model":"","instructions":"Private guidance"},"messages":[{"role":"user","text":"Private request"}]})).unwrap()
    }
    fn message(role: &str, text: &str) -> super::super::ChatMessage {
        serde_json::from_value(json!({"role":role,"text":text})).unwrap()
    }
    fn profile(provider: &str) -> crate::profiles::Profile {
        crate::profiles::Profile {
            id: uuid::Uuid::new_v4().to_string(),
            provider: provider.into(),
            namespace: "sessions-test".into(),
            ..Default::default()
        }
    }
    fn saved(session: &Session) -> Record {
        serde_json::from_slice(&std::fs::read(&session.path).unwrap()).unwrap()
    }
    #[tokio::test]
    async fn a_claude_session_whose_transcript_was_cleaned_up_starts_over_from_the_saved_messages()
    {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let account = crate::profiles::Profile {
            root: Some(config.path().to_path_buf()),
            isolated: true,
            ..profile("claude")
        };
        let exe = crate::providers::Executable {
            provider: "claude".into(),
            program: "claude".into(),
            prefix: vec![],
            wsl: None,
        };
        crate::profiles::scope(account, async {
            let mut r = request();
            let first = Session::prepare(root.path(), &r).unwrap().unwrap();
            first.bind(first.id(), true).unwrap();
            let id = first.id().to_string();
            drop(first);
            r.messages.push(message("assistant", "Earlier answer"));
            r.messages.push(message("user", "Next"));
            // Without a projects folder nothing proves the transcript gone: the CLI resumes.
            let mut session = Session::prepare(root.path(), &r).unwrap().unwrap();
            assert!(!session.verify_transcript(&exe, None).await);
            assert!(session.resumed && session.id() == id);
            drop(session);
            // Where the CLI keeps it, under the folder it ran in or any other.
            let folder = config.path().join("projects").join("C--work-my-app");
            std::fs::create_dir_all(&folder).unwrap();
            let transcript = folder.join(format!("{id}.jsonl"));
            std::fs::write(&transcript, "{}\n").unwrap();
            let mut session = Session::prepare(root.path(), &r).unwrap().unwrap();
            for cwd in [Some("C:\\work\\my app"), Some("D:\\moved"), None] {
                assert!(!session.verify_transcript(&exe, cwd.map(Into::into)).await);
            }
            assert!(session.resumed && !session.transcript_missing && session.id() == id);
            // A Codex session or an account switch's copy is never checked this way.
            let codex = crate::providers::Executable {
                provider: "codex".into(),
                ..exe.clone()
            };
            std::fs::remove_file(&transcript).unwrap();
            assert!(!session.verify_transcript(&codex, None).await);
            session.transfer_path = Some("host-owned-snapshot.jsonl".into());
            assert!(!session.verify_transcript(&exe, None).await);
            drop(session);
            // Once Claude Code's cleanup deleted it, the reply starts a new session from the
            // saved messages, as after a rewind.
            let mut session = Session::prepare(root.path(), &r).unwrap().unwrap();
            assert!(
                session
                    .verify_transcript(&exe, Some("C:\\work\\my app".into()))
                    .await
            );
            assert!(session.transcript_missing && !session.resumed && !session.history_rewritten);
            assert_ne!(session.id(), id);
            assert!(session.unconfirmed_message.is_none() && !session.instructions_changed);
            let fresh = session.id().to_string();
            session.bind(&fresh, true).unwrap();
            assert_eq!(saved(&session).id, fresh);
            r.native_session = Some(session);
            assert!(r.native_context().unwrap().contains("Earlier answer"));
        })
        .await;
    }
    #[test]
    fn a_claude_transcript_is_found_by_its_folder_name_or_by_looking_through_every_folder() {
        let config = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(claude_transcript(config.path(), &id, None), None);
        let long = format!("/home/me/{}", "deep/".repeat(60));
        let named: String = long
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        // Claude Code shortens names past 200 characters with a hash.
        let folder = config
            .path()
            .join("projects")
            .join(format!("{}-1x2y3z", &named[..200]));
        std::fs::create_dir_all(&folder).unwrap();
        assert_eq!(
            claude_transcript(config.path(), &id, Some(&long)),
            Some(false)
        );
        std::fs::write(folder.join(format!("{id}.jsonl")), "{}\n").unwrap();
        assert_eq!(
            claude_transcript(config.path(), &id, Some(&long)),
            Some(true)
        );
        assert_eq!(
            claude_transcript(
                config.path(),
                &uuid::Uuid::new_v4().to_string(),
                Some(&long)
            ),
            Some(false)
        );
    }
    #[test]
    fn manual_compaction_requires_an_existing_binding_and_cannot_switch_accounts() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        r.compact = true;
        r.messages[0].text = "/compact".into();
        assert!(Session::prepare(root.path(), &r).is_err());
        r.compact = false;
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        session.bind(session.id(), true).unwrap();
        let before = std::fs::read(&session.path).unwrap();
        let path = session.path.clone();
        drop(session);
        r.compact = true;
        assert!(Session::prepare(root.path(), &r).unwrap().unwrap().resumed);
        let mut previous: Record = serde_json::from_slice(&before).unwrap();
        previous.account = "another-account".into();
        previous.scope = "another-scope".into();
        std::fs::write(&path, serde_json::to_vec(&previous).unwrap()).unwrap();
        let foreign = std::fs::read(&path).unwrap();
        r.account_switch = true;
        assert!(Session::prepare(root.path(), &r).is_err());
        assert_eq!(std::fs::read(path).unwrap(), foreign);
    }
    #[tokio::test]
    async fn inspection_is_read_only_and_checks_the_same_profile_scope_as_execution() {
        let root = tempfile::tempdir().unwrap();
        let r = request();
        assert_eq!(
            bound_id(
                root.path(),
                r.conversation_id.as_deref().unwrap(),
                "claude",
                None
            )
            .unwrap(),
            None
        );
        assert!(!root.path().join("native-sessions").exists());
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        session.bind(session.id(), true).unwrap();
        let before = std::fs::read(&session.path).unwrap();
        assert_eq!(
            bound_id(
                root.path(),
                r.conversation_id.as_deref().unwrap(),
                "claude",
                None
            )
            .unwrap()
            .as_deref(),
            Some(session.id())
        );
        assert!(bound_id(
            root.path(),
            r.conversation_id.as_deref().unwrap(),
            "codex",
            None
        )
        .is_err());
        let other = crate::profiles::Profile {
            id: "other-profile".into(),
            ..Default::default()
        };
        let error = crate::profiles::scope(other, async {
            bound_id(
                root.path(),
                r.conversation_id.as_deref().unwrap(),
                "claude",
                None,
            )
        })
        .await
        .unwrap_err();
        assert!(error.contains("previously selected account"), "{error}");
        assert_eq!(std::fs::read(&session.path).unwrap(), before);
    }
    #[test]
    fn disk_resume_reuses_id_without_storing_conversation_content() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        assert!(!session.resumed);
        assert!(!session.switched_account);
        let id = session.id().to_string();
        session.bind(&id, true).unwrap();
        let saved = std::fs::read_to_string(&session.path).unwrap();
        assert!(!saved.contains("Private"));
        assert!(
            Session::prepare(root.path(), &r).is_err(),
            "Concurrent writers must be excluded"
        );
        drop(session);
        r.messages
            .extend([message("assistant", "Done"), message("user", "Continue")]);
        r.native_session = Session::prepare(root.path(), &r).unwrap();
        let resumed = r.native_session.as_ref().unwrap();
        assert!(resumed.resumed);
        assert_eq!(resumed.id(), id);
        assert!(!resumed.retry);
        assert_eq!(r.native_context(), None);
        assert_eq!(r.native_user_text(), "Continue");
        assert!(resumed
            .bind(&uuid::Uuid::new_v4().to_string(), true)
            .is_err());
    }

    #[test]
    fn rewound_history_starts_fresh_and_rejects_stale_revisions() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        let original = session.id().to_string();
        session.bind(&original, true).unwrap();
        drop(session);
        r.messages[0].text = "A replacement message".into();
        assert!(Session::prepare(root.path(), &r).is_err());
        r.history_revision = 1;
        let next = Session::prepare(root.path(), &r).unwrap().unwrap();
        assert!(!next.resumed);
        assert_ne!(next.id(), original);
        next.bind(next.id(), true).unwrap();
        drop(next);
        r.history_revision = 0;
        assert!(Session::prepare(root.path(), &r).is_err());
        r.history_revision = 1;
        r.messages.push(message("assistant", "New answer"));
        r.messages.push(message("user", "Continue"));
        assert!(Session::prepare(root.path(), &r).unwrap().unwrap().resumed);
    }
    #[test]
    fn undoing_a_rewind_resumes_the_session_that_received_the_same_history() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        let original = session.id().to_string();
        session.bind(&original, true).unwrap();
        drop(session);
        // Rewind and Undo rewind advanced the revision twice but restored the same history.
        r.history_revision = 2;
        r.messages
            .extend([message("assistant", "Answer"), message("user", "Continue")]);
        let resumed = Session::prepare(root.path(), &r).unwrap().unwrap();
        assert!(resumed.resumed && !resumed.history_rewritten);
        assert_eq!(resumed.id(), original);
        resumed.bind(&original, true).unwrap();
        drop(resumed);
        // A file Undo notes the undone edits on an earlier reply: the history no longer
        // continues the transcript, so the next reply starts a fresh session.
        r.history_revision = 3;
        r.messages[1].text =
            "Answer\n\n[The user undid this response’s recorded file edits.]".into();
        r.messages
            .extend([message("assistant", "Done"), message("user", "Next")]);
        let fresh = Session::prepare(root.path(), &r).unwrap().unwrap();
        assert!(fresh.history_rewritten && !fresh.resumed);
        assert_ne!(fresh.id(), original);
    }
    #[tokio::test]
    async fn rewound_history_is_neither_carried_to_another_account_nor_compacted() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let first = profile("claude");
        let mut second = first.clone();
        second.id = uuid::Uuid::new_v4().to_string();
        r.messages.extend([
            message("assistant", "Kept answer"),
            message("user", "Discarded"),
        ]);
        crate::profiles::scope(first, async {
            let s = Session::prepare(root.path(), &r).unwrap().unwrap();
            s.bind(s.id(), true).unwrap();
        })
        .await;
        // Rewound to before "Discarded", then a new question under another account.
        r.history_revision = 1;
        r.messages.last_mut().unwrap().text = "A new question".into();
        let mut compact = r.clone();
        compact.compact = true;
        compact.messages.last_mut().unwrap().text = "/compact".into();
        let error = crate::profiles::scope(second.clone(), async {
            Session::prepare(root.path(), &compact).err().unwrap()
        })
        .await;
        assert!(error.contains("before compacting"), "{error}");
        let switched = crate::profiles::scope(second, async {
            Session::prepare(root.path(), &r).unwrap().unwrap()
        })
        .await;
        assert!(switched.switched_account && switched.history_rewritten);
        assert!(!switched.resumed && switched.transfer_from.is_none());
        // The fresh session receives the retained messages instead of the old transcript.
        r.native_session = Some(switched);
        let context = r.native_context().unwrap();
        assert!(context.contains("Private request") && context.contains("Kept answer"));
        assert_eq!(r.native_user_text(), "A new question");
    }
    #[test]
    fn retries_preserve_partial_work_and_unconfirmed_input_is_explicit() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        session.bind(session.id(), false).unwrap();
        drop(session);
        r.native_session = Session::prepare(root.path(), &r).unwrap();
        assert!(r.native_session.as_ref().unwrap().retry);
        assert!(r
            .native_user_text()
            .contains("do not blindly repeat completed side effects"));
        assert!(r.native_image_message(0));
        r.native_session = None;
        r.messages.push(message("user", "Where did you stop?"));
        r.native_session = Session::prepare(root.path(), &r).unwrap();
        assert!(r
            .native_context()
            .unwrap()
            .contains("before acknowledgment"));
        assert!(r.native_image_message(0));
    }
    #[test]
    fn rejects_changed_history_and_unseen_user_messages() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        session.bind(session.id(), true).unwrap();
        drop(session);
        let original = r.messages[0].text.clone();
        r.messages[0].text = "Edited history".into();
        assert!(Session::prepare(root.path(), &r).is_err());
        r.messages[0].text = original;
        r.messages.extend([
            message("user", "Unseen remote turn"),
            message("user", "Next"),
        ]);
        assert!(Session::prepare(root.path(), &r).is_err());
    }
    #[test]
    fn isolated_conversations_and_changed_provider_do_not_share_sessions() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        let id = session.id().to_string();
        session.bind(&id, true).unwrap();
        drop(session);
        r.agent.provider = "codex".into();
        assert!(Session::prepare(root.path(), &r).is_err());
        r.account_switch = true;
        assert!(
            Session::prepare(root.path(), &r).is_err(),
            "The agent itself never changes within a conversation"
        );
        r.conversation_id = Some(uuid::Uuid::new_v4().to_string());
        let other = Session::prepare(root.path(), &r).unwrap().unwrap();
        assert!(!other.resumed);
        assert_ne!(other.id(), id);
    }
    #[test]
    fn malformed_bindings_fail_closed_and_legacy_callers_stay_ephemeral() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        std::fs::write(&session.path, "{}").unwrap();
        drop(session);
        assert!(Session::prepare(root.path(), &r).is_err());
        r.account_switch = true;
        assert!(Session::prepare(root.path(), &r).is_err());
        r.conversation_id = None;
        assert!(Session::prepare(root.path(), &r).unwrap().is_none());
    }
    #[tokio::test]
    async fn environment_and_folder_changes_cannot_resume_or_switch_each_other() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        r.account_switch = true;
        let profile = profile("claude");
        crate::profiles::scope(profile.clone(), async {
            let s = Session::prepare(root.path(), &r).unwrap().unwrap();
            s.bind(s.id(), true).unwrap();
        })
        .await;
        let mut other = profile.clone();
        other.distribution = Some("Different Ubuntu".into());
        assert!(
            crate::profiles::scope(other, async { Session::prepare(root.path(), &r).is_err() })
                .await
        );
        let mut other = profile.clone();
        other.namespace = "another-installation".into();
        assert!(
            crate::profiles::scope(other, async { Session::prepare(root.path(), &r).is_err() })
                .await
        );
        let mut moved = r.clone();
        moved.location = Some(serde_json::from_value(json!({"computerId":uuid::Uuid::new_v4(),"environmentId":uuid::Uuid::new_v4(),"path":"C:/other"})).unwrap());
        assert!(
            crate::profiles::scope(profile.clone(), async {
                Session::prepare(root.path(), &moved).is_err()
            })
            .await
        );
        let mut elsewhere = profile.clone();
        elsewhere.id = uuid::Uuid::new_v4().to_string();
        assert!(
            crate::profiles::scope(elsewhere, async {
                Session::prepare(root.path(), &moved).is_err()
            })
            .await,
            "Another account at another folder is a moved chat, not an account switch"
        );
    }
    #[tokio::test]
    async fn account_switches_prepare_a_new_destination_and_keep_the_latest_binding() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let first = profile("claude");
        let mut second = first.clone();
        second.id = uuid::Uuid::new_v4().to_string();
        let first_id = crate::profiles::scope(first.clone(), async {
            let s = Session::prepare(root.path(), &r).unwrap().unwrap();
            s.bind(s.id(), true).unwrap();
            s.id().to_string()
        })
        .await;
        r.messages
            .extend([message("assistant", "Done"), message("user", "Continue")]);
        // A version 2 binding recognizes the same location under another account by itself.
        assert!(!r.account_switch);
        let mut switched = crate::profiles::scope(second.clone(), async {
            Session::prepare(root.path(), &r).unwrap().unwrap()
        })
        .await;
        assert!(switched.switched_account);
        assert!(!switched.resumed && !switched.retry && !switched.instructions_changed);
        assert_eq!(switched.unconfirmed_message, None);
        let second_id = switched.id().to_string();
        assert_ne!(second_id, first_id);
        // Simulate the verified snapshot step; the native smoke exercises it end to end.
        switched.resumed = true;
        switched.transfer_path = Some("host-owned-transcript.jsonl".into());
        switched.instructions_changed = true;
        r.native_session = Some(switched);
        let context = r.native_context().unwrap();
        assert!(!context.contains("Private request") && !context.contains("Done"));
        assert_eq!(r.native_user_text(), "Continue");
        assert!(!r.native_image_message(0));
        assert_eq!(r.stdin_payload().lines().count(), 2);
        let switched = r.native_session.take().unwrap();
        switched.bind(&second_id, true).unwrap();
        let record = saved(&switched);
        assert_eq!(record.version, 2);
        assert!(!record.account.is_empty() && !record.location.is_empty());
        drop(switched);
        // The old account's binding is gone: inspection under it reports the switch.
        let conversation = r.conversation_id.clone().unwrap();
        let error = crate::profiles::scope(first.clone(), async {
            bound_id(root.path(), &conversation, "claude", None).unwrap_err()
        })
        .await;
        assert!(error.contains("previously selected account"), "{error}");
        assert_eq!(
            crate::profiles::scope(second.clone(), async {
                bound_id(root.path(), &conversation, "claude", None).unwrap()
            })
            .await
            .as_deref(),
            Some(second_id.as_str())
        );
        // Later replies resume the new account's own session.
        r.messages
            .extend([message("assistant", "Again"), message("user", "More")]);
        let resumed = crate::profiles::scope(second.clone(), async {
            Session::prepare(root.path(), &r).unwrap().unwrap()
        })
        .await;
        assert!(resumed.resumed && !resumed.switched_account);
        assert_eq!(resumed.id(), second_id);
        drop(resumed);
        // Switching back never resumes the first account's stale transcript.
        let back = crate::profiles::scope(first, async {
            Session::prepare(root.path(), &r).unwrap().unwrap()
        })
        .await;
        assert!(back.switched_account && !back.resumed);
        assert_ne!(back.id(), first_id);
        assert_ne!(back.id(), second_id);
    }
    #[tokio::test]
    async fn retrying_under_another_account_continues_the_interrupted_attempt() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let first = profile("codex");
        let mut second = first.clone();
        second.id = uuid::Uuid::new_v4().to_string();
        crate::profiles::scope(first, async {
            let s = Session::prepare(root.path(), &r).unwrap().unwrap();
            s.bind(s.id(), false).unwrap();
        })
        .await;
        r.native_session =
            crate::profiles::scope(second, async { Session::prepare(root.path(), &r).unwrap() })
                .await;
        let session = r.native_session.as_ref().unwrap();
        assert!(session.switched_account && session.retry && !session.resumed);
        assert!(r
            .native_user_text()
            .contains("do not blindly repeat completed side effects"));
        assert!(
            r.native_context().unwrap().contains("earlier context only"),
            "A fresh session still receives the (empty) saved history framing"
        );
    }
    #[tokio::test]
    async fn legacy_bindings_switch_accounts_only_on_an_explicit_request() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let first = profile("claude");
        let mut second = first.clone();
        second.id = uuid::Uuid::new_v4().to_string();
        let legacy_scope =
            crate::profiles::scope(first.clone(), async { scope("claude", None).unwrap() }).await;
        let directory = root.path().join("native-sessions");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("{}.json", r.conversation_id.as_ref().unwrap()));
        let legacy_id = uuid::Uuid::new_v4().to_string();
        std::fs::write(
            &path,
            json!({"version":1,"scope":legacy_scope,"id":legacy_id,"history":[fingerprint(&r.messages[0]).unwrap()],"instructions":fingerprint(&r.agent.instructions).unwrap(),"received":true}).to_string(),
        )
        .unwrap();
        let conversation = r.conversation_id.clone().unwrap();
        // The legacy binding still resumes under its own account and cannot name the other one.
        let resumed = crate::profiles::scope(first.clone(), async {
            Session::prepare(root.path(), &r).unwrap().unwrap()
        })
        .await;
        assert!(resumed.resumed && !resumed.switched_account);
        assert_eq!(resumed.id(), legacy_id);
        drop(resumed);
        let error = crate::profiles::scope(second.clone(), async {
            bound_id(root.path(), &conversation, "claude", None).unwrap_err()
        })
        .await;
        assert!(error.contains("does not match"), "{error}");
        assert!(
            crate::profiles::scope(second.clone(), async {
                Session::prepare(root.path(), &r).is_err()
            })
            .await,
            "A mismatch without an explicit switch still fails closed"
        );
        r.account_switch = true;
        let switched = crate::profiles::scope(second.clone(), async {
            Session::prepare(root.path(), &r).unwrap().unwrap()
        })
        .await;
        assert!(switched.switched_account && !switched.resumed);
        assert_ne!(switched.id(), legacy_id);
        switched.bind(switched.id(), true).unwrap();
        assert_eq!(saved(&switched).version, 2);
        let switched_id = switched.id().to_string();
        drop(switched);
        // Once upgraded, the explicit request is no longer needed to detect the account.
        r.account_switch = false;
        r.messages
            .extend([message("assistant", "Done"), message("user", "Continue")]);
        let back = crate::profiles::scope(first, async {
            Session::prepare(root.path(), &r).unwrap().unwrap()
        })
        .await;
        assert!(back.switched_account);
        assert_ne!(back.id(), switched_id);
    }
    #[test]
    fn a_session_begun_under_the_earlier_rule_for_pages_reads_the_current_one_once() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let note = crate::artifacts::pages_rule_changed();
        r.native_session = Session::prepare(root.path(), &r).unwrap();
        // A new session reads the rule with its first message, and is never told again.
        assert!(r
            .stdin_payload()
            .contains("publish it with the Artifact tool right away"));
        assert!(!r.stdin_payload().contains(&note));
        let s = r.native_session.take().unwrap();
        assert!(!s.pages_rule_changed);
        s.bind(s.id(), true).unwrap();
        let binding = s.path.clone();
        drop(s);
        r.messages
            .extend([message("assistant", "Answer"), message("user", "Next")]);
        r.native_session = Session::prepare(root.path(), &r).unwrap();
        assert!(!r.native_session.as_ref().unwrap().pages_rule_changed);
        assert_eq!(r.stdin_payload().lines().count(), 1);
        r.native_session = None;
        // A binding as earlier releases wrote it says nothing of the rule.
        let mut record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&binding).unwrap()).unwrap();
        assert_eq!(record["pages_rule"], true);
        record.as_object_mut().unwrap().remove("pages_rule");
        std::fs::write(&binding, serde_json::to_vec(&record).unwrap()).unwrap();
        r.native_session = Session::prepare(root.path(), &r).unwrap();
        let payload = r.stdin_payload();
        let lines: Vec<serde_json::Value> = payload
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["shouldQuery"], false);
        assert!(lines[0].get("origin").is_none());
        assert_eq!(lines[0]["message"]["content"][0]["text"], note.as_str());
        assert_eq!(lines[1]["origin"]["kind"], "human");
        // Only the note: it brings back no history.
        assert!(!payload.contains("Answer"));
        // Another agent's session never hears of it, and the binding remembers either way.
        r.agent.provider = "codex".into();
        assert!(r.native_context().is_none());
        r.agent.provider = "claude".into();
        // Told once, it is told no more.
        let s = r.native_session.take().unwrap();
        s.bind(s.id(), true).unwrap();
        assert!(saved(&s).pages_rule);
        drop(s);
        r.messages
            .extend([message("assistant", "Answer"), message("user", "Again")]);
        r.native_session = Session::prepare(root.path(), &r).unwrap();
        assert!(!r.native_session.as_ref().unwrap().pages_rule_changed);
        assert_eq!(r.stdin_payload().lines().count(), 1);
        // A message that never arrived may have carried it, so the next reply carries it again.
        let s = r.native_session.take().unwrap();
        s.bind(s.id(), false).unwrap();
        drop(s);
        r.native_session = Session::prepare(root.path(), &r).unwrap();
        assert!(r.native_session.as_ref().unwrap().pages_rule_changed);
    }

    #[test]
    fn claude_bootstraps_once_and_changes_instructions_without_replaying_history() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        r.native_session = Session::prepare(root.path(), &r).unwrap();
        let first: Vec<serde_json::Value> = r
            .stdin_payload()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        assert_eq!(first.len(), 2);
        assert_eq!(first[0]["shouldQuery"], false);
        assert!(first[0].get("origin").is_none());
        assert_eq!(first[1]["origin"]["kind"], "human");
        let s = r.native_session.take().unwrap();
        s.bind(s.id(), true).unwrap();
        drop(s);
        r.messages
            .extend([message("assistant", "Answer"), message("user", "Next")]);
        r.native_session = Session::prepare(root.path(), &r).unwrap();
        assert_eq!(r.stdin_payload().lines().count(), 1);
        assert!(!r.stdin_payload().contains("Private request"));
        r.native_session = None;
        r.agent.instructions = "New instructions".into();
        r.native_session = Session::prepare(root.path(), &r).unwrap();
        let payload = r.stdin_payload();
        assert_eq!(payload.lines().count(), 2);
        assert!(payload.contains("New instructions"));
        assert!(!payload.contains("Private request"));
    }
}
