//! The release notes of `CHANGELOG.md`, embedded in the binary so the "What's new" view works
//! offline. The file follows Keep a Changelog; `scripts/version.mjs` moves `Unreleased` into the
//! new version at release time.

use std::sync::LazyLock;

use serde::Serialize;
use specta::Type;

const CHANGELOG: &str = include_str!("../../../CHANGELOG.md");

/// How the UI groups an entry. Keep a Changelog has six sections; users care about three.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Feature,
    Fix,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogEntry {
    pub kind: ChangeKind,
    /// One paragraph; Markdown links are reduced to their text, `code` spans are kept.
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogRelease {
    /// `None` for the changes not released yet.
    pub version: Option<String>,
    /// Release date, `YYYY-MM-DD`.
    pub date: Option<String>,
    /// In file order: grouping by kind is the UI's.
    pub entries: Vec<ChangelogEntry>,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ParseError {
    #[error("line {0}: expected `## [Unreleased]` or `## [x.y.z] - YYYY-MM-DD`")]
    BadVersion(usize),
    #[error("line {0}: unknown section `{1}`")]
    UnknownSection(usize, String),
    #[error("line {0}: entry outside a `###` section")]
    EntryOutsideSection(usize),
    #[error("line {0}: unexpected text")]
    UnexpectedLine(usize),
}

/// Releases newest first, as written. An empty `Unreleased` section is left out.
pub fn releases() -> Vec<ChangelogRelease> {
    static PARSED: LazyLock<Vec<ChangelogRelease>> = LazyLock::new(|| {
        parse(CHANGELOG).unwrap_or_else(|err| {
            // The tests parse the embedded file: this only happens on a build that skipped them.
            tracing::error!(error = %err, "embedded CHANGELOG.md does not parse");
            Vec::new()
        })
    });
    PARSED.clone()
}

fn section_kind(heading: &str) -> Option<ChangeKind> {
    match heading {
        "Added" => Some(ChangeKind::Feature),
        "Fixed" | "Security" => Some(ChangeKind::Fix),
        "Changed" | "Deprecated" | "Removed" => Some(ChangeKind::Other),
        _ => None,
    }
}

fn parse_version_heading(heading: &str) -> Option<(Option<String>, Option<String>)> {
    if heading == "[Unreleased]" {
        return Some((None, None));
    }
    let (version, date) = heading.strip_prefix('[')?.split_once("] - ")?;
    let numeric = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    let parts: Vec<&str> = version.split('.').collect();
    let date_parts: Vec<&str> = date.split('-').collect();
    let date_ok = date_parts.len() == 3
        && date_parts.iter().all(|part| numeric(part))
        && date_parts.iter().map(|part| part.len()).eq([4, 2, 2]);
    (parts.len() == 3 && parts.iter().all(|part| numeric(part)) && date_ok)
        .then(|| (Some(version.to_owned()), Some(date.to_owned())))
}

/// `[text](url)` → `text`; anything else is left as written.
fn strip_links(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        let link = after.find("](").and_then(|close| {
            let url = &after[close + 2..];
            url.find(')').map(|end| (close, close + 2 + end + 1))
        });
        match link {
            Some((close, consumed)) => {
                out.push_str(&rest[..open]);
                out.push_str(&after[..close]);
                rest = &after[consumed..];
            }
            None => {
                out.push_str(&rest[..=open]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

pub fn parse(text: &str) -> Result<Vec<ChangelogRelease>, ParseError> {
    let mut releases: Vec<ChangelogRelease> = Vec::new();
    let mut kind: Option<ChangeKind> = None;

    for (index, raw) in text.lines().enumerate() {
        let line_no = index + 1;
        let line = raw.trim_end();
        if let Some(heading) = line.strip_prefix("## ") {
            let (version, date) =
                parse_version_heading(heading.trim()).ok_or(ParseError::BadVersion(line_no))?;
            releases.push(ChangelogRelease {
                version,
                date,
                entries: Vec::new(),
            });
            kind = None;
            continue;
        }
        // Title and introduction, before the first version.
        let Some(release) = releases.last_mut() else {
            continue;
        };
        if line.is_empty() {
            continue;
        }
        if let Some(heading) = line.strip_prefix("### ") {
            let heading = heading.trim();
            kind = Some(
                section_kind(heading)
                    .ok_or_else(|| ParseError::UnknownSection(line_no, heading.to_owned()))?,
            );
        } else if let Some(entry) = line.strip_prefix("- ") {
            let kind = kind.ok_or(ParseError::EntryOutsideSection(line_no))?;
            release.entries.push(ChangelogEntry {
                kind,
                text: entry.trim().to_owned(),
            });
        } else if line.starts_with("  ") {
            let entry = release
                .entries
                .last_mut()
                .ok_or(ParseError::UnexpectedLine(line_no))?;
            entry.text.push(' ');
            entry.text.push_str(line.trim());
        } else if line.starts_with('[') && line.contains("]: ") {
            // Link reference definition (`[0.3.0]: https://…`).
        } else {
            return Err(ParseError::UnexpectedLine(line_no));
        }
    }

    for entry in releases.iter_mut().flat_map(|release| &mut release.entries) {
        entry.text = strip_links(&entry.text);
    }
    releases.retain(|release| release.version.is_some() || !release.entries.is_empty());
    Ok(releases)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
# Changelog

Intro text, [with a link](https://example.com).

## [Unreleased]

### Added

- Something new, continued
  on the next line (#22).

### Fixed

- A [linked](https://example.com/x) fix with `code`.

## [0.2.0] - 2026-10-14

### Changed

- Moved things.

### Security

- Patched.

[0.2.0]: https://github.com/SimonVanMello/yaggui/releases/tag/v0.2.0
";

    fn entry(kind: ChangeKind, text: &str) -> ChangelogEntry {
        ChangelogEntry {
            kind,
            text: text.to_owned(),
        }
    }

    #[test]
    fn parses_versions_sections_and_entries() {
        let releases = parse(SAMPLE).unwrap();
        assert_eq!(
            releases,
            vec![
                ChangelogRelease {
                    version: None,
                    date: None,
                    entries: vec![
                        entry(
                            ChangeKind::Feature,
                            "Something new, continued on the next line (#22)."
                        ),
                        entry(ChangeKind::Fix, "A linked fix with `code`."),
                    ],
                },
                ChangelogRelease {
                    version: Some("0.2.0".to_owned()),
                    date: Some("2026-10-14".to_owned()),
                    entries: vec![
                        entry(ChangeKind::Other, "Moved things."),
                        entry(ChangeKind::Fix, "Patched."),
                    ],
                },
            ]
        );
    }

    #[test]
    fn leaves_out_an_empty_unreleased_section() {
        let releases =
            parse("## [Unreleased]\n\n## [0.1.0] - 2026-10-14\n\n### Added\n\n- First.\n").unwrap();
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].version.as_deref(), Some("0.1.0"));
    }

    #[test]
    fn rejects_malformed_files() {
        assert_eq!(
            parse("## 0.1.0\n"),
            Err(ParseError::BadVersion(1)),
            "brackets required"
        );
        assert_eq!(
            parse("## [0.1.0]\n"),
            Err(ParseError::BadVersion(1)),
            "date required"
        );
        assert_eq!(
            parse("## [0.1.0] - 14/10/2026\n"),
            Err(ParseError::BadVersion(1))
        );
        assert_eq!(
            parse("## [0.1.0-beta] - 2026-10-14\n"),
            Err(ParseError::BadVersion(1))
        );
        assert_eq!(
            parse("## [Unreleased]\n### Improved\n"),
            Err(ParseError::UnknownSection(2, "Improved".to_owned()))
        );
        assert_eq!(
            parse("## [Unreleased]\n- Orphan\n"),
            Err(ParseError::EntryOutsideSection(2))
        );
        assert_eq!(
            parse("## [Unreleased]\n### Added\nLoose text\n"),
            Err(ParseError::UnexpectedLine(3))
        );
    }

    #[test]
    fn strips_links_only() {
        assert_eq!(strip_links("see [docs](https://x.y) now"), "see docs now");
        assert_eq!(strip_links("an [unclosed bracket"), "an [unclosed bracket");
        assert_eq!(strip_links("[a](b) and [c](d)"), "a and c");
    }

    fn version_key(version: &str) -> Vec<u64> {
        version
            .split('.')
            .filter_map(|part| part.parse().ok())
            .collect()
    }

    #[test]
    fn embedded_changelog_parses_newest_first_with_this_version() {
        let releases = parse(CHANGELOG).unwrap();
        let versions: Vec<&str> = releases
            .iter()
            .filter_map(|release| release.version.as_deref())
            .collect();
        assert!(
            versions.contains(&env!("CARGO_PKG_VERSION")),
            "CHANGELOG.md has no section for {}: run `pnpm release:version`",
            env!("CARGO_PKG_VERSION")
        );
        assert!(
            versions
                .windows(2)
                .all(|pair| version_key(pair[0]) > version_key(pair[1])),
            "versions must be listed newest first: {versions:?}"
        );
        assert!(
            releases
                .iter()
                .skip(1)
                .all(|release| release.version.is_some()),
            "Unreleased must come first"
        );
    }
}
