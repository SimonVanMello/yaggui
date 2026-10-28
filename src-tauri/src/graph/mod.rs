//! Commit graph: history loading, topological order, lane layout and pagination.
//!
//! Per session, a `GraphCache` keeps the snapshot of the current refs: commit store (every
//! commit loaded so far), row order, labels and the incremental layout. A request first
//! compares the refs fingerprint; the order is only recomputed when refs changed.
//!
//! The order is computed incrementally (`topo::Walk`): a page only waits for its own rows,
//! and a background thread finishes the walk, reporting progress to the listener (the
//! `graph-progress` event). Rows never move once emitted, so pages already sent stay valid;
//! operations that need a row further down (jumps) wait for the walk to reach it.
//!
//! First-parent mode (F-032, `GraphFilter::first_parent`) walks the same tips, each following
//! its first parents only: the walk, the lanes and the search all see a commit's parents cut
//! to the first one. The mode is part of the fingerprint, so it has its own snapshot.

pub mod layout;
pub mod search;
pub mod store;
pub mod topo;
pub mod types;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{Duration, Instant};

use gix::ObjectId;
use gix::bstr::ByteSlice;
use gix::objs::Find;

use crate::git::errors::{BackendError, YagguiError};
use crate::git::read::refs::{GraphRefs, graph_refs, refs_fingerprint};
use layout::{Layout, RowSource, color_hash};
use store::{CommitStore, GraphFiles, Node};
use topo::{Dag, Walk};
use types::{
    CommitDetail, GRAPH_PAGE_SIZE, GraphFilter, GraphLocation, GraphPage, GraphRef, GraphWip,
    RefKind, RefLabel, Signature, SignatureKind, signature_code,
};

/// Longest the walk holds its lock at once.
const WALK_STEP: Duration = Duration::from_millis(8);
/// Rows emitted between two clock checks.
const WALK_BATCH: u32 = 64;
/// Least time between two progress reports.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

/// Where the history walk of a graph version is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WalkProgress {
    pub version: u32,
    /// Rows so far: a lower bound until `exact`.
    pub total_rows: u32,
    pub exact: bool,
    /// The version was dropped (its order turned out wrong): reload the graph.
    pub stale: bool,
}

/// Receives the progress of the walks of a `GraphCache`.
pub type GraphListener = Arc<dyn Fn(WalkProgress) + Send + Sync>;

/// The store, seen by the walk.
struct StoreDag<'a> {
    store: &'a mut CommitStore,
    objects: &'a gix::OdbHandle,
    buf: &'a mut Vec<u8>,
    first_parent: bool,
}

impl Dag for StoreDag<'_> {
    fn node_count(&self) -> usize {
        self.store.len()
    }

    fn load(&mut self, node: Node) -> Result<bool, YagguiError> {
        self.store.load(self.objects, node, self.buf)
    }

    fn parents_into(&self, node: Node, out: &mut Vec<Node>) {
        self.store.parents_into(node, out);
        if self.first_parent {
            out.truncate(1);
        }
    }

    fn time(&self, node: Node) -> i64 {
        self.store.time(node)
    }

    fn generation(&self, node: Node) -> u32 {
        self.store.generation(node)
    }
}

/// Mutable part of a snapshot.
struct WalkState {
    store: CommitStore,
    walk: Walk,
    layout: Layout,
    buf: Vec<u8>,
    first_parent: bool,
    /// A page went out before the walk was done: report its progress and its end.
    reporting: bool,
    reported_at: Option<Instant>,
    reported_end: bool,
}

impl WalkState {
    fn total(&self) -> u32 {
        if self.walk.is_done() {
            self.walk.rows()
        } else {
            self.walk.total_estimate().max(self.walk.rows())
        }
    }

    /// Emits rows for at most `WALK_STEP`, or until `until`.
    fn work(
        &mut self,
        objects: &gix::OdbHandle,
        until: &dyn Fn(&WalkState) -> bool,
    ) -> Result<(), YagguiError> {
        let started = Instant::now();
        while !until(self) && !self.walk.is_finished() && started.elapsed() < WALK_STEP {
            let WalkState {
                store,
                walk,
                buf,
                first_parent,
                ..
            } = self;
            let target = walk.rows().saturating_add(WALK_BATCH);
            walk.ensure(
                &mut StoreDag {
                    store,
                    objects,
                    buf,
                    first_parent: *first_parent,
                },
                target,
            )?;
        }
        Ok(())
    }
}

/// The layout's view of the rows.
struct Rows<'a> {
    store: &'a CommitStore,
    walk: &'a Walk,
    labels: &'a HashMap<Node, Vec<RefLabel>>,
    first_parent: bool,
}

impl RowSource for Rows<'_> {
    fn node(&self, row: u32) -> Option<u32> {
        self.walk.node(row)
    }

    fn parents(&self, node: u32, out: &mut Vec<u32>) {
        self.store.parents_into(node, out);
        if self.first_parent {
            out.truncate(1);
        }
        topo::dedup_in_order(out);
        out.retain(|&p| self.walk.is_reached(p));
    }

    fn seed_color(&self, node: u32) -> u32 {
        let labels = self.labels.get(&node).map_or(&[][..], Vec::as_slice);
        if let Some(local) = labels.iter().find(|l| l.kind == RefKind::LocalBranch) {
            return color_hash(local.name.as_bytes());
        }
        if let Some(remote) = labels.iter().find(|l| l.kind == RefKind::RemoteBranch) {
            // `origin/feat/x` gets the color of `feat/x`.
            let name = remote
                .name
                .split_once('/')
                .map_or(&*remote.name, |(_, rest)| rest);
            return color_hash(name.as_bytes());
        }
        color_hash(self.store.id(node).to_hex().to_string().as_bytes())
    }
}

/// A row as the search scans it.
pub(crate) struct ScanRow {
    pub row: u32,
    pub id: ObjectId,
    /// Root tree, when known without reading the commit.
    pub tree: Option<ObjectId>,
    /// First parent, unless a shallow clone cut it off, with its root tree if known.
    pub parent: Option<(ObjectId, Option<ObjectId>)>,
}

/// One version of the graph: the rows of the refs it was computed for.
pub struct Snapshot {
    pub version: u32,
    fingerprint: u64,
    first_parent: bool,
    files: GraphFiles,
    has_commit_graph: bool,
    /// Labels by commit, in ref order.
    labels: HashMap<Node, Vec<RefLabel>>,
    state: Mutex<WalkState>,
    /// Requests waiting for `state`: the background walk steps aside.
    waiting: AtomicUsize,
    /// Mirrors of the walk's state, readable without the lock.
    finished: AtomicBool,
    broken: AtomicBool,
    /// Replaced by a newer version: the background walk stops.
    retired: AtomicBool,
    listener: Option<GraphListener>,
}

impl Snapshot {
    /// Rows so far: exact once the walk is done (see `is_complete`), a lower bound before.
    pub fn total_rows(&self) -> u32 {
        self.lock().total()
    }

    /// Every row is known.
    pub fn is_complete(&self) -> bool {
        self.finished.load(Ordering::SeqCst) && !self.is_broken()
    }

    /// The walk found its order wrong (dates far off): the next request rebuilds the graph.
    pub fn is_broken(&self) -> bool {
        self.broken.load(Ordering::SeqCst)
    }

    pub fn has_commit_graph(&self) -> bool {
        self.has_commit_graph
    }

    /// Rows follow first parents only (F-032).
    pub fn is_first_parent(&self) -> bool {
        self.first_parent
    }

    /// Commits decoded so far that the commit-graph file does not have.
    pub fn outside_graph(&self) -> usize {
        self.lock().store.outside_graph()
    }

    /// Walks the whole history; returns the number of rows.
    pub fn complete(&self, objects: &gix::OdbHandle) -> Result<u32, YagguiError> {
        Ok(self.advance(objects, &|_| false)?.total())
    }

    /// Row of a commit if the walk already reached it, without waiting.
    pub fn row_of(&self, id: &gix::oid) -> Option<u32> {
        let state = self.lock();
        state.store.lookup(id).and_then(|node| state.walk.row(node))
    }

    /// Row of a commit, walking the history as far as needed: `None` when it is not in the
    /// graph (which takes walking it all).
    pub fn find_row(
        &self,
        objects: &gix::OdbHandle,
        id: &gix::oid,
    ) -> Result<Option<u32>, YagguiError> {
        let row = |state: &WalkState| state.store.lookup(id).and_then(|n| state.walk.row(n));
        let state = self.advance(objects, &|state| row(state).is_some())?;
        Ok(row(&state))
    }

    /// Ref labels of a commit.
    pub fn labels_of(&self, id: &gix::oid) -> Vec<RefLabel> {
        let node = self.lock().store.lookup(id);
        node.and_then(|node| self.labels.get(&node))
            .cloned()
            .unwrap_or_default()
    }

    /// Rows `from..from + count` (fewer at the end), for the search.
    pub(crate) fn scan_rows(
        &self,
        objects: &gix::OdbHandle,
        from: u32,
        count: u32,
    ) -> Result<Vec<ScanRow>, YagguiError> {
        let end = from.saturating_add(count);
        let state = self.advance(objects, &|state| state.walk.rows() >= end)?;
        let mut parents = Vec::new();
        let rows = (from..end.min(state.walk.rows()))
            .filter_map(|row| {
                let node = state.walk.node(row)?;
                let store = &state.store;
                store.parents_into(node, &mut parents);
                // A parent cut off by a shallow clone counts as no parent, like Git.
                let parent = parents
                    .first()
                    .filter(|&&p| store.is_present(p))
                    .map(|&p| (store.id(p), store.root_tree(p)));
                Some(ScanRow {
                    row,
                    id: store.id(node),
                    tree: store.root_tree(node),
                    parent,
                })
            })
            .collect();
        Ok(rows)
    }

    fn lock(&self) -> MutexGuard<'_, WalkState> {
        lock(&self.state)
    }

    /// Walks until `until` holds or the walk is finished, letting other requests in between
    /// steps; returns with the lock held.
    fn advance(
        &self,
        objects: &gix::OdbHandle,
        until: &dyn Fn(&WalkState) -> bool,
    ) -> Result<MutexGuard<'_, WalkState>, YagguiError> {
        self.waiting.fetch_add(1, Ordering::SeqCst);
        let result = (|| loop {
            let mut state = self.lock();
            if until(&state) || state.walk.is_finished() {
                return Ok(state);
            }
            state.work(objects, until)?;
            self.report(&mut state);
            if until(&state) || state.walk.is_finished() {
                return Ok(state);
            }
            drop(state);
            std::thread::yield_now();
        })();
        self.waiting.fetch_sub(1, Ordering::SeqCst);
        result
    }

    /// One step of the background walk; `true` when there is nothing left to do.
    fn background_step(&self, objects: &gix::OdbHandle) -> Result<bool, YagguiError> {
        while self.waiting.load(Ordering::SeqCst) > 0 {
            if self.retired.load(Ordering::SeqCst) {
                return Ok(true);
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        if self.retired.load(Ordering::SeqCst) {
            return Ok(true);
        }
        let mut state = self.lock();
        state.work(objects, &|_| false)?;
        self.report(&mut state);
        Ok(state.walk.is_finished())
    }

    /// Mirrors the walk's state and tells the listener about it, if a page was served early.
    fn report(&self, state: &mut WalkState) {
        let broken = state.walk.is_broken();
        self.finished
            .store(state.walk.is_finished(), Ordering::SeqCst);
        if broken && !self.broken.swap(true, Ordering::SeqCst) {
            tracing::warn!(
                version = self.version,
                rows = state.walk.rows(),
                "commit dates misled the history walk, recomputing the graph"
            );
            self.notify(state, true);
            return;
        }
        if !state.reporting || state.reported_end || broken {
            return;
        }
        if state.walk.is_done() {
            state.reported_end = true;
            tracing::info!(
                version = self.version,
                rows = state.walk.rows(),
                "history walk done"
            );
        } else if state
            .reported_at
            .is_some_and(|at| at.elapsed() < PROGRESS_EVERY)
        {
            return;
        }
        state.reported_at = Some(Instant::now());
        self.notify(state, false);
    }

    fn notify(&self, state: &WalkState, stale: bool) {
        if let Some(listener) = &self.listener {
            listener(WalkProgress {
                version: self.version,
                total_rows: state.total(),
                exact: state.walk.is_done(),
                stale,
            });
        }
    }

    /// Stops the background walk (a newer version replaces this one).
    fn retire(&self) {
        self.retired.store(true, Ordering::SeqCst);
    }

    /// A copy of the commit store for the next version, `None` when the commit-graph files
    /// changed (node numbers are no longer valid).
    fn copy_store(&self, repo: &gix::Repository) -> Option<CommitStore> {
        let state = self.lock();
        (!state.store.is_stale()).then(|| state.store.duplicate(repo))
    }
}

#[derive(Default)]
struct BuildState {
    next_version: u32,
    /// A walk of this session was misled by dates: explore the whole history first.
    exact: bool,
}

/// Graph state of one repository session.
#[derive(Default)]
pub struct GraphCache {
    /// Published snapshot: readers never wait for a rebuild.
    current: RwLock<Option<Arc<Snapshot>>>,
    /// Held during a rebuild, so concurrent requests wait for it instead of rebuilding twice.
    build: Mutex<BuildState>,
    /// Refs left out (F-028); part of the fingerprint, so a change rebuilds the graph.
    filter: RwLock<GraphFilter>,
    listener: RwLock<Option<GraphListener>>,
    /// Finish walks on the calling thread only (tests, benchmarks).
    no_background: AtomicBool,
}

impl GraphCache {
    /// The snapshot of the current refs, computed if they changed since the last call.
    pub fn snapshot(&self, repo: &gix::Repository) -> Result<Arc<Snapshot>, YagguiError> {
        self.snapshot_at(repo, refs_fingerprint(repo)?)
    }

    /// Receives the progress of the history walks.
    pub fn set_listener(&self, listener: GraphListener) {
        *write(&self.listener) = Some(listener);
    }

    /// Walks only advance when a request needs more rows (no background thread).
    pub fn without_background(self) -> Self {
        self.no_background.store(true, Ordering::SeqCst);
        self
    }

    pub fn filter(&self) -> GraphFilter {
        read(&self.filter).clone()
    }

    /// Replaces the filter; the next request rebuilds the graph.
    pub fn set_filter(&self, filter: GraphFilter) {
        *write(&self.filter) = filter;
    }

    /// The refs fingerprint combined with the filter.
    fn filtered(&self, fingerprint: u64) -> (u64, GraphFilter) {
        let filter = self.filter();
        if filter.is_empty() {
            return (fingerprint, filter);
        }
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        std::hash::Hash::hash(&fingerprint, &mut hasher);
        std::hash::Hash::hash(&filter, &mut hasher);
        (std::hash::Hasher::finish(&hasher), filter)
    }

    /// Like [`snapshot`](Self::snapshot), with the refs fingerprint already known.
    pub fn snapshot_at(
        &self,
        repo: &gix::Repository,
        fingerprint: u64,
    ) -> Result<Arc<Snapshot>, YagguiError> {
        let (fingerprint, filter) = self.filtered(fingerprint);
        if let Some(snapshot) = self.fresh(fingerprint) {
            return Ok(snapshot);
        }
        let mut state = lock(&self.build);
        // Another request may have rebuilt it while this one waited.
        if let Some(snapshot) = self.fresh(fingerprint) {
            return Ok(snapshot);
        }
        let refs = filter_refs(graph_refs(repo)?, &filter);
        let previous = read(&self.current).clone();
        let store = match &previous {
            Some(previous) => {
                previous.retire();
                state.exact |= previous.is_broken();
                previous.copy_store(repo)
            }
            None => None,
        };
        let store = store.unwrap_or_else(|| CommitStore::new(repo));
        state.next_version = state.next_version.wrapping_add(1);
        let snapshot = Arc::new(build(
            repo,
            store,
            refs,
            fingerprint,
            state.next_version,
            WalkMode {
                exact: state.exact,
                first_parent: filter.first_parent,
            },
            read(&self.listener).clone(),
        )?);
        *write(&self.current) = Some(Arc::clone(&snapshot));
        drop(previous);
        if !self.no_background.load(Ordering::SeqCst) {
            spawn_walk(repo, &snapshot);
        }
        Ok(snapshot)
    }

    fn fresh(&self, fingerprint: u64) -> Option<Arc<Snapshot>> {
        read(&self.current)
            .as_ref()
            .filter(|s| s.fingerprint == fingerprint && !s.is_broken() && !s.files.is_stale())
            .cloned()
    }

    /// The current snapshot if it matches `fingerprint`, without computing or waiting.
    pub fn current(&self, fingerprint: u64) -> Option<Arc<Snapshot>> {
        let (fingerprint, _) = self.filtered(fingerprint);
        read(&self.current)
            .as_ref()
            .filter(|s| s.fingerprint == fingerprint)
            .cloned()
    }
}

/// Finishes the walk of `snapshot` on a background thread, until it is done or replaced.
fn spawn_walk(repo: &gix::Repository, snapshot: &Arc<Snapshot>) {
    if snapshot.finished.load(Ordering::SeqCst) {
        return;
    }
    let weak = Arc::downgrade(snapshot);
    let repo = repo.clone().into_sync();
    let spawned = std::thread::Builder::new()
        .name("graph-walk".into())
        .spawn(move || {
            let repo = repo.to_thread_local();
            while let Some(snapshot) = weak.upgrade() {
                match snapshot.background_step(&repo.objects) {
                    Ok(false) => {}
                    Ok(true) => break,
                    Err(err) => {
                        // Requests that need these rows will meet the error themselves.
                        tracing::warn!(error = %err, "background history walk stopped");
                        break;
                    }
                }
                drop(snapshot);
                std::thread::yield_now();
            }
        });
    if let Err(err) = spawned {
        tracing::warn!(error = %err, "no background history walk, rows load on demand");
    }
}

/// The refs the graph shows under `filter`. HEAD stays unless another ref is soloed; a solo
/// ref that no longer exists is ignored.
pub fn filter_refs(refs: GraphRefs, filter: &GraphFilter) -> GraphRefs {
    if !filter.filters_refs() {
        return refs;
    }
    let GraphRefs { labels, head, .. } = refs;
    let solo = filter.solo.as_deref().and_then(|solo| {
        labels
            .iter()
            .find(|(_, label)| label.full_name == solo && label.kind != RefKind::Stash)
            .map(|(id, label)| (*id, label.is_head))
    });
    let tips: Vec<ObjectId> = match solo {
        Some((id, _)) => vec![id],
        None => {
            // `tips` holds the labelled refs in order, then HEAD: rebuild it from the labels
            // that stay.
            let mut kept: Vec<ObjectId> = labels
                .iter()
                .filter(|(_, l)| {
                    matches!(
                        l.kind,
                        RefKind::LocalBranch | RefKind::RemoteBranch | RefKind::Tag
                    ) && !filter.hides(&l.full_name)
                })
                .map(|(id, _)| *id)
                .collect();
            kept.extend(head.as_ref().map(|(id, _)| *id));
            kept
        }
    };
    let head = match solo {
        Some((_, false)) => None,
        _ => head,
    };
    let labels = labels
        .into_iter()
        .filter(|(_, l)| match l.kind {
            RefKind::Stash => !filter.hide_stashes,
            RefKind::Head => solo.is_none(),
            // A hidden folder can hold the checked-out branch: its commits stay, so does its
            // label.
            _ => l.is_head || !filter.hides(&l.full_name),
        })
        .collect();
    GraphRefs { tips, labels, head }
}

/// How a version walks the history.
#[derive(Clone, Copy)]
struct WalkMode {
    /// Explore the whole history before the first row (dates misled a walk of this session).
    exact: bool,
    /// Follow first parents only (F-032).
    first_parent: bool,
}

fn build(
    repo: &gix::Repository,
    mut store: CommitStore,
    refs: GraphRefs,
    fingerprint: u64,
    version: u32,
    WalkMode {
        exact,
        first_parent,
    }: WalkMode,
    listener: Option<GraphListener>,
) -> Result<Snapshot, YagguiError> {
    let started = Instant::now();
    store.load_shallow(repo)?;
    let tips: Vec<Node> = refs.tips.iter().map(|id| store.node_of(*id)).collect();
    let mut labels: HashMap<Node, Vec<RefLabel>> = HashMap::new();
    for (id, label) in refs.labels {
        labels.entry(store.node_of(id)).or_default().push(label);
    }
    let head = refs
        .head
        .map(|(id, seed)| (store.node_of(id), color_hash(seed.as_bytes())));
    let mut buf = Vec::new();
    let walk = Walk::new(
        &mut StoreDag {
            store: &mut store,
            objects: &repo.objects,
            buf: &mut buf,
            first_parent,
        },
        &tips,
        exact,
    )?;
    // HEAD's commit can be missing (corruption): no WIP line then.
    let head = head.filter(|&(node, _)| walk.is_reached(node));
    tracing::info!(
        tips = tips.len(),
        commit_graph = store.has_commit_graph(),
        first_parent,
        exact,
        total_ms = started.elapsed().as_millis() as u64,
        version,
        "graph walk started"
    );
    let finished = walk.is_finished();
    Ok(Snapshot {
        version,
        fingerprint,
        first_parent,
        files: store.files().clone(),
        has_commit_graph: store.has_commit_graph(),
        labels,
        state: Mutex::new(WalkState {
            store,
            walk,
            layout: Layout::new(head),
            buf,
            first_parent,
            reporting: false,
            reported_at: None,
            reported_end: false,
        }),
        waiting: AtomicUsize::new(0),
        finished: AtomicBool::new(finished),
        broken: AtomicBool::new(false),
        retired: AtomicBool::new(false),
        listener,
    })
}

/// Summary, author and dates of a commit, as shown in a graph row.
pub(crate) struct RowCommit {
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: f64,
    pub commit_time: f64,
    pub signature: Option<SignatureKind>,
}

pub(crate) fn decode_row(
    objects: &gix::OdbHandle,
    id: &gix::oid,
    buf: &mut Vec<u8>,
) -> Result<RowCommit, YagguiError> {
    let data = objects
        .try_find(id, buf)
        .map_err(|err| BackendError::gix("read a commit", err))?
        .ok_or_else(|| YagguiError::internal(format!("commit {id} not found")))?;
    let commit = gix::objs::CommitRef::from_bytes(data.data, id.kind())
        .map_err(|err| BackendError::gix("decode a commit", err))?;
    let author = commit.author().ok();
    let committer = commit.committer().ok();
    Ok(RowCommit {
        summary: commit.message().summary().to_string(),
        author_name: author
            .map(|a| a.name.to_str_lossy().trim().to_owned())
            .unwrap_or_default(),
        author_email: author
            .map(|a| a.email.to_str_lossy().trim().to_owned())
            .unwrap_or_default(),
        author_time: author.map_or(0.0, |a| a.seconds() as f64),
        commit_time: committer.map_or(0.0, |c| c.seconds() as f64),
        signature: header_signature(&commit),
    })
}

/// Rows `start..start + limit` of the snapshot, walking the history as far as needed.
pub fn page(
    repo: &gix::Repository,
    snapshot: &Snapshot,
    start: u32,
    limit: u32,
) -> Result<GraphPage, YagguiError> {
    let limit = limit.min(GRAPH_PAGE_SIZE);
    // One row more: the edges of the last row depend on the lane of the next one.
    let wanted = start.saturating_add(limit).saturating_add(1);
    let mut state = snapshot.advance(&repo.objects, &|state| state.walk.rows() >= wanted)?;
    let rows = state.walk.rows();
    let start = start.min(rows);
    let end = start.saturating_add(limit).min(rows);
    let total = state.total();
    let exact = state.walk.is_done();
    if !exact {
        state.reporting = true;
    }
    let WalkState {
        store,
        walk,
        layout,
        ..
    } = &mut *state;
    let layout_rows = layout.rows(
        &Rows {
            store,
            walk,
            labels: &snapshot.labels,
            first_parent: snapshot.first_parent,
        },
        start,
        end,
    );
    let wip = layout.wip().and_then(|wip| {
        walk.row(wip.head).map(|head_row| GraphWip {
            lane: wip.lane,
            color: wip.color,
            head_row,
        })
    });
    let count = (end - start) as usize;
    let mut ids = Vec::with_capacity(count);
    let mut page = GraphPage {
        version: snapshot.version,
        start,
        total_rows: total,
        total_exact: exact,
        lane_count: layout_rows.lane_count,
        wip,
        shas: Vec::with_capacity(count),
        parents: Vec::with_capacity(count),
        summaries: Vec::with_capacity(count),
        author_names: Vec::with_capacity(count),
        author_emails: Vec::with_capacity(count),
        author_times: Vec::with_capacity(count),
        commit_times: Vec::with_capacity(count),
        lanes: layout_rows.lanes,
        colors: layout_rows.colors,
        signatures: Vec::with_capacity(count),
        edge_offsets: layout_rows.edge_offsets,
        edges: layout_rows.edges,
        refs: Vec::new(),
    };
    let mut parents = Vec::new();
    for row in start..end {
        let Some(node) = walk.node(row) else {
            break;
        };
        let id = store.id(node);
        ids.push(id);
        store.parents_into(node, &mut parents);
        page.shas.push(id.to_string());
        page.parents
            .push(parents.iter().map(|&p| store.id(p).to_string()).collect());
        if let Some(labels) = snapshot.labels.get(&node) {
            page.refs.extend(labels.iter().map(|label| GraphRef {
                row,
                label: label.clone(),
            }));
        }
    }
    drop(state);
    let mut buf = Vec::new();
    for id in &ids {
        let commit = decode_row(&repo.objects, id, &mut buf)?;
        page.summaries.push(commit.summary);
        page.author_names.push(commit.author_name);
        page.author_emails.push(commit.author_email);
        page.author_times.push(commit.author_time);
        page.commit_times.push(commit.commit_time);
        page.signatures.push(
            commit
                .signature
                .map_or(signature_code::NONE, SignatureKind::code),
        );
    }
    Ok(page)
}

/// Resolves a revision to a commit and its row.
pub fn index_of(
    repo: &gix::Repository,
    snapshot: &Snapshot,
    rev: &str,
) -> Result<GraphLocation, YagguiError> {
    let id = resolve_commit(repo, rev)?;
    Ok(GraphLocation {
        version: snapshot.version,
        sha: id.to_string(),
        row: snapshot.find_row(&repo.objects, &id)?,
    })
}

pub(crate) fn resolve_commit(repo: &gix::Repository, rev: &str) -> Result<ObjectId, YagguiError> {
    let rev = rev.trim();
    if rev.is_empty() || rev.starts_with('-') {
        return Err(YagguiError::revision_not_found(rev));
    }
    let id = repo
        .rev_parse_single(rev)
        .map_err(|err| YagguiError::revision_not_found(rev).with_detail(err.to_string()))?;
    let commit = id
        .object()
        .and_then(|object| object.peel_to_commit())
        .map_err(|err| YagguiError::revision_not_found(rev).with_detail(err.to_string()))?;
    Ok(commit.id)
}

/// Header data of a commit; `snapshot` gives its refs and row.
pub fn commit_detail(
    repo: &gix::Repository,
    snapshot: &Snapshot,
    sha: &str,
) -> Result<CommitDetail, YagguiError> {
    let not_found = || YagguiError::revision_not_found(sha);
    let id = ObjectId::from_hex(sha.trim().as_bytes()).map_err(|_| not_found())?;
    let commit = repo.find_commit(id).map_err(|_| not_found())?;
    let decoded = commit
        .decode()
        .map_err(|err| BackendError::gix("decode a commit", err))?;
    let signature = |sig: Result<gix::actor::SignatureRef<'_>, _>| -> Signature {
        let sig = sig.ok();
        let time = sig.and_then(|s| s.time().ok());
        Signature {
            name: sig
                .map(|s| s.name.to_str_lossy().trim().to_owned())
                .unwrap_or_default(),
            email: sig
                .map(|s| s.email.to_str_lossy().trim().to_owned())
                .unwrap_or_default(),
            time: time.map_or(0.0, |t| t.seconds as f64),
            offset_minutes: time.map_or(0, |t| t.offset / 60),
        }
    };
    let message = decoded.message.to_string();
    let row = snapshot.row_of(&id);
    Ok(CommitDetail {
        sha: id.to_string(),
        parents: decoded.parents().map(|p| p.to_string()).collect(),
        summary: decoded.message().summary().to_string(),
        message: message.trim_end().to_owned(),
        author: signature(decoded.author()),
        committer: signature(decoded.committer()),
        refs: snapshot.labels_of(&id),
        signature: header_signature(&decoded),
        row,
    })
}

/// Kind of the signature in the commit header, read from the already parsed headers: no gpg or
/// ssh-keygen run, nothing verified. `gpgsig-sha256` is what a SHA-256 repository writes (and
/// what a converted commit may carry besides `gpgsig`).
fn header_signature(commit: &gix::objs::CommitRef<'_>) -> Option<SignatureKind> {
    commit
        .extra_headers
        .iter()
        .find(|(name, _)| {
            *name == gix::objs::commit::SIGNATURE_FIELD_NAME
                || *name == gix::objs::commit::SIGNATURE_FIELD_NAME_SHA256
        })
        .map(|(_, value)| signature_kind(value.as_ref()))
}

fn signature_kind(signature: &[u8]) -> SignatureKind {
    let text = String::from_utf8_lossy(signature);
    let text = text.trim_start();
    if text.starts_with("-----BEGIN PGP SIGNATURE-----") {
        SignatureKind::Gpg
    } else if text.starts_with("-----BEGIN SSH SIGNATURE-----") {
        SignatureKind::Ssh
    } else if text.starts_with("-----BEGIN SIGNED MESSAGE-----") {
        SignatureKind::X509
    } else {
        SignatureKind::Unknown
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn read<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(PoisonError::into_inner)
}

fn write<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind_of(header: &str) -> Option<SignatureKind> {
        let headers = if header.is_empty() {
            String::new()
        } else {
            format!("{header}\n")
        };
        let raw = format!(
            "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\
             author A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n{headers}\nmessage\n"
        );
        let commit = gix::objs::CommitRef::from_bytes(raw.as_bytes(), gix::hash::Kind::Sha1)
            .unwrap_or_else(|err| panic!("{header:?}: {err:?}"));
        header_signature(&commit)
    }

    #[test]
    fn signature_kind_comes_from_the_header() {
        assert_eq!(kind_of(""), None);
        assert_eq!(
            kind_of("gpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----"),
            Some(SignatureKind::Gpg)
        );
        assert_eq!(
            kind_of("gpgsig -----BEGIN SSH SIGNATURE-----\n abc\n -----END SSH SIGNATURE-----"),
            Some(SignatureKind::Ssh)
        );
        assert_eq!(
            kind_of("gpgsig -----BEGIN SIGNED MESSAGE-----\n abc\n -----END SIGNED MESSAGE-----"),
            Some(SignatureKind::X509)
        );
        assert_eq!(
            kind_of(
                "gpgsig-sha256 -----BEGIN PGP SIGNATURE-----\n abc\n -----END PGP SIGNATURE-----"
            ),
            Some(SignatureKind::Gpg)
        );
        assert_eq!(kind_of("gpgsig garbage"), Some(SignatureKind::Unknown));
        assert_eq!(kind_of("mergetag object 1234"), None);
        assert_eq!(SignatureKind::Ssh.code(), signature_code::SSH);
    }
}
