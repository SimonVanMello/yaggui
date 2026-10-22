//! The todo list of an interactive rebase (M3-4), built by yaggui from the caller's entries.
//!
//! Git never opens an editor: messages are not written by `reword` / `squash` lines (both
//! would open `GIT_EDITOR`) but carried by a *twin* commit, same tree, parent and author as
//! the original with the new message, made beforehand with `git commit-tree`. The group
//! head is picked as that twin and the commits melded into it become `fixup` lines, which
//! keep its message verbatim (lines starting with `#` included). Only `pick`, `edit`,
//! `fixup` and `drop` are written, all known to Git ≥ 2.30.

use std::collections::{HashMap, HashSet};

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

/// Prefix of the message `git commit --fixup` writes.
const FIXUP_PREFIX: &str = "fixup! ";

/// Subject a `fixup!` commit points to, every `fixup! ` prefix removed (a fixup of a fixup
/// points to the same commit); `None` for any other commit.
pub fn fixup_subject(summary: &str) -> Option<&str> {
    let mut rest = summary.strip_prefix(FIXUP_PREFIX)?;
    while let Some(next) = rest.strip_prefix(FIXUP_PREFIX) {
        rest = next;
    }
    Some(rest)
}

/// The todo order `git rebase --autosquash` would give a range (F-147).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Autosquash {
    /// Every commit once, as `(index in the input, action)`: each matched `fixup!` commit
    /// right after its target and the fixups already under it, as a `Fixup`; the others
    /// picked, in their order.
    pub order: Vec<(usize, RebaseAction)>,
    /// Indexes of the `fixup!` commits whose target is not in the range: left in place.
    pub unmatched: Vec<usize>,
}

impl Autosquash {
    /// Index of the oldest commit that receives a fixup.
    pub fn oldest_target(&self) -> Option<usize> {
        self.order
            .windows(2)
            .find(|pair| pair[1].1 == RebaseAction::Fixup)
            .map(|pair| pair[0].0)
    }
}

/// Moves the `fixup!` commits of `commits` (oldest first, with their summary) under their
/// target, the way Git's `--autosquash` matches them: the first earlier commit whose summary
/// is the fixup's subject, else the earlier commit whose SHA starts with it, else the first
/// earlier commit whose summary starts with it.
pub fn autosquash(commits: &[(ObjectId, &str)]) -> Autosquash {
    // The kept commit each matched fixup melds into.
    let mut targets: Vec<Option<usize>> = vec![None; commits.len()];
    let mut by_summary: HashMap<&str, usize> = HashMap::new();
    let mut unmatched = Vec::new();
    for (i, (_, summary)) in commits.iter().enumerate() {
        if let Some(subject) = fixup_subject(summary) {
            let found = (!subject.trim().is_empty())
                .then(|| {
                    by_summary
                        .get(subject)
                        .copied()
                        .or_else(|| sha_match(&commits[..i], subject))
                        .or_else(|| (0..i).find(|&j| commits[j].1.starts_with(subject)))
                })
                .flatten()
                .map(|j| targets[j].unwrap_or(j));
            if let Some(target) = found {
                targets[i] = Some(target);
                continue;
            }
            unmatched.push(i);
        }
        by_summary.entry(summary).or_insert(i);
    }
    let mut fixups: Vec<Vec<usize>> = vec![Vec::new(); commits.len()];
    for (i, target) in targets.iter().enumerate() {
        if let Some(target) = target {
            fixups[*target].push(i);
        }
    }
    let mut order = Vec::with_capacity(commits.len());
    for (i, target) in targets.iter().enumerate() {
        if target.is_none() {
            order.push((i, RebaseAction::Pick));
            order.extend(fixups[i].iter().map(|&k| (k, RebaseAction::Fixup)));
        }
    }
    Autosquash { order, unmatched }
}

/// Index of the commit of `commits` whose SHA starts with `subject` (4 hex digits or more).
fn sha_match(commits: &[(ObjectId, &str)], subject: &str) -> Option<usize> {
    let prefix = subject.to_ascii_lowercase();
    if prefix.len() < 4 || !prefix.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    commits
        .iter()
        .position(|(id, _)| id.to_string().starts_with(&prefix))
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

    fn arranged(summaries: &[&str]) -> (Vec<(usize, RebaseAction)>, Vec<usize>) {
        let commits: Vec<_> = summaries
            .iter()
            .enumerate()
            .map(|(i, s)| (id(u8::try_from(i).unwrap() + 0xa0), *s))
            .collect();
        let result = autosquash(&commits);
        (result.order, result.unmatched)
    }

    #[test]
    fn strips_fixup_prefixes() {
        assert_eq!(fixup_subject("fixup! Add x"), Some("Add x"));
        assert_eq!(fixup_subject("fixup! fixup! Add x"), Some("Add x"));
        assert_eq!(fixup_subject("Add x"), None);
        assert_eq!(fixup_subject("squash! Add x"), None);
    }

    #[test]
    fn moves_fixups_under_their_target() {
        let (order, unmatched) =
            arranged(&["A", "B", "fixup! A", "C", "fixup! fixup! A", "fixup! B"]);
        assert_eq!(
            order,
            [
                (0, Pick),
                (2, Fixup),
                (4, Fixup),
                (1, Pick),
                (5, Fixup),
                (3, Pick)
            ]
        );
        assert!(unmatched.is_empty());
        let result = autosquash(&[(id(1), "A"), (id(2), "fixup! A")]);
        assert_eq!(result.oldest_target(), Some(0));
    }

    #[test]
    fn matches_like_git() {
        // The first commit with the subject wins; then a SHA prefix; then a summary prefix.
        let (order, _) = arranged(&["Same", "Same", "fixup! Same"]);
        assert_eq!(order, [(0, Pick), (2, Fixup), (1, Pick)]);
        let sha = id(0xa1).to_string();
        let by_sha = format!("fixup! {}", &sha[..7]);
        let (order, _) = arranged(&["A", "B", &by_sha]);
        assert_eq!(order, [(0, Pick), (1, Pick), (2, Fixup)]);
        let (order, _) = arranged(&["Add the parser and tests", "fixup! Add the parser"]);
        assert_eq!(order, [(0, Pick), (1, Fixup)]);
    }

    #[test]
    fn leaves_unmatched_fixups_in_place() {
        // No target, a target after the fixup, an empty subject.
        let (order, unmatched) = arranged(&["fixup! Gone", "fixup! Later", "Later", "fixup! "]);
        assert_eq!(order, [(0, Pick), (1, Pick), (2, Pick), (3, Pick)]);
        assert_eq!(unmatched, [0, 1, 3]);
        // A fixup of an unmatched fixup has no target either: every prefix is stripped.
        let (order, unmatched) = arranged(&["fixup! Gone", "fixup! fixup! Gone"]);
        assert_eq!(order, [(0, Pick), (1, Pick)]);
        assert_eq!(unmatched, [0, 1]);
        assert_eq!(autosquash(&[(id(1), "A")]).oldest_target(), None);
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
