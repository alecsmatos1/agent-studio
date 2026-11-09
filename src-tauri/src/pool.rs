//! Parked per-conversation CLI processes. A completed or interrupted reply, or one a usage
//! limit stopped, leaves its Claude or Codex process waiting on stdin so the conversation's
//! next reply can continue in the same process, keeping its integrations, background work,
//! and token counters.
//! A process is reused only when the launch identity still matches; anything else restarts.
//! Closing a chat is the user's decision: a parked process stays until its chat moves to
//! History or is deleted, a later reply needs a different launch, or the app quits. Nothing
//! expires or evicts one, so background work such as a Monitor runs as long as it needs.
use crate::providers::{Executable, RunRequest};
use std::{
    collections::HashMap,
    io,
    path::PathBuf,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWrite, BufReader},
    process::{Child, ChildStdin},
    sync::mpsc,
};

/// How long an in-band interrupt may take before the process tree is killed instead.
pub const INTERRUPT_GRACE: Duration = Duration::from_secs(5);

pub enum Line {
    Out(String),
    Err(String),
}

pub type OutputObserver = Arc<dyn Fn(&str) + Send + Sync>;

/// The CLI's input pipe. Tokio's `ChildStdin::shutdown` leaves the pipe open, and a one-shot
/// run (background titles, Antigravity replies) ends only when the CLI reads the end of its
/// input. Shutting this down releases the handle without waiting for the CLI to read, so Stop
/// and deadlines still apply: a write in flight keeps its own handle until it completes, and
/// later writes fail as they would on a closed pipe.
pub struct Input(Option<ChildStdin>);

impl AsyncWrite for Input {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match &mut self.0 {
            Some(stdin) => Pin::new(stdin).poll_write(cx, buf),
            None => Poll::Ready(Err(io::ErrorKind::BrokenPipe.into())),
        }
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut self.0 {
            Some(stdin) => Pin::new(stdin).poll_flush(cx),
            None => Poll::Ready(Ok(())),
        }
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.0 = None;
        Poll::Ready(Ok(()))
    }
}

pub struct Process {
    pub exe: Executable,
    pub child: Child,
    pub stdin: Input,
    pub lines: mpsc::Receiver<Line>,
    idle: Arc<AtomicBool>,
    /// Launch identity: provider, account/profile, computer, folder, executable,
    /// reasoning, and (except for Claude's in-band selection) model.
    pub fingerprint: String,
    /// Claude's acknowledged mutable settings, separate from its launch identity.
    pub claude_settings: Option<crate::providers::claude_settings::Settings>,
    pub session_id: String,
    /// False once the protocol state is unknown (an interrupt that never confirmed, a
    /// desynchronized response); such a process is killed instead of parked.
    pub healthy: bool,
    /// The turn this process just served ended at the account's usage limit, with the CLI
    /// idle and well: only that request was refused. The process parks for the reply that
    /// continues the chat after the reset, as after a finished reply. A fresh process would
    /// resume the session from its transcript, and Claude Code then attaches the project's
    /// CLAUDE.md again in full when it changed meanwhile, which can push a long chat past its
    /// compaction threshold at once.
    pub limited: bool,
    /// Codex: the loaded thread, its reported model, and the next JSON-RPC request id.
    pub thread: String,
    pub reported_model: Option<String>,
    pub next_id: u64,
    pub turns: u64,
    /// Claude's latest running cost total in this process. It continues while the process
    /// lives; a fresh process starts at zero because parked processes never exit cleanly.
    pub cost_total: f64,
    /// Claude background work this process keeps running after the replies that started it.
    pub background: Option<Arc<crate::background_work::Watch>>,
    /// Background work an earlier reply still waited for when it handed this process to the
    /// conversation's next reply, which goes on waiting for it.
    pub carried: Option<crate::providers::visualize::Carried>,
    /// The next reply that takes this process over once its current reply returns it.
    pub hand_off: Option<tokio::sync::oneshot::Sender<Result<Process, String>>>,
    /// The lock its CLI holds while it renews the profile's login, read at launch, since the
    /// process ends outside that launch's scope (`Executable::end`).
    renewal: Option<PathBuf>,
}

impl Process {
    pub fn new(
        exe: Executable,
        child: Child,
        fingerprint: String,
        session_id: String,
    ) -> Result<Self, String> {
        Self::new_observed(exe, child, fingerprint, session_id, None)
    }
    pub fn new_observed(
        exe: Executable,
        mut child: Child,
        fingerprint: String,
        session_id: String,
        observer: Option<OutputObserver>,
    ) -> Result<Self, String> {
        let stdin = child.stdin.take().ok_or("CLI stdin is unavailable")?;
        let stdout = child.stdout.take().ok_or("CLI stdout is unavailable")?;
        let stderr = child.stderr.take().ok_or("CLI stderr is unavailable")?;
        let (tx, lines) = mpsc::channel(256);
        let idle = Arc::new(AtomicBool::new(false));
        // Readers live as long as the process. While parked, output is dropped so an idle
        // CLI can never fill its pipe or accumulate unbounded memory.
        let (out_tx, out_idle) = (tx.clone(), idle.clone());
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(observer) = &observer {
                    observer(&line);
                }
                if out_idle.load(Ordering::Relaxed) {
                    continue;
                }
                if out_tx.send(Line::Out(line)).await.is_err() {
                    break;
                }
            }
        });
        let err_idle = idle.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if err_idle.load(Ordering::Relaxed) {
                    continue;
                }
                if tx.send(Line::Err(line)).await.is_err() {
                    break;
                }
            }
        });
        let renewal = exe.renewal_lock();
        Ok(Self {
            exe,
            child,
            stdin: Input(Some(stdin)),
            lines,
            idle,
            fingerprint,
            claude_settings: None,
            session_id,
            healthy: true,
            limited: false,
            thread: String::new(),
            reported_model: None,
            next_id: 1,
            turns: 0,
            cost_total: 0.0,
            background: None,
            carried: None,
            hand_off: None,
            renewal,
        })
    }
    pub fn alive(&mut self) -> bool {
        self.child.try_wait().ok().flatten().is_none()
    }
    /// Whether this parked process can serve a reply with the given launch identity and
    /// native session. The session ID is the provider-reported one recorded at bind time.
    pub fn serves(
        &mut self,
        fingerprint: &str,
        session: &crate::providers::sessions::Session,
    ) -> bool {
        self.alive()
            && self.healthy
            && self.fingerprint == fingerprint
            && session.resumed
            && !session.switched_account
            && self.session_id == session.id()
    }
    fn drain(&mut self) {
        while self.lines.try_recv().is_ok() {}
    }
    /// Stop forwarding output between replies.
    pub fn park(&mut self) {
        self.idle.store(true, Ordering::Relaxed);
        self.drain();
        // Parked output is dropped, so the next reply could not tell when handed-over work
        // reports and must not wait for it.
        self.carried = None;
    }
    /// Resume forwarding output for the next reply.
    pub fn claim(&mut self) {
        self.drain();
        self.idle.store(false, Ordering::Relaxed);
    }
    pub async fn kill(&mut self) {
        self.exe.kill(&mut self.child).await;
        // Background work belongs to the terminated process tree.
        if let Some(watch) = self.background.take() {
            watch.ended();
        }
    }
    /// Ends the CLI once nothing more is wanted from it, letting it finish what it still has
    /// under way, such as renewing its login, before its tree is killed (`Executable::end`).
    /// Stop and a process whose protocol state is unknown use `kill`.
    pub async fn finish(mut self) {
        // Output is dropped from now on, so the CLI never fills its pipe while it ends.
        self.idle.store(true, Ordering::Relaxed);
        let input = self.stdin.0.take();
        self.exe.end(self.child, input, None, self.renewal).await;
        if let Some(watch) = self.background.take() {
            watch.ended();
        }
    }
}

/// The identity a parked process must share with the reply that wants to reuse it.
pub fn fingerprint(request: &RunRequest, exe: &Executable) -> Result<String, String> {
    let scope =
        crate::providers::sessions::scope(&request.agent.provider, request.location.as_ref())?;
    Ok(serde_json::json!({
        "scope": scope,
        "provider": request.agent.provider,
        "model": if request.agent.provider == "claude" { "" } else { &request.agent.model },
        "reasoning": request.agent.reasoning,
        "autoCompactTokens": request.agent.auto_compact_tokens,
        // Claude reads Fast mode at launch; Codex takes it with each turn.
        "fastMode": if request.agent.provider == "claude" { request.agent.fast_mode } else { None },
        "fallbackModel": request.agent.fallback_model,
        "outputSchema": if request.agent.provider == "claude" && !request.compact { request.agent.output_schema.as_deref() } else { None },
        "planMode": request.agent.plan_mode,
        "claudeInstructions": request.claude_instructions,
        // An orchestrator's process has the mission tools, which no other chat's has.
        "mission": request.mission.as_ref().map(|m| &m.run_id),
        "plugins": crate::plugins::for_run(request),
        "sharedContext": request.shared_context,
        "program": exe.program,
        "prefix": crate::wsl::reusable_prefix(exe),
        "installed": installed(exe),
    })
    .to_string())
}

/// The size and modification time of the CLI file a native launch runs (npm's script, or
/// the executable itself). Updating the CLI in place changes them, so the next reply starts
/// the new version instead of reusing a process that still runs the old one, which can mean
/// a different model for the same alias. WSL's Linux file is not visible from here.
fn installed(exe: &Executable) -> Option<String> {
    if exe.wsl.is_some() {
        return None;
    }
    let file = exe.prefix.first().map_or(exe.program.clone(), Into::into);
    let metadata = std::fs::metadata(file).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH);
    Some(format!("{}:{}", metadata.len(), modified.ok()?.as_nanos()))
}

#[derive(Default)]
pub struct Pool(Mutex<HashMap<String, Process>>);

impl Pool {
    /// Remove the conversation's parked process so a reply can decide to reuse or replace it.
    pub fn take(&self, conversation: &str) -> Option<Process> {
        self.0.lock().ok()?.remove(conversation)
    }
    pub fn len(&self) -> usize {
        self.0.lock().map(|parked| parked.len()).unwrap_or(0)
    }
    /// Whether a parked process runs this provider's CLI on this host rather than in WSL.
    pub fn holds_native(&self, provider: &str) -> bool {
        self.0.lock().map_or(true, |parked| {
            parked
                .values()
                .any(|process| process.exe.provider == provider && process.exe.wsl.is_none())
        })
    }
    /// Keep the process for the conversation's next reply, replacing any previous process of
    /// the same conversation. Every conversation keeps its own, however many are parked.
    pub async fn park(&self, conversation: &str, mut process: Process) {
        process.park();
        let replaced = match self.0.lock() {
            Ok(mut parked) => parked.insert(conversation.into(), process),
            Err(_) => Some(process),
        };
        if let Some(replaced) = replaced {
            replaced.finish().await;
        }
    }
    /// Release a conversation's process when its chat is closed (moved to History or
    /// deleted) or changes under it (a rewind or a file Undo).
    pub async fn release(&self, conversation: &str) {
        if let Some(process) = self.take(conversation) {
            process.finish().await;
        }
    }
    /// Drop processes that exited on their own, recording the background work that ended
    /// with them. Idle processes stay parked however long their chat waits.
    pub async fn sweep(&self) {
        let mut exited = Vec::new();
        if let Ok(mut parked) = self.0.lock() {
            let ids: Vec<String> = parked
                .iter_mut()
                .filter_map(|(id, process)| (!process.alive()).then(|| id.clone()))
                .collect();
            for id in ids {
                exited.extend(parked.remove(&id));
            }
        }
        for process in exited.iter_mut() {
            process.kill().await;
        }
    }
    /// Ends every parked process at once, so quitting waits for the slowest rather than all.
    pub async fn shutdown(&self) {
        let mut ending = tokio::task::JoinSet::new();
        if let Ok(mut parked) = self.0.lock() {
            for (_, process) in parked.drain() {
                ending.spawn(process.finish());
            }
        }
        while ending.join_next().await.is_some() {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    fn exe() -> Executable {
        Executable {
            provider: "codex".into(),
            program: if cfg!(windows) {
                "powershell.exe".into()
            } else {
                "sh".into()
            },
            prefix: vec![],
            wsl: None,
        }
    }
    // A child that waits on stdin like an idle CLI and echoes each line back.
    fn idle_child() -> Child {
        let mut command = exe().command();
        if cfg!(windows) {
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "while ($null -ne ($line = [Console]::ReadLine())) { [Console]::WriteLine($line) }",
            ]);
        } else {
            command.args(["-c", "cat"]);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.spawn().unwrap()
    }
    fn process(id: &str) -> Process {
        Process::new(exe(), idle_child(), format!("fingerprint-{id}"), id.into()).unwrap()
    }

    #[tokio::test]
    async fn account_observer_receives_output_while_parked_without_replaying_chat_lines() {
        use tokio::io::AsyncWriteExt;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut process = Process::new_observed(
            exe(),
            idle_child(),
            "live".into(),
            "session".into(),
            Some(Arc::new(move |line| {
                tx.send(line.to_owned()).unwrap();
            })),
        )
        .unwrap();
        process.park();
        process
            .stdin
            .write_all(b"{\"method\":\"account/updated\"}\n")
            .await
            .unwrap();
        let observed = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(observed.contains("account/updated"));
        assert!(process.lines.try_recv().is_err());
        process.claim();
        process.stdin.write_all(b"active\n").await.unwrap();
        assert!(
            matches!(tokio::time::timeout(Duration::from_secs(10),process.lines.recv()).await.unwrap(),Some(Line::Out(line)) if line == "active")
        );
        process.kill().await;
    }

    #[tokio::test]
    async fn parked_output_is_dropped_and_claimed_output_is_forwarded() {
        use tokio::io::AsyncWriteExt;
        let mut process = process("echo");
        process.stdin.write_all(b"live\n").await.unwrap();
        let line = tokio::time::timeout(Duration::from_secs(10), process.lines.recv())
            .await
            .unwrap();
        assert!(matches!(line, Some(Line::Out(text)) if text == "live"));
        process.park();
        process.stdin.write_all(b"idle\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        process.claim();
        process.stdin.write_all(b"again\n").await.unwrap();
        let line = tokio::time::timeout(Duration::from_secs(10), process.lines.recv())
            .await
            .unwrap();
        assert!(matches!(line, Some(Line::Out(text)) if text == "again"));
        assert!(process.alive());
        process.kill().await;
        assert!(!process.alive());
    }

    #[tokio::test]
    async fn shutting_down_input_ends_it_so_a_one_shot_cli_exits() {
        use tokio::io::AsyncWriteExt;
        let mut process = process("one-shot");
        // Larger than the pipe buffer: the write is still in flight when the input closes.
        let prompt = "x".repeat(200_000);
        process
            .stdin
            .write_all(format!("{prompt}\n").as_bytes())
            .await
            .unwrap();
        process.stdin.shutdown().await.unwrap();
        // The child reads all of it, answers and exits at the end of its input.
        let mut output = vec![];
        while let Some(line) = tokio::time::timeout(Duration::from_secs(10), process.lines.recv())
            .await
            .expect("the child must see the end of its input")
        {
            if let Line::Out(text) = line {
                output.push(text);
            }
        }
        assert!(output == [prompt], "the whole input arrives before it ends");
        assert!(process.stdin.write_all(b"late\n").await.is_err());
        process.kill().await;
    }

    fn running(pid: u32) -> bool {
        #[cfg(windows)]
        {
            let output = std::process::Command::new("tasklist.exe")
                .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
        }
        #[cfg(unix)]
        {
            unsafe { libc::kill(pid as i32, 0) == 0 }
        }
    }

    #[tokio::test]
    async fn pool_reuses_by_conversation_and_keeps_every_parked_process() {
        let pool = Pool::default();
        assert!(!pool.holds_native("codex"));
        let first = process("a");
        let first_pid = first.child.id().unwrap();
        pool.park("a", first).await;
        // A Codex update waits while a parked process runs this host's CLI.
        assert!(pool.holds_native("codex") && !pool.holds_native("claude"));
        pool.park("a", process("a2")).await;
        assert!(
            !running(first_pid),
            "re-parking a conversation kills its previous process"
        );
        assert_eq!(pool.len(), 1);
        let current = pool.take("a").unwrap();
        assert_eq!(current.fingerprint, "fingerprint-a2");
        assert!(pool.take("a").is_none());
        pool.park("a", current).await;
        // Only the user closes a chat: parking more conversations evicts none of them.
        for id in ["b", "c", "d", "e", "f"] {
            pool.park(id, process(id)).await;
        }
        assert_eq!(pool.len(), 6);
        let mut oldest = pool.take("a").unwrap();
        assert!(oldest.alive());
        oldest.kill().await;
        let released = pool.take("b").unwrap();
        let released_pid = released.child.id().unwrap();
        pool.park("b", released).await;
        pool.release("b").await;
        assert!(!running(released_pid));
        assert!(pool.take("b").is_none());
        pool.shutdown().await;
        assert_eq!(pool.len(), 0);
        assert!(!pool.holds_native("codex"));
    }

    #[tokio::test(start_paused = true)]
    async fn sweep_keeps_idle_processes_and_drops_exited_ones() {
        let pool = Pool::default();
        pool.park("idle", process("idle")).await;
        let mut exited = process("exited");
        exited.child.kill().await.unwrap();
        pool.park("exited", exited).await;
        // A day without a reply closes nothing; the user decides when a chat is done.
        tokio::time::advance(Duration::from_secs(24 * 60 * 60)).await;
        pool.sweep().await;
        assert!(pool.take("exited").is_none());
        let mut idle = pool.take("idle").unwrap();
        assert!(idle.alive());
        idle.kill().await;
    }

    #[tokio::test]
    async fn a_parked_process_serves_only_the_session_the_provider_reported() {
        let root = tempfile::tempdir().unwrap();
        let conversation = uuid::Uuid::new_v4().to_string();
        let mut request: RunRequest = serde_json::from_value(serde_json::json!({"runId":uuid::Uuid::new_v4(),"conversationId":conversation,"agent":{"provider":"codex","model":"fixture","reasoning":"low","instructions":""},"messages":[{"role":"user","text":"First"}]})).unwrap();
        request.native_session =
            crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
        let identity = fingerprint(&request, &exe()).unwrap();
        let first = request.native_session.take().unwrap();
        let mut process = process("codex");
        process.session_id = first.id().to_string();
        // Codex names its own thread; the binding records that identity.
        let thread = uuid::Uuid::new_v4().to_string();
        first.bind(&thread, true).unwrap();
        drop(first);
        request.messages.push(
            serde_json::from_value(serde_json::json!({"role":"assistant","text":"READY"})).unwrap(),
        );
        request.messages.push(
            serde_json::from_value(serde_json::json!({"role":"user","text":"Second"})).unwrap(),
        );
        let second = crate::providers::sessions::Session::prepare(root.path(), &request)
            .unwrap()
            .unwrap();
        assert!(second.resumed);
        assert!(!second.switched_account);
        assert_eq!(second.id(), thread);
        assert_eq!(process.fingerprint, "fingerprint-codex");
        process.fingerprint = identity.clone();
        assert!(
            !process.serves(&identity, &second),
            "the pre-bind identity must not match the reported thread"
        );
        process.session_id = thread.clone();
        assert!(process.serves(&identity, &second));
        let mut changed = request.clone();
        changed.agent.model = "other".into();
        assert!(!process.serves(&fingerprint(&changed, &exe()).unwrap(), &second));
        process.healthy = false;
        assert!(!process.serves(&identity, &second));
        process.healthy = true;
        process.kill().await;
        assert!(!process.serves(&identity, &second));
    }

    #[test]
    fn fingerprint_covers_model_reasoning_and_executable() {
        let request: RunRequest = serde_json::from_value(serde_json::json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"fixture","reasoning":"high","instructions":""},"messages":[{"role":"user","text":"hi"}]})).unwrap();
        let mut other = exe();
        let base = fingerprint(&request, &exe()).unwrap();
        other.prefix = vec!["--wsl".into()];
        assert_ne!(base, fingerprint(&request, &other).unwrap());
        let mut changed = request.clone();
        changed.agent.reasoning = "low".into();
        assert_ne!(base, fingerprint(&changed, &exe()).unwrap());
        changed.agent.reasoning = "high".into();
        changed.agent.model = "other".into();
        assert_ne!(base, fingerprint(&changed, &exe()).unwrap());
        changed.agent.model = "fixture".into();
        changed.agent.instructions = "changed".into();
        assert_eq!(
            base,
            fingerprint(&changed, &exe()).unwrap(),
            "instructions travel in-band and do not restart the process"
        );
        for fast in [Some(true), Some(false)] {
            changed.agent.fast_mode = fast;
            assert_eq!(
                base,
                fingerprint(&changed, &exe()).unwrap(),
                "Codex takes Fast mode with each turn"
            );
        }
    }

    #[test]
    fn an_updated_cli_file_is_a_new_launch_identity() {
        let request: RunRequest = serde_json::from_value(serde_json::json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"claude","model":"opus","instructions":""},"messages":[{"role":"user","text":"hi"}]})).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("claude.exe");
        std::fs::write(&program, "2.1.278").unwrap();
        let native = Executable {
            provider: "claude".into(),
            program: program.clone(),
            prefix: vec![],
            wsl: None,
        };
        let base = fingerprint(&request, &native).unwrap();
        assert_eq!(base, fingerprint(&request, &native).unwrap());
        std::fs::write(&program, "2.1.281 ").unwrap();
        assert_ne!(base, fingerprint(&request, &native).unwrap());
        // npm installs run their script through Node, so the script is what an update changes.
        let script = dir.path().join("cli.js");
        std::fs::write(&script, "2.1.278").unwrap();
        let npm = Executable {
            prefix: vec![script.to_string_lossy().into_owned()],
            ..native
        };
        let base = fingerprint(&request, &npm).unwrap();
        std::fs::write(&script, "2.1.281 ").unwrap();
        assert_ne!(base, fingerprint(&request, &npm).unwrap());
    }

    #[test]
    fn claude_only_excludes_native_mutable_settings_from_launch_identity() {
        let mut request: RunRequest = serde_json::from_value(serde_json::json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"claude","model":"sonnet","reasoning":"high","instructions":""},"messages":[{"role":"user","text":"hi"}]})).unwrap();
        let base = fingerprint(&request, &exe()).unwrap();
        request.agent.model = "opus".into();
        request.agent.max_thinking_tokens = Some(4096);
        assert_eq!(base, fingerprint(&request, &exe()).unwrap());
        request.agent.reasoning = "low".into();
        assert_ne!(base, fingerprint(&request, &exe()).unwrap());
        request.agent.reasoning = "high".into();
        request.agent.plan_mode = true;
        assert_ne!(base, fingerprint(&request, &exe()).unwrap());
        request.agent.plan_mode = false;
        request.agent.auto_compact_tokens = Some(200000);
        assert_ne!(base, fingerprint(&request, &exe()).unwrap());
        request.agent.auto_compact_tokens = None;
        request.agent.output_schema = Some("{\"type\":\"object\"}".into());
        assert_ne!(base, fingerprint(&request, &exe()).unwrap());
        request.agent.output_schema = None;
        request.agent.fast_mode = Some(true);
        assert_ne!(base, fingerprint(&request, &exe()).unwrap());
    }
}
