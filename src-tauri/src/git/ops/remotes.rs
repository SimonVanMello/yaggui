//! Types and pure helpers of the remote and tag operations (M4-7c): name and URL checks,
//! `git push --porcelain` parsing.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::errors::YagguiError;
use crate::git::ops::types::DeletedRef;

/// What removing a remote takes away, for its confirmation. Read-only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRemovalPreview {
    /// Remote-tracking branches deleted with it (`origin/main`), sorted.
    pub tracking: Vec<String>,
    /// Local branches whose upstream is on this remote: they lose their upstream.
    pub upstream_of: Vec<String>,
}

/// A removed remote, with what is needed to add it back (undo).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemovedRemote {
    pub name: String,
    pub url: Option<String>,
    pub push_url: Option<String>,
    /// Its remote-tracking refs and where they pointed.
    pub tracking: Vec<DeletedRef>,
}

/// Outcome of a tag push.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TagPushResult {
    /// Tags created or moved on the remote by this push, sorted.
    pub pushed: Vec<String>,
    /// Tags already there, unchanged.
    pub up_to_date: u32,
}

/// The rules Git applies to a remote name (`refs/remotes/<name>/test` must be a valid ref),
/// checked in process; the operation also asks `git check-ref-format`.
pub fn check_remote_name(name: &str) -> Result<(), YagguiError> {
    let refused = name.is_empty()
        || name.starts_with('-')
        || name.contains("@{")
        || name.chars().any(char::is_whitespace)
        || gix::validate::reference::name(format!("refs/remotes/{name}/test").as_str().into())
            .is_err();
    if refused {
        Err(YagguiError::invalid_remote_name(name))
    } else {
        Ok(())
    }
}

/// A trimmed remote URL. Refused: empty, starting with `-` (it would be read as an option by
/// the transport), or holding control characters (a newline would break the config file).
pub fn check_remote_url(url: &str) -> Result<String, YagguiError> {
    let url = url.trim();
    if url.is_empty() {
        return Err(YagguiError::invalid_argument(
            "The remote URL is empty.",
            "L'URL du remote est vide.",
        ));
    }
    if url.starts_with('-') || url.chars().any(char::is_control) {
        return Err(YagguiError::invalid_argument(
            format!("\"{}\" is not a valid remote URL.", url.escape_default()),
            format!(
                "« {} » n'est pas une URL de remote valide.",
                url.escape_default()
            ),
        ));
    }
    Ok(url.to_owned())
}

/// One ref line of `git push --porcelain`: `<flag>\t<from>:<to>\t<summary>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushedRef {
    pub flag: char,
    /// Destination ref (`refs/tags/v1`).
    pub to: String,
    pub summary: String,
}

pub fn parse_porcelain(stdout: &str) -> Vec<PushedRef> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let flag = fields.next()?.chars().next()?;
            let refs = fields.next()?;
            let summary = fields.next().unwrap_or_default();
            let to = refs.rsplit_once(':').map_or(refs, |(_, to)| to);
            Some(PushedRef {
                flag,
                to: to.to_owned(),
                summary: summary.to_owned(),
            })
        })
        .collect()
}

/// Tag name of a `refs/tags/…` destination.
pub fn tag_of(full: &str) -> Option<&str> {
    full.strip_prefix("refs/tags/")
}

/// The tags a failed push refused, as a catalog error; `None` when no tag was refused.
pub fn tag_rejection(refs: &[PushedRef]) -> Option<YagguiError> {
    let rejected: Vec<&PushedRef> = refs
        .iter()
        .filter(|r| r.flag == '!' && tag_of(&r.to).is_some())
        .collect();
    if rejected.is_empty() {
        return None;
    }
    let mut names: Vec<String> = rejected
        .iter()
        .filter_map(|r| tag_of(&r.to).map(str::to_owned))
        .collect();
    names.sort();
    let exists = rejected
        .iter()
        .all(|r| r.summary.contains("already exists") || r.summary.contains("fetch first"));
    Some(YagguiError::tag_rejected(&names, exists))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::errors::ErrorCode;

    #[test]
    fn checks_remote_names() {
        for valid in ["origin", "upstream", "my-fork", "team/mirror", "a.b"] {
            assert!(check_remote_name(valid).is_ok(), "{valid}");
        }
        for invalid in [
            "", "-x", "a b", "a..b", "a:b", "a~b", "a^b", "a?b", "a*b", "a[b", "@{u}", "a\\b",
        ] {
            assert_eq!(
                check_remote_name(invalid).unwrap_err().code,
                ErrorCode::InvalidRemoteName,
                "{invalid}"
            );
        }
    }

    #[test]
    fn checks_remote_urls() {
        assert_eq!(
            check_remote_url("  git@github.com:a/b.git \n").unwrap(),
            "git@github.com:a/b.git"
        );
        assert!(check_remote_url("/srv/git/repo.git").is_ok());
        for invalid in ["", "  ", "--upload-pack=touch x", "https://a\nb", "a\u{0}b"] {
            assert_eq!(
                check_remote_url(invalid).unwrap_err().code,
                ErrorCode::InvalidArgument,
                "{invalid:?}"
            );
        }
    }

    #[test]
    fn reads_tag_rejections_from_porcelain_output() {
        let stdout = "To file:///r.git\n*\trefs/tags/v2:refs/tags/v2\t[new tag]\n!\trefs/tags/v1:refs/tags/v1\t[rejected] (already exists)\n=\trefs/tags/v0:refs/tags/v0\t[up to date]\nDone\n";
        let refs = parse_porcelain(stdout);
        assert_eq!(refs.len(), 3);
        assert_eq!(refs[0].flag, '*');
        assert_eq!(refs[0].to, "refs/tags/v2");
        let error = tag_rejection(&refs).unwrap();
        assert_eq!(error.code, ErrorCode::TagRejected);
        assert!(error.message.en.contains("v1") && !error.message.en.contains("v2"));
        assert!(error.message.fr.contains("existe déjà"));

        let hook =
            parse_porcelain("!\trefs/tags/v3:refs/tags/v3\t[remote rejected] (hook declined)\n");
        assert!(tag_rejection(&hook).unwrap().message.en.contains("hook"));
        assert!(
            tag_rejection(&parse_porcelain(
                "*\trefs/tags/v2:refs/tags/v2\t[new tag]\n"
            ))
            .is_none()
        );
    }
}
