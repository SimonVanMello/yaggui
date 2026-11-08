//! Links to the user documentation on the website (`website/`).

use crate::git::errors::YagguiError;
use crate::store::Locale;
use crate::system::editor;

/// The website: `/docs/` in English, `/fr/docs/` in French, latest released version.
pub const DOCS_SITE: &str = "https://yaggui.tropico.dev";

/// Address of a docs page: `page` is its path under `/docs/` (`start-here/install`), with an
/// optional `#anchor`; empty for the docs home. Only lowercase words, digits, `-` and `/` are
/// accepted: the address goes to the system opener.
pub fn docs_url(page: &str, locale: Locale) -> Result<String, YagguiError> {
    let (path, anchor) = page.split_once('#').unwrap_or((page, ""));
    let path = path.trim_matches('/');
    let word = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-';
    let valid = path.is_empty()
        || path
            .split('/')
            .all(|part| !part.is_empty() && part.chars().all(word));
    if !valid || !anchor.chars().all(word) {
        return Err(YagguiError::internal(format!("not a docs page: {page}")));
    }
    let prefix = match locale {
        Locale::En => "",
        Locale::Fr => "/fr",
    };
    let mut url = format!("{DOCS_SITE}{prefix}/docs/");
    if !path.is_empty() {
        url.push_str(path);
        url.push('/');
    }
    if !anchor.is_empty() {
        url.push('#');
        url.push_str(anchor);
    }
    Ok(url)
}

/// Opens a docs page in the default browser without waiting for it.
pub fn open(page: &str, locale: Locale) -> Result<(), YagguiError> {
    editor::open_url(&docs_url(page, locale)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_address_of_each_locale() {
        assert_eq!(
            docs_url("", Locale::En).unwrap(),
            "https://yaggui.tropico.dev/docs/"
        );
        assert_eq!(
            docs_url("start-here/install", Locale::Fr).unwrap(),
            "https://yaggui.tropico.dev/fr/docs/start-here/install/"
        );
        assert_eq!(
            docs_url("/start-here/install/#requirements", Locale::En).unwrap(),
            "https://yaggui.tropico.dev/docs/start-here/install/#requirements"
        );
    }

    #[test]
    fn refuses_anything_but_a_docs_path() {
        for page in [
            "../etc",
            "start-here//install",
            "https://example.com",
            "Start-Here",
            "a b",
            "install#a b",
            "install?x=1",
        ] {
            assert!(
                docs_url(page, Locale::En).is_err(),
                "{page} must be refused"
            );
        }
    }
}
