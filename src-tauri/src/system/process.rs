//! Child processes that can be stopped with everything they started: `git` (and the hooks,
//! ssh, credential helpers it runs) and the `claude` CLI (and its tools).

use std::process::{Child, Command};
#[cfg(unix)]
use std::thread;
use std::time::SystemTime;
#[cfg(unix)]
use std::time::{Duration, Instant};

/// After asking a cancelled command to stop, how long before it is killed. Git removes its
/// lock files when terminated, not when killed.
#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_secs(1);
#[cfg(unix)]
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Starts the command without a terminal and in its own process group, so a
/// [`ProcessTree`] can stop it with its children.
pub fn isolate(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // A new session, without a controlling terminal: when yaggui is started from a
        // terminal, `ssh` (fetch, push…) would otherwise ask for a key passphrase or a host
        // key confirmation on `/dev/tty` and wait there until cancelled.
        // `GIT_TERMINAL_PROMPT=0` only covers git's own prompts. Without a terminal, ssh
        // fails at once (or uses the user's own `SSH_ASKPASS`), and ssh-agent still works.
        // The session leader also leads a new process group whose id is its pid, which is
        // what `ProcessTree` signals on cancellation.
        // SAFETY: `setsid` is async-signal-safe and touches no memory of the parent.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: the child gets no console (none flashes for each call, none is
        // inherited from a terminal yaggui was started from). Git for Windows then starts
        // ssh without a console either, so ssh cannot prompt for a passphrase.
        cmd.creation_flags(0x0800_0000);
    }
}

/// The processes a command started, so a cancellation stops all of them. The command must
/// have been started with [`isolate`].
pub struct ProcessTree {
    #[cfg(unix)]
    group: libc::pid_t,
    #[cfg(windows)]
    job: Option<windows_job::Job>,
}

impl ProcessTree {
    #[cfg(unix)]
    pub fn attach(child: &Child) -> Self {
        // The child leads its own session and group (`setsid` in `isolate`): its pid is the
        // group id.
        Self {
            group: libc::pid_t::try_from(child.id()).unwrap_or(0),
        }
    }

    #[cfg(windows)]
    pub fn attach(child: &Child) -> Self {
        Self {
            job: windows_job::Job::assign(child),
        }
    }

    #[cfg(not(any(unix, windows)))]
    pub fn attach(_child: &Child) -> Self {
        Self {}
    }

    /// Asks the whole tree to stop (git removes its locks), then kills what is left. Returns
    /// when the child itself had to be killed, `None` if it stopped on its own.
    pub fn terminate(&self, child: &mut Child) -> Option<SystemTime> {
        let exited = self.ask_to_stop(child);
        let killed_at = (!exited).then(SystemTime::now);
        self.kill_remaining();
        let _ = child.kill();
        let _ = child.wait();
        killed_at
    }

    /// Sends SIGTERM to the tree and waits up to `TERMINATE_GRACE` for the child to exit on
    /// its own; `true` if it did. Windows has no graceful stop: always `false`.
    #[cfg(unix)]
    fn ask_to_stop(&self, child: &mut Child) -> bool {
        self.signal(libc::SIGTERM);
        let start = Instant::now();
        while start.elapsed() < TERMINATE_GRACE {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return true;
            }
            thread::sleep(POLL_INTERVAL);
        }
        false
    }

    #[cfg(not(unix))]
    fn ask_to_stop(&self, _child: &mut Child) -> bool {
        false
    }

    /// Kills every process of the tree still running.
    pub fn kill_remaining(&self) {
        #[cfg(unix)]
        self.signal(libc::SIGKILL);
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
    }

    #[cfg(unix)]
    fn signal(&self, signal: libc::c_int) {
        if self.group <= 0 {
            return;
        }
        // SAFETY: `kill` has no memory-safety preconditions. The group id stays reserved
        // while any of its processes lives, so it cannot designate unrelated processes.
        unsafe {
            libc::kill(-self.group, signal);
        }
    }
}

#[cfg(windows)]
mod windows_job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject,
    };

    /// A job object holding a process and everything it starts.
    pub struct Job(HANDLE);

    // The handle is only used through thread-safe Win32 calls.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        /// `None` if the job cannot be created or the process assigned (cancellation then
        /// only kills the process itself).
        pub fn assign(child: &Child) -> Option<Self> {
            // SAFETY: null attributes and name are allowed; the handle is owned by `Job`.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return None;
            }
            let job = Self(handle);
            // SAFETY: both handles are valid for the duration of the call.
            let assigned =
                unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) };
            (assigned != 0).then_some(job)
        }

        pub fn terminate(&self) {
            // SAFETY: the job handle is valid until drop.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: owned handle, closed once. Closing does not kill the processes.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
