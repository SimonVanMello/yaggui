//! Per-repository queue that serializes write operations on a dedicated thread.
//!
//! Two priorities: user operations, and background maintenance (e.g. writing the
//! commit-graph) that only runs when no user operation is waiting and is cancelled as soon
//! as one is enqueued, so it never delays what the user asked for.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread;

use crate::events::{
    BackendEvent, EventSink, OpFinished, OpKind, OpNote, OpOutcome, OpProgress, OpStarted,
};
use crate::git::cli::{CancelToken, GitProgress};
use crate::git::errors::{BackendError, ErrorCode, YagguiError};

/// Operation ids are unique across repositories, so `cancel_op` needs no repo id.
static NEXT_OP_ID: AtomicU32 = AtomicU32::new(1);

/// What a running operation can use: its cancel token and a progress reporter.
pub struct OpContext<'a> {
    pub repo_id: u32,
    pub op_id: u32,
    pub cancel: &'a CancelToken,
    sink: &'a dyn EventSink,
    note: Mutex<Option<OpNote>>,
}

impl OpContext<'_> {
    /// Qualifies a success in `op-finished` (Git reports a halted or aborted operation as a
    /// success); ignored when the operation fails.
    pub fn set_note(&self, note: OpNote) {
        *lock(&self.note) = Some(note);
    }

    pub fn progress(&self, progress: GitProgress) {
        self.sink.emit(BackendEvent::OpProgress(OpProgress {
            repo_id: self.repo_id,
            op_id: self.op_id,
            phase: progress.phase,
            percent: progress.percent,
            current: progress.current,
            total: progress.total,
            #[allow(clippy::cast_precision_loss)]
            bytes: progress.bytes.map(|b| b as f64),
            #[allow(clippy::cast_precision_loss)]
            bytes_per_sec: progress.bytes_per_sec.map(|b| b as f64),
        }));
    }
}

pub type OpJob = Box<dyn FnOnce(&OpContext<'_>) -> Result<(), YagguiError> + Send>;

struct QueuedOp {
    op_id: u32,
    kind: OpKind,
    cancellable: bool,
    cancel: CancelToken,
    job: OpJob,
    done: mpsc::Sender<Result<(), YagguiError>>,
}

/// Handle on an enqueued operation.
pub struct OpHandle {
    pub op_id: u32,
    done: mpsc::Receiver<Result<(), YagguiError>>,
}

impl OpHandle {
    /// Blocks until the operation finished (call from a blocking thread).
    pub fn wait(self) -> Result<(), YagguiError> {
        self.done.recv().unwrap_or_else(|_| Err(queue_stopped()))
    }
}

#[derive(Default)]
struct Pending {
    user: VecDeque<QueuedOp>,
    background: VecDeque<QueuedOp>,
    /// Cancel token of the background operation currently running.
    running_background: Option<CancelToken>,
    stopped: bool,
}

#[derive(Default)]
struct Shared {
    pending: Mutex<Pending>,
    wake: Condvar,
    /// Cancel tokens of queued and running operations.
    active: Mutex<HashMap<u32, CancelToken>>,
}

/// Serialized write queue of one repository. Dropping it lets the worker finish the
/// current operation, then stops it (queued operations are dropped).
pub struct OpQueue {
    shared: Arc<Shared>,
}

impl OpQueue {
    /// `status_generation` is bumped after each operation, before `op-finished`: what the
    /// operation changed is never answered from a status read made before it.
    pub fn new(
        repo_id: u32,
        sink: Arc<dyn EventSink>,
        status_generation: Arc<AtomicU64>,
    ) -> Result<Self, YagguiError> {
        let shared: Arc<Shared> = Arc::default();
        let worker = Arc::clone(&shared);
        thread::Builder::new()
            .name(format!("yaggui-ops-{repo_id}"))
            .spawn(move || {
                while let Some(op) = next_op(&worker) {
                    run_op(
                        repo_id,
                        op,
                        sink.as_ref(),
                        &worker.active,
                        &status_generation,
                    );
                    lock(&worker.pending).running_background = None;
                }
            })
            .map_err(|e| BackendError::io("cannot start the operation queue", e))?;
        Ok(Self { shared })
    }

    /// Queues `job`; it runs after every user operation enqueued before it, and cancels a
    /// running background operation.
    pub fn enqueue(
        &self,
        kind: OpKind,
        cancellable: bool,
        job: impl FnOnce(&OpContext<'_>) -> Result<(), YagguiError> + Send + 'static,
    ) -> Result<OpHandle, YagguiError> {
        self.push(kind, cancellable, false, Box::new(job))
    }

    /// Queues `job` like [`enqueue`](Self::enqueue) and blocks until it finished (call from a
    /// blocking thread), returning its value.
    pub fn run<T: Send + 'static>(
        &self,
        kind: OpKind,
        cancellable: bool,
        job: impl FnOnce(&OpContext<'_>) -> Result<T, YagguiError> + Send + 'static,
    ) -> Result<T, YagguiError> {
        let slot = Arc::new(Mutex::new(None));
        let out = Arc::clone(&slot);
        self.enqueue(kind, cancellable, move |ctx| {
            let value = job(ctx)?;
            *lock(&out) = Some(value);
            Ok(())
        })?
        .wait()?;
        lock(&slot)
            .take()
            .ok_or_else(|| BackendError::Invariant("operation returned no value".into()).into())
    }

    /// Queues a background job: it runs only when no user operation is waiting, and its
    /// cancel token is raised when one is enqueued (the job must stop cleanly then).
    pub fn enqueue_background(
        &self,
        kind: OpKind,
        job: impl FnOnce(&OpContext<'_>) -> Result<(), YagguiError> + Send + 'static,
    ) -> Result<OpHandle, YagguiError> {
        self.push(kind, true, true, Box::new(job))
    }

    fn push(
        &self,
        kind: OpKind,
        cancellable: bool,
        background: bool,
        job: OpJob,
    ) -> Result<OpHandle, YagguiError> {
        let op_id = NEXT_OP_ID.fetch_add(1, Ordering::Relaxed);
        let cancel = CancelToken::new();
        let (done_tx, done_rx) = mpsc::channel();
        let op = QueuedOp {
            op_id,
            kind,
            cancellable,
            cancel: cancel.clone(),
            job,
            done: done_tx,
        };
        let mut pending = lock(&self.shared.pending);
        if pending.stopped {
            return Err(queue_stopped());
        }
        lock(&self.shared.active).insert(op_id, cancel);
        if background {
            pending.background.push_back(op);
        } else {
            if let Some(running) = &pending.running_background {
                running.cancel();
            }
            pending.user.push_back(op);
        }
        drop(pending);
        self.shared.wake.notify_one();
        Ok(OpHandle {
            op_id,
            done: done_rx,
        })
    }

    /// Requests cancellation; returns `false` if the operation is unknown to this queue.
    pub fn cancel(&self, op_id: u32) -> bool {
        match lock(&self.shared.active).get(&op_id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Stops accepting operations; the worker exits after the current one.
    pub fn shutdown(&self) {
        for token in lock(&self.shared.active).values() {
            token.cancel();
        }
        let mut pending = lock(&self.shared.pending);
        pending.stopped = true;
        let mut dropped: Vec<QueuedOp> = pending.user.drain(..).collect();
        dropped.extend(pending.background.drain(..));
        drop(pending);
        let mut active = lock(&self.shared.active);
        for op in &dropped {
            active.remove(&op.op_id);
        }
        drop(active);
        self.shared.wake.notify_all();
    }
}

/// Next operation to run, user operations first; `None` once the queue is stopped.
fn next_op(shared: &Shared) -> Option<QueuedOp> {
    let mut pending = lock(&shared.pending);
    loop {
        if pending.stopped {
            return None;
        }
        if let Some(op) = pending.user.pop_front() {
            return Some(op);
        }
        if let Some(op) = pending.background.pop_front() {
            pending.running_background = Some(op.cancel.clone());
            return Some(op);
        }
        pending = shared
            .wake
            .wait(pending)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
    }
}

impl Drop for OpQueue {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_op(
    repo_id: u32,
    op: QueuedOp,
    sink: &dyn EventSink,
    active: &Mutex<HashMap<u32, CancelToken>>,
    status_generation: &AtomicU64,
) {
    let QueuedOp {
        op_id,
        kind,
        cancellable,
        cancel,
        job,
        done,
    } = op;
    sink.emit(BackendEvent::OpStarted(OpStarted {
        repo_id,
        op_id,
        kind,
        cancellable,
    }));
    let mut note = None;
    let result = if cancel.is_cancelled() {
        Err(YagguiError::cancelled())
    } else {
        let ctx = OpContext {
            repo_id,
            op_id,
            cancel: &cancel,
            sink,
            note: Mutex::new(None),
        };
        // A panicking job must not kill the worker: later operations would never run and
        // this one would never report `op-finished`.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(&ctx)))
            .unwrap_or_else(|payload| {
                let message = panic_message(payload.as_ref());
                tracing::error!(repo_id, op_id, %message, "operation panicked");
                Err(BackendError::Invariant(format!("operation panicked: {message}")).into())
            });
        note = lock(&ctx.note).take();
        result
    };
    lock(active).remove(&op_id);
    status_generation.fetch_add(1, Ordering::SeqCst);
    let outcome = match &result {
        Ok(()) => OpOutcome::Success { note },
        Err(err) if err.code == ErrorCode::Cancelled => OpOutcome::Cancelled,
        Err(err) => OpOutcome::Failed { error: err.clone() },
    };
    sink.emit(BackendEvent::OpFinished(OpFinished {
        repo_id,
        op_id,
        kind,
        outcome,
    }));
    // The caller may have stopped waiting; that is fine.
    let _ = done.send(result);
}

fn queue_stopped() -> YagguiError {
    BackendError::Invariant("operation queue stopped".into()).into()
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".to_owned())
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
