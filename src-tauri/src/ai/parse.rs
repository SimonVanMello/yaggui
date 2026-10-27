//! Turns a provider's answer into a summary and a description.

use crate::git::errors::YagguiError;

/// Lines a model tends to put before the message despite the instructions.
const PREAMBLES: [&str; 6] = [
    "here is",
    "here's",
    "commit message:",
    "suggested commit message",
    "voici",
    "message de commit",
];

/// `(summary, description)`: code fences, surrounding quotes and a preamble line are
/// removed, the summary is the first line, the description what follows the first blank
/// line. An answer with no text left is `aiEmptyResponse`.
pub fn parse_message(answer: &str) -> Result<(String, String), YagguiError> {
    let text = answer.replace("\r\n", "\n");
    let mut lines: Vec<&str> = text.lines().collect();

    // A preamble ("Here is the commit message:") ends with a colon and precedes the message.
    while let Some(first) = lines.iter().position(|l| !l.trim().is_empty()) {
        let line = lines[first].trim().to_lowercase();
        let preamble = line.ends_with(':') && PREAMBLES.iter().any(|p| line.starts_with(p));
        if !preamble {
            break;
        }
        lines.drain(..=first);
    }
    let mut text = lines.join("\n");
    text = strip_fence(text.trim()).to_owned();
    let text = strip_quotes(text.trim());

    let mut parts = text.splitn(2, '\n');
    let summary = parts.next().unwrap_or_default().trim().to_owned();
    let rest = parts.next().unwrap_or_default();
    // The description starts after the first blank line; lines glued to the summary belong
    // to it too (some models skip the blank line).
    let description = rest
        .trim_start_matches(['\n', ' ', '\t'])
        .trim_end()
        .to_owned();
    if summary.is_empty() {
        return Err(YagguiError::ai_empty_response(
            answer.trim().chars().take(500).collect::<String>(),
        ));
    }
    Ok((summary, description))
}

/// The inside of a ``` fence wrapping the whole text, or the text as it is.
fn strip_fence(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("```") else {
        return text;
    };
    // The language tag (` ```text `) ends the opening line.
    let body = rest.split_once('\n').map_or("", |(_, body)| body);
    body.trim_end()
        .strip_suffix("```")
        .unwrap_or(body)
        .trim_matches('\n')
}

fn strip_quotes(text: &str) -> &str {
    for (open, close) in [("\"", "\""), ("'", "'"), ("“", "”"), ("«", "»")] {
        if text.len() > open.len() + close.len()
            && let Some(inner) = text.strip_prefix(open).and_then(|t| t.strip_suffix(close))
            && !inner.contains(open)
        {
            return inner.trim();
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::parse_message;
    use crate::git::errors::ErrorCode;

    fn parsed(text: &str) -> (String, String) {
        parse_message(text).unwrap()
    }

    #[test]
    fn splits_summary_and_description() {
        assert_eq!(
            parsed("Add the AI button\n\nIt calls the provider.\n\n- one\n- two\n"),
            (
                "Add the AI button".into(),
                "It calls the provider.\n\n- one\n- two".into()
            )
        );
        assert_eq!(parsed("  Fix typo  \n"), ("Fix typo".into(), String::new()));
        assert_eq!(
            parsed("Fix typo\r\nin the readme"),
            ("Fix typo".into(), "in the readme".into())
        );
    }

    #[test]
    fn strips_fences_quotes_and_preambles() {
        assert_eq!(
            parsed("Here is the commit message:\n\n```text\nfeat(ai): add button\n\nBody.\n```"),
            ("feat(ai): add button".into(), "Body.".into())
        );
        assert_eq!(
            parsed("\"Fix the graph\""),
            ("Fix the graph".into(), String::new())
        );
        assert_eq!(parsed("```\nFix it\n```"), ("Fix it".into(), String::new()));
        // A quoted word inside the message is kept.
        assert_eq!(
            parsed("Rename \"foo\" to \"bar\""),
            ("Rename \"foo\" to \"bar\"".into(), String::new())
        );
        // A colon line that is the message itself stays.
        assert_eq!(
            parsed("docs: explain the setup:"),
            ("docs: explain the setup:".into(), String::new())
        );
    }

    #[test]
    fn empty_answers_are_typed_errors() {
        for answer in ["", "  \n ", "```\n```", "Here is the commit message:\n"] {
            let err = parse_message(answer).unwrap_err();
            assert_eq!(err.code, ErrorCode::AiEmptyResponse, "{answer:?}");
        }
    }
}
