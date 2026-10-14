//! Blame of a file (F-221): payloads and the parsing of `git blame --incremental`.
//!
//! The content is read by yaggui (a blob of the commit, or the working tree file passed to
//! `git blame --contents -`), so lines and their attribution always describe the same bytes.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::read::diff::types::TextEncoding;

/// Bytes Git looks at to decide that a file is binary (`buffer_is_binary`).
const BINARY_PROBE: usize = 8000;

/// What to blame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BlameRequest {
    /// Repository-relative path, in `rev` (or the working tree).
    pub path: String,
    /// Commit whose version is blamed; `None`: the working tree file, uncommitted lines
    /// included.
    pub rev: Option<String>,
}

/// Where the lines a commit introduced were before it, for "blame of the parent".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BlamePrevious {
    pub sha: String,
    pub path: String,
}

/// A commit lines are attributed to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    /// Null SHA (`000…`) for lines not committed yet.
    pub sha: String,
    pub author_name: String,
    pub author_email: String,
    /// Seconds since the Unix epoch.
    pub author_time: f64,
    pub summary: String,
    /// Path of the file in this commit.
    pub path: String,
    /// `None` for a root commit (or the boundary of a shallow clone).
    pub previous: Option<BlamePrevious>,
    pub uncommitted: bool,
}

/// Consecutive lines attributed to one commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BlameChunk {
    /// First line, 0-based.
    pub start: u32,
    pub count: u32,
    /// Index in `commits`.
    pub commit: u32,
    /// First line in the commit's version of the file, 0-based.
    pub source_start: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BlameContent {
    Text {
        lines: Vec<String>,
        encoding: TextEncoding,
        commits: Vec<BlameCommit>,
        /// Sorted by `start`, covering every line once.
        chunks: Vec<BlameChunk>,
    },
    /// Not blamed: Git's line attribution means nothing on binary content.
    Binary { size: f64 },
    /// The file is not in HEAD yet (untracked or only added to the index).
    NotCommitted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Blame {
    pub path: String,
    /// Commit blamed (full SHA), `None` for the working tree.
    pub rev: Option<String>,
    pub content: BlameContent,
}

/// Same rule as Git: a NUL byte in the first 8000 bytes.
pub fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_PROBE)].contains(&0)
}

/// Lines of `text` without their `\n` (a `\r` before it is dropped too).
pub fn split_lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let body = text.strip_suffix('\n').unwrap_or(text);
    body.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned())
        .collect()
}

fn is_null_sha(sha: &str) -> bool {
    sha.bytes().all(|b| b == b'0')
}

/// Parses `git blame --incremental`: every chunk starts with `<sha> <source line> <line>
/// <count>`, followed by the commit's headers the first time it appears, and ends with
/// `filename`.
pub fn parse_incremental(output: &str) -> (Vec<BlameCommit>, Vec<BlameChunk>) {
    let mut commits: Vec<BlameCommit> = Vec::new();
    let mut index: HashMap<String, u32> = HashMap::new();
    let mut chunks = Vec::new();
    let mut current: Option<u32> = None;
    for line in output.lines() {
        if current.is_none() {
            let mut parts = line.split(' ');
            let (Some(sha), Some(source), Some(start), Some(count)) =
                (parts.next(), parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            let (Ok(source), Ok(start), Ok(count)) = (
                source.parse::<u32>(),
                start.parse::<u32>(),
                count.parse::<u32>(),
            ) else {
                continue;
            };
            let next = u32::try_from(commits.len()).unwrap_or(u32::MAX);
            let commit = *index.entry(sha.to_owned()).or_insert_with(|| {
                commits.push(BlameCommit {
                    sha: sha.to_owned(),
                    author_name: String::new(),
                    author_email: String::new(),
                    author_time: 0.0,
                    summary: String::new(),
                    path: String::new(),
                    previous: None,
                    uncommitted: is_null_sha(sha),
                });
                next
            });
            chunks.push(BlameChunk {
                start: start.saturating_sub(1),
                count,
                commit,
                source_start: source.saturating_sub(1),
            });
            current = Some(commit);
            continue;
        }
        let Some(commit) = current.and_then(|i| commits.get_mut(i as usize)) else {
            continue;
        };
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        match key {
            "author" => value.clone_into(&mut commit.author_name),
            "author-mail" => {
                let email = value.trim_start_matches('<').trim_end_matches('>');
                email.clone_into(&mut commit.author_email);
            }
            "author-time" => commit.author_time = value.parse().unwrap_or(0.0),
            "summary" => value.clone_into(&mut commit.summary),
            "previous" => {
                if let Some((sha, path)) = value.split_once(' ') {
                    commit.previous = Some(BlamePrevious {
                        sha: sha.to_owned(),
                        path: path.to_owned(),
                    });
                }
            }
            "filename" => {
                if commit.path.is_empty() {
                    value.clone_into(&mut commit.path);
                }
                current = None;
            }
            _ => {}
        }
    }
    chunks.sort_unstable_by_key(|c| c.start);
    (commits, chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OUTPUT: &str = "\
0000000000000000000000000000000000000000 2 2 1
author External file (--contents)
author-mail <external.file>
author-time 1791918528
summary Version of b.txt from standard input
previous c19b2e71a63ccd4073269903328aa5d5e1a910c6 b.txt
filename b.txt
cc8b79e73bfc394fa1b06d63f1c0909ea335fae0 4 3 2
author Ada
author-mail <ada@example.com>
author-time 1700000000
summary main edit
previous 9d7dd408b14d025b41a6321dbeacb4d540cd708e b.txt
filename b.txt
56cc751d8108baade76d47349564576bff6f932f 1 1 1
author Bob
author-mail <bob@example.com>
author-time 1600000000
summary add a
boundary
filename a.txt
cc8b79e73bfc394fa1b06d63f1c0909ea335fae0 9 5 1
filename b.txt
";

    #[test]
    fn parses_chunks_and_commits() {
        let (commits, chunks) = parse_incremental(OUTPUT);
        assert_eq!(commits.len(), 3);
        assert!(commits[0].uncommitted);
        assert_eq!(commits[1].author_email, "ada@example.com");
        assert_eq!(commits[1].summary, "main edit");
        assert_eq!(
            commits[1].previous,
            Some(BlamePrevious {
                sha: "9d7dd408b14d025b41a6321dbeacb4d540cd708e".into(),
                path: "b.txt".into()
            })
        );
        assert_eq!(commits[2].path, "a.txt");
        assert_eq!(commits[2].previous, None);
        let starts: Vec<_> = chunks
            .iter()
            .map(|c| (c.start, c.count, c.commit))
            .collect();
        assert_eq!(starts, vec![(0, 1, 2), (1, 1, 0), (2, 2, 1), (4, 1, 1)]);
        assert_eq!(chunks[3].source_start, 8);
    }

    #[test]
    fn splits_lines_and_detects_binaries() {
        assert_eq!(split_lines("a\r\nb\n"), vec!["a", "b"]);
        assert_eq!(split_lines("a\nb"), vec!["a", "b"]);
        assert!(split_lines("").is_empty());
        assert!(is_binary(b"PNG\0\x01"));
        assert!(!is_binary(b"text"));
    }
}
