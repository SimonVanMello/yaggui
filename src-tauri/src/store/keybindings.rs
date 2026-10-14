//! `keybindings.json` in the config folder (F-281): the shortcuts the user changed.
//!
//! The file is meant to be edited by hand too, so it is a plain object `{ "<action id>":
//! "Mod+Shift+K" | null }`: a string rebinds the action, `null` leaves it without shortcut.
//! Actions that are absent keep their default.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::errors::{BackendError, YagguiError};

pub const KEYBINDINGS_FILE: &str = "keybindings.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingOverride {
    /// Stable action id (`tab.new`, `git.push`…).
    pub action: String,
    /// Shortcut in `Mod+Shift+K` notation; `None` removes the shortcut.
    pub shortcut: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingsFile {
    pub path: String,
    pub overrides: Vec<KeybindingOverride>,
    /// The file could not be read as a whole, or entries were skipped: the screen shows it,
    /// and the file stays untouched until the user saves a change.
    pub problem: Option<String>,
}

const MODIFIERS: [&str; 4] = ["Mod", "Ctrl", "Alt", "Shift"];

/// `Mod+Shift+K`: distinct modifiers, then one key.
pub fn is_valid_shortcut(shortcut: &str) -> bool {
    let mut parts: Vec<&str> = shortcut.split('+').collect();
    let Some(key) = parts.pop() else { return false };
    let key_ok = !key.is_empty()
        && key.chars().count() <= 16
        && !key.chars().any(|c| c.is_control() || c.is_whitespace());
    let mut seen = Vec::new();
    let modifiers_ok = parts.iter().all(|m| {
        let fresh = MODIFIERS.contains(m) && !seen.contains(m);
        seen.push(*m);
        fresh
    });
    key_ok && modifiers_ok
}

fn valid_action_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

pub fn path_in(config_dir: &Path) -> PathBuf {
    config_dir.join(KEYBINDINGS_FILE)
}

/// Reads the file; a missing file means no override.
pub fn read(config_dir: &Path) -> KeybindingsFile {
    let path = path_in(config_dir);
    let shown = path.display().to_string();
    let empty = |problem: Option<String>| KeybindingsFile {
        path: shown.clone(),
        overrides: Vec::new(),
        problem,
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return empty(None),
        Err(err) => return empty(Some(format!("{shown}: {err}"))),
    };
    if raw.trim().is_empty() {
        return empty(None);
    }
    let parsed: BTreeMap<String, Option<String>> = match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(err) => return empty(Some(format!("{shown}: {err}"))),
    };
    let mut overrides = Vec::new();
    let mut skipped = Vec::new();
    for (action, shortcut) in parsed {
        let valid = valid_action_id(&action) && shortcut.as_deref().is_none_or(is_valid_shortcut);
        if valid {
            overrides.push(KeybindingOverride { action, shortcut });
        } else {
            skipped.push(action);
        }
    }
    KeybindingsFile {
        path: shown,
        overrides,
        problem: (!skipped.is_empty()).then(|| format!("Ignored entries: {}", skipped.join(", "))),
    }
}

/// Replaces the file with `overrides` (written atomically, so a crash never leaves half a file).
pub fn write(
    config_dir: &Path,
    overrides: &[KeybindingOverride],
) -> Result<KeybindingsFile, YagguiError> {
    let mut map = BTreeMap::new();
    for entry in overrides {
        let shortcut_ok = entry.shortcut.as_deref().is_none_or(is_valid_shortcut);
        if !valid_action_id(&entry.action) || !shortcut_ok {
            return Err(YagguiError::invalid_argument(
                format!("\"{}\" cannot be bound like this.", entry.action),
                format!("« {} » ne peut pas être associé ainsi.", entry.action),
            ));
        }
        map.insert(entry.action.clone(), entry.shortcut.clone());
    }
    std::fs::create_dir_all(config_dir).map_err(|e| {
        YagguiError::storage(BackendError::io("cannot create the config folder", e).chain())
    })?;
    let path = path_in(config_dir);
    let tmp = path.with_extension("json.tmp");
    let mut text = serde_json::to_string_pretty(&map).map_err(BackendError::from)?;
    text.push('\n');
    std::fs::write(&tmp, text)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| {
            YagguiError::storage(BackendError::io("cannot write keybindings.json", e).chain())
        })?;
    Ok(read(config_dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_syntax() {
        for ok in [
            "Mod+T",
            "Mod+Shift+Alt+S",
            "Ctrl+Tab",
            "F5",
            "Mod+,",
            "Mod+Enter",
        ] {
            assert!(is_valid_shortcut(ok), "{ok}");
        }
        for bad in ["", "Mod+", "Mod+Mod+T", "Cmd+T", "Mod+T+Y", "Mod+ T", "+"] {
            assert!(!is_valid_shortcut(bad), "{bad}");
        }
    }

    #[test]
    fn round_trips_and_keeps_unbound_actions() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read(dir.path()).overrides.is_empty());
        let saved = write(
            dir.path(),
            &[
                KeybindingOverride {
                    action: "tab.new".into(),
                    shortcut: Some("Mod+N".into()),
                },
                KeybindingOverride {
                    action: "git.push".into(),
                    shortcut: None,
                },
            ],
        )
        .unwrap();
        assert!(saved.problem.is_none());
        let raw = std::fs::read_to_string(path_in(dir.path())).unwrap();
        assert!(raw.contains("\"tab.new\": \"Mod+N\""), "{raw}");
        assert!(raw.contains("\"git.push\": null"), "{raw}");
        assert_eq!(read(dir.path()).overrides.len(), 2);
    }

    #[test]
    fn a_broken_file_is_reported_and_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path_in(dir.path()), "{ not json").unwrap();
        let file = read(dir.path());
        assert!(file.overrides.is_empty());
        assert!(file.problem.is_some());
        assert_eq!(
            std::fs::read_to_string(path_in(dir.path())).unwrap(),
            "{ not json"
        );
    }

    #[test]
    fn invalid_entries_are_skipped_and_writes_are_validated() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            path_in(dir.path()),
            r#"{"tab.new":"Mod+N","git.push":"Hyper+P","bad id":"Mod+X"}"#,
        )
        .unwrap();
        let file = read(dir.path());
        assert_eq!(file.overrides.len(), 1);
        assert!(file.problem.as_deref().unwrap().contains("git.push"));
        let err = write(
            dir.path(),
            &[KeybindingOverride {
                action: "tab.new".into(),
                shortcut: Some("Hyper+P".into()),
            }],
        )
        .unwrap_err();
        assert_eq!(err.code, crate::git::errors::ErrorCode::InvalidArgument);
    }
}
