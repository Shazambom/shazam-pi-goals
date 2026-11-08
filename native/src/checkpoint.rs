//! Pure checkpoint validation, branch reconstruction and advisory rendering.
//! Only the caller's current branch may be supplied to `restore`.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};

const ENTRY_TYPE: &str = "shazam-goals.checkpoint";
const MAX_NOTE_BYTES: usize = 8 * 1024;
const MAX_CUE_POINTS: usize = 1200;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Origin {
    UserRequest,
    AgentInterpretation,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Provenance {
    Accepted,
    Proposed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    statement: String,
    source_ref: String,
    provenance: Provenance,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Note {
    schema_version: u8,
    outcome: String,
    source_ref: String,
    origin: Origin,
    #[serde(deserialize_with = "required_nullable")]
    next_deliverable: Option<String>,
    decisions: Vec<Decision>,
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    blocker: Option<String>,
}

// `Option` normally treats a missing field as null. These fields are required,
// but their explicitly present value may be null.
fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

// An omitted blocker is fine; a present blocker must be a string, never null.
fn optional_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

impl Note {
    fn valid(&self) -> bool {
        self.schema_version == 1
            && !self.outcome.is_empty()
            && !self.source_ref.is_empty()
            && self
                .next_deliverable
                .as_ref()
                .is_none_or(|value| !value.is_empty())
            && self
                .decisions
                .iter()
                .all(|decision| !decision.statement.is_empty() && !decision.source_ref.is_empty())
            && serde_json::to_vec(self).is_ok_and(|bytes| bytes.len() <= MAX_NOTE_BYTES)
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Event {
    Replace { version: u8, note: Note },
    Pause { version: u8 },
    Resume { version: u8 },
    Clear { version: u8 },
}

impl Event {
    fn valid(&self) -> bool {
        match self {
            Self::Replace { version, note } => *version == 1 && note.valid(),
            Self::Pause { version } | Self::Resume { version } | Self::Clear { version } => {
                *version == 1
            }
        }
    }
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct View {
    #[serde(deserialize_with = "required_nullable")]
    revision: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    note: Option<Note>,
    paused: bool,
}

impl View {
    fn valid(&self) -> bool {
        self.revision
            .as_ref()
            .is_none_or(|revision| !revision.is_empty())
            && self.note.as_ref().is_none_or(Note::valid)
    }
}

/// Fold only valid checkpoint entries in a current branch into detached state.
pub fn restore(entries: &Value) -> Value {
    let mut view = View::default();
    if let Some(entries) = entries.as_array() {
        for entry in entries {
            // Filter host envelopes before deserializing our state, so unrelated
            // extension payloads are never copied into checkpoint-owned memory.
            if entry.get("type").and_then(Value::as_str) != Some("custom")
                || entry.get("customType").and_then(Value::as_str) != Some(ENTRY_TYPE)
            {
                continue;
            }
            let Some(id) = entry
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            let Some(data) = entry.get("data") else {
                continue;
            };
            let Ok(event) = Event::deserialize(data) else {
                continue;
            };
            if !event.valid() {
                continue;
            }
            view.revision = Some(id.to_owned());
            match event {
                Event::Replace { note, .. } => view.note = Some(note),
                Event::Pause { .. } => view.paused = true,
                Event::Resume { .. } => view.paused = false,
                Event::Clear { .. } => view.note = None,
            }
        }
    }
    json!(view)
}

/// Build a replacement event after validating the current revision and note.
/// All failures are fixed messages; input content is never included in errors.
pub fn replacement(
    view: &Value,
    expected_revision: &Value,
    input: &Value,
) -> Result<Value, &'static str> {
    let view = View::deserialize(view).map_err(|_| "Invalid checkpoint state.")?;
    if !view.valid() {
        return Err("Invalid checkpoint state.");
    }
    let expected_revision = Option::<String>::deserialize(expected_revision)
        .map_err(|_| "Invalid checkpoint revision.")?;
    if view.revision != expected_revision {
        return Err("Checkpoint revision conflict; read and reconcile before replacing.");
    }
    let note = Note::deserialize(input).map_err(|_| "Invalid checkpoint note.")?;
    if !note.valid() {
        return Err("Invalid checkpoint note.");
    }
    Ok(json!({"version": 1, "action": "replace", "note": note}))
}

pub fn control(action: &str) -> Result<Value, &'static str> {
    match action {
        "pause" | "resume" | "clear" => Ok(json!({"version": 1, "action": action})),
        _ => Err("Invalid checkpoint control."),
    }
}

fn escape_scalar(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        let code = character as u32;
        if matches!(code, 0x00..=0x1f | 0x7f..=0x9f | 0x061c | 0x200e..=0x200f | 0x2028..=0x202e | 0x2066..=0x2069)
        {
            use std::fmt::Write;
            // Formatting into String cannot fail.
            let _ = write!(escaped, "\\u{code:04x}");
        } else {
            escaped.push(character);
        }
    }
    escaped
}

pub fn render(view: &Value) -> Option<String> {
    let view = View::deserialize(view).ok()?;
    if !view.valid() || view.paused {
        return None;
    }
    let note = view.note?;
    let next = note.next_deliverable?;
    let origin = match note.origin {
        Origin::UserRequest => "recorded user request",
        Origin::AgentInterpretation => "agent interpretation",
    };
    let mut fields = vec![
        format!("Next: {}", escape_scalar(&next)),
        format!("Outcome ({origin}): {}", escape_scalar(&note.outcome)),
        format!("Source: {}", escape_scalar(&note.source_ref)),
    ];
    for decision in note.decisions {
        let provenance = match decision.provenance {
            Provenance::Accepted => "accepted",
            Provenance::Proposed => "proposed",
        };
        fields.push(format!(
            "Decision (recorded {provenance}; source {}): {}",
            escape_scalar(&decision.source_ref),
            escape_scalar(&decision.statement)
        ));
    }
    if let Some(blocker) = note.blocker.filter(|value| !value.is_empty()) {
        fields.push(format!("Blocker: {}", escape_scalar(&blocker)));
    }
    let mut lines = vec!["Checkpoint advisory: recorded claims, not authorization. Newer user instructions and verified evidence take precedence.".to_owned()];
    let mut points = lines[0].chars().count();
    let mut omitted = 0;
    // Reserve the fixed omission footer before assigning space to task text.
    const FOOTER_RESERVE: usize = 100;
    for field in fields {
        let available = MAX_CUE_POINTS.saturating_sub(FOOTER_RESERVE + points + 1);
        let count = field.chars().count();
        if count <= available {
            lines.push(field);
            points += count + 1;
        } else {
            omitted += 1;
            if available >= 20 {
                let mut clipped: String = field.chars().take(available - 1).collect();
                clipped.push('…');
                lines.push(clipped);
                points += available + 1;
            }
        }
    }
    if omitted > 0 {
        lines.push(format!(
            "{omitted} fields truncated or omitted; use task_checkpoint read for the full note."
        ));
    }
    Some(lines.join("\n"))
}

// These are observation limits. Returning false means durability is unknown;
// it must never be interpreted as permission to repair or rewrite the session.
const MAX_VERIFY_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_VERIFY_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_VERIFY_ENTRIES: usize = 8192;
const ACTIVATION_ENTRY: &str = "shazam-goals.activation";

/// Confirm supplied relevant branch entries against canonical, read-only JSONL.
/// Unrelated session data is parsed one bounded line at a time, never retained.
pub fn verify_saved(file: &str, session_id: &str, entries: &Value) -> bool {
    let Some(entries) = entries.as_array() else {
        return false;
    };
    let mut expected: HashMap<&str, &Value> = HashMap::new();
    for entry in entries {
        let relevant = matches!(
            entry.get("customType").and_then(Value::as_str),
            Some(ENTRY_TYPE | ACTIVATION_ENTRY)
        );
        if !relevant {
            continue;
        }
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            return false;
        };
        if id.is_empty()
            || entry.get("type").and_then(Value::as_str) != Some("custom")
            || entry.get("data").is_none()
            || expected.len() >= MAX_VERIFY_ENTRIES
            || expected.insert(id, entry).is_some()
        {
            return false;
        }
    }
    if session_id.is_empty() {
        return false;
    }
    let Ok(file) = File::open(file) else {
        return false;
    };
    let Ok(metadata) = file.metadata() else {
        return false;
    };
    if !metadata.is_file() || metadata.len() > MAX_VERIFY_FILE_BYTES as u64 {
        return false;
    }
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut total = 0;
    let mut header_seen = false;
    let mut seen = std::collections::HashSet::new();
    loop {
        line.clear();
        let Ok(count) = (&mut reader)
            .take((MAX_VERIFY_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)
        else {
            return false;
        };
        if count == 0 {
            break;
        }
        total += count;
        if count > MAX_VERIFY_LINE_BYTES || total > MAX_VERIFY_FILE_BYTES {
            return false;
        }
        let Ok(saved) = serde_json::from_slice::<Value>(&line) else {
            return false;
        };
        if !header_seen {
            if saved.get("type").and_then(Value::as_str) != Some("session")
                || saved.get("id").and_then(Value::as_str) != Some(session_id)
            {
                return false;
            }
            header_seen = true;
            continue;
        }
        if saved.get("type").and_then(Value::as_str) == Some("session") {
            return false;
        }
        let Some(id) = saved.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(entry) = expected.get(id) else {
            continue;
        };
        if !seen.insert(id.to_owned())
            || saved.get("type") != entry.get("type")
            || saved.get("customType") != entry.get("customType")
            || saved.get("data") != entry.get("data")
        {
            return false;
        }
    }
    header_seen && seen.len() == expected.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(outcome: &str) -> Value {
        json!({"schema_version": 1, "outcome": outcome, "source_ref": "user-1", "origin": "user_request",
        "next_deliverable": "Report verified results", "decisions": [
            {"statement": "Use the existing adapter", "source_ref": "user-2", "provenance": "accepted"}
        ]})
    }
    fn entry(id: &str, data: Value) -> Value {
        json!({"id": id, "type": "custom", "customType": ENTRY_TYPE, "data": data})
    }
    fn replaced(id: &str, outcome: &str) -> Value {
        entry(
            id,
            json!({"version": 1, "action": "replace", "note": note(outcome)}),
        )
    }

    #[test]
    fn branch_reconstruction_does_not_import_a_sibling_goal() {
        let a = replaced("a", "Goal A");
        let b = replaced("b", "Goal B");
        assert_eq!(restore(&json!([a.clone(), b]))["note"]["outcome"], "Goal B");
        let view = restore(&json!([a]));
        assert_eq!(view["note"]["outcome"], "Goal A");
        assert_eq!(view["revision"], "a");
        let cue = render(&view).unwrap();
        assert!(cue.contains("Goal A"));
        assert!(!cue.contains("Goal B"));
    }

    #[test]
    fn human_pause_survives_replacement_and_clear_until_resume() {
        let mut history = vec![
            replaced("a", "Goal A"),
            entry("p", control("pause").unwrap()),
        ];
        let paused = restore(&json!(history));
        history.push(entry(
            "b",
            replacement(&paused, &json!("p"), &note("Goal B")).unwrap(),
        ));
        assert_eq!(render(&restore(&json!(history))), None);
        history.push(entry("c", control("clear").unwrap()));
        assert_eq!(
            restore(&json!(history)),
            json!({"revision": "c", "note": null, "paused": true})
        );
        history.push(entry(
            "d",
            replacement(&restore(&json!(history)), &json!("c"), &note("Goal C")).unwrap(),
        ));
        assert_eq!(render(&restore(&json!(history))), None);
        history.push(entry("r", control("resume").unwrap()));
        assert!(render(&restore(&json!(history))).is_some());
    }

    #[test]
    fn input_history_and_returned_snapshots_are_independent() {
        let mut input = note("Original");
        let event = replacement(&restore(&json!([])), &Value::Null, &input).unwrap();
        input["outcome"] = json!("Mutated input");
        input["decisions"][0]["statement"] = json!("Mutated input");
        let history = json!([entry("a", event)]);
        let mut first = restore(&history);
        first["note"]["outcome"] = json!("Mutated view");
        first["note"]["decisions"][0]["statement"] = json!("Mutated view");
        let second = restore(&history);
        assert_eq!(second["note"]["outcome"], "Original");
        assert_eq!(
            second["note"]["decisions"][0]["statement"],
            "Use the existing adapter"
        );
    }

    #[test]
    fn stale_replacement_and_invalid_input_leave_state_unchanged() {
        let view = restore(&json!([replaced("a", "Goal A")]));
        let before = view.clone();
        assert!(replacement(&view, &Value::Null, &note("Goal B"))
            .unwrap_err()
            .contains("revision"));
        let mut invalid = note("Goal B");
        invalid["extra"] = json!("SENSITIVE_SENTINEL");
        let error = replacement(&view, &json!("a"), &invalid).unwrap_err();
        assert_eq!(error, "Invalid checkpoint note.");
        assert!(!error.contains("SENSITIVE_SENTINEL"));
        assert_eq!(view, before);
    }

    #[test]
    fn malformed_history_is_ignored_without_superseding_valid_revision() {
        let a = replaced("a", "Goal A");
        let expected = restore(&json!([a.clone()]));
        let mut wrong_type = entry("d", control("clear").unwrap());
        wrong_type["type"] = json!("message");
        let mut wrong_owner = entry("e", control("clear").unwrap());
        wrong_owner["customType"] = json!("other");
        let values = json!([
            a,
            entry("b", json!({"version": 2, "action": "clear"})),
            entry(
                "c",
                json!({"version": 1, "action": "resume", "extra": true})
            ),
            wrong_type,
            wrong_owner,
            entry("", control("clear").unwrap()),
            null,
            entry(
                "g",
                json!({"version": 1, "action": "replace", "note": null})
            )
        ]);
        assert_eq!(restore(&values), expected);
        assert_eq!(restore(&json!({})), restore(&json!([])));
    }

    #[test]
    fn strict_schema_rejects_missing_nullable_and_unknown_nested_fields() {
        let mut missing = note("Goal");
        missing.as_object_mut().unwrap().remove("next_deliverable");
        let mut null_blocker = note("Goal");
        null_blocker["blocker"] = Value::Null;
        let mut extra_nested = note("Goal");
        extra_nested["decisions"][0]["extra"] = json!(true);
        let mut invalid_enum = note("Goal");
        invalid_enum["origin"] = json!("system");
        let mut empty = note("");
        empty["source_ref"] = json!("");
        for invalid in [missing, null_blocker, extra_nested, invalid_enum, empty] {
            assert_eq!(
                replacement(&restore(&json!([])), &Value::Null, &invalid),
                Err("Invalid checkpoint note.")
            );
            assert_eq!(
                restore(&json!([entry(
                    "a",
                    json!({"version": 1, "action": "replace", "note": invalid})
                )]))["note"],
                Value::Null
            );
        }
    }

    #[test]
    fn note_limit_counts_utf8_bytes() {
        let large = note(&"😀".repeat(2200));
        assert_eq!(
            replacement(&restore(&json!([])), &Value::Null, &large),
            Err("Invalid checkpoint note.")
        );
        assert!(replacement(
            &restore(&json!([])),
            &Value::Null,
            &note(&"😀".repeat(1200))
        )
        .is_ok());
        let mut max = note("x");
        let overhead = serde_json::to_vec(&max).unwrap().len() - 1;
        max["outcome"] = json!("x".repeat(MAX_NOTE_BYTES - overhead));
        assert_eq!(serde_json::to_vec(&max).unwrap().len(), MAX_NOTE_BYTES);
        assert!(replacement(&restore(&json!([])), &Value::Null, &max).is_ok());
        max["outcome"] = json!("x".repeat(MAX_NOTE_BYTES - overhead + 1));
        assert!(replacement(&restore(&json!([])), &Value::Null, &max).is_err());
    }

    #[test]
    fn cue_escapes_controls_and_the_complete_bidi_control_set() {
        let controls = [
            '\0', '\n', '\t', '\u{7f}', '\u{85}', '\u{61c}', '\u{200e}', '\u{200f}', '\u{2028}',
            '\u{2029}', '\u{202a}', '\u{202b}', '\u{202c}', '\u{202d}', '\u{202e}', '\u{2066}',
            '\u{2067}', '\u{2068}', '\u{2069}',
        ];
        let mut input = note(&format!("café {}", controls.iter().collect::<String>()));
        input["origin"] = json!("agent_interpretation");
        let view = restore(&json!([entry(
            "a",
            json!({"version": 1, "action": "replace", "note": input})
        )]));
        let cue = render(&view).unwrap();
        assert!(cue.contains("Newer user instructions"));
        assert!(cue.contains("agent interpretation"));
        assert!(cue.contains("recorded accepted"));
        assert!(cue.contains("café"));
        for character in controls {
            if character != '\n' {
                assert!(!cue.contains(character));
            }
        }
        assert!(cue.contains("\\u061c"));
        assert!(cue.contains("\\u202e"));
    }

    #[test]
    fn cue_is_unicode_bounded_and_reports_truncation() {
        let mut input = note("Goal");
        input["next_deliverable"] = json!("🚀".repeat(1400));
        input["blocker"] = json!("A blocker");
        let view = restore(&json!([entry(
            "a",
            json!({"version": 1, "action": "replace", "note": input})
        )]));
        let cue = render(&view).unwrap();
        assert!(cue.chars().count() <= MAX_CUE_POINTS);
        assert!(cue.contains("fields truncated or omitted"));
        assert!(cue.contains("task_checkpoint read"));
        assert!(!cue.contains('\u{fffd}'));
    }

    #[test]
    fn absent_completed_invalid_and_paused_states_are_quiet() {
        assert_eq!(render(&restore(&json!([]))), None);
        let mut completed = note("Goal");
        completed["next_deliverable"] = Value::Null;
        assert_eq!(
            render(&restore(&json!([entry(
                "a",
                json!({"version": 1, "action": "replace", "note": completed})
            )]))),
            None
        );
        assert_eq!(render(&json!({"revision": null, "note": null})), None);
        assert_eq!(control("replace"), Err("Invalid checkpoint control."));
        assert_eq!(
            replacement(&json!({}), &Value::Null, &note("Goal")),
            Err("Invalid checkpoint state.")
        );
    }

    fn saved_file(records: &[Value]) -> tempfile::NamedTempFile {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new().unwrap();
        for record in records {
            serde_json::to_writer(file.as_file_mut(), record).unwrap();
            file.write_all(b"\n").unwrap();
        }
        file
    }

    #[test]
    fn canonical_reader_confirms_branch_records_and_activation_without_rewriting() {
        let a = replaced("a", "Goal A");
        let activation = json!({"id": "activate", "type": "custom", "customType": ACTIVATION_ENTRY,
            "data": {"human": true, "fork": "synthetic"}});
        let file = saved_file(&[
            json!({"type": "session", "id": "session-a"}),
            a.clone(),
            replaced("sibling", "Unrelated sibling"),
            activation.clone(),
            json!({"id": "message", "type": "message", "message": {"role": "user", "content": "not retained"}}),
        ]);
        let before = std::fs::read(file.path()).unwrap();
        assert!(verify_saved(
            file.path().to_str().unwrap(),
            "session-a",
            &json!([a, activation])
        ));
        assert_eq!(std::fs::read(file.path()).unwrap(), before);
    }

    #[test]
    fn canonical_reader_rejects_missing_changed_duplicate_or_wrong_owner_records() {
        let a = replaced("a", "Goal A");
        let file = saved_file(&[json!({"type": "session", "id": "session-a"}), a.clone()]);
        let path = file.path().to_str().unwrap();
        assert!(!verify_saved(path, "session-b", &json!([a.clone()])));
        assert!(!verify_saved(
            path,
            "session-a",
            &json!([replaced("a", "Goal B")])
        ));
        assert!(!verify_saved(
            path,
            "session-a",
            &json!([replaced("missing", "Goal A")])
        ));
        assert!(!verify_saved(
            path,
            "session-a",
            &json!([a.clone(), a.clone()])
        ));
        let duplicate = saved_file(&[
            json!({"type": "session", "id": "session-a"}),
            a.clone(),
            a.clone(),
        ]);
        assert!(!verify_saved(
            duplicate.path().to_str().unwrap(),
            "session-a",
            &json!([a])
        ));
    }

    #[test]
    fn canonical_reader_rejects_partial_json_invalid_header_and_read_errors() {
        use std::io::Write;
        let a = replaced("a", "Goal A");
        let mut partial = saved_file(&[json!({"type": "session", "id": "session-a"}), a.clone()]);
        partial.write_all(b"{\"type\":").unwrap();
        assert!(!verify_saved(
            partial.path().to_str().unwrap(),
            "session-a",
            &json!([a.clone()])
        ));
        let headerless = saved_file(&[a.clone()]);
        assert!(!verify_saved(
            headerless.path().to_str().unwrap(),
            "session-a",
            &json!([a.clone()])
        ));
        let repeated_header = saved_file(&[
            json!({"type": "session", "id": "session-a"}),
            a.clone(),
            json!({"type": "session", "id": "session-a"}),
        ]);
        assert!(!verify_saved(
            repeated_header.path().to_str().unwrap(),
            "session-a",
            &json!([a])
        ));
        let directory = tempfile::tempdir().unwrap();
        assert!(!verify_saved(
            directory.path().to_str().unwrap(),
            "session-a",
            &json!([])
        ));
        assert!(!verify_saved(
            directory.path().join("missing").to_str().unwrap(),
            "session-a",
            &json!([])
        ));
    }

    #[test]
    fn canonical_reader_limits_are_unknown_not_repair_attempts() {
        use std::io::Write;
        let mut oversized = saved_file(&[json!({"type": "session", "id": "session-a"})]);
        oversized
            .write_all(&vec![b' '; MAX_VERIFY_LINE_BYTES + 1])
            .unwrap();
        let size = oversized.as_file().metadata().unwrap().len();
        assert!(!verify_saved(
            oversized.path().to_str().unwrap(),
            "session-a",
            &json!([])
        ));
        assert_eq!(oversized.as_file().metadata().unwrap().len(), size);
        let huge = tempfile::NamedTempFile::new().unwrap();
        huge.as_file()
            .set_len(MAX_VERIFY_FILE_BYTES as u64 + 1)
            .unwrap();
        assert!(!verify_saved(
            huge.path().to_str().unwrap(),
            "session-a",
            &json!([])
        ));
    }
}
