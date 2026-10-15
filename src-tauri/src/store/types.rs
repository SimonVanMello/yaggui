//! Types persisted by the store and exchanged with the frontend.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::errors::YagguiError;
use crate::git::ops::types::PullStrategy;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KnownRepo {
    pub id: u32,
    /// Absolute path of the worktree root.
    pub path: String,
    /// Display name (folder name by default).
    pub name: String,
    pub favorite: bool,
    /// Last time the repo was opened, seconds since the Unix epoch.
    pub last_opened_at: u32,
    /// `false` when the folder no longer exists (moved or deleted).
    pub exists: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    /// Frontend-generated stable id.
    pub id: String,
    /// `None` for a "new tab" (welcome screen).
    pub repo_id: Option<u32>,
    /// Opaque JSON owned by the frontend (panel sizes…), stored as is.
    pub ui_state: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TabsState {
    /// Tabs in display order.
    pub tabs: Vec<Tab>,
    pub active_tab_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ThemePreference {
    Light,
    Dark,
    #[default]
    System,
}

/// Visual style (spec §7): `Terminal` is the dense monospace dark style (D), which ignores
/// the light / dark choice.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ThemeStyle {
    #[default]
    Standard,
    Terminal,
}

/// What the Terminal button and shortcut open.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TerminalMode {
    /// The panel at the bottom of the repository view (F-267).
    #[default]
    Integrated,
    /// The system terminal, or the configured one (F-266).
    External,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Locale {
    En,
    Fr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub theme: ThemePreference,
    /// Visual style (F-320).
    pub style: ThemeStyle,
    /// `None` follows the OS language.
    pub locale: Option<Locale>,
    /// Terminal opened by "Terminal" (F-266): an application name on macOS (`iTerm`), a
    /// program name or path elsewhere. `None` uses the system default.
    pub terminal: Option<String>,
    /// What the Terminal button opens: the integrated panel (F-267) or the external terminal.
    pub terminal_mode: TerminalMode,
    /// External editor (F-323): an application name on macOS, a program name or path elsewhere.
    pub editor: Option<String>,
    /// External diff tool (F-323): a name known to `git difftool`; `None` follows `diff.tool`.
    pub diff_tool: Option<String>,
    /// External merge tool (F-323): a name known to `git mergetool`; `None` follows `merge.tool`.
    pub merge_tool: Option<String>,
    /// Diff layout (F-080).
    pub diff_view: DiffViewMode,
    /// Diff display options (F-082).
    #[serde(default)]
    pub diff_options: DiffPreferences,
    /// Stronger borders and text contrast (F-320).
    pub high_contrast: bool,
    pub density: Density,
    /// Font family of the interface; `None` keeps the bundled one.
    pub ui_font: Option<String>,
    /// Font family of code and diffs; `None` keeps the bundled one.
    pub code_font: Option<String>,
    /// Base text size in px, within `FONT_SIZE_RANGE`.
    pub font_size: u8,
    /// Path of the `git` binary (F-322); `None` uses the one found on the `PATH`.
    pub git_path: Option<String>,
    /// Fetch every repository in the background (F-324).
    pub auto_fetch: bool,
    /// Minutes between two automatic fetches, within `AUTO_FETCH_RANGE`.
    pub auto_fetch_minutes: u32,
    /// Remove remote-tracking branches deleted on the remote when fetching.
    pub prune: bool,
    /// Strategy of a pull that names none; `None` follows the Git configuration (`pull.rebase`,
    /// `pull.ff`).
    pub pull_strategy: Option<PullStrategy>,
    /// Branch names or patterns (`release/*`) that destructive operations treat with care.
    pub protected_branches: Vec<String>,
    /// Confirmations the user turned off. `ForcePush` is never honored.
    pub disabled_confirmations: Vec<ConfirmationKind>,
    /// Gravatar avatars in the graph (F-033). Off by default: when on, the hash of each
    /// author e-mail is sent to gravatar.com.
    #[serde(default)]
    pub gravatar: bool,
    /// Look for a newer version at startup (SPEC §10). `None` until the user answered the
    /// one-time question: the check is opt-in, nothing is asked of GitHub before.
    #[serde(default)]
    pub check_updates: Option<bool>,
}

pub const FONT_SIZE_RANGE: std::ops::RangeInclusive<u8> = 11..=18;
pub const AUTO_FETCH_RANGE: std::ops::RangeInclusive<u32> = 1..=240;
pub const DEFAULT_FONT_SIZE: u8 = 13;
pub const DEFAULT_AUTO_FETCH_MINUTES: u32 = 10;
pub const DEFAULT_PROTECTED_BRANCHES: [&str; 4] = ["main", "master", "develop", "release/*"];
/// Longest accepted font family or protected branch pattern.
pub const MAX_PREF_TEXT: usize = 200;
pub const MAX_PROTECTED_BRANCHES: usize = 100;

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: ThemePreference::default(),
            style: ThemeStyle::default(),
            locale: None,
            terminal: None,
            terminal_mode: TerminalMode::default(),
            editor: None,
            diff_tool: None,
            merge_tool: None,
            diff_view: DiffViewMode::default(),
            high_contrast: false,
            density: Density::default(),
            ui_font: None,
            code_font: None,
            font_size: DEFAULT_FONT_SIZE,
            git_path: None,
            auto_fetch: true,
            auto_fetch_minutes: DEFAULT_AUTO_FETCH_MINUTES,
            prune: true,
            pull_strategy: None,
            protected_branches: DEFAULT_PROTECTED_BRANCHES
                .iter()
                .map(|b| (*b).to_owned())
                .collect(),
            disabled_confirmations: Vec::new(),
            diff_options: DiffPreferences::default(),
            gravatar: false,
            check_updates: None,
        }
    }
}

impl Preferences {
    /// The preferences as they will be stored: texts trimmed, lists cleaned, the locked
    /// confirmations restored. Rejects values out of range.
    pub fn normalized(&self) -> Result<Self, YagguiError> {
        let mut prefs = self.clone();
        if !FONT_SIZE_RANGE.contains(&prefs.font_size) {
            return Err(range_error(
                "Font size",
                "Taille de police",
                *FONT_SIZE_RANGE.start(),
                *FONT_SIZE_RANGE.end(),
            ));
        }
        if !AUTO_FETCH_RANGE.contains(&prefs.auto_fetch_minutes) {
            return Err(range_error(
                "Auto-fetch interval (minutes)",
                "Intervalle d'auto-fetch (minutes)",
                *AUTO_FETCH_RANGE.start(),
                *AUTO_FETCH_RANGE.end(),
            ));
        }
        prefs.editor = clean_command(prefs.editor.take())?;
        prefs.diff_tool = clean_tool_name(prefs.diff_tool.take())?;
        prefs.merge_tool = clean_tool_name(prefs.merge_tool.take())?;
        prefs.ui_font = clean_font(prefs.ui_font.take())?;
        prefs.code_font = clean_font(prefs.code_font.take())?;
        prefs.git_path = prefs
            .git_path
            .take()
            .map(|p| p.trim().to_owned())
            .filter(|p| !p.is_empty());

        let mut branches: Vec<String> = Vec::new();
        for pattern in &prefs.protected_branches {
            let pattern = pattern.trim();
            if pattern.is_empty() || branches.iter().any(|b| b == pattern) {
                continue;
            }
            if pattern.chars().count() > MAX_PREF_TEXT
                || pattern.chars().any(|c| c.is_whitespace() || c.is_control())
            {
                return Err(YagguiError::invalid_argument(
                    format!("\"{pattern}\" is not a valid branch name or pattern."),
                    format!("« {pattern} » n'est pas un nom ou un motif de branche valide."),
                ));
            }
            branches.push(pattern.to_owned());
        }
        if branches.len() > MAX_PROTECTED_BRANCHES {
            return Err(YagguiError::invalid_argument(
                format!("At most {MAX_PROTECTED_BRANCHES} protected branches are supported."),
                format!(
                    "{MAX_PROTECTED_BRANCHES} branches protégées au plus sont prises en charge."
                ),
            ));
        }
        prefs.protected_branches = branches;

        let mut disabled: Vec<ConfirmationKind> = Vec::new();
        for kind in &prefs.disabled_confirmations {
            if *kind != ConfirmationKind::ForcePush && !disabled.contains(kind) {
                disabled.push(*kind);
            }
        }
        prefs.disabled_confirmations = disabled;
        Ok(prefs)
    }
}

fn range_error(
    en: &str,
    fr: &str,
    min: impl std::fmt::Display,
    max: impl std::fmt::Display,
) -> YagguiError {
    YagguiError::invalid_argument(
        format!("{en} must be between {min} and {max}."),
        format!("{fr} : une valeur entre {min} et {max} est attendue."),
    )
}

/// An editor or terminal: a program or application name, or a path.
fn clean_command(value: Option<String>) -> Result<Option<String>, YagguiError> {
    let Some(value) = value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if value.len() > 512 || value.chars().any(char::is_control) || value.starts_with('-') {
        return Err(YagguiError::invalid_argument(
            "The editor must be a program or application name, or a path.",
            "L'éditeur doit être un nom de programme ou d'application, ou un chemin.",
        ));
    }
    Ok(Some(value))
}

/// A tool name for `git difftool --tool=` / `git mergetool --tool=`: it ends up in an
/// argument, so it stays a plain word.
pub fn is_tool_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with(['-', '.'])
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+'))
}

fn clean_tool_name(value: Option<String>) -> Result<Option<String>, YagguiError> {
    let Some(value) = value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if !is_tool_name(&value) {
        return Err(YagguiError::invalid_argument(
            format!("\"{value}\" is not a valid tool name (letters, digits, - _ . + only)."),
            format!(
                "« {value} » n'est pas un nom d'outil valide (lettres, chiffres, - _ . + seulement)."
            ),
        ));
    }
    Ok(Some(value))
}

/// A font family typed by the user ends up in a CSS declaration: keep it to plain names.
fn clean_font(font: Option<String>) -> Result<Option<String>, YagguiError> {
    let Some(font) = font else { return Ok(None) };
    let font = font.trim();
    if font.is_empty() {
        return Ok(None);
    }
    if font.chars().count() > MAX_PREF_TEXT
        || font
            .chars()
            .any(|c| c.is_control() || matches!(c, ';' | '{' | '}' | '<' | '>' | '\\' | '"' | '\''))
    {
        return Err(YagguiError::invalid_argument(
            format!("\"{font}\" is not a valid font name."),
            format!("« {font} » n'est pas un nom de police valide."),
        ));
    }
    Ok(Some(font.to_owned()))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Density {
    #[default]
    Comfortable,
    Compact,
}

/// Confirmation dialogs that can be turned off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConfirmationKind {
    DiscardChanges,
    DeleteTag,
    DropStash,
    /// Always asked: listed so the screen can show it locked.
    ForcePush,
}

/// Diff display options kept across sessions (F-082).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffPreferences {
    /// Soft-wrap long lines.
    pub wrap: bool,
    /// Like `git diff -w`. Hunk and line actions are disabled while it is on.
    pub ignore_whitespace: bool,
    /// Unchanged lines around each change.
    pub context_lines: u32,
    /// One hunk spanning the whole file.
    pub full_file: bool,
    /// Markdown files shown rendered, with their changes (F-089). Absent from options saved
    /// before it existed.
    #[serde(default)]
    pub markdown_preview: bool,
}

impl Default for DiffPreferences {
    fn default() -> Self {
        Self {
            wrap: false,
            ignore_whitespace: false,
            context_lines: 3,
            full_file: false,
            markdown_preview: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DiffViewMode {
    Unified,
    #[default]
    Split,
}

/// Values previously kept in `localStorage` (M0-1), imported once.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPreferences {
    pub theme: Option<ThemePreference>,
    pub locale: Option<Locale>,
}

/// What yaggui knows about a `git` binary, for the preferences screen (F-322).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitBinaryInfo {
    /// Absolute path when it could be resolved, else what was asked for.
    pub path: Option<String>,
    /// `None` when the binary does not work (see `error`).
    pub version: Option<String>,
    /// `false` below the minimal supported version (warning in the UI).
    pub supported: bool,
    pub min_version: String,
    pub error: Option<YagguiError>,
}
