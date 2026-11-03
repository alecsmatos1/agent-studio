//! Claude Code compacts a long conversation by replacing its messages with a summary. Agent
//! Studio's guidance (how to show files, visuals, questions, screens, workflows and pages) and
//! the conversation's instructions reach a session only in its first message, which a summary
//! keeps by chance, so a chat stopped showing its pictures after a compaction (requested
//! 2026-11-03). Each chat process therefore registers `SessionStart` hooks for compactions in
//! its `initialize` request, and the reply running when they fire answers them with that
//! guidance, which Claude Code adds to the context after the summary. A sub-agent's compaction
//! fires no `SessionStart` hook.
//!
//! Claude Code (2.1.317) keeps one hook's context whole only up to [`PIECE`] characters and
//! saves a longer one to a file the model sees 2,000 characters of, so the guidance goes in
//! pieces, one hook each. It runs a matcher's hooks side by side and keeps their contexts in
//! the order they were registered.
use serde_json::{json, Value};

/// This app's hooks in the CLI's `hook_callback` requests: `studio-after-compaction-<n>`, the
/// hook that gives the guidance's piece `n`.
const CALLBACK: &str = "studio-after-compaction-";
/// How many pieces the guidance can take, far more than any chat's guidance and instructions
/// need. A longer rest goes whole in the last piece, which the CLI then saves to a file the
/// model can read.
const PIECES: usize = 20;
/// The longest context Claude Code keeps whole for one hook (`YMe`), in UTF-16 units as
/// JavaScript counts a string's length.
const PIECE: usize = 10_000;
/// How long the CLI waits for an answer, in seconds. A running reply answers at once, while a
/// parked process has nobody listening, and the CLI's default of ten minutes would hold the
/// reply that claims the process for as long.
const TIMEOUT_SECONDS: u64 = 30;

/// The `hooks` field of a chat's `initialize` request.
pub fn hooks() -> Value {
    let ids: Vec<String> = (0..PIECES).map(|n| format!("{CALLBACK}{n}")).collect();
    json!({"SessionStart":[{"matcher":"compact","hookCallbackIds":ids,"timeout":TIMEOUT_SECONDS}]})
}

/// One reply's answers to its process's compaction hooks, with the guidance in pieces, worked
/// out once the first hook asks.
#[derive(Default)]
pub struct Guidance(Option<Vec<String>>);

impl Guidance {
    /// The answer to a `hook_callback` request of the CLI, or None for any other line. `parts`
    /// gives the guidance (`RunRequest::compaction_context`).
    pub fn answer(&mut self, value: &Value, parts: impl FnOnce() -> Vec<String>) -> Option<Value> {
        let request = &value["request"];
        if value["type"] != "control_request" || request["subtype"] != "hook_callback" {
            return None;
        }
        let index = request["callback_id"]
            .as_str()
            .and_then(|id| id.strip_prefix(CALLBACK))
            .and_then(|n| n.parse::<usize>().ok())
            .filter(|n| *n < PIECES && request["input"]["hook_event_name"] == "SessionStart");
        let context = index.and_then(|index| {
            let pieces = self.0.get_or_insert_with(|| pieces(&parts(), PIECE));
            pieces.get(index..).map(|rest| {
                if index + 1 == PIECES {
                    rest.join("\n\n")
                } else {
                    rest.first().cloned().unwrap_or_default()
                }
            })
        });
        // Any other callback, and a hook with no piece left, gets no opinion rather than an
        // error the CLI reports as a failed hook.
        let output = match context.filter(|context| !context.is_empty()) {
            Some(context) => {
                json!({"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":context}})
            }
            None => json!({}),
        };
        Some(
            json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":output}}),
        )
    }
}

/// `parts` in pieces of at most `limit` UTF-16 units, in order: a part joins the piece before
/// it when both fit, and a longer part is cut at the last paragraph, line, sentence or word
/// break that fits.
fn pieces(parts: &[String], limit: usize) -> Vec<String> {
    let mut pieces: Vec<String> = Vec::new();
    for part in parts {
        let mut rest = part.trim();
        while !rest.is_empty() {
            let (head, tail) = rest.split_at(cut(rest, limit));
            let head = head.trim_end();
            match pieces.last_mut() {
                Some(last) if units(last) + 2 + units(head) <= limit => {
                    last.push_str("\n\n");
                    last.push_str(head);
                }
                _ => pieces.push(head.to_string()),
            }
            rest = tail.trim_start();
        }
    }
    pieces
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Where the next piece of `text` ends: all of it when it fits, else after the last paragraph,
/// line, sentence or word break within `limit` units, else after the most that fits, and never
/// before its first character.
fn cut(text: &str, limit: usize) -> usize {
    let (mut fits, mut used) = (0, 0);
    for (at, c) in text.char_indices() {
        used += c.len_utf16();
        if used > limit {
            break;
        }
        fits = at + c.len_utf8();
    }
    if fits == text.len() {
        return fits;
    }
    let head = &text[..fits];
    for mark in ["\n\n", "\n", ". ", " "] {
        if let Some(at) = head.rfind(mark).filter(|at| *at > 0) {
            return at + mark.len();
        }
    }
    fits.max(text.chars().next().map_or(0, char::len_utf8))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn callback(id: &str, event: &str) -> Value {
        json!({"type":"control_request","request_id":"hook-1","request":{"subtype":"hook_callback","callback_id":id,"input":{"hook_event_name":event,"source":"compact","session_id":"s"},"tool_use_id":null}})
    }

    fn context(answer: &Value) -> Option<&str> {
        assert_eq!(answer["type"], "control_response");
        assert_eq!(answer["response"]["subtype"], "success");
        assert_eq!(answer["response"]["request_id"], "hook-1");
        let output = &answer["response"]["response"];
        if output == &json!({}) {
            return None;
        }
        assert_eq!(
            output["hookSpecificOutput"]["hookEventName"],
            "SessionStart"
        );
        output["hookSpecificOutput"]["additionalContext"].as_str()
    }

    #[test]
    fn registers_its_pieces_as_session_start_hooks_for_compactions() {
        let hooks = hooks();
        assert_eq!(hooks.as_object().unwrap().len(), 1);
        let matchers = hooks["SessionStart"].as_array().unwrap();
        assert_eq!(matchers.len(), 1);
        assert_eq!(matchers[0]["matcher"], "compact");
        assert_eq!(matchers[0]["timeout"], 30);
        let ids = matchers[0]["hookCallbackIds"].as_array().unwrap();
        assert_eq!(ids.len(), PIECES);
        assert_eq!(ids[0], "studio-after-compaction-0");
        assert_eq!(
            ids[PIECES - 1],
            format!("studio-after-compaction-{}", PIECES - 1)
        );
    }

    #[test]
    fn each_hook_gives_its_piece_and_the_guidance_is_worked_out_once() {
        let asked = Cell::new(0);
        let parts = || {
            asked.set(asked.get() + 1);
            vec!["A".repeat(PIECE), "B".repeat(10), "C".repeat(PIECE - 5)]
        };
        let mut guidance = Guidance::default();
        let mut given = vec![];
        for n in 0..PIECES {
            let answer = guidance
                .answer(&callback(&format!("{CALLBACK}{n}"), "SessionStart"), parts)
                .unwrap();
            given.push(context(&answer).map(String::from));
        }
        assert_eq!(asked.get(), 1);
        assert_eq!(
            given[..4],
            [
                Some("A".repeat(PIECE)),
                Some("B".repeat(10)),
                Some("C".repeat(PIECE - 5)),
                None
            ]
        );
        assert!(given[4..].iter().all(Option::is_none));
    }

    #[test]
    fn the_last_hook_gives_whatever_the_pieces_before_it_leave() {
        let parts = vec!["word ".repeat(PIECE * (PIECES + 2) / 5)];
        let all = pieces(&parts, PIECE);
        assert!(all.len() > PIECES);
        let mut guidance = Guidance::default();
        let last = guidance
            .answer(
                &callback(&format!("{CALLBACK}{}", PIECES - 1), "SessionStart"),
                || parts.clone(),
            )
            .unwrap();
        assert_eq!(context(&last).unwrap(), all[PIECES - 1..].join("\n\n"));
    }

    #[test]
    fn other_callbacks_and_events_get_no_opinion() {
        let mut guidance = Guidance::default();
        for other in [
            callback("someone-else", "SessionStart"),
            callback(&format!("{CALLBACK}{PIECES}"), "SessionStart"),
            callback(&format!("{CALLBACK}x"), "SessionStart"),
            callback(&format!("{CALLBACK}0"), "PreCompact"),
        ] {
            let answer = guidance.answer(&other, || vec!["GUIDANCE".into()]).unwrap();
            assert_eq!(context(&answer), None);
        }
        // A chat without guidance to give, such as one without tools, answers every hook empty.
        let mut empty = Guidance::default();
        let answer = empty
            .answer(&callback(&format!("{CALLBACK}0"), "SessionStart"), Vec::new)
            .unwrap();
        assert_eq!(context(&answer), None);
    }

    #[test]
    fn leaves_every_other_line_to_the_reply() {
        let mut guidance = Guidance::default();
        for line in [
            json!({"type":"control_request","request_id":"r","request":{"subtype":"can_use_tool"}}),
            json!({"type":"control_request","request_id":"r","request":{"subtype":"mcp_message"}}),
            json!({"type":"system","subtype":"compact_boundary"}),
        ] {
            assert!(guidance.answer(&line, || panic!("never read")).is_none());
        }
    }

    #[test]
    fn parts_share_pieces_that_fit_and_longer_ones_break_where_they_can() {
        let short = vec![
            "One.".to_string(),
            " Two. ".into(),
            String::new(),
            "Three.".into(),
        ];
        assert_eq!(pieces(&short, 100), ["One.\n\nTwo.\n\nThree."]);
        assert_eq!(pieces(&short, 11), ["One.\n\nTwo.", "Three."]);
        // A paragraph break wins over a line break, a line over a sentence, a sentence over a
        // word, and text without any breaks at all is cut where it stops fitting.
        assert_eq!(pieces(&["aa\n\nb\nc. d e".into()], 9), ["aa", "b\nc. d e"]);
        assert_eq!(pieces(&["aa b\nc. d e".into()], 8), ["aa b", "c. d e"]);
        assert_eq!(pieces(&["aa b. cc d".into()], 8), ["aa b.", "cc d"]);
        assert_eq!(pieces(&["aa bb cc".into()], 6), ["aa bb", "cc"]);
        assert_eq!(pieces(&["abcdefgh".into()], 3), ["abc", "def", "gh"]);
        // Lengths are JavaScript's: a character outside the basic plane counts twice, and a
        // piece never ends inside one.
        let wide = ["\u{1F600}".repeat(3)];
        assert_eq!(pieces(&wide, 5), ["\u{1F600}\u{1F600}", "\u{1F600}"]);
        assert_eq!(pieces(&wide, 1), ["\u{1F600}", "\u{1F600}", "\u{1F600}"]);
    }

    #[test]
    fn long_guidance_keeps_every_word_in_pieces_that_fit() {
        let text: String = (0..6000)
            .map(|n| format!("Sentence {n} of the part. "))
            .collect();
        let parts = vec![text.clone(), "Instructions:\nkeep them.".into()];
        let all = pieces(&parts, PIECE);
        assert!(all.iter().all(|piece| units(piece) <= PIECE));
        let words = |text: &str| {
            text.split_whitespace()
                .map(String::from)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            words(&all.join(" ")),
            words(&format!("{text} Instructions:\nkeep them."))
        );
    }
}
