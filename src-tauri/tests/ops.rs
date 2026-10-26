//! Operation queue, git command log and progress events, on generated fixtures.

mod common;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{Fixture, backend};
use yaggui_lib::events::{BackendEvent, OpKind, OpOutcome};
use yaggui_lib::git::cli::GitCommand;
use yaggui_lib::git::errors::ErrorCode;
use yaggui_lib::git::log::CommandStatus;

#[test]
fn operations_run_one_at_a_time_in_order() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let session = b.repos.session(id).unwrap();
    let order = Arc::new(Mutex::new(Vec::new()));

    let handles: Vec<_> = (0..3)
        .map(|n| {
            let order = order.clone();
            session
                .queue()
                .enqueue(OpKind::Maintenance, false, move |_ctx| {
                    order.lock().unwrap().push(format!("start {n}"));
                    std::thread::sleep(Duration::from_millis(30));
                    order.lock().unwrap().push(format!("end {n}"));
                    Ok(())
                })
                .unwrap()
        })
        .collect();
    for handle in handles {
        handle.wait().unwrap();
    }
    assert_eq!(
        *order.lock().unwrap(),
        ["start 0", "end 0", "start 1", "end 1", "start 2", "end 2"]
    );

    let lifecycle: Vec<&str> = b
        .sink
        .events()
        .iter()
        .filter_map(|e| match e {
            BackendEvent::OpStarted(_) => Some("started"),
            BackendEvent::OpFinished(f) if matches!(f.outcome, OpOutcome::Success { .. }) => {
                Some("ok")
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        lifecycle,
        ["started", "ok", "started", "ok", "started", "ok"]
    );
}

#[test]
fn git_writes_through_the_queue_are_logged_with_progress() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let session = b.repos.session(id).unwrap();
    let git = b.git.clone();
    let origin = format!("file://{}", fx.root.join("origin.git").display());
    let target = fx.root.join("clone");
    let cwd = fx.repo();

    session
        .queue()
        .enqueue(OpKind::Fetch, true, move |ctx| {
            let mut report = |p| ctx.progress(p);
            git.run_with(
                &GitCommand::new(["clone", "--progress", "--", &origin])
                    .arg(&target)
                    .cwd(&cwd)
                    .repo(ctx.repo_id),
                Some(ctx.cancel),
                Some(&mut report),
            )
            .map(|_| ())
        })
        .unwrap()
        .wait()
        .unwrap();

    assert!(fx.root.join("clone/README.md").exists());
    let events = b.sink.events();
    assert!(
        events.iter().any(
            |e| matches!(e, BackendEvent::OpProgress(p) if p.repo_id == id && !p.phase.is_empty())
        ),
        "no progress event in {events:?}"
    );
    let logged: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            BackendEvent::CommandLogged(c) => Some(&c.entry),
            _ => None,
        })
        .collect();
    let clone = logged
        .iter()
        .find(|e| e.args[0] == "clone")
        .expect("clone logged");
    assert_eq!(clone.repo_id, Some(id));
    assert_eq!(clone.status, CommandStatus::Success);
    assert_eq!(clone.exit_code, Some(0));
    assert!(clone.stderr.contains("Receiving objects") || clone.stderr.contains("Cloning"));
    assert_eq!(b.git.log().entries().last().map(|e| e.id), Some(clone.id));
}

#[test]
fn a_running_git_command_can_be_cancelled() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let session = b.repos.session(id).unwrap();
    let git = b.git.clone();
    let cwd = fx.repo();

    // A git alias running a shell command stands in for a slow network operation.
    let handle = session
        .queue()
        .enqueue(OpKind::Fetch, true, move |ctx| {
            git.run_with(
                &GitCommand::new(["-c", "alias.slow=!sleep 5", "slow"]).cwd(&cwd),
                Some(ctx.cancel),
                None,
            )
            .map(|_| ())
        })
        .unwrap();
    let op_id = handle.op_id;
    assert!(b.sink.wait_for(
        Duration::from_secs(2),
        |e| matches!(e, BackendEvent::OpStarted(s) if s.op_id == op_id)
    ));
    std::thread::sleep(Duration::from_millis(100));

    let start = Instant::now();
    b.repos.cancel_op(op_id).unwrap();
    let err = handle.wait().unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "cancel took {:?}",
        start.elapsed()
    );

    assert!(b.sink.events().iter().any(|e| matches!(
        e,
        BackendEvent::OpFinished(f) if f.op_id == op_id && matches!(f.outcome, OpOutcome::Cancelled)
    )));
    assert_eq!(
        b.git.log().entries().last().unwrap().status,
        CommandStatus::Cancelled
    );
    assert_eq!(
        b.repos.cancel_op(op_id).unwrap_err().code,
        ErrorCode::OpNotFound
    );
}

#[test]
fn a_queued_operation_cancelled_before_start_never_runs() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let queue = b.repos.session(id).unwrap();
    let queue = queue.queue();

    let blocker = queue
        .enqueue(OpKind::Maintenance, false, |_| {
            std::thread::sleep(Duration::from_millis(200));
            Ok(())
        })
        .unwrap();
    let ran = Arc::new(Mutex::new(false));
    let ran_in_job = ran.clone();
    let queued = queue
        .enqueue(OpKind::Fetch, true, move |_| {
            *ran_in_job.lock().unwrap() = true;
            Ok(())
        })
        .unwrap();
    assert!(queue.cancel(queued.op_id));
    blocker.wait().unwrap();
    assert_eq!(queued.wait().unwrap_err().code, ErrorCode::Cancelled);
    assert!(!*ran.lock().unwrap());
}

#[test]
fn failed_operations_carry_the_typed_error() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let git = b.git.clone();
    let cwd = fx.repo();
    let err = b
        .repos
        .session(id)
        .unwrap()
        .queue()
        .enqueue(OpKind::Checkout, false, move |_| {
            git.run(&GitCommand::new(["checkout", "no-such-branch"]).cwd(&cwd))
                .map(|_| ())
        })
        .unwrap()
        .wait()
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::GitFailed);
    assert!(err.detail.unwrap().contains("no-such-branch"));
    assert!(b.sink.events().iter().any(|e| matches!(
        e,
        BackendEvent::OpFinished(f) if matches!(&f.outcome, OpOutcome::Failed { error } if error.code == ErrorCode::GitFailed)
    )));
}

#[test]
fn a_panicking_job_does_not_kill_the_queue() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let session = b.repos.session(id).unwrap();
    let queue = session.queue();

    let panicking = queue
        .enqueue(OpKind::Maintenance, false, |_| panic!("boom"))
        .unwrap();
    let panicking_id = panicking.op_id;
    let err = panicking.wait().unwrap_err();
    assert_eq!(err.code, ErrorCode::Internal);
    assert!(err.detail.unwrap().contains("boom"));
    assert!(b.sink.events().iter().any(|e| matches!(
        e,
        BackendEvent::OpFinished(f) if f.op_id == panicking_id && matches!(f.outcome, OpOutcome::Failed { .. })
    )));

    // The worker is still alive and the panicked op is no longer tracked.
    queue
        .enqueue(OpKind::Maintenance, false, |_| Ok(()))
        .unwrap()
        .wait()
        .unwrap();
    assert!(!queue.cancel(panicking_id));
}

#[test]
fn background_operations_yield_to_user_operations() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let session = b.repos.session(id).unwrap();
    let queue = session.queue();
    let order = Arc::new(Mutex::new(Vec::new()));

    let blocker = queue
        .enqueue(OpKind::Maintenance, false, |_| {
            std::thread::sleep(Duration::from_millis(100));
            Ok(())
        })
        .unwrap();
    // Queued before the user operation, but runs after it.
    let log = order.clone();
    let background = queue
        .enqueue_background(OpKind::CommitGraph, move |ctx| {
            log.lock().unwrap().push("background start");
            // Stands for a long `git commit-graph write`: stops when preempted.
            let started = Instant::now();
            while !ctx.cancel.is_cancelled() && started.elapsed() < Duration::from_secs(5) {
                std::thread::sleep(Duration::from_millis(5));
            }
            log.lock().unwrap().push("background end");
            if ctx.cancel.is_cancelled() {
                Err(yaggui_lib::git::errors::YagguiError::cancelled())
            } else {
                Ok(())
            }
        })
        .unwrap();
    let log = order.clone();
    let user = queue
        .enqueue(OpKind::Fetch, true, move |_| {
            log.lock().unwrap().push("user");
            Ok(())
        })
        .unwrap();
    blocker.wait().unwrap();
    user.wait().unwrap();
    assert_eq!(order.lock().unwrap().first(), Some(&"user"));

    // A user operation enqueued while the background one runs preempts it.
    let deadline = Instant::now() + Duration::from_secs(5);
    while order.lock().unwrap().len() < 2 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    let log = order.clone();
    let started = Instant::now();
    let second = queue
        .enqueue(OpKind::Fetch, true, move |_| {
            log.lock().unwrap().push("user 2");
            Ok(())
        })
        .unwrap();
    second.wait().unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(background.wait().unwrap_err().code, ErrorCode::Cancelled);
    assert_eq!(
        *order.lock().unwrap(),
        ["user", "background start", "background end", "user 2"]
    );
}

#[test]
fn a_non_cancellable_operation_survives_cancel_and_shutdown() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let session = b.repos.session(id).unwrap();
    let queue = session.queue();

    // Cancel is refused: the token is never raised and the job finishes normally.
    let interrupted = Arc::new(Mutex::new(false));
    let seen = interrupted.clone();
    let handle = queue
        .enqueue(OpKind::Commit, false, move |ctx| {
            let started = Instant::now();
            while started.elapsed() < Duration::from_millis(300) {
                if ctx.cancel.is_cancelled() {
                    *seen.lock().unwrap() = true;
                    return Err(yaggui_lib::git::errors::YagguiError::cancelled());
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(())
        })
        .unwrap();
    let op_id = handle.op_id;
    assert!(b.sink.wait_for(
        Duration::from_secs(2),
        |e| matches!(e, BackendEvent::OpStarted(s) if s.op_id == op_id && !s.cancellable)
    ));
    assert!(!queue.cancel(op_id));
    assert_eq!(
        b.repos.cancel_op(op_id).unwrap_err().code,
        ErrorCode::OpNotFound
    );
    handle.wait().unwrap();
    assert!(!*interrupted.lock().unwrap());

    // Closing the repository (the queue is shut down) lets the running non-cancellable
    // operation finish, while queued ones are dropped.
    let interrupted = Arc::new(Mutex::new(false));
    let seen = interrupted.clone();
    let running = queue
        .enqueue(OpKind::Push, false, move |ctx| {
            let started = Instant::now();
            while started.elapsed() < Duration::from_millis(300) {
                if ctx.cancel.is_cancelled() {
                    *seen.lock().unwrap() = true;
                    return Err(yaggui_lib::git::errors::YagguiError::cancelled());
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(())
        })
        .unwrap();
    let running_id = running.op_id;
    let queued = queue.enqueue(OpKind::Fetch, true, |_| Ok(())).unwrap();
    assert!(b.sink.wait_for(
        Duration::from_secs(2),
        |e| matches!(e, BackendEvent::OpStarted(s) if s.op_id == running_id)
    ));
    queue.shutdown();
    running.wait().unwrap();
    assert!(!*interrupted.lock().unwrap());
    assert!(queued.wait().is_err());
    assert!(b.sink.events().iter().any(|e| matches!(
        e,
        BackendEvent::OpFinished(f) if f.op_id == running_id && matches!(f.outcome, OpOutcome::Success { .. })
    )));
}

#[test]
fn shutdown_interrupts_a_cancellable_operation() {
    let fx = Fixture::new("clean");
    let b = backend(false);
    let id = b.repos.open(&fx.repo_str()).unwrap().id;
    let session = b.repos.session(id).unwrap();
    let queue = session.queue();
    let handle = queue
        .enqueue(OpKind::Fetch, true, move |ctx| {
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(5) {
                if ctx.cancel.is_cancelled() {
                    return Err(yaggui_lib::git::errors::YagguiError::cancelled());
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(())
        })
        .unwrap();
    let op_id = handle.op_id;
    assert!(b.sink.wait_for(
        Duration::from_secs(2),
        |e| matches!(e, BackendEvent::OpStarted(s) if s.op_id == op_id)
    ));
    let start = Instant::now();
    queue.shutdown();
    assert_eq!(handle.wait().unwrap_err().code, ErrorCode::Cancelled);
    assert!(start.elapsed() < Duration::from_secs(2));
}

#[test]
fn finishing_an_operation_raises_the_refs_changed_flag_before_op_finished() {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use yaggui_lib::events::EventSink;
    use yaggui_lib::repo::op_queue::OpQueue;

    /// Records the flag the moment `op-finished` is emitted.
    struct Probe {
        flag: Arc<AtomicBool>,
        seen: Mutex<Option<bool>>,
    }
    impl EventSink for Probe {
        fn emit(&self, event: BackendEvent) {
            if matches!(event, BackendEvent::OpFinished(_)) {
                *self.seen.lock().unwrap() = Some(self.flag.load(Ordering::SeqCst));
            }
        }
    }
    let refs_changed = Arc::new(AtomicBool::new(false));
    let probe = Arc::new(Probe {
        flag: refs_changed.clone(),
        seen: Mutex::new(None),
    });
    let queue = OpQueue::new(7, probe.clone(), Arc::new(AtomicU64::new(0)))
        .unwrap()
        .with_refs_changed(refs_changed.clone());
    queue
        .enqueue(OpKind::Fetch, true, |_| Ok(()))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(*probe.seen.lock().unwrap(), Some(true));
    assert!(refs_changed.load(Ordering::SeqCst));
}
