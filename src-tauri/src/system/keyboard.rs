//! macOS keyboard behavior of the webview.

/// Turns off the macOS press-and-hold accent picker for the app, so a held key repeats
/// (`j` held in vim, in the integrated terminal). WKWebView otherwise swallows the repeat
/// of every letter key, accented or not.
///
/// Registered defaults are the lowest-priority domain and are not saved: a user who
/// prefers the picker can still turn it back on with
/// `defaults write <bundle id> ApplePressAndHoldEnabled -bool true`.
#[cfg(target_os = "macos")]
pub fn enable_key_repeat() {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSDictionary, NSNumber, NSString, NSUserDefaults, ns_string};

    let off = NSNumber::numberWithBool(false);
    let defaults: Retained<NSDictionary<NSString, AnyObject>> =
        NSDictionary::from_slices(&[ns_string!("ApplePressAndHoldEnabled")], &[off.as_ref()]);
    // SAFETY: string keys and object values, the dictionary type `registerDefaults:` takes.
    unsafe { NSUserDefaults::standardUserDefaults().registerDefaults(&defaults) };
}

#[cfg(not(target_os = "macos"))]
pub fn enable_key_repeat() {}
