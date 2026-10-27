//! The excluded paths of the AI context (F-075): `*`, `?` and `**`, gitignore-like.

/// `true` when `path` (repository-relative, `/`-separated) matches `pattern`. A pattern
/// without `/` matches the file name at any depth (`*.lock`); otherwise it is matched against
/// the whole path from the root (`vendor/**`, `/docs/*.md`), `**` spanning folders. A pattern
/// ending with `/` matches everything under that folder.
pub fn matches(pattern: &str, path: &str) -> bool {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return false;
    }
    if let Some(dir) = pattern.strip_suffix('/') {
        let dir = dir.trim_start_matches('/');
        return matches(&format!("{dir}/**"), path)
            || (!dir.contains('/') && path.split('/').rev().skip(1).any(|d| glob(dir, d)));
    }
    if pattern.contains('/') {
        return path_glob(pattern.trim_start_matches('/'), path);
    }
    let name = path.rsplit('/').next().unwrap_or(path);
    glob(pattern, name)
}

/// Matches segment by segment; `**` matches any number of segments.
fn path_glob(pattern: &str, path: &str) -> bool {
    let pattern: Vec<&str> = pattern.split('/').collect();
    let path: Vec<&str> = path.split('/').collect();
    segments(&pattern, &path)
}

fn segments(pattern: &[&str], path: &[&str]) -> bool {
    match pattern.split_first() {
        None => path.is_empty(),
        Some((&"**", rest)) => (0..=path.len()).any(|skip| segments(rest, &path[skip..])),
        Some((first, rest)) => match path.split_first() {
            Some((segment, path_rest)) => glob(first, segment) && segments(rest, path_rest),
            None => false,
        },
    }
}

/// `*` and `?` within one name (they never match `/`).
fn glob(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    let (mut p, mut t) = (0, 0);
    // Position after the last `*` and the text position it was tried at: backtracking point.
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        match pattern.get(p) {
            Some('*') => {
                star = Some((p + 1, t));
                p += 1;
            }
            Some('?') => {
                p += 1;
                t += 1;
            }
            Some(c) if *c == text[t] => {
                p += 1;
                t += 1;
            }
            _ => match star {
                Some((after, tried)) => {
                    p = after;
                    t = tried + 1;
                    star = Some((after, tried + 1));
                }
                None => return false,
            },
        }
    }
    pattern[p..].iter().all(|c| *c == '*')
}

#[cfg(test)]
mod tests {
    use super::matches;

    #[test]
    fn names_match_at_any_depth() {
        assert!(matches("Cargo.lock", "Cargo.lock"));
        assert!(matches("Cargo.lock", "src-tauri/Cargo.lock"));
        assert!(matches("*.min.js", "web/dist/app.min.js"));
        assert!(!matches("*.min.js", "web/app.js"));
        assert!(matches("yarn.lock", "yarn.lock"));
        assert!(!matches("yarn.lock", "yarn.lock.bak"));
        assert!(matches("file?.txt", "a/file1.txt"));
    }

    #[test]
    fn paths_match_from_the_root() {
        assert!(matches("vendor/**", "vendor/a/b.c"));
        assert!(!matches("vendor/**", "src/vendor/a.c"));
        assert!(matches("**/generated/*.ts", "src/generated/api.ts"));
        assert!(matches("**/generated/*.ts", "generated/api.ts"));
        assert!(!matches("**/generated/*.ts", "generated/deep/api.ts"));
        assert!(matches("/docs/*.md", "docs/a.md"));
        assert!(!matches("docs/*.md", "docs/a/b.md"));
    }

    #[test]
    fn folders_match_their_content() {
        assert!(matches("dist/", "dist/app.js"));
        assert!(matches("dist/", "web/dist/app.js"));
        assert!(!matches("dist/", "distribution/app.js"));
        assert!(matches("web/dist/", "web/dist/a/b.js"));
        assert!(!matches("web/dist/", "dist/a.js"));
    }

    #[test]
    fn stars_backtrack() {
        assert!(matches("a*b*c", "aXbYbZc"));
        assert!(!matches("a*b*c", "aXbYbZ"));
        assert!(matches("*", "anything"));
        assert!(!matches("", "x"));
    }
}
