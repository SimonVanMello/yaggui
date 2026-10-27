//! The context sent to the provider (F-075): the staged changes (and the amended commit's),
//! read through the diff read path without writing anything, cut to the byte budgets of the
//! preferences.

use std::fmt::Write as _;

use super::glob;
use super::types::{AiContextSummary, AiMessageRequest, AiPreferences};
use crate::git::errors::{BackendError, YagguiError};
use crate::git::read::diff::{
    self,
    types::{ChangedFile, DiffContent, DiffOptions, DiffTarget, FileStatus, TextDiff},
};

/// Files listed by name at most per section: a commit of 50,000 files does not need them all.
const LISTED_FILES_MAX: usize = 500;
/// Below this many bytes left, a file's diff is left out rather than cut to almost nothing.
const MIN_USEFUL_DIFF: usize = 200;
/// A subject longer than this is cut: a style example needs no more.
const SUBJECT_MAX_CHARS: usize = 200;

/// What a file of the context shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileBody {
    /// Unified diff text, complete.
    Diff(String),
    Binary,
    /// A short description instead of a diff (submodule commit, LFS object).
    Note(String),
    /// Above the size guards of the diff reader.
    TooLarge,
    /// Matches an excluded path: never read.
    Excluded,
    /// Not read because the budget was spent.
    NotRead,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub body: FileBody,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextSection {
    pub title: &'static str,
    pub files: Vec<ContextFile>,
}

/// Everything read from the repository, before it is rendered.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContextInput {
    /// Short branch name; `None` on a detached HEAD.
    pub branch: Option<String>,
    pub amend: bool,
    /// Newest first.
    pub recent_subjects: Vec<String>,
    pub sections: Vec<ContextSection>,
}

impl ContextInput {
    pub fn is_empty(&self) -> bool {
        self.sections.iter().all(|s| s.files.is_empty())
    }
}

pub const STAGED_TITLE: &str = "Staged changes";
pub const AMENDED_TITLE: &str = "Changes of the commit being amended (HEAD)";

/// Reads the context of `request` from `repo`; `staged` is the staged file list (from the
/// repository session, which caches the status). Nothing is written to the repository: the
/// diffs come from the object database, the index and the working tree.
pub fn read(
    repo: &gix::Repository,
    staged: Vec<ChangedFile>,
    request: AiMessageRequest,
    prefs: &AiPreferences,
) -> Result<ContextInput, YagguiError> {
    let head = repo.head().map_err(|e| BackendError::gix("read HEAD", e))?;
    let unborn = head.is_unborn();
    let branch = head.referent_name().map(|name| name.shorten().to_string());
    let mut sections = Vec::new();
    let mut budget = Budget::new(prefs);
    if request.amend && !unborn {
        let target = DiffTarget::Commits {
            from: None,
            to: "HEAD".to_owned(),
        };
        let files = diff::changed_files(repo, &target)?.files;
        sections.push(ContextSection {
            title: AMENDED_TITLE,
            files: read_files(repo, &target, files, prefs, &mut budget)?,
        });
    }
    sections.push(ContextSection {
        title: STAGED_TITLE,
        files: read_files(repo, &DiffTarget::Staged, staged, prefs, &mut budget)?,
    });
    let recent_subjects = if unborn {
        Vec::new()
    } else {
        // The amended commit's own subject would be copied rather than serve as an example.
        recent_subjects(
            repo,
            usize::from(prefs.recent_subjects),
            usize::from(request.amend),
        )?
    };
    Ok(ContextInput {
        branch,
        amend: request.amend && !unborn,
        recent_subjects,
        sections,
    })
}

/// Bytes of diff still allowed, so files are not read once nothing more can be sent.
struct Budget {
    left: usize,
}

impl Budget {
    fn new(prefs: &AiPreferences) -> Self {
        Self {
            left: prefs.max_diff_bytes as usize,
        }
    }
}

fn read_files(
    repo: &gix::Repository,
    target: &DiffTarget,
    files: Vec<ChangedFile>,
    prefs: &AiPreferences,
    budget: &mut Budget,
) -> Result<Vec<ContextFile>, YagguiError> {
    let options = DiffOptions::default();
    let mut out = Vec::with_capacity(files.len());
    for file in files {
        let excluded = prefs
            .excluded_paths
            .iter()
            .any(|p| glob::matches(p, &file.path));
        let body = if excluded {
            FileBody::Excluded
        } else if file.binary {
            FileBody::Binary
        } else if budget.left < MIN_USEFUL_DIFF {
            FileBody::NotRead
        } else {
            let read =
                diff::file_diff(repo, target, &file.path, file.old_path.as_deref(), &options)?;
            let body = body_of(&read.content, &file);
            if let FileBody::Diff(text) = &body {
                let sent = text.len().min(prefs.max_file_bytes as usize);
                budget.left = budget.left.saturating_sub(sent);
            }
            body
        };
        out.push(ContextFile {
            path: file.path,
            old_path: file.old_path,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            body,
        });
    }
    Ok(out)
}

fn body_of(content: &DiffContent, file: &ChangedFile) -> FileBody {
    match content {
        DiffContent::Text(text) => FileBody::Diff(unified(text, file)),
        DiffContent::Binary { .. } => FileBody::Binary,
        DiffContent::TooLarge { .. } => FileBody::TooLarge,
        DiffContent::Lfs { .. } => FileBody::Note("Git LFS object".to_owned()),
        DiffContent::Submodule {
            old_commit,
            new_commit,
        } => FileBody::Note(format!(
            "submodule {} -> {}",
            old_commit.as_deref().unwrap_or("(none)"),
            new_commit.as_deref().unwrap_or("(none)")
        )),
        DiffContent::Conflict => FileBody::Note("unresolved conflict".to_owned()),
    }
}

/// `git diff`-like text of one file.
fn unified(text: &TextDiff, file: &ChangedFile) -> String {
    let old = file.old_path.as_deref().unwrap_or(&file.path);
    let mut out = String::new();
    let _ = writeln!(out, "diff --git a/{old} b/{}", file.path);
    let (from, to) = match file.status {
        FileStatus::Added | FileStatus::Untracked => {
            ("/dev/null".to_owned(), format!("b/{}", file.path))
        }
        FileStatus::Deleted => (format!("a/{old}"), "/dev/null".to_owned()),
        _ => (format!("a/{old}"), format!("b/{}", file.path)),
    };
    let _ = writeln!(out, "--- {from}\n+++ {to}");
    for hunk in &text.hunks {
        let _ = write!(
            out,
            "@@ -{},{} +{},{} @@",
            hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines
        );
        if !hunk.header.is_empty() {
            let _ = write!(out, " {}", hunk.header);
        }
        out.push('\n');
        for (kind, line) in hunk.kinds.chars().zip(&hunk.lines) {
            out.push(kind);
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn recent_subjects(
    repo: &gix::Repository,
    count: usize,
    skip: usize,
) -> Result<Vec<String>, YagguiError> {
    let mut subjects = Vec::new();
    if count == 0 {
        return Ok(subjects);
    }
    let mut next = Some(
        repo.head_id()
            .map_err(|e| BackendError::gix("read HEAD", e))?
            .detach(),
    );
    let mut skipped = 0;
    // Bounded walk: merges are skipped, but a long run of them must not walk the history.
    for _ in 0..(count + skip) * 4 {
        let Some(id) = next else { break };
        let commit = repo
            .find_commit(id)
            .map_err(|e| BackendError::gix("read a commit", e))?;
        let mut parents = commit.parent_ids();
        next = parents.next().map(|p| p.detach());
        let merge = parents.next().is_some();
        if skipped < skip {
            skipped += 1;
            continue;
        }
        if merge {
            continue;
        }
        let message = commit.message_raw_sloppy().to_string();
        let subject: String = message
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .chars()
            .take(SUBJECT_MAX_CHARS)
            .collect();
        if !subject.is_empty() {
            subjects.push(subject);
        }
        if subjects.len() == count {
            break;
        }
    }
    Ok(subjects)
}

/// The context block appended after the instructions, and what it holds.
pub fn render(input: &ContextInput, prefs: &AiPreferences) -> (String, AiContextSummary) {
    let mut summary = AiContextSummary::default();
    let mut out = String::new();
    out.push_str("<context>\n");
    match &input.branch {
        Some(branch) => {
            let _ = writeln!(out, "Branch: {branch}");
        }
        None => out.push_str("Branch: (detached HEAD)\n"),
    }
    if input.amend {
        out.push_str("The new message replaces the message of the HEAD commit (amend): describe its changes and the staged ones together.\n");
    }
    if !input.recent_subjects.is_empty() {
        out.push_str(
            "\nRecent commit subjects of the branch, newest first (style examples only):\n",
        );
        for subject in &input.recent_subjects {
            let _ = writeln!(out, "- {subject}");
        }
    }

    let mut left = prefs.max_diff_bytes as usize;
    let per_file = prefs.max_file_bytes as usize;
    for section in &input.sections {
        if section.files.is_empty() {
            continue;
        }
        summary.files += u32::try_from(section.files.len()).unwrap_or(u32::MAX);
        let _ = writeln!(
            out,
            "\n## {} ({} files)\n",
            section.title,
            section.files.len()
        );
        let mut diffs = String::new();
        for (index, file) in section.files.iter().enumerate() {
            let note = match &file.body {
                FileBody::Diff(text) => {
                    if left < MIN_USEFUL_DIFF {
                        summary.omitted_files.push(file.path.clone());
                        Some("diff not sent: size limit reached")
                    } else {
                        let cap = per_file.min(left);
                        let (kept, cut) = cut_at_line(text, cap);
                        left -= kept.len();
                        diffs.push_str(kept);
                        if cut > 0 {
                            let _ = writeln!(diffs, "[... {cut} more bytes of this diff not sent]");
                            summary.truncated_files.push(file.path.clone());
                        }
                        None
                    }
                }
                FileBody::Binary => {
                    summary.binary_files.push(file.path.clone());
                    Some("binary")
                }
                FileBody::Note(note) => {
                    let _ = writeln!(diffs, "diff of {}: {note}", file.path);
                    None
                }
                FileBody::TooLarge => {
                    summary.truncated_files.push(file.path.clone());
                    Some("diff too large to send")
                }
                FileBody::Excluded => {
                    summary.excluded_files.push(file.path.clone());
                    Some("diff not sent: excluded")
                }
                FileBody::NotRead => {
                    summary.omitted_files.push(file.path.clone());
                    Some("diff not sent: size limit reached")
                }
            };
            if index < LISTED_FILES_MAX {
                list_file(&mut out, file, note);
            }
        }
        if section.files.len() > LISTED_FILES_MAX {
            let _ = writeln!(
                out,
                "... and {} more files",
                section.files.len() - LISTED_FILES_MAX
            );
        }
        if !diffs.is_empty() {
            out.push_str("\n<diff>\n");
            out.push_str(&diffs);
            out.push_str("</diff>\n");
        }
    }
    out.push_str("</context>\n");
    (out, summary)
}

fn list_file(out: &mut String, file: &ContextFile, note: Option<&str>) {
    let status = match file.status {
        FileStatus::Added | FileStatus::Untracked => "A",
        FileStatus::Modified => "M",
        FileStatus::Deleted => "D",
        FileStatus::Renamed => "R",
        FileStatus::Copied => "C",
        FileStatus::TypeChanged => "T",
        FileStatus::Conflicted => "U",
    };
    let _ = write!(out, "{status} ");
    if let Some(old) = &file.old_path {
        let _ = write!(out, "{old} -> ");
    }
    out.push_str(&file.path);
    if let (Some(add), Some(del)) = (file.additions, file.deletions) {
        let _ = write!(out, " (+{add} -{del})");
    }
    if let Some(note) = note {
        let _ = write!(out, " [{note}]");
    }
    out.push('\n');
}

/// The longest start of `text` within `max` bytes that ends at a line end (or at a char
/// boundary when the first line alone is longer), and the bytes left out.
fn cut_at_line(text: &str, max: usize) -> (&str, usize) {
    if text.len() <= max {
        return (text, 0);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    if let Some(newline) = text[..end].rfind('\n') {
        end = newline + 1;
    }
    (&text[..end], text.len() - end)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, body: FileBody) -> ContextFile {
        ContextFile {
            path: path.to_owned(),
            old_path: None,
            status: FileStatus::Modified,
            additions: Some(1),
            deletions: Some(0),
            body,
        }
    }

    fn input(files: Vec<ContextFile>) -> ContextInput {
        ContextInput {
            branch: Some("main".into()),
            amend: false,
            recent_subjects: vec!["Fix the graph".into()],
            sections: vec![ContextSection {
                title: STAGED_TITLE,
                files,
            }],
        }
    }

    fn prefs(total: u32, per_file: u32) -> AiPreferences {
        AiPreferences {
            max_diff_bytes: total,
            max_file_bytes: per_file,
            ..AiPreferences::default()
        }
    }

    #[test]
    fn renders_files_diffs_and_subjects() {
        let (text, summary) = render(
            &input(vec![
                file(
                    "a.rs",
                    FileBody::Diff("diff --git a/a.rs b/a.rs\n+x\n".into()),
                ),
                file("logo.png", FileBody::Binary),
                file("Cargo.lock", FileBody::Excluded),
            ]),
            &prefs(10_000, 10_000),
        );
        assert!(text.contains("Branch: main"));
        assert!(text.contains("- Fix the graph"));
        assert!(text.contains("M a.rs (+1 -0)\n"));
        assert!(text.contains("M logo.png (+1 -0) [binary]"));
        assert!(text.contains("M Cargo.lock (+1 -0) [diff not sent: excluded]"));
        assert!(text.contains("<diff>\ndiff --git a/a.rs b/a.rs\n+x\n</diff>"));
        assert_eq!(summary.files, 3);
        assert_eq!(summary.binary_files, vec!["logo.png"]);
        assert_eq!(summary.excluded_files, vec!["Cargo.lock"]);
        assert!(summary.truncated_files.is_empty());
    }

    #[test]
    fn cuts_each_file_then_stops_at_the_total() {
        let long = "+line\n".repeat(200); // 1200 bytes
        let (text, summary) = render(
            &input(vec![
                file("a", FileBody::Diff(long.clone())),
                file("b", FileBody::Diff(long.clone())),
                file("c", FileBody::Diff(long.clone())),
                file("d", FileBody::NotRead),
            ]),
            &prefs(1_000, 500),
        );
        assert_eq!(summary.truncated_files, vec!["a", "b"]);
        assert_eq!(summary.omitted_files, vec!["c", "d"]);
        assert!(text.contains("[... 702 more bytes of this diff not sent]"));
        let diff = text.split("<diff>\n").nth(1).unwrap();
        // Two cuts of 498 bytes (83 whole lines) and their notes.
        assert_eq!(diff.matches("+line\n").count(), 166);
    }

    #[test]
    fn cuts_on_a_line_or_char_boundary() {
        assert_eq!(cut_at_line("ab\ncd\n", 4), ("ab\n", 3));
        assert_eq!(cut_at_line("ééé", 3), ("é", 4));
        assert_eq!(cut_at_line("abc", 10), ("abc", 0));
    }

    #[test]
    fn unified_text_has_git_headers() {
        let text = TextDiff {
            hunks: vec![crate::git::read::diff::types::DiffHunk {
                id: String::new(),
                old_start: 0,
                old_lines: 0,
                new_start: 1,
                new_lines: 1,
                header: String::new(),
                kinds: "+".into(),
                lines: vec!["hello".into()],
            }],
            additions: 1,
            deletions: 0,
            old_encoding: crate::git::read::diff::types::TextEncoding::Utf8,
            new_encoding: crate::git::read::diff::types::TextEncoding::Utf8,
            old_line_ending: crate::git::read::diff::types::LineEnding::None,
            new_line_ending: crate::git::read::diff::types::LineEnding::Lf,
            old_missing_newline: false,
            new_missing_newline: false,
            old_line_count: 0,
            new_line_count: 1,
        };
        let changed = ChangedFile {
            path: "new.txt".into(),
            old_path: None,
            status: FileStatus::Added,
            similarity: None,
            additions: Some(1),
            deletions: Some(0),
            binary: false,
            old_mode: None,
            new_mode: None,
        };
        assert_eq!(
            unified(&text, &changed),
            "diff --git a/new.txt b/new.txt\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello\n"
        );
    }
}
