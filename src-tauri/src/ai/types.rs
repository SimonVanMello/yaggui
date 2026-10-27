//! AI commit message types shared with the frontend (F-072 to F-075).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::errors::YagguiError;

/// A service that writes the message. Adding one (Codex CLI, another API) is a new variant
/// and a new module of `ai/`: the commands keep their shape.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AiProviderKind {
    /// Anthropic's Messages API with the user's API key.
    #[default]
    ClaudeApi,
    /// The user's `claude` CLI and login, run read-only in the repository.
    ClaudeCode,
}

/// Default model of the Claude API provider: fast and cheap, enough for a commit message.
pub const DEFAULT_CLAUDE_API_MODEL: &str = "claude-haiku-5-5";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeApiSettings {
    /// Model id sent to the API (`claude-haiku-5-5`).
    pub model: String,
}

impl Default for ClaudeApiSettings {
    fn default() -> Self {
        Self {
            model: DEFAULT_CLAUDE_API_MODEL.to_owned(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeSettings {
    /// `--model` (an alias like `haiku` or a full id); `None` keeps the CLI's default.
    pub model: Option<String>,
    /// Name of a Claude Code skill to write the message with (`commit`, `plugin:skill`);
    /// `None` uses yaggui's prompt alone.
    pub skill: Option<String>,
}

/// Language of the generated message.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AiLanguage {
    /// The language of the recent subjects of the branch, English when there are none.
    #[default]
    Auto,
    En,
    Fr,
}

/// Settings of the AI commit messages that travel with an exported preferences file. Whether
/// the feature is on (`Preferences::ai_enabled`) and the `claude` path
/// (`Preferences::claude_path`) are kept per machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiPreferences {
    /// The provider used by the commit area.
    pub provider: AiProviderKind,
    pub claude_api: ClaudeApiSettings,
    pub claude_code: ClaudeCodeSettings,
    /// Instructions replacing the default ones (`ai_default_prompt`); `None` follows the
    /// default, so its improvements reach users who never edited it. The context block is
    /// always appended by yaggui.
    pub custom_prompt: Option<String>,
    /// Diff bytes sent at most, all files together, within `AI_DIFF_BYTES_RANGE`.
    pub max_diff_bytes: u32,
    /// Diff bytes sent at most for one file, within `AI_FILE_BYTES_RANGE`; the rest of the
    /// file is cut and the file is listed as truncated.
    pub max_file_bytes: u32,
    /// Globs of paths whose diff is never sent, only their name and status. A pattern
    /// without `/` matches the file name anywhere (`*.lock`), else the path from the root
    /// (`vendor/**`).
    pub excluded_paths: Vec<String>,
    /// Subjects of the last commits of the branch sent as style examples, within
    /// `AI_RECENT_SUBJECTS_RANGE`; 0 sends none.
    pub recent_subjects: u8,
    pub language: AiLanguage,
    /// Seconds before a generation is abandoned, within `AI_TIMEOUT_RANGE`.
    pub timeout_seconds: u32,
}

pub const AI_DIFF_BYTES_RANGE: std::ops::RangeInclusive<u32> = 4_000..=1_000_000;
pub const AI_FILE_BYTES_RANGE: std::ops::RangeInclusive<u32> = 500..=1_000_000;
pub const AI_RECENT_SUBJECTS_RANGE: std::ops::RangeInclusive<u8> = 0..=50;
pub const AI_TIMEOUT_RANGE: std::ops::RangeInclusive<u32> = 10..=900;
pub const DEFAULT_AI_DIFF_BYTES: u32 = 60_000;
pub const DEFAULT_AI_FILE_BYTES: u32 = 12_000;
pub const DEFAULT_AI_RECENT_SUBJECTS: u8 = 10;
pub const DEFAULT_AI_TIMEOUT_SECONDS: u32 = 120;
/// Longest custom prompt accepted.
pub const AI_PROMPT_MAX: u32 = 20_000;
pub const AI_EXCLUDED_PATHS_MAX: usize = 200;
/// Lockfiles and generated bundles: large, noisy, and never what a commit is about.
pub const DEFAULT_AI_EXCLUDED_PATHS: [&str; 12] = [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "Cargo.lock",
    "Gemfile.lock",
    "composer.lock",
    "poetry.lock",
    "uv.lock",
    "go.sum",
    "*.min.js",
    "*.min.css",
];

impl Default for AiPreferences {
    fn default() -> Self {
        Self {
            provider: AiProviderKind::default(),
            claude_api: ClaudeApiSettings::default(),
            claude_code: ClaudeCodeSettings::default(),
            custom_prompt: None,
            max_diff_bytes: DEFAULT_AI_DIFF_BYTES,
            max_file_bytes: DEFAULT_AI_FILE_BYTES,
            excluded_paths: DEFAULT_AI_EXCLUDED_PATHS
                .iter()
                .map(|p| (*p).to_owned())
                .collect(),
            recent_subjects: DEFAULT_AI_RECENT_SUBJECTS,
            language: AiLanguage::default(),
            timeout_seconds: DEFAULT_AI_TIMEOUT_SECONDS,
        }
    }
}

/// Where the API key comes from. The key itself never leaves the backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ApiKeySource {
    /// No key: neither saved nor in the environment.
    None,
    /// Saved by yaggui in the OS keychain (`ai_set_api_key`).
    Keychain,
    /// `ANTHROPIC_API_KEY` of yaggui's or the login shell's environment.
    Environment,
}

/// What a provider needs to work, and what yaggui found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiCredential {
    /// An API key, saved in the keychain or read from the environment.
    #[serde(rename_all = "camelCase")]
    ApiKey {
        source: ApiKeySource,
        /// The OS keychain can be used (`ai_set_api_key` would work). When it cannot (no
        /// Secret Service on Linux), the environment variable is the only way.
        keychain_available: bool,
        /// Name of the environment variable read when no key is saved.
        env_var: String,
    },
    /// A command-line program and its own login.
    #[serde(rename_all = "camelCase")]
    Cli {
        /// Absolute path of the program found (the configured one, or on the login shell's
        /// `PATH`); `None` when it was not found.
        path: Option<String>,
        /// What `--version` printed; `None` when it does not run.
        version: Option<String>,
        /// The path comes from the preferences rather than auto-detection.
        configured: bool,
    },
}

/// One provider as the preferences screen lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderStatus {
    pub kind: AiProviderKind,
    /// Display name (a product name, the same in every language).
    pub name: String,
    /// Model used when none is set; `None` when the provider picks it itself.
    pub default_model: Option<String>,
    /// Models offered in the picker (any other id can be typed).
    pub suggested_models: Vec<String>,
    /// The provider can run a Claude Code skill (`ai_list_skills`).
    pub supports_skills: bool,
    pub credential: AiCredential,
    /// Everything needed is there; a generation can still fail (key refused, offline).
    pub ready: bool,
    /// Why it is not ready (`aiNotConfigured`, `aiKeychainUnavailable`…).
    pub problem: Option<YagguiError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    /// Every provider this version knows, in display order.
    pub providers: Vec<AiProviderStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AiSkillScope {
    /// `~/.claude/skills` or `~/.claude/commands`.
    User,
    /// `.claude/skills` or `.claude/commands` of the repository.
    Project,
    /// A skill of an installed Claude Code plugin (best effort).
    Plugin,
}

/// A Claude Code skill or custom command the Claude Code provider can be asked to use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiSkill {
    /// Name to save in `ClaudeCodeSettings::skill` (`commit`, `plugin:commit`).
    pub name: String,
    /// The `description` of its frontmatter.
    pub description: Option<String>,
    pub scope: AiSkillScope,
    /// A legacy `commands/<name>.md` custom command rather than a `skills/<name>/SKILL.md`.
    pub legacy_command: bool,
}

/// What to describe, for `ai_generate_commit_message` and `ai_preview_context`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiMessageRequest {
    /// The commit will amend HEAD: HEAD's own changes are described too.
    pub amend: bool,
    /// The Conventional Commits helper is on: ask for `type(scope): subject`.
    pub conventional: bool,
}

/// What the context sent to the provider holds, for the result and the preview.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiContextSummary {
    /// Changed files, all listed with their status.
    pub files: u32,
    /// Files whose diff was cut to `maxFileBytes`.
    pub truncated_files: Vec<String>,
    /// Files matching `excludedPaths`: name and status only.
    pub excluded_files: Vec<String>,
    /// Binary files: name and status only.
    pub binary_files: Vec<String>,
    /// Files left out once `maxDiffBytes` was reached: name and status only.
    pub omitted_files: Vec<String>,
    /// Size of the whole text sent (instructions and context), in bytes.
    pub sent_bytes: u32,
}

/// The exact text a generation would send, without sending anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiContextPreview {
    pub text: String,
    pub summary: AiContextSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedCommitMessage {
    /// First line, trimmed.
    pub summary: String,
    /// The rest after the first blank line, trimmed; empty when there is none.
    pub description: String,
    pub provider: AiProviderKind,
    /// Model that answered, when the provider says (or the one asked for).
    pub model: Option<String>,
    pub duration_ms: u32,
    pub context: AiContextSummary,
}

/// Answer of `ai_test_provider`: the provider answered a tiny prompt (no repository data).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiTestResult {
    pub provider: AiProviderKind,
    pub model: Option<String>,
    pub duration_ms: u32,
    /// The provider's reply, cut to a few hundred characters.
    pub reply: String,
}
