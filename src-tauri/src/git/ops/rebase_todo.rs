//! The todo list of an interactive rebase (M3-4), built by yaggui from the caller's entries.
//!
//! Git never opens an editor: messages are not written by `reword` / `squash` lines (both
//! would open `GIT_EDITOR`) but carried by a *twin* commit, same tree, parent and author as
//! the original with the new message, made beforehand with `git commit-tree`. The group
//! head is picked as that twin and the commits melded into it become `fixup` lines, which
//! keep its message verbatim (lines starting with `#` included); a `fixup -C` (an `amend!`
//! commit) is the same: its message goes to the twin. Only `pick`, `edit`,
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
                // A `fixup` with a message is `fixup -C`: it gives the group its message.
                if entry.action == RebaseAction::Squash || entry.message.is_some() {
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

/// How a `fixup!`, `amend!` or `squash!` commit melds into its target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Meld {
    /// `fixup!`: the target's message stays.
    Fixup,
    /// `amend!`: `fixup -C`, the message of the `amend!` commit replaces the target's.
    Amend,
    /// `squash!`: the messages are combined.
    Squash,
}

/// Prefixes `git commit --fixup` / `--squash` write, as Git's `skip_fixupish` tries them.
const MELD_PREFIXES: [(&str, Meld); 3] = [
    ("fixup! ", Meld::Fixup),
    ("amend! ", Meld::Amend),
    ("squash! ", Meld::Squash),
];

fn skip_meld_prefix(subject: &str) -> Option<(Meld, &str)> {
    MELD_PREFIXES
        .iter()
        .find_map(|(prefix, meld)| subject.strip_prefix(prefix).map(|rest| (*meld, rest)))
}

/// Kind of a `fixup!` / `amend!` / `squash!` commit and the subject it points to, the way
/// `git rebase --autosquash` reads it: the first prefix gives the kind, then every further
/// prefix and the whitespace around them is skipped (`fixup! squash! A` points to `A`).
/// `None` for any other commit.
pub fn meld_subject(summary: &str) -> Option<(Meld, &str)> {
    let (meld, mut rest) = skip_meld_prefix(summary)?;
    loop {
        rest = rest.trim_start_matches([' ', '\t', '\n', '\r']);
        match skip_meld_prefix(rest) {
            Some((_, next)) => rest = next,
            None => return Some((meld, rest)),
        }
    }
}

/// The message of a commit without its subject paragraph (the lines up to the first blank
/// one): what an `amend!` commit gives its target with `fixup -C`, and what a `squash!`
/// commit adds to the combined message, as Git comments its subject out.
pub fn without_subject(message: &str) -> &str {
    let mut rest = message;
    loop {
        let (line, next) = rest.split_once('\n').unwrap_or((rest, ""));
        if line.trim().is_empty() {
            break;
        }
        rest = next;
        if rest.is_empty() {
            break;
        }
    }
    rest.trim_start_matches(['\n', '\r', ' ', '\t'].as_slice())
        .trim_end()
}

/// One step of an autosquash arrangement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Pick,
    Meld(Meld),
}

/// The todo order `git rebase --autosquash` would give a range (F-147).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Autosquash {
    /// Every commit once, as `(index in the input, step)`: each matched `fixup!` / `amend!` /
    /// `squash!` commit under its target, the others picked, in their order.
    pub order: Vec<(usize, Step)>,
    /// Indexes of the `fixup!` / `amend!` / `squash!` commits whose target is not in the
    /// range: left in place.
    pub unmatched: Vec<usize>,
}

impl Autosquash {
    /// Index of the oldest commit that receives a fixup, amend or squash.
    pub fn oldest_target(&self) -> Option<usize> {
        self.order
            .windows(2)
            .find(|pair| matches!(pair[1].1, Step::Meld(_)))
            .map(|pair| pair[0].0)
    }
}

/// Moves the `fixup!`, `amend!` and `squash!` commits of `commits` (oldest first, with their
/// summary) under their target, as Git's `todo_list_rearrange_squash` does. The target is
/// the first earlier commit, not itself moved, whose summary is the subject; else, for a
/// subject without spaces, the earlier commit it names (`resolve`: a SHA prefix, a branch…);
/// else the first earlier commit whose summary starts with the subject. A commit moved under
/// one that is itself moved goes right after it (and after what was already put there),
/// like Git's chained list.
pub fn autosquash(
    commits: &[(ObjectId, &str)],
    resolve: impl Fn(&str) -> Option<ObjectId>,
) -> Autosquash {
    let n = commits.len();
    // Git's `next` / `tail` lists: what follows each commit, and the last commit put under it.
    let mut next: Vec<Option<usize>> = vec![None; n];
    let mut tail: Vec<Option<usize>> = vec![None; n];
    let mut steps = vec![Step::Pick; n];
    let mut by_summary: HashMap<&str, usize> = HashMap::new();
    let mut unmatched = Vec::new();
    for (i, (_, summary)) in commits.iter().enumerate() {
        let mut target = None;
        if let Some((meld, subject)) = meld_subject(summary) {
            target = by_summary
                .get(subject)
                .copied()
                .or_else(|| {
                    (!subject.contains(' '))
                        .then(|| resolve(subject))
                        .flatten()
                        .and_then(|id| commits[..i].iter().position(|(c, _)| *c == id))
                })
                .or_else(|| (0..i).find(|&j| commits[j].1.starts_with(subject)));
            match target {
                Some(j) => {
                    steps[i] = Step::Meld(meld);
                    let after = tail[j].unwrap_or(j);
                    next[i] = next[after];
                    next[after] = Some(i);
                    tail[j] = Some(i);
                }
                None => unmatched.push(i),
            }
        }
        if target.is_none() {
            by_summary.entry(summary).or_insert(i);
        }
    }
    let mut order = Vec::with_capacity(n);
    for i in (0..n).filter(|&i| steps[i] == Step::Pick) {
        let mut current = Some(i);
        while let Some(k) = current {
            order.push((k, steps[k]));
            current = next[k];
        }
    }
    Autosquash { order, unmatched }
}

/// The commit `name` names with `git rev-parse` rules (a SHA prefix of 4 digits or more, a
/// ref…), as Git's `lookup_commit_reference_by_name`; `None` when it names no commit.
pub fn resolve_name(repo: &gix::Repository, name: &str) -> Option<ObjectId> {
    // `:/text` would search the whole history for a message: Git does it, a reviewable
    // arrangement does not need it.
    if name.is_empty() || name.starts_with(':') {
        return None;
    }
    let id = repo.rev_parse_single(name).ok()?;
    let object = id.object().ok()?;
    Some(object.peel_to_commit().ok()?.id)
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
    fn fixup_with_a_message_replaces_the_group_message() {
        let range = [id(1), id(2), id(3)];
        let lines = plan(
            &range,
            &[
                entry(1, Pick, None),
                entry(2, Fixup, None),
                entry(3, Fixup, Some("Amended\n\nbody")),
            ],
        )
        .unwrap();
        assert_eq!(lines[0].message.as_deref(), Some("Amended\n\nbody\n"));
        assert!(lines[1..].iter().all(|l| l.command == TodoCommand::Fixup));
        // An empty `fixup -C` message is refused like an empty squash message.
        let err = plan(
            &range,
            &[
                entry(1, Pick, None),
                entry(2, Squash, None),
                entry(3, Fixup, Some(" \n")),
            ],
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument);
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

    const P: Step = Step::Pick;
    const F: Step = Step::Meld(Meld::Fixup);
    const A: Step = Step::Meld(Meld::Amend);
    const S: Step = Step::Meld(Meld::Squash);

    fn commits_of<'a>(summaries: &[&'a str]) -> Vec<(ObjectId, &'a str)> {
        summaries
            .iter()
            .enumerate()
            .map(|(i, s)| (id(u8::try_from(i).unwrap() + 0xa0), *s))
            .collect()
    }

    /// SHA prefixes only, as a repository without refs resolves them.
    fn by_sha<'a>(commits: &'a [(ObjectId, &str)]) -> impl Fn(&str) -> Option<ObjectId> + 'a {
        move |name| {
            let name = name.to_ascii_lowercase();
            (name.len() >= 4 && name.bytes().all(|b| b.is_ascii_hexdigit()))
                .then(|| {
                    commits
                        .iter()
                        .map(|(id, _)| *id)
                        .find(|id| id.to_string().starts_with(&name))
                })
                .flatten()
        }
    }

    fn arranged(summaries: &[&str]) -> (Vec<(usize, Step)>, Vec<usize>) {
        let commits = commits_of(summaries);
        let result = autosquash(&commits, by_sha(&commits));
        (result.order, result.unmatched)
    }

    #[test]
    fn reads_meld_prefixes_like_git() {
        assert_eq!(meld_subject("fixup! Add x"), Some((Meld::Fixup, "Add x")));
        assert_eq!(meld_subject("amend! Add x"), Some((Meld::Amend, "Add x")));
        assert_eq!(meld_subject("squash! Add x"), Some((Meld::Squash, "Add x")));
        // The first prefix gives the kind; the next ones and the spaces around are skipped.
        assert_eq!(
            meld_subject("fixup!   amend!  squash! Add x"),
            Some((Meld::Fixup, "Add x"))
        );
        assert_eq!(meld_subject("squash! fixup! B"), Some((Meld::Squash, "B")));
        // A prefix needs its space; without one, the rest is the subject.
        assert_eq!(
            meld_subject("fixup! fixup!C"),
            Some((Meld::Fixup, "fixup!C"))
        );
        assert_eq!(meld_subject("fixup!C"), None);
        assert_eq!(meld_subject("Add x"), None);
        assert_eq!(meld_subject("Fixup! Add x"), None);
    }

    #[test]
    fn strips_the_subject_paragraph() {
        assert_eq!(
            without_subject("amend! B\n\nB new\n\nbody\n"),
            "B new\n\nbody"
        );
        assert_eq!(without_subject("squash! A\nmore\n\n  \nbody"), "body");
        assert_eq!(without_subject("amend! B"), "");
        assert_eq!(without_subject("amend! B\n"), "");
    }

    #[test]
    fn moves_fixups_under_their_target() {
        let (order, unmatched) =
            arranged(&["A", "B", "fixup! A", "C", "fixup! fixup! A", "fixup! B"]);
        assert_eq!(order, [(0, P), (2, F), (4, F), (1, P), (5, F), (3, P)]);
        assert!(unmatched.is_empty());
        let commits = commits_of(&["A", "fixup! A"]);
        assert_eq!(
            autosquash(&commits, by_sha(&commits)).oldest_target(),
            Some(0)
        );
    }

    #[test]
    fn arranges_squash_and_amend_commits() {
        // `git rebase -i --autosquash` (2.43) on the same summaries gives this todo.
        let (order, unmatched) = arranged(&[
            "A",
            "B",
            "squash! A",
            "amend! B",
            "fixup! squash! A",
            "squash! fixup! B",
            "amend! A",
            "squash! A",
        ]);
        assert_eq!(
            order,
            [
                (0, P),
                (2, S),
                (4, F),
                (6, A),
                (7, S),
                (1, P),
                (3, A),
                (5, S)
            ]
        );
        assert!(unmatched.is_empty());
        let commits = commits_of(&["A", "squash! A"]);
        assert_eq!(
            autosquash(&commits, by_sha(&commits)).oldest_target(),
            Some(0)
        );
    }

    #[test]
    fn matches_like_git() {
        // The first commit with the subject wins; then a SHA prefix; then a summary prefix.
        let (order, _) = arranged(&["Same", "Same", "fixup! Same"]);
        assert_eq!(order, [(0, P), (2, F), (1, P)]);
        let sha = id(0xa1).to_string();
        let by_sha = format!("fixup! {}", &sha[..7]);
        let (order, _) = arranged(&["A", "B", &by_sha]);
        assert_eq!(order, [(0, P), (1, P), (2, F)]);
        let (order, _) = arranged(&["Add the parser and tests", "squash! Add the parser"]);
        assert_eq!(order, [(0, P), (1, S)]);
        // Only commits left in place are matched by summary; a fixup of a fixup points to
        // the same target, after the first one.
        let (order, _) = arranged(&["A x", "fixup! A x", "fixup! fixup! A x"]);
        assert_eq!(order, [(0, P), (1, F), (2, F)]);
    }

    #[test]
    fn chains_a_fixup_of_a_moved_commit_after_it() {
        // `fixup! <sha of the first fixup>`: right after that fixup, before the next fixup of
        // the same target (Git's `next` list), not at the end of the group.
        let first = id(0xa1).to_string();
        let by_sha = format!("fixup! {}", &first[..8]);
        let (order, _) = arranged(&["A", "fixup! A", "fixup! A", &by_sha]);
        assert_eq!(order, [(0, P), (1, F), (3, F), (2, F)]);
    }

    #[test]
    fn resolves_other_names_without_spaces() {
        let commits = commits_of(&["A", "B", "fixup! topic", "fixup! some topic"]);
        let resolve = |name: &str| (name == "topic").then(|| id(0xa0));
        let result = autosquash(&commits, resolve);
        // "some topic" has a space: never looked up as a name, and matches nothing.
        assert_eq!(result.order, [(0, P), (2, F), (1, P), (3, P)]);
        assert_eq!(result.unmatched, [3]);
        // A name is only matched to an earlier commit.
        let commits = commits_of(&["fixup! later", "A"]);
        let result = autosquash(&commits, |name: &str| (name == "later").then(|| id(0xa1)));
        assert_eq!(result.order, [(0, P), (1, P)]);
        assert_eq!(result.unmatched, [0]);
    }

    #[test]
    fn leaves_unmatched_fixups_in_place() {
        // No target, a target after the fixup, an empty subject (Git trims it: no prefix).
        let (order, unmatched) = arranged(&["fixup! Gone", "squash! Later", "Later", "fixup!"]);
        assert_eq!(order, [(0, P), (1, P), (2, P), (3, P)]);
        assert_eq!(unmatched, [0, 1]);
        // A fixup of an unmatched fixup has no target either: every prefix is skipped.
        let (order, unmatched) = arranged(&["fixup! Gone", "fixup! fixup! Gone"]);
        assert_eq!(order, [(0, P), (1, P)]);
        assert_eq!(unmatched, [0, 1]);
        let commits = commits_of(&["A"]);
        assert_eq!(autosquash(&commits, by_sha(&commits)).oldest_target(), None);
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
