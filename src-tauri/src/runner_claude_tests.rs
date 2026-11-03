//! Exercise the Claude stream-json turn loop with a controlled child: in-band interrupt,
//! a second turn on the same process, and the kill fallback when no result arrives.
#![cfg(windows)]
use super::*;
use crate::providers::questions::Questions;
use std::process::Stdio;

const FIXTURE: &str = r#"
$ErrorActionPreference = 'Stop'
$turn = 0
# Like the real CLI, results report the process's running cost total.
$total = 0d
function Cost([decimal]$amount) {
    $script:total += $amount
    return $script:total.ToString([Globalization.CultureInfo]::InvariantCulture)
}
$open = $false
$agent = $false
while ($null -ne ($line = [Console]::ReadLine())) {
    $value = $line | ConvertFrom-Json
    $settingsLog = Join-Path (Split-Path $PSCommandPath) 'settings.jsonl'
    Add-Content -LiteralPath $settingsLog -Value $line
    if ($value.type -eq 'control_request' -and $value.request.subtype -in @('set_model', 'set_max_thinking_tokens')) {
        # Unrelated, stale and child responses must not release the next prompt.
        [Console]::WriteLine('{"type":"control_response","response":{"subtype":"error","request_id":"foreign","error":"PRIVATE"}}')
        [Console]::WriteLine('{"type":"result","subtype":"success","num_turns":1,"result":"STALE"}')
        $modeFile = Join-Path (Split-Path $PSCommandPath) 'settings-mode'
        $mode = if (Test-Path -LiteralPath $modeFile) { Get-Content -LiteralPath $modeFile } else { '' }
        if ($mode -eq 'exit') { exit 1 }
        if ($mode -eq 'hang') { continue }
        $status = if ($mode -eq 'reject' -or ($mode -eq 'partial' -and $value.request.subtype -eq 'set_max_thinking_tokens')) { 'error' } else { 'success' }
        [Console]::WriteLine('{"type":"control_response","response":{"subtype":"' + $status + '","request_id":"' + $value.request_id + '","error":"PRIVATE"}}')
        continue
    }
    if ($value.type -eq 'control_request' -and $value.request.subtype -eq 'initialize') {
        [Console]::WriteLine('{"type":"control_response","response":{"subtype":"success","request_id":"' + $value.request_id + '"}}')
        continue
    }
    if ($value.type -eq 'control_request' -and $value.request.subtype -eq 'stop_task') {
        [Console]::WriteLine('{"type":"system","subtype":"task_updated","task_id":"' + $value.request.task_id + '","patch":{"status":"killed"}}')
        [Console]::WriteLine('{"type":"system","subtype":"task_notification","task_id":"' + $value.request.task_id + '","status":"stopped"}')
        [Console]::WriteLine('{"type":"control_response","response":{"subtype":"success","request_id":"' + $value.request_id + '","response":{}}}')
        continue
    }
    if ($value.type -eq 'control_request' -and $value.request.subtype -eq 'interrupt') {
        [Console]::WriteLine('{"type":"control_response","response":{"subtype":"success","request_id":"' + $value.request_id + '"}}')
        if ($open -and $env:STUDIO_TEST_SILENT_INTERRUPT -ne 'true') {
            [Console]::WriteLine('{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":1,"result":""}')
        }
        $open = $false
        continue
    }
    if ($value.type -eq 'user') {
        if ($open -and $value.uuid) {
            if ($value.message.content[0].text -ne 'Race completion') { [Console]::WriteLine($line) }
            [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"STEERED"}')
            continue
        }
        if ($value.shouldQuery -eq $false) {
            [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":0,"result":""}')
            continue
        }
        $turn += 1
        if ($value.message.content[0].text -like '/compact*') {
            [Console]::WriteLine('{"type":"system","subtype":"status","status":"compacting"}')
            if ($value.message.content[0].text -ne '/compact missing') {
                [Console]::WriteLine('{"type":"system","subtype":"compact_boundary","uuid":"boundary","compact_metadata":{"trigger":"manual","pre_tokens":90000,"post_tokens":5000}}')
            }
            [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":0,"result":""}')
            continue
        }
        $mode = $value.message.content[0].text
        if ($mode -like 'Stale*') {
            # A resumed session whose earlier CLI ended with a command still running reports it
            # stopped and ends that notice's turn before it takes the message.
            [Console]::WriteLine('{"type":"system","subtype":"task_notification","task_id":"old-shell","tool_use_id":"old-call","status":"stopped","summary":"Background shell command didn''t finish before the previous session ended"}')
            [Console]::WriteLine('{"type":"system","subtype":"init","session_id":"' + $env:STUDIO_TEST_SESSION + '","parent_tool_use_id":null}')
            if ($mode -eq 'Stale answered') {
                [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"message":{"id":"notice","model":"fixture-model","content":[{"type":"text","text":"The old build stopped."}],"usage":{"input_tokens":3,"output_tokens":1}}}')
                [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"The old build stopped.","usage":{"input_tokens":3,"output_tokens":1}}')
            } else {
                [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":0,"result":""}')
            }
        }
        [Console]::WriteLine('{"type":"system","subtype":"init","session_id":"' + $env:STUDIO_TEST_SESSION + '","parent_tool_use_id":null}')
        if ($value.uuid) {
            # Like --replay-user-messages, the CLI replays the human message it takes.
            [Console]::WriteLine('{"type":"user","uuid":"' + $value.uuid + '","parent_tool_use_id":null,"isReplay":true,"message":{"role":"user","content":[{"type":"text","text":"Replayed"}]}}')
        }
        if ($mode -eq 'Limit') {
            # The API refuses a request at the account's limit: the CLI answers with a synthetic
            # message of its own and ends the turn with an error result.
            [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"message":{"id":"msg-work","model":"fixture-model","content":[{"type":"text","text":"Reading the generator."}],"usage":{"input_tokens":40,"cache_read_input_tokens":60,"output_tokens":2}}}')
            [Console]::WriteLine('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1759254600,"rateLimitType":"five_hour"},"uuid":"limit-event","session_id":"' + $env:STUDIO_TEST_SESSION + '"}')
            [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"error":"rate_limit","is_api_error_message":true,"message":{"id":"b5b9d6d0-8fe4-4efb-a83a-4c65d0b3ef48","model":"<synthetic>","role":"assistant","usage":{"input_tokens":0,"output_tokens":0},"content":[{"type":"text","text":"You''ve hit your session limit \u00b7 resets 1:50pm (America/Sao_Paulo)"}]}}')
            [Console]::WriteLine('{"type":"result","subtype":"success","is_error":true,"num_turns":2,"result":"You''ve hit your session limit \u00b7 resets 1:50pm (America/Sao_Paulo)","usage":{"input_tokens":40,"output_tokens":2},"total_cost_usd":' + (Cost 0.001d) + '}')
            continue
        }
        if ($mode -eq 'Refused') {
            # Safety checks ask for a person under any mode; approved plan decisions change it.
            foreach ($next in @('', 'plan', 'bypassPermissions')) {
                if ($next) { [Console]::WriteLine('{"type":"system","subtype":"status","permissionMode":"' + $next + '"}') }
                [Console]::WriteLine('{"type":"control_request","request_id":"ask' + $next + '","request":{"subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"call","input":{},"decision_reason":"Dangerous rm operation","decision_reason_type":"safetyCheck"}}')
                Add-Content -LiteralPath $settingsLog -Value ([Console]::ReadLine())
            }
            [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Done","usage":{"input_tokens":1,"output_tokens":1}}')
            continue
        }
        if ($mode -eq 'Agents') {
            # A background agent works on after the turn ends.
            [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"message":{"id":"launch","content":[{"type":"tool_use","id":"agent-call","name":"Agent","input":{"description":"Researcher","prompt":"Research","run_in_background":true}}]}}')
            [Console]::WriteLine('{"type":"system","subtype":"task_started","task_id":"agent-task","tool_use_id":"agent-call","task_type":"local_agent","description":"Researcher"}')
            [Console]::WriteLine('{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"agent-call","content":"Launched"}]},"tool_use_result":{"isAsync":true,"status":"async_launched","agentId":"a1"}}')
            [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"message":{"id":"waiting","content":[{"type":"text","text":"I will write the plan once the agent reports back."}]}}')
            [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"I will write the plan once the agent reports back.","usage":{"input_tokens":10,"output_tokens":2},"total_cost_usd":' + (Cost 0.001d) + '}')
            [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":"agent-call","message":{"id":"child","content":[{"type":"tool_use","id":"child-read","name":"Read","input":{"file_path":"notes.txt"}}]}}')
            $agent = $true
            continue
        }
        if ($agent) {
            # A message while the agent works starts a turn at once; the agent reports after it.
            [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"message":{"id":"answer","content":[{"type":"text","text":"Answering ' + $mode + '"}]}}')
            [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Answering ' + $mode + '","usage":{"input_tokens":5,"output_tokens":1},"total_cost_usd":' + (Cost 0.001d) + '}')
            $agent = $false
            [Console]::WriteLine('{"type":"user","parent_tool_use_id":"agent-call","message":{"content":[{"type":"tool_result","tool_use_id":"child-read","content":"PRIVATE_NOTES"}]}}')
            [Console]::WriteLine('{"type":"system","subtype":"task_notification","task_id":"agent-task","tool_use_id":"agent-call","status":"completed","summary":"Research done"}')
            [Console]::WriteLine('{"type":"system","subtype":"init","session_id":"' + $env:STUDIO_TEST_SESSION + '","parent_tool_use_id":null}')
            [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"message":{"id":"plan","content":[{"type":"text","text":"The plan is ready."}]}}')
            [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"The plan is ready.","usage":{"input_tokens":5,"output_tokens":1},"total_cost_usd":' + (Cost 0.001d) + ',"origin":{"kind":"task-notification"}}')
            continue
        }
        if ($mode -like 'Await*') {
            # A dev server and a test run go to the background; only the tests are declared.
            foreach ($task in @('server', 'tests')) {
                [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"message":{"id":"' + $task + '","content":[{"type":"tool_use","id":"' + $task + '-call","name":"Bash","input":{"run_in_background":true}}]}}')
                [Console]::WriteLine('{"type":"system","subtype":"task_started","task_id":"' + $task + '","tool_use_id":"' + $task + '-call","task_type":"local_bash"}')
                [Console]::WriteLine('{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"' + $task + '-call","content":"Running in background"}]},"tool_use_result":{"backgroundTaskId":"' + $task + '"}}')
            }
            [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"message":{"id":"await","content":[{"type":"tool_use","id":"await-call","name":"mcp__agent_studio__await_background_tasks","input":{"task_ids":["tests"]}}]}}')
            [Console]::WriteLine('{"type":"control_request","request_id":"await-request","request":{"subtype":"mcp_message","server_name":"agent_studio","message":{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"await_background_tasks","arguments":{"task_ids":["tests"]}}}}}')
            Add-Content -LiteralPath $settingsLog -Value ([Console]::ReadLine())
            [Console]::WriteLine('{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"await-call","content":"Registered"}]}}')
            [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"message":{"id":"waiting","content":[{"type":"text","text":"Waiting for tests"}]}}')
            if ($mode -in @('Await race', 'Await replay', 'Await lost')) {
                # The tests finish after the model's last request of this turn.
                [Console]::WriteLine('{"type":"system","subtype":"task_notification","task_id":"tests","status":"completed"}')
            }
            if ($mode -eq 'Await replay') {
                [Console]::WriteLine('{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":"<task-notification>\n<task-id>tests</task-id>\n<status>completed</status>\n</task-notification>"}}')
            }
            [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"Waiting for tests","usage":{"input_tokens":10,"output_tokens":2},"total_cost_usd":' + (Cost 0.001d) + '}')
            if ($mode -eq 'Await') {
                Start-Sleep -Milliseconds 500
                [Console]::WriteLine('{"type":"system","subtype":"task_updated","task_id":"tests","patch":{"status":"completed"}}')
                [Console]::WriteLine('{"type":"system","subtype":"task_notification","task_id":"tests","status":"completed"}')
            }
            if ($mode -in @('Await', 'Await race')) {
                # The CLI re-invokes the model with the finished task.
                [Console]::WriteLine('{"type":"system","subtype":"init","session_id":"' + $env:STUDIO_TEST_SESSION + '","parent_tool_use_id":null}')
                [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"message":{"id":"report","content":[{"type":"text","text":"Tests passed"}]}}')
                [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Tests passed","usage":{"input_tokens":20,"output_tokens":3},"total_cost_usd":' + (Cost 0.002d) + ',"origin":{"kind":"task-notification"}}')
            }
            continue
        }
        if (Test-Path -LiteralPath (Join-Path (Split-Path $PSCommandPath) 'tool-progress')) {
            [Console]::WriteLine('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"cmd","name":"Bash","input":{}}]}}')
            [Console]::WriteLine('{"type":"tool_progress","tool_use_id":"cmd","parent_tool_use_id":null,"tool_name":"Bash","elapsed_time_seconds":12.5,"message":"PRIVATE_OUTPUT"}')
            Start-Sleep -Milliseconds 2200
            [Console]::WriteLine('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"cmd","content":"PRIVATE_OUTPUT"}]}}')
            [Console]::WriteLine('{"type":"tool_progress","tool_use_id":"cmd","parent_tool_use_id":null,"elapsed_time_seconds":90}')
            [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Done"}')
            continue
        }
        [Console]::WriteLine('{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg' + $turn + '"}}}')
        [Console]::WriteLine('{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}')
        [Console]::WriteLine('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Compare paths."}}}')
        [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"message":{"id":"msg' + $turn + '","model":"fixture-model","content":[{"type":"thinking","thinking":"Compare paths."},{"type":"text","text":"Turn ' + $turn + '"}],"usage":{"input_tokens":10,"output_tokens":2}}}')
        if ($turn -eq 1 -and $env:STUDIO_TEST_HANG -eq 'true') {
            # Keep the turn open like a long tool call while still reading control requests.
            $open = $true
            continue
        }
        [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Turn ' + $turn + '","usage":{"input_tokens":10,"output_tokens":2},"total_cost_usd":' + (Cost 0.001d) + '}')
    }
}
"#;

#[tokio::test]
async fn claude_tool_progress_native_loop_ticks_without_output_or_late_revival() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("tool-progress"), "enabled").unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let request = request(
        root.path(),
        &conversation,
        serde_json::json!([{"role":"user","text":"Progress"}]),
    );
    let session = request.native_session.as_ref().unwrap().id().to_string();
    let mut process = fixture(root.path(), &session, false, false);
    let (result, events) = turn(
        &mut process,
        &request,
        CancellationToken::new(),
        false,
        false,
    )
    .await;
    process.kill().await;
    assert_eq!(result.unwrap().0, "complete");
    assert!(!serde_json::to_string(&events).unwrap().contains("PRIVATE"));
    let tools: Vec<_> = events
        .into_iter()
        .filter_map(|e| match e {
            RunEvent::Tool { tool } => Some(serde_json::to_value(tool).unwrap()),
            _ => None,
        })
        .collect();
    assert!(tools
        .iter()
        .any(|t| t["status"] == "running" && t["elapsedMs"].as_u64().unwrap_or(0) >= 13000));
    assert!(tools.last().unwrap()["elapsedMs"].as_u64().unwrap() < 90000);
    assert_eq!(tools.last().unwrap()["status"], "complete");
    assert_eq!(tools.last().unwrap()["progress"]["kind"], "heartbeat");
}

#[tokio::test]
async fn a_usage_limit_ends_the_reply_with_claude_codes_own_line() {
    let root = tempfile::tempdir().unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let request = request(
        root.path(),
        &conversation,
        serde_json::json!([{"role":"user","text":"Limit"}]),
    );
    let session = request.native_session.as_ref().unwrap().id().to_string();
    let mut process = fixture(root.path(), &session, false, false);
    let (result, events) = turn(
        &mut process,
        &request,
        CancellationToken::new(),
        false,
        false,
    )
    .await;
    assert!(!process.healthy);
    process.kill().await;
    let line = "You've hit your session limit \u{b7} resets 1:50pm (America/Sao_Paulo)";
    assert_eq!(result.unwrap_err(), line);
    let limits: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            RunEvent::UsageLimit { usage_limit } => Some(usage_limit.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(limits.len(), 1);
    assert_eq!((limits[0].revision, limits[0].text.as_str()), (1, line));
    // The line is neither progress nor the answer, and the reply keeps the model that ran.
    assert!(!events.iter().any(|e| matches!(e,
        RunEvent::Progress { text, .. } | RunEvent::Text { text } if text.contains("hit your"))));
    assert!(events.iter().any(|e| matches!(e, RunEvent::Usage { usage }
        if usage.model.as_deref() == Some("fixture-model") && usage.context_input == Some(100))));
}

#[tokio::test]
async fn a_refused_tool_hears_of_planning_only_while_the_cli_reports_plan_mode() {
    // A reply started in Build and one started in Plan differ until the CLI reports a mode.
    for (plan_mode, first) in [(false, "Dangerous rm operation"), (true, "While planning")] {
        let root = tempfile::tempdir().unwrap();
        let conversation = uuid::Uuid::new_v4().to_string();
        let mut request = request(
            root.path(),
            &conversation,
            serde_json::json!([{"role":"user","text":"Refused"}]),
        );
        request.agent.plan_mode = plan_mode;
        let session = request.native_session.as_ref().unwrap().id().to_string();
        let mut process = fixture(root.path(), &session, false, false);
        let (result, _) = turn(
            &mut process,
            &request,
            CancellationToken::new(),
            false,
            false,
        )
        .await;
        process.kill().await;
        assert_eq!(result.unwrap().0, "complete");
        let answers: Vec<_> = settings_input(root.path())
            .into_iter()
            .filter(|line| line["type"] == "control_response")
            .map(|line| {
                assert_eq!(line["response"]["response"]["behavior"], "deny");
                line["response"]["response"]["message"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(answers.len(), 3, "{answers:?}");
        assert!(answers[0].contains(first), "{answers:?}");
        assert!(answers[1].contains("While planning"), "{answers:?}");
        assert!(answers[2].contains("Dangerous rm operation"), "{answers:?}");
        assert!(!answers[2].contains("planning"), "{answers:?}");
    }
}

#[tokio::test]
async fn a_resumed_session_answers_after_its_notice_about_commands_left_running() {
    // The CLI of the first reply ends with a command still running, as when the app closes. The
    // next one reports the command stopped and ends that notice's turn, with or without a
    // request, before it takes the message.
    for mode in ["Stale", "Stale answered"] {
        let root = tempfile::tempdir().unwrap();
        let conversation = uuid::Uuid::new_v4().to_string();
        let first = request(
            root.path(),
            &conversation,
            serde_json::json!([{"role":"user","text":"First"}]),
        );
        let session = first.native_session.as_ref().unwrap().id().to_string();
        let mut process = fixture(root.path(), &session, false, false);
        let (result, _) = turn(&mut process, &first, CancellationToken::new(), false, false).await;
        assert!(result.is_ok(), "{mode}");
        process.kill().await;
        drop(first);
        let next = request(
            root.path(),
            &conversation,
            serde_json::json!([{"role":"user","text":"First"},{"role":"assistant","text":"Turn 1"},{"role":"user","text":mode}]),
        );
        assert!(next.native_session.as_ref().unwrap().resumed, "{mode}");
        let mut process = fixture(root.path(), &session, false, false);
        let (result, events) =
            turn(&mut process, &next, CancellationToken::new(), false, false).await;
        assert_eq!(
            result.unwrap(),
            ("complete".into(), "Turn 1".into()),
            "{mode}"
        );
        assert!(process.alive() && process.healthy, "{mode}");
        assert!(
            !events.iter().any(|e| matches!(e,
                RunEvent::Activity { text } if text == "Waiting for background work to finish")),
            "{mode}"
        );
        process.kill().await;
    }
}

#[tokio::test]
async fn steering_requires_the_human_echo_and_kills_unconfirmed_input_at_completion() {
    for text in ["Correction", "Race completion"] {
        let root = tempfile::tempdir().unwrap();
        let conversation = uuid::Uuid::new_v4().to_string();
        let first = request(
            root.path(),
            &conversation,
            serde_json::json!([{"role":"user","text":"First"}]),
        );
        let mut process = fixture(
            root.path(),
            first.native_session.as_ref().unwrap().id(),
            true,
            false,
        );
        let hub = Questions::default();
        let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
        let channel = EventSink::new(move |e| tx.send(e).map_err(|e| e.to_string()));
        let mut questions = hub.open(&first.run_id, None, channel.clone()).unwrap();
        let run_id = first.run_id.clone();
        let task = tokio::spawn(async move {
            let result = stream_turn(
                &mut process,
                &first,
                Some(&channel),
                CancellationToken::new(),
                Some(&mut questions),
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
        let sent = hub
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
        let (result, healthy) = task.await.unwrap();
        assert_eq!(sent.is_ok(), text == "Correction");
        assert_eq!(healthy, text == "Correction");
        assert_eq!(result.unwrap().0, "complete");
    }
}

#[tokio::test]
async fn declared_background_tests_hold_the_reply_until_the_model_reports_them() {
    for (mode, text) in [
        ("Await", "Tests passed"),
        ("Await race", "Tests passed"),
        ("Await replay", "Waiting for tests"),
        ("Await lost", "Waiting for tests"),
    ] {
        let root = tempfile::tempdir().unwrap();
        let conversation = uuid::Uuid::new_v4().to_string();
        let first = request(
            root.path(),
            &conversation,
            serde_json::json!([{"role":"user","text":mode}]),
        );
        let session = first.native_session.as_ref().unwrap().id().to_string();
        let mut process = fixture(root.path(), &session, false, false);
        let started = std::time::Instant::now();
        let (result, events) =
            turn(&mut process, &first, CancellationToken::new(), false, false).await;
        assert_eq!(result.unwrap(), ("complete".into(), text.into()), "{mode}");
        assert!(process.alive() && process.healthy, "{mode}");
        if mode == "Await lost" {
            // The CLI started no turn for the finished tests, so the reply ends after the grace.
            assert!(started.elapsed() >= FOLLOW_UP_GRACE);
        }
        let waiting = events.iter().any(|e| {
            matches!(e, RunEvent::Activity { text } if text == "Waiting for background work to finish")
        });
        assert_eq!(waiting, mode != "Await replay", "{mode}");
        // The turn that reports the tests starts the answer again, so what it writes follows
        // the text the reply waited with instead of standing above it.
        let answers: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                RunEvent::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        if text == "Tests passed" {
            assert_eq!(answers, ["Waiting for tests", "", text], "{mode}");
        } else {
            assert_eq!(answers, [text], "{mode}");
        }
        let accepted = settings_input(root.path())
            .into_iter()
            .find(|v| v["response"]["request_id"] == "await-request")
            .unwrap();
        let result = &accepted["response"]["response"]["mcp_response"]["result"];
        assert_eq!(result["isError"], false, "{mode}");
        if text == "Tests passed" {
            // The reply's token counts cover both of its CLI turns.
            assert!(events.iter().any(|e| matches!(e, RunEvent::Usage { usage } if usage.input == Some(30) && usage.output == Some(5))));
        }
        let cost = |events: &[RunEvent], expected: f64| {
            events.iter().any(|e| matches!(e, RunEvent::Usage { usage } if usage.cost_usd.is_some_and(|c| (c - expected).abs() < 1e-9)))
        };
        let charged = if text == "Tests passed" { 0.003 } else { 0.001 };
        assert!(cost(&events, charged), "{mode}");
        // A follow-up turn's init must not leave the delivered message unconfirmed, and
        // the next reply pays only for itself although the CLI reports a running total.
        drop(first);
        process.turns += 1;
        process.park();
        process.claim();
        let next = request(
            root.path(),
            &conversation,
            serde_json::json!([{"role":"user","text":mode},{"role":"assistant","text":text},{"role":"user","text":"Next"}]),
        );
        let session = next.native_session.as_ref().unwrap();
        assert!(
            session.resumed && session.unconfirmed_message.is_none(),
            "{mode}"
        );
        assert!(!session.instructions_changed, "{mode}");
        let (result, events) =
            turn(&mut process, &next, CancellationToken::new(), true, false).await;
        assert!(result.is_ok(), "{mode}");
        assert!(cost(&events, 0.001), "{mode}");
        process.kill().await;
    }
}

#[tokio::test]
async fn stop_while_waiting_stops_only_declared_work_and_keeps_the_process() {
    let root = tempfile::tempdir().unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let request = request(
        root.path(),
        &conversation,
        serde_json::json!([{"role":"user","text":"Await stop"}]),
    );
    let session = request.native_session.as_ref().unwrap().id().to_string();
    let mut process = fixture(root.path(), &session, false, false);
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let channel = EventSink::new(move |event| {
        // The CLI is idle between turns: an interrupt alone produces no result.
        if matches!(&event, RunEvent::Activity { text } if text == "Waiting for background work to finish")
        {
            stop.cancel();
        }
        Ok(())
    });
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        stream_turn(
            &mut process,
            &request,
            Some(&channel),
            cancel,
            Some(&mut questions),
            false,
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        result.unwrap(),
        ("cancelled".into(), "Waiting for tests".into())
    );
    assert!(
        process.alive() && process.healthy,
        "acknowledged stops park the process without the kill fallback"
    );
    let stopped: Vec<_> = settings_input(root.path())
        .into_iter()
        .filter(|v| v["request"]["subtype"] == "stop_task")
        .map(|v| v["request"]["task_id"].clone())
        .collect();
    assert_eq!(stopped, ["tests"], "the dev server keeps running");
    process.kill().await;
}

#[tokio::test]
async fn a_steer_while_the_reply_waits_follows_the_answer_it_was_sent_after() {
    let root = tempfile::tempdir().unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let request = request(
        root.path(),
        &conversation,
        serde_json::json!([{"role":"user","text":"Agents"}]),
    );
    let session = request.native_session.as_ref().unwrap().id().to_string();
    let mut process = fixture(root.path(), &session, false, false);
    let hub = Questions::default();
    let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |e| tx.send(e).map_err(|e| e.to_string()));
    let mut questions = hub.open(&request.run_id, None, channel.clone()).unwrap();
    let run_id = request.run_id.clone();
    let task = tokio::spawn(async move {
        let result = tokio::time::timeout(
            Duration::from_secs(30),
            stream_turn(
                &mut process,
                &request,
                Some(&channel),
                CancellationToken::new(),
                Some(&mut questions),
                false,
            ),
        )
        .await;
        process.kill().await;
        result
    });
    // The turn ended with its answer while the agent works: the reply only waits.
    let mut seen = vec![];
    while let Some(event) = events.recv().await {
        let idle = matches!(event, RunEvent::BackgroundWait { wait: Some(1) });
        seen.push(event);
        if idle {
            break;
        }
    }
    let sent = hub
        .1
        .send(
            &run_id,
            None,
            crate::providers::steering::Input {
                id: uuid::Uuid::new_v4().to_string(),
                text: "Stop for now".into(),
            },
        )
        .await;
    assert_eq!(sent, Ok(()));
    let result = task.await.unwrap().expect("the reply must end");
    assert_eq!(
        result.unwrap(),
        ("complete".into(), "The plan is ready.".into())
    );
    while let Ok(event) = events.try_recv() {
        seen.push(event);
    }
    // Each turn's answer is emptied as the next turn begins: ahead of the steer that began the
    // second, and of what the third wrote once the agent reported.
    let outline: Vec<_> = seen
        .iter()
        .filter_map(|e| match e {
            RunEvent::Progress { text, .. } => Some(format!("comment: {text}")),
            RunEvent::Text { text } => Some(format!("answer: {text}")),
            RunEvent::Steering { steering, .. } => Some(format!("steer: {}", steering.text)),
            _ => None,
        })
        .collect();
    assert_eq!(
        outline,
        [
            "comment: I will write the plan once the agent reports back.",
            "answer: I will write the plan once the agent reports back.",
            "answer: ",
            "steer: Stop for now",
            "comment: Answering Stop for now",
            "answer: Answering Stop for now",
            "answer: ",
            "comment: The plan is ready.",
            "answer: The plan is ready.",
        ]
    );
}

#[tokio::test]
async fn a_message_takes_over_a_reply_that_only_waits_for_a_background_agent() {
    use crate::background_work::{Event, Watch};
    let root = tempfile::tempdir().unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let first = request(
        root.path(),
        &conversation,
        serde_json::json!([{"role":"user","text":"Agents"}]),
    );
    let first_id = first.run_id.clone();
    let session = first.native_session.as_ref().unwrap().id().to_string();
    let mut process = fixture(root.path(), &session, false, false);
    let earlier = Arc::new(Mutex::new(vec![]));
    let sink = earlier.clone();
    process.background = Some(Watch::new(
        &conversation,
        Box::new(move |event| sink.lock().unwrap().push(event)),
    ));
    let hub = Questions::default();
    let (tx, mut first_events) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |e| tx.send(e).map_err(|e| e.to_string()));
    let mut questions = hub.open(&first.run_id, None, channel.clone()).unwrap();
    let task = tokio::spawn(async move {
        let result = stream_turn(
            &mut process,
            &first,
            Some(&channel),
            CancellationToken::new(),
            Some(&mut questions),
            false,
        )
        .await;
        (process, result, first)
    });
    // The turn ended while the agent works: the CLI is idle in the first stretch.
    let mut seen = vec![];
    while let Some(event) = first_events.recv().await {
        let idle = matches!(event, RunEvent::BackgroundWait { wait: Some(1) });
        seen.push(event);
        if idle {
            break;
        }
    }
    let next_id = uuid::Uuid::new_v4().to_string();
    let (tx, mut next_events) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |e| tx.send(e).map_err(|e| e.to_string()));
    let mut next_questions = hub.open(&next_id, None, channel.clone()).unwrap();
    let target = |wait| crate::providers::take_over::Target {
        run_id: first_id.clone(),
        wait,
    };
    // Another stretch, or a launch identity that needs a new process, keeps the reply going.
    for (wait, identity, reason) in [
        (2, "fixture", take_over::BUSY),
        (1, "other", take_over::CHANGED),
    ] {
        let offer = next_questions
            .take_over
            .request(&target(wait), identity.into())
            .unwrap();
        assert_eq!(offer.await.unwrap().err().as_deref(), Some(reason));
    }
    let offer = next_questions
        .take_over
        .request(&target(1), "fixture".into())
        .unwrap();
    let (mut process, result, first) = task.await.unwrap();
    assert_eq!(
        result.unwrap(),
        (
            "complete".into(),
            "I will write the plan once the agent reports back.".into()
        )
    );
    // What execute does next: release the session and hand over the process.
    process.turns += 1;
    drop(first);
    assert!(process.carried.is_some());
    assert!(process.hand_off.take().unwrap().send(Ok(process)).is_ok());
    let mut process = offer.await.unwrap().ok().unwrap();
    let mut next = request(
        root.path(),
        &conversation,
        serde_json::json!([{"role":"user","text":"Agents"},{"role":"assistant","text":"I will write the plan once the agent reports back."},{"role":"user","text":"Next"}]),
    );
    next.run_id = next_id;
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        stream_turn(
            &mut process,
            &next,
            Some(&channel),
            CancellationToken::new(),
            Some(&mut next_questions),
            true,
        ),
    )
    .await
    .unwrap();
    // The reply that took over answered at once, then waited for the agent's report.
    assert_eq!(
        result.unwrap(),
        ("complete".into(), "The plan is ready.".into())
    );
    assert!(process.alive() && process.healthy && process.carried.is_none());
    drop(channel);
    let mut events = vec![];
    while let Ok(event) = next_events.try_recv() {
        events.push(event);
    }
    assert!(events
        .iter()
        .any(|e| matches!(e, RunEvent::Progress { text, .. } if text == "Answering Next")));
    let waits: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            RunEvent::BackgroundWait { wait } => Some(*wait),
            _ => None,
        })
        .collect();
    assert_eq!(waits, [Some(1), None]);
    // The agent's later call and outcome belong to the reply that started it.
    assert!(!events.iter().any(|e| matches!(e, RunEvent::Tool { .. })));
    let earlier: Vec<_> = earlier
        .lock()
        .unwrap()
        .iter()
        .filter_map(|event| match event {
            Event::Tool(outcome) if outcome.run_id == first_id => {
                Some(serde_json::to_value(&outcome.tool).unwrap())
            }
            _ => None,
        })
        .collect();
    assert!(earlier
        .iter()
        .any(|tool| tool["id"] == "claude:child-read" && tool["status"] == "complete"));
    let group = earlier
        .iter()
        .rfind(|tool| tool["id"] == "claude:agents")
        .unwrap();
    assert_eq!(group["agents"][0]["status"], "complete");
    assert_eq!(group["agents"][0]["result"], "Research done");
    assert!(!serde_json::to_string(&earlier).unwrap().contains("PRIVATE"));
    process.kill().await;
}

/// The real CLI is launched with the binding's --session-id, so the fixture echoes it.
fn fixture(
    root: &std::path::Path,
    session: &str,
    hang: bool,
    silent_interrupt: bool,
) -> crate::pool::Process {
    let script = root.join("claude.ps1");
    std::fs::write(&script, FIXTURE).unwrap();
    let exe = crate::providers::Executable {
        provider: "claude".into(),
        program: "powershell.exe".into(),
        prefix: vec![],
        wsl: None,
    };
    let mut command = exe.command();
    command
        .args(["-NoProfile", "-NonInteractive", "-File"])
        .arg(script)
        .env("STUDIO_TEST_SESSION", session)
        .env("STUDIO_TEST_HANG", hang.to_string())
        .env("STUDIO_TEST_SILENT_INTERRUPT", silent_interrupt.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = command.spawn().unwrap();
    crate::pool::Process::new(exe, child, "fixture".into(), session.into()).unwrap()
}

fn request(root: &std::path::Path, conversation: &str, messages: serde_json::Value) -> RunRequest {
    let mut request: RunRequest = serde_json::from_value(serde_json::json!({"runId":uuid::Uuid::new_v4(),"conversationId":conversation,"agent":{"provider":"claude","model":"fixture","instructions":""},"messages":messages})).unwrap();
    request.native_session = crate::providers::sessions::Session::prepare(root, &request).unwrap();
    assert!(request.native_session.is_some());
    request
}

fn settings_input(root: &std::path::Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(root.join("settings.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line.trim_start_matches('\u{feff}')).unwrap())
        .collect()
}

#[tokio::test]
async fn claude_settings_acknowledged_before_prompt_and_reused_without_restart() {
    let root = tempfile::tempdir().unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let mut messages = serde_json::json!([{"role":"user","text":"First"}]);
    let mut process = None;
    let mut first_pid = None;
    for (index, (model, budget)) in [
        ("fixture", Some(1024)),
        ("other", Some(4096)),
        ("other", Some(4096)),
        ("", Some(0)),
        ("", None),
    ]
    .into_iter()
    .enumerate()
    {
        let mut r = request(root.path(), &conversation, messages.clone());
        r.agent.model = model.into();
        r.agent.max_thinking_tokens = budget;
        r.claude_default_model = Some("configured-default".into());
        if process.is_none() {
            let mut p = fixture(
                root.path(),
                r.native_session.as_ref().unwrap().id(),
                false,
                false,
            );
            p.fingerprint = crate::pool::fingerprint(&r, &p.exe).unwrap();
            first_pid = p.child.id();
            process = Some(p);
        }
        let p = process.as_mut().unwrap();
        if index > 0 {
            assert!(p.serves(
                &crate::pool::fingerprint(&r, &p.exe).unwrap(),
                r.native_session.as_ref().unwrap()
            ));
            p.claim();
        }
        let (result, _) = turn(p, &r, CancellationToken::new(), index > 0, false).await;
        assert_eq!(
            result.unwrap(),
            ("complete".into(), format!("Turn {}", index + 1))
        );
        assert_eq!(p.child.id(), first_pid);
        assert!(p.healthy && p.alive());
        p.turns += 1;
        p.park();
        messages.as_array_mut().unwrap().extend([
            serde_json::json!({"role":"assistant","text":format!("Turn {}", index + 1)}),
            serde_json::json!({"role":"user","text":"Next"}),
        ]);
    }
    process.as_mut().unwrap().kill().await;
    let input = settings_input(root.path());
    let controls: Vec<_> = input
        .iter()
        .filter(|v| v["type"] == "control_request" && v["request"]["subtype"] != "initialize")
        .map(|v| v["request"].clone())
        .collect();
    assert_eq!(
        controls,
        vec![
            serde_json::json!({"subtype":"set_max_thinking_tokens","max_thinking_tokens":1024}),
            serde_json::json!({"subtype":"set_model","model":"other"}),
            serde_json::json!({"subtype":"set_max_thinking_tokens","max_thinking_tokens":4096}),
            serde_json::json!({"subtype":"set_model","model":"configured-default"}),
            serde_json::json!({"subtype":"set_max_thinking_tokens","max_thinking_tokens":0}),
            serde_json::json!({"subtype":"set_max_thinking_tokens","max_thinking_tokens":null}),
        ]
    );
    let order: Vec<_> = input
        .iter()
        .filter(|v| v["shouldQuery"] != false)
        .map(|v| {
            if v["type"] == "user" {
                "user"
            } else {
                v["request"]["subtype"].as_str().unwrap()
            }
        })
        .collect();
    assert_eq!(
        order,
        [
            "initialize",
            "set_max_thinking_tokens",
            "user",
            "set_model",
            "set_max_thinking_tokens",
            "user",
            "user",
            "set_model",
            "set_max_thinking_tokens",
            "user",
            "set_max_thinking_tokens",
            "user"
        ]
    );
}

#[tokio::test]
async fn claude_settings_failure_never_sends_the_prompt_or_reuses_partial_state() {
    for mode in ["reject", "partial", "exit", "cancel", "wait"] {
        let root = tempfile::tempdir().unwrap();
        let conversation = uuid::Uuid::new_v4().to_string();
        let r = request(
            root.path(),
            &conversation,
            serde_json::json!([{"role":"user","text":"First"}]),
        );
        let mut process = fixture(
            root.path(),
            r.native_session.as_ref().unwrap().id(),
            false,
            false,
        );
        assert!(
            turn(&mut process, &r, CancellationToken::new(), false, false)
                .await
                .0
                .is_ok()
        );
        drop(r);
        let before = process.claude_settings.clone();
        let mut r = request(
            root.path(),
            &conversation,
            serde_json::json!([{"role":"user","text":"First"},{"role":"assistant","text":"Turn 1"},{"role":"user","text":"Must not send"}]),
        );
        r.agent.model = "other".into();
        r.agent.max_thinking_tokens = Some(4096);
        std::fs::write(
            root.path().join("settings-mode"),
            if matches!(mode, "cancel" | "wait") {
                "hang"
            } else {
                mode
            },
        )
        .unwrap();
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let task = tokio::spawn(async move {
            let result = stream_turn(&mut process, &r, None, cancel, None, true).await;
            (process, result)
        });
        if matches!(mode, "cancel" | "wait") {
            tokio::time::timeout(Duration::from_secs(10), async {
                while !settings_input(root.path())
                    .iter()
                    .any(|v| v["request"]["subtype"] == "set_model")
                {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap();
            if mode == "wait" {
                // No acknowledgement deadline: the reply waits for the CLI however long it
                // takes, until the user stops it.
                tokio::time::pause();
                tokio::time::advance(Duration::from_secs(60 * 60)).await;
                tokio::time::resume();
                tokio::time::sleep(Duration::from_millis(200)).await;
                assert!(!task.is_finished(), "settings have no deadline");
            }
            stop.cancel();
        }
        let (mut process, result) = task.await.unwrap();
        if matches!(mode, "cancel" | "wait") {
            assert_eq!(result.unwrap().0, "cancelled");
        } else {
            let error = result.unwrap_err();
            assert!(!error.contains("PRIVATE"));
        }
        assert!(!process.healthy);
        assert_eq!(process.claude_settings, before);
        process.kill().await;
        assert_eq!(
            settings_input(root.path())
                .iter()
                .filter(|v| v["type"] == "user" && v["shouldQuery"] != false)
                .count(),
            1,
            "{mode}: no second human message"
        );
    }
}

#[tokio::test]
async fn manual_compaction_requires_a_boundary_and_keeps_the_native_process() {
    for command in ["/compact", "/compact missing"] {
        let root = tempfile::tempdir().unwrap();
        let conversation = uuid::Uuid::new_v4().to_string();
        let first = request(
            root.path(),
            &conversation,
            serde_json::json!([{"role":"user","text":"First"}]),
        );
        let id = first.native_session.as_ref().unwrap().id().to_string();
        let mut process = fixture(root.path(), &id, false, false);
        assert!(
            turn(&mut process, &first, CancellationToken::new(), false, false)
                .await
                .0
                .is_ok()
        );
        drop(first);
        let mut next = request(
            root.path(),
            &conversation,
            serde_json::json!([{"role":"user","text":"First"},{"role":"assistant","text":"Turn 1"},{"role":"user","text":command}]),
        );
        next.compact = true;
        let (result, events) =
            turn(&mut process, &next, CancellationToken::new(), true, false).await;
        if command == "/compact" {
            assert_eq!(
                result.unwrap(),
                ("complete".into(), "Context compacted.".into())
            );
            assert!(process.alive() && process.healthy);
            assert!(events.iter().any(
                |e| matches!(e, RunEvent::Compaction{compaction} if compaction.status == "complete")
            ));
        } else {
            assert!(result
                .unwrap_err()
                .contains("without confirming compaction"));
        }
        process.kill().await;
    }
}

async fn turn(
    process: &mut crate::pool::Process,
    request: &RunRequest,
    cancel: CancellationToken,
    reused: bool,
    interrupt_after_progress: bool,
) -> (Result<(String, String), String>, Vec<RunEvent>) {
    let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
    let stop = cancel.clone();
    let channel = EventSink::new(move |event| {
        // Process startup can exceed a fixed delay under full-suite load. Wait for
        // parent output so interruption exercises the active turn, not early Stop.
        if interrupt_after_progress && matches!(event, RunEvent::Progress { .. }) {
            stop.cancel();
        }
        events.send(event).map_err(|e| e.to_string())
    });
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        stream_turn(
            process,
            request,
            Some(&channel),
            cancel,
            Some(&mut questions),
            reused,
        ),
    )
    .await
    .expect("the turn must finish");
    drop(channel);
    let mut all = vec![];
    while let Ok(event) = received.try_recv() {
        all.push(event);
    }
    (result, all)
}

#[tokio::test]
async fn interrupt_keeps_the_process_and_the_next_reply_reuses_it() {
    let root = tempfile::tempdir().unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let first = request(
        root.path(),
        &conversation,
        serde_json::json!([{"role":"user","text":"First"}]),
    );
    let session_id = first.native_session.as_ref().unwrap().id().to_string();
    let mut process = fixture(root.path(), &session_id, true, false);
    let cancel = CancellationToken::new();
    let (result, _) = turn(&mut process, &first, cancel, false, true).await;
    assert_eq!(result.unwrap().0, "cancelled");
    assert!(
        process.alive() && process.healthy,
        "an acknowledged interrupt keeps the CLI"
    );
    drop(first);
    process.turns += 1;
    process.park();
    process.claim();
    let second = request(
        root.path(),
        &conversation,
        serde_json::json!([{"role":"user","text":"First"},{"role":"assistant","text":"Turn 1"},{"role":"user","text":"Second"}]),
    );
    let session = second.native_session.as_ref().unwrap();
    assert!(session.resumed);
    assert_eq!(session.id(), session_id);
    let (result, events) = turn(&mut process, &second, CancellationToken::new(), true, false).await;
    assert_eq!(
        result.unwrap(),
        ("complete".to_string(), "Turn 2".to_string())
    );
    assert!(process.alive() && process.healthy);
    assert!(events
        .iter()
        .any(|e| matches!(e, RunEvent::Usage { usage } if usage.cost_usd == Some(0.001))));
    process.kill().await;
    assert!(!process.alive());
}

#[tokio::test]
async fn an_unconfirmed_interrupt_falls_back_to_killing_the_process() {
    let root = tempfile::tempdir().unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let first = request(
        root.path(),
        &conversation,
        serde_json::json!([{"role":"user","text":"First"}]),
    );
    let session_id = first.native_session.as_ref().unwrap().id().to_string();
    let mut process = fixture(root.path(), &session_id, true, true);
    let cancel = CancellationToken::new();
    let started = std::time::Instant::now();
    let (result, _) = turn(&mut process, &first, cancel, false, true).await;
    assert_eq!(result.unwrap().0, "cancelled");
    assert!(started.elapsed() >= crate::pool::INTERRUPT_GRACE);
    assert!(!process.healthy);
    assert!(!process.alive());
}

#[tokio::test]
async fn a_completed_turn_leaves_the_process_waiting_for_input() {
    let root = tempfile::tempdir().unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let first = request(
        root.path(),
        &conversation,
        serde_json::json!([{"role":"user","text":"Only"}]),
    );
    let session_id = first.native_session.as_ref().unwrap().id().to_string();
    let mut process = fixture(root.path(), &session_id, false, false);
    let (result, events) = turn(&mut process, &first, CancellationToken::new(), false, false).await;
    assert_eq!(
        result.unwrap(),
        ("complete".to_string(), "Turn 1".to_string())
    );
    assert!(process.alive() && process.healthy);
    assert!(events
        .iter()
        .any(|e| matches!(e, RunEvent::Text { text } if text == "Turn 1")));
    let reasoning: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, RunEvent::Reasoning { .. }))
        .collect();
    assert_eq!(
        reasoning.len(),
        1,
        "The full block must not duplicate its streamed text"
    );
    assert!(
        matches!(reasoning[0], RunEvent::Reasoning { id, text, revision: 1, truncated: false } if id == "msg1:0" && text == "Compare paths.")
    );
    process.kill().await;
}

#[tokio::test]
async fn one_shot_runs_end_the_input_so_the_cli_exits_with_its_answer() {
    // Titles and chats without a conversation identity read until the CLI exits, which a
    // stream-json CLI does only at the end of its input.
    for conversation_only in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let mut request: RunRequest = serde_json::from_value(serde_json::json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"claude","model":"fixture","instructions":""},"messages":[{"role":"user","text":"Name this"}]})).unwrap();
        request.conversation_only = conversation_only;
        let mut process = fixture(root.path(), "", false, false);
        let result = tokio::time::timeout(
            Duration::from_secs(30),
            stream_turn(
                &mut process,
                &request,
                None,
                CancellationToken::new(),
                None,
                false,
            ),
        )
        .await
        .expect("the run must end with the CLI");
        process.kill().await;
        assert_eq!(
            result.unwrap(),
            ("complete".to_string(), "Turn 1".to_string()),
            "conversation_only: {conversation_only}"
        );
    }
}
