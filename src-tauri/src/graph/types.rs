//! IPC contract of the commit graph (M1-1): pages, ref labels, search, commit detail.
//!
//! Pages are column-oriented (one array per field, all of the same length) so that a page
//! of 500 rows stays compact on the wire (rule 7) and the frontend can draw the graph on a
//! canvas without recomputing any layout.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Number of lane colors: every `color` is in `0..GRAPH_COLORS` and maps to the
/// `--lane-<color>` theme token.
pub const GRAPH_COLORS: u32 = 8;

/// Lanes are capped to keep very parallel histories readable: a line that would need a
/// lane beyond `GRAPH_MAX_LANES - 1` is drawn on that last lane.
pub const GRAPH_MAX_LANES: u32 = 48;

/// Rows per page, the maximum accepted `limit` of `graph_page`.
pub const GRAPH_PAGE_SIZE: u32 = 500;

/// Values of the 4th element of an edge (`GraphPage::edges`).
pub mod edge_kind {
    /// Pass-through line or link from a commit to its first parent.
    pub const NORMAL: u32 = 0;
    /// Link from a merge commit to one of its other parents.
    pub const MERGE: u32 = 1;
    /// Part of the line from the WIP node down to the HEAD commit: draw it only when the
    /// worktree is dirty (the WIP node is shown).
    pub const WIP: u32 = 2;
}

/// Values of `GraphPage::signatures`: the kind of signature found in the commit header, not
/// verified (F-066; checking it is `verify_commit_signature`, from the commit detail).
pub mod signature_code {
    pub const NONE: u8 = 0;
    pub const GPG: u8 = 1;
    pub const SSH: u8 = 2;
    pub const X509: u8 = 3;
    /// A `gpgsig` header in no known format.
    pub const UNKNOWN: u8 = 4;
}

/// What a ref label designates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    /// Detached HEAD (when HEAD is on a branch, the branch label has `isHead`).
    Head,
    LocalBranch,
    RemoteBranch,
    Tag,
    Stash,
}

/// A ref pointing at a commit, as shown on the graph and in the commit header (F-023).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub kind: RefKind,
    /// Short name: `main`, `origin/main`, `v1.2.0`, `stash@{0}`, `HEAD`.
    pub name: String,
    /// Full name: `refs/heads/main`, `refs/stash`… (`HEAD` for a detached HEAD).
    pub full_name: String,
    /// Local branch checked out in this worktree.
    pub is_head: bool,
    /// Local branches: short name of the upstream (`origin/main`), to merge the local and
    /// remote labels when both point at the same commit.
    pub upstream: Option<String>,
    /// Stashes: their message (`On main: my changes`), which names them better than
    /// `stash@{0}`. `null` for the other kinds.
    #[serde(default)]
    #[specta(optional)]
    pub message: Option<String>,
}

/// A ref label placed on a graph row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphRef {
    /// Absolute row index.
    pub row: u32,
    pub label: RefLabel,
}

/// The WIP node drawn above row 0 when the worktree is dirty (F-022). Its line runs on
/// `lane` down to `headRow`; the edges of that line have the kind `edge_kind::WIP`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphWip {
    pub lane: u32,
    pub color: u32,
    /// Row of the commit HEAD points to.
    pub head_row: u32,
}

/// A slice of the commit graph, rows `start .. start + shas.length`.
///
/// Rows are commits only, in `git log --topo-order` order over every branch, remote branch,
/// tag and HEAD (stashes are labels on their base commit, not rows). Without commit-graph, a
/// commit with more than a year of unread history above it when Git would list it is placed
/// by date instead (see `graph/topo.rs`); the order stays topological. The WIP node is not a
/// row: it sits above row 0 (see `wip`), so row indices do not move when the worktree
/// becomes dirty or clean.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphPage {
    /// Identifies the graph layout. It changes when refs change (`refs-changed`): never mix
    /// rows of different versions, drop the cached pages and refetch.
    pub version: u32,
    pub start: u32,
    /// Number of commit rows of the whole graph. While the history walk runs (`totalExact`
    /// false), a lower bound that grows with each page and `graph-progress` event: rows
    /// already sent never move, only more come.
    pub total_rows: u32,
    /// `false` while `total_rows` is a lower bound.
    pub total_exact: bool,
    /// Lanes used by the rows and edges of this page (≤ `GRAPH_MAX_LANES`).
    pub lane_count: u32,
    /// `None` when HEAD is unborn, not in the graph, or not reached by the history walk yet.
    pub wip: Option<GraphWip>,

    /// Full SHA of each row.
    pub shas: Vec<String>,
    /// Full parent SHAs of each row, first parent first.
    pub parents: Vec<Vec<String>>,
    /// First line of the message.
    pub summaries: Vec<String>,
    pub author_names: Vec<String>,
    pub author_emails: Vec<String>,
    /// Author dates, seconds since the Unix epoch.
    pub author_times: Vec<f64>,
    /// Committer dates, seconds since the Unix epoch.
    pub commit_times: Vec<f64>,
    /// Lane of the node of each row.
    pub lanes: Vec<u32>,
    /// Color of the node of each row.
    pub colors: Vec<u32>,
    /// Signature of each row, a `signature_code` value (unverified).
    pub signatures: Vec<u8>,

    /// Lines to draw between row `i` and row `i + 1`, flattened by groups of 4 numbers
    /// `[fromLane, toLane, color, kind]`: `fromLane` is at the height of row `i`, `toLane`
    /// at the height of row `i + 1`. The edges of the page's row `k` (0-based within the
    /// page) are `edges[4 * edgeOffsets[k] .. 4 * edgeOffsets[k + 1]]` (`edgeOffsets` has
    /// one more element than there are rows). A line leaving the node of row `i` has
    /// `fromLane == lanes[i]`; a line joining the node of row `i + 1` has
    /// `toLane == lanes[i + 1]`.
    pub edge_offsets: Vec<u32>,
    pub edges: Vec<u32>,
    /// Ref labels of the rows of this page, sorted by row.
    pub refs: Vec<GraphRef>,
}

/// Result of `graph_index_of`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphLocation {
    pub version: u32,
    /// Full SHA of the commit the revision resolved to.
    pub sha: String,
    /// `None` when the commit is not in the graph (not reachable from any ref or HEAD).
    pub row: Option<u32>,
}

/// Criteria of a commit search (F-027). Every criterion given must match (AND); text
/// comparisons ignore case.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitSearch {
    /// Contained in the message or the author name/email, or a prefix of the SHA.
    pub text: Option<String>,
    /// Contained in the author name or email.
    pub author: Option<String>,
    /// Commit changes this file, or a file under this folder, compared to its first parent
    /// (all paths for a root commit). Relative to the worktree root, `/` separators.
    pub path: Option<String>,
    /// Author date lower bound, inclusive, seconds since the Unix epoch.
    pub since: Option<f64>,
    /// Author date upper bound, inclusive, seconds since the Unix epoch.
    pub until: Option<f64>,
}

/// One chunk of search results. A search scans the rows in order and stops after a
/// short time budget: call again with `nextRow` until it is `None`. Cancelling is just not
/// asking for the next chunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchChunk {
    /// Graph version the row indices refer to. If it differs from the version of the
    /// first chunk, the graph changed: restart the search.
    pub version: u32,
    /// Matching rows found in this chunk, ascending.
    pub matches: Vec<u32>,
    /// Where to continue, `None` when the whole graph was scanned.
    pub next_row: Option<u32>,
    /// Rows known when this chunk was scanned (grows while the history walk runs).
    pub total_rows: u32,
}

/// Author or committer of a commit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub name: String,
    pub email: String,
    /// Seconds since the Unix epoch.
    pub time: f64,
    /// Time zone offset of the signature, in minutes east of UTC.
    pub offset_minutes: i32,
}

/// Kind of cryptographic signature attached to a commit (not verified yet, see F-066).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SignatureKind {
    Gpg,
    Ssh,
    X509,
    Unknown,
}

impl SignatureKind {
    /// Its `signature_code` value.
    pub fn code(self) -> u8 {
        match self {
            Self::Gpg => signature_code::GPG,
            Self::Ssh => signature_code::SSH,
            Self::X509 => signature_code::X509,
            Self::Unknown => signature_code::UNKNOWN,
        }
    }
}

/// Header of the commit detail panel. Files and diff come from the diff commands (M1-4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub sha: String,
    pub parents: Vec<String>,
    pub summary: String,
    /// Full message, summary included, without the trailing newline.
    pub message: String,
    pub author: Signature,
    pub committer: Signature,
    /// Refs pointing at this commit.
    pub refs: Vec<RefLabel>,
    pub signature: Option<SignatureKind>,
    /// Row in the current graph, when the commit is in it and the history walk already
    /// reached it (use `graph_index_of` to wait for it).
    pub row: Option<u32>,
}

/// Most refs a graph filter may hide (a hand-edited store must not slow every page down).
pub const GRAPH_FILTER_MAX: u32 = 1_000;

/// Refs left out of the graph (F-028) and first-parent mode (F-032), kept per repository.
/// HEAD's commit always stays, except in solo mode on another ref.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphFilter {
    /// Full names of hidden branches and tags (`refs/heads/x`, `refs/remotes/origin/x`):
    /// neither their tip nor their label is shown. Their commits stay when another ref
    /// reaches them. A name ending with `/` is a folder (`refs/heads/backup/`): it hides
    /// every ref under it, including those created later.
    pub hidden: Vec<String>,
    /// Full name of the only ref whose history is shown. Ignored when that ref no longer
    /// exists.
    pub solo: Option<String>,
    /// Every remote-tracking branch hidden.
    pub hide_remotes: bool,
    /// Stash labels hidden.
    pub hide_stashes: bool,
    /// First-parent history (F-032): every tip shown follows its first parents only, so a
    /// commit only reachable through a merge's other parents is not a row. Merges stay rows,
    /// without the lines to their other parents.
    #[serde(default)]
    pub first_parent: bool,
}

impl GraphFilter {
    /// Shows everything.
    pub fn is_empty(&self) -> bool {
        !self.filters_refs() && !self.first_parent
    }

    /// Leaves out some tips or labels.
    pub fn filters_refs(&self) -> bool {
        !self.hidden.is_empty() || self.solo.is_some() || self.hide_remotes || self.hide_stashes
    }

    /// Whether the tip and label of `full_name` are left out (solo aside).
    pub fn hides(&self, full_name: &str) -> bool {
        (self.hide_remotes && full_name.starts_with("refs/remotes/"))
            || self
                .hidden
                .iter()
                .any(|h| h == full_name || (h.ends_with('/') && full_name.starts_with(h.as_str())))
    }
}

/// A commit with what a list of commits shows (branch comparison).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ComparedCommit {
    pub sha: String,
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    /// Seconds since the Unix epoch.
    pub author_time: f64,
    /// Row in the current graph, `None` when it is not shown.
    pub row: Option<u32>,
}

/// Commits listed per side of a comparison, at most.
pub const COMPARE_MAX_COMMITS: u32 = 1_000;

/// Two revisions compared (F-104): the commits of each side not in the other, newest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    /// Full SHAs the revisions resolved to.
    pub a: String,
    pub b: String,
    /// Best common ancestor, `None` for unrelated histories.
    pub merge_base: Option<String>,
    /// In `a`, not in `b` (at most `COMPARE_MAX_COMMITS`).
    pub only_a: Vec<ComparedCommit>,
    /// In `b`, not in `a`.
    pub only_b: Vec<ComparedCommit>,
    /// Totals, beyond the lists when they are cut.
    pub only_a_count: u32,
    pub only_b_count: u32,
    /// Graph version the rows belong to.
    pub version: u32,
}
