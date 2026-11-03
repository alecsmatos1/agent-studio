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
/// asks while planning, but also with permissions bypassed: its safety checks want a person for
/// `rm` on a variable path or a write under a Windows short name, as ask rules and hooks can. Nobody
/// answers those prompts in a chat, so the agent gets Claude Code's own reason, which often says
/// how to write the call. Telling it the session was planning made it stop and ask the user to
/// turn off a plan mode that was never on.
pub fn refuse_tool(value: &Value, planning: bool) -> Value {
    let reason = value["request"]["decision_reason"]
        .as_str()
        .map(str::trim)
        .filter(|reason| !reason.is_empty());
    let message = match (planning, reason) {
        (true, _) => "This action requires permission that is unavailable in the current mode. While planning, propose the change and request ExitPlanMode approval before implementation.".to_string(),
        (false, Some(reason)) => format!("{ASKS_A_PERSON} Claude Code's reason: {reason}\nCorrect the call if that reason shows how. Otherwise leave it undone, without another route to the same effect, finish the rest of the work and tell the user what it needed."),
        (false, None) => format!("{ASKS_A_PERSON}\nLeave the call undone, without another route to the same effect, finish the rest of the work and tell the user what it needed."),
    };
    json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":{"behavior":"deny","message":message}}})
}
const ASKS_A_PERSON: &str = "Claude Code asks for a person's approval before this call, and Agent Studio does not give that approval, so the call did not run. The session's permission mode has not changed.";
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
    fn a_refused_tool_hears_claude_codes_reason_and_of_planning_only_while_planning() {
        // As Claude Code 2.1.317 asks under bypassed permissions.
        let reason = "Dangerous rm operation on possibly-empty variable path: $D/*.png in `rm -f $D/*.png` (rewrite it as \"${D:?}\"/*.png or use a literal path)";
        let check = json!({"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -f $D/*.png"},"decision_reason":reason,"decision_reason_type":"safetyCheck","tool_use_id":"tool"});
        let build = refusal(check.clone(), false);
        assert!(build.contains(reason), "{build}");
        assert!(build.contains("has not changed"));
        assert!(!build.contains("planning"), "{build}");
        assert!(!build.contains("ExitPlanMode"), "{build}");
        // A request without a reason, as a rule's or an older CLI's, or with an empty one.
        for request in [
            json!({"subtype":"can_use_tool","tool_name":"Bash","decision_reason_type":"rule"}),
            json!({"subtype":"can_use_tool","tool_name":"Bash","decision_reason":"  "}),
        ] {
            let build = refusal(request, false);
            assert!(!build.contains("reason"), "{build}");
            assert!(build.contains("did not run"));
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
