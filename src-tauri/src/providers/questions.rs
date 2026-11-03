//! Run-owned questions. Only an explicit answer command can resolve a pending call;
//! checkpoints and provider text can never submit an answer.
use crate::{protocol::RunEvent, runner::EventSink};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, oneshot};
mod draft;
mod plan_approval;
pub use draft::Draft;
pub use plan_approval::{refuse_tool, PlanApproval};

pub const GUIDANCE: &str = "When you need clarification or a decision from the user, call studio_ask_user (Claude: mcp__agent_studio__studio_ask_user). Ask concise questions with stable ids and optional choices. Set multiSelect=false for one answer (radio buttons), or true only when multiple answers are allowed (checkboxes), independently for each question. Multiple questions do not imply multiple answers per question. The tool waits for explicitly submitted answers or a skip; never assume a default was accepted. Use it only in the parent conversation. Do not request passwords, tokens or other secrets. Native request_user_input and AskUserQuestion are also supported.";
pub fn tool() -> Value {
    json!({"name":"studio_ask_user","description":GUIDANCE,"inputSchema":{
        "type":"object","properties":{"questions":{"type":"array","minItems":1,"items":{
            "type":"object","properties":{
                "id":{"type":"string","minLength":1},
                "header":{"type":"string"},
                "question":{"type":"string","minLength":1},
                "multiSelect":{"type":"boolean","description":"false: choose one answer using radio buttons. true: choose multiple answers using checkboxes. Set per question, regardless of how many questions are in this call."},
                "options":{"type":"array","items":{"type":"object","properties":{
                    "label":{"type":"string","minLength":1},"description":{"type":"string"}
                },"required":["label","description"],"additionalProperties":false}}
            },"required":["id","header","question","options","multiSelect"],"additionalProperties":false
        }}},"required":["questions"],"additionalProperties":false}})
}
pub fn codex_tool() -> Value {
    let mut value = tool();
    value["type"] = json!("function");
    value["deferLoading"] = json!(false);
    value
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct OptionItem {
    pub label: String,
    #[serde(default)]
    pub description: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<OptionItem>,
    pub multi_select: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AnswerItem {
    pub id: String,
    pub values: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Answer {
    pub request_id: String,
    pub answers: Vec<AnswerItem>,
    #[serde(default)]
    pub skipped: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct Request {
    pub id: String,
    pub revision: u64,
    pub status: String,
    pub questions: Vec<Question>,
    #[serde(rename = "planApproval", skip_serializing_if = "Option::is_none")]
    pub plan_approval: Option<PlanApproval>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<Answer>,
}
/// Text with something in it and no NUL character.
fn filled(s: &str) -> bool {
    !s.trim().is_empty() && !s.contains('\0')
}
fn parse(args: &Value, native_claude: bool) -> Result<Vec<Question>, &'static str> {
    let invalid = "Questions must contain unique ids, text, and distinct choices. Secret input is unavailable.";
    let items = args["questions"].as_array().ok_or(invalid)?;
    if items.is_empty() {
        return Err(invalid);
    }
    let mut result = vec![];
    let mut ids = HashSet::new();
    let mut labels = HashSet::new();
    for (index, item) in items.iter().enumerate() {
        if item["isSecret"] == true {
            return Err(invalid);
        }
        let question = item["question"]
            .as_str()
            .filter(|s| filled(s))
            .ok_or(invalid)?;
        let id = if native_claude {
            format!("q{}", index + 1)
        } else {
            item["id"]
                .as_str()
                .filter(|s| filled(s))
                .ok_or(invalid)?
                .into()
        };
        if !ids.insert(id.clone()) || (native_claude && !labels.insert(question)) {
            return Err(invalid);
        }
        let header = item["header"].as_str().unwrap_or_default();
        let options: Vec<OptionItem> = if item["options"].is_null() {
            vec![]
        } else {
            serde_json::from_value(item["options"].clone()).map_err(|_| invalid)?
        };
        if options
            .iter()
            .map(|o| &o.label)
            .collect::<HashSet<_>>()
            .len()
            != options.len()
            || options.iter().any(|o| !filled(&o.label))
        {
            return Err(invalid);
        }
        result.push(Question {
            id,
            header: header.into(),
            question: question.into(),
            options,
            multi_select: item["multiSelect"].as_bool().unwrap_or(false),
        });
    }
    Ok(result)
}
fn valid_answer(request: &Request, answer: &Answer) -> bool {
    if answer.request_id != request.id {
        return false;
    }
    if answer.skipped {
        return answer.answers.is_empty();
    }
    if request.plan_approval.is_some() {
        return answer.answers.len() == 1
            && answer.answers[0].id == "approval"
            && answer.answers[0].values.len() == 1
            && matches!(answer.answers[0].values[0].as_str(), "Approve" | "Decline");
    }
    answer.answers.len() == request.questions.len()
        && request.questions.iter().all(|q| {
            let Some(a) = answer.answers.iter().find(|a| a.id == q.id) else {
                return false;
            };
            // Choices of the question and, at most, one answer in the user's own words.
            !a.values.is_empty()
                && (q.multi_select || a.values.len() == 1)
                && a.values.iter().all(|v| filled(v))
                && a.values.iter().collect::<HashSet<_>>().len() == a.values.len()
                && a.values
                    .iter()
                    .filter(|v| !q.options.iter().any(|o| &o.label == *v))
                    .count()
                    <= 1
        })
}

#[derive(Clone)]
enum Wire {
    Codex(Value, bool),
    Claude(Value, bool),
    ClaudePlan(Value),
}
impl Wire {
    fn response(
        &self,
        request: Option<&Request>,
        answer: Option<&Answer>,
        error: Option<&str>,
    ) -> Value {
        let values: serde_json::Map<String, Value> = answer
            .into_iter()
            .flat_map(|a| &a.answers)
            .map(|a| (a.id.clone(), json!({"answers":a.values})))
            .collect();
        let result = json!({"answers":values,"skipped":answer.is_some_and(|a| a.skipped)});
        match self {
            Self::ClaudePlan(value) => plan_approval::response(value, answer, error),
            Self::Codex(value, dynamic) => {
                if *dynamic {
                    json!({"id":value["id"],"result":{"success":error.is_none(),"contentItems":[{"type":"inputText","text":error.map(String::from).unwrap_or_else(|| result.to_string())}]}})
                } else if let Some(error) = error {
                    json!({"id":value["id"],"error":{"code":-32602,"message":error}})
                } else {
                    json!({"id":value["id"],"result":{"answers":values}})
                }
            }
            Self::Claude(value, native) => {
                let response = if *native {
                    if error.is_some() || answer.is_some_and(|a| a.skipped) {
                        json!({"behavior":"deny","message":error.unwrap_or("The user skipped these questions. Continue without assuming an answer.")})
                    } else {
                        let mut input = value["request"]["input"].clone();
                        let answers: serde_json::Map<String, Value> = request
                            .into_iter()
                            .flat_map(|r| &r.questions)
                            .map(|q| {
                                let values = answer
                                    .unwrap()
                                    .answers
                                    .iter()
                                    .find(|a| a.id == q.id)
                                    .unwrap();
                                (q.question.clone(), json!(values.values.join(", ")))
                            })
                            .collect();
                        input["answers"] = json!(answers);
                        json!({"behavior":"allow","updatedInput":input})
                    }
                } else {
                    json!({"mcp_response":{"jsonrpc":"2.0","id":value["request"]["message"]["id"],"result":{"isError":error.is_some(),"content":[{"type":"text","text":error.map(String::from).unwrap_or_else(|| result.to_string())}]}}})
                };
                json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":response}})
            }
        }
    }
}
struct Entry {
    request: Request,
    wire: Wire,
    submitted: Option<Answer>,
}
struct Run {
    connection: Option<String>,
    entries: HashMap<String, Entry>,
    tx: mpsc::UnboundedSender<Delivery>,
}
#[derive(Default, Clone)]
pub struct Questions(
    Arc<Mutex<HashMap<String, Run>>>,
    pub super::steering::Hub,
    pub super::elicitation::Hub,
    pub super::take_over::Hub,
    pub super::workflow_calls::Hub,
);
pub struct Delivery {
    pub payload: Value,
    request: Request,
    ack: oneshot::Sender<Result<(), String>>,
}
pub struct Session {
    approvals: plan_approval::Tracker,
    drafts: draft::Drafts,
    pub steering: super::steering::Session,
    pub elicitation: super::elicitation::Session,
    pub take_over: super::take_over::Session,
    pub workflow: super::workflow_calls::Session,
    hub: Questions,
    run_id: String,
    channel: EventSink,
    pub rx: mpsc::UnboundedReceiver<Delivery>,
    parents: HashMap<String, Value>,
    consumed: HashSet<String>,
}
impl Questions {
    pub fn open(
        &self,
        run_id: &str,
        connection: Option<String>,
        channel: EventSink,
    ) -> Result<Session, String> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut runs = self
            .0
            .lock()
            .map_err(|_| "Question registry is unavailable")?;
        if runs.contains_key(run_id) {
            return Err("This run already exists".into());
        }
        runs.insert(
            run_id.into(),
            Run {
                connection: connection.clone(),
                entries: HashMap::new(),
                tx,
            },
        );
        Ok(Session {
            approvals: plan_approval::Tracker::default(),
            drafts: draft::Drafts::default(),
            elicitation: self.2.open(run_id, connection.clone(), channel.clone()),
            take_over: self.3.open(run_id, connection.clone()),
            workflow: self.4.open(run_id, connection.clone()),
            steering: self.1.open(run_id, connection, channel.clone()),
            hub: self.clone(),
            run_id: run_id.into(),
            channel,
            rx,
            parents: HashMap::new(),
            consumed: HashSet::new(),
        })
    }
    pub async fn answer(
        &self,
        run_id: &str,
        connection: Option<&str>,
        answer: Answer,
    ) -> Result<(), String> {
        let rx = {
            let mut runs = self
                .0
                .lock()
                .map_err(|_| "Question registry is unavailable")?;
            let run = runs
                .get_mut(run_id)
                .ok_or("This run is no longer waiting. Its answers were not sent.")?;
            if run.connection.as_deref() != connection {
                return Err("This question belongs to another connection.".into());
            }
            let entry = run
                .entries
                .get_mut(&answer.request_id)
                .ok_or("This question is no longer available.")?;
            if !valid_answer(&entry.request, &answer) {
                return Err(
                    "Answer every question with a choice or your own text, or skip the questions."
                        .into(),
                );
            }
            if entry.request.status == "answered"
                && entry.request.response.as_ref() == Some(&answer)
            {
                return Ok(());
            }
            if entry.request.status != "pending" || entry.submitted.is_some() {
                return Err("This question was already answered or is no longer waiting.".into());
            }
            let (tx, rx) = oneshot::channel();
            let payload = entry
                .wire
                .response(Some(&entry.request), Some(&answer), None);
            let mut request = entry.request.clone();
            request.status = "answered".into();
            request.revision = 2;
            request.response = Some(answer.clone());
            entry.submitted = Some(answer);
            run.tx
                .send(Delivery {
                    payload,
                    request,
                    ack: tx,
                })
                .map_err(|_| "The provider is no longer waiting.")?;
            rx
        };
        rx.await.map_err(|_| {
            "The run ended before confirming the answer. Check the saved reply.".to_string()
        })?
    }
}
impl Session {
    pub fn can_deliver(&self, delivery: &Delivery) -> bool {
        self.hub
            .0
            .lock()
            .ok()
            .and_then(|runs| {
                runs.get(&self.run_id)
                    .and_then(|r| r.entries.get(&delivery.request.id))
                    .map(|e| {
                        e.request.status == "pending" && e.submitted == delivery.request.response
                    })
            })
            .unwrap_or(false)
    }
    pub fn close(&self) {
        if let Ok(mut runs) = self.hub.0.lock() {
            if let Some(run) = runs.get_mut(&self.run_id) {
                for entry in run
                    .entries
                    .values_mut()
                    .filter(|e| e.request.status == "pending")
                {
                    entry.request.status = "cancelled".into();
                    entry.request.revision = 3;
                    let _ = self.channel.send(RunEvent::Question {
                        question: entry.request.clone(),
                        draft: None,
                    });
                }
            }
        }
    }
    #[cfg(test)]
    pub fn pending(&self) -> bool {
        self.hub
            .0
            .lock()
            .ok()
            .and_then(|runs| {
                runs.get(&self.run_id)
                    .map(|r| r.entries.values().any(|e| e.request.status == "pending"))
            })
            .unwrap_or(false)
    }
    pub fn delivered(&self, delivery: Delivery, result: Result<(), String>) {
        if result.is_ok() {
            if let Ok(mut runs) = self.hub.0.lock() {
                if let Some(entry) = runs
                    .get_mut(&self.run_id)
                    .and_then(|r| r.entries.get_mut(&delivery.request.id))
                {
                    entry.request = delivery.request.clone();
                }
            }
            let _ = self.channel.send(RunEvent::Question {
                question: delivery.request,
                draft: None,
            });
        }
        let _ = delivery.ack.send(result);
    }
    /// Records a question, or returns the provider's refusal. `draft` names the call whose
    /// draft the recorded question replaces.
    fn submit(
        &mut self,
        wire: Wire,
        args: &Value,
        native: bool,
        parent: bool,
        draft: Option<String>,
    ) -> Option<Value> {
        let parsed = if parent {
            parse(args, native)
        } else {
            Err("Only the parent conversation can ask the user questions.")
        };
        let questions = match parsed {
            Ok(q) => q,
            Err(e) => return Some(wire.response(None, None, Some(e))),
        };
        let request = Request {
            plan_approval: None,
            id: uuid::Uuid::new_v4().to_string(),
            revision: 1,
            status: "pending".into(),
            questions,
            response: None,
        };
        let mut runs = self.hub.0.lock().ok()?;
        let run = runs.get_mut(&self.run_id)?;
        run.entries.insert(
            request.id.clone(),
            Entry {
                request: request.clone(),
                wire,
                submitted: None,
            },
        );
        let _ = self.channel.send(RunEvent::Question {
            question: request,
            draft,
        });
        None
    }
    pub fn codex(&mut self, value: &Value, root: &str) -> Option<Option<Value>> {
        let p = &value["params"];
        let dynamic = value["method"] == "item/tool/call" && p["tool"] == "studio_ask_user";
        if !dynamic
            && value["method"] != "item/tool/requestUserInput"
            && value["method"] != "tool/requestUserInput"
        {
            return None;
        }
        let parent =
            !root.is_empty() && p["threadId"] == root && (!dynamic || p["namespace"].is_null());
        Some(self.submit(
            Wire::Codex(value.clone(), dynamic),
            if dynamic { &p["arguments"] } else { p },
            false,
            parent,
            None,
        ))
    }
    pub fn observe_claude(&mut self, value: &Value) {
        self.observe_plan(value);
        for draft in self.drafts.observe(value) {
            let _ = self.channel.send(RunEvent::QuestionDraft {
                question_draft: draft,
            });
        }
        if value["type"] == "control_cancel_request" {
            if let Ok(mut runs) = self.hub.0.lock() {
                if let Some(run) = runs.get_mut(&self.run_id) {
                    for entry in run.entries.values_mut() {
                        if matches!(&entry.wire, Wire::Claude(v, _) | Wire::ClaudePlan(v) if v["request_id"] == value["request_id"])
                            && entry.request.status == "pending"
                        {
                            entry.request.status = "cancelled".into();
                            entry.request.revision = 3;
                            let _ = self.channel.send(RunEvent::Question {
                                question: entry.request.clone(),
                                draft: None,
                            });
                        }
                    }
                }
            }
            return;
        }
        if value["type"] != "assistant" || !value["parent_tool_use_id"].is_null() {
            return;
        }
        for block in value["message"]["content"].as_array().into_iter().flatten() {
            if block["type"] == "tool_use"
                && matches!(
                    block["name"].as_str(),
                    Some("AskUserQuestion" | "mcp__agent_studio__studio_ask_user")
                )
            {
                if let Some(id) = block["id"].as_str().filter(|s| filled(s)) {
                    self.parents.insert(id.into(), block["input"].clone());
                }
            }
        }
    }
    pub fn claude(&mut self, value: &Value) -> Option<Option<Value>> {
        let r = &value["request"];
        let native = r["subtype"] == "can_use_tool" && r["tool_name"] == "AskUserQuestion";
        let mcp = r["subtype"] == "mcp_message"
            && r["server_name"] == "agent_studio"
            && r["message"]["method"] == "tools/call"
            && r["message"]["params"]["name"] == "studio_ask_user";
        if !native && !mcp {
            return None;
        }
        let args = if native {
            &r["input"]
        } else {
            &r["message"]["params"]["arguments"]
        };
        let parent = if native {
            r["tool_use_id"]
                .as_str()
                .filter(|id| self.parents.get(*id) == Some(args) && !self.consumed.contains(*id))
                .map(String::from)
        } else {
            self.parents
                .iter()
                .find(|(id, input)| *input == args && !self.consumed.contains(*id))
                .map(|(id, _)| id.clone())
        };
        if let Some(id) = &parent {
            self.consumed.insert(id.clone());
        }
        // The question replaces the draft its call wrote, in the same event; a refused call
        // closes its draft at once.
        let draft = parent.as_deref().and_then(|id| self.drafts.take(id));
        let response = self.submit(
            Wire::Claude(value.clone(), native),
            args,
            native,
            parent.is_some(),
            draft.as_ref().map(|d| d.id.clone()),
        );
        if let (Some(_), Some(draft)) = (&response, draft) {
            let _ = self.channel.send(RunEvent::QuestionDraft {
                question_draft: draft.closing(),
            });
        }
        Some(response)
    }
    pub fn resolved_codex(&self, value: &Value, root: &str) {
        if value["method"] != "serverRequest/resolved" || value["params"]["threadId"] != root {
            return;
        }
        if let Ok(mut runs) = self.hub.0.lock() {
            if let Some(run) = runs.get_mut(&self.run_id) {
                for entry in run.entries.values_mut() {
                    if matches!(&entry.wire, Wire::Codex(v, _) if v["id"] == value["params"]["requestId"])
                        && entry.request.status == "pending"
                    {
                        entry.request.status = "cancelled".into();
                        entry.request.revision = 3;
                        let _ = self.channel.send(RunEvent::Question {
                            question: entry.request.clone(),
                            draft: None,
                        });
                    }
                }
            }
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        if let Ok(mut runs) = self.hub.0.lock() {
            if let Some(run) = runs.remove(&self.run_id) {
                for mut entry in run
                    .entries
                    .into_values()
                    .filter(|e| e.request.status == "pending")
                {
                    entry.request.status = "cancelled".into();
                    entry.request.revision = 3;
                    let _ = self.channel.send(RunEvent::Question {
                        question: entry.request,
                        draft: None,
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args() -> Value {
        json!({"questions":[{"id":"format","header":"Format","question":"Choose format","options":[{"label":"Brief","description":"Short"},{"label":"Detailed","description":"Long"}],"multiSelect":false}]})
    }
    fn sink() -> EventSink {
        EventSink::new(|_| Ok(()))
    }
    fn pending(session: &Session) -> Request {
        session.hub.0.lock().unwrap()[&session.run_id]
            .entries
            .values()
            .next()
            .unwrap()
            .request
            .clone()
    }
    #[tokio::test]
    async fn answers_are_validated_bound_to_connection_and_delivered_once() {
        let hub = Questions::default();
        let mut session = hub.open("run", Some("connection".into()), sink()).unwrap();
        let call = json!({"id":19,"method":"item/tool/requestUserInput","params":{"threadId":"root","questions":args()["questions"]}});
        assert_eq!(session.codex(&call, "root"), Some(None));
        let request = pending(&session);
        let answer = Answer {
            request_id: request.id.clone(),
            skipped: false,
            answers: vec![AnswerItem {
                id: "format".into(),
                values: vec!["My own literal $(answer)".into()],
            }],
        };
        assert!(hub
            .answer("run", Some("other"), answer.clone())
            .await
            .is_err());
        let mut invalid = answer.clone();
        invalid.answers[0].id = "unknown".into();
        assert!(hub
            .answer("run", Some("connection"), invalid)
            .await
            .is_err());
        let answer2 = answer.clone();
        let (result, ()) = tokio::join!(
            hub.answer("run", Some("connection"), answer.clone()),
            async {
                let delivery = session.rx.recv().await.unwrap();
                assert_eq!(
                    delivery.payload,
                    json!({"id":19,"result":{"answers":{"format":{"answers":["My own literal $(answer)"]}}}})
                );
                assert!(hub
                    .answer("run", Some("connection"), answer2)
                    .await
                    .is_err());
                session.delivered(delivery, Ok(()));
            }
        );
        assert!(result.is_ok());
        assert!(!session.pending());
        assert!(hub
            .answer("run", Some("connection"), answer.clone())
            .await
            .is_ok());
        assert!(session.rx.try_recv().is_err());
        drop(session);
        assert!(hub.answer("run", Some("connection"), answer).await.is_err());
    }
    #[test]
    fn bounds_secret_fields_child_calls_and_resolved_requests_fail_closed() {
        let hub = Questions::default();
        let mut session = hub.open("run", None, sink()).unwrap();
        let mut call = json!({"id":"call","method":"item/tool/call","params":{"threadId":"child","tool":"studio_ask_user","arguments":args()}});
        assert_eq!(
            session.codex(&call, "root").unwrap().unwrap()["result"]["success"],
            false
        );
        call["params"]["threadId"] = json!("root");
        call["params"]["arguments"]["questions"][0]["isSecret"] = json!(true);
        assert!(session.codex(&call, "root").unwrap().is_some());
        call["params"]["arguments"] = args();
        assert_eq!(session.codex(&call, "root"), Some(None));
        assert!(session.pending());
        session.resolved_codex(&json!({"method":"serverRequest/resolved","params":{"threadId":"root","requestId":"call"}}), "root");
        assert!(!session.pending());
        let mut duplicates = args();
        duplicates["questions"]
            .as_array_mut()
            .unwrap()
            .push(args()["questions"][0].clone());
        assert!(parse(&duplicates, false).is_err());
        // Any number of questions and choices of any length, past the 4 questions of 2,000
        // characters with 12 choices earlier releases took.
        let many: Vec<Value> = (0..6)
            .map(|i| json!({"id":format!("q{i}"),"header":"h".repeat(150),"question":"a".repeat(3000),"options":(0..15).map(|o| json!({"label":format!("{o}{}", "l".repeat(250)),"description":"d".repeat(1500)})).collect::<Vec<_>>(),"multiSelect":true}))
            .collect();
        let parsed = parse(&json!({ "questions": many }), false).unwrap();
        assert_eq!((parsed.len(), parsed[5].options.len()), (6, 15));
    }
    #[tokio::test]
    async fn claude_native_and_sdk_tools_return_user_answers_without_approving_other_tools() {
        for native in [true, false] {
            let hub = Questions::default();
            let mut session = hub.open("run", None, sink()).unwrap();
            let input = args();
            session.observe_claude(&json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"parent-tool","name":if native {"AskUserQuestion"} else {"mcp__agent_studio__studio_ask_user"},"input":input}]}}));
            let request = if native {
                json!({"subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"parent-tool","input":input})
            } else {
                json!({"subtype":"mcp_message","server_name":"agent_studio","message":{"id":17,"method":"tools/call","params":{"name":"studio_ask_user","arguments":input}}})
            };
            let call = json!({"type":"control_request","request_id":"control-7","request":request});
            assert_eq!(session.claude(&call), Some(None));
            let question = pending(&session);
            let answer = Answer {
                request_id: question.id,
                answers: vec![AnswerItem {
                    id: if native { "q1" } else { "format" }.into(),
                    values: vec!["Brief".into()],
                }],
                skipped: false,
            };
            let (result, ()) = tokio::join!(hub.answer("run", None, answer), async {
                let delivery = session.rx.recv().await.unwrap();
                assert_eq!(delivery.payload["response"]["request_id"], "control-7");
                if native {
                    assert_eq!(
                        delivery.payload["response"]["response"]["updatedInput"]["answers"]
                            ["Choose format"],
                        "Brief"
                    );
                } else {
                    assert_eq!(
                        delivery.payload["response"]["response"]["mcp_response"]["id"],
                        17
                    );
                }
                session.delivered(delivery, Ok(()));
            });
            assert!(result.is_ok());
            assert!(
                session.claude(&call).unwrap().is_some(),
                "duplicate calls cannot ask again"
            );
            assert!(session
                .claude(&json!({"request":{"subtype":"can_use_tool","tool_name":"Bash"}}))
                .is_none());
        }
    }
    #[test]
    fn claude_shows_a_question_as_it_is_written_until_its_call_records_or_refuses_it() {
        let hub = Questions::default();
        let (tx, mut events) = mpsc::unbounded_channel();
        let mut session = hub
            .open(
                "run",
                None,
                EventSink::new(move |e| tx.send(e).map_err(|e| e.to_string())),
            )
            .unwrap();
        let stream =
            |event: Value| json!({"type":"stream_event","parent_tool_use_id":null,"event":event});
        let mut ask = |session: &mut Session, id: &str, input: &Value| {
            let text = input.to_string();
            let cut = text.find("Choose").map_or(text.len() / 2, |at| at + 3);
            session.observe_claude(&stream(json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":id,"name":"mcp__agent_studio__studio_ask_user","input":{}}})));
            for part in [&text[..cut], &text[cut..]] {
                session.observe_claude(&stream(json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":part}})));
            }
            // Claude Code 2.1.286 calls the tool before it ends the streamed block.
            session.observe_claude(&json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":id,"name":"mcp__agent_studio__studio_ask_user","input":input}]}}));
            let call = json!({"type":"control_request","request_id":id,"request":{"subtype":"mcp_message","server_name":"agent_studio","message":{"id":3,"method":"tools/call","params":{"name":"studio_ask_user","arguments":input}}}});
            let response = session.claude(&call).unwrap();
            session.observe_claude(&stream(json!({"type":"content_block_stop","index":0})));
            let mut seen = vec![];
            while let Ok(event) = events.try_recv() {
                seen.push(event);
            }
            (response, seen)
        };
        let (response, seen) = ask(&mut session, "asked", &args());
        assert!(response.is_none());
        let texts: Vec<String> = seen
            .iter()
            .filter_map(|e| match e {
                RunEvent::QuestionDraft { question_draft } => Some(
                    question_draft
                        .questions
                        .first()
                        .map(|q| q.question.clone())
                        .unwrap_or_default(),
                ),
                _ => None,
            })
            .collect();
        assert_eq!(texts, ["", "Cho", "Choose format"]);
        // The page reads these names.
        let wire = serde_json::to_value(&seen[2]).unwrap();
        assert_eq!(wire["kind"], "questiondraft");
        assert_eq!(wire["questionDraft"]["id"], "asked");
        assert_eq!(wire["questionDraft"]["questions"][0]["multiSelect"], false);
        assert!(wire["questionDraft"].get("closed").is_none());
        assert_eq!(
            serde_json::to_value(seen.last().unwrap()).unwrap()["draft"],
            "asked"
        );
        let Some(RunEvent::Question { question, draft }) = seen.last() else {
            panic!("the recorded question follows its drafts")
        };
        assert_eq!(
            (question.status.as_str(), draft.as_deref()),
            ("pending", Some("asked"))
        );
        // Invalid input is refused, and its draft closes with the refusal.
        let (response, seen) = ask(&mut session, "refused", &json!({"questions":[]}));
        assert!(response.is_some());
        let Some(RunEvent::QuestionDraft { question_draft }) = seen.last() else {
            panic!("the refused call closes its draft")
        };
        assert!(question_draft.closed && question_draft.id == "refused");
        assert!(!seen.iter().any(|e| matches!(e, RunEvent::Question { .. })));
    }
    #[test]
    fn multi_select_and_explicit_skip_are_preserved() {
        let mut request = Request {
            plan_approval: None,
            id: "request".into(),
            revision: 1,
            status: "pending".into(),
            questions: parse(&args(), false).unwrap(),
            response: None,
        };
        let mut answer = Answer {
            request_id: "request".into(),
            skipped: false,
            answers: vec![AnswerItem {
                id: "format".into(),
                values: vec!["Brief".into(), "Detailed".into()],
            }],
        };
        assert!(!valid_answer(&request, &answer));
        request.questions[0].multi_select = true;
        assert!(valid_answer(&request, &answer));
        answer.skipped = true;
        assert!(!valid_answer(&request, &answer));
        answer.answers.clear();
        assert!(valid_answer(&request, &answer));
        let wire = Wire::Claude(json!({"request_id":1}), true);
        assert_eq!(
            wire.response(Some(&request), Some(&answer), None)["response"]["response"]["behavior"],
            "deny"
        );
    }
    #[test]
    fn claude_cancelled_control_requests_close_only_the_matching_question() {
        let hub = Questions::default();
        let mut session = hub.open("run", None, sink()).unwrap();
        session.observe_claude(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool","name":"AskUserQuestion","input":args()}]}}));
        let call = json!({"type":"control_request","request_id":"control","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"tool","input":args()}});
        assert_eq!(session.claude(&call), Some(None));
        session.observe_claude(&json!({"type":"control_cancel_request","request_id":"other"}));
        assert!(session.pending());
        session.observe_claude(&json!({"type":"control_cancel_request","request_id":"control"}));
        assert!(!session.pending());
        assert_eq!(pending(&session).status, "cancelled");
    }
    #[tokio::test]
    async fn a_reply_takes_any_number_of_questions_and_answers_of_any_length() {
        use std::{
            future::Future,
            task::{Context, Poll, Waker},
        };
        // Past the 16 calls and 256 KB of questions and answers a reply earlier releases kept.
        let hub = Questions::default();
        let mut session = hub.open("run", None, sink()).unwrap();
        let questions: Vec<Value> = (0..4).map(|i| json!({"id":format!("q{i}"),"header":"","question":"q".repeat(2000),"options":[],"multiSelect":false})).collect();
        for id in 0..20 {
            assert_eq!(session.codex(&json!({"id":id,"method":"item/tool/requestUserInput","params":{"threadId":"root","questions":questions}}), "root"), Some(None));
        }
        let requests: Vec<Request> = hub.0.lock().unwrap()["run"]
            .entries
            .values()
            .map(|e| e.request.clone())
            .collect();
        let mut waiting = vec![];
        let mut rejected = 0;
        for request in requests {
            let answer = Answer {
                request_id: request.id,
                skipped: false,
                answers: request
                    .questions
                    .into_iter()
                    .map(|q| AnswerItem {
                        id: q.id,
                        values: vec!["a".repeat(5000)],
                    })
                    .collect(),
            };
            let mut future = Box::pin(hub.answer("run", None, answer));
            match future
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
            {
                Poll::Pending => waiting.push(future),
                Poll::Ready(result) => {
                    assert!(result.is_ok());
                    rejected += 1;
                }
            }
        }
        assert_eq!((rejected, waiting.len()), (0, 20));
        while let Ok(delivery) = session.rx.try_recv() {
            session.delivered(delivery, Ok(()));
        }
        for future in waiting {
            assert!(future.await.is_ok());
        }
    }
}
