//! The todo list of an interactive rebase (M3-4), built by yaggui from the caller's entries.
//!
//! Git never opens an editor: messages are not written by `reword` / `squash` lines (both
//! would open `GIT_EDITOR`) but carried by a *twin* commit, same tree, parent and author as
//! the original with the new message, made beforehand with `git commit-tree`. The group
//! head is picked as that twin and the commits melded into it become `fixup` lines, which
//! keep its message verbatim (lines starting with `#` included). Only `pick`, `edit`,
//! `fixup` and `drop` are written, all known to Git ≥ 2.30.

use std::collections::HashSet;

use gix::ObjectId;

use crate::git::errors::YagguiError;

use super::types::{RebaseAction, RebaseTodoEntry};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TodoCommand {
    Pick,
    Edit,
    Fixup,
    Drop,
}

impl TodoCommand {
    fn keyword(self) -> &'static str {
        match self {
            Self::Pick => "pick",
            Self::Edit => "edit",
            Self::Fixup => "fixup",
            Self::Drop => "drop",
        }
    }
}

/// One line of the todo Git receives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoLine {
    pub command: TodoCommand,
    pub commit: ObjectId,
    /// Message the commit must carry: it is replaced by a twin with this message.
    pub message: Option<String>,
}

/// Validates `entries` against the commits of the range (`range`, oldest first) and turns
/// them into todo lines, in the caller's order.
pub fn plan(range: &[ObjectId], entries: &[RebaseTodoEntry]) -> Result<Vec<TodoLine>, YagguiError> {
    if entries.is_empty() {
        return Err(YagguiError::invalid_argument(
            "There is no commit to rebase.",
            "Il n'y a aucun commit à rebaser.",
        ));
    }
    let known: HashSet<&ObjectId> = range.iter().collect();
    let mut seen = HashSet::new();
    let mut lines: Vec<TodoLine> = Vec::with_capacity(entries.len());
    // Index (in `lines`) of the commit squash / fixup lines meld into, and whether the last
    // squash of its group still lacks the message of the combined commit.
    let mut head: Option<usize> = None;
    let mut missing_message = false;
    for entry in entries {
        let commit = ObjectId::from_hex(entry.sha.trim().as_bytes())
            .ok()
            .filter(|id| known.contains(id))
            .ok_or_else(stale)?;
        if !seen.insert(commit) {
            return Err(stale());
        }
        let short = &commit.to_string()[..7];
        let line = |command, message| TodoLine {
            command,
            commit,
            message,
        };
        match entry.action {
            RebaseAction::Drop => lines.push(line(TodoCommand::Drop, None)),
            RebaseAction::Pick | RebaseAction::Reword | RebaseAction::Edit => {
                if missing_message {
                    return Err(squash_message_required());
                }
                let message = if entry.action == RebaseAction::Reword {
                    Some(
                        entry
                            .message
                            .as_deref()
                            .and_then(normalize_message)
                            .ok_or_else(|| reword_message_required(short))?,
                    )
                } else {
                    None
                };
                let command = if entry.action == RebaseAction::Edit {
                    TodoCommand::Edit
                } else {
                    TodoCommand::Pick
                };
                head = Some(lines.len());
                lines.push(line(command, message));
            }
            RebaseAction::Squash | RebaseAction::Fixup => {
                let Some(target) = head else {
                    return Err(YagguiError::invalid_argument(
                        format!(
                            "{short} cannot be squashed or fixed up: there is no kept commit before it."
                        ),
                        format!(
                            "{short} ne peut pas être fusionné (squash / fixup) : aucun commit conservé ne le précède."
                        ),
                    ));
                };
                if entry.action == RebaseAction::Squash {
                    match entry.message.as_deref().and_then(normalize_message) {
                        Some(message) => {
                            lines[target].message = Some(message);
                            missing_message = false;
                        }
                        None => missing_message = true,
                    }
                }
                lines.push(line(TodoCommand::Fixup, None));
            }
        }
    }
    if missing_message {
        return Err(squash_message_required());
    }
    if seen.len() != range.len() {
        return Err(stale());
    }
    if head.is_none() {
        return Err(YagguiError::invalid_argument(
            "Every commit would be dropped: reset the branch instead.",
            "Tous les commits seraient supprimés : fais plutôt un reset de la branche.",
        ));
    }
    Ok(lines)
}

/// The todo file: one `<command> <sha>` line each, `twin` giving the commit to use for a
/// line that carries a message.
pub fn render(lines: &[TodoLine], twin: impl Fn(usize) -> Option<ObjectId>) -> String {
    let mut out = String::new();
    for (i, line) in lines.iter().enumerate() {
        let commit = twin(i).unwrap_or(line.commit);
        out.push_str(line.command.keyword());
        out.push(' ');
        out.push_str(&commit.to_string());
        out.push('\n');
    }
    out
}

/// A message as stored: no leading blank lines, no trailing whitespace, one final newline.
/// `None` when its first line (the summary) is blank.
pub fn normalize_message(message: &str) -> Option<String> {
    let message = message.trim_start_matches(['\n', '\r']).trim_end();
    let summary = message.lines().next().unwrap_or_default();
    if summary.trim().is_empty() {
        return None;
    }
    let mut out = message.replace("\r\n", "\n");
    out.push('\n');
    Some(out)
}

fn stale() -> YagguiError {
    YagguiError::invalid_argument(
        "The list of commits no longer matches the branch (it changed meanwhile): reload it.",
        "La liste des commits ne correspond plus à la branche (elle a changé entre-temps) : recharge-la.",
    )
}

fn reword_message_required(short: &str) -> YagguiError {
    YagguiError::invalid_argument(
        format!("The new message of {short} is empty."),
        format!("Le nouveau message de {short} est vide."),
    )
}

fn squash_message_required() -> YagguiError {
    YagguiError::invalid_argument(
        "The message of a squashed commit is empty.",
        "Le message d'un commit fusionné (squash) est vide.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::errors::ErrorCode;

    fn id(n: u8) -> ObjectId {
        ObjectId::from_bytes_or_panic(&[n; 20])
    }

    fn entry(n: u8, action: RebaseAction, message: Option<&str>) -> RebaseTodoEntry {
        RebaseTodoEntry {
            sha: id(n).to_string(),
            action,
            message: message.map(str::to_owned),
        }
    }

    use RebaseAction::*;

    #[test]
    fn maps_actions_to_twins_and_fixups() {
        let range = [id(1), id(2), id(3), id(4), id(5)];
        let lines = plan(
            &range,
            &[
                entry(2, Reword, Some("New\n\n# kept\n")),
                entry(1, Drop, None),
                entry(3, Squash, Some("Combined")),
                entry(4, Edit, None),
                entry(5, Fixup, None),
            ],
        )
        .unwrap();
        let commands: Vec<_> = lines.iter().map(|l| (l.command, l.commit)).collect();
        assert_eq!(
            commands,
            [
                (TodoCommand::Pick, id(2)),
                (TodoCommand::Drop, id(1)),
                (TodoCommand::Fixup, id(3)),
                (TodoCommand::Edit, id(4)),
                (TodoCommand::Fixup, id(5)),
            ]
        );
        // The squash message wins over the reword one: it is the combined commit's.
        assert_eq!(lines[0].message.as_deref(), Some("Combined\n"));
        assert_eq!(lines[3].message, None);
        let todo = render(&lines, |i| (i == 0).then(|| id(9)));
        assert!(todo.starts_with(&format!("pick {}\ndrop {}\n", id(9), id(1))));
    }

    #[test]
    fn last_squash_of_a_group_carries_the_message() {
        let range = [id(1), id(2), id(3)];
        let ok = plan(
            &range,
            &[
                entry(1, Pick, None),
                entry(2, Squash, None),
                entry(3, Squash, Some("All")),
            ],
        )
        .unwrap();
        assert_eq!(ok[0].message.as_deref(), Some("All\n"));
        let err = plan(
            &range,
            &[
                entry(1, Pick, None),
                entry(2, Squash, Some("All")),
                entry(3, Squash, Some("  \n")),
            ],
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument);
    }

    #[test]
    fn refuses_invalid_lists() {
        let range = [id(1), id(2)];
        let refused = |entries: &[RebaseTodoEntry]| plan(&range, entries).unwrap_err().code;
        // Squash / fixup with nothing kept before.
        assert_eq!(
            refused(&[entry(1, Fixup, None), entry(2, Pick, None)]),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            refused(&[entry(1, Drop, None), entry(2, Squash, Some("x"))]),
            ErrorCode::InvalidArgument
        );
        // Missing, unknown or repeated commit: a stale list.
        assert_eq!(refused(&[entry(1, Pick, None)]), ErrorCode::InvalidArgument);
        assert_eq!(
            refused(&[entry(1, Pick, None), entry(7, Pick, None)]),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            refused(&[entry(1, Pick, None), entry(1, Pick, None)]),
            ErrorCode::InvalidArgument
        );
        // Reword without message, everything dropped.
        assert_eq!(
            refused(&[entry(1, Reword, Some("\n  ")), entry(2, Pick, None)]),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            refused(&[entry(1, Drop, None), entry(2, Drop, None)]),
            ErrorCode::InvalidArgument
        );
        assert_eq!(refused(&[]), ErrorCode::InvalidArgument);
    }

    #[test]
    fn normalizes_messages() {
        assert_eq!(
            normalize_message("\n\nTitle\r\n\r\n# body  \n\n").as_deref(),
            Some("Title\n\n# body\n")
        );
        assert_eq!(normalize_message("   \nbody"), None);
    }
}
