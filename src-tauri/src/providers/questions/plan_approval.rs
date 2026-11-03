//! Native plan-mode decisions use the existing authenticated question channel,
//! with a strict two-action contract and no caller-supplied permission rules.
use super::*;

#[derive(Clone, Debug, Serialize)]
pub struct PlanApproval {
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}
#[derive(Default)]
pub(super) struct Tracker {
    parents: HashMap<String, (String, Value)>,
}
pub(super) fn response(value: &Value, answer: Option<&Answer>, error: Option<&str>) -> Value {
    let approved = error.is_none()
        && answer.is_some_and(|a| {
            !a.skipped
                && a.answers.len() == 1
                && a.answers[0].id == "approval"
                && a.answers[0].values == ["Approve"]
        });
    let result = if approved {
        json!({"behavior":"allow","updatedInput":value["request"]["input"],
            "updatedPermissions":[{"type":"setMode","mode":if value["request"]["tool_name"] == "EnterPlanMode" {"plan"} else {"bypassPermissions"},"destination":"session"}]})
    } else {
        json!({"behavior":"deny","message":error.unwrap_or("The user declined this plan-mode change. Do not implement the plan. Ask for feedback or continue planning.")})
    };
    json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":result}})
}
/// Answers a permission request for a tool that no plan decision or question took. Claude Code
/// asks while planning, but also with permissions bypassed: its critical-path check wants a person
/// for `rm` on `$D/*.png`, `rm -rf *` or a top-level folder, and ask rules and hooks can ask too.
/// Nobody answers those prompts in a chat, so this stays aligned with Claude's desktop app, which
/// denies such a removal itself, and tells the agent what Claude Code tells it there (2.1.317).
/// The desktop path is not one a host can choose: the CLI keeps it for its first-party entrypoints.
/// Telling the agent the session was planning made it stop and ask the user to turn off a plan mode
/// that was never on.
pub fn refuse_tool(value: &Value, planning: bool) -> Value {
    let request = &value["request"];
    let reason = request["decision_reason"]
        .as_str()
        .map(str::trim)
        .filter(|reason| !reason.is_empty());
    let message = if planning {
        "This action requires permission that is unavailable in the current mode. While planning, propose the change and request ExitPlanMode approval before implementation.".to_string()
    } else if let Some(removal) = reason.filter(|reason| reason.starts_with("Dangerous rm")) {
        format!("{REMOVAL_REFUSED}{removal}")
    } else {
        let needed = reason
            .or(request["tool_name"].as_str())
            .unwrap_or("this tool use");
        format!("{NO_APPROVAL}{needed}")
    };
    json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":{"behavior":"deny","message":message}}})
}
const REMOVAL_REFUSED: &str = "Permission for this command was denied by a built-in Claude Code safety check, not by the user. The check stops removals that can delete far more than intended: a system, home or workspace directory, or a target it cannot resolve, such as a shell variable that, if unset or empty, turns this into `rm -rf /` or `rm -rf /*`. Only a person may approve such a removal, and no person did (no permission prompt was shown). The command was NOT run; do not claim it succeeded. Do not work around the check by splitting, scripting, or re-issuing the removal through another tool or shell: the check exists because a removal like this can destroy the user's data, and getting past it would not make it safe. If the text below suggests a safe rewrite, run that instead; it goes through the same check. Otherwise finish the rest of the task without this removal, tell the user what you wanted to delete and why, and leave the removal to them. What was flagged: ";
const NO_APPROVAL: &str = "Permission for this tool use was denied. It requires approval, and this session has no approval surface: nobody can answer a permission prompt here, so it was denied automatically. The action was NOT performed; do not claim it succeeded, and do not retry it: this action, and anything else that requires approval, will be denied the same way for the rest of this session. Tell the user what was blocked and why you needed it, then continue with the parts of the task that do not require approval. What required approval: ";
impl Session {
    pub(super) fn observe_plan(&mut self, value: &Value) {
        if value["type"] != "assistant" || !value["parent_tool_use_id"].is_null() {
            return;
        }
        for b in value["message"]["content"].as_array().into_iter().flatten() {
            if b["type"] != "tool_use"
                || !matches!(b["name"].as_str(), Some("EnterPlanMode" | "ExitPlanMode"))
            {
                continue;
            }
            if let Some(id) = b["id"].as_str().filter(|s| filled(s)) {
                if b["input"].is_object() {
                    self.approvals.parents.entry(id.into()).or_insert_with(|| {
                        (b["name"].as_str().unwrap().into(), b["input"].clone())
                    });
                }
            }
        }
    }
    pub fn claude_plan(&mut self, value: &Value, active: bool) -> Option<Option<Value>> {
        let r = &value["request"];
        if r["subtype"] != "can_use_tool"
            || !matches!(
                r["tool_name"].as_str(),
                Some("EnterPlanMode" | "ExitPlanMode")
            )
        {
            return None;
        }
        let invalid = |why: &str| Some(Some(response(value, None, Some(why))));
        let parent = r["tool_use_id"].as_str().and_then(|id| {
            self.approvals
                .parents
                .get(id)
                .filter(|(name, input)| {
                    r["tool_name"] == *name && r["input"] == *input && !self.consumed.contains(id)
                })
                .map(|_| id.to_owned())
        });
        if !active
            || parent.is_none()
            || !value["parent_tool_use_id"].is_null()
            || !value["request_id"].as_str().is_some_and(filled)
        {
            return invalid("Only a current parent plan-mode request can ask for approval.");
        }
        let id = parent.unwrap();
        self.consumed.insert(id);
        let exit = r["tool_name"] == "ExitPlanMode";
        let text = if exit {
            match r["input"]["plan"].as_str().filter(|s| filled(s)) {
                Some(text) => Some(text.to_owned()),
                None => return invalid("Include the complete proposed plan as text. Agent Studio cannot approve a missing plan or read a plan file path."),
            }
        } else {
            None
        };
        let request = Request {
            id: uuid::Uuid::new_v4().to_string(),
            revision: 1,
            status: "pending".into(),
            response: None,
            plan_approval: Some(PlanApproval {
                action: if exit { "exit" } else { "enter" }.into(),
                text,
            }),
            questions: vec![Question {
                id: "approval".into(),
                header: "Plan mode".into(),
                question: if exit {
                    "Approve this plan and allow implementation?"
                } else {
                    "Allow Claude to enter plan mode?"
                }
                .into(),
                options: vec![
                    OptionItem {
                        label: "Approve".into(),
                        description: String::new(),
                    },
                    OptionItem {
                        label: "Decline".into(),
                        description: String::new(),
                    },
                ],
                multi_select: false,
            }],
        };
        let Some(mut runs) = self.hub.0.lock().ok() else {
            return invalid("Plan approval is unavailable.");
        };
        let Some(run) = runs.get_mut(&self.run_id) else {
            return invalid("This run ended.");
        };
        run.entries.insert(
            request.id.clone(),
            Entry {
                request: request.clone(),
                wire: Wire::ClaudePlan(value.clone()),
                submitted: None,
            },
        );
        let _ = self.channel.send(RunEvent::Question {
            question: request,
            draft: None,
        });
        Some(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call(tool: &str, input: Value) -> Value {
        json!({"type":"control_request","request_id":"control","request":{"subtype":"can_use_tool","tool_name":tool,"tool_use_id":"tool","input":input}})
    }
    fn observed(session: &mut Session, call: &Value, child: bool) {
        session.observe_claude(&json!({"type":"assistant","parent_tool_use_id":if child {json!("child")} else {Value::Null},"message":{"content":[{"type":"tool_use","id":"tool","name":call["request"]["tool_name"],"input":call["request"]["input"]}]}}));
    }
    fn answer(q: &Request, value: &str) -> Answer {
        Answer {
            request_id: q.id.clone(),
            skipped: false,
            answers: vec![AnswerItem {
                id: "approval".into(),
                values: vec![value.into()],
            }],
        }
    }
    fn refusal(request: Value, planning: bool) -> String {
        let answer = refuse_tool(
            &json!({"type":"control_request","request_id":"asked","request":request}),
            planning,
        );
        assert_eq!(answer["response"]["request_id"], "asked");
        assert_eq!(answer["response"]["response"]["behavior"], "deny");
        answer["response"]["response"]["message"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    #[test]
    fn a_refused_tool_hears_what_claude_code_says_and_of_planning_only_while_planning() {
        // As Claude Code 2.1.317 asks under bypassed permissions: a removal reads as it does in
        // Claude's desktop app, with the reason that says how to rewrite it.
        let reason = "Dangerous rm operation on possibly-empty variable path: $D/*.png in `rm -f $D/*.png` (rewrite it as \"${D:?}\"/*.png or use a literal path)";
        let check = json!({"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -f $D/*.png"},"decision_reason":reason,"decision_reason_type":"safetyCheck","tool_use_id":"tool"});
        for build in [
            refusal(check.clone(), false),
            refusal(
                json!({"subtype":"can_use_tool","tool_name":"Bash","decision_reason":"Dangerous rmdir operation on critical path: /x"}),
                false,
            ),
        ] {
            assert!(build.contains("not by the user"), "{build}");
            assert!(build.contains("was NOT run"), "{build}");
            assert!(build.contains("Do not work around the check"), "{build}");
            assert!(build.contains("What was flagged: Dangerous rm"), "{build}");
            assert!(!build.contains("planning"), "{build}");
            assert!(!build.contains("ExitPlanMode"), "{build}");
        }
        assert!(refusal(check.clone(), false).ends_with(reason));
        // Anything else that asks reads as a session with no approval surface: a reason it gives,
        // or the tool when it gives none or an empty one, as a rule's does.
        for (request, needed) in [
            (
                json!({"subtype":"can_use_tool","tool_name":"Write","decision_reason":"Another check","decision_reason_type":"safetyCheck"}),
                "What required approval: Another check",
            ),
            (
                json!({"subtype":"can_use_tool","tool_name":"Bash","decision_reason_type":"rule"}),
                "What required approval: Bash",
            ),
            (
                json!({"subtype":"can_use_tool","tool_name":"Bash","decision_reason":"  "}),
                "What required approval: Bash",
            ),
        ] {
            let build = refusal(request, false);
            assert!(build.ends_with(needed), "{build}");
            assert!(build.contains("no approval surface"), "{build}");
            assert!(!build.contains("planning"), "{build}");
        }
        // Planning, the mode is the reason, whatever else the CLI reports.
        for request in [
            check,
            json!({"subtype":"can_use_tool","tool_name":"Write","decision_reason_type":"mode"}),
        ] {
            let planning = refusal(request, true);
            assert!(planning.contains("While planning"), "{planning}");
            assert!(planning.contains("ExitPlanMode"));
        }
    }
    #[tokio::test]
    async fn native_plan_approval_is_explicit_scoped_and_preserves_exact_input() {
        for tool in ["EnterPlanMode", "ExitPlanMode"] {
            let hub = Questions::default();
            let (tx, mut events) = mpsc::unbounded_channel();
            let mut s = hub
                .open(
                    "run",
                    Some("connection".into()),
                    EventSink::new(move |e| tx.send(e).map_err(|e| e.to_string())),
                )
                .unwrap();
            let input = if tool == "ExitPlanMode" {
                json!({"plan":"# Complete plan","planFilePath":"private-native-path","allowedPrompts":[{"tool":"Bash","prompt":"arbitrary"}]})
            } else {
                json!({})
            };
            let call = call(tool, input.clone());
            observed(&mut s, &call, false);
            assert!(s.claude_plan(&call, true).unwrap().is_none());
            let RunEvent::Question { question: q, .. } = events.recv().await.unwrap() else {
                panic!("approval")
            };
            assert!(!serde_json::to_string(&q)
                .unwrap()
                .contains("private-native-path"));
            assert!(!serde_json::to_string(&q)
                .unwrap()
                .contains("allowedPrompts"));
            assert!(s.rx.try_recv().is_err(), "receipt must never auto approve");
            assert!(hub
                .answer("run", Some("foreign"), answer(&q, "Approve"))
                .await
                .is_err());
            assert!(hub
                .answer("run", Some("connection"), answer(&q, "yes"))
                .await
                .is_err());
            let h = hub.clone();
            let a = answer(&q, "Approve");
            let pending = tokio::spawn(async move { h.answer("run", Some("connection"), a).await });
            let delivery = s.rx.recv().await.unwrap();
            assert!(s.can_deliver(&delivery));
            let wire = &delivery.payload["response"]["response"];
            assert_eq!(wire["behavior"], "allow");
            assert_eq!(wire["updatedInput"], input);
            assert_eq!(
                wire["updatedPermissions"],
                json!([{"type":"setMode","mode":if tool=="EnterPlanMode" {"plan"} else {"bypassPermissions"},"destination":"session"}])
            );
            s.delivered(delivery, Ok(()));
            assert!(pending.await.unwrap().is_ok());
            assert!(
                s.claude_plan(&call, true).unwrap().is_some(),
                "duplicate tool request rejected"
            );
            assert!(hub
                .answer("run", Some("connection"), answer(&q, "Decline"))
                .await
                .is_err());
        }
    }
    #[tokio::test]
    async fn withdrawal_and_stop_reject_queued_approval() {
        for stop in [false, true] {
            let hub = Questions::default();
            let mut s = hub.open("run", None, EventSink::new(|_| Ok(()))).unwrap();
            let c = call("ExitPlanMode", json!({"plan":"Review me"}));
            observed(&mut s, &c, false);
            assert!(s.claude_plan(&c, true).unwrap().is_none());
            let q = hub.0.lock().unwrap()["run"]
                .entries
                .values()
                .next()
                .unwrap()
                .request
                .clone();
            let h = hub.clone();
            let a = answer(&q, "Approve");
            let pending = tokio::spawn(async move { h.answer("run", None, a).await });
            let delivery = s.rx.recv().await.unwrap();
            if stop {
                s.close();
            } else {
                s.observe_claude(&json!({"type":"control_cancel_request","request_id":"control"}));
            }
            assert!(!s.can_deliver(&delivery));
            s.delivered(delivery, Err("Closed".into()));
            assert!(pending.await.unwrap().is_err());
            assert!(hub
                .answer("run", None, answer(&q, "Approve"))
                .await
                .is_err());
        }
    }
    #[test]
    fn child_foreign_inactive_and_malformed_plans_fail_closed() {
        for (child, active, input) in [
            (true, true, json!({"plan":"x"})),
            (false, false, json!({"plan":"x"})),
            (false, true, json!({"planFilePath":"do-not-read"})),
        ] {
            let hub = Questions::default();
            let mut s = hub.open("run", None, EventSink::new(|_| Ok(()))).unwrap();
            let c = call("ExitPlanMode", input);
            observed(&mut s, &c, child);
            assert_eq!(
                s.claude_plan(&c, active).unwrap().unwrap()["response"]["response"]["behavior"],
                "deny"
            );
        }
        let c = call("ExitPlanMode", json!({"plan":"x"}));
        assert_eq!(
            response(&c, None, None)["response"]["response"]["behavior"],
            "deny"
        );
        // A plan of any length asks for approval, past the 24 KB earlier releases showed.
        let hub = Questions::default();
        let mut s = hub.open("run", None, EventSink::new(|_| Ok(()))).unwrap();
        let c = call("ExitPlanMode", json!({"plan":"x".repeat(100_000)}));
        observed(&mut s, &c, false);
        assert!(s.claude_plan(&c, true).unwrap().is_none());
        assert!(s.pending());
    }
}
