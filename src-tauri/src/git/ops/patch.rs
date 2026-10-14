//! Patch of one file built from a selection of hunks and lines of its diff, for `git apply`.
//!
//! The patch is always expressed old → new. Forward (stage) applies it to the old side:
//! unselected removals stay as context, unselected additions are left out. Reverse (unstage,
//! discard) is applied with `--reverse` to the new side: unselected additions stay as
//! context, unselected removals are left out.

use std::collections::{HashMap, HashSet};

use crate::git::ops::types::HunkSelection;
use crate::git::read::diff::text::{HunkSpan, SpanLine};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Forward,
    Reverse,
}

/// One side of the file, `None` when the path does not exist on that side.
#[derive(Debug, Clone, Copy)]
pub struct PatchSide<'a> {
    pub content: &'a [u8],
    /// Octal Git mode (`100644`, `100755`).
    pub mode: &'a str,
}

pub struct PatchInput<'a> {
    pub path: &'a str,
    pub old: Option<PatchSide<'a>>,
    pub new: Option<PatchSide<'a>>,
    /// Hunks of the diff of `old` → `new`, as `text::hunk_spans` computes them.
    pub spans: &'a [HunkSpan],
}

/// The selection does not match the diff (unknown hunk, line out of range): it was made on
/// another version of the file.
#[derive(Debug, PartialEq, Eq)]
pub struct StaleSelection;

/// Lines of a side split on `\n`, each without its `\n` (a `\r` stays part of the line).
struct RawLines<'a> {
    lines: Vec<&'a [u8]>,
    missing_newline: bool,
}

impl<'a> RawLines<'a> {
    fn new(content: &'a [u8]) -> Self {
        if content.is_empty() {
            return Self {
                lines: Vec::new(),
                missing_newline: false,
            };
        }
        let missing_newline = !content.ends_with(b"\n");
        let body = content.strip_suffix(b"\n").unwrap_or(content);
        Self {
            lines: body.split(|&b| b == b'\n').collect(),
            missing_newline,
        }
    }

    fn get(&self, index: u32) -> Result<&'a [u8], StaleSelection> {
        usize::try_from(index)
            .ok()
            .and_then(|i| self.lines.get(i))
            .copied()
            .ok_or(StaleSelection)
    }

    /// Whether the line ends with `\n` in the file.
    fn terminated(&self, index: u32) -> bool {
        !(self.missing_newline && usize::try_from(index).is_ok_and(|i| i + 1 == self.lines.len()))
    }
}

#[derive(Debug, Clone, Copy)]
struct PatchLine<'a> {
    kind: u8,
    text: &'a [u8],
    newline: bool,
}

/// Selected lines of one hunk (`None`: all of them).
type Selected = Option<Vec<u32>>;

fn selections(selection: &[HunkSelection]) -> HashMap<&str, Selected> {
    let mut by_id: HashMap<&str, Selected> = HashMap::new();
    for hunk in selection {
        match (by_id.get_mut(hunk.id.as_str()), &hunk.lines) {
            (Some(slot), Some(lines)) => {
                if let Some(existing) = slot {
                    existing.extend(lines);
                }
            }
            (Some(slot), None) => *slot = None,
            (None, lines) => {
                by_id.insert(&hunk.id, lines.clone());
            }
        }
    }
    by_id
}

/// The patch, or `None` when the selection changes nothing.
pub fn build(
    input: &PatchInput<'_>,
    selection: &[HunkSelection],
    direction: Direction,
) -> Result<Option<Vec<u8>>, StaleSelection> {
    let selected = selections(selection);
    let known: HashSet<&str> = input.spans.iter().map(|span| span.id.as_str()).collect();
    if selected.keys().any(|id| !known.contains(id)) {
        return Err(StaleSelection);
    }
    let old = RawLines::new(input.old.map_or(&[][..], |s| s.content));
    let new = RawLines::new(input.new.map_or(&[][..], |s| s.content));

    let mut complete = true;
    let mut body = Vec::new();
    // Lines added minus lines removed by the hunks already written.
    let mut delta: i64 = 0;
    for span in input.spans {
        let Some(chosen) = selected.get(span.id.as_str()) else {
            complete &= span.lines.iter().all(|l| l.kind == b' ');
            continue;
        };
        if let Some(lines) = chosen
            && lines
                .iter()
                .any(|&i| usize::try_from(i).map_or(true, |i| i >= span.lines.len()))
        {
            return Err(StaleSelection);
        }
        let chosen_lines: Option<HashSet<usize>> = chosen.as_ref().map(|lines| {
            lines
                .iter()
                .filter_map(|&i| usize::try_from(i).ok())
                .collect()
        });
        let is_selected = |position: usize| {
            chosen_lines
                .as_ref()
                .is_none_or(|lines| lines.contains(&position))
        };
        let mut lines = Vec::with_capacity(span.lines.len());
        for (position, kind, o, n) in paired(span) {
            let chosen = is_selected(position);
            match kind {
                b'-' => {
                    complete &= chosen;
                    if chosen {
                        lines.push(PatchLine {
                            kind: b'-',
                            text: old.get(o)?,
                            newline: old.terminated(o),
                        });
                    } else if direction == Direction::Forward {
                        lines.push(PatchLine {
                            kind: b' ',
                            text: old.get(o)?,
                            newline: old.terminated(o),
                        });
                    }
                }
                b'+' => {
                    complete &= chosen;
                    if chosen {
                        lines.push(PatchLine {
                            kind: b'+',
                            text: new.get(n)?,
                            newline: new.terminated(n),
                        });
                    } else if direction == Direction::Reverse {
                        lines.push(PatchLine {
                            kind: b' ',
                            text: new.get(n)?,
                            newline: new.terminated(n),
                        });
                    }
                }
                _ => {
                    // Context: identical on both sides; read it from the side patched.
                    let (side, index) = match direction {
                        Direction::Forward => (&old, o),
                        Direction::Reverse => (&new, n),
                    };
                    lines.push(PatchLine {
                        kind: b' ',
                        text: side.get(index)?,
                        newline: side.terminated(index),
                    });
                }
            }
        }
        if lines.iter().all(|l| l.kind == b' ') {
            continue;
        }
        let lines = fix_missing_newlines(lines);
        let pre = count(&lines, b'+');
        let post = count(&lines, b'-');
        let (pre_first, post_first) = match direction {
            Direction::Forward => {
                let first = i64::from(span.old_first);
                (first, first + delta)
            }
            Direction::Reverse => {
                let first = i64::from(span.new_first);
                (first - delta, first)
            }
        };
        delta += post - pre;
        let start = |first: i64, lines: i64| if lines == 0 { first } else { first + 1 };
        body.extend_from_slice(
            format!(
                "@@ -{},{pre} +{},{post} @@\n",
                start(pre_first, pre),
                start(post_first, post)
            )
            .as_bytes(),
        );
        for line in lines {
            body.push(line.kind);
            body.extend_from_slice(line.text);
            body.push(b'\n');
            if !line.newline {
                body.extend_from_slice(b"\\ No newline at end of file\n");
            }
        }
    }
    if body.is_empty() {
        return Ok(None);
    }

    let creation = input.old.is_none() && (direction == Direction::Forward || complete);
    let deletion = input.new.is_none() && (direction == Direction::Reverse || complete);
    let quoted = |prefix: &str| quote(&format!("{prefix}{}", input.path));
    let mut patch = format!("diff --git {} {}\n", quoted("a/"), quoted("b/"));
    if creation && let Some(side) = input.new {
        patch.push_str(&format!("new file mode {}\n", side.mode));
    }
    if deletion && let Some(side) = input.old {
        patch.push_str(&format!("deleted file mode {}\n", side.mode));
    }
    let old_name = if creation {
        "/dev/null".to_owned()
    } else {
        quoted("a/")
    };
    let new_name = if deletion {
        "/dev/null".to_owned()
    } else {
        quoted("b/")
    };
    patch.push_str(&format!("--- {old_name}\n+++ {new_name}\n"));
    let mut bytes = patch.into_bytes();
    bytes.extend_from_slice(&body);
    Ok(Some(bytes))
}

/// Id of the single hunk of [`whole_file`].
const WHOLE_FILE_ID: &str = "whole-file";

/// The same selection as one hunk spanning the whole file: every line outside the selected
/// changes becomes context. `git apply` then checks the entire file before writing it, so a
/// patch applied to the working tree (discard) fails on any change made since the diff was
/// read, instead of landing on shifted lines (hunks without context only match by position).
pub fn whole_file(
    input: &PatchInput<'_>,
    selection: &[HunkSelection],
) -> Result<(Vec<HunkSpan>, Vec<HunkSelection>), StaleSelection> {
    let selected = selections(selection);
    let old_len = line_count(input.old.map_or(&[][..], |s| s.content));
    let new_len = line_count(input.new.map_or(&[][..], |s| s.content));
    let mut lines = Vec::new();
    let mut chosen = Vec::new();
    let (mut old_at, mut new_at) = (0u32, 0u32);
    let context = |lines: &mut Vec<SpanLine>, count: u32, new_at: u32| {
        lines.extend((0..count).map(|k| SpanLine {
            kind: b' ',
            index: new_at + k,
        }));
    };
    for span in input.spans {
        let gap = span.old_first.checked_sub(old_at).ok_or(StaleSelection)?;
        if span.new_first.checked_sub(new_at) != Some(gap) {
            return Err(StaleSelection);
        }
        context(&mut lines, gap, new_at);
        let offset = u32::try_from(lines.len()).map_err(|_| StaleSelection)?;
        match selected.get(span.id.as_str()) {
            Some(Some(picked)) => chosen.extend(picked.iter().map(|i| offset + i)),
            Some(None) => chosen.extend(
                (0..span.lines.len()).filter_map(|i| u32::try_from(i).ok().map(|i| offset + i)),
            ),
            None => {}
        }
        lines.extend_from_slice(&span.lines);
        old_at = span.old_first + span.old_lines;
        new_at = span.new_first + span.new_lines;
    }
    let tail = old_len.checked_sub(old_at).ok_or(StaleSelection)?;
    if new_len.checked_sub(new_at) != Some(tail) {
        return Err(StaleSelection);
    }
    context(&mut lines, tail, new_at);
    let span = HunkSpan {
        id: WHOLE_FILE_ID.to_owned(),
        old_first: 0,
        new_first: 0,
        old_lines: old_len,
        new_lines: new_len,
        lines,
    };
    let selection = HunkSelection {
        id: WHOLE_FILE_ID.to_owned(),
        lines: Some(chosen),
    };
    Ok((vec![span], vec![selection]))
}

fn line_count(content: &[u8]) -> u32 {
    u32::try_from(RawLines::new(content).lines.len()).unwrap_or(u32::MAX)
}

/// Lines of a hunk as `(position in the hunk, kind, old index, new index)`, each block of
/// removals followed by additions interleaved pairwise (`-a +A -b +B` instead of
/// `-a -b +A +B`). Same images, but a line taken alone from a block of replaced lines stays
/// in place: unselected neighbours become context around it instead of before it.
fn paired(span: &HunkSpan) -> Vec<(usize, u8, u32, u32)> {
    let mut out = Vec::with_capacity(span.lines.len());
    let (mut o, mut n) = (span.old_first, span.new_first);
    let mut i = 0;
    while i < span.lines.len() {
        if span.lines[i].kind == b' ' {
            out.push((i, b' ', o, n));
            o += 1;
            n += 1;
            i += 1;
            continue;
        }
        let removed_end = i + span.lines[i..]
            .iter()
            .take_while(|l| l.kind == b'-')
            .count();
        let added_end = removed_end
            + span.lines[removed_end..]
                .iter()
                .take_while(|l| l.kind == b'+')
                .count();
        let (removed, added) = (removed_end - i, added_end - removed_end);
        for k in 0..removed.max(added) {
            if k < removed {
                out.push((i + k, b'-', o, n));
                o += 1;
            }
            if k < added {
                out.push((removed_end + k, b'+', o, n));
                n += 1;
            }
        }
        i = added_end;
    }
    out
}

/// Lines of the patch except those of `excluded` kind (`+` for the preimage, `-` for the
/// postimage).
fn count(lines: &[PatchLine<'_>], excluded: u8) -> i64 {
    let n = lines.iter().filter(|l| l.kind != excluded).count();
    i64::try_from(n).unwrap_or(i64::MAX)
}

/// A line without newline must end the image(s) it belongs to. Once a selection drops or
/// keeps lines, the last line of a side can be followed by other lines in one image: there
/// it needs its newline. A context line in that situation is split into `-` and `+`, each with
/// the right ending (`\ No newline` only on the image it ends).
fn fix_missing_newlines(lines: Vec<PatchLine<'_>>) -> Vec<PatchLine<'_>> {
    let mut fixed = Vec::with_capacity(lines.len() + 1);
    for (i, line) in lines.iter().enumerate() {
        if line.newline {
            fixed.push(*line);
            continue;
        }
        let rest = &lines[i + 1..];
        let followed_in_pre = rest.iter().any(|l| l.kind != b'+');
        let followed_in_post = rest.iter().any(|l| l.kind != b'-');
        match line.kind {
            b'-' => fixed.push(PatchLine {
                newline: followed_in_pre,
                ..*line
            }),
            b'+' => fixed.push(PatchLine {
                newline: followed_in_post,
                ..*line
            }),
            _ if followed_in_pre == followed_in_post => fixed.push(PatchLine {
                newline: followed_in_pre,
                ..*line
            }),
            _ => {
                fixed.push(PatchLine {
                    kind: b'-',
                    newline: followed_in_pre,
                    ..*line
                });
                fixed.push(PatchLine {
                    kind: b'+',
                    newline: followed_in_post,
                    ..*line
                });
            }
        }
    }
    fixed
}

/// C-style quoting, as Git writes paths in patches: always quoted, so spaces, tabs and quotes
/// never split or end a name. Bytes ≥ 0x80 are written as is (Git reads them back verbatim).
pub fn quote(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 2);
    out.push('"');
    for c in path.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if u32::from(c) < 0x20 || c == '\u{7f}' => {
                out.push_str(&format!("\\{:03o}", u32::from(c)));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::read::diff::text::hunk_spans;
    use crate::git::read::diff::types::DiffOptions;
    use gix::diff::blob::Algorithm;

    fn patch(
        old: Option<&'static str>,
        new: Option<&'static str>,
        selection: &[HunkSelection],
        direction: Direction,
    ) -> Option<String> {
        let spans = hunk_spans(
            old.unwrap_or_default().as_bytes(),
            new.unwrap_or_default().as_bytes(),
            Algorithm::Histogram,
            &DiffOptions::default(),
        );
        let side = |s: Option<&'static str>| {
            s.map(|c| PatchSide {
                content: c.as_bytes(),
                mode: "100644",
            })
        };
        let input = PatchInput {
            path: "f.txt",
            old: side(old),
            new: side(new),
            spans: &spans,
        };
        build(&input, selection, direction)
            .unwrap()
            .map(|p| String::from_utf8(p).unwrap())
    }

    fn sel(id: &str, lines: Option<Vec<u32>>) -> HunkSelection {
        HunkSelection {
            id: id.to_owned(),
            lines,
        }
    }

    #[test]
    fn forward_keeps_unselected_removals_as_context() {
        let p = patch(
            Some("a\nb\nc\n"),
            Some("a\nB\nC\n"),
            // Lines: ' a', '-b', '-c', '+B', '+C'. Select "-b" and "+B".
            &[sel("-1,3+1,3", Some(vec![1, 3]))],
            Direction::Forward,
        )
        .unwrap();
        assert!(p.ends_with("@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n"), "{p}");
    }

    #[test]
    fn reverse_keeps_unselected_additions_as_context() {
        let p = patch(
            Some("a\nb\nc\n"),
            Some("a\nB\nC\n"),
            &[sel("-1,3+1,3", Some(vec![1, 3]))],
            Direction::Reverse,
        )
        .unwrap();
        assert!(p.ends_with("@@ -1,3 +1,3 @@\n a\n-b\n+B\n C\n"), "{p}");
    }

    #[test]
    fn unchanged_selection_gives_no_patch() {
        let p = patch(
            Some("a\nb\n"),
            Some("a\nc\n"),
            &[sel("-1,2+1,2", Some(vec![0]))],
            Direction::Forward,
        );
        assert_eq!(p, None);
    }

    #[test]
    fn unknown_hunk_is_stale() {
        let spans = hunk_spans(
            b"a\n",
            b"b\n",
            Algorithm::Histogram,
            &DiffOptions::default(),
        );
        let side = PatchSide {
            content: b"a\n",
            mode: "100644",
        };
        let input = PatchInput {
            path: "f",
            old: Some(side),
            new: Some(side),
            spans: &spans,
        };
        assert_eq!(
            build(&input, &[sel("-9,1+9,1", None)], Direction::Forward),
            Err(StaleSelection)
        );
        assert_eq!(
            build(
                &input,
                &[sel(&spans[0].id, Some(vec![7]))],
                Direction::Forward
            ),
            Err(StaleSelection)
        );
    }

    #[test]
    fn last_line_without_newline_followed_by_selected_addition_is_split() {
        // Old ends without newline; select only the added line after it.
        let p = patch(
            Some("a\nb"),
            Some("a\nb\nc\n"),
            // Lines: ' a', '-b'(no nl), '+b', '+c'. Select "+c" only.
            &[sel("-1,2+1,3", Some(vec![3]))],
            Direction::Forward,
        )
        .unwrap();
        assert!(
            p.ends_with("@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n"),
            "{p}"
        );
    }

    #[test]
    fn creation_and_deletion_headers() {
        let p = patch(
            None,
            Some("x\ny\n"),
            &[sel("-0,0+1,2", Some(vec![1]))],
            Direction::Forward,
        )
        .unwrap();
        assert!(
            p.contains(
                "new file mode 100644\n--- /dev/null\n+++ \"b/f.txt\"\n@@ -0,0 +1,1 @@\n+y\n"
            ),
            "{p}"
        );
        let p = patch(
            Some("x\ny\n"),
            None,
            &[sel("-1,2+0,0", Some(vec![0]))],
            Direction::Forward,
        )
        .unwrap();
        assert!(!p.contains("deleted file mode"), "{p}");
        assert!(p.ends_with("@@ -1,2 +1,1 @@\n-x\n y\n"), "{p}");
    }

    #[test]
    fn quotes_paths() {
        assert_eq!(quote("a b\"c\\d\te"), "\"a b\\\"c\\\\d\\te\"");
        assert_eq!(quote("é"), "\"é\"");
    }
}
