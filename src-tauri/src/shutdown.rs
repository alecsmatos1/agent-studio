//! Shut down when chats finish (requested 2026-11-03: "Create a button that watches when enabled,
//! wait for all chats to finish then turn off the PC automatically", to leave the computer working
//! through the night). The window decides when this computer's chats are done and counts down
//! (`src/lib/shutdown-watch.ts`); this module keeps the watch on through reloads of the window,
//! keeps the computer awake while it is on, and turns the computer off, never while a reply runs
//! here; a debug build only records that it would (`DRY_RUN`). Nothing of it is saved: the app
//! always starts with the watch off. See docs/BACKGROUND.md.
use serde::Serialize;
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{Mutex, MutexGuard, PoisonError},
};
use tauri::{AppHandle, Manager};

const SERVER: &str = "A server host stays on.";
const OFF: &str = "Shut down when chats finish is off.";
/// What Windows records in its event log as the reason, beside shutdown.exe and this app.
#[cfg(windows)]
const COMMENT: &str = "Agent Studio: every chat on this computer finished.";
/// A shutdown that another program started is already under way.
#[cfg(any(windows, test))]
const ERROR_SHUTDOWN_IN_PROGRESS: i32 = 1115;
#[cfg(any(windows, test))]
const WINDOWS_REFUSED: &str = "Windows did not shut down this computer.";
/// Where a debug build records the shutdown it was asked for instead of turning the computer
/// off, so development and native QA follow the whole path without doing it.
const DRY_RUN: &str = "shutdown-dry-run.txt";

/// Whether the watch is on, and what keeps the computer awake meanwhile.
#[derive(Default)]
pub struct Shutdown(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    armed: bool,
    awake: Option<Awake>,
}

impl Shutdown {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    armed: bool,
    /// The chats whose replies, or file Undos, this computer runs now.
    running: Vec<String>,
}

/// What a request to turn the computer off did.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// The computer is turning off.
    ShuttingDown,
    /// A reply began here meanwhile, so the watch waits for it.
    Running,
}

/// The chats of the runs in this computer's registry, each once. A run without a chat counts by
/// its own id.
fn chats(runs: &HashMap<String, crate::runner::Run>) -> Vec<String> {
    let mut chats: Vec<String> = runs
        .iter()
        .map(|(id, run)| run.conversation.clone().unwrap_or_else(|| id.clone()))
        .collect();
    chats.sort();
    chats.dedup();
    chats
}

fn running(app: &AppHandle) -> Vec<String> {
    let runs = app.state::<crate::runner::Runs>();
    let active = runs.0.lock().unwrap_or_else(PoisonError::into_inner);
    chats(&active)
}

fn armed(app: &AppHandle) -> bool {
    app.state::<Shutdown>().lock().armed
}

fn status(app: &AppHandle) -> Status {
    Status {
        armed: armed(app),
        running: running(app),
    }
}

/// Turns the watch on or off, holding the computer awake while it is on.
fn set_armed(app: &AppHandle, armed: bool) {
    let shutdown = app.state::<Shutdown>();
    let mut inner = shutdown.lock();
    inner.armed = armed;
    let released = if armed {
        if inner.awake.is_none() {
            inner.awake = stay_awake();
        }
        None
    } else {
        inner.awake.take()
    };
    drop(inner);
    drop(released);
}

/// Keeps the computer from sleeping while the watch is on: the chats it waits for finish only on
/// a computer that is awake, and Windows' power plans sleep without input however busy it is. The
/// display may still turn off. Dropping it lets the computer sleep again, as the app's end does.
#[cfg(windows)]
struct Awake {
    // The thread holding the request ends with it once this sender goes.
    _release: std::sync::mpsc::Sender<()>,
}

#[cfg(windows)]
fn stay_awake() -> Option<Awake> {
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };
    let (release, released) = std::sync::mpsc::channel::<()>();
    std::thread::Builder::new()
        .name("stay-awake".into())
        .spawn(move || {
            // SAFETY: changes only this thread's own power request, which ends with the thread.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
            // Returns once the sender is dropped.
            let _ = released.recv();
            // SAFETY: as above.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        })
        .ok()?;
    Some(Awake { _release: release })
}

/// macOS's `caffeinate` and Linux's `systemd-inhibit`, each ending by itself with this app.
#[cfg(unix)]
struct Awake(std::process::Child);

#[cfg(unix)]
impl Drop for Awake {
    fn drop(&mut self) {
        // systemd-inhibit leads a process group with the command it holds the lock for.
        #[cfg(not(target_os = "macos"))]
        {
            if let Ok(group) = i32::try_from(self.0.id()) {
                // SAFETY: signals the helper's own process group.
                unsafe {
                    libc::kill(-group, libc::SIGTERM);
                }
            }
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(target_os = "macos")]
fn stay_awake() -> Option<Awake> {
    std::process::Command::new("/usr/bin/caffeinate")
        .args(["-i", "-w", &std::process::id().to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
        .map(Awake)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn stay_awake() -> Option<Awake> {
    use std::os::unix::process::CommandExt;
    let pid = format!("--pid={}", std::process::id());
    std::process::Command::new("systemd-inhibit")
        .args([
            "--what=sleep",
            "--who=Agent Studio",
            "--why=Shut down when chats finish",
            "--mode=block",
            "tail",
            &pid,
            "-f",
            "/dev/null",
        ])
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
        .map(Awake)
}

/// What shutdown.exe's exit code means.
#[cfg(any(windows, test))]
fn windows_outcome(code: Option<i32>) -> Result<(), String> {
    match code {
        Some(0 | ERROR_SHUTDOWN_IN_PROGRESS) => Ok(()),
        Some(code) => Err(format!(
            "Windows did not shut down this computer (error {code})."
        )),
        None => Err(WINDOWS_REFUSED.into()),
    }
}

/// Turns this computer off. Windows closes the apps that are still open without asking them to
/// save, as an unattended shutdown has to: an app waiting for an answer would otherwise keep the
/// computer on all night.
#[cfg(windows)]
async fn power_off() -> Result<(), String> {
    let program = crate::console::window::system_directory()
        .ok_or(WINDOWS_REFUSED)?
        .join("shutdown.exe");
    let status = tokio::process::Command::new(program)
        .args(["/s", "/f", "/t", "0", "/c", COMMENT])
        // CREATE_NO_WINDOW
        .creation_flags(0x0800_0000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|_| WINDOWS_REFUSED.to_string())?;
    windows_outcome(status.code())
}

/// macOS asks System Events, which needs Agent Studio's permission to control it once.
#[cfg(target_os = "macos")]
async fn power_off() -> Result<(), String> {
    let refused = "macOS did not shut down this computer. Allow Agent Studio to control System Events in Privacy & Security → Automation.";
    let status = tokio::process::Command::new("/usr/bin/osascript")
        .args(["-e", "tell application \"System Events\" to shut down"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|_| refused.to_string())?;
    status.success().then_some(()).ok_or_else(|| refused.into())
}

/// systemd powers off for the user of an active local session without asking for a password.
#[cfg(all(unix, not(target_os = "macos")))]
async fn power_off() -> Result<(), String> {
    let refused = "Linux did not shut down this computer.";
    let program = ["/usr/bin/systemctl", "/bin/systemctl"]
        .into_iter()
        .find(|path| std::path::Path::new(path).exists())
        .unwrap_or("systemctl");
    let status = tokio::process::Command::new(program)
        .args(["--no-ask-password", "poweroff"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|_| refused.to_string())?;
    status.success().then_some(()).ok_or_else(|| refused.into())
}

/// The dry run of a debug build (`DRY_RUN`): the time it was asked for, in app data.
async fn dry_run(app: &AppHandle) -> Result<(), String> {
    let refused = "Cannot record the dry run.";
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|_| refused)?
        .join(DRY_RUN);
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();
    tauri::async_runtime::spawn_blocking(move || std::fs::write(path, at))
        .await
        .map_err(|_| refused)?
        .map_err(|_| refused.into())
}

async fn shut_down(app: AppHandle) -> Result<Outcome, String> {
    if crate::server::active() {
        return Err(SERVER.into());
    }
    if !armed(&app) {
        return Err(OFF.into());
    }
    if !running(&app).is_empty() {
        return Ok(Outcome::Running);
    }
    // Parked CLIs end as a terminal ends them, so none is cut off while it saves a renewed login,
    // and screens' jobs record that they stopped.
    crate::release_for_shutdown(&app).await;
    if !running(&app).is_empty() {
        return Ok(Outcome::Running);
    }
    // Cancel was chosen while they ended.
    if !armed(&app) {
        return Err(OFF.into());
    }
    if cfg!(debug_assertions) {
        dry_run(&app).await?;
    } else {
        power_off().await?;
    }
    // A shutdown an app cancelled leaves the watch off, which the window then says.
    set_armed(&app, false);
    Ok(Outcome::ShuttingDown)
}

#[tauri::command]
pub async fn shutdown_watch(app: AppHandle) -> Status {
    status(&app)
}

#[tauri::command]
pub async fn set_shutdown_watch(
    app: AppHandle,
    call: crate::calls::Call,
    armed: bool,
) -> Result<Status, String> {
    call.once(async move {
        if armed && crate::server::active() {
            return Err(SERVER.into());
        }
        // Holding the computer awake starts a thread or a helper process.
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || set_armed(&handle, armed))
            .await
            .map_err(|_| "Cannot change Shut down when chats finish.")?;
        Ok(status(&app))
    })
    .await
}

#[tauri::command]
pub async fn shut_down_computer(
    app: AppHandle,
    call: crate::calls::Call,
) -> Result<Outcome, String> {
    call.once(shut_down(app)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    fn run(conversation: Option<&str>) -> crate::runner::Run {
        crate::runner::Run {
            conversation: conversation.map(Into::into),
            cancel: CancellationToken::new(),
        }
    }

    #[test]
    fn running_chats_count_once_and_runs_without_a_chat_by_their_id() {
        let mut runs = HashMap::new();
        assert!(chats(&runs).is_empty());
        runs.insert("run-b".to_string(), run(Some("chat-1")));
        // A reply that takes over one waiting for background work runs beside it.
        runs.insert("run-a".to_string(), run(Some("chat-1")));
        runs.insert("run-c".to_string(), run(Some("chat-2")));
        runs.insert("run-d".to_string(), run(None));
        assert_eq!(chats(&runs), ["chat-1", "chat-2", "run-d"]);
    }

    #[test]
    fn windows_exit_codes_read_as_the_shutdown_they_report() {
        assert_eq!(windows_outcome(Some(0)), Ok(()));
        // Another program's shutdown is already under way.
        assert_eq!(windows_outcome(Some(1115)), Ok(()));
        assert_eq!(
            windows_outcome(Some(5)),
            Err("Windows did not shut down this computer (error 5).".into())
        );
        assert_eq!(
            windows_outcome(None),
            Err("Windows did not shut down this computer.".into())
        );
    }

    #[test]
    fn status_and_outcome_serialize_camel_case() {
        let status = Status {
            armed: true,
            running: vec!["chat-1".into()],
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({"armed": true, "running": ["chat-1"]})
        );
        assert_eq!(
            serde_json::to_value(Outcome::ShuttingDown).unwrap(),
            "shuttingDown"
        );
        assert_eq!(serde_json::to_value(Outcome::Running).unwrap(), "running");
    }

    #[cfg(windows)]
    #[test]
    fn staying_awake_holds_a_thread_until_released() {
        let awake = stay_awake().expect("a thread holds the request");
        drop(awake);
    }
}
