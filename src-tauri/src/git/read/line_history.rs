//! History of a line range (F-223): payloads, the parsing of `git log -L` and the mapping of
//! working tree lines to HEAD lines.
//!
//! `git log -L<start>,<end>:<path> <rev>` walks the commits that changed the range, follows it
//! as lines are added or removed around it and across renames of the file, and prints for each
//! commit the whole range as it was before and after (one hunk per range). The walk itself runs
//! in `repo/inspect.rs`.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::read::diff::text::HunkSpan;
use crate::git::read::diff::types::{DiffHunk, FileStatus, LineEnding, TextDiff, TextEncoding};

/// Maximum entries per page.
pub const LINE_HISTORY_PAGE_MAX: u32 = 500;

/// Largest range accepted: Git prints the whole range for every commit, so a page costs about
/// `entries × range` lines.
pub const LINE_RANGE_MAX: u32 = 5_000;

/// Range lines a page aims at (`entries × range`): a wide range gets shorter pages.
pub const PAGE_LINE_BUDGET: u32 = 100_000;

/// `git log` format of one entry: record separator, fields separated by `\x1f`, a final `\x1f`
/// before the end of the line, then the patch.
pub const LOG_FORMAT: &str = "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f";

/// Lines to follow, as the user selected them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LineHistoryRequest {
    /// Repository-relative path in `rev` (or the working tree).
    pub path: String,
    /// Version the line numbers refer to; `None`: the working tree file, whose lines are
    /// mapped to those of HEAD first.
    pub rev: Option<String>,
    /// First line, 1-based.
    pub start: u32,
    /// Last line, 1-based, inclusive.
    pub end: u32,
}

/// The range the walk follows: a commit, the file's path in it and committed line numbers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LineRange {
    /// Full SHA.
    pub rev: String,
    pub path: String,
    /// 1-based, inclusive.
    pub start: u32,
    pub end: u32,
}

/// Where the next page starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LineHistoryCursor {
    pub range: LineRange,
    /// Entries already returned.
    pub skip: u32,
}

/// One commit that changed the range.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LineHistoryEntry {
    pub sha: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Seconds since the Unix epoch.
    pub author_time: f64,
    pub summary: String,
    /// Path of the file in this commit.
    pub path: String,
    /// Path in the parent when this commit renamed the file.
    pub old_path: Option<String>,
    /// `added` when the commit created the file, `renamed` with `old_path`, else `modified`.
    pub status: FileStatus,
    /// The range before and after the commit. `None` for a merge, which Git lists without a
    /// diff when the range differs from every parent.
    pub diff: Option<TextDiff>,
    /// The lines do not exist before this commit (file created, or lines written or moved
    /// here): the history of the range ends with it.
    pub origin: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LineHistoryPage {
    /// The range followed, in committed line numbers (the working tree lines of the request
    /// mapped to HEAD).
    pub range: LineRange,
    /// Newest first.
    pub entries: Vec<LineHistoryEntry>,
    /// `None` at the end of the range's history.
    pub next: Option<LineHistoryCursor>,
}

/// Entries to ask Git for in one page of a range of `lines` lines.
pub fn page_size(limit: u32, lines: u32) -> u32 {
    let by_budget = PAGE_LINE_BUDGET / lines.max(1);
    limit.clamp(1, LINE_HISTORY_PAGE_MAX).min(by_budget.max(1))
}

/// Unquotes a path Git printed C-style (`"a/t\tb"`); other paths come back as they are.
fn unquote(raw: &str) -> String {
    let Some(inner) = raw
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    else {
        return raw.to_owned();
    };
    let mut bytes = Vec::with_capacity(inner.len());
    let mut chars = inner.bytes().peekable();
    while let Some(byte) = chars.next() {
        if byte != b'\\' {
            bytes.push(byte);
            continue;
        }
        match chars.next() {
            Some(b'n') => bytes.push(b'\n'),
            Some(b't') => bytes.push(b'\t'),
            Some(b'r') => bytes.push(b'\r'),
            Some(b'a') => bytes.push(0x07),
            Some(b'b') => bytes.push(0x08),
            Some(b'f') => bytes.push(0x0c),
            Some(b'v') => bytes.push(0x0b),
            Some(digit @ b'0'..=b'7') => {
                let mut value = u32::from(digit - b'0');
                for _ in 0..2 {
                    match chars.peek() {
                        Some(&next @ b'0'..=b'7') => {
                            value = value * 8 + u32::from(next - b'0');
                            chars.next();
                        }
                        _ => break,
                    }
                }
                bytes.push(u8::try_from(value).unwrap_or(u8::MAX));
            }
            Some(other) => bytes.push(other),
            None => bytes.push(b'\\'),
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Path of a `--- ` / `+++ ` line without its `a/` / `b/` prefix; `None` for `/dev/null`.
fn side_path(raw: &str, prefix: &str) -> Option<String> {
    if raw == "/dev/null" {
        return None;
    }
    let path = unquote(raw);
    Some(
        path.strip_prefix(prefix)
            .map_or(path.clone(), str::to_owned),
    )
}

/// `-a,b` or `+c,d` (the count defaults to 1, as in Git).
fn parse_range(part: &str) -> Option<(u32, u32)> {
    let digits = part.get(1..)?;
    match digits.split_once(',') {
        Some((start, lines)) => Some((start.parse().ok()?, lines.parse().ok()?)),
        None => Some((digits.parse().ok()?, 1)),
    }
}

fn hunk_of(line: &str) -> Option<DiffHunk> {
    let mut parts = line.strip_prefix("@@ ")?.split(' ');
    let (old_start, old_lines) = parse_range(parts.next()?)?;
    let (new_start, new_lines) = parse_range(parts.next()?)?;
    Some(DiffHunk {
        id: format!("-{old_start},{old_lines}+{new_start},{new_lines}"),
        old_start,
        old_lines,
        new_start,
        new_lines,
        header: String::new(),
        kinds: String::new(),
        lines: Vec::new(),
    })
}

#[derive(Default)]
struct Endings {
    crlf: u32,
    lf: u32,
}

impl Endings {
    fn add(&mut self, crlf: bool) {
        if crlf {
            self.crlf += 1;
        } else {
            self.lf += 1;
        }
    }

    fn ending(&self) -> LineEnding {
        match (self.lf, self.crlf) {
            (0, 0) => LineEnding::None,
            (_, 0) => LineEnding::Lf,
            (0, _) => LineEnding::Crlf,
            _ => LineEnding::Mixed,
        }
    }
}

/// The diff of one entry: hunks of the range, with line counts that make the gutters and the
/// "no newline" marks of the diff view right.
struct Patch {
    old_path: Option<String>,
    new_path: Option<String>,
    created: bool,
    diff: TextDiff,
}

fn parse_patch(patch: &str) -> Option<Patch> {
    let mut old_path = None;
    let mut new_path = None;
    let mut created = false;
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let (mut additions, mut deletions) = (0, 0);
    let (mut old_endings, mut new_endings) = (Endings::default(), Endings::default());
    let (mut old_missing, mut new_missing) = (false, false);
    let mut last_kind = b' ';
    let mut in_hunk = false;
    for line in patch.split('\n') {
        if line.starts_with("diff --git ") {
            in_hunk = false;
            continue;
        }
        if let Some(hunk) = hunks.last_mut().filter(|_| in_hunk) {
            let kind = line.as_bytes().first().copied();
            match kind {
                Some(kind @ (b' ' | b'-' | b'+')) => {
                    let text = &line[1..];
                    let crlf = text.ends_with('\r');
                    match kind {
                        b'-' => {
                            deletions += 1;
                            old_endings.add(crlf);
                        }
                        b'+' => {
                            additions += 1;
                            new_endings.add(crlf);
                        }
                        _ => {
                            old_endings.add(crlf);
                            new_endings.add(crlf);
                        }
                    }
                    hunk.kinds.push(char::from(kind));
                    hunk.lines
                        .push(text.strip_suffix('\r').unwrap_or(text).to_owned());
                    last_kind = kind;
                    continue;
                }
                Some(b'\\') => {
                    match last_kind {
                        b'-' => old_missing = true,
                        b'+' => new_missing = true,
                        _ => {
                            old_missing = true;
                            new_missing = true;
                        }
                    }
                    continue;
                }
                _ => {}
            }
        }
        if let Some(raw) = line.strip_prefix("--- ") {
            old_path = side_path(raw, "a/");
            created = old_path.is_none();
        } else if let Some(raw) = line.strip_prefix("+++ ") {
            new_path = side_path(raw, "b/");
        } else if let Some(hunk) = hunk_of(line) {
            hunks.push(hunk);
            in_hunk = true;
        }
    }
    if hunks.is_empty() {
        return None;
    }
    // A side ends at the last line of its last hunk: the "no newline" mark goes there.
    let end = |start: u32, lines: u32| (start + lines).saturating_sub(1);
    let old_line_count = hunks
        .iter()
        .map(|h| end(h.old_start, h.old_lines))
        .max()
        .unwrap_or(0);
    let new_line_count = hunks
        .iter()
        .map(|h| end(h.new_start, h.new_lines))
        .max()
        .unwrap_or(0);
    Some(Patch {
        old_path,
        new_path,
        created,
        diff: TextDiff {
            hunks,
            additions,
            deletions,
            // Git's output is read as UTF-8 (invalid bytes replaced).
            old_encoding: TextEncoding::Utf8,
            new_encoding: TextEncoding::Utf8,
            old_line_ending: old_endings.ending(),
            new_line_ending: new_endings.ending(),
            old_missing_newline: old_missing,
            new_missing_newline: new_missing,
            old_line_count,
            new_line_count,
        },
    })
}

/// Parses `git log <LOG_FORMAT> -L<range>:<path> --src-prefix=a/ --dst-prefix=b/`. `path` is
/// the file's path at the start of the walk, kept by entries without a diff (merges).
pub fn parse_log(output: &str, path: &str) -> Vec<LineHistoryEntry> {
    let mut entries = Vec::new();
    let mut current_path = path.to_owned();
    for record in output.split('\x1e').filter(|r| !r.is_empty()) {
        let Some((header, patch)) = record
            .split_once("\x1f\n")
            .or_else(|| record.strip_suffix('\x1f').map(|header| (header, "")))
        else {
            continue;
        };
        let mut fields = header.split('\x1f');
        let mut next = || fields.next().unwrap_or_default().to_owned();
        let sha = next();
        if sha.len() < 40 {
            continue;
        }
        let parents = next()
            .split(' ')
            .filter(|p| !p.is_empty())
            .map(str::to_owned)
            .collect();
        let author_name = next();
        let author_email = next();
        let author_time = next().trim().parse::<f64>().unwrap_or(0.0);
        let summary = next();
        let (path, old_path, status, diff, origin) = match parse_patch(patch) {
            Some(patch) => {
                let new_path = patch
                    .new_path
                    .or_else(|| patch.old_path.clone())
                    .unwrap_or_else(|| current_path.clone());
                let (old_path, status) = match patch.old_path {
                    _ if patch.created => (None, FileStatus::Added),
                    Some(old) if old != new_path => (Some(old), FileStatus::Renamed),
                    _ => (None, FileStatus::Modified),
                };
                let origin = patch.diff.hunks.iter().all(|h| h.old_lines == 0);
                // Older commits name the file as it was before the rename.
                current_path = old_path.clone().unwrap_or_else(|| new_path.clone());
                (new_path, old_path, status, Some(patch.diff), origin)
            }
            None => (
                current_path.clone(),
                None,
                FileStatus::Modified,
                None,
                false,
            ),
        };
        entries.push(LineHistoryEntry {
            sha,
            parents,
            author_name,
            author_email,
            author_time,
            summary,
            path,
            old_path,
            status,
            diff,
            origin,
        });
    }
    entries
}

/// Where a working tree line is in HEAD.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Base {
    /// Unchanged: this HEAD line (0-based).
    Line(u32),
    /// Changed: it replaces HEAD lines `first .. first + count` (count 0: it was inserted
    /// before HEAD line `first`).
    Replaces { first: u32, count: u32 },
}

fn base_of(spans: &[HunkSpan], line: u32) -> Base {
    let mut delta: i64 = 0;
    for span in spans {
        if line < span.new_first {
            break;
        }
        if line < span.new_first + span.new_lines {
            return Base::Replaces {
                first: span.old_first,
                count: span.old_lines,
            };
        }
        delta += i64::from(span.old_lines) - i64::from(span.new_lines);
    }
    Base::Line(u32::try_from(i64::from(line) + delta).unwrap_or(0))
}

/// Maps the working tree lines `start ..= end` (1-based) to HEAD lines, through the hunks of
/// the HEAD → working tree diff computed without context. Changed lines stand for the HEAD
/// lines they replace; lines only added are dropped. `None` when no line of the range is in
/// HEAD.
pub fn map_to_head(spans: &[HunkSpan], start: u32, end: u32) -> Option<(u32, u32)> {
    let first = match base_of(spans, start.saturating_sub(1)) {
        Base::Line(line) | Base::Replaces { first: line, .. } => line + 1,
    };
    let last = match base_of(spans, end.saturating_sub(1)) {
        Base::Line(line) => line + 1,
        // One past the replaced lines, as 1-based numbers: the last one replaced, or the line
        // before an insertion.
        Base::Replaces { first, count } => first + count,
    };
    (first <= last).then_some((first, last))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::read::diff::text::hunk_spans;
    use crate::git::read::diff::types::DiffOptions;
    use gix::diff::blob::Algorithm;

    const A: &str = "1111111111111111111111111111111111111111";
    const B: &str = "2222222222222222222222222222222222222222";
    const C: &str = "3333333333333333333333333333333333333333";
    const D: &str = "4444444444444444444444444444444444444444";

    #[test]
    fn parses_edits_renames_merges_and_the_origin() {
        let output = format!(
            "\x1e{D}\x1f{B} {C}\x1fAda\x1fada@x\x1f400\x1fMerge side\x1f\n\n\
             \x1e{C}\x1f{B}\x1fBob\x1fbob@x\x1f300\x1fmove\x1f\n\n\
             diff --git a/src/app.txt b/lib/app.txt\n--- a/src/app.txt\n+++ b/lib/app.txt\n\
             @@ -8,2 +8,2 @@\n-a5 v2\n+a5 v3\n a6\n\
             \x1e{B}\x1f{A}\x1fBob\x1fbob@x\x1f200\x1fedit\x1f\n\n\
             diff --git a/src/app.txt b/src/app.txt\n--- a/src/app.txt\n+++ b/src/app.txt\n\
             @@ -5,2 +5,2 @@\n-a5\r\n+a5 v2\r\n a6\r\n\
             \x1e{A}\x1f\x1fAda\x1fada@x\x1f100\x1fadd\x1f\n\n\
             diff --git a/src/app.txt b/src/app.txt\n--- /dev/null\n+++ b/src/app.txt\n\
             @@ -0,0 +5,2 @@\n+a5\n+a6\n\\ No newline at end of file\n"
        );
        let entries = parse_log(&output, "lib/app.txt");
        assert_eq!(entries.len(), 4);

        let merge = &entries[0];
        assert_eq!(merge.parents, vec![B.to_owned(), C.to_owned()]);
        assert_eq!(merge.diff, None);
        assert_eq!(merge.path, "lib/app.txt");
        assert!(!merge.origin);

        let moved = &entries[1];
        assert_eq!(moved.status, FileStatus::Renamed);
        assert_eq!(moved.path, "lib/app.txt");
        assert_eq!(moved.old_path.as_deref(), Some("src/app.txt"));
        let diff = moved.diff.as_ref().unwrap();
        assert_eq!(diff.hunks.len(), 1);
        assert_eq!(diff.hunks[0].kinds, "-+ ");
        assert_eq!(diff.hunks[0].lines, vec!["a5 v2", "a5 v3", "a6"]);
        assert_eq!((diff.additions, diff.deletions), (1, 1));
        assert_eq!((diff.old_line_count, diff.new_line_count), (9, 9));

        let edit = &entries[2];
        assert_eq!(edit.path, "src/app.txt");
        assert_eq!(edit.status, FileStatus::Modified);
        let diff = edit.diff.as_ref().unwrap();
        assert_eq!(diff.hunks[0].lines[0], "a5");
        assert_eq!(diff.new_line_ending, LineEnding::Crlf);

        let add = &entries[3];
        assert_eq!(add.status, FileStatus::Added);
        assert!(add.origin);
        assert!(add.parents.is_empty());
        let diff = add.diff.as_ref().unwrap();
        assert_eq!(diff.hunks[0].id, "-0,0+5,2");
        assert!(diff.new_missing_newline);
        assert!(!diff.old_missing_newline);
        assert!((add.author_time - 100.0).abs() < f64::EPSILON);
    }

    #[test]
    fn lines_moved_into_the_file_are_an_origin_and_merges_keep_the_older_name() {
        let output = format!(
            "\x1e{C}\x1f{B}\x1fBob\x1fbob@x\x1f300\x1fmove tail\x1f\n\n\
             diff --git a/lib/app.txt b/lib/app.txt\n--- a/lib/app.txt\n+++ b/lib/app.txt\n\
             @@ -0,0 +1,2 @@\n+a9\n+a10\n"
        );
        let entries = parse_log(&output, "lib/app.txt");
        assert_eq!(entries[0].status, FileStatus::Modified);
        assert!(entries[0].origin);

        let renamed_then_merge = format!(
            "\x1e{C}\x1f{B}\x1fBob\x1fbob@x\x1f300\x1fmove\x1f\n\n\
             diff --git a/old.txt b/new.txt\n--- a/old.txt\n+++ b/new.txt\n\
             @@ -1,1 +1,1 @@\n-x\n+y\n\
             \x1e{B}\x1f{A} {D}\x1fBob\x1fbob@x\x1f200\x1fmerge\x1f\n\n"
        );
        let entries = parse_log(&renamed_then_merge, "new.txt");
        assert_eq!(entries[1].path, "old.txt");
    }

    #[test]
    fn unquotes_c_style_paths() {
        assert_eq!(unquote("\"a/t\\tb\\\"q\\\\\""), "a/t\tb\"q\\");
        assert_eq!(unquote("\"a/caf\\303\\251\""), "a/café");
        assert_eq!(unquote("a/plain"), "a/plain");
        assert_eq!(
            side_path("\"b/sp ace\\n.txt\"", "b/").as_deref(),
            Some("sp ace\n.txt")
        );
        assert_eq!(side_path("/dev/null", "a/"), None);
    }

    #[test]
    fn hunk_counts_default_to_one() {
        let hunk = hunk_of("@@ -3 +4,0 @@").unwrap();
        assert_eq!(
            (
                hunk.old_start,
                hunk.old_lines,
                hunk.new_start,
                hunk.new_lines
            ),
            (3, 1, 4, 0)
        );
        assert!(hunk_of("@@ nonsense").is_none());
    }

    #[test]
    fn wide_ranges_get_shorter_pages() {
        assert_eq!(page_size(500, 3), 500);
        assert_eq!(page_size(9_999, 3), LINE_HISTORY_PAGE_MAX);
        assert_eq!(page_size(500, 5_000), 20);
        assert_eq!(page_size(0, 1), 1);
        assert_eq!(page_size(500, 1_000_000), 1);
    }

    fn spans(old: &str, new: &str) -> Vec<HunkSpan> {
        let options = DiffOptions {
            context_lines: 0,
            ..DiffOptions::default()
        };
        hunk_spans(
            old.as_bytes(),
            new.as_bytes(),
            Algorithm::default(),
            &options,
        )
    }

    #[test]
    fn maps_working_tree_lines_to_head() {
        let head = "a\nb\nc\nd\ne\n";
        // Two lines inserted on top, `d` edited.
        let worktree = "x\ny\na\nb\nc\nD\ne\n";
        let spans = spans(head, worktree);
        // Unchanged lines shift by the insertion.
        assert_eq!(map_to_head(&spans, 3, 5), Some((1, 3)));
        // An edited line stands for the line it replaces.
        assert_eq!(map_to_head(&spans, 5, 6), Some((3, 4)));
        assert_eq!(map_to_head(&spans, 6, 7), Some((4, 5)));
        // Inserted lines are dropped at either end.
        assert_eq!(map_to_head(&spans, 1, 3), Some((1, 1)));
        assert_eq!(map_to_head(&spans, 1, 2), None);
        // No change: same numbers.
        assert_eq!(map_to_head(&[], 2, 4), Some((2, 4)));
    }

    #[test]
    fn maps_around_deleted_lines() {
        let head = "a\nb\nc\nd\n";
        let worktree = "a\nd\n";
        let spans = spans(head, worktree);
        assert_eq!(map_to_head(&spans, 1, 2), Some((1, 4)));
        assert_eq!(map_to_head(&spans, 2, 2), Some((4, 4)));
    }
}
