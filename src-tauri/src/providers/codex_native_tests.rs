//! The installed Codex CLI and the production loop: its app-server accepts Agent Studio's
//! dynamic tools on a new thread, and its model builds a screen through save_screen.
use super::*;
use crate::{protocol::RunEvent, providers::questions::Questions};
use std::sync::Arc;

/// The installed CLI takes Fast mode as each turn's service tier, on and off.
#[tokio::test]
#[ignore = "Opt-in installed Codex CLI test; uses subscription capacity, at the Fast tier's rate once."]
async fn installed_codex_answers_with_fast_mode_on_and_off() {
    for fast in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("chat-runtime");
        std::fs::create_dir_all(&runtime).unwrap();
        let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"","reasoning":"low","instructions":"","fastMode":fast},"messages":[{"role":"user","text":"This is an Agent Studio integration test. Run no tool. Reply with just the word OK."}]})).unwrap();
        request.validate().unwrap();
        request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
        request.native_session =
            crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
        let exe = crate::providers::resolve("codex").await.unwrap();
        let mut command = crate::providers::chat_command(&request, &runtime, &exe)
            .await
            .unwrap();
        let mut process = Process::new(
            exe,
            command.spawn().unwrap(),
            "real-fast-test".into(),
            String::new(),
        )
        .unwrap();
        let (tx, _received) = tokio::sync::mpsc::unbounded_channel();
        let channel = EventSink::new(move |event| {
            let _ = tx.send(event);
            Ok(())
        });
        let mut questions = Questions::default()
            .open(&request.run_id, None, channel.clone())
            .unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(300),
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
        .expect("Installed CLI test timed out");
        process.kill().await;
        let (status, answer) = result.expect("Installed CLI failed");
        assert_eq!(status, "complete", "Fast mode {fast}");
        assert!(answer.contains("OK"), "Fast mode {fast}: {answer}");
        eprintln!("Fast mode {fast}: {answer}");
    }
}

#[tokio::test]
#[ignore = "Opt-in installed Codex CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_codex_saves_a_screen_whose_action_runs() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let data = root.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let text = "This is an Agent Studio integration test. Call the save_screen tool once to save a screen titled Probe screen. Its html is a paragraph with id status that shows the passing count from await studio.json('count', { limit: 3 }). Give it exactly one action: name count, shell powershell, an integer parameter limit with minimum 1 and maximum 5, and a script that prints, with ConvertTo-Json -Compress, an object whose passing property is [int]$env:PARAM_LIMIT. Run no other tool and no command. Then reply with one short sentence.";
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"","reasoning":"low","instructions":""},"messages":[{"role":"user","text":text}]})).unwrap();
    request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    request.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
    let exe = crate::providers::resolve("codex").await.unwrap();
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let mut process = Process::new(
        exe,
        command.spawn().unwrap(),
        "real-screen-test".into(),
        String::new(),
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
        .expect("Codex saved no screen");
    assert_eq!(card.title, "Probe screen");
    let ask = |request: Value| {
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
    assert_eq!(detail["actions"][0]["name"], "count", "{detail}");
    let run = json!({"op":"run","id":card.id,"action":"count","params":{"limit":3}});
    let outcome = ask(run).await.unwrap();
    assert_eq!(outcome["exitCode"], 0, "{outcome}");
    let printed: Value = serde_json::from_str(outcome["stdout"].as_str().unwrap().trim()).unwrap();
    assert_eq!(printed["passing"], 3, "{outcome}");
    eprintln!(
        "Saved {} with {}; answer: {answer}",
        card.title, detail["actions"][0]["script"]
    );
}

/// A chat shows a page it wrote through its call of the show_artifact dynamic tool, which reads
/// the file where the chat runs and answers with the page as the viewer renders it: screenshots
/// as image items and the problems the preview found (a page too wide for a phone here).
#[tokio::test]
#[ignore = "Opt-in installed Codex CLI test; uses subscription capacity, a model's tool choice and Edge or Chrome."]
async fn installed_codex_shows_an_artifact_and_reads_its_preview() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let page = root.path().join("probe.html");
    std::fs::write(&page, "<!doctype html><html><head><title>Probe page</title><style>body{margin:0;background:#fff;color:#111;font:16px system-ui}.wide{width:700px;height:40px;background:#c4e88c}</style></head><body><h1>Probe page</h1><div class=\"wide\"></div></body></html>").unwrap();
    let text = format!("This is an Agent Studio integration test. Call the show_artifact tool once with id probe, title Probe page and path {}. Run no command and change no file. Reply with one sentence naming the problems the preview reported, followed by <!-- artifact:probe --> on its own line.", page.display());
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"","reasoning":"low","instructions":""},"messages":[{"role":"user","text":text}]})).unwrap();
    request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    request.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
    let exe = crate::providers::resolve("codex").await.unwrap();
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let mut process = Process::new(
        exe,
        command.spawn().unwrap(),
        "real-artifact-test".into(),
        String::new(),
    )
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
    .expect("Installed CLI test timed out");
    process.kill().await;
    drop(channel);
    let mut events = vec![];
    while let Ok(event) = received.try_recv() {
        events.push(event);
    }
    let (status, answer) = result.expect("Installed CLI failed");
    assert_eq!(status, "complete");
    let artifact = events
        .iter()
        .find_map(|event| match event {
            RunEvent::Artifact { artifact } => Some(artifact.clone()),
            _ => None,
        })
        .expect("Codex showed no artifact");
    assert_eq!(artifact.id, "probe");
    assert!(artifact.source.contains("<h1>Probe page</h1>"));
    assert!(answer.contains("<!-- artifact:probe -->"), "{answer}");
    let told = answer.to_lowercase();
    assert!(
        told.contains("sideways") || told.contains("scroll") || told.contains("wide"),
        "{answer}"
    );
    eprintln!("Answer: {answer}");
}

/// A chat compares two files through its call of the compare_files dynamic tool, which checks
/// both where the chat runs and records them as one comparison, each file with its label.
#[tokio::test]
#[ignore = "Opt-in installed Codex CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_codex_compares_two_files_side_by_side() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let [before, after] = [("before.png", 4, 3), ("after.png", 8, 6)].map(|(name, w, h)| {
        let path = root.path().join(name);
        crate::providers::sent_files::test_png(&path, w, h);
        path.display().to_string()
    });
    let text = format!("This is an Agent Studio integration test. Call the compare_files tool once with id pair, the two files {before} and {after} in that order, and the labels Before and After. Run no command and change no file. Reply with one short sentence followed by <!-- files:pair --> on its own line.");
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"","reasoning":"low","instructions":""},"messages":[{"role":"user","text":text}]})).unwrap();
    request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    request.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
    let exe = crate::providers::resolve("codex").await.unwrap();
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let mut process = Process::new(
        exe,
        command.spawn().unwrap(),
        "real-compare-test".into(),
        String::new(),
    )
    .unwrap();
    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| {
        let _ = tx.send(event);
        Ok(())
    })
    .with_outputs(crate::tool_output::Recorder::detached(&request.run_id));
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(300),
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
    .expect("Installed CLI test timed out");
    process.kill().await;
    drop(channel);
    let mut events = vec![];
    while let Ok(event) = received.try_recv() {
        events.push(event);
    }
    let (status, answer) = result.expect("Installed CLI failed");
    assert_eq!(status, "complete");
    let shown = events
        .iter()
        .find_map(|event| match event {
            RunEvent::SentFiles { sent_files } => Some(sent_files.clone()),
            _ => None,
        })
        .expect("Codex compared no files");
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

/// An orchestrator's Codex thread starts with the workflow tools as dynamic tools, and its calls
/// reach this computer's window, here a stand-in, whose answers reach the model.
#[tokio::test]
#[ignore = "Opt-in installed Codex CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_codex_answers_workflow_tools_through_the_window() {
    use crate::providers::workflow_calls::{Binding, Call, Context};
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let text = "This is an Agent Studio integration test. Call the workflow_list tool once, then call the dynamic_state tool once. Run no other tool and no command. Then reply with one short sentence naming the workflow and the mission title they report.";
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"","reasoning":"low","instructions":""},"messages":[{"role":"user","text":text}]})).unwrap();
    request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    let mission = Binding {
        run_id: uuid::Uuid::new_v4().to_string(),
        role: "orchestrator".into(),
    };
    request.mission = Some(mission.clone());
    request.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
    let exe = crate::providers::resolve("codex").await.unwrap();
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let mut process = Process::new(
        exe,
        command.spawn().unwrap(),
        "real-workflow-test".into(),
        String::new(),
    )
    .unwrap();
    let channel = EventSink::new(|_| Ok(()));
    let hub = Questions::default();
    let mut questions = hub.open(&request.run_id, None, channel.clone()).unwrap();
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
                tools.push(call.tool.clone());
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
    .expect("Installed CLI test timed out");
    process.kill().await;
    drop(questions);
    let (status, answer) = result.expect("Installed CLI failed");
    let tools = tokio::time::timeout(Duration::from_secs(5), window)
        .await
        .ok()
        .and_then(|t| t.ok())
        .unwrap_or_default();
    assert_eq!(status, "complete");
    assert!(tools.contains(&"workflow_list".to_string()), "{tools:?}");
    assert!(tools.contains(&"dynamic_state".to_string()), "{tools:?}");
    assert!(answer.contains("Nightly report"), "{answer}");
    assert!(answer.contains("Probe mission"), "{answer}");
    eprintln!("Tools {tools:?}; answer: {answer}");
}

/// A rewound Codex chat and a new fork go on with what their thread held through the reply they
/// follow: output only a command returned, deleted since, none of what came later, also from
/// before a compaction; and Agent Studio's tools stay theirs.
#[tokio::test]
#[ignore = "Opt-in installed Codex CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_codex_rewinds_and_forks_keep_their_native_context() {
    const CODEWORD: &str = "MARIGOLD-7741";
    const ASK: &str = "Run no command. On one line: what word did notes.txt print earlier, what fruit and what vegetable did I ask you to remember? Say none for what you have no record of.";
    let folder = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let notes = folder.path().join("notes.txt");
    std::fs::write(&notes, format!("Today's word is {CODEWORD}.\n")).unwrap();
    let cwd = folder.path().to_string_lossy().into_owned();
    let exe = crate::providers::resolve("codex").await.unwrap();
    let (computer, environment) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let location = json!({"computerId":computer,"environmentId":environment,"path":cwd});
    let conversation = uuid::Uuid::new_v4().to_string();
    let request = |run: &str, revision: u64, messages: &serde_json::Value| -> RunRequest {
        serde_json::from_value(json!({"runId":run,"conversationId":conversation,
            "historyRevision":revision,"location":location,
            "agent":{"provider":"codex","model":"gpt-5.6-luna","reasoning":"low","instructions":""},
            "messages":messages}))
        .unwrap()
    };
    let prepare = |mut request: RunRequest| {
        let (root, cwd) = (root.path().to_path_buf(), cwd.clone());
        async move {
            let mut session = crate::providers::sessions::Session::prepare(&root, &request)
                .unwrap()
                .unwrap();
            session.fork_here(&request).await;
            session.set_fork_folder(Some(cwd));
            request.native_session = Some(session);
            request
        }
    };
    let reply = |request: RunRequest| {
        let (exe, runtime, cwd) = (exe.clone(), runtime.clone(), cwd.clone());
        async move {
            let mut command = crate::providers::chat_command(&request, &runtime, &exe)
                .await
                .unwrap();
            let mut process = Process::new(
                exe,
                command.spawn().unwrap(),
                "rewind".into(),
                String::new(),
            )
            .unwrap();
            let (tx, _received) = tokio::sync::mpsc::unbounded_channel();
            let channel = EventSink::new(move |event| {
                let _ = tx.send(event);
                Ok(())
            });
            let mut questions = Questions::default()
                .open(&request.run_id, None, channel.clone())
                .unwrap();
            let result = tokio::time::timeout(
                Duration::from_secs(300),
                run(
                    &mut process,
                    &request,
                    Some(&channel),
                    CancellationToken::new(),
                    &mut questions,
                    Some(&cwd),
                    false,
                ),
            )
            .await
            .expect("Installed CLI test timed out");
            let (status, text) = result.expect("Installed CLI failed");
            assert_eq!(status, "complete", "{text}");
            (text, process)
        }
    };
    let say = |role: &str, text: &str| json!({"role":role,"text":text});
    let new_run = || uuid::Uuid::new_v4().to_string();
    let bound = |conversation: &str| -> String {
        let bytes = std::fs::read(
            root.path()
                .join("native-sessions")
                .join(format!("{conversation}.json")),
        )
        .unwrap();
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let mut threads = Vec::new();

    let read_it = "Run a command that prints notes.txt, then reply with only the word DONE.";
    let run1 = new_run();
    let mut messages = vec![say("user", read_it)];
    let (first_answer, mut process) =
        reply(prepare(request(&run1, 0, &json!(messages))).await).await;
    process.kill().await;
    std::fs::remove_file(&notes).unwrap();
    let original = bound(&conversation);
    threads.push(original.clone());
    let profile = crate::context::native_profile_root("codex").await.unwrap();
    let rollout = |thread: &str| -> String {
        std::fs::read_to_string(
            crate::native_instructions::find_record(&profile, "codex", thread)
                .unwrap()
                .expect("A saved rollout"),
        )
        .unwrap()
    };
    assert!(
        rollout(&original).contains(CODEWORD),
        "The command printed it"
    );
    messages.push(say("assistant", &first_answer));
    let kept = messages.clone();
    messages.push(say(
        "user",
        "Remember the fruit PAPAYA-2093. Reply only OK.",
    ));
    let (_, mut process) = reply(prepare(request(&new_run(), 0, &json!(messages))).await).await;
    process.kill().await;
    assert_eq!(bound(&conversation), original, "A follow-up resumes");

    // Rewound to before the fruit, with a new question.
    let mut messages = kept;
    messages.push(say("user", ASK));
    let mut rewound = request(&new_run(), 1, &json!(messages));
    rewound.rewound = true;
    rewound.last_reply = serde_json::from_value(json!({"runId":run1})).unwrap();
    let rewound = prepare(rewound).await;
    let session = rewound.native_session.as_ref().unwrap();
    assert!(session.resumed && session.native_fork.is_some());
    let ask_run = rewound.run_id.clone();
    let (answer, mut process) = reply(rewound).await;
    process.kill().await;
    eprintln!("After the rewind: {answer}");
    assert!(answer.contains(CODEWORD), "{answer}");
    assert!(!answer.contains("PAPAYA-2093"), "{answer}");
    let forked = bound(&conversation);
    assert_ne!(forked, original, "The rewound chat has a thread of its own");
    threads.push(forked.clone());

    // A compaction and a later message, then a rewind to before the compaction.
    messages.push(say("assistant", &answer));
    let before_compaction = messages.clone();
    messages.push(say("user", "/compact"));
    let mut compact = request(&new_run(), 1, &json!(messages));
    compact.compact = true;
    let (_, mut process) = reply(prepare(compact).await).await;
    process.kill().await;
    messages.push(say("assistant", "Compacted"));
    messages.push(say(
        "user",
        "Remember the vegetable OKRA-5512. Reply only OK.",
    ));
    let (_, mut process) = reply(prepare(request(&new_run(), 1, &json!(messages))).await).await;
    process.kill().await;
    assert_eq!(bound(&conversation), forked);
    let mut messages = before_compaction;
    messages.push(say("user", ASK));
    let mut uncompacted = request(&new_run(), 2, &json!(messages));
    uncompacted.rewound = true;
    uncompacted.last_reply = serde_json::from_value(json!({"runId":ask_run})).unwrap();
    let uncompacted = prepare(uncompacted).await;
    let second_ask = uncompacted.run_id.clone();
    let (answer, mut process) = reply(uncompacted).await;
    process.kill().await;
    eprintln!("From before the compaction: {answer}");
    assert!(answer.contains(CODEWORD), "{answer}");
    assert!(!answer.contains("OKRA-5512"), "{answer}");
    threads.push(bound(&conversation));

    // A fork of the chat keeps the codeword and Agent Studio's own tools.
    messages.push(say("assistant", &answer));
    let fork_id = uuid::Uuid::new_v4().to_string();
    messages.push(say("user", "Run no command. On one line: what word did notes.txt print earlier, and is a tool named studio_ask_user available to you, yes or no?"));
    let mut fork = request(&new_run(), 0, &json!(messages));
    fork.conversation_id = Some(fork_id.clone());
    fork.forked = true;
    fork.forked_from = vec![conversation.clone()];
    fork.last_reply = serde_json::from_value(json!({"runId":second_ask})).unwrap();
    let fork = prepare(fork).await;
    assert!(fork.native_session.as_ref().unwrap().native_fork.is_some());
    let (answer, mut process) = reply(fork).await;
    eprintln!("In the fork: {answer}");
    assert!(answer.contains(CODEWORD), "{answer}");
    assert!(answer.to_lowercase().contains("yes"), "{answer}");
    threads.push(bound(&fork_id));

    // Newest first, since a fork's history names the thread it came from.
    for thread in threads.iter().rev() {
        let deleted =
            crate::plugins::rpc(&mut process, "thread/delete", json!({"threadId":thread})).await;
        eprintln!("Deleted {thread}: {:?}", deleted.map(|_| "ok"));
    }
    process.kill().await;
}
