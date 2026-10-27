//! Which local tags a remote holds (opt-in `remoteTags` preference): Git keeps no local record
//! of the tags of a remote, so they are listed with `git ls-remote --tags --refs` and compared
//! with the local tags by the object they point to.

use std::collections::{BTreeMap, HashMap};

use gix::ObjectId;
use serde::{Deserialize, Serialize};
use specta::Type;

use super::state::gix;
use crate::git::errors::YagguiError;

/// A local tag found, at the same object, on at least one remote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTag {
    /// Short name: `v1.2.0`.
    pub name: String,
    /// Remotes holding it, sorted.
    pub remotes: Vec<String>,
}

/// Tags of one remote, by short name → object (the tag object for an annotated tag).
pub type TagTargets = HashMap<String, ObjectId>;

/// Parses `git ls-remote --tags --refs` (`<oid>\trefs/tags/<name>` per line).
pub fn parse_ls_remote(stdout: &str) -> TagTargets {
    stdout
        .lines()
        .filter_map(|line| {
            let (oid, name) = line.split_once('\t')?;
            let name = name.strip_prefix("refs/tags/")?;
            // `--refs` leaves out the peeled `^{}` lines; older servers may still send them.
            if name.ends_with("^{}") {
                return None;
            }
            Some((name.to_owned(), ObjectId::from_hex(oid.as_bytes()).ok()?))
        })
        .collect()
}

/// Local tags, by short name → the object the ref points to (not peeled, like `ls-remote`).
pub fn local_tags(repo: &gix::Repository) -> Result<TagTargets, YagguiError> {
    let platform = repo.references().map_err(gix("list tags"))?;
    let mut tags = TagTargets::new();
    for reference in platform.tags().map_err(gix("list tags"))? {
        let Ok(reference) = reference else { continue };
        let Some(id) = reference.target().try_id().map(ToOwned::to_owned) else {
            continue;
        };
        tags.insert(reference.name().shorten().to_string(), id);
    }
    Ok(tags)
}

/// Local tags present on remotes at the same object, sorted by name. A remote tag of the same
/// name on another object does not count: pushing the local one would be refused.
pub fn matching(local: &TagTargets, remotes: &BTreeMap<String, TagTargets>) -> Vec<RemoteTag> {
    let mut found: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for (remote, tags) in remotes {
        for (name, id) in tags {
            if local.get(name) == Some(id) {
                found.entry(name).or_default().push(remote.clone());
            }
        }
    }
    found
        .into_iter()
        .map(|(name, remotes)| RemoteTag {
            name: name.to_owned(),
            remotes,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "1111111111111111111111111111111111111111";
    const B: &str = "2222222222222222222222222222222222222222";

    fn id(hex: &str) -> ObjectId {
        ObjectId::from_hex(hex.as_bytes()).unwrap()
    }

    #[test]
    fn parses_ls_remote_output() {
        let out = format!(
            "{A}\trefs/tags/v1.0\n{B}\trefs/tags/v1.0^{{}}\n{B}\trefs/tags/release/2\n{A}\trefs/heads/main\nnot a line\n"
        );
        let tags = parse_ls_remote(&out);
        assert_eq!(tags.len(), 2);
        assert_eq!(tags["v1.0"], id(A));
        assert_eq!(tags["release/2"], id(B));
    }

    #[test]
    fn matches_by_name_and_object() {
        let local = TagTargets::from([
            ("v1".to_owned(), id(A)),
            ("v2".to_owned(), id(A)),
            ("only-local".to_owned(), id(B)),
        ]);
        let remotes = BTreeMap::from([
            (
                "origin".to_owned(),
                TagTargets::from([
                    ("v1".to_owned(), id(A)),
                    // Same name, another object: not this tag.
                    ("v2".to_owned(), id(B)),
                    ("only-remote".to_owned(), id(A)),
                ]),
            ),
            (
                "mirror".to_owned(),
                TagTargets::from([("v1".to_owned(), id(A)), ("v2".to_owned(), id(A))]),
            ),
        ]);
        assert_eq!(
            matching(&local, &remotes),
            vec![
                RemoteTag {
                    name: "v1".into(),
                    remotes: vec!["mirror".into(), "origin".into()],
                },
                RemoteTag {
                    name: "v2".into(),
                    remotes: vec!["mirror".into()],
                },
            ]
        );
    }
}
