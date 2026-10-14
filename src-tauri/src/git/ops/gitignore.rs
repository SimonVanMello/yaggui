//! `.gitignore` templates offered by "Init" (F-003). Short lists of the usual build outputs,
//! dependency folders and editor or OS leftovers; written for yaggui, no third-party text.
//! Also the rules "Add to .gitignore" writes for one file (F-069).

use serde::{Deserialize, Serialize};
use specta::Type;

use super::types::GitignoreRuleKind;
use crate::git::errors::YagguiError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GitignoreTemplate {
    Node,
    Rust,
    DotNet,
    Python,
    MacOs,
    Windows,
}

impl GitignoreTemplate {
    pub const ALL: [Self; 6] = [
        Self::Node,
        Self::Rust,
        Self::DotNet,
        Self::Python,
        Self::MacOs,
        Self::Windows,
    ];

    pub fn title(self) -> &'static str {
        match self {
            Self::Node => "Node",
            Self::Rust => "Rust",
            Self::DotNet => ".NET",
            Self::Python => "Python",
            Self::MacOs => "macOS",
            Self::Windows => "Windows",
        }
    }

    pub fn content(self) -> &'static str {
        match self {
            Self::Node => {
                "node_modules/\n.pnpm-store/\ndist/\nbuild/\ncoverage/\n.next/\n.cache/\n*.log\nnpm-debug.log*\nyarn-error.log*\n.env\n.env.local\n*.tsbuildinfo\n"
            }
            Self::Rust => "target/\n**/*.rs.bk\n*.pdb\n",
            Self::DotNet => {
                "bin/\nobj/\n.vs/\n*.user\n*.suo\n*.userprefs\nTestResults/\n*.nupkg\nproject.lock.json\n"
            }
            Self::Python => {
                "__pycache__/\n*.py[cod]\n.venv/\nvenv/\n.pytest_cache/\n.mypy_cache/\n.ruff_cache/\n*.egg-info/\nbuild/\ndist/\n.env\n"
            }
            Self::MacOs => ".DS_Store\n.AppleDouble\n.LSOverride\n._*\n.Spotlight-V100\n.Trashes\n",
            Self::Windows => "Thumbs.db\nehthumbs.db\nDesktop.ini\n$RECYCLE.BIN/\n*.lnk\n",
        }
    }
}

/// The text of a `.gitignore` made of `templates`, each under a comment with its name.
/// Duplicates are written once, in the order given.
pub fn render(templates: &[GitignoreTemplate]) -> String {
    let mut seen: Vec<GitignoreTemplate> = Vec::new();
    let mut out = String::new();
    for template in templates {
        if seen.contains(template) {
            continue;
        }
        seen.push(*template);
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str("# ");
        out.push_str(template.title());
        out.push('\n');
        out.push_str(template.content());
    }
    out
}

/// A rule for one file, and what it matches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IgnoreRule {
    /// The `.gitignore` line.
    pub line: String,
    kind: GitignoreRuleKind,
    /// The file, the extension with its dot (`.log`), or the folder with its slash.
    target: String,
}

impl IgnoreRule {
    /// The rule of `kind` for the repository-relative file `path`.
    pub fn for_path(path: &str, kind: GitignoreRuleKind) -> Result<Self, YagguiError> {
        let path = path.trim_end_matches('/');
        let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
        match kind {
            GitignoreRuleKind::File => Ok(Self {
                line: format!("/{}", escape(path)),
                kind,
                target: path.to_owned(),
            }),
            GitignoreRuleKind::Extension => {
                let ext = name
                    .rfind('.')
                    .filter(|&dot| dot > 0 && dot + 1 < name.len())
                    .map(|dot| &name[dot..])
                    .ok_or_else(|| {
                        YagguiError::invalid_argument(
                            format!("\"{name}\" has no extension."),
                            format!("« {name} » n'a pas d'extension."),
                        )
                    })?;
                Ok(Self {
                    line: format!("*{}", escape(ext)),
                    kind,
                    target: ext.to_owned(),
                })
            }
            GitignoreRuleKind::Folder => {
                if dir.is_empty() {
                    return Err(YagguiError::invalid_argument(
                        format!(
                            "\"{path}\" is at the root of the repository: it has no folder to ignore."
                        ),
                        format!(
                            "« {path} » est à la racine du dépôt : il n'a pas de dossier à ignorer."
                        ),
                    ));
                }
                Ok(Self {
                    line: format!("/{}/", escape(dir)),
                    kind,
                    target: format!("{dir}/"),
                })
            }
        }
    }

    /// Whether the rule ignores the repository-relative file `path`.
    pub fn matches(&self, path: &str) -> bool {
        match self.kind {
            GitignoreRuleKind::File => path == self.target,
            GitignoreRuleKind::Extension => path
                .rsplit('/')
                .next()
                .is_some_and(|name| name.ends_with(&self.target)),
            GitignoreRuleKind::Folder => path.starts_with(&self.target),
        }
    }

    /// The text of `.gitignore` with the rule appended (on a line of its own), keeping CRLF
    /// line endings when the file has them.
    pub fn append_to(&self, current: &str) -> String {
        let eol = if current.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let mut out = current.to_owned();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push_str(eol);
        }
        out.push_str(&self.line);
        out.push_str(eol);
        out
    }

    /// `current` already has the exact line.
    pub fn is_in(&self, current: &str) -> bool {
        current
            .lines()
            .any(|line| line.trim_end_matches('\r') == self.line)
    }
}

/// Escapes a literal name for a `.gitignore` pattern: wildcards and trailing spaces (which Git
/// would otherwise drop). Every rule starts with `/` or `*`, so a `#` or `!` is never first.
fn escape(literal: &str) -> String {
    let mut out = String::with_capacity(literal.len());
    for c in literal.chars() {
        if matches!(c, '\\' | '*' | '?' | '[') {
            out.push('\\');
        }
        out.push(c);
    }
    let trimmed = out.trim_end_matches(' ');
    let spaces = out.len() - trimmed.len();
    let mut escaped = trimmed.to_owned();
    for _ in 0..spaces {
        escaped.push_str("\\ ");
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_rules_for_a_file() {
        let rule = |path, kind| IgnoreRule::for_path(path, kind).map(|r| r.line);
        assert_eq!(
            rule("logs/app.log", GitignoreRuleKind::File).unwrap(),
            "/logs/app.log"
        );
        assert_eq!(
            rule("logs/app.log", GitignoreRuleKind::Extension).unwrap(),
            "*.log"
        );
        assert_eq!(
            rule("logs/app.log", GitignoreRuleKind::Folder).unwrap(),
            "/logs/"
        );
        assert_eq!(
            rule("a/b/c.tar.gz", GitignoreRuleKind::Extension).unwrap(),
            "*.gz"
        );
        assert!(rule(".env", GitignoreRuleKind::Extension).is_err());
        assert!(rule("README", GitignoreRuleKind::Extension).is_err());
        assert!(rule("top.txt", GitignoreRuleKind::Folder).is_err());
    }

    #[test]
    fn escapes_special_characters() {
        let rule = |path| {
            IgnoreRule::for_path(path, GitignoreRuleKind::File)
                .unwrap()
                .line
        };
        assert_eq!(rule("a[1]*?.txt"), "/a\\[1]\\*\\?.txt");
        assert_eq!(rule("#notes"), "/#notes");
        assert_eq!(rule("trail "), "/trail\\ ");
        let bang = IgnoreRule::for_path("!x/y.md", GitignoreRuleKind::Folder).unwrap();
        assert_eq!(bang.line, "/!x/");
    }

    #[test]
    fn matches_and_appends() {
        let ext = IgnoreRule::for_path("x/a.log", GitignoreRuleKind::Extension).unwrap();
        assert!(ext.matches("deep/b.log"));
        assert!(!ext.matches("b.logs"));
        let dir = IgnoreRule::for_path("build/out/a.o", GitignoreRuleKind::Folder).unwrap();
        assert!(dir.matches("build/out/b/c"));
        assert!(!dir.matches("build/outer"));
        assert_eq!(dir.append_to(""), "/build/out/\n");
        assert_eq!(dir.append_to("a\nb"), "a\nb\n/build/out/\n");
        assert!(dir.is_in("x\r\n/build/out/\r\n"));
        assert_eq!(dir.append_to("x\r\ny"), "x\r\ny\r\n/build/out/\r\n");
    }

    #[test]
    fn renders_each_template_once_under_its_name() {
        let text = render(&[
            GitignoreTemplate::Rust,
            GitignoreTemplate::MacOs,
            GitignoreTemplate::Rust,
        ]);
        assert_eq!(text.matches("# Rust\n").count(), 1);
        assert!(text.contains("target/\n"));
        assert!(text.contains("\n# macOS\n.DS_Store\n"));
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn every_template_has_content() {
        for template in GitignoreTemplate::ALL {
            assert!(!template.content().is_empty(), "{}", template.title());
            assert!(template.content().ends_with('\n'));
        }
    }

    #[test]
    fn nothing_selected_renders_nothing() {
        assert_eq!(render(&[]), "");
    }
}
