//! Masks credentials embedded in URLs, for everything the user can see (command log, error
//! details, remote lists). The arguments actually passed to Git are never touched.

use std::borrow::Cow;

const MASK: &str = "***";

/// Replaces the secret of every `scheme://userinfo@host` in `text`: `user:secret` becomes
/// `user:***`, a token-only `secret` becomes `***`. SSH URLs without a password
/// (`ssh://git@host/…`) carry a user name, not a secret, and scp-like addresses
/// (`git@host:org/repo`) have no `scheme://`: both are left as they are.
pub fn redact_urls(text: &str) -> Cow<'_, str> {
    if !text.contains("://") {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let (head, tail) = rest.split_at(at + 3);
        out.push_str(head);
        let end = tail.find(ends_authority).unwrap_or(tail.len());
        let (authority, after) = tail.split_at(end);
        match authority.rsplit_once('@') {
            Some((userinfo, host)) => {
                out.push_str(&mask_userinfo(userinfo, scheme_before(&head[..at])));
                out.push('@');
                out.push_str(host);
            }
            None => out.push_str(authority),
        }
        rest = after;
    }
    out.push_str(rest);
    if out == text {
        Cow::Borrowed(text)
    } else {
        Cow::Owned(out)
    }
}

/// Characters that cannot be part of a URL authority (a literal `?` or `#` in a password
/// would be read by Git as the start of the query or fragment too).
fn ends_authority(c: char) -> bool {
    c.is_whitespace() || matches!(c, '/' | '\\' | '?' | '#' | '\'' | '"' | '<' | '>' | '`')
}

fn scheme_before(prefix: &str) -> &str {
    let start = prefix
        .rfind(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')))
        .map_or(0, |i| i + 1);
    &prefix[start..]
}

fn mask_userinfo(userinfo: &str, scheme: &str) -> String {
    match userinfo.split_once(':') {
        Some((user, _)) => format!("{user}:{MASK}"),
        None if is_ssh(scheme) => userinfo.to_owned(),
        None => MASK.to_owned(),
    }
}

fn is_ssh(scheme: &str) -> bool {
    let scheme = scheme.to_ascii_lowercase();
    scheme == "ssh" || scheme == "git+ssh" || scheme == "ssh+git"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(text: &str) -> String {
        redact_urls(text).into_owned()
    }

    #[test]
    fn masks_password_of_http_urls() {
        assert_eq!(
            r("https://user:s3cret@github.com/org/repo.git"),
            "https://user:***@github.com/org/repo.git"
        );
        assert_eq!(
            r("http://user:s3cret@host:8080/r.git"),
            "http://user:***@host:8080/r.git"
        );
        assert_eq!(r("https://:tok@host/r.git"), "https://:***@host/r.git");
    }

    #[test]
    fn masks_token_only_userinfo() {
        assert_eq!(
            r("https://ghp_abc123@github.com/org/repo.git"),
            "https://***@github.com/org/repo.git"
        );
    }

    #[test]
    fn leaves_urls_without_secret_untouched() {
        for url in [
            "git@github.com:org/repo.git",
            "ssh://git@github.com/org/repo.git",
            "ssh://git@github.com:22/org/repo.git",
            "https://github.com/org/repo.git",
            "file:///srv/git/repo.git",
            "/srv/git/repo.git",
            "git://host/repo.git",
            "https://host/path/with@sign",
            "https://host?mail=a@b.c",
            "https://host/r.git#frag@x",
            "fatal: unable to access 'https://github.com/org/repo.git/': Could not resolve host",
        ] {
            assert!(matches!(redact_urls(url), Cow::Borrowed(_)), "{url}");
        }
    }

    #[test]
    fn masks_password_of_ssh_urls() {
        assert_eq!(r("ssh://git:pw@host/r.git"), "ssh://git:***@host/r.git");
    }

    #[test]
    fn masks_every_url_of_a_line_or_output() {
        assert_eq!(
            r(
                "fatal: unable to access 'https://u:p1@a.com/x.git/': 401\nfrom https://tok@b.com/y.git to ssh://git@c.com/z.git\r\nhttp://u2:p2@d.com"
            ),
            "fatal: unable to access 'https://u:***@a.com/x.git/': 401\nfrom https://***@b.com/y.git to ssh://git@c.com/z.git\r\nhttp://u2:***@d.com"
        );
    }

    #[test]
    fn masks_percent_encoded_and_special_secrets() {
        assert_eq!(
            r("https://me%40mail.com:p%40ss%2Fw%3Ard@host/r.git"),
            "https://me%40mail.com:***@host/r.git"
        );
        // A raw `@` in the password: the last one separates the host.
        assert_eq!(r("https://u:p@ss@host/r.git"), "https://u:***@host/r.git");
        assert_eq!(r("https://u:@host/r.git"), "https://u:***@host/r.git");
    }

    #[test]
    fn masks_urls_inside_config_arguments() {
        assert_eq!(
            r("remote.origin.url=https://u:p@h/r.git"),
            "remote.origin.url=https://u:***@h/r.git"
        );
        assert_eq!(
            r("url.https://tok@h/.insteadOf=x"),
            "url.https://***@h/.insteadOf=x"
        );
    }

    #[test]
    fn is_idempotent() {
        for url in ["https://u:***@h/r.git", "https://***@h/r.git"] {
            assert!(matches!(redact_urls(url), Cow::Borrowed(_)), "{url}");
        }
    }

    #[test]
    fn keeps_non_ascii_text() {
        assert_eq!(
            r("échec: https://é:ü@hôte/dépôt.git — fin"),
            "échec: https://é:***@hôte/dépôt.git — fin"
        );
    }
}
