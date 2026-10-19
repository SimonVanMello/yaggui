//! Line diff of two text buffers into hunks. Pure: no repository access.

use std::borrow::Cow;

use gix::diff::blob::{Algorithm, Diff, InternedInput};

use super::types::{DiffHunk, DiffOptions, LineEnding, TextDiff, TextEncoding};

/// Above this, a single side is never decoded as text for display without `force`.
pub const MAX_RENDER_BYTES: u64 = 1024 * 1024;
/// Above this many rendered lines, the diff is not shown without `force`.
pub const MAX_RENDER_LINES: u32 = 5_000;

/// Unicode code points of Windows-1252 bytes 0x80–0x9F (undefined bytes map to themselves).
const CP1252_HIGH: [char; 32] = [
    '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}',
    '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
];

/// UTF-8 when valid, Windows-1252 otherwise: every byte maps to a character, so legacy
/// Latin files stay readable and nothing is lost to replacement characters.
pub fn decode(bytes: &[u8]) -> (Cow<'_, str>, TextEncoding) {
    match std::str::from_utf8(bytes) {
        Ok(text) => (Cow::Borrowed(text), TextEncoding::Utf8),
        Err(_) => (
            Cow::Owned(
                bytes
                    .iter()
                    .map(|&b| match b {
                        0x80..=0x9f => CP1252_HIGH[usize::from(b - 0x80)],
                        _ => char::from(b),
                    })
                    .collect(),
            ),
            TextEncoding::Windows1252,
        ),
    }
}

/// Lines of one side, split on `\n`, each keeping a trailing `\r` if any.
struct Lines<'a> {
    raw: Vec<&'a str>,
    ending: LineEnding,
    missing_newline: bool,
}

fn split_lines(text: &str) -> Lines<'_> {
    let missing_newline = !text.is_empty() && !text.ends_with('\n');
    let body = text.strip_suffix('\n').unwrap_or(text);
    let raw: Vec<&str> = if text.is_empty() {
        Vec::new()
    } else {
        body.split('\n').collect()
    };
    let terminated = if missing_newline {
        raw.len().saturating_sub(1)
    } else {
        raw.len()
    };
    let crlf = raw[..terminated]
        .iter()
        .filter(|line| line.ends_with('\r'))
        .count();
    let ending = match (crlf, terminated) {
        (_, 0) => LineEnding::None,
        (0, _) => LineEnding::Lf,
        (c, t) if c == t => LineEnding::Crlf,
        _ => LineEnding::Mixed,
    };
    Lines {
        raw,
        ending,
        missing_newline,
    }
}

/// Line ending style of a whole text.
pub fn line_ending(text: &str) -> LineEnding {
    split_lines(text).ending
}

fn display(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

/// Comparison key of a line. A last line without newline differs from the same text with
/// one, as in Git; ignoring whitespace drops every whitespace character (`git diff -w`).
fn key<'a>(line: &'a str, last_without_newline: bool, ignore_whitespace: bool) -> Cow<'a, [u8]> {
    let mut key: Cow<'a, [u8]> = if ignore_whitespace {
        Cow::Owned(
            line.chars()
                .filter(|c| !c.is_whitespace())
                .collect::<String>()
                .into_bytes(),
        )
    } else {
        Cow::Borrowed(line.as_bytes())
    };
    if last_without_newline {
        key.to_mut().extend_from_slice(b"\0no-newline");
    }
    key
}

fn keys<'a>(lines: &Lines<'a>, ignore_whitespace: bool) -> impl Iterator<Item = Cow<'a, [u8]>> {
    let last = lines.raw.len().saturating_sub(1);
    let missing = lines.missing_newline;
    lines
        .raw
        .iter()
        .enumerate()
        .map(move |(i, line)| key(line, missing && i == last, ignore_whitespace))
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Lines of `before`/`after` changed by the diff, as half-open ranges of line indexes.
struct Change {
    before: std::ops::Range<u32>,
    after: std::ops::Range<u32>,
}

fn compute(
    old: &Lines<'_>,
    new: &Lines<'_>,
    algorithm: Algorithm,
    ignore_whitespace: bool,
    postprocess: bool,
) -> (Vec<Change>, u32, u32) {
    let mut input: InternedInput<Cow<'_, [u8]>> = InternedInput::default();
    input.update_before(keys(old, ignore_whitespace));
    input.update_after(keys(new, ignore_whitespace));
    let mut diff = Diff::compute(algorithm, &input);
    if postprocess {
        diff.postprocess_lines(&input);
    }
    let changes = diff
        .hunks()
        .map(|h| Change {
            before: h.before,
            after: h.after,
        })
        .collect();
    (changes, diff.count_additions(), diff.count_removals())
}

/// Added / removed line counts and line count of each side, without building hunks.
pub struct LineStats {
    pub additions: u32,
    pub deletions: u32,
    pub old_lines: u32,
    pub new_lines: u32,
}

impl LineStats {
    /// Share of unchanged lines, 0–100, as shown for renames and copies.
    pub fn similarity(&self) -> u8 {
        let largest = self.old_lines.max(self.new_lines);
        if largest == 0 {
            return 100;
        }
        let kept = u64::from(self.old_lines.saturating_sub(self.deletions));
        let percent = (kept * 100 + u64::from(largest) / 2) / u64::from(largest);
        u8::try_from(percent.min(100)).unwrap_or(100)
    }
}

pub fn line_stats(old: &[u8], new: &[u8], algorithm: Algorithm) -> LineStats {
    let (old_text, _) = decode(old);
    let (new_text, _) = decode(new);
    let old_lines = split_lines(&old_text);
    let new_lines = split_lines(&new_text);
    let (_, additions, deletions) = compute(&old_lines, &new_lines, algorithm, false, false);
    LineStats {
        additions,
        deletions,
        old_lines: count(old_lines.raw.len()),
        new_lines: count(new_lines.raw.len()),
    }
}

/// Git's default function-name heuristic: the closest previous line starting with a
/// letter, `_` or `$`.
fn hunk_header(old: &Lines<'_>, before: u32) -> String {
    const MAX_SCAN: usize = 2_000;
    const MAX_LEN: usize = 80;
    let end = usize::try_from(before)
        .unwrap_or(usize::MAX)
        .min(old.raw.len());
    old.raw[end.saturating_sub(MAX_SCAN)..end]
        .iter()
        .rev()
        .map(|line| display(line))
        .find(|line| {
            line.chars()
                .next()
                .is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$')
        })
        .map(|line| {
            line.chars()
                .take(MAX_LEN)
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .unwrap_or_default()
}

/// One line of a hunk: its kind and its index in the side it is read from (the new side
/// for context lines, which are identical on both sides).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpanLine {
    pub kind: u8,
    pub index: u32,
}

/// A hunk as line indexes into both sides. Its `id` is the `DiffHunk::id` the same diff shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HunkSpan {
    pub id: String,
    /// 0-based index of the first line of the hunk on each side.
    pub old_first: u32,
    pub new_first: u32,
    pub old_lines: u32,
    pub new_lines: u32,
    pub lines: Vec<SpanLine>,
}

impl HunkSpan {
    fn new(old_first: u32, new_first: u32) -> Self {
        Self {
            id: String::new(),
            old_first,
            new_first,
            old_lines: 0,
            new_lines: 0,
            lines: Vec::new(),
        }
    }

    fn push(&mut self, kind: u8, index: u32) {
        match kind {
            b'-' => self.old_lines += 1,
            b'+' => self.new_lines += 1,
            _ => {
                self.old_lines += 1;
                self.new_lines += 1;
            }
        }
        self.lines.push(SpanLine { kind, index });
    }

    // Git numbers an empty side from the line before it.
    fn starts(&self) -> (u32, u32) {
        let start = |first: u32, lines: u32| if lines == 0 { first } else { first + 1 };
        (
            start(self.old_first, self.old_lines),
            start(self.new_first, self.new_lines),
        )
    }

    fn finish(mut self) -> Self {
        let (old_start, new_start) = self.starts();
        self.id = format!(
            "-{old_start},{}+{new_start},{}",
            self.old_lines, self.new_lines
        );
        self
    }

    fn to_hunk(&self, old: &Lines<'_>, new: &Lines<'_>) -> DiffHunk {
        let (old_start, new_start) = self.starts();
        DiffHunk {
            id: self.id.clone(),
            old_start,
            old_lines: self.old_lines,
            new_start,
            new_lines: self.new_lines,
            header: hunk_header(old, self.old_first),
            kinds: self.lines.iter().map(|l| char::from(l.kind)).collect(),
            lines: self
                .lines
                .iter()
                .map(|l| {
                    let side = if l.kind == b'-' { old } else { new };
                    display(line_at(side, l.index)).to_owned()
                })
                .collect(),
        }
    }
}

fn line_at<'a>(lines: &Lines<'a>, index: u32) -> &'a str {
    usize::try_from(index)
        .ok()
        .and_then(|i| lines.raw.get(i))
        .copied()
        .unwrap_or_default()
}

/// Groups changes closer than two contexts into hunks, with `context` lines around them.
fn build_spans(old_len: u32, new_len: u32, changes: &[Change], context: u32) -> Vec<HunkSpan> {
    let mut hunks = Vec::new();
    let mut index = 0;
    while index < changes.len() {
        let first = &changes[index];
        let lead = first.before.start.min(context);
        let mut hunk = HunkSpan::new(first.before.start - lead, first.after.start - lead);
        // Unchanged lines are identical on both sides (modulo ignored whitespace): show the
        // new version.
        for offset in (1..=lead).rev() {
            hunk.push(b' ', first.after.start - offset);
        }
        loop {
            let change = &changes[index];
            for i in change.before.clone() {
                hunk.push(b'-', i);
            }
            for i in change.after.clone() {
                hunk.push(b'+', i);
            }
            let next = changes.get(index + 1);
            match next {
                Some(next)
                    if next.before.start - change.before.end <= context.saturating_mul(2) =>
                {
                    for i in 0..next.before.start - change.before.end {
                        hunk.push(b' ', change.after.end + i);
                    }
                    index += 1;
                }
                _ => {
                    let trail = (old_len - change.before.end).min(context);
                    for i in 0..trail {
                        hunk.push(b' ', change.after.end + i);
                    }
                    index += 1;
                    break;
                }
            }
        }
        hunks.push(hunk.finish());
    }
    if hunks.is_empty() && context >= FULL_FILE_CONTEXT && new_len > 0 {
        // Nothing changed (pure rename, mode change…): the whole file is still shown.
        let mut hunk = HunkSpan::new(0, 0);
        for i in 0..new_len {
            hunk.push(b' ', i);
        }
        hunks.push(hunk.finish());
    }
    hunks
}

const FULL_FILE_CONTEXT: u32 = u32::MAX / 4;

fn context_of(options: &DiffOptions) -> u32 {
    if options.full_file {
        FULL_FILE_CONTEXT
    } else {
        options.context_lines
    }
}

/// Full text diff, with display-ready hunks.
pub fn text_diff(old: &[u8], new: &[u8], algorithm: Algorithm, options: &DiffOptions) -> TextDiff {
    let (old_text, old_encoding) = decode(old);
    let (new_text, new_encoding) = decode(new);
    let old_lines = split_lines(&old_text);
    let new_lines = split_lines(&new_text);
    let (changes, additions, deletions) = compute(
        &old_lines,
        &new_lines,
        algorithm,
        options.ignore_whitespace,
        true,
    );
    let hunks = build_spans(
        count(old_lines.raw.len()),
        count(new_lines.raw.len()),
        &changes,
        context_of(options),
    )
    .iter()
    .map(|span| span.to_hunk(&old_lines, &new_lines))
    .collect();
    TextDiff {
        hunks,
        additions,
        deletions,
        old_encoding,
        new_encoding,
        old_line_ending: old_lines.ending,
        new_line_ending: new_lines.ending,
        old_missing_newline: old_lines.missing_newline,
        new_missing_newline: new_lines.missing_newline,
        old_line_count: count(old_lines.raw.len()),
        new_line_count: count(new_lines.raw.len()),
    }
}

/// The hunks `text_diff` shows for these sides and options, as line indexes (same ids).
/// Decoding maps each `\n` byte to one `\n`, so the indexes are also those of the raw byte
/// lines split on `\n`.
pub fn hunk_spans(
    old: &[u8],
    new: &[u8],
    algorithm: Algorithm,
    options: &DiffOptions,
) -> Vec<HunkSpan> {
    let (old_text, _) = decode(old);
    let (new_text, _) = decode(new);
    let old_lines = split_lines(&old_text);
    let new_lines = split_lines(&new_text);
    let (changes, _, _) = compute(
        &old_lines,
        &new_lines,
        algorithm,
        options.ignore_whitespace,
        true,
    );
    build_spans(
        count(old_lines.raw.len()),
        count(new_lines.raw.len()),
        &changes,
        context_of(options),
    )
}

/// Lines the frontend would render for these hunks.
pub fn rendered_lines(diff: &TextDiff) -> u32 {
    diff.hunks
        .iter()
        .map(|hunk| count(hunk.lines.len()))
        .fold(0, u32::saturating_add)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diff(old: &str, new: &str, options: DiffOptions) -> TextDiff {
        text_diff(
            old.as_bytes(),
            new.as_bytes(),
            Algorithm::Histogram,
            &options,
        )
    }

    fn numbered(n: u32) -> String {
        (1..=n).map(|i| format!("line {i}\n")).collect()
    }

    #[test]
    fn single_change_with_context() {
        let old = numbered(10);
        let new = old.replace("line 5\n", "line five\n");
        let d = diff(&old, &new, DiffOptions::default());
        assert_eq!(d.additions, 1);
        assert_eq!(d.deletions, 1);
        assert_eq!(d.hunks.len(), 1);
        let h = &d.hunks[0];
        assert_eq!(
            (h.old_start, h.old_lines, h.new_start, h.new_lines),
            (2, 7, 2, 7)
        );
        assert_eq!(h.id, "-2,7+2,7");
        assert_eq!(h.kinds, "   -+   ");
        assert_eq!(h.lines[3], "line 5");
        assert_eq!(h.lines[4], "line five");
        assert_eq!(h.header, "line 1");
    }

    #[test]
    fn distant_changes_make_separate_hunks_close_ones_merge() {
        let old = numbered(30);
        let new = old
            .replace("line 2\n", "two\n")
            .replace("line 25\n", "twenty-five\n");
        assert_eq!(diff(&old, &new, DiffOptions::default()).hunks.len(), 2);
        let near = old
            .replace("line 2\n", "two\n")
            .replace("line 8\n", "eight\n");
        let d = diff(&near, &old, DiffOptions::default());
        assert_eq!(d.hunks.len(), 1);
        assert_eq!(d.hunks[0].kinds, " -+     -+   ");
    }

    #[test]
    fn context_lines_option_and_full_file() {
        let old = numbered(20);
        let new = old.replace("line 10\n", "ten\n");
        let zero = diff(
            &old,
            &new,
            DiffOptions {
                context_lines: 0,
                ..DiffOptions::default()
            },
        );
        assert_eq!(zero.hunks[0].kinds, "-+");
        assert_eq!(zero.hunks[0].old_start, 10);
        let full = diff(
            &old,
            &new,
            DiffOptions {
                full_file: true,
                ..DiffOptions::default()
            },
        );
        assert_eq!(full.hunks.len(), 1);
        assert_eq!(full.hunks[0].lines.len(), 21);
        assert_eq!(full.hunks[0].old_start, 1);
        // An unchanged file still shows its content in full-file mode.
        let same = diff(
            &old,
            &old,
            DiffOptions {
                full_file: true,
                ..DiffOptions::default()
            },
        );
        assert_eq!(same.hunks[0].kinds, " ".repeat(20));
    }

    #[test]
    fn added_and_deleted_files() {
        let added = diff("", "a\nb\n", DiffOptions::default());
        let h = &added.hunks[0];
        assert_eq!(
            (h.old_start, h.old_lines, h.new_start, h.new_lines),
            (0, 0, 1, 2)
        );
        assert_eq!(h.kinds, "++");
        let deleted = diff("a\nb\n", "", DiffOptions::default());
        let h = &deleted.hunks[0];
        assert_eq!(
            (h.old_start, h.old_lines, h.new_start, h.new_lines),
            (1, 2, 0, 0)
        );
    }

    #[test]
    fn ignore_whitespace() {
        let old = "fn a() {\n  x();\n}\n";
        let new = "fn a() {\n    x( );\n}\n";
        assert_eq!(diff(old, new, DiffOptions::default()).hunks.len(), 1);
        let ignored = diff(
            old,
            new,
            DiffOptions {
                ignore_whitespace: true,
                ..DiffOptions::default()
            },
        );
        assert!(ignored.hunks.is_empty());
        assert_eq!(ignored.additions, 0);
    }

    #[test]
    fn line_endings_are_reported_and_stripped() {
        let d = diff("a\r\nb\r\n", "a\nb\n", DiffOptions::default());
        assert_eq!(d.old_line_ending, LineEnding::Crlf);
        assert_eq!(d.new_line_ending, LineEnding::Lf);
        assert_eq!(d.deletions, 2);
        assert!(d.hunks[0].lines.iter().all(|l| !l.ends_with('\r')));
        // CR-only differences are whitespace.
        let ignored = diff(
            "a\r\nb\r\n",
            "a\nb\n",
            DiffOptions {
                ignore_whitespace: true,
                ..DiffOptions::default()
            },
        );
        assert!(ignored.hunks.is_empty());
        assert_eq!(
            diff("a\r\nb\n", "", DiffOptions::default()).old_line_ending,
            LineEnding::Mixed
        );
    }

    #[test]
    fn missing_newline_at_end() {
        let d = diff("a\nb", "a\nb\n", DiffOptions::default());
        assert!(d.old_missing_newline);
        assert!(!d.new_missing_newline);
        assert_eq!(d.hunks[0].kinds, " -+");
        assert_eq!(d.old_line_count, 2);
    }

    #[test]
    fn non_utf8_is_decoded_as_windows_1252() {
        let old = b"caf\xe9 \x80\n".to_vec();
        let d = text_diff(
            &old,
            b"cafe\n",
            Algorithm::Histogram,
            &DiffOptions::default(),
        );
        assert_eq!(d.old_encoding, TextEncoding::Windows1252);
        assert_eq!(d.new_encoding, TextEncoding::Utf8);
        assert_eq!(d.hunks[0].lines[0], "café €");
    }

    #[test]
    fn stats_and_similarity() {
        let old = numbered(100);
        let new = old.replace("line 50\n", "fifty\n");
        let stats = line_stats(old.as_bytes(), new.as_bytes(), Algorithm::Histogram);
        assert_eq!((stats.additions, stats.deletions), (1, 1));
        assert_eq!(stats.similarity(), 99);
        let empty = line_stats(b"", b"", Algorithm::Histogram);
        assert_eq!(empty.similarity(), 100);
    }

    #[test]
    fn rendered_lines_counts_every_hunk_line() {
        let old = numbered(30);
        let new = old.replace("line 2\n", "two\n").replace("line 25\n", "x\n");
        let d = diff(&old, &new, DiffOptions::default());
        assert_eq!(
            rendered_lines(&d),
            d.hunks.iter().map(|h| h.lines.len() as u32).sum::<u32>()
        );
    }
}
