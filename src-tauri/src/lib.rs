mod artifacts;
mod background_work;
mod badges;
mod calls;
mod chat_images;
mod claude_pages;
mod cli_queries;
mod cli_updates;
mod console;
mod context;
mod drafts;
mod folder_icons;
mod folders;
mod imports;
mod lending;
mod linking;
mod live_usage;
mod mcp;
pub mod memory;
mod mentions;
mod models;
mod native_instructions;
mod notifications;
mod page_guard;
mod page_preview;
mod plugins;
mod pool;
mod profiles;
mod protocol;
mod providers;
mod relay;
mod reply_feed;
mod retention;
mod runner;
mod saved;
mod screens;
mod sent;
mod server;
mod shared_context;
mod shutdown;
mod sign_in;
mod site_icons;
mod spend;
mod standalone;
mod startup;
mod structured_output;
mod sync_state;
mod titles;
mod tool_output;
mod tray;
mod undo;
mod updates;
mod usage;
mod watchdog;
mod window_recovery;
mod workflow_files;
mod wsl;
use std::io::Write;
use std::sync::Mutex;
use tauri::{ipc::Channel, Manager, State};
use tokio_util::sync::CancellationToken;
/// Serializes workspace and sync checkpoint writes, and holds what the last write left on disk.
#[derive(Default)]
struct Storage(Mutex<StorageState>);
#[derive(Default)]
struct StorageState {
    /// Whether `workspace.json` is known to be current, which spares later saves a check for a
    /// pre-migration file to back up.
    current: bool,
    /// The conversations of the last write by id, each the JSON text it was written as. A reply
    /// that changes one conversation sends that conversation alone and these fill in the rest,
    /// copied into the file as they are: neither the page nor this process encodes every
    /// conversation to save one. Held as values, the 167 MB workspace of 2026-10-20 took 820 MB,
    /// and each save copied them all and encoded the file into one 256 MiB buffer, which is what
    /// Windows refused when the app closed (docs/DIAGNOSTICS.md). Cleared whenever the file is
    /// written another way, or a write fails.
    saved: Option<std::collections::HashMap<String, Box<serde_json::value::RawValue>>>,
}

#[tauri::command]
async fn manage_plugins(
    app: tauri::AppHandle,
    call: calls::Call,
    provider: String,
    connection_id: String,
    conversation_id: Option<String>,
    location: Option<folders::ChatLocation>,
    action: plugins::Action,
) -> Result<plugins::ResultView, String> {
    call.once(plugins::manage(
        app,
        provider,
        connection_id,
        conversation_id,
        location,
        action,
    ))
    .await
}

#[tauri::command]
async fn manage_mcp(
    app: tauri::AppHandle,
    call: calls::Call,
    provider: String,
    connection_id: String,
    conversation_id: Option<String>,
    location: Option<folders::ChatLocation>,
    action: mcp::Action,
) -> Result<mcp::ResultView, String> {
    call.once(mcp::manage(
        app,
        provider,
        connection_id,
        conversation_id,
        location,
        action,
    ))
    .await
}

#[tauri::command]
async fn read_native_instructions(
    app: tauri::AppHandle,
    conversation_id: String,
    provider: String,
    connection_id: Option<String>,
) -> Result<native_instructions::NativeInstructions, String> {
    native_instructions::read(app, conversation_id, provider, connection_id).await
}

/// The CLI session stores of this computer and its WSL distributions: each separate account
/// profile and each environment's default CLI directory, for importing their chats.
#[tauri::command]
async fn list_import_sources(app: tauri::AppHandle) -> Result<Vec<imports::SourceView>, String> {
    imports::sources(&app).await
}
/// One source's chats, newest first, each with an opaque key to import it by.
#[tauri::command]
async fn list_importable_chats(
    app: tauri::AppHandle,
    catalog: State<'_, imports::Catalog>,
    source: String,
) -> Result<imports::SourceChats, String> {
    imports::chats(&app, &catalog, &source).await
}
/// Reads one listed chat whole into a new conversation's messages; its first reply forks the
/// chat's own session.
#[tauri::command]
async fn import_chat(
    app: tauri::AppHandle,
    catalog: State<'_, imports::Catalog>,
    key: String,
    conversation_id: String,
    connection_id: Option<String>,
) -> Result<imports::Imported, String> {
    imports::import(&app, &catalog, &key, &conversation_id, connection_id).await
}
/// A finished tool call's result, kept on this computer by the run that made it, with each
/// stream whole. `full`, which windows of earlier releases send, changes nothing.
#[tauri::command]
async fn read_tool_output(
    app: tauri::AppHandle,
    pending: State<'_, std::sync::Arc<tool_output::Pending>>,
    run_id: String,
    tool_id: String,
    full: Option<bool>,
) -> Result<tool_output::View, String> {
    let _ = full;
    let root = tool_output::root(&app)?;
    tool_output::read(root, pending.inner().clone(), run_id, tool_id).await
}
/// One 3D model a finished tool call kept, whole and however large, for a viewer on another
/// device: as base64.
#[tauri::command]
async fn read_tool_output_model(
    app: tauri::AppHandle,
    pending: State<'_, std::sync::Arc<tool_output::Pending>>,
    run_id: String,
    tool_id: String,
    index: usize,
) -> Result<tool_output::ModelData, String> {
    let root = tool_output::root(&app)?;
    tool_output::read_model(root, pending.inner().clone(), run_id, tool_id, index).await
}
/// One 3D model a finished tool call kept, whole and however large, as raw bytes for this
/// computer's window.
#[tauri::command]
async fn read_tool_output_model_file(
    app: tauri::AppHandle,
    pending: State<'_, std::sync::Arc<tool_output::Pending>>,
    run_id: String,
    tool_id: String,
    index: usize,
) -> Result<tauri::ipc::Response, String> {
    let root = tool_output::root(&app)?;
    tool_output::read_model_file(root, pending.inner().clone(), run_id, tool_id, index)
        .await
        .map(tauri::ipc::Response::new)
}
/// The views this computer keeps of one of its models for other devices, with the model's
/// format and size for rendering them when none are kept.
#[tauri::command]
async fn read_tool_output_model_views(
    app: tauri::AppHandle,
    pending: State<'_, std::sync::Arc<tool_output::Pending>>,
    run_id: String,
    tool_id: String,
    index: usize,
) -> Result<tool_output::ModelViews, String> {
    let root = tool_output::root(&app)?;
    tool_output::read_model_views(root, pending.inner().clone(), run_id, tool_id, index).await
}
/// Keeps the views this computer's window rendered of one of its models.
#[tauri::command]
async fn store_tool_output_model_views(
    app: tauri::AppHandle,
    pending: State<'_, std::sync::Arc<tool_output::Pending>>,
    run_id: String,
    tool_id: String,
    index: usize,
    renderer: u32,
    views: Vec<String>,
) -> Result<(), String> {
    let root = tool_output::root(&app)?;
    tool_output::store_model_views(
        root,
        pending.inner().clone(),
        run_id,
        tool_id,
        index,
        renderer,
        views,
    )
    .await
}
/// Rows of a table a finished tool call kept, a page at a time, with every sheet's size.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn read_tool_output_table(
    app: tauri::AppHandle,
    pending: State<'_, std::sync::Arc<tool_output::Pending>>,
    tables: State<'_, std::sync::Arc<tool_output::files::Tables>>,
    run_id: String,
    tool_id: String,
    index: usize,
    sheet: usize,
    start: usize,
    count: usize,
) -> Result<tool_output::files::TablePage, String> {
    let root = tool_output::root(&app)?;
    tool_output::read_table(
        root,
        pending.inner().clone(),
        tables.inner().clone(),
        run_id,
        tool_id,
        index,
        sheet,
        start,
        count,
    )
    .await
}
/// The text of a document a finished tool call kept: whole, or its beginning for a card.
#[tauri::command]
async fn read_tool_output_document(
    app: tauri::AppHandle,
    pending: State<'_, std::sync::Arc<tool_output::Pending>>,
    run_id: String,
    tool_id: String,
    index: usize,
    head: Option<u64>,
) -> Result<tool_output::files::DocumentText, String> {
    let root = tool_output::root(&app)?;
    tool_output::read_document(root, pending.inner().clone(), run_id, tool_id, index, head).await
}
/// A table, document or video a finished tool call kept, whole and however large, as base64 for
/// a viewer on another device.
#[tauri::command]
async fn read_tool_output_file(
    app: tauri::AppHandle,
    pending: State<'_, std::sync::Arc<tool_output::Pending>>,
    run_id: String,
    tool_id: String,
    index: usize,
) -> Result<tool_output::FileData, String> {
    let root = tool_output::root(&app)?;
    tool_output::read_other(root, pending.inner().clone(), run_id, tool_id, index).await
}
/// One image of a finished tool call's result.
#[tauri::command]
async fn read_tool_output_image(
    app: tauri::AppHandle,
    pending: State<'_, std::sync::Arc<tool_output::Pending>>,
    run_id: String,
    tool_id: String,
    index: usize,
) -> Result<tool_output::ImageData, String> {
    let root = tool_output::root(&app)?;
    tool_output::read_image(root, pending.inner().clone(), run_id, tool_id, index).await
}
#[tauri::command]
async fn search_mentions(
    app: tauri::AppHandle,
    provider: String,
    connection_id: String,
    location: Option<folders::ChatLocation>,
    conversation_id: Option<String>,
    kind: String,
    query: String,
) -> Result<mentions::Results, String> {
    folders::validate_chat(&app, location.as_ref(), Some(&connection_id))?;
    let mut profile = profiles::resolve(&app, &provider, Some(&connection_id))?;
    profile.folder_distribution = location
        .as_ref()
        .map(|l| folders::environment_distribution(&app, &l.environment_id))
        .transpose()?
        .flatten();
    profiles::scope(
        profile,
        mentions::read(app, provider, location, conversation_id, kind, query),
    )
    .await
}

#[tauri::command]
async fn read_context(
    app: tauri::AppHandle,
    provider: String,
    model: String,
    location: Option<folders::ChatLocation>,
    connection_id: Option<String>,
    conversation_id: Option<String>,
    forked: Option<bool>,
) -> Result<context::ContextSnapshot, String> {
    folders::validate_chat(&app, location.as_ref(), connection_id.as_deref())?;
    let mut profile = profiles::resolve(&app, &provider, connection_id.as_deref())?;
    profile.folder_distribution = location
        .as_ref()
        .map(|location| folders::environment_distribution(&app, &location.environment_id))
        .transpose()?
        .flatten();
    profiles::scope(
        profile,
        context::read(
            app,
            provider,
            model,
            location,
            conversation_id,
            forked.unwrap_or(false),
        ),
    )
    .await
}

#[tauri::command]
async fn read_usage(
    app: tauri::AppHandle,
    state: State<'_, usage::UsageState>,
    provider: String,
    model: String,
    force: bool,
    connection_id: Option<String>,
) -> Result<usage::UsageSnapshot, String> {
    let profile = profiles::resolve(&app, &provider, connection_id.as_deref())?;
    profiles::scope(profile, usage::read(app, &state, &provider, &model, force)).await
}

#[tauri::command]
async fn live_account_updates(
    state: State<'_, live_usage::LiveUsage>,
) -> Result<Vec<live_usage::Update>, String> {
    Ok(state.snapshots())
}

#[tauri::command]
async fn background_work(
    state: State<'_, background_work::Registry>,
) -> Result<Vec<background_work::Snapshot>, String> {
    Ok(state.snapshots())
}

#[tauri::command]
async fn manage_account(
    app: tauri::AppHandle,
    call: calls::Call,
    connection_id: String,
    input: live_usage::Action,
) -> Result<serde_json::Value, String> {
    call.once(async move {
        let profile = profiles::resolve(&app, "codex", Some(&connection_id))?;
        profiles::scope(profile, live_usage::manage(&app, input)).await
    })
    .await
}

#[tauri::command]
async fn generate_title(
    app: tauri::AppHandle,
    titles: State<'_, titles::Titles>,
    call: calls::Call,
    conversation_id: String,
    provider: String,
    first_message: String,
    connection_id: Option<String>,
) -> Result<titles::GeneratedTitle, String> {
    call.once(title(
        app,
        &titles,
        conversation_id,
        provider,
        first_message,
        connection_id,
    ))
    .await
}
async fn title(
    app: tauri::AppHandle,
    titles: &titles::Titles,
    conversation_id: String,
    provider: String,
    first_message: String,
    connection_id: Option<String>,
) -> Result<titles::GeneratedTitle, String> {
    let profile = profiles::resolve(&app, &provider, connection_id.as_deref())?;
    // A borrowed Codex login writes titles on Windows, where that login lives: a one-shot
    // `codex exec` in WSL could not sign in with it.
    let profile = match profile.lender {
        Some(lender) => *lender,
        None => profile,
    };
    uuid::Uuid::parse_str(&conversation_id).map_err(|_| "Invalid conversation id")?;
    let cancel = CancellationToken::new();
    {
        let mut active = titles.0.lock().map_err(|_| "Title registry lock failed")?;
        if active.contains_key(&conversation_id) {
            return Err("Title generation is already busy".into());
        }
        active.insert(conversation_id.clone(), cancel.clone());
    }
    let result = profiles::scope(
        profile,
        titles::generate(app, &provider, &first_message, cancel),
    )
    .await;
    if let Ok(mut active) = titles.0.lock() {
        active.remove(&conversation_id);
    }
    result
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn generate_folder_icon(
    app: tauri::AppHandle,
    icons: State<'_, folder_icons::FolderIcons>,
    call: calls::Call,
    conversation_id: String,
    provider: String,
    folder: String,
    first_message: String,
    connection_id: Option<String>,
) -> Result<folder_icons::ChosenIcon, String> {
    call.once(folder_icon(
        app,
        &icons,
        conversation_id,
        provider,
        folder,
        first_message,
        connection_id,
    ))
    .await
}
async fn folder_icon(
    app: tauri::AppHandle,
    icons: &folder_icons::FolderIcons,
    conversation_id: String,
    provider: String,
    folder: String,
    first_message: String,
    connection_id: Option<String>,
) -> Result<folder_icons::ChosenIcon, String> {
    let profile = profiles::resolve(&app, &provider, connection_id.as_deref())?;
    // A borrowed Codex login chooses icons on Windows, where that login lives, as it writes
    // titles.
    let profile = match profile.lender {
        Some(lender) => *lender,
        None => profile,
    };
    uuid::Uuid::parse_str(&conversation_id).map_err(|_| "Invalid conversation id")?;
    let cancel = CancellationToken::new();
    {
        let mut active = icons
            .0
            .lock()
            .map_err(|_| "Folder icon registry lock failed")?;
        if active.contains_key(&conversation_id) {
            return Err("Folder icon choice is already busy".into());
        }
        active.insert(conversation_id.clone(), cancel.clone());
    }
    let result = profiles::scope(
        profile,
        folder_icons::choose(app, &provider, &folder, &first_message, cancel),
    )
    .await;
    if let Ok(mut active) = icons.0.lock() {
        active.remove(&conversation_id);
    }
    result
}
#[tauri::command]
async fn cancel_title(
    titles: State<'_, titles::Titles>,
    conversation_id: String,
) -> Result<(), String> {
    if let Ok(active) = titles.0.lock() {
        if let Some(cancel) = active.get(&conversation_id) {
            cancel.cancel();
        }
    }
    Ok(())
}

#[tauri::command]
async fn list_models(
    app: tauri::AppHandle,
    provider: Option<String>,
    connection_id: Option<String>,
) -> Result<std::collections::BTreeMap<String, Vec<models::ModelInfo>>, String> {
    let profile = profiles::resolve(
        &app,
        provider.as_deref().unwrap_or("codex"),
        connection_id.as_deref(),
    )?;
    // Claude names its aliases from a query in the same neutral folder as usage readings.
    let runtime = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(|root| root.join("usage-runtime"));
    Ok(profiles::scope(
        profile,
        models::catalog(provider.as_deref().unwrap_or("codex"), runtime.as_deref()),
    )
    .await)
}

/// The app session this process opened: History groups the chats used until the next start of
/// the app under it. Page reloads keep it.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppSession {
    id: String,
    started_at: u64,
    /// An earlier page of this process asked already: the window reloaded, and the app did not
    /// start again.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    reloaded: bool,
}
static APP_SESSION_ASKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static APP_SESSION: std::sync::OnceLock<AppSession> = std::sync::OnceLock::new();
fn app_session_started() -> &'static AppSession {
    APP_SESSION.get_or_init(|| AppSession {
        id: uuid::Uuid::new_v4().to_string(),
        started_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as u64),
        reloaded: false,
    })
}
#[tauri::command]
async fn app_session() -> AppSession {
    AppSession {
        reloaded: APP_SESSION_ASKED.swap(true, std::sync::atomic::Ordering::SeqCst),
        ..app_session_started().clone()
    }
}
#[tauri::command]
async fn get_installation(app: tauri::AppHandle) -> Result<profiles::Installation, String> {
    let mut installation =
        tauri::async_runtime::spawn_blocking(move || profiles::installation(&app))
            .await
            .map_err(|_| "Cannot read the installation identity")??;
    installation.server = server::active();
    Ok(installation)
}
#[tauri::command]
async fn discover_wsl(app: tauri::AppHandle) -> Result<wsl::Discovery, String> {
    wsl::discover(&profiles::installation(&app)?.id).await
}
#[tauri::command]
async fn inspect_environment_clis(
    app: tauri::AppHandle,
    environment_id: String,
) -> Result<Vec<providers::CliInstallation>, String> {
    match folders::environment_distribution(&app, &environment_id)? {
        Some(distribution) => wsl::installations(&distribution).await,
        None => Ok(providers::native_installations()),
    }
}
#[tauri::command]
async fn list_folders(
    app: tauri::AppHandle,
    environment_id: String,
    path: String,
) -> Result<folders::FolderListing, String> {
    folders::list(app, environment_id, path).await
}
#[tauri::command]
async fn detect_connection(
    app: tauri::AppHandle,
    provider: String,
    connection_id: String,
) -> Result<providers::ProviderStatus, String> {
    let profile = profiles::resolve(&app, &provider, Some(&connection_id))?;
    let lender = profile.lender.clone();
    let shares = profile.shares_directory() && profile.distribution.is_none();
    let root = profile.root.clone();
    let mut status = profiles::scope(profile, providers::detect_one(&provider)).await;
    // The check linked the profile to this computer's Claude directory, as far as Windows let it.
    if shares {
        match root.as_deref().and_then(linking::last) {
            Some(linking::State::NeedsPermission) => {
                status.sharing = Some(linking::NEEDS_PERMISSION.into());
                status.sharing_permission = cfg!(windows);
            }
            Some(linking::State::Unlinked(reason)) => status.sharing = Some(reason),
            _ => {}
        }
    }
    // A borrowed Codex login is the Windows login: its state and identity are that login's,
    // while the installation stays this distribution's own.
    if let Some(lender) = lender.filter(|_| status.installed) {
        let source = profiles::scope(*lender, providers::detect_one(&provider)).await;
        status.account = source.account;
        status.detail = if source.auth == "ready" {
            "Uses this account's Windows login.".into()
        } else {
            "Uses this account's Windows login, which needs signing in. Open sign-in signs in on Windows.".into()
        };
        status.auth = source.auth;
    }
    Ok(status)
}
/// Asks Windows once to link settings.json and CLAUDE.md of every separate Claude profile on this
/// computer that shares its Claude directory and still lacks them (`linking`). An automatic
/// request asks at most once per profile in a run of the app; Allow in Connections asks again.
async fn share_files(app: &tauri::AppHandle, explicit: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        static ASKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        static ASKED: std::sync::Mutex<Vec<std::path::PathBuf>> = std::sync::Mutex::new(Vec::new());
        let _one = ASKING.lock().await;
        let source = context::native_default_root("claude")
            .ok_or("Cannot locate this computer's Claude directory")?;
        let mut pending = vec![];
        for (id, root) in profiles::directory_sharing(app)? {
            if linking::ensure(root.clone(), source.clone()).await
                != linking::State::NeedsPermission
            {
                continue;
            }
            let mut asked = ASKED.lock().unwrap_or_else(|p| p.into_inner());
            if explicit || !asked.contains(&root) {
                asked.push(root);
                pending.push(id);
            }
        }
        if pending.is_empty() {
            return Ok(());
        }
        let owner = app
            .get_webview_window("main")
            .and_then(|window| window.hwnd().ok())
            .map(|hwnd| hwnd.0 as isize)
            .unwrap_or(0);
        let shared = source.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            linking::request_permission(&shared, &pending, owner)
        })
        .await
        .map_err(|_| "Could not ask Windows for permission")?;
        // Whatever Windows allowed is each profile's state for this run from now on.
        for (_, root) in profiles::directory_sharing(app)? {
            linking::ensure(root, source.clone()).await;
        }
        result
    }
    #[cfg(not(windows))]
    {
        let _ = (app, explicit);
        Ok(())
    }
}
#[tauri::command]
async fn share_claude_files(app: tauri::AppHandle, call: calls::Call) -> Result<(), String> {
    call.once(share_files(&app, true)).await
}
// Read-only check of one environment's existing CLI login, used before a connection exists so
// the app can tell whether that login is already connected through another profile.
#[tauri::command]
async fn detect_environment_login(
    app: tauri::AppHandle,
    provider: String,
    environment_id: String,
) -> Result<providers::ProviderStatus, String> {
    let profile = profiles::environment_profile(&app, &provider, &environment_id)?;
    Ok(profiles::scope(profile, providers::detect_one(&provider)).await)
}
#[tauri::command]
async fn relay_connect(
    app: tauri::AppHandle,
    state: State<'_, relay::Relay>,
    url: String,
    token: String,
) -> Result<(), String> {
    relay::connect(
        &state,
        &app.config().identifier,
        url,
        token,
        profiles::installation(&app)?.id,
        &app.path()
            .app_local_data_dir()
            .map_err(|_| "Cannot locate app data")?,
    )
    .await
}
#[tauri::command]
async fn relay_resume(
    app: tauri::AppHandle,
    state: State<'_, relay::Relay>,
) -> Result<Option<String>, String> {
    relay::resume(
        &state,
        &app.config().identifier,
        profiles::installation(&app)?.id,
        &app.path()
            .app_local_data_dir()
            .map_err(|_| "Cannot locate app data")?,
    )
    .await
}
#[tauri::command]
async fn relay_disconnect(
    app: tauri::AppHandle,
    state: State<'_, relay::Relay>,
) -> Result<(), String> {
    relay::disconnect(
        &state,
        &app.config().identifier,
        &profiles::installation(&app)?.id,
    )
    .await
}
/// A relay request from the window: `method`, `path` and an optional `body`. One that carries
/// conversations sends those arguments as bytes (sent.rs), and its body goes on as it is.
#[tauri::command]
async fn relay_request(
    state: State<'_, relay::Relay>,
    request: tauri::ipc::Request<'_>,
) -> Result<serde_json::Value, String> {
    let sent = sent::Sent::of(request.body());
    let sent = tauri::async_runtime::spawn_blocking(move || relay::Sent::read(sent))
        .await
        .map_err(|_| "Invalid request")??;
    relay::request(&state, &sent.method, &sent.path, sent.body).await
}
// File commands read and write megabytes. Keep them off the UI thread: it also handles window
// input, so a blocked save made text selection and typing stall. performance-guards.test.ts
// fails when a new command runs synchronously; see docs/PERFORMANCE.md.
#[tauri::command]
async fn load_sync_state(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || read_sync_state(&app))
        .await
        .map_err(|_| "Cannot read sync checkpoint")?
}
fn read_sync_state(app: &tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?
        .join("sync-state.json");
    match std::fs::read(path) {
        Ok(bytes) => {
            let mut value: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|_| "Sync checkpoint is unreadable".to_string())?;
            // Its baseline holds images inline if it was written before the image store.
            let root = chat_images::root(app)?;
            if let Some(conversations) = value
                .get_mut("base")
                .and_then(|base| base.get_mut("conversations"))
            {
                if chat_images::store_inline(&root, conversations) {
                    write_sync_state(app, |root| sync_state::write(root, &value))?;
                }
            }
            Ok(Some(value))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read sync checkpoint".into()),
    }
}
/// Saves the sync checkpoint: `value` whole, or `value` without its conversations beside the
/// `upsert` of those that changed and the `order` of them all, which sync_state.rs completes
/// from the file.
#[tauri::command]
async fn save_sync_state(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let sent = sent::Sent::of(request.body());
    tauri::async_runtime::spawn_blocking(move || {
        write_sync_state(&app, |root| sync_state::save(root, sent))
    })
    .await
    .map_err(|_| "Cannot save sync checkpoint")?
}
/// Writes the checkpoint under the storage lock, in this app's data folder.
fn write_sync_state(
    app: &tauri::AppHandle,
    write: impl FnOnce(&std::path::Path) -> Result<(), String>,
) -> Result<(), String> {
    let storage = app.state::<Storage>();
    let _lock = storage.0.lock().map_err(|_| "Storage lock failed")?;
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?;
    write(&root)
}

#[tauri::command]
async fn detect_providers() -> Vec<providers::ProviderStatus> {
    let (a, b, c) = tokio::join!(
        providers::detect_one("codex"),
        providers::detect_one("claude"),
        providers::detect_one("gemini")
    );
    vec![a, b, c]
}
#[tauri::command]
async fn load_workspace(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || read_workspace(&app))
        .await
        .map_err(|_| "Cannot read the saved workspace. Check your app data permissions.")?
}
fn read_workspace(app: &tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?
        .join("workspace.json");
    match std::fs::read(&path) {
        Ok(bytes) => {
            let mut value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
                "Saved workspace is unreadable. Your existing file has been preserved.".to_string()
            })?;
            // Images saved inline before the image store move into it once; the file they came
            // from is kept beside it.
            let root = chat_images::root(app)?;
            let moved = value["version"] == 3
                && value
                    .get_mut("conversations")
                    .is_some_and(|conversations| chat_images::store_inline(&root, conversations));
            if moved {
                let backup = path.with_file_name("workspace-before-images.json");
                if !backup.exists() {
                    std::fs::write(&backup, &bytes)
                        .map_err(|_| "Cannot keep the workspace before moving its images")?;
                }
                let workspace = WorkspaceFile::of(value.clone())?;
                let storage = app.state::<Storage>();
                let mut state = storage.0.lock().map_err(|_| "Storage lock failed")?;
                write_workspace(app, &mut state, workspace)?;
            }
            Ok(Some(value))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read the saved workspace. Check your app data permissions.".into()),
    }
}
#[tauri::command]
async fn save_workspace(app: tauri::AppHandle, workspace: serde_json::Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = WorkspaceFile::of(workspace)?;
        let storage = app.state::<Storage>();
        let mut state = storage.0.lock().map_err(|_| "Storage lock failed")?;
        write_workspace(&app, &mut state, workspace)
    })
    .await
    .map_err(|_| "Cannot save the workspace")?
}
/// Told when a patch cannot be completed from the last write, so the page sends everything.
pub const NEEDS_WHOLE_WORKSPACE: &str = "The whole workspace is needed to save this change.";
/// Saves a workspace assembled from the conversations that changed and the last write. `order`
/// names every conversation the workspace holds, so additions, removals and reordering all
/// arrive; a conversation that is neither sent nor already saved fails instead of being dropped.
/// The window sends `index`, `upsert` and `order` as bytes (sent.rs): a streamed reply saves its
/// conversation every few seconds, and a long one is megabytes.
#[tauri::command]
async fn save_workspace_patch(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    #[derive(serde::Deserialize)]
    struct Patch {
        index: serde_json::Value,
        upsert: Vec<Box<serde_json::value::RawValue>>,
        order: Vec<String>,
    }
    let sent = sent::Sent::of(request.body());
    tauri::async_runtime::spawn_blocking(move || {
        let Patch {
            index,
            upsert,
            order,
        } = sent.read().map_err(|_| "Invalid workspace")?;
        for conversation in &upsert {
            readable(conversation)?;
        }
        let storage = app.state::<Storage>();
        let mut state = storage.0.lock().map_err(|_| "Storage lock failed")?;
        let workspace = patched_workspace(&mut state, index, upsert, order)?;
        write_workspace(&app, &mut state, workspace)
    })
    .await
    .map_err(|_| "Cannot save the workspace")?
}
/// A workspace to write: everything but its conversations, then those in order, each the JSON
/// text it came as, with its id when it has one.
struct WorkspaceFile {
    index: serde_json::Map<String, serde_json::Value>,
    conversations: Vec<(Option<String>, Box<serde_json::value::RawValue>)>,
}
impl WorkspaceFile {
    /// A whole workspace as the page sends it. Each conversation's values go as it becomes text.
    fn of(workspace: serde_json::Value) -> Result<Self, String> {
        let serde_json::Value::Object(mut index) = workspace else {
            return Err("Invalid workspace".into());
        };
        let Some(serde_json::Value::Array(list)) = index.remove("conversations") else {
            return Err("Invalid workspace".into());
        };
        let index = workspace_index(serde_json::Value::Object(index))?;
        let conversations = list
            .into_iter()
            .map(|conversation| {
                let id = conversation["id"].as_str().map(str::to_owned);
                serde_json::value::to_raw_value(&conversation).map(|text| (id, text))
            })
            .collect::<Result<_, _>>()
            .map_err(|_| "Cannot serialize workspace")?;
        Ok(Self {
            index,
            conversations,
        })
    }
    /// Writes the workspace as JSON, with the fields in the order the index keeps them and the
    /// conversations where theirs falls among them, as `serde_json` wrote the whole file before.
    fn write(&self, out: &mut impl Write) -> std::io::Result<()> {
        fn field(out: &mut impl Write, first: &mut bool, name: &str) -> std::io::Result<()> {
            if !std::mem::take(first) {
                out.write_all(b",")?;
            }
            serde_json::to_writer(&mut *out, name)?;
            out.write_all(b":")
        }
        fn list(
            out: &mut impl Write,
            first: &mut bool,
            file: &WorkspaceFile,
        ) -> std::io::Result<()> {
            field(out, first, "conversations")?;
            out.write_all(b"[")?;
            for (index, (_, conversation)) in file.conversations.iter().enumerate() {
                if index > 0 {
                    out.write_all(b",")?;
                }
                out.write_all(conversation.get().as_bytes())?;
            }
            out.write_all(b"]")
        }
        out.write_all(b"{")?;
        let mut first = true;
        let mut listed = false;
        for (name, value) in &self.index {
            if !listed && name.as_str() > "conversations" {
                list(out, &mut first, self)?;
                listed = true;
            }
            field(out, &mut first, name)?;
            serde_json::to_writer(&mut *out, value)?;
        }
        if !listed {
            list(out, &mut first, self)?;
        }
        out.write_all(b"}")
    }
    /// The conversations kept for the next patch to fill in from.
    fn kept(self) -> std::collections::HashMap<String, Box<serde_json::value::RawValue>> {
        self.conversations
            .into_iter()
            .filter_map(|(id, conversation)| Some((id?, conversation)))
            .collect()
    }
}
/// Everything a workspace holds but its conversations, checked as a version 3 workspace.
fn workspace_index(
    index: serde_json::Value,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let serde_json::Value::Object(mut index) = index else {
        return Err("Invalid workspace".into());
    };
    if index.get("version").and_then(serde_json::Value::as_i64) != Some(3)
        || !index
            .get("preferences")
            .is_some_and(serde_json::Value::is_object)
    {
        return Err("Invalid workspace".into());
    }
    index.remove("conversations");
    Ok(index)
}
/// Refuses JSON text a `serde_json::Value` parse would refuse, without building the value. A
/// conversation saved as the text the page sent must be one the next start of the app reads,
/// and reading text as raw JSON checks less: it lets a lone surrogate escape through.
fn readable(conversation: &serde_json::value::RawValue) -> Result<(), String> {
    struct Read;
    impl<'de> serde::Deserialize<'de> for Read {
        fn deserialize<D: serde::Deserializer<'de>>(json: D) -> Result<Self, D::Error> {
            json.deserialize_any(Read)
        }
    }
    impl<'de> serde::de::Visitor<'de> for Read {
        type Value = Read;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("JSON")
        }
        fn visit_bool<E>(self, _: bool) -> Result<Read, E> {
            Ok(Read)
        }
        fn visit_i64<E>(self, _: i64) -> Result<Read, E> {
            Ok(Read)
        }
        fn visit_u64<E>(self, _: u64) -> Result<Read, E> {
            Ok(Read)
        }
        fn visit_f64<E>(self, _: f64) -> Result<Read, E> {
            Ok(Read)
        }
        fn visit_str<E>(self, _: &str) -> Result<Read, E> {
            Ok(Read)
        }
        fn visit_unit<E>(self) -> Result<Read, E> {
            Ok(Read)
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut list: A) -> Result<Read, A::Error> {
            while list.next_element::<Read>()?.is_some() {}
            Ok(Read)
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Read, A::Error> {
            while map.next_entry::<Read, Read>()?.is_some() {}
            Ok(Read)
        }
    }
    serde_json::from_str::<Read>(conversation.get())
        .map(|_| ())
        .map_err(|_| "Invalid workspace".into())
}
/// A conversation's id, read without building the conversation.
fn conversation_id(conversation: &serde_json::value::RawValue) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Named<'a> {
        #[serde(borrow)]
        id: std::borrow::Cow<'a, str>,
    }
    serde_json::from_str::<Named>(conversation.get())
        .ok()
        .map(|named| named.id.into_owned())
}
/// The workspace a patch describes: its index, and the conversations `order` names, each the
/// one sent or else the one the last write kept, moved rather than copied.
fn patched_workspace(
    state: &mut StorageState,
    index: serde_json::Value,
    upsert: Vec<Box<serde_json::value::RawValue>>,
    order: Vec<String>,
) -> Result<WorkspaceFile, String> {
    let index = workspace_index(index)?;
    let mut sent = std::collections::HashMap::with_capacity(upsert.len());
    for conversation in upsert {
        let id = conversation_id(&conversation).ok_or("Invalid workspace")?;
        sent.insert(id, conversation);
    }
    // Checked before the last write's conversations move, which a refusal keeps.
    let kept = state.saved.as_ref();
    let mut named = std::collections::HashSet::with_capacity(order.len());
    for id in &order {
        let known = sent.contains_key(id) || kept.is_some_and(|kept| kept.contains_key(id));
        if !known || !named.insert(id.as_str()) {
            return Err(NEEDS_WHOLE_WORKSPACE.into());
        }
    }
    // A conversation sent but left out of the order would be silently discarded.
    if sent.keys().any(|id| !named.contains(id.as_str())) {
        return Err(NEEDS_WHOLE_WORKSPACE.into());
    }
    drop(named);
    let mut kept = state.saved.take().unwrap_or_default();
    let conversations = order
        .into_iter()
        .filter_map(|id| {
            let conversation = sent.remove(&id).or_else(|| kept.remove(&id))?;
            Some((Some(id), conversation))
        })
        .collect();
    Ok(WorkspaceFile {
        index,
        conversations,
    })
}
fn write_workspace(
    app: &tauri::AppHandle,
    state: &mut StorageState,
    workspace: WorkspaceFile,
) -> Result<(), String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?;
    write_workspace_file(&root, state, workspace)
}
/// Writes the workspace file in `root` straight to disk, where encoding the whole file in
/// memory first took a buffer of up to twice its size, and keeps its conversations for the next
/// patch.
fn write_workspace_file(
    root: &std::path::Path,
    state: &mut StorageState,
    workspace: WorkspaceFile,
) -> Result<(), String> {
    // Until this write ends, the conversations kept no longer describe the file.
    state.saved = None;
    std::fs::create_dir_all(root).map_err(|_| "Cannot create app data directory")?;
    let mut file =
        tempfile::NamedTempFile::new_in(root).map_err(|_| "Cannot prepare workspace save")?;
    let mut out = std::io::BufWriter::with_capacity(1 << 20, file.as_file_mut());
    workspace
        .write(&mut out)
        .and_then(|()| out.flush())
        .map_err(|_| "Cannot write workspace")?;
    drop(out);
    file.as_file()
        .sync_all()
        .map_err(|_| "Cannot flush workspace")?;
    let path = root.join("workspace.json");
    // Keep the original pre-migration workspace once, without rewriting its data. Only the
    // file found at launch can be older, since this app writes the current version.
    if !state.current && path.is_file() {
        if let Ok(old) = std::fs::read(&path) {
            #[derive(serde::Deserialize)]
            struct Versioned {
                version: Option<u64>,
            }
            if let Ok(Versioned {
                version: Some(version @ (1 | 2)),
            }) = serde_json::from_slice(&old)
            {
                let backup = root.join(format!("workspace-v{version}-backup.json"));
                if !backup.exists() {
                    std::fs::write(&backup, old)
                        .map_err(|_| "Cannot back up the previous workspace")?;
                }
            }
        }
    }
    replace_workspace(file, &path)
        .map_err(|_| "Cannot finish workspace save. The previous file was preserved.")?;
    state.current = true;
    state.saved = Some(workspace.kept());
    Ok(())
}
/// Replaces the saved workspace with a written and flushed file from the same folder. Commands
/// read the workspace without the storage lock, and a plain Windows replace fails while one has
/// it open; `std::fs::rename` then renames with POSIX semantics, and that reader keeps the
/// previous file.
fn replace_workspace(file: tempfile::NamedTempFile, path: &std::path::Path) -> std::io::Result<()> {
    let saved = file.into_temp_path().keep().map_err(|error| error.error)?;
    std::fs::rename(&saved, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&saved);
    })
}
#[tauri::command]
async fn run_agent(
    app: tauri::AppHandle,
    runs: State<'_, runner::Runs>,
    call: calls::Call,
    request: providers::RunRequest,
    on_event: Channel<protocol::RunEvent>,
    connection_id: Option<String>,
    job: Option<bool>,
) -> Result<String, String> {
    // A second copy of this call (calls.rs) holds its own handle on the window's channel, which
    // ends the channel in the window when it goes: keep each until the reply has answered.
    let channel = on_event.clone();
    let answer = call
        .once(reply(
            app,
            &runs,
            request,
            on_event,
            connection_id,
            job.unwrap_or(false),
        ))
        .await;
    drop(channel);
    answer
}
/// How a reply's events reach the window following it through `channel`.
fn follower(channel: Channel<protocol::RunEvent>) -> reply_feed::Window {
    std::sync::Arc::new(move |event| channel.send(event).map_err(|e| e.to_string()))
}
async fn reply(
    app: tauri::AppHandle,
    runs: &runner::Runs,
    request: providers::RunRequest,
    on_event: Channel<protocol::RunEvent>,
    connection_id: Option<String>,
    // Another device asked for this reply through the relay (reply_feed.rs).
    job: bool,
) -> Result<String, String> {
    // The document that asked: a reload before the reply joins those a window follows refuses it.
    let document = runs.document();
    request.validate()?;
    // A request from an app older than the image store carries its images inline: keep them
    // and send references on, as every other request does.
    let request = if request
        .messages
        .iter()
        .flat_map(|message| &message.images)
        .any(|image| image.data.is_some())
    {
        let root = chat_images::root(&app)?;
        tauri::async_runtime::spawn_blocking(move || {
            let mut request = request;
            chat_images::store_request(&root, &mut request).map(|_| request)
        })
        .await
        .map_err(|_| "Cannot keep the images of this message")??
    } else {
        request
    };
    // A request from a window or device that has not received a later rewind or file Undo
    // must not continue the replaced history. A newer request may arrive before sync does.
    if let Some(id) = &request.conversation_id {
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "Cannot locate app data")?;
        if let Ok(bytes) = std::fs::read(root.join("workspace.json")) {
            if let Some(conversation) =
                saved::conversations(&bytes).and_then(|list| list.into_iter().find(|c| c.id == *id))
            {
                if conversation.history_revision.as_u64().unwrap_or(0) > request.history_revision {
                    return Err(providers::sessions::STALE_HISTORY.into());
                }
            }
        }
    }
    folders::validate_chat(&app, request.location.as_ref(), connection_id.as_deref())?;
    let mut profile = profiles::resolve(&app, &request.agent.provider, connection_id.as_deref())?;
    profile.folder_distribution = request
        .location
        .as_ref()
        .map(|location| folders::environment_distribution(&app, &location.environment_id))
        .transpose()?
        .flatten();
    let cancel = CancellationToken::new();
    runs.begin(
        &request.run_id,
        request.conversation_id.as_deref(),
        cancel.clone(),
        request
            .take_over
            .as_ref()
            .map(|target| target.run_id.as_str()),
    )
    .await?;
    let id = request.run_id.clone();
    // What the reply reports outlives the window's document: a reload follows it again.
    let feed = runs.open_feed(
        document,
        &id,
        request.conversation_id.clone(),
        job,
        follower(on_event),
    )?;
    let _ = feed.send(protocol::RunEvent::Activity {
        text: "Starting the provider CLI".into(),
    });
    let handle = app.clone();
    let result = profiles::scope(
        profile,
        runner::run(app, request, feed.clone(), cancel, connection_id),
    )
    .await;
    if let Ok(mut active) = runs.0.lock() {
        active.remove(&id);
    }
    runs.2.finish(&feed, result.clone());
    prune_chat_images(&handle);
    result
}
/// The replies this app runs that a window may follow (reply_feed.rs): a reloaded window takes
/// up each one its document saved as running.
#[tauri::command]
async fn live_runs(runs: State<'_, runner::Runs>) -> Result<Vec<reply_feed::LiveRun>, String> {
    Ok(runs.2.live())
}
/// Follows a reply this app runs from a window that reloaded since it began: what the reply
/// reported comes again, then the rest as it comes, and the answer is the reply's end.
#[tauri::command]
async fn follow_run(
    runs: State<'_, runner::Runs>,
    call: calls::Call,
    run_id: String,
    on_event: Channel<protocol::RunEvent>,
) -> Result<String, String> {
    let feeds = runs.2.clone();
    let channel = on_event.clone();
    let answer = call
        .once(async move {
            let feed = feeds
                .get(&run_id)
                .ok_or("This response is no longer running.")?;
            let window = follower(on_event);
            let end = feed.follow(window.clone()).await;
            feeds.release(&feed, &window);
            end
        })
        .await;
    drop(channel);
    answer
}
/// Removes stored chat images no saved chat names any more, off the UI thread.
fn prune_chat_images(app: &tauri::AppHandle) {
    if let Ok(root) = chat_images::root(app) {
        tauri::async_runtime::spawn_blocking(move || chat_images::prune(&root));
    }
}
/// Keeps an attached image, sent as the request body, in the image store.
#[tauri::command]
async fn store_chat_image(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<chat_images::Stored, String> {
    let bytes = chat_images::sent_bytes(request.body())?;
    let root = chat_images::root(&app)?;
    tauri::async_runtime::spawn_blocking(move || chat_images::store(&root, &bytes))
        .await
        .map_err(|_| "Cannot keep the image")?
}
/// A kept image's bytes, from this computer or the relay, for a window that attaches a sent
/// message's images again, as a rewind returning the message to the composer does.
#[tauri::command]
async fn read_chat_image(
    app: tauri::AppHandle,
    hash: String,
) -> Result<tauri::ipc::Response, String> {
    chat_images::ensure(&app, &hash)
        .await
        .map(tauri::ipc::Response::new)
}
/// Uploads the images of `hashes` the relay lacks from this computer, returning those it still
/// lacks because this computer does not hold them either.
#[tauri::command]
async fn upload_chat_images(
    app: tauri::AppHandle,
    hashes: Vec<String>,
) -> Result<Vec<String>, String> {
    chat_images::upload(&app, hashes).await
}
#[tauri::command]
async fn cancel_run(
    runs: State<'_, runner::Runs>,
    run_id: String,
    wait_for_completion: Option<bool>,
) -> Result<(), String> {
    {
        let active = runs.0.lock().map_err(|_| "Run registry lock failed")?;
        if let Some(run) = active.get(&run_id) {
            run.cancel.cancel();
        }
    }
    if wait_for_completion.unwrap_or(false) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while runs
            .0
            .lock()
            .map_err(|_| "Run registry lock failed")?
            .contains_key(&run_id)
        {
            if std::time::Instant::now() >= deadline {
                return Err("The response has not stopped yet. Try deleting again.".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
    Ok(())
}
#[tauri::command]
async fn release_conversation(
    pool: State<'_, pool::Pool>,
    conversation_id: String,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&conversation_id).map_err(|_| "Invalid conversation id")?;
    pool.release(&conversation_id).await;
    Ok(())
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn undo_files(
    app: tauri::AppHandle,
    runs: State<'_, runner::Runs>,
    storage: State<'_, Storage>,
    call: calls::Call,
    conversation_id: String,
    run_id: String,
    connection_id: Option<String>,
    commit: bool,
) -> Result<undo::Preview, String> {
    call.once(undo(
        app,
        &runs,
        &storage,
        conversation_id,
        run_id,
        connection_id,
        commit,
    ))
    .await
}
async fn undo(
    app: tauri::AppHandle,
    runs: &runner::Runs,
    storage: &Storage,
    conversation_id: String,
    run_id: String,
    connection_id: Option<String>,
    commit: bool,
) -> Result<undo::Preview, String> {
    let operation = uuid::Uuid::new_v4().to_string();
    runs.begin(
        &operation,
        Some(&conversation_id),
        CancellationToken::new(),
        None,
    )
    .await?;
    let result = async {
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "Cannot locate app data")?;
        let conversation = saved::conversations(
            &std::fs::read(root.join("workspace.json"))
                .map_err(|_| "Save the conversation before Undo")?,
        )
        .ok_or("Cannot read the saved conversation")?
        .into_iter()
        .find(|c| c.id == conversation_id)
        .ok_or("Conversation is unavailable")?;
        if conversation.settings["connectionId"].as_str() != connection_id.as_deref() {
            return Err("The selected account changed. Reopen Undo.".into());
        }
        let messages = conversation
            .messages
            .as_ref()
            .ok_or("Invalid conversation")?;
        if messages.iter().any(|m| m.status == "running") {
            return Err("Wait for the response to finish before Undo".into());
        }
        if !messages
            .iter()
            .any(|m| m.role == "assistant" && m.run_id == run_id)
        {
            return Err("The response is no longer in this conversation".into());
        }
        let provider = conversation.settings["provider"]
            .as_str()
            .ok_or("Invalid provider")?;
        let location: Option<folders::ChatLocation> = if conversation.location["path"]
            .as_str()
            .is_none_or(str::is_empty)
        {
            None
        } else {
            Some(
                serde_json::from_value(conversation.location.clone())
                    .map_err(|_| "Invalid conversation folder")?,
            )
        };
        folders::validate_chat(&app, location.as_ref(), connection_id.as_deref())?;
        let mut profile = profiles::resolve(&app, provider, connection_id.as_deref())?;
        profile.folder_distribution = location
            .as_ref()
            .map(|l| folders::environment_distribution(&app, &l.environment_id))
            .transpose()?
            .flatten();
        uuid::Uuid::parse_str(&conversation_id).map_err(|_| "Invalid conversation id")?;
        std::fs::create_dir_all(root.join("native-sessions"))
            .map_err(|_| "Cannot lock the conversation")?;
        let lock = std::fs::File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(
                root.join("native-sessions")
                    .join(format!("{conversation_id}.lock")),
            )
            .map_err(|_| "Cannot lock the conversation")?;
        lock.try_lock()
            .map_err(|_| "This conversation is running in another window")?;
        if commit {
            app.state::<pool::Pool>().release(&conversation_id).await;
        }
        let preview = profiles::scope(profile, async {
            let scope = providers::sessions::location_scope(provider, location.as_ref())?;
            undo::apply(&root, &conversation_id, &run_id, &scope, commit)
        })
        .await?;
        if preview.undone {
            // The session goes on, and its next reply is told the files changed under it.
            let _ = providers::sessions::note_files_undone(&root, &conversation_id);
            // Save the receipt on the executing host even if the requesting Viewer
            // disconnects before receiving its result. Retrying is idempotent.
            let mut saved = storage.0.lock().map_err(|_| "Storage lock failed")?;
            // This writes the file directly, so a later patch cannot build on the last write.
            saved.saved = None;
            let mut workspace: serde_json::Value =
                serde_json::from_slice(&std::fs::read(root.join("workspace.json")).map_err(
                    |_| "Files were undone, but their status could not be saved. Retry Undo.",
                )?)
                .map_err(|_| "Cannot read workspace")?;
            if let Some(conversation) = workspace["conversations"]
                .as_array_mut()
                .and_then(|list| list.iter_mut().find(|c| c["id"] == conversation_id))
            {
                if let Some(message) = conversation["messages"]
                    .as_array_mut()
                    .and_then(|list| list.iter_mut().find(|m| m["runId"] == run_id))
                {
                    if message["filesUndone"] != true {
                        message["filesUndone"] = true.into();
                        conversation["historyRevision"] =
                            (conversation["historyRevision"].as_u64().unwrap_or(0) + 1).into();
                    }
                }
            }
            let mut file = tempfile::NamedTempFile::new_in(&root).map_err(|_| {
                "Files were undone, but their status could not be saved. Retry Undo."
            })?;
            let mut out = std::io::BufWriter::with_capacity(1 << 20, file.as_file_mut());
            serde_json::to_writer(&mut out, &workspace)
                .map_err(std::io::Error::from)
                .and_then(|()| out.flush())
                .map_err(|_| "Cannot save Undo status")?;
            drop(out);
            file.as_file()
                .sync_all()
                .map_err(|_| "Cannot flush Undo status")?;
            replace_workspace(file, &root.join("workspace.json"))
                .map_err(|_| "Cannot save Undo status")?;
        }
        Ok(preview)
    }
    .await;
    if let Ok(mut active) = runs.0.lock() {
        active.remove(&operation);
    }
    result
}
#[tauri::command]
async fn answer_question(
    questions: State<'_, providers::questions::Questions>,
    call: calls::Call,
    run_id: String,
    connection_id: Option<String>,
    answer: providers::questions::Answer,
) -> Result<(), String> {
    call.once(questions.answer(&run_id, connection_id.as_deref(), answer))
        .await
}
#[tauri::command]
async fn manage_elicitation(
    questions: State<'_, providers::questions::Questions>,
    call: calls::Call,
    run_id: String,
    connection_id: Option<String>,
    input: providers::elicitation::Input,
) -> Result<Option<providers::elicitation::Request>, String> {
    call.once(questions.2.manage(&run_id, connection_id.as_deref(), input))
        .await
}
/// This window's answer to a workflow tool call of a reply this computer runs.
#[tauri::command]
async fn answer_workflow_call(
    questions: State<'_, providers::questions::Questions>,
    call: calls::Call,
    run_id: String,
    connection_id: Option<String>,
    id: String,
    text: String,
    error: bool,
) -> Result<(), String> {
    call.once(
        questions
            .4
            .answer(&run_id, connection_id.as_deref(), &id, text, error),
    )
    .await
}
/// Workflow tool calls still waiting for this computer's window, which a reloaded window takes.
#[tauri::command]
async fn pending_workflow_calls(
    questions: State<'_, providers::questions::Questions>,
) -> Result<Vec<providers::workflow_calls::Call>, String> {
    Ok(questions.4.pending())
}
#[tauri::command]
async fn steer_run(
    questions: State<'_, providers::questions::Questions>,
    call: calls::Call,
    run_id: String,
    connection_id: Option<String>,
    input: providers::steering::Input,
) -> Result<(), String> {
    call.once(questions.1.send(&run_id, connection_id.as_deref(), input))
        .await
}
/// Signs in to the selected profile's CLI. Claude Code and Codex sign in without a terminal:
/// their sign-in page opens in the browser, and windows follow the sign-in through
/// `sign_in::EVENT` until the CLI reports its end. Antigravity keeps its terminal and returns
/// no sign-in to follow.
#[tauri::command]
async fn sign_in(
    app: tauri::AppHandle,
    sign_ins: State<'_, sign_in::SignIns>,
    call: calls::Call,
    provider: String,
    connection_id: Option<String>,
    remote: Option<bool>,
) -> Result<Option<sign_in::View>, String> {
    let sign_ins = sign_ins.inner().clone();
    call.once(open_sign_in(app, sign_ins, provider, connection_id, remote))
        .await
}
async fn open_sign_in(
    app: tauri::AppHandle,
    sign_ins: sign_in::SignIns,
    provider: String,
    connection_id: Option<String>,
    remote: Option<bool>,
) -> Result<Option<sign_in::View>, String> {
    // Opened from another device, through the relay, which shows the page itself.
    let remote = remote.unwrap_or(false);
    let profile = profiles::resolve(&app, &provider, connection_id.as_deref())?;
    // A WSL Codex profile that borrows a Windows login signs in on Windows, where the login
    // lives. Claude profiles sign in inside their own distribution.
    let profile = match profile.lender {
        Some(lender) => *lender,
        None => profile,
    };
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?
        .join("sign-in");
    if provider == "gemini" {
        if remote {
            return Err("Antigravity signs in through a terminal on its own computer.".into());
        }
        return profiles::scope(profile, providers::terminal_sign_in(&directory))
            .await
            .map(|()| None);
    }
    if !matches!(provider.as_str(), "claude" | "codex") {
        return Err("Unknown provider".into());
    }
    let account = if profile.id.is_empty() {
        provider.clone()
    } else {
        profile.id.clone()
    };
    let (notify, open) = (sign_in::notifier(&app), sign_in::browser(&app));
    profiles::scope(profile, async move {
        std::fs::create_dir_all(&directory).map_err(|_| "Cannot prepare the sign-in directory")?;
        let exe = providers::resolve(&provider).await?;
        let start = sign_in::Start {
            exe,
            provider,
            connection_id,
            account,
            directory,
            remote,
        };
        sign_ins.start(start, notify, open).await.map(Some)
    })
    .await
}
/// The sign-ins waiting for the browser, for a window that opens or reloads.
#[tauri::command]
async fn sign_ins(sign_ins: State<'_, sign_in::SignIns>) -> Result<Vec<sign_in::View>, String> {
    Ok(sign_ins.list())
}
/// Sends the code a Claude sign-in page showed to the CLI waiting for it.
#[tauri::command]
async fn sign_in_code(
    app: tauri::AppHandle,
    sign_ins: State<'_, sign_in::SignIns>,
    call: calls::Call,
    id: String,
    code: String,
) -> Result<sign_in::View, String> {
    call.once(sign_ins.code(&id, &code, &sign_in::notifier(&app)))
        .await
}
#[tauri::command]
async fn cancel_sign_in(sign_ins: State<'_, sign_in::SignIns>, id: String) -> Result<(), String> {
    sign_ins.cancel(&id);
    Ok(())
}
/// Opens a console window on this computer, in a chat's working folder, and runs the code of
/// one block of a reply there. The chat's own connection names the computer, as for a reply.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn run_in_console(
    app: tauri::AppHandle,
    call: calls::Call,
    provider: String,
    connection_id: Option<String>,
    location: Option<folders::ChatLocation>,
    conversation_id: String,
    shell: console::Shell,
    code: String,
) -> Result<console::Opened, String> {
    call.once(async move {
        folders::validate_chat(&app, location.as_ref(), connection_id.as_deref())?;
        let mut profile = profiles::resolve(&app, &provider, connection_id.as_deref())?;
        profile.folder_distribution = location
            .as_ref()
            .map(|l| folders::environment_distribution(&app, &l.environment_id))
            .transpose()?
            .flatten();
        profiles::scope(
            profile,
            console::open(app, provider, location, conversation_id, shell, code),
        )
        .await
    })
    .await
}

/// Where an export went, and how many of its images neither this computer nor the relay held.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Export {
    path: String,
    missing_images: usize,
}
#[tauri::command]
async fn export_workspace(
    app: tauri::AppHandle,
    call: calls::Call,
    mut workspace: serde_json::Value,
) -> Result<Export, String> {
    call.once(async move {
        // An export stands on its own: its images carry their bytes. Those this computer does
        // not hold are read from the relay first.
        if let Some(conversations) = workspace.get_mut("conversations") {
            for hash in chat_images::hashes(conversations) {
                let _ = chat_images::ensure(&app, &hash).await;
            }
        }
        tauri::async_runtime::spawn_blocking(move || {
            let root = chat_images::root(&app)?;
            let missing_images = workspace
                .get_mut("conversations")
                .map_or(0, |conversations| {
                    chat_images::inline_all(&root, conversations)
                });
            Ok(Export {
                path: write_export(&app, &workspace)?,
                missing_images,
            })
        })
        .await
        .map_err(|_| "Cannot write workspace export")?
    })
    .await
}
fn write_export(app: &tauri::AppHandle, workspace: &serde_json::Value) -> Result<String, String> {
    if workspace["version"] != 3 {
        return Err("Invalid workspace".into());
    }
    let root = app
        .path()
        .download_dir()
        .map_err(|_| "Cannot locate Downloads")?;
    std::fs::create_dir_all(&root).map_err(|_| "Cannot create Downloads directory")?;
    let path = root.join(format!("agent-studio-{}.json", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(workspace).map_err(|_| "Cannot encode export")?;
    std::fs::write(&path, bytes).map_err(|_| "Cannot write workspace export")?;
    Ok(path.to_string_lossy().into_owned())
}

/// Cancellation tokens of work this app owns: replies, titles, folder icons, usage reads,
/// sign-ins and plugin evaluations.
fn owned_tokens(app: &tauri::AppHandle) -> Vec<CancellationToken> {
    let mut tokens = app
        .state::<runner::Runs>()
        .0
        .lock()
        .map(|active| {
            active
                .values()
                .map(|run| run.cancel.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    tokens.extend(background_tokens(app));
    tokens
}

/// The owned work beside replies and file Undos: titles, folder icons, usage reads, sign-ins and
/// plugin evaluations.
fn background_tokens(app: &tauri::AppHandle) -> Vec<CancellationToken> {
    let mut tokens = Vec::new();
    tokens.extend(
        app.state::<titles::Titles>()
            .0
            .lock()
            .map(|active| active.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default(),
    );
    tokens.extend(
        app.state::<folder_icons::FolderIcons>()
            .0
            .lock()
            .map(|active| active.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default(),
    );
    tokens.extend(
        app.state::<usage::UsageState>()
            .active
            .lock()
            .map(|a| a.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default(),
    );
    tokens.extend(app.state::<sign_in::SignIns>().tokens());
    tokens.extend(plugins::active_tokens());
    tokens
}

fn has_owned_work(app: &tauri::AppHandle) -> bool {
    !owned_tokens(app).is_empty()
        || app.state::<pool::Pool>().len() > 0
        || app.state::<mcp::Management>().has_work()
        || app
            .state::<std::sync::Arc<screens::Screens>>()
            .jobs
            .running()
            > 0
}

/// Cancel all owned work, release parked CLIs, and wait until owned processes have stopped,
/// including the ones still ending after their work, which may be saving a renewed login.
async fn release_owned_work(app: &tauri::AppHandle) {
    for token in owned_tokens(app) {
        token.cancel();
    }
    app.state::<mcp::Management>().sweep(app, true).await;
    let screens = app.state::<std::sync::Arc<screens::Screens>>();
    screens.calls.shutdown().await;
    // Screens' jobs keep what they printed, read as stopped.
    screens.jobs.shutdown().await;
    app.state::<pool::Pool>().shutdown().await;
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        if owned_tokens(app).is_empty() && !providers::ending() {
            break;
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
}

/// Releases owned work before this computer turns off (`shutdown.rs`) as `release_owned_work`
/// does, except replies: none runs when it begins, and one that begins meanwhile is the caller's
/// to wait for rather than stop.
async fn release_for_shutdown(app: &tauri::AppHandle) {
    for token in background_tokens(app) {
        token.cancel();
    }
    app.state::<mcp::Management>().sweep(app, true).await;
    let screens = app.state::<std::sync::Arc<screens::Screens>>();
    screens.calls.shutdown().await;
    screens.jobs.shutdown().await;
    app.state::<pool::Pool>().shutdown().await;
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        if background_tokens(app).is_empty() && !providers::ending() {
            break;
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A server's settings leave the environment before any thread or process starts.
    server::init();
    // The VPS updater asks a release whether it runs as a server before deploying it.
    if std::env::args_os().skip(1).any(|arg| arg == server::CHECK) {
        println!("{}", server::CHECKED);
        return;
    }
    let context = tauri::generate_context!();
    // The elevated helper Windows starts, with the user's permission, to link two shared Claude
    // files (`linking`): it does only that and exits, before anything else of the app starts.
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args_os()
            .skip(1)
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        // The helper the watchdog starts to save a minidump of a frozen app, which a process
        // cannot safely do for itself.
        if args.first().is_some_and(|arg| arg == watchdog::DUMP) {
            let identifier = &context.config().identifier;
            let code = match startup::data_root(identifier) {
                Ok(data) => watchdog::dump_main(&data, &args[1..]),
                Err(_) => 2,
            };
            std::process::exit(code);
        }
        if args.first().is_some_and(|arg| arg == linking::ELEVATED) {
            let identifier = &context.config().identifier;
            let code =
                match startup::verify(identifier).and_then(|()| startup::data_root(identifier)) {
                    Ok(data) => linking::elevated_main(&data, &args[1..]),
                    Err(_) => 2,
                };
            std::process::exit(code);
        }
    }
    let version = context.package_info().version.to_string();
    let check_only = std::env::args_os()
        .skip(1)
        .any(|arg| arg == "--check-startup");
    if let Err(message) = startup::verify(&context.config().identifier) {
        eprintln!("{message}");
        if !check_only {
            startup::show_error(message);
        }
        std::process::exit(1);
    }
    if check_only {
        println!("Agent Studio startup storage verified.");
        return;
    }
    app_session_started();
    let app = tauri::Builder::default()
        // First, so a second launch shows the running window and exits before anything else
        // starts on the same data.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_window(app)
        }))
        .register_uri_scheme_protocol("studio-artifact", |_context, request| {
            artifacts::response(request.uri().path())
        })
        // Chat images for windows, by hash, from this computer or the relay.
        .register_asynchronous_uri_scheme_protocol("studio-image", |context, request, responder| {
            let app = context.app_handle().clone();
            let path = request.uri().path().to_string();
            tauri::async_runtime::spawn(async move {
                responder.respond(chat_images::serve(&app, &path).await);
            });
        })
        // Videos replies show, streamed to this computer's window a part at a time as they play.
        .register_asynchronous_uri_scheme_protocol("studio-file", |context, request, responder| {
            let app = context.app_handle().clone();
            let path = request.uri().path().to_string();
            let range = request
                .headers()
                .get("range")
                .and_then(|value| value.to_str().ok())
                .map(String::from);
            tauri::async_runtime::spawn(async move {
                responder.respond(tool_output::serve_other(&app, &path, range).await);
            });
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::Updates::new(version))
        .manage(cli_updates::CliUpdates::default())
        .manage(runner::Runs::default())
        .manage(calls::Calls::default())
        .manage(pool::Pool::default())
        .manage(mcp::Management::default())
        .manage(providers::questions::Questions::default())
        .manage(titles::Titles::default())
        .manage(folder_icons::FolderIcons::default())
        .manage(Storage::default())
        .manage(drafts::DraftStorage::default())
        .manage(workflow_files::WorkflowFiles::default())
        .manage(notifications::Notifications::default())
        .manage(relay::Relay::default())
        .manage(usage::UsageState::default())
        .manage(live_usage::LiveUsage::default())
        .manage(background_work::Registry::default())
        .manage(std::sync::Arc::new(tool_output::Pending::default()))
        .manage(std::sync::Arc::new(tool_output::files::Tables::default()))
        .manage(tray::Tray::default())
        .manage(imports::Catalog::default())
        .manage(std::sync::Arc::new(screens::Screens::default()))
        .manage(sign_in::SignIns::default())
        .manage(shutdown::Shutdown::default())
        .manage(watchdog::Watchdog::default())
        .manage(window_recovery::Recovery::default())
        .setup(|app| {
            tray::setup(app.handle());
            // The taskbar overlay is set off the window thread, on the window's own handle.
            #[cfg(windows)]
            app.manage(badges::Overlay::new());
            watchdog::start(app.handle());
            // The taskbar count, WebView2's failures recorded and repaired, and F5, Ctrl+R and
            // the menu's Reload no longer reloading the window.
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window_recovery::prepare(app.handle(), &window, 0);
            }
            // When a Claude profile's two shared files need Windows' permission, ask once for
            // every account that needs it.
            {
                let handle = app.handle().clone();
                linking::on_permission_needed(Box::new(move || {
                    let handle = handle.clone();
                    Box::pin(async move {
                        let _ = share_files(&handle, false).await;
                    })
                }));
            }
            // Remove kept tool results of deleted chats and old runs once startup settles.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                let pending = handle
                    .state::<std::sync::Arc<tool_output::Pending>>()
                    .inner()
                    .clone();
                if let Ok(root) = tool_output::root(&handle) {
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        tool_output::prune(&root, &pending)
                    })
                    .await;
                }
                prune_chat_images(&handle);
            });
            // Drop parked CLI processes that exited on their own. Idle ones stay until the
            // user closes their chat.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    handle.state::<pool::Pool>().sweep().await;
                    handle
                        .state::<mcp::Management>()
                        .sweep(&handle, false)
                        .await;
                }
            });
            updates::start(app.handle());
            cli_updates::start(app.handle());
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Started
            {
                // Replies run on through a reload, and the new document follows them again.
                webview.state::<runner::Runs>().reloaded();
                // The claude.ai panes belonged to the old document's panels.
                claude_pages::page_loaded(webview.app_handle());
                for token in plugins::active_tokens() {
                    token.cancel();
                }
                let handle = webview.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    handle.state::<mcp::Management>().sweep(&handle, true).await;
                });
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Moved(_) = event {
                claude_pages::window_moved();
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle().clone();
                // Restart to update is already stopping work; its installer ends the app.
                if updates::installing(&app) {
                    api.prevent_close();
                    return;
                }
                // The app keeps running in the tray, with its replies, relay jobs and parked
                // CLIs, until Quit is chosen there.
                if tray::hides_on_close(&app) {
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }
                // An idle app installs a downloaded update as it closes, without relaunching.
                let update = updates::take_for_close(&app);
                if update.is_none() && !has_owned_work(&app) {
                    return;
                }
                // Cancel all owned work and release parked CLIs before closing the window.
                for token in owned_tokens(&app) {
                    token.cancel();
                }
                api.prevent_close();
                let window = window.clone();
                tauri::async_runtime::spawn(async move {
                    release_owned_work(&app).await;
                    if let Some(update) = update {
                        if updates::install_on_close(&app, update) {
                            app.exit(0);
                            return;
                        }
                    }
                    let _ = window.close();
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            badges::set_pending_chat_badge,
            notifications::desktop_notification_settings,
            notifications::set_desktop_notifications,
            notifications::desktop_notification,
            updates::app_update_status,
            updates::check_app_update,
            updates::install_app_update,
            cli_updates::cli_update_status,
            cli_updates::set_cli_auto_update,
            cli_updates::check_cli_updates,
            cli_updates::install_cli,
            artifacts::save_artifact,
            claude_pages::claude_page,
            claude_pages::close_claude_pages,
            site_icons::site_icon,
            app_session,
            get_installation,
            discover_wsl,
            inspect_environment_clis,
            list_folders,
            detect_connection,
            share_claude_files,
            detect_environment_login,
            relay_connect,
            relay_resume,
            relay_disconnect,
            relay_request,
            load_sync_state,
            save_sync_state,
            detect_providers,
            list_models,
            read_usage,
            live_account_updates,
            background_work,
            manage_account,
            read_context,
            search_mentions,
            manage_mcp,
            manage_plugins,
            read_native_instructions,
            list_import_sources,
            list_importable_chats,
            import_chat,
            read_tool_output,
            read_tool_output_image,
            read_tool_output_table,
            read_tool_output_document,
            read_tool_output_file,
            read_tool_output_model,
            read_tool_output_model_file,
            read_tool_output_model_views,
            store_tool_output_model_views,
            load_workspace,
            save_workspace,
            save_workspace_patch,
            store_chat_image,
            read_chat_image,
            upload_chat_images,
            drafts::load_drafts,
            drafts::save_drafts,
            run_agent,
            live_runs,
            follow_run,
            generate_title,
            cancel_title,
            generate_folder_icon,
            cancel_run,
            release_conversation,
            undo_files,
            answer_question,
            answer_workflow_call,
            pending_workflow_calls,
            workflow_files::workflow_file_read,
            workflow_files::workflow_file_write,
            workflow_files::workflow_file_remove,
            workflow_files::workflow_file_names,
            manage_elicitation,
            steer_run,
            sign_in,
            sign_ins,
            sign_in_code,
            cancel_sign_in,
            run_in_console,
            screens::manage_screen,
            export_workspace,
            tray::window_behavior,
            tray::set_close_to_tray,
            shutdown::shutdown_watch,
            shutdown::set_shutdown_watch,
            shutdown::shut_down_computer,
            watchdog::window_heartbeat,
            watchdog::record_window_stall,
            watchdog::record_ipc_fallback
        ])
        .build(context)
        .expect("error while building tauri application");
    app.run(|handle, event| {
        // The window thread stops taking tasks on purpose now; that is no freeze.
        if let tauri::RunEvent::Exit = event {
            watchdog::stop(handle);
        }
        // The window is built again after WebView2 ended under it, and closing the old one
        // left none for a moment (window_recovery.rs).
        if let tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } = &event
        {
            if window_recovery::rebuilding(handle) {
                api.prevent_exit();
            }
        }
        // The Dock icon brings back a window kept running in the menu bar.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = event
        {
            tray::show_window(handle);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = event;
    });
}

#[cfg(test)]
mod workspace_patch_tests {
    use super::{
        patched_workspace, readable, write_workspace_file, StorageState, WorkspaceFile,
        NEEDS_WHOLE_WORKSPACE,
    };
    use serde_json::{json, value::RawValue, Value};

    fn chat(id: &str, title: &str) -> Value {
        json!({"id": id, "title": title, "messages": []})
    }
    fn text(conversation: Value) -> Box<RawValue> {
        serde_json::value::to_raw_value(&conversation).unwrap()
    }
    fn index() -> Value {
        json!({"version": 3, "preferences": {}})
    }
    fn whole(chats: Vec<Value>) -> WorkspaceFile {
        WorkspaceFile::of(json!({"version": 3, "preferences": {}, "conversations": chats})).unwrap()
    }
    fn state(chats: Vec<Value>) -> StorageState {
        StorageState {
            current: true,
            saved: Some(whole(chats).kept()),
        }
    }
    /// What a workspace writes.
    fn bytes(workspace: &WorkspaceFile) -> Vec<u8> {
        let mut out = Vec::new();
        workspace.write(&mut out).unwrap();
        out
    }
    fn patch(
        state: &mut StorageState,
        index: Value,
        upsert: Vec<Value>,
        order: &[&str],
    ) -> Result<Value, String> {
        patched_workspace(
            state,
            index,
            upsert.into_iter().map(text).collect(),
            order.iter().map(|id| id.to_string()).collect(),
        )
        .map(|workspace| serde_json::from_slice(&bytes(&workspace)).unwrap())
    }

    #[test]
    fn fills_unsent_conversations_from_the_last_write() {
        let mut saved = state(vec![chat("a", "First"), chat("b", "Second")]);
        let patched = patch(&mut saved, index(), vec![chat("b", "Renamed")], &["a", "b"]).unwrap();
        let chats = patched["conversations"].as_array().unwrap();
        assert_eq!(chats.len(), 2);
        assert_eq!(chats[0]["title"], "First");
        assert_eq!(chats[1]["title"], "Renamed");
        assert_eq!(patched["preferences"], json!({}));
    }

    #[test]
    fn order_adds_removes_and_reorders_without_sending_every_conversation() {
        let mut saved = state(vec![chat("a", "First"), chat("b", "Second")]);
        let patched = patch(&mut saved, index(), vec![chat("c", "New")], &["c", "b"]).unwrap();
        let titles: Vec<&str> = patched["conversations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["title"].as_str().unwrap())
            .collect();
        assert_eq!(titles, vec!["New", "Second"]);
    }

    #[test]
    fn asks_for_the_whole_workspace_rather_than_dropping_a_conversation() {
        // Nothing was written yet, so the conversations left out cannot be filled in.
        let mut empty = StorageState::default();
        assert_eq!(
            patch(&mut empty, index(), vec![chat("a", "First")], &["a", "b"]).unwrap_err(),
            NEEDS_WHOLE_WORKSPACE
        );
        // A conversation sent but missing from the order would be discarded.
        let mut saved = state(vec![chat("a", "First")]);
        assert_eq!(
            patch(&mut saved, index(), vec![chat("b", "Second")], &["a"]).unwrap_err(),
            NEEDS_WHOLE_WORKSPACE
        );
        // One named twice would be written twice.
        assert_eq!(
            patch(&mut saved, index(), vec![], &["a", "a"]).unwrap_err(),
            NEEDS_WHOLE_WORKSPACE
        );
        // A refusal leaves the last write's conversations to the next patch.
        let patched = patch(&mut saved, index(), vec![], &["a"]).unwrap();
        assert_eq!(patched["conversations"], json!([chat("a", "First")]));
    }

    #[test]
    fn rejects_an_index_that_is_not_a_workspace() {
        let mut saved = state(vec![chat("a", "First")]);
        for index in [
            json!([]),
            json!({"preferences": {}}),
            json!({"version": 2, "preferences": {}}),
            json!({"version": 3}),
        ] {
            assert_eq!(
                patch(&mut saved, index, vec![], &["a"]).unwrap_err(),
                "Invalid workspace"
            );
        }
        assert_eq!(
            patch(&mut saved, index(), vec![json!({"title": "No id"})], &["a"]).unwrap_err(),
            "Invalid workspace"
        );
        assert!(WorkspaceFile::of(json!({"version": 3, "preferences": {}})).is_err());
        // Each refusal kept the last write.
        assert!(patch(&mut saved, index(), vec![], &["a"]).is_ok());
    }

    #[test]
    fn writes_a_whole_workspace_as_serde_json_wrote_it() {
        // Fields on either side of the conversations, which their name sorts between.
        for workspace in [
            json!({
                "accountColors": [{"accountId": "x", "color": "lime"}],
                "appSessions": [],
                "conversations": [chat("a", "First \u{e9}\" \u{1F600}"), {"title": "No id"}],
                "fleet": {"computers": [{"id": "c"}]},
                "preferences": {"theme": "dark"},
                "version": 3
            }),
            json!({"appSessions": [], "conversations": [], "preferences": {}, "version": 3}),
            json!({"conversations": [chat("a", "A")], "preferences": {}, "version": 3}),
        ] {
            let file = WorkspaceFile::of(workspace.clone()).unwrap();
            assert_eq!(bytes(&file), serde_json::to_vec(&workspace).unwrap());
            // Only conversations with an id can be filled in later.
            assert_eq!(
                file.kept().len(),
                workspace["conversations"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|c| c["id"].is_string())
                    .count()
            );
        }
    }

    #[test]
    fn keeps_each_conversation_as_the_text_it_came_as() {
        // Text a parser and a writer could change: key order, escapes, a long number.
        let odd = r#"{"title":"\u00e9\/","id":"a","n":1.0000000000000000000001,"messages":[]}"#;
        let mut saved = StorageState::default();
        let workspace = patched_workspace(
            &mut saved,
            index(),
            vec![RawValue::from_string(odd.into()).unwrap()],
            vec!["a".into()],
        )
        .unwrap();
        let folder = tempfile::tempdir().unwrap();
        write_workspace_file(folder.path(), &mut saved, workspace).unwrap();
        // A later save that sends another conversation copies this one as it was.
        let workspace = patched_workspace(
            &mut saved,
            index(),
            vec![text(chat("b", "Second"))],
            vec!["b".into(), "a".into()],
        )
        .unwrap();
        write_workspace_file(folder.path(), &mut saved, workspace).unwrap();
        let file = std::fs::read_to_string(folder.path().join("workspace.json")).unwrap();
        assert_eq!(
            file,
            format!(
                r#"{{"conversations":[{},{odd}],"preferences":{{}},"version":3}}"#,
                serde_json::to_string(&chat("b", "Second")).unwrap()
            )
        );
        assert!(saved.current && saved.saved.as_ref().unwrap().len() == 2);
    }

    #[test]
    fn a_failed_write_leaves_the_next_patch_nothing_to_fill_in() {
        let folder = tempfile::tempdir().unwrap();
        // A file where the app data folder should be.
        let root = folder.path().join("data");
        std::fs::write(&root, b"").unwrap();
        let mut saved = state(vec![chat("a", "First")]);
        let workspace = patched_workspace(&mut saved, index(), vec![], vec!["a".into()]).unwrap();
        assert!(write_workspace_file(&root, &mut saved, workspace).is_err());
        assert!(saved.saved.is_none());
        assert_eq!(
            patch(&mut saved, index(), vec![], &["a"]).unwrap_err(),
            NEEDS_WHOLE_WORKSPACE
        );
    }

    #[test]
    fn backs_up_a_workspace_of_an_earlier_version_once() {
        let folder = tempfile::tempdir().unwrap();
        let old = br#"{"version":2,"conversations":[{"id":"a"}]}"#;
        std::fs::write(folder.path().join("workspace.json"), old).unwrap();
        let mut saved = StorageState::default();
        write_workspace_file(folder.path(), &mut saved, whole(vec![chat("a", "A")])).unwrap();
        let backup = folder.path().join("workspace-v2-backup.json");
        assert_eq!(std::fs::read(&backup).unwrap(), old);
        // A current file is never backed up.
        std::fs::remove_file(&backup).unwrap();
        write_workspace_file(folder.path(), &mut StorageState::default(), whole(vec![])).unwrap();
        assert!(!backup.exists());
    }

    #[test]
    fn refuses_text_a_value_parse_refuses() {
        for (conversation, accepted) in [
            (r#"{"id":"a","text":"\ud83d\ude00 \u00e9"}"#, true),
            (r#"{"id":"a","text":"\ud83d"}"#, false),
            (r#"{"id":"a","text":"\ude00"}"#, false),
            (r#"{"id":"a","\ud800":1}"#, false),
            (r#"{"id":"a","n":1e400}"#, false),
            (r#"{"id":"a","n":[1,-2,3.5,true,null,{}]}"#, true),
        ] {
            let raw = RawValue::from_string(conversation.into()).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(conversation).is_ok(),
                accepted,
                "{conversation}"
            );
            assert_eq!(readable(&raw).is_ok(), accepted, "{conversation}");
        }
    }
}

#[cfg(test)]
mod workspace_file_tests {
    use std::io::Write;

    #[test]
    fn replaces_the_workspace_while_a_command_reads_it() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("workspace.json");
        std::fs::write(&path, b"previous").unwrap();
        let reader = std::fs::File::open(&path).unwrap();
        let mut file = tempfile::NamedTempFile::new_in(root.path()).unwrap();
        file.write_all(b"saved").unwrap();
        super::replace_workspace(file, &path).unwrap();
        drop(reader);
        assert_eq!(std::fs::read(&path).unwrap(), b"saved");
        // The written file became the workspace; no temporary file is left behind.
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }
}

#[cfg(test)]
mod app_session_tests {
    #[test]
    fn keeps_one_app_session_per_process() {
        let started = super::app_session_started();
        assert_eq!(super::app_session_started().id, started.id);
        assert!(uuid::Uuid::parse_str(&started.id).is_ok());
        assert!(started.started_at > 1_700_000_000_000);
        let value = serde_json::to_value(started).unwrap();
        assert_eq!(value["startedAt"], started.started_at);
        assert!(value.get("reloaded").is_none());
    }
    #[tokio::test]
    async fn a_later_page_of_the_same_process_reloaded() {
        let first = super::app_session().await;
        let second = super::app_session().await;
        assert_eq!(first.id, second.id);
        assert!(!first.reloaded && second.reloaded);
        assert_eq!(serde_json::to_value(second).unwrap()["reloaded"], true);
    }
}
#[cfg(test)]
mod command_future_tests {
    use super::*;
    fn size<A, B, C, D, E, G, H, F: std::future::Future>(_: fn(A, B, C, D, E, G, H) -> F) -> usize {
        std::mem::size_of::<F>()
    }
    /// Tauri moves a command's future on the window thread's stack before spawning it, several
    /// times over in a debug build: a `run_agent` future of 182 KB, which held its reply inline
    /// twice, overflowed it as a reply started (calls.rs keeps the work on the heap).
    #[test]
    fn a_reply_command_future_stays_small() {
        let run_agent = size(
            run_agent
                as fn(
                    tauri::AppHandle,
                    State<'static, runner::Runs>,
                    calls::Call,
                    providers::RunRequest,
                    Channel<protocol::RunEvent>,
                    Option<String>,
                    Option<bool>,
                ) -> _,
        );
        assert!(
            run_agent < 16 * 1024,
            "run_agent's future takes {run_agent} bytes"
        );
    }
}
