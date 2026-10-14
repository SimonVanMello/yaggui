//! Git LFS without the `git lfs` binary (F-262): which paths are tracked (`filter=lfs` in the
//! attributes), and the pointer files Git stores in their place.

use gix::bstr::{BStr, ByteSlice};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::errors::{BackendError, YagguiError};

/// Pointer files are small: the specification caps them at 1024 bytes.
pub const POINTER_MAX_BYTES: u64 = 1024;

const POINTER_VERSIONS: [&str; 2] = [
    "https://git-lfs.github.com/spec/v1",
    // Pre-release name of the format, still accepted by git-lfs.
    "https://hawser.github.com/spec/v1",
];

/// One side of a file stored with LFS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LfsObject {
    /// `sha256:…` id of the content, `None` for a working tree file that is the content
    /// itself (not hashed: that would read the whole file).
    pub oid: Option<String>,
    /// Size of the content in bytes.
    pub size: f64,
}

/// Parses an LFS pointer (`version …`, `oid sha256:…`, `size …`); `None` for anything else.
pub fn parse_pointer(data: &[u8]) -> Option<LfsObject> {
    if data.len() as u64 > POINTER_MAX_BYTES {
        return None;
    }
    let text = std::str::from_utf8(data).ok()?;
    let mut lines = text.lines();
    let version = lines.next()?.strip_prefix("version ")?;
    if !POINTER_VERSIONS.contains(&version) {
        return None;
    }
    let (mut oid, mut size) = (None, None);
    for line in lines {
        if let Some(value) = line.strip_prefix("oid ") {
            let hex = value.strip_prefix("sha256:")?;
            if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            oid = Some(value.to_owned());
        } else if let Some(value) = line.strip_prefix("size ") {
            size = Some(value.parse::<u64>().ok()?);
        }
    }
    #[allow(clippy::cast_precision_loss)] // Shown rounded; exact up to 2^53 bytes.
    Some(LfsObject {
        oid: Some(oid?),
        size: size? as f64,
    })
}

/// Whether some attributes file could route a path to the LFS filter: the `.gitattributes`
/// of the index or of the working tree root, and `info/attributes`. Cheap, so callers skip
/// the attribute lookups of repositories that do not use LFS.
pub fn may_use_lfs(repo: &gix::Repository, index: &gix::index::State) -> bool {
    let mentions_lfs = |data: &[u8]| data.find(b"lfs").is_some();
    let in_index = index.entries().iter().any(|entry| {
        let path = entry.path(index);
        (path == ".gitattributes" || path.ends_with(b"/.gitattributes"))
            && repo
                .find_blob(entry.id)
                .is_ok_and(|blob| mentions_lfs(&blob.data))
    });
    let on_disk = |path: std::path::PathBuf| std::fs::read(path).is_ok_and(|d| mentions_lfs(&d));
    in_index
        || repo
            .workdir()
            .is_some_and(|root| on_disk(root.join(".gitattributes")))
        || on_disk(repo.common_dir().join("info").join("attributes"))
}

/// Answers "is this path stored with LFS?" from the attributes (`filter=lfs`), as Git does:
/// working tree `.gitattributes` first, then the index.
pub struct LfsMatcher<'r> {
    stack: gix::AttributeStack<'r>,
    outcome: gix::attrs::search::Outcome,
}

impl<'r> LfsMatcher<'r> {
    /// `None` when no attributes file mentions LFS (see [`may_use_lfs`]).
    pub fn new(repo: &'r gix::Repository) -> Result<Option<Self>, YagguiError> {
        let index = repo
            .index_or_empty()
            .map_err(|e| BackendError::gix("read index", e))?;
        if !may_use_lfs(repo, &index) {
            return Ok(None);
        }
        let stack = repo
            .attributes_only(
                &index,
                gix::worktree::stack::state::attributes::Source::WorktreeThenIdMapping,
            )
            .map_err(|e| BackendError::gix("read the attributes", e))?;
        let outcome = stack.selected_attribute_matches(["filter"]);
        Ok(Some(Self { stack, outcome }))
    }

    pub fn is_lfs(&mut self, path: &BStr) -> bool {
        let Ok(platform) = self.stack.at_entry(path, None) else {
            return false;
        };
        if !platform.matching_attributes(&mut self.outcome) {
            return false;
        }
        self.outcome.iter_selected().any(|m| {
            matches!(m.assignment.state, gix::attrs::StateRef::Value(value) if value.as_bstr() == "lfs")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OID: &str = "sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393";

    #[test]
    fn parses_pointers() {
        let pointer =
            format!("version https://git-lfs.github.com/spec/v1\noid {OID}\nsize 12345\n");
        assert_eq!(
            parse_pointer(pointer.as_bytes()),
            Some(LfsObject {
                oid: Some(OID.to_owned()),
                size: 12345.0
            })
        );
        // Extension lines are allowed between the version and the oid.
        let extended = format!(
            "version https://git-lfs.github.com/spec/v1\next-0-foo sha256:{}\noid {OID}\nsize 1\n",
            "0".repeat(64)
        );
        assert!(parse_pointer(extended.as_bytes()).is_some());
    }

    #[test]
    fn refuses_other_content() {
        assert_eq!(parse_pointer(b"hello\n"), None);
        assert_eq!(parse_pointer(b""), None);
        let no_size = format!("version https://git-lfs.github.com/spec/v1\noid {OID}\n");
        assert_eq!(parse_pointer(no_size.as_bytes()), None);
        let bad_oid = "version https://git-lfs.github.com/spec/v1\noid sha256:xyz\nsize 3\n";
        assert_eq!(parse_pointer(bad_oid.as_bytes()), None);
        let long = format!(
            "version https://git-lfs.github.com/spec/v1\noid {OID}\nsize 3\n{}",
            "x".repeat(1100)
        );
        assert_eq!(parse_pointer(long.as_bytes()), None);
    }
}
