//! History of one file across renames (F-220): payloads and the parsing of `git log`.
//!
//! The walk itself runs in `repo/inspect.rs`: one `git log -- <path>` per name the file had
//! (fast with the commit-graph's changed-path Bloom filters, which `--follow` disables), and a
//! rename lookup on the commit that added the path to go on under the previous name.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::read::diff::types::FileStatus;

/// Maximum entries per page.
pub const FILE_HISTORY_PAGE_MAX: u32 = 500;

/// `git log` format of one entry: record separator, then fields separated by `\x1f`.
pub const LOG_FORMAT: &str = "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s";

/// Where the next page of a file history starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryCursor {
    /// Commit the walk of this name starts from (full SHA).
    pub rev: String,
    /// Name of the file in that part of the history.
    pub path: String,
    /// Entries of this name already returned.
    pub skip: u32,
}

/// One commit that changed the file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub sha: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Seconds since the Unix epoch.
    pub author_time: f64,
    pub summary: String,
    /// Path of the file in this commit.
    pub path: String,
    /// Previous path when this commit renamed the file.
    pub old_path: Option<String>,
    /// What the commit did to the file. A merge (no diff of its own) is `modified`.
    pub status: FileStatus,
    /// Similarity of a rename, 0–100.
    pub similarity: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryPage {
    /// Newest first.
    pub entries: Vec<FileHistoryEntry>,
    /// `None` at the start of the file's history.
    pub next: Option<FileHistoryCursor>,
}

fn status_of(letter: &str) -> FileStatus {
    match letter.as_bytes().first() {
        Some(b'A') => FileStatus::Added,
        Some(b'D') => FileStatus::Deleted,
        Some(b'R') => FileStatus::Renamed,
        Some(b'C') => FileStatus::Copied,
        Some(b'T') => FileStatus::TypeChanged,
        _ => FileStatus::Modified,
    }
}

fn similarity_of(letter: &str) -> Option<u8> {
    letter.get(1..).and_then(|n| n.parse().ok())
}

/// Parses `git log <LOG_FORMAT> --name-status -z -- <path>`. Entries without a status (merges,
/// whose diff `git log` does not show) keep `path`.
pub fn parse_log(output: &str, path: &str) -> Vec<FileHistoryEntry> {
    let mut entries = Vec::new();
    for record in output.split('\x1e').filter(|r| !r.is_empty()) {
        let (header, changes) = record.split_once('\0').unwrap_or((record, ""));
        let mut fields = header.split('\x1f');
        let mut next = || fields.next().unwrap_or_default().to_owned();
        let sha = next();
        if sha.len() < 40 {
            continue;
        }
        let parents = next();
        let author_name = next();
        let author_email = next();
        let author_time = next().trim().parse::<f64>().unwrap_or(0.0);
        let summary = next();
        // `\n` then `<status>\0<path>\0[<new path>\0]`.
        let mut tokens = changes.trim_start_matches('\n').split('\0');
        let (status, similarity, entry_path, old_path) = match tokens.next() {
            Some(letter) if !letter.is_empty() => {
                let first = tokens.next().unwrap_or(path).to_owned();
                match status_of(letter) {
                    FileStatus::Renamed | FileStatus::Copied => {
                        let second = tokens.next().unwrap_or(path).to_owned();
                        (
                            status_of(letter),
                            similarity_of(letter),
                            second,
                            Some(first),
                        )
                    }
                    status => (status, None, first, None),
                }
            }
            _ => (FileStatus::Modified, None, path.to_owned(), None),
        };
        entries.push(FileHistoryEntry {
            sha,
            parents: parents
                .split(' ')
                .filter(|p| !p.is_empty())
                .map(str::to_owned)
                .collect(),
            author_name,
            author_email,
            author_time,
            summary,
            path: entry_path,
            old_path,
            status,
            similarity,
        });
    }
    entries
}

/// The rename of `path` in `git diff-tree -r -M --name-status -z` output: `(old path,
/// similarity)`.
pub fn find_rename(output: &str, path: &str) -> Option<(String, Option<u8>)> {
    let mut tokens = output.split('\0');
    while let Some(letter) = tokens.next() {
        let letter = letter.trim_start_matches('\n');
        if letter.is_empty() {
            continue;
        }
        let first = tokens.next()?;
        if matches!(status_of(letter), FileStatus::Renamed | FileStatus::Copied) {
            let second = tokens.next()?;
            if letter.starts_with('R') && second == path {
                return Some((first.to_owned(), similarity_of(letter)));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "1111111111111111111111111111111111111111";
    const B: &str = "2222222222222222222222222222222222222222";
    const C: &str = "3333333333333333333333333333333333333333";

    #[test]
    fn parses_entries_with_renames_and_merges() {
        let output = format!(
            "\x1e{C}\x1f{A} {B}\x1fAda\x1fada@x\x1f300\x1fMerge side\0\
             \x1e{B}\x1f{A}\x1fBob\x1fbob@x\x1f200\x1frename\0\nR087\0old.txt\0new.txt\0\
             \x1e{A}\x1f\x1fAda\x1fada@x\x1f100\x1fadd\0\nA\0new.txt\0"
        );
        let entries = parse_log(&output, "new.txt");
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].status, FileStatus::Modified);
        assert_eq!(entries[0].parents, vec![A.to_owned(), B.to_owned()]);
        assert_eq!(entries[0].path, "new.txt");
        assert_eq!(entries[1].status, FileStatus::Renamed);
        assert_eq!(entries[1].old_path.as_deref(), Some("old.txt"));
        assert_eq!(entries[1].similarity, Some(87));
        assert_eq!(entries[2].status, FileStatus::Added);
        assert!(entries[2].parents.is_empty());
        assert!((entries[2].author_time - 100.0).abs() < f64::EPSILON);
    }

    #[test]
    fn finds_the_rename_of_a_path() {
        let output = "M\0a.txt\0R100\0old/b.txt\0b.txt\0D\0c.txt\0";
        assert_eq!(
            find_rename(output, "b.txt"),
            Some(("old/b.txt".to_owned(), Some(100)))
        );
        assert_eq!(find_rename(output, "a.txt"), None);
    }
}
