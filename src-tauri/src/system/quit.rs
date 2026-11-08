//! Quit and close guard (backend side). The frontend decides what needs a confirmation (a
//! running operation, unsaved edits); this module makes sure a native quit reaches it, and
//! that a webview which cannot answer never keeps the app from quitting or closing.
//!
//! Requests arrive from:
//! - the window's close (its button, Alt+F4, `close()`): the frontend's close-requested
//!   listener handles it, this module only adds the fallback for an unresponsive webview;
//! - the "Quit yaggui" item of the macOS menu (⌘Q), whose id is [`QUIT_MENU_ID`];
//! - on macOS, the Dock's Quit and AppleScript (`quit app "yaggui"`), through the app
//!   delegate (see [`install_dock_hook`]). tao never sends a preventable `ExitRequested` for
//!   these: it only answers `applicationWillTerminate:`, when it is too late to cancel.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri_specta::Event;

use crate::events::QuitRequested;

/// Id of the frontend's "Quit yaggui" menu item (its `quit` shell action).
pub const QUIT_MENU_ID: &str = "quit";

/// A request still not acknowledged after this long means the webview cannot answer: the
/// next request goes through without it. Long enough for a busy webview to acknowledge.
pub const UNANSWERED_AFTER: Duration = Duration::from_secs(1);

/// What to do with a native quit or close request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Quit (or close) now, without the frontend.
    Proceed,
    /// Leave it to the frontend, which confirms if needed.
    AskFrontend,
}

/// State shared by the request sources.
#[derive(Debug)]
pub struct QuitGate {
    /// Whether the frontend reported something a quit would interrupt or lose.
    guarded: AtomicBool,
    /// When the oldest request the frontend has not acknowledged yet arrived.
    unanswered: Mutex<Option<Instant>>,
}

impl Default for QuitGate {
    fn default() -> Self {
        Self::new()
    }
}

impl QuitGate {
    pub const fn new() -> Self {
        Self {
            guarded: AtomicBool::new(false),
            unanswered: Mutex::new(None),
        }
    }

    pub fn set_guarded(&self, guarded: bool) {
        self.guarded.store(guarded, Ordering::Relaxed);
    }

    /// The frontend received the last request (it confirms from there, or quits).
    pub fn acknowledge(&self) {
        *self.lock() = None;
    }

    /// A quit from the menu or the Dock: at once when nothing is in progress (no round trip
    /// through the webview, as with the native Quit item it replaces), else the frontend asks.
    pub fn quit_requested(&self, now: Instant) -> Decision {
        if !self.guarded.load(Ordering::Relaxed) {
            return Decision::Proceed;
        }
        self.ask(now)
    }

    /// A close of the main window: the frontend always handles it (it saves the session).
    pub fn close_requested(&self, now: Instant) -> Decision {
        self.ask(now)
    }

    fn ask(&self, now: Instant) -> Decision {
        let mut unanswered = self.lock();
        match *unanswered {
            Some(since) if now.saturating_duration_since(since) >= UNANSWERED_AFTER => {
                *unanswered = None;
                Decision::Proceed
            }
            Some(_) => Decision::AskFrontend,
            None => {
                *unanswered = Some(now);
                Decision::AskFrontend
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Instant>> {
        // Only an `Option<Instant>` behind it: a poisoned lock still holds a valid value.
        self.unanswered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// One gate per process: the macOS delegate callback has no other way to reach it.
pub static GATE: QuitGate = QuitGate::new();

/// The "Quit yaggui" menu item, or the Dock's Quit: returns whether the app quits now. When it
/// does not, the frontend got `quit-requested` and calls `quit_app` once the user confirmed.
pub fn native_quit(app: &AppHandle) -> bool {
    match GATE.quit_requested(Instant::now()) {
        Decision::Proceed => true,
        Decision::AskFrontend => {
            if let Err(err) = QuitRequested.emit(app) {
                tracing::warn!(error = %err, "cannot ask the frontend to confirm the quit");
                return true;
            }
            false
        }
    }
}

/// Fallback for the window's close: the frontend's listener cancels the native close and
/// destroys the window itself; a webview that does not answer would leave it open forever.
pub fn on_close_requested(window: &tauri::Window) {
    if GATE.close_requested(Instant::now()) == Decision::Proceed {
        tracing::warn!("the frontend did not answer the close request, closing anyway");
        if let Err(err) = window.destroy() {
            tracing::error!(error = %err, "cannot close the main window");
        }
    }
}

/// macOS: asks the frontend before the Dock's Quit or AppleScript terminates the app.
#[cfg(target_os = "macos")]
pub fn install_dock_hook(app: AppHandle) {
    macos::install(app);
}

#[cfg(not(target_os = "macos"))]
pub fn install_dock_hook(_app: AppHandle) {}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::OnceLock;

    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{class, ffi, msg_send, sel};
    use tauri::AppHandle;

    static APP: OnceLock<AppHandle> = OnceLock::new();

    /// `NSApplicationTerminateReply` values.
    const TERMINATE_CANCEL: usize = 0;
    const TERMINATE_NOW: usize = 1;

    /// `- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender`.
    /// Called on the main thread by `-[NSApplication terminate:]` (Dock, AppleScript, logout).
    /// `app.exit()` stops the run loop without `terminate:`, so `quit_app` never comes here.
    extern "C-unwind" fn should_terminate(
        _this: &AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> usize {
        match APP.get() {
            Some(app) if !super::native_quit(app) => TERMINATE_CANCEL,
            _ => TERMINATE_NOW,
        }
    }

    pub fn install(app: AppHandle) {
        if APP.set(app).is_err() {
            return;
        }
        // SAFETY: plain Objective-C runtime calls on the main thread (Tauri's setup). tao's
        // delegate class does not implement `applicationShouldTerminate:` (otherwise
        // `class_addMethod` returns NO and changes nothing); the function matches the method's
        // signature, encoded "Q@:@" (NSUInteger return, self, _cmd, sender).
        let added = unsafe {
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            if ns_app.is_null() {
                false
            } else {
                let delegate: *mut AnyObject = msg_send![ns_app, delegate];
                match delegate.as_ref() {
                    None => false,
                    Some(delegate) => {
                        let cls: *const AnyClass = delegate.class();
                        let imp = std::mem::transmute::<
                            extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize,
                            Imp,
                        >(should_terminate);
                        ffi::class_addMethod(
                            cls.cast_mut(),
                            sel!(applicationShouldTerminate:),
                            imp,
                            c"Q@:@".as_ptr(),
                        )
                        .as_bool()
                    }
                }
            }
        };
        if !added {
            tracing::warn!("cannot guard the Dock's Quit: it quits without confirmation");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quits_at_once_when_nothing_is_in_progress() {
        let gate = QuitGate::new();
        let now = Instant::now();
        assert_eq!(gate.quit_requested(now), Decision::Proceed);
        assert_eq!(gate.quit_requested(now), Decision::Proceed);
    }

    #[test]
    fn asks_the_frontend_while_work_is_in_progress() {
        let gate = QuitGate::new();
        gate.set_guarded(true);
        let now = Instant::now();
        assert_eq!(gate.quit_requested(now), Decision::AskFrontend);
        gate.acknowledge();
        // The user cancelled: the next request asks again, even much later.
        let later = now + Duration::from_secs(60);
        assert_eq!(gate.quit_requested(later), Decision::AskFrontend);
    }

    #[test]
    fn a_request_the_frontend_never_answered_lets_the_next_one_through() {
        let gate = QuitGate::new();
        gate.set_guarded(true);
        let now = Instant::now();
        assert_eq!(gate.quit_requested(now), Decision::AskFrontend);
        // A quick second request (a double click) still waits for the webview.
        assert_eq!(
            gate.quit_requested(now + Duration::from_millis(200)),
            Decision::AskFrontend
        );
        assert_eq!(
            gate.quit_requested(now + UNANSWERED_AFTER),
            Decision::Proceed
        );
        // Forced once: the next request starts over.
        assert_eq!(
            gate.quit_requested(now + UNANSWERED_AFTER * 2),
            Decision::AskFrontend
        );
    }

    #[test]
    fn the_close_always_goes_to_the_frontend_unless_it_stopped_answering() {
        let gate = QuitGate::new();
        let now = Instant::now();
        assert_eq!(gate.close_requested(now), Decision::AskFrontend);
        gate.acknowledge();
        assert_eq!(
            gate.close_requested(now + UNANSWERED_AFTER),
            Decision::AskFrontend
        );
        assert_eq!(
            gate.close_requested(now + UNANSWERED_AFTER * 2),
            Decision::Proceed
        );
    }
}
