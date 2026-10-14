//! Canonical paths that every tool accepts.

use std::path::{Path, PathBuf};

/// `fs::canonicalize`, falling back to `path` when it does not resolve. On Windows the
/// result loses the `\\?\` prefix `canonicalize` adds: Git and most tools reject it (`git
/// clone`, `worktree add`, `hash-object` fail with "Invalid argument"), and it is not what
/// the user typed.
pub fn canonical(path: &Path) -> PathBuf {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if cfg!(windows) {
        strip_verbatim(resolved)
    } else {
        resolved
    }
}

/// `\\?\C:\a` → `C:\a`, `\\?\UNC\server\share` → `\\server\share`; anything else as is.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path;
    };
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(disk) if disk.as_bytes().get(1) == Some(&b':') => PathBuf::from(disk),
        _ => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_prefixes_are_removed() {
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\C:\Users\me\repo")),
            PathBuf::from(r"C:\Users\me\repo")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\UNC\server\share\repo")),
            PathBuf::from(r"\\server\share\repo")
        );
        // Device and volume GUID paths have no plain form.
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\Volume{1234}\repo")),
            PathBuf::from(r"\\?\Volume{1234}\repo")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from("/home/me/repo")),
            PathBuf::from("/home/me/repo")
        );
    }
}
