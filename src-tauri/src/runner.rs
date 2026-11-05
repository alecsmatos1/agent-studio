use crate::{
    protocol::{Decoder, RunEvent},
    providers::{chat_command, take_over, RunRequest},
};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::Manager;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

/// A request a document asked for just before the window reloaded, which no document follows.
pub const RELOADED: &str =
    "This response was interrupted when the app reloaded. Retry from the current window.";
/// A reply or file Undo this app owns, with the conversation it belongs to.
pub struct Run {
    pub conversation: Option<String>,
    pub cancel: CancellationToken,
}
/// The replies and file Undos this app runs, the window reloads counted, and what each reply
/// reported, for a reloaded window to follow (reply_feed.rs).
#[derive(Default)]
pub struct Runs(
    pub Mutex<HashMap<String, Run>>,
    AtomicU64,
    pub Arc<crate::reply_feed::Feeds>,
);
impl Runs {
    /// The window reloaded. Its replies run on, and the new document follows them again; a
    /// request the old document left waiting to begin is refused, since nothing would follow it.
    pub fn reloaded(&self) {
        if let Ok(_active) = self.0.lock() {
            self.1.fetch_add(1, Ordering::SeqCst);
            self.2.detach_all();
        }
    }

    /// The window's document, which a reload replaces.
    pub fn document(&self) -> u64 {
        self.1.load(Ordering::SeqCst)
    }

    /// Starts keeping what the admitted reply `id` reports for the window that asked for it in
    /// `document`. A reload since then refuses it, so a reply never runs that no document follows:
    /// the new document listed the replies to follow before this one would have joined them.
    pub fn open_feed(
        &self,
        document: u64,
        id: &str,
        conversation: Option<String>,
        job: bool,
        window: crate::reply_feed::Window,
    ) -> Result<Arc<crate::reply_feed::Feed>, String> {
        let mut active = self.0.lock().map_err(|_| "Run registry lock failed")?;
        if self.1.load(Ordering::SeqCst) != document {
            active.remove(id);
            return Err(RELOADED.into());
        }
        Ok(self.2.open(id, conversation, job, window))
    }

    /// Admit work for a conversation. Different conversations run side by side; one
    /// conversation admits a single reply or file Undo, and a stopped one keeps its place
    /// until its process has exited and released the conversation's native session. A reply
    /// that continues one waiting for background work (`after`) is admitted beside that
    /// reply only while it runs, and takes over its process once it hands it over.
    pub async fn begin(
        &self,
        id: &str,
        conversation: Option<&str>,
        cancel: CancellationToken,
        after: Option<&str>,
    ) -> Result<(), String> {
        let generation = self.1.load(Ordering::SeqCst);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            {
                let mut active = self.0.lock().map_err(|_| "Run registry lock failed")?;
                if generation != self.1.load(Ordering::SeqCst) {
                    return Err(RELOADED.into());
                }
                let same = |run: &Run| {
                    conversation.is_some() && run.conversation.as_deref() == conversation
                };
                if let Some(previous) = after {
                    let mut others = active.iter().filter(|(_, run)| same(run));
                    let waiting = matches!(
                        (others.next(), others.next()),
                        (Some((running, run)), None) if running == previous && !run.cancel.is_cancelled()
                    );
                    if !waiting {
                        return Err(crate::providers::take_over::ENDED.into());
                    }
                    active.insert(
                        id.into(),
                        Run {
                            conversation: conversation.map(Into::into),
                            cancel,
                        },
                    );
                    return Ok(());
                }
                if active
                    .values()
                    .any(|run| same(run) && !run.cancel.is_cancelled())
                {
                    return Err(
                        "This conversation is already responding. Stop it or wait for it to finish."
                            .into(),
                    );
                }
                if !active.values().any(same) {
                    active.insert(
                        id.into(),
                        Run {
                            conversation: conversation.map(Into::into),
                            cancel,
                        },
                    );
                    return Ok(());
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(
                    "The previous response is still stopping. Try again in a moment.".into(),
                );
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}
#[derive(Clone)]
pub struct EventSink {
    send: Arc<dyn Fn(RunEvent) -> Result<(), String> + Send + Sync>,
    /// Keeps finished tool results on this computer for a conversation's run.
    outputs: Option<crate::tool_output::Recorder>,
    /// The conversation whose screens this run's tools save, list and read.
    screens: Option<Arc<crate::screens::tools::Context>>,
}
impl EventSink {
    pub fn new(f: impl Fn(RunEvent) -> Result<(), String> + Send + Sync + 'static) -> Self {
        Self {
            send: Arc::new(f),
            outputs: None,
            screens: None,
        }
    }
    pub fn send(&self, event: RunEvent) -> Result<(), String> {
        (self.send)(event)
    }
    /// The store this run keeps its results in, for output it stages itself.
    pub fn recorder(&self) -> Option<crate::tool_output::Recorder> {
        self.outputs.clone()
    }
    /// The conversation a chat's screen tools act for, when this run has one.
    pub fn screens(&self) -> Option<Arc<crate::screens::tools::Context>> {
        self.screens.clone()
    }
    /// A test's run, whose screen tools act for this conversation.
    #[cfg(test)]
    pub fn with_screens(mut self, screens: crate::screens::tools::Context) -> Self {
        self.screens = Some(Arc::new(screens));
        self
    }
    /// A test's run, which keeps the files it shows as a conversation's run does.
    #[cfg(test)]
    pub fn with_outputs(mut self, outputs: crate::tool_output::Recorder) -> Self {
        self.outputs = Some(outputs);
        self
    }
    /// Stores tool results the decoder captured, when this run keeps them.
    pub fn outputs(&self, outputs: Vec<crate::protocol::activity::CapturedOutput>) {
        if let Some(recorder) = &self.outputs {
            for output in outputs {
                recorder.record(output);
            }
        }
    }
}
pub async fn kill_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        #[cfg(windows)]
        {
            let mut kill = tokio::process::Command::new("taskkill.exe");
            kill.args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000);
            let _ = kill.output().await;
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        let _ = child.kill().await;
    }
    let _ = child.wait().await;
}

pub async fn run(
    app: tauri::AppHandle,
    request: RunRequest,
    feed: Arc<crate::reply_feed::Feed>,
    cancel: CancellationToken,
    connection_id: Option<String>,
) -> Result<String, String> {
    let usage_revision = AtomicU64::new(0);
    let changes = Arc::new(Mutex::new(None));
    let recorded_changes = changes.clone();
    let screens =
        crate::screens::tools::Context::new(&app, &request, connection_id.as_deref()).map(Arc::new);
    let mut output = EventSink::new(move |mut event| {
        if let RunEvent::Compaction { compaction } = &mut event {
            compaction.usage_revision = usage_revision.load(Ordering::Relaxed);
        }
        if let RunEvent::FileChanges { file_changes } = &event {
            if let Ok(mut recorded) = recorded_changes.lock() {
                *recorded = Some(file_changes.clone());
            }
        }
        if let RunEvent::Usage { usage } = &mut event {
            usage.revision = Some(usage_revision.fetch_add(1, Ordering::Relaxed) + 1);
        }
        feed.send(event)
    });
    output.screens = screens;
    let workflow = crate::providers::workflow_calls::context(&app, &request, connection_id.clone());
    let mut questions = app.state::<crate::providers::questions::Questions>().open(
        &request.run_id,
        connection_id,
        output.clone(),
    )?;
    questions.workflow.attach(workflow);
    let tracking = matches!(request.agent.provider.as_str(), "claude" | "codex")
        && request.conversation_id.is_some();
    let mut observation = crate::spend::Observation {
        version: 1,
        revision: 1,
        run_id: request.run_id.clone(),
        before: None,
        after: None,
        run_duration_ms: None,
    };
    let provider = request.agent.provider.clone();
    let model = request.agent.model.clone();
    // A message that takes over a reply waiting for background work goes out at once. The
    // reading the waiting reply takes as it ends marks the same moment.
    if tracking && request.take_over.is_none() {
        observation.before = crate::usage::read_cancellable(
            app.clone(),
            &app.state::<crate::usage::UsageState>(),
            &provider,
            &model,
            true,
            cancel.clone(),
        )
        .await
        .ok()
        .map(Into::into);
        let _ = output.send(RunEvent::AccountUsage {
            account_usage: observation.clone(),
        });
    }
    let run_started = std::time::Instant::now();
    let undo_request = request.clone();
    let result = execute(
        app.clone(),
        request,
        Some(output.clone()),
        cancel.clone(),
        "chat-runtime",
        Some(questions),
    )
    .await
    .map(|(status, _)| status);
    let run_duration_ms = run_started.elapsed().as_millis().min(9_007_199_254_740_991) as u64;
    let snapshot = changes.lock().ok().and_then(|mut s| s.take());
    if let Some(snapshot) = snapshot {
        if let Err(error) = crate::undo::capture(&app, &undo_request, &snapshot).await {
            let _ = output.send(RunEvent::Activity {
                text: format!("File Undo unavailable: {error}"),
            });
        }
    }
    if tracking {
        observation.run_duration_ms = Some(run_duration_ms);
        if !cancel.is_cancelled() {
            observation.after = crate::usage::read_cancellable(
                app.clone(),
                &app.state::<crate::usage::UsageState>(),
                &provider,
                &model,
                true,
                cancel,
            )
            .await
            .ok()
            .map(Into::into);
        }
        observation.revision = 2;
        let _ = output.send(RunEvent::AccountUsage {
            account_usage: observation,
        });
    }
    result
}
/// The answer to a restricted background request, such as a title or a folder icon, run in the
/// isolated title runtime.
pub async fn background_text(
    app: tauri::AppHandle,
    request: RunRequest,
    cancel: CancellationToken,
) -> Result<String, String> {
    let (status, text) = execute(app, request, None, cancel, "title-runtime", None).await?;
    if status == "complete" {
        Ok(text)
    } else {
        Err("Background request cancelled".into())
    }
}
pub(crate) async fn execute(
    app: tauri::AppHandle,
    mut request: RunRequest,
    channel: Option<EventSink>,
    cancel: CancellationToken,
    directory: &str,
    mut questions: Option<crate::providers::questions::Session>,
) -> Result<(String, String), String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate the app data directory")?
        .join(directory);
    std::fs::create_dir_all(&root)
        .map_err(|_| "Cannot create the conversation runtime directory")?;
    let exe = crate::providers::resolve(&request.agent.provider).await?;
    // Conversation replies keep their tool results on this computer; titles and other
    // restricted runs have no tools to record.
    let channel = channel.map(|mut channel| {
        if let (Some(conversation), true) = (&request.conversation_id, request.tools_enabled()) {
            channel.outputs =
                crate::tool_output::Recorder::new(&app, conversation, &request.run_id);
            if let Some(recorder) = &channel.outputs {
                recorder.distribution(exe.wsl.as_ref().map(|w| w.distribution.clone()));
            }
        }
        channel
    });
    if request.agent.provider == "gemini" {
        let login = crate::providers::require_gemini_login(&exe, &cancel).await;
        if !cancel.is_cancelled() {
            login?;
        }
    }
    if cancel.is_cancelled() {
        return Ok(("cancelled".into(), String::new()));
    }
    let pool = app.state::<crate::pool::Pool>();
    if request.tools_enabled()
        && (crate::profiles::current().shared_source.is_some()
            || crate::profiles::current().shared_error.is_some())
    {
        let command = chat_command(&request, &root, &exe).await?;
        let folder = if let Some(wsl) = &exe.wsl {
            if let Some(location) = &request.location {
                location.path.clone()
            } else {
                let (_, _, _, fallback) = crate::context::wsl_paths(
                    &wsl.distribution,
                    &crate::profiles::current(),
                    &request.agent.provider,
                )
                .await?;
                match crate::standalone::prepare(root.parent().unwrap(), &request)? {
                    Some(id) => std::path::Path::new(&fallback)
                        .parent()
                        .ok_or("Cannot locate Standalone folder")?
                        .join("standalone")
                        .join(id.to_string())
                        .to_string_lossy()
                        .replace('\\', "/"),
                    None => fallback,
                }
            }
        } else {
            command
                .as_std()
                .get_current_dir()
                .unwrap_or(&root)
                .to_string_lossy()
                .into_owned()
        };
        request.shared_context =
            crate::shared_context::load(&request.agent.provider, &folder).await?;
    }
    // A message that continues a reply waiting for background work takes over that reply's
    // process first: the waiting reply holds the conversation's native session until it hands
    // the process over at its idle point, where it ends.
    let mut handed = None;
    if let (Some(target), Some(conversation)) =
        (request.take_over.clone(), request.conversation_id.clone())
    {
        let session = questions.as_ref().ok_or(take_over::ENDED)?;
        let mut offer = session
            .take_over
            .request(&target, crate::pool::fingerprint(&request, &exe)?)?;
        let outcome = tokio::select! {
            outcome = &mut offer => outcome,
            _ = cancel.cancelled() => {
                // A process handed over as this reply stopped stays with its conversation.
                offer.close();
                if let Ok(Ok(process)) = offer.try_recv() {
                    pool.park(&conversation, process).await;
                }
                return Ok(("cancelled".into(), String::new()));
            }
        };
        handed = Some(outcome.map_err(|_| take_over::ENDED.to_string())??);
    }
    let prepared = async {
        request.native_session =
            crate::providers::sessions::Session::prepare(root.parent().unwrap(), &request)?;
        // Only conversation-bound Claude/Codex chats keep their process between replies.
        let parkable = request.native_session.is_some();
        let fingerprint = if parkable {
            crate::pool::fingerprint(&request, &exe)?
        } else {
            String::new()
        };
        // The images this reply sends its provider, read here or from the relay. The request
        // keeps them in memory only, after its session was fingerprinted on references.
        crate::chat_images::materialize(&app, &mut request).await?;
        Ok::<_, String>((parkable, fingerprint))
    }
    .await;
    let (parkable, fingerprint) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            // The work a handed-over process carries runs on for the conversation.
            if let (Some(process), Some(conversation)) = (handed, &request.conversation_id) {
                pool.park(conversation, process).await;
            }
            return Err(error);
        }
    };
    let mut reused = None;
    if let Some(conversation) = request.conversation_id.as_deref().filter(|_| parkable) {
        let session = request.native_session.as_ref().expect("parkable session");
        if let Some(mut process) = handed.take() {
            if !process.serves(&fingerprint, session) {
                pool.park(conversation, process).await;
                return Err("The reply could not continue this conversation's native session. Send the message again once the reply finishes.".into());
            }
            // Its output was never parked: what the work it carries reports is this reply's
            // to read.
            reused = Some(process);
            if let Some(channel) = &channel {
                let _ = channel.send(RunEvent::TakeOver);
            }
        } else if let Some(mut parked) = pool.take(conversation) {
            if parked.serves(&fingerprint, session) {
                parked.claim();
                reused = Some(parked);
            } else if parked.healthy {
                // Changed launch identity or session: start over. Claude model and
                // thinking budgets are acknowledged in-band before the next prompt.
                parked.finish().await;
            } else {
                parked.kill().await;
            }
        }
    }
    if let (Some(process), Some(conversation)) = (handed, &request.conversation_id) {
        pool.park(conversation, process).await;
        return Err(take_over::ENDED.into());
    }
    let mut config_cwd = None;
    if let Some(mut session) = request.native_session.take() {
        session.prepare_transfer(&app, &request).await?;
        request.native_session = Some(session);
    }
    let mut process = match reused {
        Some(process) => process,
        None => {
            let mut command = tokio::select! {
                command = chat_command(&request, &root, &exe) => command?,
                _ = cancel.cancelled() => return Ok(("cancelled".into(), String::new())),
            };
            // A fresh Claude process resumes its session from the transcript, which Claude Code's
            // cleanup may have deleted: then the reply starts a new session instead.
            if let Some(session) = request.native_session.as_mut() {
                let launch = command.as_std();
                let cwd = if exe.wsl.is_some() {
                    let args: Vec<_> = launch.get_args().collect();
                    args.windows(2)
                        .find(|a| a[0] == "--agent-studio-cwd")
                        .map(|a| a[1].to_string_lossy().into_owned())
                } else {
                    launch
                        .get_current_dir()
                        .map(|p| p.to_string_lossy().into_owned())
                };
                session.set_fork_folder(cwd.clone());
                let missing = tokio::select! {
                    missing = session.verify_transcript(&exe, cwd) => missing,
                    _ = cancel.cancelled() => return Ok(("cancelled".into(), String::new())),
                };
                if missing {
                    if request.compact {
                        return Err("Claude Code no longer has this chat's earlier session on this computer, so there is nothing to compact. Send a message to start a new session from the saved messages.".into());
                    }
                    command = chat_command(&request, &root, &exe).await?;
                }
            }
            if request.agent.provider == "claude"
                && request.agent.model.is_empty()
                && request.native_session.as_ref().is_some_and(|s| s.resumed)
            {
                let model = crate::providers::defaults::claude_model(
                    &exe,
                    &request,
                    command.as_std().get_current_dir().unwrap_or(&root),
                    &cancel,
                )
                .await;
                if cancel.is_cancelled() {
                    return Ok(("cancelled".into(), String::new()));
                }
                command.args(["--model", &model?]);
            }
            if let Some(session) = request
                .native_session
                .as_ref()
                .filter(|s| !s.resumed || s.switched_account)
            {
                if let Some(channel) = &channel {
                    if let Some(provider) = session.imported() {
                        let app = if provider == "codex" {
                            "Codex"
                        } else {
                            "Claude Code"
                        };
                        let text = if session.import_missing {
                            format!("The {app} session this chat was imported from is no longer on this computer, so this reply continues from the imported messages. Earlier tool details are not carried over.")
                        } else {
                            format!("Continuing this imported chat from its {app} session, with its tool results and context. Agent Studio continues a copy, so the original stays as it was in {app}.")
                        };
                        let _ = channel.send(RunEvent::Progress {
                            id: "studio-import".into(),
                            revision: 1,
                            text,
                        });
                    } else if session.transcript_missing {
                        let _ = channel.send(RunEvent::Progress { id: "studio-session-missing".into(), revision: 1, text: "Claude Code no longer has this chat's earlier session on this computer (it removes sessions unused for a while), so this reply continues from the saved messages. Earlier tool details and compacted context are not carried over.".into() });
                    } else if session.history_rewritten {
                        if request.messages.len() > 1 {
                            let _ = channel.send(RunEvent::Progress {
                                id: "studio-session-rewound".into(),
                                revision: 1,
                                text: crate::providers::sessions::REWIND_REPLAYED.into(),
                            });
                        }
                    } else if session.switched_account {
                        let _ = channel.send(RunEvent::Progress { id: "studio-account-switch".into(), revision: 1, text: "Continuing the latest native conversation history under the selected account. Saved tool results and compacted context are carried forward; live terminals and background processes are not restarted.".into() });
                    } else if request.messages.len() > 1 {
                        let _ = channel.send(RunEvent::Progress { id: "studio-session-bootstrap".into(), revision: 1, text: "Continuing this older chat from its saved messages. Native session history is retained from this reply onward; earlier unrecorded tool details are unavailable.".into() });
                    }
                }
            }
            config_cwd = if exe.wsl.is_some() {
                request
                    .location
                    .as_ref()
                    .map(|location| location.path.clone())
            } else {
                command
                    .as_std()
                    .get_current_dir()
                    .map(|p| p.to_string_lossy().into_owned())
            };
            let child = command
                .spawn()
                .map_err(|_| "Could not launch the provider CLI. Check Connections.")?;
            let session_id = request
                .native_session
                .as_ref()
                .map(|s| s.id().to_string())
                .unwrap_or_default();
            // Work a chat leaves running in the background outlives its reply.
            let watch = request
                .conversation_id
                .as_deref()
                .filter(|_| parkable && channel.is_some() && request.agent.provider == "claude")
                .map(|conversation| crate::background_work::watch(&app, conversation));
            let mut process = crate::pool::Process::new_observed(
                exe.clone(),
                child,
                fingerprint,
                session_id,
                crate::background_work::observer(
                    channel
                        .as_ref()
                        .and_then(|_| crate::live_usage::observer(&app, &request.agent.provider)),
                    watch.clone(),
                ),
            )?;
            process.background = watch;
            process
        }
    };
    let reused = process.turns > 0;
    if reused
        && request.agent.provider == "claude"
        && request.agent.model.trim().is_empty()
        && process
            .claude_settings
            .as_ref()
            .is_none_or(|s| !s.uses_default_model())
    {
        // Query the selected profile/folder without a model turn, then update the
        // existing chat process. Never infer that an acknowledged null reset worked.
        let default = async {
            let command = chat_command(&request, &root, &exe).await?;
            crate::providers::defaults::claude_model(
                &exe,
                &request,
                command.as_std().get_current_dir().unwrap_or(&root),
                &cancel,
            )
            .await
        };
        // The reader handles cancellation and releases its owned process tree.
        let result = default.await;
        match result {
            Ok(model) => request.claude_default_model = Some(model),
            Err(error) => {
                match request.conversation_id.as_deref() {
                    // Work an earlier reply handed over with this process runs on.
                    Some(conversation) if process.carried.is_some() => {
                        pool.park(conversation, process).await
                    }
                    _ => process.finish().await,
                }
                return if cancel.is_cancelled() {
                    Ok(("cancelled".into(), String::new()))
                } else {
                    Err(error)
                };
            }
        }
    }
    if matches!(request.agent.provider.as_str(), "codex" | "claude") {
        if let Some(channel) = &channel {
            let _ = channel.send(RunEvent::FileChanges {
                file_changes: crate::protocol::file_changes::Snapshot::empty(),
            });
        }
    }
    let result = if request.uses_codex_server() {
        crate::providers::codex_chat::run(
            &mut process,
            &request,
            channel.as_ref(),
            cancel,
            questions
                .as_mut()
                .ok_or("Question channel is unavailable")?,
            config_cwd.as_deref(),
            reused,
        )
        .await
    } else {
        stream_turn(
            &mut process,
            &request,
            channel.as_ref(),
            cancel,
            questions.as_mut(),
            reused,
        )
        .await
    };
    process.turns += 1;
    if let Some(watch) = &process.background {
        watch.detach(&request.run_id);
    }
    // The next message took this reply's process over while it waited for background work.
    if let Some(next) = process.hand_off.take() {
        // Its native session lock goes first, so the next reply can prepare its own.
        request.native_session = None;
        if let Err(Ok(process)) = next.send(Ok(process)) {
            // The next reply stopped meanwhile: the process stays with the conversation.
            if let Some(conversation) = request.conversation_id.as_deref() {
                pool.park(conversation, process).await;
            }
        }
        return result;
    }
    // A finished or cleanly interrupted turn leaves the CLI waiting for the next reply.
    let park = parkable
        && process.healthy
        && matches!(&result, Ok((status, _)) if status == "complete" || status == "cancelled")
        && process.alive();
    if park {
        pool.park(request.conversation_id.as_deref().unwrap(), process)
            .await;
    } else if process.healthy {
        process.finish().await;
    } else {
        process.kill().await;
    }
    result
}
/// How long a Claude reply waits for the turn that reports finished background tasks the
/// model declared. The CLI starts that turn right after its previous result.
const FOLLOW_UP_GRACE: Duration = if cfg!(test) {
    Duration::from_secs(2)
} else {
    Duration::from_secs(15)
};
/// One reply over a stream-json process: Claude chats (persistent), Claude background
/// queries, and Antigravity (one prompt, then input closes).
async fn stream_turn(
    process: &mut crate::pool::Process,
    request: &RunRequest,
    channel: Option<&EventSink>,
    cancel: CancellationToken,
    mut questions: Option<&mut crate::providers::questions::Session>,
    reused: bool,
) -> Result<(String, String), String> {
    use crate::pool::Line;
    if cancel.is_cancelled() {
        process.healthy = false;
        return Ok(("cancelled".into(), String::new()));
    }
    let claude_visualizer = request.uses_claude_visualizer();
    let persistent = claude_visualizer && request.native_session.is_some();
    let prompt = request.stdin_payload();
    let mut stdin_open = true;
    let mut initialized = reused;
    let mut prompt_sent = false;
    let mut settings = crate::providers::claude_settings::Update::new(
        &request.agent,
        process.claude_settings.as_ref(),
        reused,
        request.claude_default_model.as_deref(),
    )?;
    let send_failed = "Could not send input to the provider CLI.";
    if !claude_visualizer {
        // Background and text-only runs send one prompt and close their input.
        process
            .stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|_| send_failed)?;
        prompt_sent = true;
        stdin_open = false;
        process.stdin.shutdown().await.map_err(|_| send_failed)?;
    } else if reused {
        if let Some(session) = &request.native_session {
            session.bind(session.id(), false)?;
        }
        prompt_sent = settings.advance(process, &prompt).await?;
    } else {
        // The process keeps these hooks for every later reply, each answering them as it runs.
        let init = serde_json::json!({"type":"control_request","request_id":"studio-init","request":{"subtype":"initialize","hooks":crate::providers::after_compaction::hooks()}});
        process
            .stdin
            .write_all(format!("{init}\n").as_bytes())
            .await
            .map_err(|_| send_failed)?;
    }
    let mut decoder = Decoder::default();
    decoder.cost_baseline = process.cost_total;
    decoder.expect_structured_output = request.agent.output_schema.is_some() && !request.compact;
    let mut tool_tick = tokio::time::interval(Duration::from_secs(1));
    tool_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    decoder.compactions.manual = request.compact;
    let mut visualizer = crate::providers::visualize::Visualizer::with_tools(
        crate::providers::workflow_calls::tools(
            request.workflow_tools(),
            request.mission.is_some(),
        ),
    );
    // What a compaction hears again, worked out once its hooks ask (`after_compaction`).
    let mut compaction_guidance = crate::providers::after_compaction::Guidance::default();
    let mut sender = crate::providers::sent_files::FileSender::default();
    let mut published = crate::providers::published_artifacts::PublishedArtifacts::default();
    let mut screen_tools = crate::screens::tools::Agent::default();
    let screen_context = channel.and_then(EventSink::screens);
    // Files this reply shows are checked and kept where the conversation runs.
    let staging = crate::providers::sent_files::Staging::new(
        &request.run_id,
        process.exe.wsl.as_ref().map(|w| w.distribution.clone()),
        channel,
        cancel.clone(),
    );
    let mut input_lifetime = crate::providers::visualize::ClaudeInputLifetime::with_context(
        request.native_session.is_none() || request.native_context().is_some(),
    );
    // Background work an earlier reply handed over with this process, which this reply goes on
    // waiting for as for its own.
    let took_over = process.carried.is_some();
    if let Some(carried) = process.carried.take() {
        input_lifetime.inherit(carried);
    }
    // That work may start a turn before the CLI takes this reply's message, and so does a resumed
    // session whose earlier CLI ended with commands still running: it reports them stopped and
    // ends that notice's turn without a request first. The CLI replays each message it takes
    // (--replay-user-messages), so only a result after the replay can end a reply; the first
    // reply after a restart otherwise ended at the notice without an answer, its message unread.
    // A compaction ends at its own result.
    let mut prompt_replayed = !claude_visualizer || request.compact;
    // The idle stretch this reply waits in, by number: its turn ended while background work it
    // waits for continues, and no turn has started since. The next message may take over here.
    let mut waiting: Option<u64> = None;
    let mut stretches = 0;
    let mut session_received = false;
    let interrupt_deadline = tokio::time::sleep(crate::pool::INTERRUPT_GRACE);
    tokio::pin!(interrupt_deadline);
    let mut interrupting = false;
    // An idle CLI answers Stop with acknowledgements only, never a result.
    let mut stopping = HashSet::new();
    let mut stopped_idle = false;
    let follow_up_deadline = tokio::time::sleep(FOLLOW_UP_GRACE);
    tokio::pin!(follow_up_deadline);
    let mut awaiting_follow_up = false;
    let mut steering: HashMap<String, crate::providers::steering::Delivery> = HashMap::new();
    let mut diagnostics = String::new();
    // The mode the CLI last reported: an approved plan decision changes it during a reply.
    let mut planning = request.agent.plan_mode;
    loop {
        let (answer_rx, steering_rx, elicitation_rx, take_over_rx, workflow_rx) =
            match questions.as_mut() {
                Some(q) => (
                    Some(&mut q.rx),
                    Some(&mut q.steering.rx),
                    Some(&mut q.elicitation.rx),
                    Some(&mut q.take_over.rx),
                    Some(&mut q.workflow.rx),
                ),
                None => (None, None, None, None, None),
            };
        let mut turn_ended = false;
        tokio::select! {
            biased;
            _ = tool_tick.tick() => {
                for event in decoder.tool_tick() {
                    if let (Some(watch), RunEvent::Tool { tool }) = (&process.background, &event) { watch.tool(&request.run_id, tool); }
                    if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } }
                }
                if let Some(watch) = &process.background { watch.tick(); }
            }
            _ = cancel.cancelled(), if !interrupting => {
                if let Some(q) = &questions { q.close(); }
                if let Some(q) = &questions { q.elicitation.close(); }
                if let Some(q) = &questions { q.workflow.close(); }
                if let Some(q) = &questions { q.steering.ready(false); }
                if persistent && prompt_sent && stdin_open {
                    // Ask the CLI to end this turn in-band so it stays usable for the next reply.
                    let id = format!("studio-interrupt-{}", process.turns + 1);
                    let interrupt = format!("{{\"type\":\"control_request\",\"request_id\":\"{id}\",\"request\":{{\"subtype\":\"interrupt\"}}}}\n");
                    if process.stdin.write_all(interrupt.as_bytes()).await.is_ok() {
                        interrupting = true;
                        stopping.insert(id);
                        // Background work this reply waits for would otherwise start an unobserved
                        // turn in the parked process. Servers left for the user keep running.
                        for (index, task) in input_lifetime.stoppable().into_iter().enumerate() {
                            let id = format!("studio-stop-{}-{index}", process.turns + 1);
                            let stop = serde_json::json!({"type":"control_request","request_id":id,"request":{"subtype":"stop_task","task_id":task}});
                            if process.stdin.write_all(format!("{stop}\n").as_bytes()).await.is_ok() { stopping.insert(id); }
                        }
                        interrupt_deadline.as_mut().reset(tokio::time::Instant::now() + crate::pool::INTERRUPT_GRACE);
                        continue;
                    }
                }
                process.healthy = false;
                process.kill().await;
                break Ok(("cancelled".to_string(), decoder.text));
            }
            _ = &mut interrupt_deadline, if interrupting => {
                process.healthy = false;
                process.kill().await;
                break Ok(("cancelled".to_string(), decoder.text));
            }
            _ = &mut follow_up_deadline, if awaiting_follow_up && !interrupting => {
                // No turn came to report the finished tasks, so the model already has them.
                awaiting_follow_up = false;
                input_lifetime.awaited.release();
                turn_ended = prompt_replayed;
            }
            Some(delivery) =async { match answer_rx { Some(rx) => rx.recv().await, None => std::future::pending().await } }, if !interrupting => {
                let result = if stdin_open && questions.as_ref().unwrap().can_deliver(&delivery) {
                    process.stdin.write_all(format!("{}\n", delivery.payload).as_bytes()).await.map_err(|_| "Could not send answers to Claude.".to_string())
                } else {
                    Err("Claude is no longer waiting for answers.".into())
                };
                // Until a native mode status confirms the transition, this
                // process cannot be reused under its old permission identity.
                if result.is_ok() && delivery.payload["response"]["response"]["updatedPermissions"].is_array() {
                    process.fingerprint.clear();
                }
                questions.as_ref().unwrap().delivered(delivery, result);
            },
            Some(delivery) = async { match steering_rx { Some(rx) => rx.recv().await, None => std::future::pending().await } }, if !interrupting => {
                let payload = serde_json::json!({"type":"user","uuid":delivery.input.id,"origin":{"kind":"human"},"message":{"role":"user","content":[{"type":"text","text":delivery.input.text}]}});
                if process.stdin.write_all(format!("{payload}\n").as_bytes()).await.is_err() {
                    questions.as_ref().unwrap().steering.delivered(delivery, Err("Could not send steering to Claude.".into()));
                    process.healthy = false; break Err(send_failed.into());
                }
                steering.insert(delivery.input.id.clone(), delivery);
            },
            Some(delivery) = async { match workflow_rx { Some(rx) => rx.recv().await, None => std::future::pending().await } }, if !interrupting => {
                let q = &questions.as_ref().unwrap().workflow;
                let result = if stdin_open && q.can_deliver(&delivery) {
                    process.stdin.write_all(format!("{}\n", delivery.payload).as_bytes()).await.map_err(|_| "Could not send the workflow's answer to Claude.".to_string())
                } else { Err("Claude is no longer waiting for this workflow call.".into()) };
                q.delivered(delivery, result);
            },
            Some(delivery) = async { match elicitation_rx { Some(rx) => rx.recv().await, None => std::future::pending().await } }, if !interrupting => {
                let q = &questions.as_ref().unwrap().elicitation;
                let result = if stdin_open && q.can_deliver(&delivery) {
                    process.stdin.write_all(format!("{}\n", delivery.payload).as_bytes()).await.map_err(|_| "Could not send MCP input to Claude.".to_string())
                } else { Err("This MCP request is no longer waiting.".into()) };
                q.delivered(delivery, result);
            },
            line = process.lines.recv() => match line {
                Some(Line::Err(line)) => {
                    if request.agent.provider == "gemini" && line.trim().to_lowercase().starts_with("authentication required") {
                        process.healthy = false;
                        break Err(provider_error(&line).into());
                    }
                    diagnostics.push_str(&line);
                    diagnostics.push('\n');
                }
                Some(Line::Out(line)) => {
                    let mut routed = false;
                    if claude_visualizer {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                            if initialized && !prompt_sent {
                                match settings.acknowledge(&value, &process.session_id) {
                                    Ok(true) => {
                                        prompt_sent = settings.advance(process, &prompt).await?;
                                        continue;
                                    }
                                    Err(error) => { process.healthy = false; break Err(error); }
                                    Ok(false) => {}
                                }
                                // Late prior-turn text/results must not complete this reply
                                // or bind its history before the settings are acknowledged.
                                if value["type"] != "control_request" {
                                    // Work taken over with the process keeps reporting meanwhile.
                                    if took_over {
                                        if let Some(watch) = &process.background { watch.route(&value); }
                                        input_lifetime.track(&value);
                                    }
                                    continue;
                                }
                                // Only SDK tool discovery is needed between turns. Never
                                // accept an old question or visualization as this reply's work.
                                let discovery = value["request"]["subtype"] == "mcp_message"
                                    && value["request"]["server_name"] == "agent_studio"
                                    && matches!(value["request"]["message"]["method"].as_str(), Some("initialize" | "notifications/initialized" | "ping" | "tools/list"));
                                let response = if let Some(answer) = compaction_guidance.answer(&value, || request.compaction_context()) { answer } else if discovery { visualizer.claude_response(&value) } else {
                                    serde_json::json!({"type":"control_response","response":{"subtype":"error","request_id":value["request_id"],"error":"Unavailable while applying next-reply settings"}})
                                };
                                process.stdin.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| send_failed)?;
                                continue;
                            }
                            // Lines about the sub-agents of a reply that handed this process over
                            // belong to that reply, apart from file edits, which are this reply's.
                            routed = process.background.as_ref().is_some_and(|watch| watch.route(&value));
                            if routed {
                                for event in decoder.decode_file_changes(&request.agent.provider, &value) {
                                    if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } }
                                }
                            }
                            if value["parent_tool_use_id"].is_null()
                                && (matches!(value["type"].as_str(), Some("assistant" | "stream_event" | "user"))
                                    || (value["type"] == "system" && value["subtype"] == "init"))
                            {
                                if value["type"] == "user" && value["uuid"].as_str() == Some(request.run_id.as_str()) {
                                    prompt_replayed = true;
                                }
                                // A turn started, so the reply's text may change from here.
                                if waiting.take().is_some() {
                                    if let Some(channel) = channel { let _ = channel.send(RunEvent::BackgroundWait { wait: None }); }
                                }
                                // The answer of the turn before starts again ahead of what this
                                // line brings, such as the steer that began the turn.
                                if let Some(event) = decoder.turn_started() {
                                    if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } }
                                }
                            }
                            if value["type"] == "user" && value["parent_tool_use_id"].is_null() {
                                if let Some(delivery) = value["uuid"].as_str().and_then(|id| steering.remove(id)) {
                                    questions.as_ref().unwrap().steering.delivered(delivery, Ok(()));
                                }
                            }
                            if value["type"] == "system" && value["subtype"] == "init" && value["parent_tool_use_id"].is_null() {
                                if let Some(session) = &request.native_session {
                                    // A follow-up turn's init keeps this reply's confirmed input.
                                    let result = value["session_id"].as_str().ok_or("Claude did not report a native session identity".to_string()).and_then(|id| session.bind(id, session_received).map(|()| id.to_string()));
                                    match result { Ok(id) => process.session_id = id, Err(error) => { process.healthy = false; break Err(error); } }
                                }
                            }
                            if !session_received && (value["type"] == "assistant" || (request.compact && value["type"] == "system" && value["subtype"] == "compact_boundary")) && value["parent_tool_use_id"].is_null() {
                                if let Some(session) = &request.native_session {
                                    if let Err(error) = session.bind(&process.session_id, true) { process.healthy = false; break Err(error); }
                                    session_received = true;
                                }
                                if let Some(q) = &questions { q.steering.ready(!request.compact && !interrupting); }
                            }
                            if value["type"] == "control_response" && value["response"]["request_id"] == "studio-init" && !initialized {
                                if value["response"]["subtype"] != "success" { process.healthy = false; break Err("Claude could not initialize conversation tools. Check its CLI version.".into()); }
                                initialized = true;
                                prompt_sent = settings.advance(process, &prompt).await?;
                                continue;
                            }
                            if let Some(questions) = &mut questions { questions.observe_claude(&value); questions.elicitation.observe(&value, None); }
                            // Track the CLI's actual permission mode in the parked-process
                            // identity. The next reply still applies its explicit mode choice.
                            if value["type"] == "system" && value["parent_tool_use_id"].is_null()
                                && matches!(value["subtype"].as_str(), Some("init" | "status"))
                                && (value["session_id"].is_null() || value["session_id"].as_str() == Some(process.session_id.as_str())) {
                                if let Some(mode) = value["permissionMode"].as_str().filter(|m| matches!(*m,"plan" | "bypassPermissions")) {
                                    planning = mode == "plan";
                                    let mut effective = request.clone();
                                    effective.agent.plan_mode = planning;
                                    if effective.native_session.is_some() { process.fingerprint = crate::pool::fingerprint(&effective, &process.exe)?; }
                                }
                            }
                            for event in visualizer.observe_claude(&value) { if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } } }
                            for event in sender.observe_claude(&value) { if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } } }
                            for event in published.observe_claude(&value) { if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } } }
                            for event in screen_tools.observe_claude(&value) { if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } } }
                            if let Some(q) = &mut questions { q.workflow.observe_claude(&value); }
                            if value["type"] == "control_request" {
                                // A compaction, automatic or /compact, asks for the guidance its summary replaced.
                                if let Some(answer) = compaction_guidance.answer(&value, || request.compaction_context()) {
                                    process.stdin.write_all(format!("{answer}\n").as_bytes()).await.map_err(|_| send_failed)?;
                                    continue;
                                }
                                let own_session = value["session_id"].is_null() || value["session_id"].as_str() == Some(process.session_id.as_str());
                                if let Some(response) = questions.as_mut().and_then(|q| q.claude_plan(&value, initialized && prompt_sent && !interrupting && !request.compact && own_session)) {
                                    if let Some(response) = response { process.stdin.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| send_failed)?; }
                                    continue;
                                }
                                if let Some(response) = questions.as_mut().and_then(|q| q.elicitation.claude(&value, initialized && prompt_sent && !interrupting && !request.compact && own_session)) {
                                    if let Some(response) = response { process.stdin.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| send_failed)?; }
                                    continue;
                                }
                                if let Some(response) = questions.as_mut().and_then(|q| q.claude(&value)) {
                                    if let Some(response) = response { let _ = process.stdin.write_all(format!("{response}\n").as_bytes()).await; }
                                    continue;
                                }
                                if value["request"]["subtype"] == "can_use_tool" {
                                    let response = crate::providers::questions::refuse_tool(&value, planning);
                                    process.stdin.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| send_failed)?;
                                    continue;
                                }
                                if let Some(response) = input_lifetime.awaited.claude_response(&value) {
                                    process.stdin.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| send_failed)?;
                                    continue;
                                }
                                if let Some(response) = questions.as_mut().and_then(|q| q.workflow.claude(&value)) {
                                    if let Some(response) = response { process.stdin.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| send_failed)?; }
                                    continue;
                                }
                                if let Some(response) = screen_tools.claude(&value, screen_context.as_deref()).await {
                                    process.stdin.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| send_failed)?;
                                    continue;
                                }
                                if let Some(response) = sender.claude(&value, &staging).await {
                                    process.stdin.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| send_failed)?;
                                    continue;
                                }
                                let response = visualizer.claude_response(&value);
                                let _ = process.stdin.write_all(format!("{response}\n").as_bytes()).await;
                                continue;
                            }
                            let context_result = input_lifetime.is_context_result(&value);
                            // A turn the CLI began for taken-over work before this reply's
                            // message never ends the reply.
                            turn_ended = input_lifetime.ended(&value) && prompt_replayed;
                            // A zero-turn acknowledgement of injected history is not a reply, nor
                            // is the empty turn of a notice before the CLI takes the message.
                            if context_result || (!prompt_replayed && !took_over && crate::providers::visualize::empty_result(&value)) { continue; }
                            let result = value["type"] == "result" && value["parent_tool_use_id"].is_null();
                            // A failed result can carry a zeroed total; it never lowers the baseline.
                            if let Some(total) = value["total_cost_usd"].as_f64().filter(|total| result && total.is_finite() && *total >= 0.0) {
                                if value["is_error"] != true || total >= process.cost_total { process.cost_total = total; }
                            }
                            if interrupting {
                                // Stop ends the reply at the interrupted turn's result, even with
                                // background work left. An idle CLI only acknowledges the requests.
                                turn_ended |= result;
                                if let Some(id) = value["response"]["request_id"].as_str().filter(|_| value["type"] == "control_response") {
                                    if stopping.remove(id) && id.starts_with("studio-stop-") && value["response"]["subtype"] != "success" { process.healthy = false; }
                                    if stopping.is_empty() && !input_lifetime.awaited.turn_active() { turn_ended = true; stopped_idle = true; }
                                }
                            } else if result && !turn_ended && (prompt_replayed || took_over) {
                                if let Some(channel) = channel { let _ = channel.send(RunEvent::Activity { text: "Waiting for background work to finish".into() }); }
                                // The CLI is idle until the work reports: the next message may
                                // take over this reply from here.
                                if persistent && !request.compact && prompt_replayed {
                                    stretches += 1;
                                    waiting = Some(stretches);
                                    if let Some(channel) = channel { let _ = channel.send(RunEvent::BackgroundWait { wait: waiting }); }
                                }
                            }
                            let expecting = !interrupting && input_lifetime.expects_follow_up();
                            if expecting && !awaiting_follow_up { follow_up_deadline.as_mut().reset(tokio::time::Instant::now() + FOLLOW_UP_GRACE); }
                            awaiting_follow_up = expecting;
                        }
                    }
                    for event in if routed { vec![] } else { decoder.decode(&request.agent.provider, &line) } {
                        if let (Some(watch), RunEvent::Tool { tool }) = (&process.background, &event) { watch.tool(&request.run_id, tool); }
                        if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } }
                    }
                    let outputs = decoder.take_tool_outputs();
                    if let Some(channel) = channel { channel.outputs(outputs); }
                }
                None => {
                    process.healthy = false;
                    let success = process.child.wait().await.map_err(|_| "Could not collect the provider process result")?.success();
                    if !success || decoder.failure.is_some() {
                        if let Some(limit) = decoder.usage_limit { break Err(limit.text); }
                        let diagnostic = format!("{} {}", diagnostics, decoder.failure.unwrap_or_default()).to_lowercase();
                        break Err(provider_error(&diagnostic).into());
                    }
                    if request.agent.provider == "gemini" && !decoder.completed { break Err("Antigravity ended before confirming the response. Try again.".into()); }
                    if claude_visualizer && stdin_open { break Err("Claude exited before confirming the final reply. Partial output has been kept.".into()); }
                    if decoder.text.trim().is_empty() && !visualizer.has_visuals() && !sender.has_files() && !published.has_artifacts() && !screen_tools.has_screens() { break Err("The CLI exited without a text response. Check Connections or try another model.".into()); }
                    break Ok(("complete".to_string(), decoder.text));
                }
            },
            // After the output branch, so a turn the CLI already reported refuses the request.
            Some(next) = async { match take_over_rx { Some(rx) => rx.recv().await, None => std::future::pending().await } }, if !interrupting => {
                let refusal = if waiting != Some(next.wait) || !steering.is_empty() {
                    Some(take_over::BUSY)
                } else if next.fingerprint != process.fingerprint {
                    Some(take_over::CHANGED)
                } else {
                    None
                };
                if let Some(reason) = refusal {
                    let _ = next.reply.send(Err(reason.into()));
                    continue;
                }
                if next.reply.is_closed() {
                    continue;
                }
                // The CLI is idle, so the next message starts a turn at once. This reply ends
                // here and hands over its process and the work it still waits for.
                if let Some(q) = &questions {
                    q.close();
                    q.elicitation.close();
                    q.steering.ready(false);
                }
                process.carried = Some(input_lifetime.carry());
                if let Some(watch) = &process.background {
                    watch.adopt(&request.run_id, decoder.hand_over(), channel.and_then(EventSink::recorder));
                }
                process.hand_off = Some(next.reply);
                break Ok(("complete".into(), decoder.text));
            }
        }
        if turn_ended {
            if let Some(q) = &questions {
                q.close();
                q.elicitation.close();
                q.steering.ready(false);
            }
            if !steering.is_empty() {
                // A late input can become Claude's next turn. Stop the owned process
                // before parking to avoid an unobserved follow-up and uncertain billing.
                process.healthy = false;
                process.kill().await;
            }
            if persistent {
                if interrupting {
                    // An interrupted turn reports an execution error; the CLI stays usable.
                    break Ok((
                        if decoder.failure.is_some() || stopped_idle {
                            "cancelled"
                        } else {
                            "complete"
                        }
                        .to_string(),
                        decoder.text,
                    ));
                }
                if let Some(failure) = decoder.failure.take() {
                    process.healthy = false;
                    // The provider's own line names the limit that stopped the reply and its reset.
                    break Err(match decoder.usage_limit.take() {
                        Some(limit) => limit.text,
                        None => provider_error(&format!("{diagnostics} {failure}")).into(),
                    });
                }
                if request.compact {
                    if !decoder.compactions.completed() {
                        process.healthy = false;
                        break Err("Claude ended without confirming compaction. The conversation was preserved.".into());
                    }
                    if let Some(channel) = channel {
                        let _ = channel.send(RunEvent::Text {
                            text: "Context compacted.".into(),
                        });
                    }
                    break Ok(("complete".into(), "Context compacted.".into()));
                }
                if decoder.text.trim().is_empty()
                    && !visualizer.has_visuals()
                    && !sender.has_files()
                    && !published.has_artifacts()
                {
                    process.healthy = false;
                    break Err("The CLI finished without a text response. Check Connections or try another model.".into());
                }
                break Ok(("complete".to_string(), decoder.text));
            }
            // Chats without a conversation identity still end with their process.
            stdin_open = false;
            let _ = process.stdin.shutdown().await;
        }
    }
}
fn provider_error(diagnostic: &str) -> &'static str {
    let diagnostic = diagnostic.to_lowercase();
    if diagnostic.contains("structured")
        || diagnostic.contains("json-schema")
        || diagnostic.contains("json schema")
    {
        return "The provider could not return the requested structured JSON output. Check the schema, retry, or disable structured output.";
    }
    if diagnostic.contains("no conversation found") || diagnostic.contains("session not found") {
        "Claude could not resume this conversation's native session. Its saved history was preserved. Check the selected CLI profile, or start a new conversation; no message was replayed."
    } else if diagnostic.contains("another claude code process is refreshing") {
        // Several of the account's CLIs renewed an expired login at once, as when the app
        // starts after a night: the login itself is fine, so the account stays signed in.
        "Another Claude Code process was renewing this account's login. Try again in a moment."
    } else if diagnostic.contains("prompt is too long") {
        "The conversation is too long for the model's context. Try again, or compact it first."
    } else if diagnostic.contains("selected folder is unavailable") {
        "The selected folder is unavailable. Choose an existing folder before sending."
    } else if diagnostic.contains("unsupported_client")
        || diagnostic.contains("client is no longer supported")
    {
        "Google retired Gemini CLI access for individual subscriptions. Install Antigravity CLI (agy) in Connections; repeating Gemini CLI sign-in will not fix this."
    } else if diagnostic.contains("quota")
        || diagnostic.contains("rate limit")
        || diagnostic.contains("usage limit")
        || diagnostic.contains("resource_exhausted")
    {
        "The provider's usage limit was reached. Try another agent or wait for your limit to reset."
    } else if diagnostic.contains("model")
        && (diagnostic.contains("not found")
            || diagnostic.contains("not supported")
            || diagnostic.contains("invalid")
            || diagnostic.contains("unknown"))
    {
        "That model is not available to this CLI account. Choose another model from the chat header."
    } else if diagnostic.contains("ineligible")
        || diagnostic.contains("not eligible")
        || diagnostic.contains("access denied")
    {
        "The provider rejected this account's access. Check your account's eligibility with the provider; repeating sign-in may not resolve it."
    } else if diagnostic.contains("auth")
        || diagnostic.contains("login")
        || diagnostic.contains("sign in")
        || diagnostic.contains("credentials")
    {
        "Your CLI login needs attention. Open Connections, sign in, and try again."
    } else {
        "The provider CLI could not complete the request. Check its login, model access, and connection, then try again."
    }
}
#[cfg(test)]
#[path = "runner_claude_tests.rs"]
mod claude_tests;

#[cfg(test)]
#[path = "elicitation_native_tests.rs"]
mod elicitation_native_tests;

#[cfg(test)]
#[path = "claude_native_tests.rs"]
mod claude_native_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn conversations_run_side_by_side_but_each_admits_one_reply() {
        let runs = Runs::default();
        let other_app = Runs::default();
        let current = CancellationToken::new();
        let unrelated = CancellationToken::new();
        runs.begin("current", Some("a"), current.clone(), None)
            .await
            .unwrap();
        other_app
            .begin("other", Some("a"), unrelated.clone(), None)
            .await
            .unwrap();
        assert!(runs
            .begin("next", Some("a"), CancellationToken::new(), None)
            .await
            .unwrap_err()
            .contains("already responding"));
        let beside = CancellationToken::new();
        runs.begin("beside", Some("b"), beside.clone(), None)
            .await
            .unwrap();
        runs.begin("unscoped", None, CancellationToken::new(), None)
            .await
            .unwrap();
        assert!(!current.is_cancelled() && !beside.is_cancelled());
        runs.reloaded();
        assert!(
            !current.is_cancelled() && !beside.is_cancelled() && !unrelated.is_cancelled(),
            "a reload stops no reply"
        );
        assert!(runs.0.lock().unwrap().contains_key("current"));
    }

    #[tokio::test]
    async fn a_message_that_continues_a_reply_runs_beside_only_that_running_reply() {
        let runs = Runs::default();
        let waiting = CancellationToken::new();
        runs.begin("waiting", Some("a"), waiting.clone(), None)
            .await
            .unwrap();
        let refused = |result: Result<(), String>| result.unwrap_err() == take_over::ENDED;
        // A reply that is not the conversation's running one cannot be continued.
        assert!(refused(
            runs.begin("stray", Some("a"), CancellationToken::new(), Some("other"))
                .await
        ));
        assert!(refused(
            runs.begin(
                "elsewhere",
                Some("b"),
                CancellationToken::new(),
                Some("waiting")
            )
            .await
        ));
        runs.begin("next", Some("a"), CancellationToken::new(), Some("waiting"))
            .await
            .unwrap();
        // Only one message continues it, and nothing else starts meanwhile.
        assert!(refused(
            runs.begin(
                "again",
                Some("a"),
                CancellationToken::new(),
                Some("waiting")
            )
            .await
        ));
        assert!(runs
            .begin("plain", Some("a"), CancellationToken::new(), None)
            .await
            .unwrap_err()
            .contains("already responding"));
        runs.0.lock().unwrap().remove("next");
        // A stopping reply no longer waits for anything.
        waiting.cancel();
        assert!(refused(
            runs.begin("late", Some("a"), CancellationToken::new(), Some("waiting"))
                .await
        ));
    }

    #[tokio::test]
    async fn a_reply_keeps_its_conversation_across_a_reload() {
        let runs = Runs::default();
        let old = CancellationToken::new();
        runs.begin("old", Some("a"), old.clone(), None)
            .await
            .unwrap();
        runs.reloaded();
        // The reloaded window follows the running reply rather than starting another.
        assert!(runs
            .begin("new", Some("a"), CancellationToken::new(), None)
            .await
            .unwrap_err()
            .contains("already responding"));
        runs.begin("elsewhere", Some("b"), CancellationToken::new(), None)
            .await
            .unwrap();
        assert!(!old.is_cancelled());
    }

    #[tokio::test]
    async fn replacement_waits_for_a_stopped_reply_to_end() {
        let runs = Runs::default();
        let old = CancellationToken::new();
        runs.begin("old", Some("a"), old.clone(), None)
            .await
            .unwrap();
        old.cancel();
        let replacement = CancellationToken::new();
        let next = runs.begin("new", Some("a"), replacement.clone(), None);
        tokio::pin!(next);
        assert!(tokio::time::timeout(Duration::from_millis(75), &mut next)
            .await
            .is_err());
        assert!(!runs.0.lock().unwrap().contains_key("new"));
        // Another conversation does not wait for this one's process to exit.
        runs.begin("elsewhere", Some("b"), CancellationToken::new(), None)
            .await
            .unwrap();
        runs.0.lock().unwrap().remove("old");
        next.await.unwrap();
        assert!(runs.0.lock().unwrap().contains_key("new"));
        assert!(!replacement.is_cancelled());
    }

    #[tokio::test]
    async fn a_reload_refuses_a_request_waiting_in_the_previous_document() {
        let runs = Runs::default();
        let old = CancellationToken::new();
        runs.begin("old", Some("a"), old.clone(), None)
            .await
            .unwrap();
        old.cancel();
        let next = runs.begin("stale", Some("a"), CancellationToken::new(), None);
        tokio::pin!(next);
        assert!(tokio::time::timeout(Duration::from_millis(75), &mut next)
            .await
            .is_err());
        runs.reloaded();
        runs.0.lock().unwrap().remove("old");
        assert!(next.await.unwrap_err().contains("app reloaded"));
        assert!(runs.0.lock().unwrap().is_empty());
        runs.begin("current", Some("a"), CancellationToken::new(), None)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_reply_asked_for_before_a_reload_never_runs_unfollowed() {
        let runs = Runs::default();
        let window: crate::reply_feed::Window = Arc::new(|_| Ok(()));
        let document = runs.document();
        runs.begin("late", Some("a"), CancellationToken::new(), None)
            .await
            .unwrap();
        runs.reloaded();
        let refused = runs.open_feed(document, "late", Some("a".into()), false, window.clone());
        assert_eq!(refused.err().as_deref(), Some(RELOADED));
        assert!(runs.0.lock().unwrap().is_empty());
        assert!(runs.2.live().is_empty());
        // A request of the current document joins the replies a reload would list.
        let document = runs.document();
        runs.begin("current", Some("a"), CancellationToken::new(), None)
            .await
            .unwrap();
        runs.open_feed(document, "current", Some("a".into()), false, window)
            .unwrap();
        runs.reloaded();
        assert_eq!(runs.2.live().len(), 1);
    }

    #[test]
    fn retired_clients_and_quota_do_not_restart_authentication() {
        let error = provider_error("Authentication succeeded. Failed to sign in: This client is no longer supported for Gemini Code Assist for individuals.");
        assert!(error.contains("Antigravity"));
        assert!(!error.contains("login needs attention"));
        assert!(provider_error("auth error: RESOURCE_EXHAUSTED").contains("usage limit"));
        assert!(provider_error("Authentication required").contains("login needs attention"));
        assert!(
            provider_error("bash: cd: permission denied\nSelected folder is unavailable")
                .contains("Choose an existing folder")
        );
        // Claude Code's own lines when another of its processes held the renewal, and when it
        // refused a conversation too long for the model: neither is a signed-out account.
        let renewing = provider_error(" success Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again");
        assert!(renewing.contains("Try again in a moment"));
        assert!(!renewing.contains("login needs attention"));
        assert!(provider_error(" success Prompt is too long").contains("compact it first"));
    }
}
