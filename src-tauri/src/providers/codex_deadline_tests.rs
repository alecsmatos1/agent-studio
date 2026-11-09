//! Exercise the real protocol loop with a controlled child, without a model call
//! or an hour-long wall-clock wait. The child's gate is independent of Tokio time.
#![cfg(windows)]
use super::*;
use crate::{protocol::RunEvent, providers::questions::Questions};
use std::process::Stdio;

const FIXTURE: &str = r#"
$ErrorActionPreference = 'Stop'
while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $line | ConvertFrom-Json
    $id = $request.id
    switch ($request.method) {
        'initialize' { [Console]::WriteLine('{"id":' + $id + ',"result":{}}') }
        'account/usage/read' { [Console]::WriteLine('{"id":' + $id + ',"result":{"threadUsage":{"threadId":"fixture","estimatedUsageCreditsMicros":1250000,"estimatedUsageUsdMicros":250000}}}') }
        'thread/start' {
            [Console]::WriteLine('{"method":"hook/started","params":{"threadId":"fixture","run":{"id":"startup-hook","eventName":"sessionStart","status":"running","entries":[{"text":"PRIVATE_HOOK_OUTPUT"}]}}}')
            [Console]::WriteLine('{"method":"hook/completed","params":{"threadId":"foreign","run":{"id":"foreign-hook","eventName":"sessionStart","status":"completed"}}}')
            [Console]::WriteLine('{"method":"hook/completed","params":{"threadId":"fixture","run":{"id":"startup-hook","eventName":"sessionStart","status":"completed"}}}')
            [Console]::WriteLine('{"id":' + $id + ',"result":{"thread":{"id":"fixture"},"model":"fixture-model"}}')
        }
        'thread/compact/start' {
            if ($request.params.threadId -ne 'fixture' -or $request.params.input) { exit 9 }
            [Console]::WriteLine('{"id":' + $id + ',"result":{}}')
            [Console]::WriteLine('{"method":"turn/started","params":{"threadId":"fixture","turn":{"id":"compact"}}}')
            if ($env:STUDIO_TEST_QUESTION -ne 'true') {
                [Console]::WriteLine('{"method":"item/completed","params":{"threadId":"fixture","turnId":"compact","item":{"type":"contextCompaction","id":"boundary"}}}')
            }
            [Console]::WriteLine('{"method":"turn/completed","params":{"threadId":"fixture","turn":{"id":"compact","status":"completed"}}}')
        }
        'turn/start' {
            $env:STUDIO_TEST_TURNS = [string]([int]$env:STUDIO_TEST_TURNS + 1)
            [Console]::WriteLine('{"id":' + $id + ',"result":{"turn":{"id":"turn' + $env:STUDIO_TEST_TURNS + '"}}}')
            $limit = Join-Path (Split-Path $PSCommandPath) 'limit'
            if (Test-Path -LiteralPath $limit) {
                # The account is at its usage limit once: Codex fails the turn, keeping its thread.
                Remove-Item -LiteralPath $limit
                $refusal = '{"message":"You''ve hit your usage limit. Try again at 3:05 PM.","codexErrorInfo":"usageLimitExceeded"}'
                [Console]::WriteLine('{"method":"error","params":{"threadId":"fixture","turnId":"turn' + $env:STUDIO_TEST_TURNS + '","willRetry":false,"error":' + $refusal + '}}')
                [Console]::WriteLine('{"method":"turn/completed","params":{"threadId":"fixture","turn":{"id":"turn' + $env:STUDIO_TEST_TURNS + '","status":"failed","error":' + $refusal + '}}}')
                continue
            }
            if (Test-Path -LiteralPath (Join-Path (Split-Path $PSCommandPath) 'tool-progress')) {
                [Console]::WriteLine('{"method":"item/started","params":{"threadId":"fixture","turnId":"turn1","item":{"type":"commandExecution","id":"cmd","status":"inProgress"}}}')
                [Console]::WriteLine('{"method":"item/commandExecution/outputDelta","params":{"threadId":"fixture","turnId":"stale","itemId":"cmd","delta":"PRIVATE_STALE"}}')
                [Console]::WriteLine('{"method":"item/commandExecution/terminalInteraction","params":{"threadId":"fixture","turnId":"turn1","itemId":"cmd","stdin":"PRIVATE_INPUT","processId":"PRIVATE_PROCESS"}}')
                [Console]::WriteLine('{"method":"command/exec/outputDelta","params":{"processId":"PRIVATE_UNOWNED","deltaBase64":"UFJJVkFURQ=="}}')
                Start-Sleep -Milliseconds 2200
                [Console]::WriteLine('{"method":"item/completed","params":{"threadId":"fixture","turnId":"turn1","item":{"type":"commandExecution","id":"cmd","status":"completed","durationMs":2200}}}')
                [Console]::WriteLine('{"method":"item/agentMessage/delta","params":{"threadId":"fixture","turnId":"turn1","itemId":"answer","delta":"Done"}}')
                [Console]::WriteLine('{"method":"turn/completed","params":{"threadId":"fixture","turn":{"id":"turn1","status":"completed"}}}')
                continue
            }
            if ($request.params.collaborationMode.mode -eq 'plan') {
                [Console]::WriteLine('{"method":"item/plan/delta","params":{"threadId":"fixture","turnId":"old","itemId":"old-plan","delta":"Stale"}}')
                [Console]::WriteLine('{"method":"item/plan/delta","params":{"threadId":"child","turnId":"turn1","itemId":"child-plan","delta":"Child"}}')
                [Console]::WriteLine('{"method":"item/plan/delta","params":{"threadId":"fixture","turnId":"turn1","itemId":"p","delta":"Draft"}}')
                [Console]::WriteLine('{"method":"item/completed","params":{"threadId":"fixture","turnId":"turn1","item":{"type":"plan","id":"p","text":"Final proposal"}}}')
                [Console]::WriteLine('{"method":"turn/completed","params":{"threadId":"fixture","turn":{"id":"turn1","status":"completed"}}}')
                continue
            }
            [Console]::WriteLine('{"method":"hook/completed","params":{"threadId":"fixture","turnId":"stale-turn","run":{"id":"stale-hook","eventName":"stop","status":"completed"}}}')
            [Console]::WriteLine('{"method":"hook/completed","params":{"threadId":"fixture","turnId":"turn' + $env:STUDIO_TEST_TURNS + '","run":{"id":"current-hook","eventName":"userPromptSubmit","status":"blocked"}}}')
            if ($env:STUDIO_TEST_QUESTION -eq 'true') {
                [Console]::WriteLine('{"id":10,"method":"item/tool/call","params":{"threadId":"fixture","tool":"studio_ask_user","arguments":{"questions":[{"id":"choice","question":"Continue?"}]}}}')
            }
            [Console]::WriteLine('{"method":"item/agentMessage/delta","params":{"threadId":"fixture","itemId":"reply' + $env:STUDIO_TEST_TURNS + '","delta":"READY' + $env:STUDIO_TEST_TURNS + '"}}')
            if ($env:STUDIO_TEST_QUESTION -ne 'true') {
                while (-not (Test-Path -LiteralPath $env:STUDIO_TEST_GATE)) { Start-Sleep -Milliseconds 10 }
                [Console]::WriteLine('{"method":"thread/tokenUsage/updated","params":{"threadId":"fixture","turnId":"turn' + $env:STUDIO_TEST_TURNS + '","tokenUsage":{"total":{"inputTokens":10,"outputTokens":2},"last":{"inputTokens":10}}}}')
                [Console]::WriteLine('{"method":"turn/completed","params":{"threadId":"fixture","turn":{"id":"turn' + $env:STUDIO_TEST_TURNS + '","status":"completed"}}}')
            }
        }
        'turn/interrupt' {
            [Console]::WriteLine('{"id":' + $id + ',"result":{}}')
            [Console]::WriteLine('{"method":"turn/completed","params":{"threadId":"fixture","turn":{"id":"turn' + $env:STUDIO_TEST_TURNS + '","status":"interrupted"}}}')
        }
        'turn/steer' {
            if ($request.params.threadId -ne 'fixture' -or $request.params.expectedTurnId -ne ('turn' + $env:STUDIO_TEST_TURNS)) { exit 9 }
            if ($request.params.input[0].text -eq 'Reject this') {
                [Console]::WriteLine('{"id":' + $id + ',"error":{"code":-32600,"message":"No active turn"}}')
            } else {
                [Console]::WriteLine('{"id":' + $id + ',"result":{"turnId":"turn' + $env:STUDIO_TEST_TURNS + '"}}')
            }
        }
    }
}
"#;

#[tokio::test]
async fn tool_progress_native_loop_ticks_and_rejects_stale_and_unowned_events() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("tool-progress"), "enabled").unwrap();
    let mut process = fixture(root.path(), &root.path().join("unused"), false);
    let request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"fixture","instructions":""},"messages":[{"role":"user","text":"Progress"}]})).unwrap();
    let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |e| tx.send(e).map_err(|e| e.to_string()));
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(20),
        run(
            &mut process,
            &request,
            Some(&channel),
            CancellationToken::new(),
            &mut questions,
            None,
            false,
        ),
    )
    .await
    .unwrap();
    process.kill().await;
    assert_eq!(result.unwrap().0, "complete");
    let mut tools = vec![];
    while let Ok(event) = events.try_recv() {
        let serialized = serde_json::to_string(&event).unwrap();
        assert!(!serialized.contains("PRIVATE"));
        if let RunEvent::Tool { tool } = event {
            if tool.id.ends_with(":cmd") {
                tools.push(serde_json::to_value(tool).unwrap());
            }
        }
    }
    assert!(tools
        .iter()
        .any(|t| t["status"] == "running" && t["elapsedMs"].as_u64().unwrap_or(0) >= 1000));
    assert!(!tools.iter().any(|t| t["progress"]["kind"] == "output"));
    assert_eq!(tools.last().unwrap()["progress"]["kind"], "terminal");
    assert_eq!(tools.last().unwrap()["elapsedMs"], 2200);
    assert_eq!(tools.last().unwrap()["status"], "complete");
}

#[tokio::test]
async fn proposed_plan_only_reply_completes_and_ignores_child_and_stale_items() {
    let root = tempfile::tempdir().unwrap();
    let mut process = fixture(root.path(), &root.path().join("unused"), false);
    let request:RunRequest=serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"","planMode":true,"instructions":""},"messages":[{"role":"user","text":"Plan"}]})).unwrap();
    let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |e| tx.send(e).map_err(|e| e.to_string()));
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        run(
            &mut process,
            &request,
            Some(&channel),
            CancellationToken::new(),
            &mut questions,
            None,
            false,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result, ("complete".into(), String::new()));
    assert!(process.healthy);
    let mut proposals = Vec::new();
    while let Ok(event) = events.try_recv() {
        if let RunEvent::ProposedPlan { proposed_plan } = event {
            proposals.push(proposed_plan);
        }
    }
    assert_eq!(proposals.len(), 2);
    assert!(proposals.iter().all(|p| p.id == "p"));
    assert_eq!(proposals[1].text, "Final proposal");
    assert!(proposals[1].complete);
    process.kill().await;
}

#[tokio::test]
async fn manual_compaction_waits_for_native_completion_not_the_empty_acknowledgement() {
    for missing in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let mut process = fixture(root.path(), &root.path().join("unused"), missing);
        let request: RunRequest = serde_json::from_value(json!({"compact":true,"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"fixture","instructions":""},"messages":[{"role":"user","text":"/compact"}]})).unwrap();
        let channel = EventSink::new(|_| Ok(()));
        let mut questions = Questions::default()
            .open(&request.run_id, None, channel.clone())
            .unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(15),
            run(
                &mut process,
                &request,
                Some(&channel),
                CancellationToken::new(),
                &mut questions,
                None,
                false,
            ),
        )
        .await
        .unwrap();
        if missing {
            assert!(result
                .unwrap_err()
                .contains("without confirming compaction"));
        } else {
            assert_eq!(
                result.unwrap(),
                ("complete".into(), "Context compacted.".into())
            );
            assert!(process.alive() && process.healthy);
        }
        process.kill().await;
    }
}

#[tokio::test]
async fn steering_ack_rejection_and_stop_use_the_same_native_turn() {
    let folder = tempfile::tempdir().unwrap();
    let mut process = fixture(folder.path(), &folder.path().join("unused"), true);
    let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |e| tx.send(e).map_err(|e| e.to_string()));
    let request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"fixture","instructions":""},"messages":[{"role":"user","text":"Wait"}]})).unwrap();
    let hub = Questions::default();
    let mut questions = hub.open(&request.run_id, None, channel.clone()).unwrap();
    let run_id = request.run_id.clone();
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let task = tokio::spawn(async move {
        let result = run(
            &mut process,
            &request,
            Some(&channel),
            cancel,
            &mut questions,
            None,
            false,
        )
        .await;
        let healthy = process.healthy;
        process.kill().await;
        (result, healthy)
    });
    while let Some(e) = events.recv().await {
        if matches!(e, RunEvent::Progress { .. }) {
            break;
        }
    }
    for text in ["Correction", "Reject this"] {
        let result = hub
            .1
            .send(
                &run_id,
                None,
                crate::providers::steering::Input {
                    id: uuid::Uuid::new_v4().to_string(),
                    text: text.into(),
                },
            )
            .await;
        assert_eq!(result.is_ok(), text == "Correction");
    }
    stop.cancel();
    let (result, healthy) = task.await.unwrap();
    assert_eq!(result.unwrap().0, "cancelled");
    assert!(healthy);
}

fn fixture(folder: &std::path::Path, gate: &std::path::Path, question: bool) -> Process {
    let script = folder.join("provider.ps1");
    std::fs::write(&script, FIXTURE).unwrap();
    let exe = crate::providers::Executable {
        provider: "codex".into(),
        program: "powershell.exe".into(),
        prefix: vec![],
        wsl: None,
    };
    let mut command = exe.command();
    command
        .args(["-NoProfile", "-NonInteractive", "-File"])
        .arg(script)
        .env("STUDIO_TEST_GATE", gate)
        .env("STUDIO_TEST_TURNS", "0")
        .env("STUDIO_TEST_QUESTION", question.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = command.spawn().unwrap();
    Process::new(exe, child, "fixture".into(), String::new()).unwrap()
}

#[tokio::test]
async fn native_run_survives_two_hours_and_still_completes_or_cancels() {
    for waiting_for_answer in [false, true] {
        let folder = tempfile::tempdir().unwrap();
        let gate = folder.path().join("finish");
        let mut process = fixture(folder.path(), &gate, waiting_for_answer);
        let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
        let channel = EventSink::new(move |event| events.send(event).map_err(|e| e.to_string()));
        let request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"fixture","instructions":""},"messages":[{"role":"user","text":"Controlled timer test"}]})).unwrap();
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let mut task = tokio::spawn(async move {
            let mut questions = Questions::default()
                .open(&request.run_id, None, channel.clone())
                .unwrap();
            let result = run(
                &mut process,
                &request,
                Some(&channel),
                cancel,
                &mut questions,
                None,
                false,
            )
            .await;
            let alive = process.alive() && process.healthy;
            process.kill().await;
            (result, alive)
        });
        let mut question_pending = false;
        tokio::time::timeout(Duration::from_secs(15), async {
            while let Some(event) = received.recv().await {
                match event {
                    RunEvent::Question { question, .. } => {
                        question_pending = question.status == "pending"
                    }
                    RunEvent::Progress { text, .. } if text == "READY1" => break,
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(question_pending, waiting_for_answer);
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(7200)).await;
        tokio::time::resume();
        tokio::select! {
            result = &mut task => panic!("The native run expired after two simulated hours: {result:?}"),
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
        if waiting_for_answer {
            stop.cancel();
        } else {
            std::fs::write(gate, "complete").unwrap();
        }
        let (result, alive) = tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .unwrap()
            .unwrap();
        let result = result.unwrap();
        assert_eq!(
            result.0,
            if waiting_for_answer {
                "cancelled"
            } else {
                "complete"
            }
        );
        assert_eq!(result.1, "READY1");
        assert!(
            alive,
            "a confirmed interrupt or completion leaves the process usable for the next reply"
        );
        if !waiting_for_answer {
            let mut usage = None;
            while let Ok(event) = received.try_recv() {
                if let RunEvent::Usage { usage: reading } = event {
                    usage = Some(reading);
                }
            }
            let usage = usage.expect("Billing estimate must survive the native protocol loop");
            assert_eq!(usage.session_credits, Some(1.25));
            assert_eq!(usage.session_cost_usd, Some(0.25));
            assert_eq!(usage.cost_usd, None);
        }
    }
}

#[tokio::test]
async fn a_parked_process_serves_the_next_reply_without_restarting_the_thread() {
    let folder = tempfile::tempdir().unwrap();
    let gate = folder.path().join("finish");
    std::fs::write(&gate, "open").unwrap();
    let mut process = fixture(folder.path(), &gate, false);
    let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| events.send(event).map_err(|e| e.to_string()));
    let request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"fixture","instructions":""},"messages":[{"role":"user","text":"First"}]})).unwrap();
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let first = run(
        &mut process,
        &request,
        Some(&channel),
        CancellationToken::new(),
        &mut questions,
        None,
        false,
    )
    .await
    .unwrap();
    assert_eq!(first, ("complete".into(), "READY1".into()));
    assert_eq!(process.thread, "fixture");
    assert_eq!(process.reported_model.as_deref(), Some("fixture-model"));
    process.turns += 1;
    process.park();
    process.claim();
    let mut second_request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"fixture","instructions":""},"messages":[{"role":"user","text":"First"},{"role":"assistant","text":"READY1"},{"role":"user","text":"Second"}]})).unwrap();
    second_request.native_session = None;
    let mut questions = Questions::default()
        .open(&second_request.run_id, None, channel.clone())
        .unwrap();
    let second = run(
        &mut process,
        &second_request,
        Some(&channel),
        CancellationToken::new(),
        &mut questions,
        None,
        true,
    )
    .await
    .unwrap();
    assert_eq!(second, ("complete".into(), "READY2".into()));
    assert!(process.alive() && process.healthy);
    let mut models = vec![];
    let mut hooks = vec![];
    while let Ok(event) = received.try_recv() {
        if let RunEvent::Tool { ref tool } = event {
            if tool.category == "hook" {
                hooks.push(tool.clone());
            }
        }
        if let RunEvent::Usage { usage } = event {
            models.push(usage.model);
        }
    }
    assert!(
        models.iter().all(|m| m.as_deref() == Some("fixture-model")),
        "the reused thread keeps reporting its model: {models:?}"
    );
    assert_eq!(hooks.len(), 4);
    assert_eq!(hooks[0].status, "running");
    assert_eq!(hooks[1].status, "complete");
    assert_eq!(hooks[2].status, "blocked");
    assert_eq!(hooks[3].status, "blocked");
    let metadata = serde_json::to_string(&hooks).unwrap();
    for excluded in ["PRIVATE_HOOK_OUTPUT", "foreign-hook", "stale-hook"] {
        assert!(!metadata.contains(excluded));
    }
    process.kill().await;
}

#[tokio::test]
async fn a_usage_limit_keeps_the_thread_for_the_reply_after_the_reset() {
    let folder = tempfile::tempdir().unwrap();
    let gate = folder.path().join("finish");
    std::fs::write(&gate, "open").unwrap();
    std::fs::write(folder.path().join("limit"), "once").unwrap();
    let mut process = fixture(folder.path(), &gate, false);
    let (events, _received) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| events.send(event).map_err(|e| e.to_string()));
    let request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"fixture","instructions":""},"messages":[{"role":"user","text":"First"}]})).unwrap();
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let refused = run(
        &mut process,
        &request,
        Some(&channel),
        CancellationToken::new(),
        &mut questions,
        None,
        false,
    )
    .await;
    assert_eq!(
        refused.unwrap_err(),
        "You've hit your usage limit. Try again at 3:05 PM."
    );
    // Codex refused that turn alone: the server waits with its thread loaded, so it parks.
    assert!(process.alive() && process.healthy && process.limited);
    process.limited = false;
    process.turns += 1;
    process.park();
    process.claim();
    let next: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"fixture","instructions":""},"messages":[{"role":"user","text":"First"},{"role":"assistant","text":""},{"role":"user","text":"Continue where you left off."}]})).unwrap();
    let mut questions = Questions::default()
        .open(&next.run_id, None, channel.clone())
        .unwrap();
    let continued = run(
        &mut process,
        &next,
        Some(&channel),
        CancellationToken::new(),
        &mut questions,
        None,
        true,
    )
    .await
    .unwrap();
    assert_eq!(continued, ("complete".into(), "READY2".into()));
    assert!(process.alive() && process.healthy && !process.limited);
    process.kill().await;
}
