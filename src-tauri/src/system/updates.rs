//! Update check and install (SPEC §10). Opt-in: the frontend only checks when the user turned
//! the check on, or asked for it.
//!
//! The check reads `latest.json`, the update manifest attached to the newest published GitHub
//! release (written by `scripts/updater-manifest.mjs`). What the app offers next depends on how
//! it was installed: the Tauri updater only replaces what a release installer put on disk
//! (Windows installers, the macOS app, the AppImage). A copy owned by a package manager
//! (Homebrew, the AUR, a `.deb` or `.rpm`) is upgraded by that package manager, or it would
//! no longer know which version is installed.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;

use crate::git::errors::YagguiError;
use crate::system::editor;
use crate::system::terminal::Os;

/// Manifest of the newest published release. Drafts and pre-releases are never `latest`.
pub const MANIFEST_URL: &str =
    "https://github.com/SimonVanMello/yaggui/releases/latest/download/latest.json";
/// Page of the newest published release, for the installs that are upgraded by hand.
pub const RELEASE_PAGE_URL: &str = "https://github.com/SimonVanMello/yaggui/releases/latest";

/// The manifest is a few KB; anything bigger is not what we asked for.
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);

/// Where the Homebrew cask is recorded, for the Apple Silicon and Intel prefixes.
const HOMEBREW_CASKS: [&str; 2] = [
    "/opt/homebrew/Caskroom/yaggui",
    "/usr/local/Caskroom/yaggui",
];
/// pacman's database of installed packages: one `<name>-<version>` folder each.
const PACMAN_LOCAL: &str = "/var/lib/pacman/local";
const AUR_PACKAGE_PREFIX: &str = "yaggui-bin-";

/// How the running copy was installed, which decides how it is updated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum InstallChannel {
    /// A release installer the updater can replace: Windows installer, macOS app, AppImage.
    SelfUpdate,
    /// The Homebrew cask: `brew update && brew upgrade --cask yaggui`.
    Homebrew,
    /// The `yaggui-bin` AUR package, upgraded with the user's AUR helper.
    Aur,
    /// A `.deb` / `.rpm`, a development build or an unknown layout: the user downloads the
    /// new version from the release page.
    Manual,
}

/// A newer published version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub version: String,
    /// Release notes of the manifest (Markdown), if any.
    pub notes: Option<String>,
    /// Publication date (RFC 3339), if any.
    pub date: Option<String>,
    pub channel: InstallChannel,
}

/// What the channel detection looks at, gathered apart so that the decision can be tested.
#[derive(Debug, Clone, Default)]
struct Facts {
    bundle: Option<BundleType>,
    /// Built without optimizations (`tauri dev`): never replaced in place.
    debug: bool,
    /// The executable lives inside a `.app` bundle (not a bare binary from `cargo build`).
    in_app_bundle: bool,
    homebrew_cask: bool,
    aur_package: bool,
}

fn classify(facts: Facts) -> InstallChannel {
    if facts.debug {
        return InstallChannel::Manual;
    }
    match facts.bundle {
        Some(BundleType::Msi | BundleType::Nsis | BundleType::AppImage) => {
            InstallChannel::SelfUpdate
        }
        // `bundle_type` answers `App` for any macOS binary: only a real bundle is replaced.
        Some(BundleType::App | BundleType::Dmg) if facts.homebrew_cask => InstallChannel::Homebrew,
        Some(BundleType::App | BundleType::Dmg) if facts.in_app_bundle => {
            InstallChannel::SelfUpdate
        }
        // The AUR package repackages the `.deb`.
        Some(BundleType::Deb) if facts.aur_package => InstallChannel::Aur,
        _ => InstallChannel::Manual,
    }
}

/// How the running copy was installed.
pub fn install_channel() -> InstallChannel {
    let mut facts = Facts {
        bundle: bundle_type(),
        debug: cfg!(debug_assertions),
        ..Facts::default()
    };
    match facts.bundle {
        Some(BundleType::App | BundleType::Dmg) => {
            facts.homebrew_cask = HOMEBREW_CASKS.iter().any(|path| Path::new(path).is_dir());
            facts.in_app_bundle = std::env::current_exe()
                .is_ok_and(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS/"));
        }
        Some(BundleType::Deb) => facts.aur_package = has_pacman_package(AUR_PACKAGE_PREFIX),
        _ => {}
    }
    classify(facts)
}

fn has_pacman_package(prefix: &str) -> bool {
    std::fs::read_dir(PACMAN_LOCAL).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().starts_with(prefix))
    })
}

/// The fields of the Tauri update manifest the check needs.
#[derive(Debug, Deserialize)]
struct Manifest {
    version: String,
    notes: Option<String>,
    pub_date: Option<String>,
}

fn parse_version(text: &str) -> Option<semver::Version> {
    semver::Version::parse(text.trim().trim_start_matches('v')).ok()
}

/// The update described by `manifest`, `None` when it is not newer than `current`.
fn newer_release(
    manifest: &str,
    current: &str,
    channel: InstallChannel,
) -> Result<Option<UpdateInfo>, YagguiError> {
    let manifest: Manifest = serde_json::from_str(manifest)
        .map_err(|err| YagguiError::update_check_failed(format!("invalid manifest: {err}")))?;
    let latest = parse_version(&manifest.version).ok_or_else(|| {
        YagguiError::update_check_failed(format!("invalid version: {}", manifest.version))
    })?;
    let installed = parse_version(current)
        .ok_or_else(|| YagguiError::internal(format!("invalid app version: {current}")))?;
    if latest <= installed {
        return Ok(None);
    }
    Ok(Some(UpdateInfo {
        current_version: installed.to_string(),
        version: latest.to_string(),
        notes: manifest.notes.filter(|notes| !notes.trim().is_empty()),
        date: manifest.pub_date,
        channel,
    }))
}

/// Reads the manifest of the newest release. `None` when the installed version is the newest,
/// or when that release has no manifest (published before the updater existed).
pub fn check() -> Result<Option<UpdateInfo>, YagguiError> {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(CHECK_TIMEOUT))
        .https_only(true)
        .http_status_as_error(false)
        .user_agent(concat!("yaggui/", env!("CARGO_PKG_VERSION")))
        .build()
        .new_agent();
    let mut response = agent
        .get(MANIFEST_URL)
        .call()
        .map_err(|err| YagguiError::update_check_failed(err.to_string()))?;
    match response.status().as_u16() {
        200 => {}
        404 => return Ok(None),
        status => return Err(YagguiError::update_check_failed(format!("HTTP {status}"))),
    }
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_MANIFEST_BYTES)
        .read_to_string()
        .map_err(|err| YagguiError::update_check_failed(err.to_string()))?;
    newer_release(&body, env!("CARGO_PKG_VERSION"), install_channel())
}

/// Downloads, verifies and installs the newest release with the Tauri updater, then restarts
/// the app. Only for the [`InstallChannel::SelfUpdate`] installs.
pub async fn install(
    app: &tauri::AppHandle,
    mut on_progress: impl FnMut(Option<u8>) + Send,
) -> Result<(), YagguiError> {
    use tauri_plugin_updater::UpdaterExt;

    if install_channel() != InstallChannel::SelfUpdate {
        return Err(YagguiError::update_install_failed(
            "this copy is managed by a package manager",
        ));
    }
    let failed =
        |err: tauri_plugin_updater::Error| YagguiError::update_install_failed(err.to_string());
    let url = MANIFEST_URL
        .parse()
        .map_err(|err| YagguiError::internal(format!("manifest URL: {err}")))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(failed)?
        .build()
        .map_err(failed)?;
    let Some(update) = updater.check().await.map_err(failed)? else {
        return Err(YagguiError::update_install_failed(
            "no newer version in the manifest",
        ));
    };
    tracing::info!(version = %update.version, "installing update");
    let mut downloaded: u64 = 0;
    let mut last: Option<Option<u8>> = None;
    update
        .download_and_install(
            |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                let percent = total
                    .filter(|total| *total > 0)
                    .map(|total| u8::try_from(downloaded.min(total) * 100 / total).unwrap_or(100));
                if last != Some(percent) {
                    last = Some(percent);
                    on_progress(percent);
                }
            },
            || {},
        )
        .await
        .map_err(failed)?;
    tracing::info!("update installed, restarting");
    app.restart()
}

/// Opens the release page in the default browser.
pub fn open_release_page() -> Result<(), YagguiError> {
    let (program, args) = editor::command(Os::current(), Path::new(RELEASE_PAGE_URL), None);
    let name = program.to_string_lossy().into_owned();
    let child = Command::new(&program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| YagguiError::update_check_failed(format!("{name}: {err}")))?;
    editor::reap(child, &name, "yaggui-release-page");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(bundle: BundleType) -> Facts {
        Facts {
            bundle: Some(bundle),
            ..Facts::default()
        }
    }

    #[test]
    fn release_installers_update_themselves() {
        for bundle in [BundleType::Msi, BundleType::Nsis, BundleType::AppImage] {
            assert_eq!(classify(facts(bundle)), InstallChannel::SelfUpdate);
        }
        let app = Facts {
            in_app_bundle: true,
            ..facts(BundleType::App)
        };
        assert_eq!(classify(app), InstallChannel::SelfUpdate);
    }

    #[test]
    fn package_managers_keep_their_copies() {
        let cask = Facts {
            in_app_bundle: true,
            homebrew_cask: true,
            ..facts(BundleType::App)
        };
        assert_eq!(classify(cask), InstallChannel::Homebrew);
        let aur = Facts {
            aur_package: true,
            ..facts(BundleType::Deb)
        };
        assert_eq!(classify(aur), InstallChannel::Aur);
        assert_eq!(classify(facts(BundleType::Deb)), InstallChannel::Manual);
        assert_eq!(classify(facts(BundleType::Rpm)), InstallChannel::Manual);
    }

    #[test]
    fn development_and_bare_builds_are_never_replaced() {
        let dev = Facts {
            debug: true,
            ..facts(BundleType::Nsis)
        };
        assert_eq!(classify(dev), InstallChannel::Manual);
        // `cargo build` on macOS: `bundle_type` says `App`, but there is no bundle.
        assert_eq!(classify(facts(BundleType::App)), InstallChannel::Manual);
        assert_eq!(classify(Facts::default()), InstallChannel::Manual);
    }

    const MANIFEST: &str = r#"{
        "version": "0.2.0",
        "notes": "Faster graph",
        "pub_date": "2026-10-20T10:00:00Z",
        "platforms": {}
    }"#;

    #[test]
    fn a_newer_manifest_is_an_update() {
        let update = newer_release(MANIFEST, "0.1.0", InstallChannel::Homebrew)
            .unwrap()
            .unwrap();
        assert_eq!(
            update,
            UpdateInfo {
                current_version: "0.1.0".into(),
                version: "0.2.0".into(),
                notes: Some("Faster graph".into()),
                date: Some("2026-10-20T10:00:00Z".into()),
                channel: InstallChannel::Homebrew,
            }
        );
    }

    #[test]
    fn the_same_or_an_older_version_is_not_an_update() {
        for current in ["0.2.0", "0.10.0", "1.0.0"] {
            assert_eq!(
                newer_release(MANIFEST, current, InstallChannel::Manual).unwrap(),
                None,
                "{current}"
            );
        }
    }

    #[test]
    fn versions_compare_as_semver_and_accept_a_v_prefix() {
        let manifest = r#"{ "version": "v0.10.0", "notes": "  " }"#;
        let update = newer_release(manifest, "0.9.3", InstallChannel::Manual)
            .unwrap()
            .unwrap();
        assert_eq!(update.version, "0.10.0");
        assert_eq!(update.notes, None);
    }

    #[test]
    fn a_broken_manifest_is_a_typed_error() {
        for manifest in ["<html>", r#"{ "version": "latest" }"#] {
            let err = newer_release(manifest, "0.1.0", InstallChannel::Manual).unwrap_err();
            assert_eq!(err.code, crate::git::errors::ErrorCode::UpdateCheckFailed);
        }
    }
}
