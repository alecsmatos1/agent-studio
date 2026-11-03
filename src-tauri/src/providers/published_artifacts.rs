//! Artifacts a Claude reply publishes to claude.ai with Claude Code's own Artifact tools
//! (requested 2026-10-21, in place of Agent Studio's show_artifact for Claude chats). A headless
//! CLI offers those tools only when its launch sets `CLAUDE_CODE_ARTIFACT` (`ENV`), and publishes
//! with its own claude.ai login, so Agent Studio reads no credential. The reply keeps a card for
//! each artifact its parent calls published or opened, from the call's structured result: the
//! artifact's id, link and title, never the page. A new artifact and an open call also ask the
//! window that runs the reply to open the link, as the CLI's terminal opens the browser. A Claude
//! chat publishes its pages by default and works on top of them (`artifacts::guidance`). Each
//! reply counts its own revisions from one, so a later reply's card can read revision 1 of an
//! artifact already at 3 (`newestPage` in `src/lib/side-panels.ts`).
use crate::protocol::RunEvent;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// What a Claude chat's launch adds to its environment: the Artifact tools, which a headless
/// session leaves out unless asked (`sdk_default_off` in Claude Code 2.1.306), without the
/// automatic comment replies a parked process would make unseen.
pub const ENV: [(&str, &str); 2] = [
    ("CLAUDE_CODE_ARTIFACT", "1"),
    ("CLAUDE_CODE_ARTIFACT_COMMENTS_AUTOREACT", "0"),
];

/// The tool that publishes, opens and lists artifacts.
const TOOL: &str = "Artifact";

/// A claude.ai artifact as the saved reply keeps it (`src/lib/published-artifacts.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PublishedArtifact {
    pub id: String,
    pub revision: u64,
    pub url: String,
    pub title: String,
}

/// An artifact's own link on claude.ai: `/artifact/<short id>` or `/code/artifact/<uuid>`.
pub fn valid_url(url: &str) -> bool {
    if let Some(id) = url.strip_prefix("https://claude.ai/artifact/") {
        return id.len() == 22
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() && !b"0OIl".contains(&b));
    }
    url.strip_prefix("https://claude.ai/code/artifact/")
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok() && id.len() == 36)
}

/// The id an artifact's link carries: the UUID itself under `/code`, or written in base 58 in a
/// short link. Claude Code reports no `artifact_id` for a page it made from an Artifact type
/// (2.1.308 and 2.1.317), only the link.
fn link_id(url: &str) -> Option<String> {
    if let Some(short) = url.strip_prefix("https://claude.ai/artifact/") {
        const DIGITS: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        let mut value = 0u128;
        for byte in short.bytes() {
            let digit = DIGITS.iter().position(|digit| *digit == byte)?;
            value = value.checked_mul(58)?.checked_add(digit as u128)?;
        }
        return Some(uuid::Uuid::from_u128(value).to_string());
    }
    url.strip_prefix("https://claude.ai/code/artifact/")
        .map(str::to_ascii_lowercase)
}

/// The cards of one reply, from its parent's Artifact calls.
#[derive(Default)]
pub struct PublishedArtifacts {
    /// Each parent call by id, with the action it asked for.
    calls: HashMap<String, String>,
    cards: Vec<PublishedArtifact>,
    /// Pages made from an Artifact type that open on their first write, so the reader does not
    /// first see them empty.
    opens_on_write: HashSet<String>,
}
impl PublishedArtifacts {
    /// Whether this reply published or opened an artifact, so a card alone is a complete answer.
    pub fn has_artifacts(&self) -> bool {
        !self.cards.is_empty()
    }
    /// Claude reports a parent call before it runs and its result, with the tool's structured
    /// answer beside it, when it finishes. Only successful results make a card.
    pub fn observe_claude(&mut self, value: &Value) -> Vec<RunEvent> {
        if !value["parent_tool_use_id"].is_null() {
            return vec![];
        }
        let Some(blocks) = value["message"]["content"].as_array() else {
            return vec![];
        };
        if value["type"] == "assistant" {
            for block in blocks {
                if block["type"] == "tool_use" && block["name"] == TOOL {
                    if let Some(id) = block["id"].as_str() {
                        let action = block["input"]["action"].as_str().unwrap_or("publish");
                        self.calls.insert(id.into(), action.into());
                    }
                }
            }
            return vec![];
        }
        // Each result line answers one call; the structured answer belongs to that one alone.
        let results: Vec<_> = blocks
            .iter()
            .filter(|b| b["type"] == "tool_result")
            .collect();
        if value["type"] != "user" || results.len() != 1 {
            return vec![];
        }
        let block = results[0];
        let Some(action) = block["tool_use_id"]
            .as_str()
            .and_then(|id| self.calls.remove(id))
        else {
            return vec![];
        };
        if block["is_error"] == true {
            return vec![];
        }
        self.card(&action, &value["tool_use_result"])
            .into_iter()
            .collect()
    }
    fn card(&mut self, action: &str, result: &Value) -> Option<RunEvent> {
        let url = result["url"].as_str().filter(|url| valid_url(url))?;
        let id = match result.get("artifact_id") {
            Some(id) => id
                .as_str()
                .filter(|id| uuid::Uuid::parse_str(id).is_ok() && id.len() == 36)?
                .to_ascii_lowercase(),
            None => link_id(url)?,
        };
        // A new artifact opens, as the CLI's own first publish does; so does an open call. One made
        // from a type may ask to open on its first write instead, and one that already existed
        // is not new.
        let open = match action {
            "publish" if result["auto_open"] == "after_first_write" => {
                self.opens_on_write.insert(id.clone());
                false
            }
            "publish" if result["already_created"] == true => false,
            "publish" => result["updated"] != true || self.opens_on_write.remove(&id),
            "open" if result["opened"] == true => true,
            _ => return None,
        };
        // One line, as the card shows it.
        let title: String = result["title"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        let title = match title.trim() {
            "" => "Untitled artifact",
            title => title,
        };
        let index = self.cards.iter().position(|card| card.id == id);
        let card = PublishedArtifact {
            revision: index.map_or(1, |i| self.cards[i].revision + 1),
            id,
            url: url.into(),
            title: title.into(),
        };
        match index {
            Some(i) => self.cards[i] = card.clone(),
            None => self.cards.push(card.clone()),
        }
        Some(RunEvent::PublishedArtifact {
            published_artifact: card,
            open,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "61f14ff2-c402-429d-ad1b-42de9c796ca9";
    const URL: &str = "https://claude.ai/artifact/D6UUK2MDNtEQ65Mn61b3ax";

    fn call(id: &str, input: Value, parent: Value) -> Value {
        json!({"type":"assistant","parent_tool_use_id":parent,"message":{"content":[{"type":"tool_use","id":id,"name":"Artifact","input":input}]}})
    }
    fn result(id: &str, answer: Value, error: bool) -> Value {
        json!({"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":id,"is_error":error,"content":"Published"}]},"tool_use_result":answer})
    }
    // The answers Claude Code 2.1.306 gave for a real publish and open on 2026-10-21.
    fn published(updated: bool) -> Value {
        json!({"url":URL,"path":"C:\\Temp\\test-page.html","artifact_id":ID,"title":"Agent Studio publish test","updated":updated,"owned":true,"icon":"test","audience":"owner","seq":1,"version":"1792592971-ea59","contract":"0.0.0","liveSubscription":"publish_context"})
    }
    fn cards(events: Vec<RunEvent>) -> Vec<(PublishedArtifact, bool)> {
        events
            .into_iter()
            .map(|event| match event {
                RunEvent::PublishedArtifact {
                    published_artifact,
                    open,
                } => (published_artifact, open),
                _ => panic!("card"),
            })
            .collect()
    }

    #[test]
    fn a_publish_makes_a_card_that_a_new_artifact_opens() {
        let mut seen = PublishedArtifacts::default();
        assert!(seen
            .observe_claude(&call(
                "t1",
                json!({"file_path":"C:\\Temp\\test-page.html"}),
                Value::Null
            ))
            .is_empty());
        let made = cards(seen.observe_claude(&result("t1", published(false), false)));
        assert_eq!(
            made,
            vec![(
                PublishedArtifact {
                    id: ID.into(),
                    revision: 1,
                    url: URL.into(),
                    title: "Agent Studio publish test".into(),
                },
                true
            )]
        );
        assert!(seen.has_artifacts());
        // Publishing it again updates the same card and opens nothing; opening it opens it.
        seen.observe_claude(&call(
            "t2",
            json!({"action":"publish","file_path":"x"}),
            Value::Null,
        ));
        let again = cards(seen.observe_claude(&result("t2", published(true), false)));
        assert_eq!((again[0].0.revision, again[0].1), (2, false));
        seen.observe_claude(&call("t3", json!({"action":"open","url":URL}), Value::Null));
        let opened = cards(seen.observe_claude(&result(
            "t3",
            json!({"opened":true,"url":URL,"artifact_id":ID,"title":"Agent Studio publish test","owned":true}),
            false,
        )));
        assert_eq!((opened[0].0.revision, opened[0].1), (3, true));
        // The structured answer is the event's only source: the event names nothing else.
        let event = serde_json::to_value(RunEvent::PublishedArtifact {
            published_artifact: opened[0].0.clone(),
            open: false,
        })
        .unwrap();
        assert_eq!(
            event,
            json!({"kind":"publishedartifact","publishedArtifact":{"id":ID,"revision":3,"url":URL,"title":"Agent Studio publish test"}})
        );
    }

    #[test]
    fn a_page_made_from_a_type_is_known_by_its_link() {
        // The answer Claude Code 2.1.317 gave for a real publish from a type on 2026-11-03, whose
        // only name for the artifact is its link.
        let made = |extra: Value| {
            let mut answer = json!({"created_from_type":true,"url":URL,"version":"1793738723-8370","owned":true,"title":"Billing report","type":{"url":"https://claude.ai/artifact/Rp9naXUCj2xozpUkyQy19W","release":"1793735263-07c8"},"own_files":[],"type_files":["index.html"],"provisioned":true,"liveSubscription":"none","instructions":"Fill it in","instructions_chars":10});
            answer
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            answer
        };
        let input = json!({"type_url":"https://claude.ai/artifact/Rp9naXUCj2xozpUkyQy19W","title":"Billing report"});
        let mut seen = PublishedArtifacts::default();
        seen.observe_claude(&call("t1", input.clone(), Value::Null));
        let shown = cards(seen.observe_claude(&result(
            "t1",
            made(json!({"auto_open":"at_create"})),
            false,
        )));
        // The link decodes to the id a file's publish reports for it, so both are one card.
        assert_eq!(shown[0].0.id, ID);
        assert!(shown[0].1);
        seen.observe_claude(&call("t2", json!({"file_path":"x"}), Value::Null));
        let filled = cards(seen.observe_claude(&result("t2", published(true), false)));
        assert_eq!((filled[0].0.revision, filled[0].1), (2, false));
        assert_eq!(seen.cards.len(), 1);

        // Asked to wait, it opens on its first write, once.
        let mut seen = PublishedArtifacts::default();
        seen.observe_claude(&call("t1", input.clone(), Value::Null));
        let shown = cards(seen.observe_claude(&result(
            "t1",
            made(json!({"auto_open":"after_first_write"})),
            false,
        )));
        assert!(!shown[0].1);
        for (id, opens) in [("t2", true), ("t3", false)] {
            seen.observe_claude(&call(id, json!({"file_path":"x"}), Value::Null));
            let filled = cards(seen.observe_claude(&result(id, published(true), false)));
            assert_eq!(filled[0].1, opens);
        }

        // A call repeated after it already made the page opens nothing.
        let mut seen = PublishedArtifacts::default();
        seen.observe_claude(&call("t1", input, Value::Null));
        let again =
            cards(seen.observe_claude(&result("t1", made(json!({"already_created":true})), false)));
        assert!(!again[0].1);
    }

    #[test]
    fn a_link_carries_the_artifacts_id() {
        assert_eq!(link_id(URL).as_deref(), Some(ID));
        // Base 58 pads a small value with its zero digit, to the 22 digits a link always has.
        assert_eq!(
            link_id("https://claude.ai/artifact/1111111111111111111112").as_deref(),
            Some("00000000-0000-0000-0000-000000000001")
        );
        assert_eq!(
            link_id(&format!(
                "https://claude.ai/code/artifact/{}",
                ID.to_uppercase()
            ))
            .as_deref(),
            Some(ID)
        );
        // Past 128 bits, it names nothing.
        assert_eq!(
            link_id("https://claude.ai/artifact/zzzzzzzzzzzzzzzzzzzzzz"),
            None
        );
        assert_eq!(link_id("https://example.com/artifact/x"), None);
    }

    #[test]
    fn only_the_parents_successful_publishes_and_opens_make_cards() {
        let mut seen = PublishedArtifacts::default();
        // A sub-agent's call, a failed call, an unknown call and other actions make none.
        seen.observe_claude(&call("child", json!({}), json!("agent")));
        assert!(seen
            .observe_claude(&result("child", published(false), false))
            .is_empty());
        seen.observe_claude(&call("failed", json!({}), Value::Null));
        assert!(seen
            .observe_claude(&result("failed", published(false), true))
            .is_empty());
        assert!(seen
            .observe_claude(&result("unknown", published(false), false))
            .is_empty());
        seen.observe_claude(&call("list", json!({"action":"list"}), Value::Null));
        assert!(seen
            .observe_claude(&result("list", json!({"artifacts":[],"total":4}), false))
            .is_empty());
        // A call of another Artifact tool makes none.
        seen.observe_claude(&json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"other","name":"ArtifactComments","input":{}}]}}));
        assert!(seen
            .observe_claude(&result("other", published(false), false))
            .is_empty());
        // An answer naming another site, or a malformed id, is refused.
        for answer in [
            json!({"url":"https://example.com/artifact/D6UUK2MDNtEQ65Mn61b3ax","artifact_id":ID}),
            json!({"url":URL,"artifact_id":"not-a-uuid"}),
            json!({"url":"https://claude.ai/artifact/short","artifact_id":ID}),
        ] {
            seen.observe_claude(&call("odd", json!({}), Value::Null));
            assert!(seen
                .observe_claude(&result("odd", answer, false))
                .is_empty());
        }
        assert!(!seen.has_artifacts());
        // A line answering two calls at once leaves its structured answer unattributed.
        seen.observe_claude(&json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"a","name":"Artifact","input":{}},{"type":"tool_use","id":"b","name":"Artifact","input":{}}]}}));
        let both = json!({"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"a"},{"type":"tool_result","tool_use_id":"b"}]},"tool_use_result":published(false)});
        assert!(seen.observe_claude(&both).is_empty());
        // A result without a title gets one, on one line.
        seen.observe_claude(&call("untitled", json!({}), Value::Null));
        let untitled = cards(seen.observe_claude(&result(
            "untitled",
            json!({"url":URL,"artifact_id":ID.to_uppercase(),"title":"Two\nlines"}),
            false,
        )));
        assert_eq!(untitled[0].0.title, "Two lines");
        assert_eq!(untitled[0].0.id, ID);
    }

    #[test]
    fn knows_claude_ai_artifact_links() {
        assert!(valid_url(URL));
        assert!(valid_url(&format!("https://claude.ai/code/artifact/{ID}")));
        for url in [
            "http://claude.ai/artifact/D6UUK2MDNtEQ65Mn61b3ax",
            "https://claude.ai/artifact/D6UUK2MDNtEQ65Mn61b3a0",
            "https://claude.ai/artifact/D6UUK2MDNtEQ65Mn61b3ax?x=1",
            "https://claude.ai/code/artifact/not-a-uuid",
            "https://claude.ai.example.com/artifact/D6UUK2MDNtEQ65Mn61b3ax",
        ] {
            assert!(!valid_url(url), "{url}");
        }
    }
}
