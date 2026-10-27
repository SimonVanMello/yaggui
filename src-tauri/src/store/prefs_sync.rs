//! Preferences import / export (F-326): one versioned JSON file to carry the preferences and
//! the custom shortcuts from one machine to another by hand.
//!
//! ```json
//! { "format": "yaggui-preferences", "version": 1,
//!   "preferences": { "theme": "dark", "fontSize": 14, … },
//!   "keybindings": [ { "action": "tab.new", "shortcut": "Mod+N" } ] }
//! ```
//!
//! `preferences` uses the camelCase names of [`Preferences`]. A key that is absent keeps its
//! value on import; `keybindings` is the whole set of overrides and replaces the local one.
//! The version only changes for a breaking change of this layout: a key added later does not
//! bump it, and an older yaggui lists it as ignored.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use specta::Type;

use super::{Preferences, Store};
use crate::git::errors::{BackendError, YagguiError};
use crate::store::keybindings::{self, KeybindingOverride, KeybindingsFile};

pub const FORMAT: &str = "yaggui-preferences";
pub const VERSION: u32 = 1;
/// A preferences file is a few KB; anything bigger is not one.
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_KEYBINDINGS: usize = 1000;

/// Settings that travel between machines.
const PORTABLE: [&str; 20] = [
    "theme",
    "style",
    "locale",
    "terminalMode",
    "diffView",
    "diffOptions",
    "highContrast",
    "density",
    "uiFont",
    "codeFont",
    "fontSize",
    "autoFetch",
    "autoFetchMinutes",
    "prune",
    "pullStrategy",
    "protectedBranches",
    "disabledConfirmations",
    "gravatar",
    "remoteTags",
    "ai",
];

/// Settings that only mean something on the machine they were set on: programs and paths
/// (they differ per OS and install), the one-time answer about update checks and the consent
/// to send code to an AI provider. Never exported; ignored (and listed) when a file holds them.
const MACHINE_SPECIFIC: [&str; 8] = [
    "gitPath",
    "terminal",
    "editor",
    "diffTool",
    "mergeTool",
    "checkUpdates",
    "aiEnabled",
    "claudePath",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IgnoredReason {
    /// A path or program of the machine that exported the file.
    MachineSpecific,
    /// Not a setting this version of yaggui has (hand edit, or a newer version).
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredKey {
    pub key: String,
    pub reason: IgnoredReason,
}

/// One setting that the import would change. Values are JSON text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceChange {
    pub key: String,
    pub before: String,
    pub after: String,
}

/// What an action's shortcut is: the default one, or an override (`None` = no shortcut).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutState {
    pub custom: bool,
    pub shortcut: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingChange {
    pub action: String,
    pub before: ShortcutState,
    pub after: ShortcutState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesImportPreview {
    /// The file the preview was read from; passed back to apply it.
    pub path: String,
    pub changes: Vec<PreferenceChange>,
    pub keybinding_changes: Vec<KeybindingChange>,
    pub ignored: Vec<IgnoredKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppliedImport {
    pub preferences: Preferences,
    pub keybindings: KeybindingsFile,
}

/// A file read and validated, ready to be previewed or applied.
struct Parsed {
    /// The current preferences with the file's values applied and normalized.
    preferences: Preferences,
    keybindings: Vec<KeybindingOverride>,
    ignored: Vec<IgnoredKey>,
}

/// The text of the export file for these preferences and shortcuts.
pub fn export_text(
    prefs: &Preferences,
    overrides: &[KeybindingOverride],
) -> Result<String, YagguiError> {
    let all = to_object(prefs)?;
    let preferences: Map<String, Value> = PORTABLE
        .iter()
        .filter_map(|key| all.get(*key).map(|v| ((*key).to_owned(), v.clone())))
        .collect();
    let file = json!({
        "format": FORMAT,
        "version": VERSION,
        "preferences": preferences,
        "keybindings": overrides,
    });
    let mut text = serde_json::to_string_pretty(&file).map_err(BackendError::from)?;
    text.push('\n');
    Ok(text)
}

/// Writes the export file (atomically) with the stored preferences and `keybindings.json`.
pub fn export_to(path: &Path, store: &Store, config_dir: &Path) -> Result<(), YagguiError> {
    let overrides = keybindings::read(config_dir).overrides;
    let text = export_text(&store.preferences()?, &overrides)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)
        .and_then(|()| std::fs::rename(&tmp, path))
        .map_err(|e| {
            YagguiError::internal(
                BackendError::io(format!("cannot write {}", path.display()), e).chain(),
            )
        })
}

/// Reads and validates the file at `path` and lists what applying it would change.
pub fn preview_from(
    path: &Path,
    store: &Store,
    config_dir: &Path,
) -> Result<PreferencesImportPreview, YagguiError> {
    let current = store.preferences()?;
    let parsed = parse(&read_file(path)?, &current)?;
    let current_overrides = keybindings::read(config_dir).overrides;
    Ok(PreferencesImportPreview {
        path: path.display().to_string(),
        changes: preference_changes(&current, &parsed.preferences)?,
        keybinding_changes: keybinding_changes(&current_overrides, &parsed.keybindings),
        ignored: parsed.ignored,
    })
}

/// Applies the file in one step. It is read and validated again, so what is applied is what
/// the file holds now; nothing is written when it is invalid.
pub fn apply_from(
    path: &Path,
    store: &Store,
    config_dir: &Path,
) -> Result<AppliedImport, YagguiError> {
    let current = store.preferences()?;
    let parsed = parse(&read_file(path)?, &current)?;
    let before = keybindings::read(config_dir);
    // The file write is the likelier failure: do it first, so a refusal leaves the
    // preferences as they were.
    let keybindings = if keybinding_changes(&before.overrides, &parsed.keybindings).is_empty() {
        before
    } else {
        keybindings::write(config_dir, &parsed.keybindings)?
    };
    let preferences = store.set_preferences(&parsed.preferences)?;
    Ok(AppliedImport {
        preferences,
        keybindings,
    })
}

fn invalid(detail: impl Into<String>) -> YagguiError {
    YagguiError::preferences_file_invalid(detail)
}

fn read_file(path: &Path) -> Result<String, YagguiError> {
    let unreadable = |e: std::io::Error| {
        YagguiError::preferences_file_invalid(
            BackendError::io(format!("cannot read {}", path.display()), e).chain(),
        )
    };
    let size = std::fs::metadata(path).map_err(unreadable)?.len();
    if size > MAX_FILE_BYTES {
        return Err(YagguiError::preferences_file_invalid(format!(
            "{} is {size} bytes, more than a preferences file can be.",
            path.display()
        )));
    }
    std::fs::read_to_string(path).map_err(unreadable)
}

fn to_object(prefs: &Preferences) -> Result<Map<String, Value>, YagguiError> {
    match serde_json::to_value(prefs).map_err(BackendError::from)? {
        Value::Object(map) => Ok(map),
        _ => Err(YagguiError::internal("preferences are not an object")),
    }
}

fn parse(text: &str, current: &Preferences) -> Result<Parsed, YagguiError> {
    let root: Value =
        serde_json::from_str(text).map_err(|e| invalid(format!("not valid JSON: {e}")))?;
    let Some(root) = root.as_object() else {
        return Err(invalid("the top level must be an object"));
    };
    if root.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(invalid(format!("\"format\" must be \"{FORMAT}\"")));
    }
    let version = root
        .get("version")
        .and_then(Value::as_u64)
        .filter(|v| *v >= 1)
        .ok_or_else(|| invalid("\"version\" must be a positive integer"))?;
    let version = u32::try_from(version).unwrap_or(u32::MAX);
    if version > VERSION {
        return Err(YagguiError::preferences_file_too_new(version, VERSION));
    }
    let incoming = match root.get("preferences") {
        None => Map::new(),
        Some(Value::Object(map)) => map.clone(),
        Some(_) => return Err(invalid("\"preferences\" must be an object")),
    };
    let keybindings = parse_keybindings(root.get("keybindings"))?;

    let mut working = current.clone();
    let mut ignored = Vec::new();
    let mut problems = Vec::new();
    for (key, value) in incoming {
        if MACHINE_SPECIFIC.contains(&key.as_str()) {
            ignored.push(IgnoredKey {
                key,
                reason: IgnoredReason::MachineSpecific,
            });
        } else if !PORTABLE.contains(&key.as_str()) {
            ignored.push(IgnoredKey {
                key,
                reason: IgnoredReason::Unknown,
            });
        } else {
            match with_value(&working, &key, value) {
                Ok(next) => working = next,
                Err(problem) => problems.push(format!("{key}: {problem}")),
            }
        }
    }
    if !problems.is_empty() {
        return Err(invalid(problems.join("; ")));
    }
    Ok(Parsed {
        preferences: working.normalized()?,
        keybindings,
        ignored,
    })
}

/// `prefs` with the setting `key` replaced by `value`; the reason when the value is refused.
fn with_value(prefs: &Preferences, key: &str, value: Value) -> Result<Preferences, String> {
    let mut object = to_object(prefs).map_err(|e| e.message.en)?;
    // A file from another version may lack AI settings added since, or hold newer ones:
    // what it lacks keeps its current value.
    let value = match (key, object.remove(key)) {
        ("ai", Some(current)) if value.is_object() => crate::ai::prefs::merge_json(current, value),
        _ => value,
    };
    object.insert(key.to_owned(), value);
    let next: Preferences =
        serde_json::from_value(Value::Object(object)).map_err(|e| e.to_string())?;
    next.normalized().map_err(|e| e.message.en)
}

fn parse_keybindings(value: Option<&Value>) -> Result<Vec<KeybindingOverride>, YagguiError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let entries: Vec<KeybindingOverride> = serde_json::from_value(value.clone()).map_err(|e| {
        invalid(format!(
            "\"keybindings\" must be a list of {{ \"action\", \"shortcut\" }}: {e}"
        ))
    })?;
    if entries.len() > MAX_KEYBINDINGS {
        return Err(invalid(format!(
            "\"keybindings\" holds {} entries, at most {MAX_KEYBINDINGS} are supported",
            entries.len()
        )));
    }
    // Same checks as a save from the shortcut editor; a repeated action keeps its last entry.
    let mut unique: Vec<KeybindingOverride> = Vec::new();
    for entry in entries {
        let shortcut_ok = entry
            .shortcut
            .as_deref()
            .is_none_or(keybindings::is_valid_shortcut);
        if !keybindings::is_valid_action_id(&entry.action) || !shortcut_ok {
            return Err(invalid(format!(
                "\"keybindings\": \"{}\" cannot be bound like this",
                entry.action
            )));
        }
        unique.retain(|e| e.action != entry.action);
        unique.push(entry);
    }
    unique.sort_by(|a, b| a.action.cmp(&b.action));
    Ok(unique)
}

fn preference_changes(
    before: &Preferences,
    after: &Preferences,
) -> Result<Vec<PreferenceChange>, YagguiError> {
    let (before, after) = (to_object(before)?, to_object(after)?);
    Ok(PORTABLE
        .iter()
        .filter_map(|key| {
            let (b, a) = (before.get(*key)?, after.get(*key)?);
            (b != a).then(|| PreferenceChange {
                key: (*key).to_owned(),
                before: b.to_string(),
                after: a.to_string(),
            })
        })
        .collect())
}

fn keybinding_changes(
    current: &[KeybindingOverride],
    incoming: &[KeybindingOverride],
) -> Vec<KeybindingChange> {
    let state = |list: &[KeybindingOverride], action: &str| {
        list.iter()
            .find(|e| e.action == action)
            .map_or(ShortcutState::default_binding(), |e| ShortcutState {
                custom: true,
                shortcut: e.shortcut.clone(),
            })
    };
    let mut actions: Vec<&str> = current
        .iter()
        .chain(incoming)
        .map(|e| e.action.as_str())
        .collect();
    actions.sort_unstable();
    actions.dedup();
    actions
        .into_iter()
        .filter_map(|action| {
            let (before, after) = (state(current, action), state(incoming, action));
            (before != after).then(|| KeybindingChange {
                action: action.to_owned(),
                before,
                after,
            })
        })
        .collect()
}

impl ShortcutState {
    fn default_binding() -> Self {
        Self {
            custom: false,
            shortcut: None,
        }
    }
}

#[cfg(test)]
mod tests;
