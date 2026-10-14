//! Diff payloads exchanged with the frontend. Kept flat and compact: one string per line,
//! line kinds packed in a string, line numbers derived from the hunk starts.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::read::lfs::LfsObject;

/// What to compare.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiffTarget {
    /// Changes introduced by `to` (a commit id or revision). `from` defaults to the first
    /// parent of `to` (the empty tree for a root commit). Merges are shown against their
    /// first parent, like GitKraken.
    Commits { from: Option<String>, to: String },
    /// HEAD → index (what the next commit will contain).
    Staged,
    /// Index → working tree, untracked files included.
    Unstaged,
}

/// Entry type of a path, from its Git mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FileMode {
    /// `100644`
    Regular,
    /// `100755`
    Executable,
    /// `120000`
    Symlink,
    /// `160000`, a submodule commit.
    Submodule,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    /// The entry type changed (file ↔ symlink ↔ submodule).
    TypeChanged,
    Untracked,
    Conflicted,
}

/// One changed path of a diff target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Repository-relative path, `/`-separated (the new path of a rename).
    pub path: String,
    /// Source path of a rename or copy.
    pub old_path: Option<String>,
    pub status: FileStatus,
    /// Similarity of a rename or copy, 0–100.
    pub similarity: Option<u8>,
    /// Added / removed lines. `None` for binary files, submodules and when stats were skipped.
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub binary: bool,
    pub old_mode: Option<FileMode>,
    pub new_mode: Option<FileMode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFiles {
    /// Sorted by path.
    pub files: Vec<ChangedFile>,
    /// Line stats are not computed above `STATS_MAX_FILES` files (huge commits).
    pub stats_skipped: bool,
    /// Paths of `files` stored with Git LFS (`filter=lfs`), sorted; their line stats are not
    /// computed (F-262).
    pub lfs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffOptions {
    /// Like `git diff -w`.
    pub ignore_whitespace: bool,
    /// Unchanged lines around each change. Ignored when `full_file` is set.
    pub context_lines: u32,
    /// One hunk spanning the whole file.
    pub full_file: bool,
    /// Render even above the size guards (`DiffContent::TooLarge`).
    pub force: bool,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            ignore_whitespace: false,
            context_lines: 3,
            full_file: false,
            force: false,
        }
    }
}

/// Line ending style of one side of a text diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LineEnding {
    /// No line break at all (empty or single-line file).
    None,
    Lf,
    Crlf,
    Mixed,
}

/// How a side was decoded for display.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TextEncoding {
    Utf8,
    /// Not valid UTF-8: decoded as Windows-1252, a guess the UI must flag.
    Windows1252,
}

/// A contiguous block of changes with its context, as in `@@ -a,b +c,d @@`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    /// Stable within one file diff (`"-a,b+c,d"`), for hunk-level staging (M2).
    pub id: String,
    /// 1-based first line on each side (0 when the side is empty, as in Git).
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// Enclosing function or section, like the text after `@@` in `git diff`.
    pub header: String,
    /// One char per line: `' '` context, `'-'` removed, `'+'` added.
    pub kinds: String,
    /// Line contents, without line terminator.
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextDiff {
    pub hunks: Vec<DiffHunk>,
    pub additions: u32,
    pub deletions: u32,
    pub old_encoding: TextEncoding,
    pub new_encoding: TextEncoding,
    pub old_line_ending: LineEnding,
    pub new_line_ending: LineEnding,
    /// The last line of the side has no terminating newline (`\ No newline at end of file`).
    pub old_missing_newline: bool,
    pub new_missing_newline: bool,
    /// Line count of each side, for the "whole file" toggle and gutters.
    pub old_line_count: u32,
    pub new_line_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiffContent {
    Text(TextDiff),
    /// Binary on at least one side: sizes only (`None` = side absent).
    #[serde(rename_all = "camelCase")]
    Binary {
        old_size: Option<f64>,
        new_size: Option<f64>,
    },
    /// Above the size guards: not rendered unless asked (`DiffOptions::force`).
    #[serde(rename_all = "camelCase")]
    TooLarge {
        old_size: Option<f64>,
        new_size: Option<f64>,
        /// Lines the diff would render; `None` when the size alone stopped it (not loaded).
        lines: Option<u32>,
    },
    /// A file stored with Git LFS: the pointers (or the local content), never a text diff
    /// of the pointer files (F-262). `None` = side absent.
    Lfs {
        old: Option<LfsObject>,
        new: Option<LfsObject>,
    },
    /// Submodule commit change.
    #[serde(rename_all = "camelCase")]
    Submodule {
        old_commit: Option<String>,
        new_commit: Option<String>,
    },
    /// Merge conflict: shown by the conflict editor (M3).
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    /// Blob ids compared, so a hunk operation can check the diff is still current. A working
    /// tree side has the id `git hash-object` gives it once loaded (`None` when absent, or not
    /// loaded: binary, too large, submodule).
    pub old_id: Option<String>,
    pub new_id: Option<String>,
    pub old_mode: Option<FileMode>,
    pub new_mode: Option<FileMode>,
    pub content: DiffContent,
}

/// Side of a file diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DiffSide {
    Old,
    New,
}
