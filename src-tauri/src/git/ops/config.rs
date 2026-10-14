//! Git configuration editor (F-325) and external tool checks (F-323): payloads and parsing.
//! Pure functions; the commands run through `git/cli.rs` (see `repo/config.rs`).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::errors::YagguiError;

/// One `key = value` line of a config file. `value` is `None` for a bare key (`[core] bare`),
/// which Git reads as `true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEntry {
    pub key: String,
    pub value: Option<String>,
}

/// What an external tool setting is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ExternalToolKind {
    Editor,
    Terminal,
    DiffTool,
    MergeTool,
}

/// Why a diff or merge tool cannot be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ToolIssue {
    /// No tool named, and `diff.tool` / `merge.tool` is not set.
    NotConfigured,
    /// Git knows the tool but it is not installed.
    NotInstalled,
    /// Git does not know the tool and no `<family>tool.<name>.cmd` defines it.
    Unknown,
}

/// Result of "Test" next to an external tool setting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalToolCheck {
    /// The program that was started, or the tool Git knows.
    pub tool: String,
    /// Editor and terminal: started. Diff and merge tools: known to Git and installed.
    pub ok: bool,
    /// Why a diff or merge tool is not usable.
    pub issue: Option<ToolIssue>,
}

/// `git config --list -z` output: `key\nvalue\0` per entry, `key\0` when there is no value.
pub fn parse_config_list(raw: &str) -> Vec<ConfigEntry> {
    raw.split('\0')
        .filter(|record| !record.is_empty())
        .map(|record| match record.split_once('\n') {
            Some((key, value)) => ConfigEntry {
                key: key.to_owned(),
                value: Some(value.to_owned()),
            },
            None => ConfigEntry {
                key: record.to_owned(),
                value: None,
            },
        })
        .collect()
}

const MAX_KEY: usize = 200;
/// A value is an argument of `git config`; stay far below the OS limits.
const MAX_VALUE: usize = 16 * 1024;

fn invalid_key(key: &str) -> YagguiError {
    YagguiError::invalid_argument(
        format!(
            "\"{key}\" is not a valid Git configuration key (section.name or section.subsection.name)."
        ),
        format!(
            "« {key} » n'est pas une clé de configuration Git valide (section.nom ou section.sous-section.nom)."
        ),
    )
}

/// Checks a key the way `git config` reads it, and that it cannot be taken for an option.
pub fn validate_key(key: &str) -> Result<(), YagguiError> {
    let (Some((section, rest)), true) = (key.split_once('.'), key.len() <= MAX_KEY) else {
        return Err(invalid_key(key));
    };
    // The variable name is what follows the last dot; a subsection may contain dots.
    let name = rest.rsplit('.').next().unwrap_or(rest);
    let subsection = rest.strip_suffix(name).unwrap_or("");
    let word = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    let valid = !section.is_empty()
        && word(section)
        && !section.starts_with('-')
        && name.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && word(name)
        && !subsection.chars().any(|c| c.is_control());
    if valid { Ok(()) } else { Err(invalid_key(key)) }
}

pub fn validate_value(value: &str) -> Result<(), YagguiError> {
    if value.contains('\0') || value.len() > MAX_VALUE {
        return Err(YagguiError::invalid_argument(
            "The value is too long or contains a NUL character.",
            "La valeur est trop longue ou contient un caractère NUL.",
        ));
    }
    Ok(())
}

/// Tools listed by `git difftool --tool-help` / `git mergetool --tool-help`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolHelp {
    pub available: Vec<String>,
    /// Known to Git but not installed.
    pub missing: Vec<String>,
}

pub fn parse_tool_help(output: &str) -> ToolHelp {
    #[derive(Clone, Copy, PartialEq)]
    enum Section {
        None,
        Available,
        Missing,
        UserDefined,
    }
    let mut help = ToolHelp::default();
    let mut section = Section::None;
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed == "user-defined:" {
            section = Section::UserDefined;
        } else if !line.starts_with(char::is_whitespace) {
            section = if trimmed.contains("may be set to one of the following") {
                Section::Available
            } else if trimmed.contains("valid, but not currently available") {
                Section::Missing
            } else {
                Section::None
            };
        } else {
            let Some(first) = trimmed.split_whitespace().next() else {
                continue;
            };
            let name = first.strip_suffix(".cmd").unwrap_or(first).to_owned();
            match section {
                Section::Available | Section::UserDefined => help.available.push(name),
                Section::Missing => help.missing.push(name),
                Section::None => {}
            }
        }
    }
    help
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::errors::ErrorCode;

    #[test]
    fn parses_nul_separated_entries() {
        let list = parse_config_list("user.name\nAda L\0core.bare\0alias.x\n!echo a\nb\0");
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].value.as_deref(), Some("Ada L"));
        assert_eq!(list[1].value, None);
        assert_eq!(list[2].value.as_deref(), Some("!echo a\nb"));
        assert!(parse_config_list("").is_empty());
    }

    #[test]
    fn keys_follow_git_syntax() {
        for key in [
            "user.name",
            "pull.rebase",
            "core.autocrlf",
            "branch.feat/x.remote",
            "url.https://host/.insteadOf",
            "gpg.ssh.program",
        ] {
            assert!(validate_key(key).is_ok(), "{key}");
        }
        for key in [
            "",
            "name",
            "-c.x",
            "--global.x",
            ".name",
            "user.",
            "user.1name",
            "us er.name",
            "user.na me",
            "user.name\n",
        ] {
            let err = validate_key(key).expect_err(key);
            assert_eq!(err.code, ErrorCode::InvalidArgument, "{key}");
        }
    }

    #[test]
    fn parses_tool_help() {
        let out = "\
'git difftool --tool=<tool>' may be set to one of the following:
\t\tmeld
\t\tvimdiff

The following tools are valid, but not currently available:
\t\tkdiff3
\t\topendiff

Some of the tools listed above only work in a windowed
environment. If run in a terminal-only session, they will fail.
user-defined:
\t\tmine.cmd = my-diff \"$LOCAL\" \"$REMOTE\"
";
        let help = parse_tool_help(out);
        assert_eq!(help.available, ["meld", "vimdiff", "mine"]);
        assert_eq!(help.missing, ["kdiff3", "opendiff"]);
    }
}
