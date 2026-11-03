//! The installed Claude CLI and the production runner: a reply waits for the tests the
//! model declared, never for a server it left running, and Stop ends a waiting reply;
//! each reply's cost is the change in its process's running total, reused or fresh.
use super::*;
use crate::providers::questions::Questions;
use serde_json::json;

async fn run(
    text: &str,
    stop_while_waiting: bool,
) -> (Result<(String, String), String>, Vec<RunEvent>, bool) {
    run_with(text, stop_while_waiting, false).await
}

/// `run`, keeping the files the reply shows as a conversation's run does when `kept` is set.
async fn run_with(
    text: &str,
    stop_while_waiting: bool,
    kept: bool,
) -> (Result<(String, String), String>, Vec<RunEvent>, bool) {
    let root = tempfile::tempdir().unwrap();
    run_in(root.path(), text, stop_while_waiting, kept).await
}

/// `run_with` with its data in a folder the caller keeps.
async fn run_in(
    root: &std::path::Path,
    text: &str,
    stop_while_waiting: bool,
    kept: bool,
) -> (Result<(String, String), String>, Vec<RunEvent>, bool) {
    let runtime = root.join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"claude","model":"sonnet","instructions":""},"messages":[{"role":"user","text":text}]})).unwrap();
    request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    request.native_session = crate::providers::sessions::Session::prepare(root, &request).unwrap();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let mut process = crate::pool::Process::new(
        exe,
        command.spawn().unwrap(),
        "real-background-test".into(),
        request.native_session.as_ref().unwrap().id().to_string(),
    )
    .unwrap();
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
    let mut channel = EventSink::new(move |event| {
        if stop_while_waiting
            && matches!(&event, RunEvent::Activity { text } if text == "Waiting for background work to finish")
        {
            stop.cancel();
        }
        let _ = tx.send(event);
        Ok(())
    });
    if kept {
        channel = channel.with_outputs(crate::tool_output::Recorder::detached(&request.run_id));
    }
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(300),
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
    .expect("Installed CLI test timed out");
    let parkable = process.healthy && process.alive();
    process.kill().await;
    drop(channel);
    let mut events = vec![];
    while let Ok(event) = received.try_recv() {
        events.push(event);
    }
    (result, events, parkable)
}

fn waited(events: &[RunEvent]) -> bool {
    events.iter().any(
        |e| matches!(e, RunEvent::Activity { text } if text == "Waiting for background work to finish"),
    )
}

/// How often a turn's answer was emptied as the next turn began. Nothing a later turn writes
/// may arrive while an earlier turn's answer still shows, or it would stand above that text.
fn answers_started_again(events: &[RunEvent]) -> usize {
    let (mut answered, mut emptied) = (false, 0);
    for event in events {
        match event {
            RunEvent::Text { text } if text.is_empty() => {
                assert!(answered, "An answer was emptied twice, or before any");
                answered = false;
                emptied += 1;
            }
            RunEvent::Text { .. } => answered = true,
            RunEvent::Progress { text, .. } => {
                assert!(!answered, "Written under an earlier turn's answer: {text}")
            }
            _ => {}
        }
    }
    emptied
}

/// What the reply wrote, answered and was told, in the order its events arrived.
fn outline(events: &[RunEvent]) -> Vec<String> {
    let short = |text: &str| text.chars().take(60).collect::<String>();
    let mut lines: Vec<String> = vec![];
    for event in events {
        let line = match event {
            RunEvent::Progress { id, text, .. } => format!("comment {id}: {}", short(text)),
            RunEvent::Text { text } => format!("answer: {}", short(text)),
            RunEvent::Steering { steering, .. } => format!("steer: {}", short(&steering.text)),
            RunEvent::BackgroundWait { wait } => format!("wait: {wait:?}"),
            _ => continue,
        };
        // A comment streams in many events; its latest text stands for all of them.
        let streamed = |last: &String| match (last.split_once(": "), line.split_once(": ")) {
            (Some((a, _)), Some((b, _))) => a == b && a.starts_with("comment "),
            _ => false,
        };
        if lines.last().is_some_and(streamed) {
            lines.pop();
        }
        lines.push(line);
    }
    lines
}

#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_reply_waits_for_declared_tests_but_not_servers() {
    let started = std::time::Instant::now();
    let (result, events, parkable) = run("This is an Agent Studio integration test in a disposable folder. Start a stand-in dev server for me to try, in the background: node -e \"setInterval(()=>{},1000)\" . Also run the slow test suite in the background: sleep 20 && echo BACKGROUND_TESTS_PASSED . Report the test output when it is done, and leave the server running for me.", false).await;
    let (status, text) = result.expect("Installed CLI failed");
    assert_eq!(status, "complete");
    assert!(text.contains("BACKGROUND_TESTS_PASSED"), "{text}");
    assert!(started.elapsed() >= Duration::from_secs(20));
    assert!(waited(&events));
    assert!(parkable);
    // The turn that reports the tests starts the answer again before it writes anything, so
    // its text follows the text the reply waited with.
    let turns = outline(&events);
    assert!(answers_started_again(&events) >= 1, "{turns:#?}");
    eprintln!("{turns:#?}");
    // Activity shows commands by description only; keep the final state of each.
    let mut commands = std::collections::HashMap::new();
    for event in &events {
        if let RunEvent::Tool { tool } = event {
            let tool = serde_json::to_value(tool).unwrap();
            if tool["operation"] == "command" {
                commands.insert(
                    tool["id"].to_string(),
                    (tool["status"].clone(), tool["background"] == true),
                );
            }
        }
    }
    let states: Vec<_> = commands.values().collect();
    assert!(
        states.contains(&&(json!("running"), true)),
        "the server outlives the reply in the background: {states:?}"
    );
    assert!(
        states.contains(&&(json!("complete"), true)),
        "the declared tests finished in the background: {states:?}"
    );
    eprintln!(
        "Reply waited {:?} for the declared tests: {text}",
        started.elapsed()
    );
}

/// Claude Code wants a person for `rm` on a variable path even with permissions bypassed, and its
/// reason says how to write the command: the reply corrects it and finishes, as it could not when
/// the refusal said the session was planning.
#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_corrects_a_command_its_safety_check_refuses() {
    let root = tempfile::tempdir().unwrap();
    let (result, events, parkable) = run_in(root.path(),"Make a shots folder here with empty files a.png and b.png, clear the images out of it again and write done into shots/result.txt, then say what the folder holds. Start with this command in the Bash tool, and change it only if you have to:\n\nSRCD=$PWD/shots; mkdir -p $SRCD; touch $SRCD/a.png $SRCD/b.png; rm -f $SRCD/*.png; echo done > $SRCD/result.txt; ls $SRCD", false, false).await;
    let (status, text) = result.expect("Installed CLI failed");
    eprintln!("{:#?}\n{text}", outline(&events));
    assert_eq!(status, "complete");
    assert!(parkable);
    assert!(!text.to_lowercase().contains("plan mode"), "{text}");
    // The final state of each command: the refused one, then the one that replaced it.
    let mut commands = vec![];
    for event in &events {
        if let RunEvent::Tool { tool } = event {
            let tool = serde_json::to_value(tool).unwrap();
            if tool["operation"] == "command" {
                commands.retain(|(id, _)| *id != tool["id"]);
                commands.push((tool["id"].clone(), tool["status"].clone()));
            }
        }
    }
    let states: Vec<_> = commands.iter().map(|(_, status)| status).collect();
    assert_eq!(states, [&json!("error"), &json!("complete")], "{text}");
    // A chat without a folder works in one of its own.
    let shots = std::fs::read_dir(root.path().join("standalone"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
        .join("shots");
    assert!(shots.join("result.txt").is_file(), "{text}");
    assert!(!shots.join("a.png").exists(), "{text}");
}

#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_stop_ends_a_waiting_reply_and_keeps_the_process() {
    let started = std::time::Instant::now();
    let (result, events, parkable) = run("This is an Agent Studio integration test in a disposable folder. Run the slow test suite in the background: sleep 240 && echo LATE_RESULT . I need its output before you are done, so wait for it.", true).await;
    let (status, _) = result.expect("Installed CLI failed");
    assert_eq!(status, "cancelled");
    assert!(waited(&events));
    assert!(
        parkable,
        "acknowledged stops keep the CLI for the next reply"
    );
    assert!(started.elapsed() < Duration::from_secs(200));
}

/// A steer taken while the reply only waits starts another turn. The text the reply waited
/// with is emptied as its answer before the steer's receipt, so the steer stands below it and
/// above what the reply then writes.
#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_steer_while_waiting_follows_the_answer_it_was_sent_after() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let text = "This is an Agent Studio integration test in a disposable folder. Run the slow test suite in the background: sleep 90 && echo LATE_RESULT . I need its output before you are done, so wait for it, and say in one sentence that it is running.";
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"claude","model":"sonnet","instructions":""},"messages":[{"role":"user","text":text}]})).unwrap();
    request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    request.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let mut process = crate::pool::Process::new(
        exe,
        command.spawn().unwrap(),
        "real-steer-test".into(),
        request.native_session.as_ref().unwrap().id().to_string(),
    )
    .unwrap();
    let hub = Questions::default();
    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| {
        let _ = tx.send(event);
        Ok(())
    });
    let mut questions = hub.open(&request.run_id, None, channel.clone()).unwrap();
    let run_id = request.run_id.clone();
    let task = tokio::spawn(async move {
        let result = tokio::time::timeout(
            Duration::from_secs(300),
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
        // Released before anything is asserted, with the command it may still run.
        process.kill().await;
        result
    });
    let mut events = vec![];
    let waiting = tokio::time::timeout(Duration::from_secs(180), async {
        while let Some(event) = received.recv().await {
            let idle = matches!(event, RunEvent::BackgroundWait { wait: Some(_) });
            events.push(event);
            if idle {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    let sent = if waiting {
        Some(
            hub.1
                .send(
                    &run_id,
                    None,
                    crate::providers::steering::Input {
                        id: uuid::Uuid::new_v4().to_string(),
                        text: "Stop that test run now instead of waiting for it, then reply with the single word STEERED.".into(),
                    },
                )
                .await,
        )
    } else {
        None
    };
    let result = task.await.unwrap();
    while let Ok(event) = received.try_recv() {
        events.push(event);
    }
    let turns = outline(&events);
    assert!(
        waiting,
        "The model never ended its turn while the tests ran: {turns:#?}"
    );
    assert_eq!(sent, Some(Ok(())), "{turns:#?}");
    let (status, text) = result
        .expect("Installed CLI test timed out")
        .expect("Installed CLI failed");
    assert_eq!(status, "complete", "{turns:#?}");
    let steer = turns
        .iter()
        .position(|line| line.starts_with("steer: "))
        .expect("The steer left no receipt");
    let before: Vec<_> = turns[..steer]
        .iter()
        .filter(|line| line.starts_with("answer: "))
        .collect();
    // The waiting turn's answer, then the same answer emptied, and only then the steer.
    assert!(
        matches!(before.as_slice(), [.., held, emptied] if held.len() > 8 && *emptied == "answer: "),
        "{turns:#?}"
    );
    assert_eq!(turns[steer - 1], "answer: ", "{turns:#?}");
    assert!(
        turns[steer + 1..]
            .iter()
            .any(|line| line.starts_with("comment ")),
        "{turns:#?}"
    );
    assert!(answers_started_again(&events) >= 1, "{turns:#?}");
    eprintln!("Ended with {text:?}: {turns:#?}");
}

#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_reports_its_context_before_the_turn_ends() {
    let (result, events, _) = run("This is an Agent Studio integration test in a disposable folder. Run the command echo CONTEXT_CHECK , then reply with its output.", false).await;
    let (status, text) = result.expect("Installed CLI failed");
    assert_eq!(status, "complete");
    assert!(text.contains("CONTEXT_CHECK"), "{text}");
    let readings: Vec<_> = events
        .iter()
        .enumerate()
        .filter_map(|(i, e)| match e {
            RunEvent::Usage { usage } => Some((i, usage)),
            _ => None,
        })
        .collect();
    let first_call = events
        .iter()
        .position(|e| matches!(e, RunEvent::Tool { .. }))
        .expect("The model ran no command");
    // The request that runs the command reports its context as its response starts, before
    // the call, the command's result and the turn's own result.
    let (at, first) = readings.first().expect("No usage reported");
    assert!(*at < first_call, "{readings:?}");
    assert!(first.context_input.is_some_and(|n| n > 0), "{first:?}");
    assert_eq!((first.input, first.output), (None, None));
    // The request that answers after the command reads the larger context.
    let (_, last) = readings.last().unwrap();
    assert!(last.input.is_some() && last.output.is_some(), "{last:?}");
    assert!(last.context_input > first.context_input, "{readings:?}");
    eprintln!(
        "Context readings: {:?}",
        readings
            .iter()
            .map(|(_, u)| (u.context_input, u.input))
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_background_work_outlives_its_reply() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"claude","model":"sonnet","instructions":""},"messages":[{"role":"user","text":"This is an Agent Studio integration test in a disposable folder. Start two things in the background and do not wait for either: a stand-in dev server for me to try, node -e \"setInterval(()=>{},1000)\" , and a short job, sleep 15 && echo JOB_DONE . Reply right away that both started; I will check the job myself later."}]})).unwrap();
    request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    request.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let (tx, mut reported) = tokio::sync::mpsc::unbounded_channel();
    let watch = crate::background_work::Watch::new(
        "conversation",
        Box::new(move |event| {
            let _ = tx.send(event);
        }),
    );
    let mut process = crate::pool::Process::new_observed(
        exe,
        command.spawn().unwrap(),
        "real-background-work-test".into(),
        request.native_session.as_ref().unwrap().id().to_string(),
        crate::background_work::observer(None, Some(watch.clone())),
    )
    .unwrap();
    process.background = Some(watch.clone());
    let channel = EventSink::new(|_| Ok(()));
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(180),
        stream_turn(
            &mut process,
            &request,
            Some(&channel),
            CancellationToken::new(),
            Some(&mut questions),
            false,
        ),
    )
    .await
    .expect("Installed CLI test timed out");
    assert_eq!(result.expect("Installed CLI failed").0, "complete");
    // As after a production reply: the watch takes over and the process waits, parked.
    watch.detach(&request.run_id);
    process.park();
    let listed = watch.snapshot().runs;
    let outcome = tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            match reported.recv().await {
                Some(crate::background_work::Event::Tool(outcome)) => break Some(outcome),
                Some(_) => {}
                None => break None,
            }
        }
    })
    .await
    .ok()
    .flatten();
    let left = watch.snapshot().runs;
    // Releasing the process stops the server it still ran. Release it before asserting,
    // so a failure never leaves the stand-in server running.
    process.kill().await;
    let mut stopped = vec![];
    while let Ok(event) = reported.try_recv() {
        if let crate::background_work::Event::Tool(outcome) = event {
            stopped.push((outcome.tool.id.clone(), outcome.tool.status.clone()));
        }
    }
    assert_eq!(
        listed.len(),
        2,
        "both launches outlive the reply: {listed:?}"
    );
    let outcome = outcome.expect("The parked process never reported the job's outcome");
    assert_eq!(outcome.tool.status, "complete");
    assert!(outcome.tool.background);
    // Within a second of the 15-second job: the launch returns just after it starts.
    let elapsed = outcome.tool.elapsed_ms.unwrap();
    assert!((14_000..60_000).contains(&elapsed), "{elapsed}");
    assert_eq!(left.len(), 1, "the server keeps running: {left:?}");
    assert_eq!(
        stopped,
        [(left[0].id.clone(), "cancelled".to_string())],
        "{stopped:?}"
    );
    assert!(watch.snapshot().runs.is_empty());
    eprintln!("Listed {listed:?}; the job finished after {elapsed} ms while parked.");
}

#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_message_takes_over_a_reply_waiting_for_a_background_agent() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let ask = "This is an Agent Studio integration test in a disposable folder. Start exactly one sub-agent in the background with the Agent tool (run_in_background: true) whose task is: run the shell command sleep 40 && echo AGENT_DONE and report its output. Do not wait for it: end your turn right away, saying only that the agent started. When it reports back, reply with its output.";
    let question = "A quick question while the agent works: what is 17 + 25? Answer with the number only, and do not wait for the agent for this answer.";
    let mut first: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"conversationId":conversation,"agent":{"provider":"claude","model":"sonnet","instructions":""},"messages":[{"role":"user","text":ask}]})).unwrap();
    first.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &first).unwrap();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let mut command = crate::providers::chat_command(&first, &runtime, &exe)
        .await
        .unwrap();
    let (tx, mut reported) = tokio::sync::mpsc::unbounded_channel();
    let watch = crate::background_work::Watch::new(
        &conversation,
        Box::new(move |event| {
            let _ = tx.send(event);
        }),
    );
    let mut next: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"conversationId":conversation,"agent":{"provider":"claude","model":"sonnet","instructions":""},"messages":[{"role":"user","text":ask},{"role":"assistant","text":"Pending"},{"role":"user","text":question}]})).unwrap();
    // The launch identity execute gives both replies, which the CLI's reported mode confirms.
    let identity = crate::pool::fingerprint(&next, &exe).unwrap();
    let mut process = crate::pool::Process::new_observed(
        exe,
        command.spawn().unwrap(),
        identity.clone(),
        first.native_session.as_ref().unwrap().id().to_string(),
        crate::background_work::observer(None, Some(watch.clone())),
    )
    .unwrap();
    process.background = Some(watch.clone());
    let hub = Questions::default();
    let (tx, mut first_events) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| {
        let _ = tx.send(event);
        Ok(())
    });
    let mut questions = hub.open(&first.run_id, None, channel.clone()).unwrap();
    let first_id = first.run_id.clone();
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
    let wait = tokio::time::timeout(Duration::from_secs(180), async {
        while let Some(event) = first_events.recv().await {
            if let RunEvent::BackgroundWait { wait: Some(wait) } = event {
                return Some(wait);
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    let started = std::time::Instant::now();
    let next_id = next.run_id.clone();
    let answered = Arc::new(Mutex::new(None));
    let first_answer = answered.clone();
    let (tx, mut next_events) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| {
        if matches!(&event, RunEvent::Progress { text, .. } | RunEvent::Text { text } if text.contains("42"))
        {
            first_answer
                .lock()
                .unwrap()
                .get_or_insert(started.elapsed());
        }
        let _ = tx.send(event);
        Ok(())
    });
    let mut next_questions = hub.open(&next_id, None, channel.clone()).unwrap();
    let offer = wait.map(|wait| {
        next_questions
            .take_over
            .request(
                &crate::providers::take_over::Target {
                    run_id: first_id.clone(),
                    wait,
                },
                identity.clone(),
            )
            .unwrap()
    });
    let (mut process, result, first) = task.await.unwrap();
    let Some(offer) = offer else {
        process.kill().await;
        panic!("The model never ended its turn while the agent worked: {result:?}");
    };
    let Some(hand_off) = process.hand_off.take() else {
        process.kill().await;
        let mut seen = vec![];
        while let Ok(event) = first_events.try_recv() {
            seen.push(serde_json::to_string(&event).unwrap());
        }
        let refusal = offer.await.map(|offer| offer.err());
        panic!(
            "The reply did not hand over ({refusal:?}): {result:?}\n{}",
            seen.join("\n")
        );
    };
    let (status, waiting_text) = result.expect("Installed CLI failed");
    process.turns += 1;
    drop(first);
    assert!(hand_off.send(Ok(process)).is_ok());
    let mut process = offer.await.unwrap().ok().unwrap();
    next.messages[1].text = waiting_text;
    next.native_session = crate::providers::sessions::Session::prepare(root.path(), &next).unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(300),
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
    .expect("Installed CLI test timed out");
    let ended = started.elapsed();
    process.kill().await;
    drop(channel);
    let mut events = vec![];
    while let Ok(event) = next_events.try_recv() {
        events.push(event);
    }
    let mut earlier = vec![];
    while let Ok(event) = reported.try_recv() {
        if let crate::background_work::Event::Tool(outcome) = event {
            if outcome.run_id == first_id {
                earlier.push(serde_json::to_value(&outcome.tool).unwrap());
            }
        }
    }
    assert_eq!(status, "complete");
    let (status, text) = result.expect("Installed CLI failed");
    assert_eq!(status, "complete");
    let answered = answered
        .lock()
        .unwrap()
        .expect("The question was never answered");
    // The question was answered at once, and the reply then waited for the agent's report.
    assert!(answered < Duration::from_secs(30), "{answered:?}");
    assert!(
        ended > answered + Duration::from_secs(5),
        "{answered:?} {ended:?}"
    );
    let waits: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            RunEvent::BackgroundWait { wait } => Some(*wait),
            _ => None,
        })
        .collect();
    assert_eq!(waits.first(), Some(&Some(1)), "{waits:?}");
    assert_eq!(waits.last(), Some(&None), "{waits:?}");
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, RunEvent::Tool { tool } if tool.id == "claude:agents")),
        "the agent stays with the reply that started it"
    );
    let group = earlier
        .iter()
        .rfind(|tool| tool["id"] == "claude:agents")
        .expect("The agent's progress never reached the reply that started it");
    assert_eq!(group["agents"][0]["status"], "complete", "{group}");
    eprintln!(
        "Answered after {answered:?}, ended after {ended:?} with {text:?}; {} updates reached the earlier reply.",
        earlier.len()
    );
}

async fn reply_cost(
    process: &mut crate::pool::Process,
    request: &RunRequest,
    reused: bool,
) -> (Result<(String, String), String>, Option<f64>) {
    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| {
        let _ = tx.send(event);
        Ok(())
    });
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(180),
        stream_turn(
            process,
            request,
            Some(&channel),
            CancellationToken::new(),
            Some(&mut questions),
            reused,
        ),
    )
    .await
    .expect("Installed CLI test timed out");
    drop(channel);
    let mut cost = None;
    while let Ok(event) = received.try_recv() {
        if let RunEvent::Usage { usage } = event {
            cost = usage.cost_usd;
        }
    }
    (result, cost)
}

/// One reply over `process` and what it reported.
async fn reply_events(
    process: &mut crate::pool::Process,
    request: &RunRequest,
    reused: bool,
) -> (Result<(String, String), String>, Vec<RunEvent>) {
    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| {
        let _ = tx.send(event);
        Ok(())
    });
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(300),
        stream_turn(
            process,
            request,
            Some(&channel),
            CancellationToken::new(),
            Some(&mut questions),
            reused,
        ),
    )
    .await
    .expect("Installed CLI test timed out");
    drop(channel);
    let mut events = vec![];
    while let Ok(event) = received.try_recv() {
        events.push(event);
    }
    (result, events)
}

/// The latest record of each call a reply reported, as saved.
fn reported_tools(events: &[RunEvent]) -> Vec<serde_json::Value> {
    let mut tools: Vec<serde_json::Value> = vec![];
    for event in events {
        if let RunEvent::Tool { tool } = event {
            let tool = serde_json::to_value(tool).unwrap();
            match tools.iter_mut().find(|t| t["id"] == tool["id"]) {
                Some(saved) => *saved = tool,
                None => tools.push(tool),
            }
        }
    }
    tools
}

#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_a_later_reply_records_the_sub_agent_it_resumes() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let mut messages = vec![
        json!({"role":"user","text":"This is an Agent Studio integration test in a disposable folder. Start exactly one sub-agent with the Agent tool, in the background (run_in_background: true), with the description Echo helper, whose task is: run the shell command echo FIRST_PASS and report its output. Wait for it to report back, then reply with its output only."}),
    ];
    let mut process: Option<crate::pool::Process> = None;
    let mut launch: Option<(String, String)> = None;
    // The first reply starts the agent; the next resumes it in the same parked process, and the
    // last in a fresh process that resumes the session, as after a restart.
    for (index, word) in ["FIRST_PASS", "SECOND_PASS", "THIRD_PASS"]
        .into_iter()
        .enumerate()
    {
        let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"conversationId":conversation,"agent":{"provider":"claude","model":"sonnet","instructions":""},"messages":messages})).unwrap();
        request.native_session =
            crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
        let reused = index == 1;
        if reused {
            let parked = process.as_mut().unwrap();
            parked.turns += 1;
            parked.park();
            parked.claim();
        } else {
            if let Some(mut previous) = process.take() {
                previous.kill().await;
            }
            let mut command = crate::providers::chat_command(&request, &runtime, &exe)
                .await
                .unwrap();
            process = Some(
                crate::pool::Process::new(
                    exe.clone(),
                    command.spawn().unwrap(),
                    crate::pool::fingerprint(&request, &exe).unwrap(),
                    request.native_session.as_ref().unwrap().id().to_string(),
                )
                .unwrap(),
            );
        }
        let (result, events) = reply_events(process.as_mut().unwrap(), &request, reused).await;
        let tools = reported_tools(&events);
        let (status, text) = result.unwrap_or_else(|error| {
            panic!("Reply {index} failed: {error}\n{tools:#?}");
        });
        assert_eq!(status, "complete");
        assert!(text.contains(word), "Reply {index}: {text}\n{tools:#?}");
        let group = tools
            .iter()
            .find(|tool| tool["id"] == "claude:agents")
            .unwrap_or_else(|| panic!("Reply {index} recorded no sub-agent: {tools:#?}"));
        let agent = &group["agents"][0];
        assert_eq!(group["agents"].as_array().unwrap().len(), 1, "{group:#}");
        assert_eq!(agent["status"], "complete", "{group:#}");
        assert_eq!(agent["background"], true, "{group:#}");
        let (id, agent_id) = (
            agent["id"].as_str().unwrap().to_string(),
            agent["agentId"].as_str().unwrap().to_string(),
        );
        match &launch {
            None => launch = Some((id.clone(), agent_id)),
            // The resumed agent keeps the record's identity: the call that started it, which
            // its lines answer, and its agent.
            Some(started) => {
                assert_eq!(&(id.clone(), agent_id), started, "{group:#}");
                assert!(
                    tools.iter().any(|tool| tool["name"] == "Message agent"),
                    "Reply {index} resumed the agent without SendMessage: {tools:#?}"
                );
            }
        }
        assert!(
            tools.iter().any(|tool| tool["parentId"] == id.as_str()),
            "Reply {index} recorded none of its agent's calls: {tools:#?}"
        );
        eprintln!("Reply {index}: {text:?}, agent {group}");
        let agent_id = &launch.as_ref().unwrap().1;
        messages.push(json!({"role":"assistant","text":text}));
        messages.push(json!({"role":"user","text":format!("Use the SendMessage tool to send your Echo helper sub-agent (agent ID {agent_id}) this message: run the shell command echo {} and report its output. Do not start a new agent. Wait for it to report back, then reply with its output only.", ["SECOND_PASS", "THIRD_PASS", ""][index])}));
    }
    process.unwrap().kill().await;
}

#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity."]
async fn installed_claude_reply_costs_follow_each_process_running_total() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let mut messages = vec![];
    let mut process: Option<crate::pool::Process> = None;
    let (mut costs, mut totals) = (vec![], vec![]);
    // A new session, the same parked process, then a fresh process resuming the session.
    for (index, word) in ["ONE", "TWO", "THREE"].into_iter().enumerate() {
        messages.push(json!({"role":"user","text":format!("Reply with the single word {word}.")}));
        let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"conversationId":conversation,"agent":{"provider":"claude","model":"haiku","instructions":""},"messages":messages})).unwrap();
        request.native_session =
            crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
        let reused = index == 1;
        if reused {
            let parked = process.as_mut().unwrap();
            parked.turns += 1;
            parked.park();
            parked.claim();
        } else {
            if let Some(mut previous) = process.take() {
                previous.kill().await;
            }
            let mut command = crate::providers::chat_command(&request, &runtime, &exe)
                .await
                .unwrap();
            process = Some(
                crate::pool::Process::new(
                    exe.clone(),
                    command.spawn().unwrap(),
                    "real-cost-test".into(),
                    request.native_session.as_ref().unwrap().id().to_string(),
                )
                .unwrap(),
            );
        }
        let (result, cost) = reply_cost(process.as_mut().unwrap(), &request, reused).await;
        let (status, text) = result.expect("Installed CLI failed");
        assert_eq!(status, "complete");
        assert!(text.contains(word), "{text}");
        costs.push(cost.expect("Each reply reports its own cost"));
        totals.push(process.as_ref().unwrap().cost_total);
        messages.push(json!({"role":"assistant","text":text}));
    }
    process.unwrap().kill().await;
    assert!(costs.iter().all(|cost| *cost > 0.0), "{costs:?}");
    // The CLI's total runs on within one process: the reused reply pays only its change.
    assert!((costs[0] - totals[0]).abs() < 1e-9, "{costs:?} {totals:?}");
    assert!(
        (costs[0] + costs[1] - totals[1]).abs() < 1e-9,
        "{costs:?} {totals:?}"
    );
    // A fresh process that resumes the session restarts the total, since parked processes
    // are terminated rather than exiting cleanly; this per-process accounting relies on it.
    assert!(totals[2] < totals[1], "{totals:?}");
    assert!((costs[2] - totals[2]).abs() < 1e-9, "{costs:?} {totals:?}");
    eprintln!("Reply costs {costs:?} for running totals {totals:?}.");
}

#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_shows_its_question_while_it_writes_it() {
    use crate::providers::questions::{Answer, AnswerItem};
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let text = "Before writing anything else, call mcp__agent_studio__studio_ask_user once to ask which color theme I prefer for a dashboard, with four options that each have a one-sentence description. After my answer, reply with the theme I chose.";
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"claude","model":"opus","instructions":""},"messages":[{"role":"user","text":text}]})).unwrap();
    request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    request.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let mut process = crate::pool::Process::new(
        exe,
        command.spawn().unwrap(),
        "real-question-test".into(),
        request.native_session.as_ref().unwrap().id().to_string(),
    )
    .unwrap();
    let hub = Questions::default();
    let started = std::time::Instant::now();
    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
    let (answering, run_id) = (hub.clone(), request.run_id.clone());
    // The user picks the first choice as soon as the question can be answered.
    let channel = EventSink::new(move |event| {
        if let RunEvent::Question { question, .. } = &event {
            if question.status == "pending" {
                let answer = Answer {
                    request_id: question.id.clone(),
                    skipped: false,
                    answers: question
                        .questions
                        .iter()
                        .map(|q| AnswerItem {
                            id: q.id.clone(),
                            values: vec![q
                                .options
                                .first()
                                .map_or("Dark".into(), |o| o.label.clone())],
                        })
                        .collect(),
                };
                let (hub, run_id) = (answering.clone(), run_id.clone());
                tokio::spawn(async move { hub.answer(&run_id, None, answer).await });
            }
        }
        let _ = tx.send((started.elapsed(), event));
        Ok(())
    });
    let mut questions = hub.open(&request.run_id, None, channel.clone()).unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(300),
        stream_turn(
            &mut process,
            &request,
            Some(&channel),
            CancellationToken::new(),
            Some(&mut questions),
            false,
        ),
    )
    .await
    .expect("Installed CLI test timed out");
    process.kill().await;
    drop(channel);
    let mut events = vec![];
    while let Ok(event) = received.try_recv() {
        events.push(event);
    }
    let (status, answer) = result.expect("Installed CLI failed");
    assert_eq!(status, "complete");
    let (asked_at, call) = events
        .iter()
        .find_map(|(at, e)| match e {
            RunEvent::Question { question, draft } if question.status == "pending" => {
                Some((*at, draft.clone().expect("The question replaces its draft")))
            }
            _ => None,
        })
        .expect("Claude asked no question");
    let written: Vec<(Duration, String)> = events
        .iter()
        .filter_map(|(at, e)| match e {
            RunEvent::QuestionDraft { question_draft } if question_draft.id == call => Some((
                *at,
                question_draft
                    .questions
                    .first()
                    .map(|q| q.question.clone())
                    .unwrap_or_default(),
            )),
            _ => None,
        })
        .collect();
    let first = written.first().expect("No draft before the question").0;
    let texts: std::collections::HashSet<_> = written.iter().map(|(_, t)| t).collect();
    // The question showed as it was written, well before its call could be answered.
    assert!(texts.len() >= 3, "{written:?}");
    assert!(
        asked_at > first + Duration::from_millis(500),
        "{written:?} {asked_at:?}"
    );
    assert!(written.iter().all(|(at, _)| *at <= asked_at));
    assert!(!answer.is_empty());
    eprintln!(
        "Draft shown at {first:?}, {} updates, question recorded at {asked_at:?}; answer: {answer}",
        written.len()
    );
}

/// A chat builds a screen through the CLI's own call of save_screen, and the screen's action
/// runs at once, only with values its declaration accepts, as its page runs it.
#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_saves_a_screen_whose_action_runs() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let data = root.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let text = "This is an Agent Studio integration test. Call mcp__agent_studio__save_screen once to save a screen titled Probe screen. Its html is a paragraph with id status that shows the passing count from await studio.json('count', { limit: 3 }). Give it exactly one action: name count, shell powershell, an integer parameter limit with minimum 1 and maximum 5, and a script that prints, with ConvertTo-Json -Compress, an object whose passing property is [int]$env:PARAM_LIMIT. Run no other tool. Then reply with one short sentence.";
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"claude","model":"sonnet","instructions":""},"messages":[{"role":"user","text":text}]})).unwrap();
    request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    request.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let mut process = crate::pool::Process::new(
        exe,
        command.spawn().unwrap(),
        "real-screen-test".into(),
        request.native_session.as_ref().unwrap().id().to_string(),
    )
    .unwrap();
    let screens = Arc::new(crate::screens::Screens::default());
    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| {
        let _ = tx.send(event);
        Ok(())
    })
    .with_screens(crate::screens::tools::Context::for_test(
        data.clone(),
        screens.clone(),
        &request,
    ));
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(300),
        stream_turn(
            &mut process,
            &request,
            Some(&channel),
            CancellationToken::new(),
            Some(&mut questions),
            false,
        ),
    )
    .await
    .expect("Installed CLI test timed out");
    process.kill().await;
    drop(channel);
    let mut events = vec![];
    while let Ok(event) = received.try_recv() {
        events.push(event);
    }
    let (status, answer) = result.expect("Installed CLI failed");
    assert_eq!(status, "complete");
    let card = events
        .iter()
        .find_map(|event| match event {
            RunEvent::Screen { screen } => Some(screen.clone()),
            _ => None,
        })
        .expect("Claude saved no screen");
    assert_eq!(card.title, "Probe screen");
    // A window reads and runs it through the same requests.
    let ask = |request: serde_json::Value| {
        let (screens, root) = (screens.clone(), data.join("screens"));
        async move {
            screens
                .handle(
                    root,
                    "agent-studio-test".into(),
                    &crate::screens::mcp::Unlaunched,
                    serde_json::from_value(request).unwrap(),
                )
                .await
        }
    };
    let detail = ask(json!({"op":"read","id":card.id})).await.unwrap();
    assert!(
        detail["html"].as_str().unwrap().contains("studio.json"),
        "{detail}"
    );
    assert_eq!(detail["actions"][0]["name"], "count", "{detail}");
    let run = json!({"op":"run","id":card.id,"action":"count","params":{"limit":3}});
    let outcome = ask(run).await.unwrap();
    assert_eq!(outcome["exitCode"], 0, "{outcome}");
    let printed: serde_json::Value =
        serde_json::from_str(outcome["stdout"].as_str().unwrap().trim()).unwrap();
    assert_eq!(printed["passing"], 3, "{outcome}");
    let refused = ask(json!({"op":"run","id":card.id,"action":"count","params":{"limit":9}}))
        .await
        .unwrap_err();
    assert!(refused.contains("outside the range"), "{refused}");
    eprintln!(
        "Saved {} with {}; answer: {answer}",
        card.title, detail["actions"][0]["script"]
    );
}

/// A chat has Claude Code's own Artifact tools, which a headless CLI offers only when its launch
/// asks (requested 2026-10-21): a read-only listing of the account's claude.ai artifacts goes
/// through the CLI's own login and comes back as a labelled call, publishing nothing.
#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity, a model's tool choice and the account's claude.ai artifacts."]
async fn installed_claude_lists_its_claude_ai_artifacts() {
    let text = "This is an Agent Studio integration test. Call the Artifact tool exactly once with {\"action\":\"list\",\"limit\":1}. Publish nothing and call no other tool. Reply with one short sentence saying how many artifacts the listing reports in all.";
    let (result, events, _) = run(text, false).await;
    for line in outline(&events) {
        eprintln!("{line}");
    }
    let (status, answer) = result.expect("Installed CLI failed");
    assert_eq!(status, "complete");
    let listed = events
        .iter()
        .filter_map(|event| match event {
            RunEvent::Tool { tool } => Some(serde_json::to_value(tool).unwrap()),
            _ => None,
        })
        .rfind(|tool| tool["name"] == "Artifact")
        .expect("Claude never called its Artifact tool");
    assert_eq!(listed["operation"], "artifact:list", "{listed}");
    assert_eq!(listed["status"], "complete", "{listed}");
    // Listing makes no card.
    assert!(!events
        .iter()
        .any(|event| matches!(event, RunEvent::PublishedArtifact { .. })));
    eprintln!("Answer: {answer}");
}

/// A chat compares two files through the CLI's own call of compare_files, which checks both where
/// the chat runs and records them as one comparison, each file with its label.
#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_compares_two_files_side_by_side() {
    let folder = tempfile::tempdir().unwrap();
    let [before, after] = [("before.png", 4, 3), ("after.png", 8, 6)].map(|(name, w, h)| {
        let path = folder.path().join(name);
        crate::providers::sent_files::test_png(&path, w, h);
        path.display().to_string()
    });
    let text = format!("This is an Agent Studio integration test. Call mcp__agent_studio__compare_files once with id pair, the two files {before} and {after} in that order, and the labels Before and After. Call no other tool. Reply with one short sentence followed by <!-- files:pair --> on its own line.");
    let (result, events, _) = run_with(&text, false, true).await;
    for line in outline(&events) {
        eprintln!("{line}");
    }
    let (status, answer) = result.expect("Installed CLI failed");
    assert_eq!(status, "complete");
    let shown = events
        .iter()
        .find_map(|event| match event {
            RunEvent::SentFiles { sent_files } => Some(sent_files.clone()),
            _ => None,
        })
        .expect("Claude compared no files");
    assert_eq!(shown.id, "pair");
    assert!(shown.compare);
    let files: Vec<_> = shown
        .files
        .iter()
        .map(|file| (file.name.as_str(), file.label.as_deref(), file.width))
        .collect();
    assert_eq!(
        files,
        [
            ("before.png", Some("Before"), Some(4)),
            ("after.png", Some("After"), Some(8))
        ]
    );
    assert!(answer.contains("<!-- files:pair -->"), "{answer}");
    eprintln!("Answer: {answer}");
}

/// A session made outside Agent Studio, as the terminal makes one, continues in a chat imported
/// from it: the first reply forks it with its context, and the original stays as it was.
#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity."]
async fn installed_claude_continues_an_imported_session_as_a_fork() {
    let folder = tempfile::tempdir().unwrap();
    let source = uuid::Uuid::new_v4().to_string();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let made = exe
        .command()
        .current_dir(folder.path())
        .args([
            "-p",
            "Remember the codeword HERON-4417 for later. Reply only OK.",
            "--session-id",
            &source,
            "--model",
            "haiku",
        ])
        .env_remove("CLAUDECODE")
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .unwrap();
    assert!(
        made.status.success(),
        "{}",
        String::from_utf8_lossy(&made.stderr)
    );
    let profile = crate::context::native_profile_root("claude").await.unwrap();
    let transcript = crate::native_instructions::find_record(&profile, "claude", &source)
        .unwrap()
        .expect("The terminal session was saved");
    let original = std::fs::read(&transcript).unwrap();

    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),
        "conversationId":uuid::Uuid::new_v4(),
        "location":{"computerId":uuid::Uuid::new_v4(),"environmentId":uuid::Uuid::new_v4(),"path":folder.path()},
        "agent":{"provider":"claude","model":"haiku","instructions":""},
        "messages":[{"role":"user","text":"Remember the codeword HERON-4417 for later. Reply only OK."},
            {"role":"assistant","text":"OK"},
            {"role":"user","text":"What was the codeword? Reply with the codeword only."}]}))
    .unwrap();
    let conversation = request.conversation_id.clone().unwrap();
    let record = crate::imports::Record {
        version: 1,
        source: crate::imports::Source {
            provider: "claude".into(),
            environment_id: uuid::Uuid::new_v4().to_string(),
            connection_id: None,
        },
        session: source.clone(),
        imported_at: 1,
        path: None,
    };
    crate::imports::write_record(root.path(), &conversation, &record).unwrap();
    let mut session = crate::providers::sessions::Session::prepare(root.path(), &request)
        .unwrap()
        .unwrap();
    assert_eq!(session.imported(), Some("claude"));
    session
        .fork_import(profile.clone(), profile.clone(), &request, record)
        .await
        .unwrap();
    let fork = session.id().to_string();
    assert_ne!(fork, source);
    request.native_session = Some(session);
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let mut process =
        crate::pool::Process::new(exe, command.spawn().unwrap(), "import".into(), fork.clone())
            .unwrap();
    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| {
        let _ = tx.send(event);
        Ok(())
    });
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(300),
        stream_turn(
            &mut process,
            &request,
            Some(&channel),
            CancellationToken::new(),
            Some(&mut questions),
            false,
        ),
    )
    .await
    .expect("Installed CLI test timed out");
    process.kill().await;
    drop(channel);
    while received.try_recv().is_ok() {}
    let (status, text) = result.expect("Installed CLI failed");
    assert_eq!(status, "complete");
    assert!(text.contains("HERON-4417"), "{text}");
    let bound: serde_json::Value = serde_json::from_slice(
        &std::fs::read(
            root.path()
                .join("native-sessions")
                .join(format!("{conversation}.json")),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        bound["id"],
        fork.as_str(),
        "The chat continues its own fork"
    );
    assert_eq!(
        std::fs::read(&transcript).unwrap(),
        original,
        "The original is unchanged"
    );
    let forked = crate::native_instructions::find_record(&profile, "claude", &fork)
        .unwrap()
        .expect("The fork was saved in the profile");
    eprintln!("Forked {source} into {fork}: {text}");
    for path in [transcript, forked] {
        std::fs::remove_file(path).unwrap();
    }
}

/// A chat the Claude app ran in a WSL folder, whose transcript the distribution keeps,
/// continues with this computer's CLI: the first reply forks the transcript read through
/// `\\wsl.localhost` and runs in the folder's Windows path, and the original stays as it was.
/// Needs a managed WSL distribution (STUDIO_TEST_DISTRIBUTION, default Ubuntu).
#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and WSL."]
async fn installed_claude_continues_a_wsl_chat_with_this_computers_cli() {
    // A project folder the test made, with the empty memory folder Claude Code adds to it.
    let tidy = |folder: &std::path::Path| {
        let _ = std::fs::remove_dir(folder.join("memory"));
        let _ = std::fs::remove_dir(folder);
    };
    let distribution =
        std::env::var("STUDIO_TEST_DISTRIBUTION").unwrap_or_else(|_| "Ubuntu".into());
    let source = uuid::Uuid::new_v4().to_string();
    let exe = crate::providers::resolve("claude").await.unwrap();
    // A session to stand for the app's: made here, then kept in the distribution as the
    // app's Claude Code there keeps one, with the folder it ran in.
    let made_in = tempfile::tempdir().unwrap();
    let made = exe
        .command()
        .current_dir(made_in.path())
        .args([
            "-p",
            "Remember the codeword KESTREL-2093 for later. Reply only OK.",
            "--session-id",
            &source,
            "--model",
            "haiku",
        ])
        .env_remove("CLAUDECODE")
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .unwrap();
    assert!(
        made.status.success(),
        "{}",
        String::from_utf8_lossy(&made.stderr)
    );
    let profile = crate::context::native_profile_root("claude").await.unwrap();
    let made_transcript = crate::native_instructions::find_record(&profile, "claude", &source)
        .unwrap()
        .expect("The session was saved");
    let scratch = format!("studio-import-{}", uuid::Uuid::new_v4().simple());
    let linux = format!("/tmp/{scratch}/work");
    let share =
        std::path::PathBuf::from(format!("\\\\wsl.localhost\\{distribution}\\tmp\\{scratch}"));
    std::fs::create_dir_all(share.join("work")).unwrap();
    let store = share.join(".claude");
    let relative = format!("projects/-tmp-{scratch}-work/{source}.jsonl");
    let original = store.join(&relative);
    std::fs::create_dir_all(original.parent().unwrap()).unwrap();
    let mut kept = String::new();
    for line in std::fs::read_to_string(&made_transcript).unwrap().lines() {
        let mut record: serde_json::Value = serde_json::from_str(line).unwrap();
        if record.get("cwd").is_some() {
            record["cwd"] = json!(linux);
        }
        kept.push_str(&record.to_string());
        kept.push('\n');
    }
    std::fs::write(&original, &kept).unwrap();
    std::fs::remove_file(&made_transcript).unwrap();
    tidy(made_transcript.parent().unwrap());

    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),
        "conversationId":uuid::Uuid::new_v4(),
        "location":{"computerId":uuid::Uuid::new_v4(),"environmentId":uuid::Uuid::new_v4(),
            "executionEnvironmentId":uuid::Uuid::new_v4(),"path":linux},
        "agent":{"provider":"claude","model":"haiku","instructions":""},
        "messages":[{"role":"user","text":"Remember the codeword KESTREL-2093 for later. Reply only OK."},
            {"role":"assistant","text":"OK"},
            {"role":"user","text":"What was the codeword, and what is your current working directory? Reply with both on one line."}]}))
    .unwrap();
    let conversation = request.conversation_id.clone().unwrap();
    let record = crate::imports::Record {
        version: 1,
        source: crate::imports::Source {
            provider: "claude".into(),
            environment_id: uuid::Uuid::new_v4().to_string(),
            connection_id: None,
        },
        session: source.clone(),
        imported_at: 1,
        path: Some(relative),
    };
    crate::imports::write_record(root.path(), &conversation, &record).unwrap();
    // This computer's CLI, with the folder in the distribution, as a Desktop chat runs it.
    let selected = crate::profiles::Profile {
        provider: "claude".into(),
        folder_distribution: Some(distribution.clone()),
        ..Default::default()
    };
    let (result, fork) = crate::profiles::scope(selected, async {
        let mut session = crate::providers::sessions::Session::prepare(root.path(), &request)
            .unwrap()
            .unwrap();
        assert_eq!(session.imported(), Some("claude"));
        session
            .fork_import(store.clone(), profile.clone(), &request, record)
            .await
            .unwrap();
        let fork = session.id().to_string();
        request.native_session = Some(session);
        let mut command = crate::providers::chat_command(&request, &runtime, &exe)
            .await
            .unwrap();
        let mut process =
            crate::pool::Process::new(exe, command.spawn().unwrap(), "import".into(), fork.clone())
                .unwrap();
        let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
        let channel = EventSink::new(move |event| {
            let _ = tx.send(event);
            Ok(())
        });
        let mut questions = Questions::default()
            .open(&request.run_id, None, channel.clone())
            .unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(300),
            stream_turn(
                &mut process,
                &request,
                Some(&channel),
                CancellationToken::new(),
                Some(&mut questions),
                false,
            ),
        )
        .await
        .expect("Installed CLI test timed out");
        process.kill().await;
        drop(channel);
        while received.try_recv().is_ok() {}
        (result, fork)
    })
    .await;
    let forked = crate::native_instructions::find_record(&profile, "claude", &fork)
        .unwrap()
        .expect("The fork was saved in the profile");
    let ran_in = std::fs::read_to_string(&forked)
        .unwrap()
        .lines()
        .rev()
        .find_map(|line| {
            let record: serde_json::Value = serde_json::from_str(line).ok()?;
            record["cwd"].as_str().map(String::from)
        });
    let unchanged = std::fs::read_to_string(&original).unwrap() == kept;
    std::fs::remove_file(&forked).unwrap();
    tidy(forked.parent().unwrap());
    std::fs::remove_dir_all(&share).unwrap();
    let (status, text) = result.expect("Installed CLI failed");
    eprintln!("Forked {source} into {fork}, ran in {ran_in:?}: {text}");
    assert_eq!(status, "complete");
    assert!(text.contains("KESTREL-2093"), "{text}");
    assert!(unchanged, "The original is unchanged");
    assert_eq!(
        ran_in.as_deref(),
        Some(format!("\\\\wsl.localhost\\{distribution}\\tmp\\{scratch}\\work").as_str())
    );
}

/// A chat whose transcript Claude Code's cleanup deleted continues as a new session from its
/// saved messages instead of failing to resume, and the new session is the one it keeps.
#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity."]
async fn installed_claude_continues_a_chat_whose_transcript_was_cleaned_up() {
    let folder = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let profile = crate::context::native_profile_root("claude").await.unwrap();
    let cwd = folder.path().to_string_lossy().into_owned();
    let conversation = uuid::Uuid::new_v4().to_string();
    let (computer, environment) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let request = |messages: &serde_json::Value| -> RunRequest {
        serde_json::from_value(
            json!({"runId":uuid::Uuid::new_v4(),"conversationId":conversation,
            "location":{"computerId":computer,"environmentId":environment,"path":cwd},
            "agent":{"provider":"claude","model":"haiku","instructions":""},"messages":messages}),
        )
        .unwrap()
    };
    let reply = |request: RunRequest| {
        let (exe, runtime) = (exe.clone(), runtime.clone());
        async move {
            let mut command = crate::providers::chat_command(&request, &runtime, &exe)
                .await
                .unwrap();
            let id = request.native_session.as_ref().unwrap().id().to_string();
            let mut process =
                crate::pool::Process::new(exe, command.spawn().unwrap(), "cleanup".into(), id)
                    .unwrap();
            let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
            let channel = EventSink::new(move |event| {
                let _ = tx.send(event);
                Ok(())
            });
            let mut questions = Questions::default()
                .open(&request.run_id, None, channel.clone())
                .unwrap();
            let result = tokio::time::timeout(
                Duration::from_secs(300),
                stream_turn(
                    &mut process,
                    &request,
                    Some(&channel),
                    CancellationToken::new(),
                    Some(&mut questions),
                    false,
                ),
            )
            .await
            .expect("Installed CLI test timed out");
            process.kill().await;
            drop(channel);
            while received.try_recv().is_ok() {}
            result.expect("Installed CLI failed")
        }
    };
    let mut messages = json!([{"role":"user","text":"Remember the codeword KESTREL-2093 for later. Reply only OK."}]);
    let mut first = request(&messages);
    first.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &first).unwrap();
    let original = first.native_session.as_ref().unwrap().id().to_string();
    let (status, text) = reply(first).await;
    assert_eq!(status, "complete");
    let transcript = crate::native_instructions::find_record(&profile, "claude", &original)
        .unwrap()
        .expect("The first reply saved its transcript");
    messages.as_array_mut().unwrap().extend([
        json!({"role":"assistant","text":text}),
        json!({"role":"user","text":"What was the codeword? Reply with the codeword only."}),
    ]);
    // While the transcript is there, the next reply resumes it.
    let mut kept = crate::providers::sessions::Session::prepare(root.path(), &request(&messages))
        .unwrap()
        .unwrap();
    assert!(kept.resumed);
    assert!(!kept.verify_transcript(&exe, Some(cwd.clone())).await);
    assert_eq!(kept.id(), original);
    drop(kept);
    // Claude Code's cleanup removes it, with the folder of files it kept beside it.
    std::fs::remove_file(&transcript).unwrap();
    let _ = std::fs::remove_dir_all(transcript.with_extension(""));
    let mut second = request(&messages);
    let mut session = crate::providers::sessions::Session::prepare(root.path(), &second)
        .unwrap()
        .unwrap();
    assert!(session.verify_transcript(&exe, Some(cwd.clone())).await);
    assert!(session.transcript_missing && !session.resumed);
    let fresh = session.id().to_string();
    assert_ne!(fresh, original);
    second.native_session = Some(session);
    let (status, text) = reply(second).await;
    assert_eq!(status, "complete");
    assert!(text.contains("KESTREL-2093"), "{text}");
    let bound: serde_json::Value = serde_json::from_slice(
        &std::fs::read(
            root.path()
                .join("native-sessions")
                .join(format!("{conversation}.json")),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        bound["id"],
        fresh.as_str(),
        "The chat keeps its new session"
    );
    let continued = crate::native_instructions::find_record(&profile, "claude", &fresh)
        .unwrap()
        .expect("The new session was saved");
    eprintln!("Continued {original} as {fresh}: {text}");
    // The project folder named after the throwaway folder holds only this test's files.
    std::fs::remove_dir_all(continued.parent().unwrap()).unwrap();
}

/// A chat whose CLI ended with a command still running, as when the app closes or crashes,
/// answers its next message the first time: the resumed session reports that command stopped and
/// ends the notice's turn before it takes the message.
#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_answers_the_first_message_after_a_command_was_left_running() {
    let folder = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let profile = crate::context::native_profile_root("claude").await.unwrap();
    let cwd = folder.path().to_string_lossy().into_owned();
    let conversation = uuid::Uuid::new_v4().to_string();
    let (computer, environment) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let request = |messages: &serde_json::Value| -> RunRequest {
        let mut request: RunRequest = serde_json::from_value(
            json!({"runId":uuid::Uuid::new_v4(),"conversationId":conversation,
            "location":{"computerId":computer,"environmentId":environment,"path":cwd},
            "agent":{"provider":"claude","model":"haiku","instructions":""},"messages":messages}),
        )
        .unwrap();
        request.native_session =
            crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
        request
    };
    // Each reply starts a CLI of its own and kills it with what it runs, as quitting does.
    let reply = |request: RunRequest| {
        let (exe, runtime) = (exe.clone(), runtime.clone());
        async move {
            let mut command = crate::providers::chat_command(&request, &runtime, &exe)
                .await
                .unwrap();
            let id = request.native_session.as_ref().unwrap().id().to_string();
            let mut process =
                crate::pool::Process::new(exe, command.spawn().unwrap(), "left".into(), id)
                    .unwrap();
            let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
            let channel = EventSink::new(move |event| {
                let _ = tx.send(event);
                Ok(())
            });
            let mut questions = Questions::default()
                .open(&request.run_id, None, channel.clone())
                .unwrap();
            let result = tokio::time::timeout(
                Duration::from_secs(300),
                stream_turn(
                    &mut process,
                    &request,
                    Some(&channel),
                    CancellationToken::new(),
                    Some(&mut questions),
                    false,
                ),
            )
            .await
            .expect("Installed CLI test timed out");
            process.kill().await;
            drop(channel);
            while received.try_recv().is_ok() {}
            (
                request.native_session.as_ref().unwrap().id().to_string(),
                result,
            )
        }
    };
    let mut messages = json!([{"role":"user","text":"Use the Bash tool with run_in_background set to true to run exactly: sleep 300. Do not wait for it. Then reply only STARTED."}]);
    let (session, first) = reply(request(&messages)).await;
    let (status, text) = first.expect("The first reply failed");
    assert_eq!(status, "complete");
    messages.as_array_mut().unwrap().extend([
        json!({"role":"assistant","text":text}),
        json!({"role":"user","text":"What is 2+2? Reply with the number only."}),
    ]);
    let next = request(&messages);
    assert!(next.native_session.as_ref().unwrap().resumed);
    let (_, second) = reply(next).await;
    let transcript = crate::native_instructions::find_record(&profile, "claude", &session)
        .unwrap()
        .expect("The replies saved their transcript");
    let held = std::fs::read_to_string(&transcript).unwrap();
    // The project folder named after the throwaway folder holds only this test's files.
    std::fs::remove_dir_all(transcript.parent().unwrap()).unwrap();
    assert!(
        held.contains("didn't finish before the previous session ended"),
        "The resumed session reported the command left running"
    );
    let (status, text) = second.expect("The first message after the restart failed");
    assert_eq!(status, "complete");
    assert!(text.contains('4'), "{text}");
}

/// An orchestrator's reply reaches the workflow tools through the SDK server: each call goes to
/// this computer's window, here a stand-in answering it, and the window's answer reaches the CLI.
#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_answers_workflow_tools_through_the_window() {
    use crate::providers::workflow_calls::{Binding, Call, Context};
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let text = "This is an Agent Studio integration test. Call mcp__agent_studio__workflow_list once, then call mcp__agent_studio__dynamic_state once. Run no other tool. Then reply with one short sentence naming the workflow and the dynamic workflow title they report.";
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"claude","model":"sonnet","instructions":""},"messages":[{"role":"user","text":text}]})).unwrap();
    request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    let mission = Binding {
        run_id: uuid::Uuid::new_v4().to_string(),
        role: "orchestrator".into(),
    };
    request.mission = Some(mission.clone());
    request.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let mut process = crate::pool::Process::new(
        exe,
        command.spawn().unwrap(),
        "real-workflow-test".into(),
        request.native_session.as_ref().unwrap().id().to_string(),
    )
    .unwrap();
    let channel = EventSink::new(|_| Ok(()));
    let hub = Questions::default();
    let mut questions = hub.open(&request.run_id, None, channel.clone()).unwrap();
    // The window: each call it hears is answered as the workflow engine would answer it.
    let (calls, mut heard) = tokio::sync::mpsc::unbounded_channel::<Call>();
    questions.workflow.attach(Some(Context {
        conversation_id: request.conversation_id.clone().unwrap(),
        connection_id: None,
        mission: Some(mission.clone()),
        emit: Arc::new(move |call: &Call| {
            let _ = calls.send(call.clone());
        }),
    }));
    let window = {
        let hub = hub.clone();
        tokio::spawn(async move {
            let mut tools = vec![];
            while let Some(call) = heard.recv().await {
                tools.push((call.tool.clone(), call.mission.clone()));
                let text = match call.tool.as_str() {
                    "workflow_list" => json!({"workflows":[{"id":"w1","name":"Nightly report","steps":3}],"runs":[]}).to_string(),
                    "dynamic_state" => json!({"mission":{"title":"Probe mission","status":"running"}}).to_string(),
                    other => format!("Unexpected tool {other}"),
                };
                let _ = hub
                    .4
                    .answer(&call.run_id, None, &call.id, text, false)
                    .await;
            }
            tools
        })
    };
    let result = tokio::time::timeout(
        Duration::from_secs(300),
        stream_turn(
            &mut process,
            &request,
            Some(&channel),
            CancellationToken::new(),
            Some(&mut questions),
            false,
        ),
    )
    .await
    .expect("Installed CLI test timed out");
    process.kill().await;
    drop(questions);
    let (status, answer) = result.expect("Installed CLI failed");
    let tools = tokio::time::timeout(Duration::from_secs(5), window).await;
    assert_eq!(status, "complete");
    let tools = tools.ok().and_then(|t| t.ok()).unwrap_or_default();
    let names: Vec<&str> = tools.iter().map(|(name, _)| name.as_str()).collect();
    assert!(names.contains(&"workflow_list"), "{names:?}");
    assert!(names.contains(&"dynamic_state"), "{names:?}");
    assert!(tools
        .iter()
        .all(|(_, binding)| binding.as_ref() == Some(&mission)));
    assert!(answer.contains("Nightly report"), "{answer}");
    assert!(answer.contains("Probe mission"), "{answer}");
    eprintln!("Tools {names:?}; answer: {answer}");
}

/// One reply of a chat on a process the test keeps, as a parked process serves later replies.
async fn reply_on(
    process: &mut crate::pool::Process,
    request: &RunRequest,
    reused: bool,
) -> (String, String) {
    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| {
        let _ = tx.send(event);
        Ok(())
    });
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(300),
        stream_turn(
            process,
            request,
            Some(&channel),
            CancellationToken::new(),
            Some(&mut questions),
            reused,
        ),
    )
    .await
    .expect("Installed CLI test timed out");
    drop(channel);
    while received.try_recv().is_ok() {}
    result.expect("Installed CLI failed")
}

/// Claude Code compacts a chat by putting a summary in place of its messages, which keeps the
/// guidance only the first message carried by chance. The compaction hook gives it back: after
/// /compact the transcript holds the hook's answer after the boundary, and the model still
/// knows which tool shows the user a file.
#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity."]
async fn installed_claude_hears_the_guidance_again_after_a_compaction() {
    let folder = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let profile = crate::context::native_profile_root("claude").await.unwrap();
    let cwd = folder.path().to_string_lossy().into_owned();
    let conversation = uuid::Uuid::new_v4().to_string();
    let (computer, environment) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let request = |messages: &serde_json::Value, compact: bool| -> RunRequest {
        let mut request: RunRequest = serde_json::from_value(
            json!({"runId":uuid::Uuid::new_v4(),"conversationId":conversation,"compact":compact,
            "location":{"computerId":computer,"environmentId":environment,"path":cwd},
            "agent":{"provider":"claude","model":"haiku","instructions":""},"messages":messages}),
        )
        .unwrap();
        request.native_session =
            crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
        request
    };
    let mut messages = json!([{"role":"user","text":"Reply only OK."}]);
    let first = request(&messages, false);
    let session = first.native_session.as_ref().unwrap().id().to_string();
    let mut command = crate::providers::chat_command(&first, &runtime, &exe)
        .await
        .unwrap();
    let mut process = crate::pool::Process::new(
        exe.clone(),
        command.spawn().unwrap(),
        "compaction".into(),
        session.clone(),
    )
    .unwrap();
    let (status, text) = reply_on(&mut process, &first, false).await;
    assert_eq!(status, "complete");
    drop(first);
    messages.as_array_mut().unwrap().extend([
        json!({"role":"assistant","text":text}),
        json!({"role":"user","text":"/compact"}),
    ]);
    let compact = request(&messages, true);
    let (status, text) = reply_on(&mut process, &compact, true).await;
    assert_eq!(
        (status.as_str(), text.as_str()),
        ("complete", "Context compacted.")
    );
    drop(compact);
    messages.as_array_mut().unwrap().extend([
        json!({"role":"assistant","text":text}),
        json!({"role":"user","text":"Without calling any tool, reply with only the full name of the tool this conversation's guidance says to call to show the user an image file."}),
    ]);
    let question = request(&messages, false);
    let (status, answer) = reply_on(&mut process, &question, true).await;
    process.kill().await;
    drop(question);
    let transcript = crate::native_instructions::find_record(&profile, "claude", &session)
        .unwrap()
        .expect("The session saved its transcript");
    let lines = std::fs::read_to_string(&transcript).unwrap();
    let after = lines
        .rsplit_once("\"subtype\":\"compact_boundary\"")
        .expect("The transcript records the compaction")
        .1;
    // Claude Code keeps the hooks' contexts as one attachment, each whole in the conversation.
    let heard: Vec<String> = after
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|line| {
            line["attachment"]["type"] == "hook_additional_context"
                && line["attachment"].to_string().contains("Agent Studio")
        })
        .map(|line| {
            line["attachment"]["content"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry.as_str().unwrap().to_owned())
                .collect()
        })
        .unwrap_or_default();
    let sizes: Vec<usize> = heard.iter().map(|entry| entry.chars().count()).collect();
    eprintln!("After the boundary: pieces of {sizes:?}; answer: {answer}");
    // The project folder named after the throwaway folder holds only this test's files.
    std::fs::remove_dir_all(transcript.parent().unwrap()).unwrap();
    assert_eq!(status, "complete");
    assert!(
        heard.len() > 1,
        "The guidance follows the boundary in pieces"
    );
    assert!(heard
        .iter()
        .all(|entry| !entry.contains("<persisted-output>")));
    assert!(heard.concat().contains("mcp__agent_studio__send_files"));
    assert!(answer.contains("send_files"), "{answer}");
}
