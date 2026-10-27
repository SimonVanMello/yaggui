//! Claude Code skills the Claude Code provider can be asked to use (F-073): the user's, the
//! repository's, and those of installed plugins (best effort). Bounded: a few folders, the
//! start of each file.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::prefs::is_plain_name;
use super::types::{AiSkill, AiSkillScope};

/// Bytes read from a skill file: the frontmatter is at the top.
const HEAD_BYTES: u64 = 16 * 1024;
/// Entries listed at most, all folders together.
const MAX_SKILLS: usize = 500;
const DESCRIPTION_MAX_CHARS: usize = 300;

/// Skills of `home` (`~/.claude`, and installed plugins) and of `repo` (`.claude`), sorted by
/// name, project ones first on equal names.
pub fn list(home: Option<&Path>, repo: Option<&Path>) -> Vec<AiSkill> {
    let mut skills = Vec::new();
    if let Some(repo) = repo {
        scan(
            &repo.join(".claude"),
            AiSkillScope::Project,
            None,
            &mut skills,
        );
    }
    if let Some(home) = home {
        let claude = home.join(".claude");
        scan(&claude, AiSkillScope::User, None, &mut skills);
        for (plugin, path) in installed_plugins(&claude) {
            scan(&path, AiSkillScope::Plugin, Some(&plugin), &mut skills);
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name).then(rank(a.scope).cmp(&rank(b.scope))));
    skills.dedup_by(|b, a| a.name == b.name && a.scope == b.scope);
    skills.truncate(MAX_SKILLS);
    skills
}

fn rank(scope: AiSkillScope) -> u8 {
    match scope {
        AiSkillScope::Project => 0,
        AiSkillScope::User => 1,
        AiSkillScope::Plugin => 2,
    }
}

/// `<root>/skills/<name>/SKILL.md` and the legacy `<root>/commands/<name>.md`.
fn scan(root: &Path, scope: AiSkillScope, plugin: Option<&str>, out: &mut Vec<AiSkill>) {
    let named = |name: &str| match plugin {
        Some(plugin) => format!("{plugin}:{name}"),
        None => name.to_owned(),
    };
    for dir in entries(&root.join("skills")) {
        let file = dir.join("SKILL.md");
        if out.len() >= MAX_SKILLS || !file.is_file() {
            continue;
        }
        let Some(folder) = dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let front = frontmatter(&file);
        let name = front.name.unwrap_or_else(|| folder.to_owned());
        push(out, named(&name), front.description, scope, false);
    }
    for file in entries(&root.join("commands")) {
        if out.len() >= MAX_SKILLS || file.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = file.file_stem().and_then(|n| n.to_str()) else {
            continue;
        };
        let front = frontmatter(&file);
        push(out, named(stem), front.description, scope, true);
    }
}

fn push(
    out: &mut Vec<AiSkill>,
    name: String,
    description: Option<String>,
    scope: AiSkillScope,
    legacy_command: bool,
) {
    // The name is saved in the preferences and sent to the CLI: it stays a plain word.
    if !is_plain_name(&name) {
        return;
    }
    out.push(AiSkill {
        name,
        description,
        scope,
        legacy_command,
    });
}

/// Entries of a folder, sorted; none when it cannot be read.
fn entries(dir: &Path) -> Vec<PathBuf> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = read
        .filter_map(Result::ok)
        .map(|e| e.path())
        .take(MAX_SKILLS * 2)
        .collect();
    paths.sort();
    paths
}

/// Installed plugins and their folders, from `~/.claude/plugins/installed_plugins.json`.
fn installed_plugins(claude: &Path) -> Vec<(String, PathBuf)> {
    let file = claude.join("plugins").join("installed_plugins.json");
    let Ok(meta) = std::fs::metadata(&file) else {
        return Vec::new();
    };
    if meta.len() > 4 * 1024 * 1024 {
        return Vec::new();
    }
    let Some(json) = std::fs::read(&file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
        return Vec::new();
    };
    let Some(plugins) = json.get("plugins").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for (id, installs) in plugins {
        // `name@marketplace`
        let name = id.split('@').next().unwrap_or(id).to_owned();
        // Older layouts hold one object, newer ones a list of installs (per scope).
        let installs: Vec<&Value> = match installs {
            Value::Array(list) => list.iter().collect(),
            other => vec![other],
        };
        for install in installs {
            if let Some(path) = install.get("installPath").and_then(Value::as_str) {
                found.push((name.clone(), PathBuf::from(path)));
            }
        }
    }
    found
}

#[derive(Debug, Default, PartialEq, Eq)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
}

fn frontmatter(file: &Path) -> Frontmatter {
    let mut head = String::new();
    let Ok(handle) = std::fs::File::open(file) else {
        return Frontmatter::default();
    };
    let mut bytes = Vec::new();
    if handle.take(HEAD_BYTES).read_to_end(&mut bytes).is_err() {
        return Frontmatter::default();
    }
    head.push_str(&String::from_utf8_lossy(&bytes));
    parse_frontmatter(&head)
}

/// `name` and `description` of a `---` YAML block: single-line values, or folded (`>`,
/// `|`) ones on the indented lines that follow.
fn parse_frontmatter(text: &str) -> Frontmatter {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Frontmatter::default();
    }
    let block: Vec<&str> = lines.take_while(|l| l.trim() != "---").collect();
    let value = |key: &str| -> Option<String> {
        let index = block
            .iter()
            .position(|l| l.strip_prefix(key).is_some_and(|r| r.starts_with(':')))?;
        let raw = block[index][key.len() + 1..].trim();
        let text = if raw.is_empty() || raw.starts_with(['>', '|']) {
            block[index + 1..]
                .iter()
                .take_while(|l| l.starts_with([' ', '\t']) || l.trim().is_empty())
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            unquote(raw).to_owned()
        };
        let text: String = text.chars().take(DESCRIPTION_MAX_CHARS).collect();
        (!text.is_empty()).then_some(text)
    };
    Frontmatter {
        name: value("name"),
        description: value("description"),
    }
}

fn unquote(value: &str) -> &str {
    for quote in ['"', '\''] {
        if value.len() >= 2
            && let Some(inner) = value
                .strip_prefix(quote)
                .and_then(|v| v.strip_suffix(quote))
        {
            return inner;
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn lists_user_project_command_and_plugin_skills() {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        write(
            &home.path().join(".claude/skills/commit/SKILL.md"),
            "---\nname: commit\ndescription: \"Write commits our way\"\n---\nbody",
        );
        write(
            &home.path().join(".claude/skills/review/SKILL.md"),
            "---\ndescription: >\n  Reviews code\n  carefully.\n---\n",
        );
        write(
            &home.path().join(".claude/skills/empty/README.md"),
            "no skill file",
        );
        write(
            &home.path().join(".claude/commands/changelog.md"),
            "---\ndescription: Update the changelog\n---\n",
        );
        write(
            &repo.path().join(".claude/skills/commit/SKILL.md"),
            "---\nname: commit\ndescription: Project commits\n---\n",
        );
        write(
            &repo.path().join(".claude/skills/bad name/SKILL.md"),
            "---\nname: --evil\n---\n",
        );
        let plugin = home.path().join("plugin-install");
        write(
            &plugin.join("skills/conventional/SKILL.md"),
            "---\nname: conventional\n---\n",
        );
        write(
            &home.path().join(".claude/plugins/installed_plugins.json"),
            &format!(
                r#"{{"version":2,"plugins":{{"git-tools@market":[{{"installPath":{}}}]}}}}"#,
                serde_json::to_string(plugin.to_str().unwrap()).unwrap()
            ),
        );

        let skills = list(Some(home.path()), Some(repo.path()));
        let summary: Vec<(String, AiSkillScope, bool, Option<String>)> = skills
            .into_iter()
            .map(|s| (s.name, s.scope, s.legacy_command, s.description))
            .collect();
        assert_eq!(
            summary,
            vec![
                (
                    "changelog".into(),
                    AiSkillScope::User,
                    true,
                    Some("Update the changelog".into())
                ),
                (
                    "commit".into(),
                    AiSkillScope::Project,
                    false,
                    Some("Project commits".into())
                ),
                (
                    "commit".into(),
                    AiSkillScope::User,
                    false,
                    Some("Write commits our way".into())
                ),
                (
                    "git-tools:conventional".into(),
                    AiSkillScope::Plugin,
                    false,
                    None
                ),
                (
                    "review".into(),
                    AiSkillScope::User,
                    false,
                    Some("Reviews code carefully.".into())
                ),
            ]
        );
    }

    #[test]
    fn nothing_when_the_folders_are_missing() {
        let empty = tempfile::tempdir().unwrap();
        assert!(list(Some(empty.path()), Some(empty.path())).is_empty());
        assert!(list(None, None).is_empty());
    }

    #[test]
    fn frontmatter_needs_its_fences() {
        assert_eq!(parse_frontmatter("name: x\n"), Frontmatter::default());
        assert_eq!(
            parse_frontmatter("---\nname: 'x'\nnamed: y\n---\n")
                .name
                .as_deref(),
            Some("x")
        );
    }
}
