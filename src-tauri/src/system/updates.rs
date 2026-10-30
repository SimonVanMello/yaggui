//! Update check and install (SPEC §10). Opt-in: the frontend only checks when the user turned
//! the check on, or asked for it.
//!
//! The check reads `latest.json`, the update manifest attached to the newest published GitHub
//! release (written by `scripts/updater-manifest.mjs`). How the update is installed depends on
//! how the app was:
//!
//! - the Tauri updater replaces what a release installer put on disk (Windows installers, the
//!   macOS app, the AppImage), and the Homebrew cask, which declares `auto_updates`;
//! - a copy owned by a Linux package manager (the AUR, a `.deb` or `.rpm`) is upgraded by that
//!   package manager, or it would no longer know which version is installed. The app runs it
//!   in an integrated terminal, where the user answers its prompts and types their password.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
/// Assets of a given release: `{RELEASE_DOWNLOAD_URL}/v{version}/{asset}`.
const RELEASE_DOWNLOAD_URL: &str = "https://github.com/SimonVanMello/yaggui/releases/download";
const CHECKSUMS_ASSET: &str = "SHA256SUMS.txt";

/// The manifest is a few KB; anything bigger is not what we asked for.
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
/// The `.deb` and `.rpm` weigh about 15 MB.
const MAX_PACKAGE_BYTES: u64 = 300 * 1024 * 1024;
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
/// Folder of the app cache where packages are downloaded, emptied before each download.
const DOWNLOAD_FOLDER: &str = "update";

/// pacman's database of installed packages: one `<name>-<version>` folder each.
const PACMAN_LOCAL: &str = "/var/lib/pacman/local";
const AUR_PACKAGE: &str = "yaggui-bin";
/// AUR helpers, by preference: pacman itself cannot build an AUR package.
const AUR_HELPERS: [&str; 2] = ["yay", "paru"];
/// Where system programs live when the app was started with a short `PATH`.
const SYSTEM_BIN: [&str; 3] = ["/usr/local/bin", "/usr/bin", "/bin"];

/// How the running copy was installed, which decides how it is updated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum InstallChannel {
    /// Replaced by the Tauri updater: Windows installer, macOS app (from the `.dmg` or the
    /// Homebrew cask), AppImage.
    SelfUpdate,
    /// The `yaggui-bin` AUR package, upgraded with the user's AUR helper.
    Aur,
    /// The `.deb`: the new one is downloaded, then installed with apt.
    Deb,
    /// The `.rpm`: the new one is downloaded, then installed with dnf or zypper.
    Rpm,
    /// A development build or an unknown layout: the user downloads the new version from the
    /// release page.
    Manual,
}

impl InstallChannel {
    /// Upgraded by a package manager, in an integrated terminal.
    pub fn upgrades_in_terminal(self) -> bool {
        matches!(self, Self::Aur | Self::Deb | Self::Rpm)
    }
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
        Some(BundleType::App | BundleType::Dmg) if facts.in_app_bundle => {
            InstallChannel::SelfUpdate
        }
        // The AUR package repackages the `.deb`.
        Some(BundleType::Deb) if facts.aur_package => InstallChannel::Aur,
        Some(BundleType::Deb) => InstallChannel::Deb,
        Some(BundleType::Rpm) => InstallChannel::Rpm,
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
            facts.in_app_bundle = std::env::current_exe()
                .is_ok_and(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS/"));
        }
        Some(BundleType::Deb) => facts.aur_package = has_pacman_package(AUR_PACKAGE),
        _ => {}
    }
    classify(facts)
}

fn has_pacman_package(name: &str) -> bool {
    let prefix = format!("{name}-");
    std::fs::read_dir(PACMAN_LOCAL).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
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

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .https_only(true)
        .http_status_as_error(false)
        .user_agent(concat!("yaggui/", env!("CARGO_PKG_VERSION")))
        .build()
        .new_agent()
}

/// Reads the manifest of the newest release. `None` when the installed version is the newest,
/// or when that release has no manifest (published before the updater existed).
pub fn check() -> Result<Option<UpdateInfo>, YagguiError> {
    let mut response = agent(CHECK_TIMEOUT)
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

/// Reports a download at most once per percent.
struct Progress<F: FnMut(Option<u8>)> {
    report: F,
    downloaded: u64,
    last: Option<Option<u8>>,
}

impl<F: FnMut(Option<u8>)> Progress<F> {
    fn new(report: F) -> Self {
        Self {
            report,
            downloaded: 0,
            last: None,
        }
    }

    fn advance(&mut self, chunk: u64, total: Option<u64>) {
        self.downloaded = self.downloaded.saturating_add(chunk);
        let percent = total
            .filter(|total| *total > 0)
            .map(|total| u8::try_from(self.downloaded.min(total) * 100 / total).unwrap_or(100));
        if self.last != Some(percent) {
            self.last = Some(percent);
            (self.report)(percent);
        }
    }
}

/// Downloads, verifies and installs the newest release with the Tauri updater, then restarts
/// the app (see [`restart`]). Only for the [`InstallChannel::SelfUpdate`] installs.
pub async fn install(
    app: &tauri::AppHandle,
    mut on_progress: impl FnMut(Option<u8>) + Send,
) -> Result<(), YagguiError> {
    use tauri_plugin_updater::UpdaterExt;

    if install_channel() != InstallChannel::SelfUpdate {
        return Err(YagguiError::update_install_failed(
            "this copy is not replaced by the updater",
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
    let mut progress = Progress::new(&mut on_progress);
    update
        .download_and_install(|chunk, total| progress.advance(chunk as u64, total), || {})
        .await
        .map_err(failed)?;
    tracing::info!("update installed, restarting");
    restart(app);
    Ok(())
}

/// Restarts the app on the version just installed. Only returns on macOS, where the app then
/// exits on its own.
pub fn restart(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    if let Some(bundle) = std::env::current_exe().ok().as_deref().and_then(app_bundle) {
        match relaunch_when_gone(&bundle) {
            Ok(()) => return app.exit(0),
            Err(err) => tracing::warn!(error = %err, "failed to schedule the relaunch"),
        }
    }
    app.restart()
}

/// The `.app` bundle an executable lives in (`<bundle>.app/Contents/MacOS/<exe>`).
#[cfg(any(target_os = "macos", test))]
fn app_bundle(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let named = |path: &Path, name: &str| path.file_name().is_some_and(|n| n == name);
    let is_app = bundle.extension().is_some_and(|ext| ext == "app");
    (named(macos, "MacOS") && named(contents, "Contents") && is_app).then(|| bundle.to_path_buf())
}

/// Waits for this process to exit (30 s at most), then opens `$2` through LaunchServices.
#[cfg(target_os = "macos")]
const RELAUNCH_SCRIPT: &str = r#"i=0
while kill -0 "$1" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i + 1)); done
exec /usr/bin/open "$2""#;

/// Tauri's restart runs `open -n` while this process is still alive: the Dock sees a second
/// instance and gives it its own tile instead of the pinned one, which stays empty. Opening the
/// bundle once this process is gone makes the new one the only instance, on the pinned tile.
/// The bundle path and the pid are arguments of the script, never part of it.
#[cfg(target_os = "macos")]
fn relaunch_when_gone(bundle: &Path) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;

    Command::new("/bin/sh")
        .arg("-c")
        .arg(RELAUNCH_SCRIPT)
        .arg("yaggui-relaunch")
        .arg(std::process::id().to_string())
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Out of our process group, so nothing sent to it on exit reaches the script.
        .process_group(0)
        .spawn()
        .map(drop)
}

/// What the update terminal runs: a program and its arguments, never a shell line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpgradeCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// The package manager command that upgrades a copy of `channel`. `package` is the downloaded
/// `.deb` / `.rpm` (an absolute path); `find` looks a program up by name.
fn upgrade_command(
    channel: InstallChannel,
    package: Option<&Path>,
    find: impl Fn(&str) -> Option<PathBuf>,
) -> Result<UpgradeCommand, YagguiError> {
    let missing = |what: &str| YagguiError::update_install_failed(format!("{what} not found"));
    let found = |name: &str| find(name).map(|path| path.to_string_lossy().into_owned());
    if channel == InstallChannel::Aur {
        let helper = AUR_HELPERS
            .iter()
            .find_map(|name| find(name))
            .ok_or_else(|| missing(&AUR_HELPERS.join(" or ")))?;
        return Ok(UpgradeCommand {
            program: helper,
            args: vec!["-S".into(), AUR_PACKAGE.into()],
        });
    }
    let mut args = match channel {
        InstallChannel::Deb => vec![
            found("apt").ok_or_else(|| missing("apt"))?,
            "install".into(),
        ],
        InstallChannel::Rpm => match (found("dnf"), found("zypper")) {
            (Some(dnf), _) => vec![dnf, "install".into()],
            // Release packages are not signed with a key zypper knows.
            (None, Some(zypper)) => vec![zypper, "install".into(), "--allow-unsigned-rpm".into()],
            (None, None) => return Err(missing("dnf or zypper")),
        },
        _ => {
            return Err(YagguiError::update_install_failed(
                "this copy is not upgraded by a package manager",
            ));
        }
    };
    // An absolute path: a package manager never reads it as an option or a package name.
    let package = package
        .filter(|package| package.is_absolute())
        .ok_or_else(|| YagguiError::internal("no downloaded package to install"))?;
    args.push(package.to_string_lossy().into_owned());
    Ok(UpgradeCommand {
        program: find("sudo").ok_or_else(|| missing("sudo"))?,
        args,
    })
}

/// File name of the release package of `channel`, `None` when none is published for `arch`.
fn package_asset(channel: InstallChannel, version: &semver::Version, arch: &str) -> Option<String> {
    match (channel, arch) {
        (InstallChannel::Deb, "x86_64") => Some(format!("yaggui_{version}_amd64.deb")),
        (InstallChannel::Rpm, "x86_64") => Some(format!("yaggui-{version}-1.x86_64.rpm")),
        _ => None,
    }
}

/// The SHA-256 of `asset` in a `sha256sum` listing, lowercase.
fn expected_checksum(sums: &str, asset: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, name) = line.split_once(char::is_whitespace)?;
        // `sha256sum` marks a file read in binary mode with `*`.
        let name = name.trim_start().trim_start_matches('*');
        (name == asset && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| hash.to_ascii_lowercase())
    })
}

/// First `name` on the `PATH`, then in the system folders.
fn find_program(name: &str) -> Option<PathBuf> {
    let search = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&search)
        .chain(SYSTEM_BIN.iter().map(PathBuf::from))
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn fetch(agent: &ureq::Agent, url: &str) -> Result<ureq::http::Response<ureq::Body>, YagguiError> {
    let response = agent
        .get(url)
        .call()
        .map_err(|err| YagguiError::update_install_failed(format!("{url}: {err}")))?;
    match response.status().as_u16() {
        200 => Ok(response),
        status => Err(YagguiError::update_install_failed(format!(
            "{url}: HTTP {status}"
        ))),
    }
}

/// Downloads the release package of `channel` into `folder` (emptied first) and checks it
/// against the release's checksums.
fn download_package(
    channel: InstallChannel,
    version: &str,
    folder: &Path,
    on_progress: impl FnMut(Option<u8>),
) -> Result<PathBuf, YagguiError> {
    let failed = YagguiError::update_install_failed;
    let version =
        parse_version(version).ok_or_else(|| failed(format!("invalid version: {version}")))?;
    let arch = std::env::consts::ARCH;
    let asset = package_asset(channel, &version, arch)
        .ok_or_else(|| failed(format!("no release package for {arch}")))?;
    let base = format!("{RELEASE_DOWNLOAD_URL}/v{version}");
    let agent = agent(DOWNLOAD_TIMEOUT);

    let sums = fetch(&agent, &format!("{base}/{CHECKSUMS_ASSET}"))?
        .body_mut()
        .with_config()
        .limit(MAX_MANIFEST_BYTES)
        .read_to_string()
        .map_err(|err| failed(format!("{CHECKSUMS_ASSET}: {err}")))?;
    let expected = expected_checksum(&sums, &asset)
        .ok_or_else(|| failed(format!("{asset} is not in {CHECKSUMS_ASSET}")))?;

    let io = |err: std::io::Error| failed(format!("{}: {err}", folder.display()));
    if folder.exists() {
        std::fs::remove_dir_all(folder).map_err(io)?;
    }
    std::fs::create_dir_all(folder).map_err(io)?;
    let path = folder.join(&asset);
    let mut response = fetch(&agent, &format!("{base}/{asset}"))?;
    let total = response.body().content_length();
    let mut reader = response
        .body_mut()
        .with_config()
        .limit(MAX_PACKAGE_BYTES)
        .reader();
    let mut file = File::create(&path).map_err(io)?;
    let mut hasher = Sha256::new();
    let mut progress = Progress::new(on_progress);
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|err| failed(format!("{asset}: {err}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read]).map_err(io)?;
        progress.advance(read as u64, total);
    }
    file.flush().map_err(io)?;
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        let _ = std::fs::remove_file(&path);
        return Err(failed(format!(
            "{asset}: checksum mismatch (expected {expected}, got {actual})"
        )));
    }
    tracing::info!(path = %path.display(), "update package downloaded");
    Ok(path)
}

/// Gets the upgrade of a package-manager copy ready: downloads and checks the new `.deb` /
/// `.rpm` into `cache_dir`, then returns the command that installs it, for the update
/// terminal. Download progress goes to `on_progress`.
pub fn prepare_upgrade(
    cache_dir: &Path,
    on_progress: impl FnMut(Option<u8>),
) -> Result<UpgradeCommand, YagguiError> {
    let channel = install_channel();
    let package = match channel {
        InstallChannel::Aur => None,
        InstallChannel::Deb | InstallChannel::Rpm => {
            let update = check()
                .map_err(|err| {
                    YagguiError::update_install_failed(
                        err.detail.unwrap_or_else(|| "update check failed".into()),
                    )
                })?
                .ok_or_else(|| {
                    YagguiError::update_install_failed("no newer version in the manifest")
                })?;
            Some(download_package(
                channel,
                &update.version,
                &cache_dir.join(DOWNLOAD_FOLDER),
                on_progress,
            )?)
        }
        _ => {
            return Err(YagguiError::update_install_failed(
                "this copy is not upgraded by a package manager",
            ));
        }
    };
    let command = upgrade_command(channel, package.as_deref(), find_program)?;
    tracing::info!(program = %command.program.display(), args = ?command.args, "upgrade ready");
    Ok(command)
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
    use crate::git::errors::ErrorCode;

    fn facts(bundle: BundleType) -> Facts {
        Facts {
            bundle: Some(bundle),
            ..Facts::default()
        }
    }

    #[test]
    fn app_bundle_is_found_from_its_executable() {
        assert_eq!(
            app_bundle(Path::new("/Applications/yaggui.app/Contents/MacOS/yaggui")),
            Some(PathBuf::from("/Applications/yaggui.app"))
        );
        assert_eq!(app_bundle(Path::new("/usr/local/bin/yaggui")), None);
        assert_eq!(
            app_bundle(Path::new("/tmp/yaggui/Contents/MacOS/yaggui")),
            None
        );
        assert_eq!(app_bundle(Path::new("yaggui")), None);
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
    fn the_homebrew_cask_updates_itself() {
        // The cask declares `auto_updates`: Homebrew leaves the upgrade to the app.
        let cask = Facts {
            in_app_bundle: true,
            ..facts(BundleType::Dmg)
        };
        assert_eq!(classify(cask), InstallChannel::SelfUpdate);
    }

    #[test]
    fn linux_packages_are_upgraded_by_their_package_manager() {
        let aur = Facts {
            aur_package: true,
            ..facts(BundleType::Deb)
        };
        assert_eq!(classify(aur), InstallChannel::Aur);
        assert_eq!(classify(facts(BundleType::Deb)), InstallChannel::Deb);
        assert_eq!(classify(facts(BundleType::Rpm)), InstallChannel::Rpm);
        for channel in [
            InstallChannel::Aur,
            InstallChannel::Deb,
            InstallChannel::Rpm,
        ] {
            assert!(channel.upgrades_in_terminal(), "{channel:?}");
        }
        assert!(!InstallChannel::SelfUpdate.upgrades_in_terminal());
        assert!(!InstallChannel::Manual.upgrades_in_terminal());
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
        let update = newer_release(MANIFEST, "0.1.0", InstallChannel::Deb)
            .unwrap()
            .unwrap();
        assert_eq!(
            update,
            UpdateInfo {
                current_version: "0.1.0".into(),
                version: "0.2.0".into(),
                notes: Some("Faster graph".into()),
                date: Some("2026-10-20T10:00:00Z".into()),
                channel: InstallChannel::Deb,
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
            assert_eq!(err.code, ErrorCode::UpdateCheckFailed);
        }
    }

    /// A `find` that knows `names`, installed in `/usr/bin`.
    fn tools(names: &'static [&'static str]) -> impl Fn(&str) -> Option<PathBuf> {
        move |name| {
            names
                .contains(&name)
                .then(|| PathBuf::from(format!("/usr/bin/{name}")))
        }
    }

    /// A downloaded package: absolute on every OS (`/home/…` is not, on Windows).
    fn package(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    fn command(program: &str, args: &[&str]) -> UpgradeCommand {
        UpgradeCommand {
            program: PathBuf::from(program),
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
        }
    }

    #[test]
    fn the_aur_package_is_rebuilt_by_the_installed_helper() {
        let yay = upgrade_command(InstallChannel::Aur, None, tools(&["yay", "paru"])).unwrap();
        assert_eq!(yay, command("/usr/bin/yay", &["-S", "yaggui-bin"]));
        let paru = upgrade_command(InstallChannel::Aur, None, tools(&["paru"])).unwrap();
        assert_eq!(paru, command("/usr/bin/paru", &["-S", "yaggui-bin"]));
        let err = upgrade_command(InstallChannel::Aur, None, tools(&["sudo"])).unwrap_err();
        assert_eq!(err.code, ErrorCode::UpdateInstallFailed);
    }

    #[test]
    fn a_downloaded_package_is_installed_with_sudo() {
        let deb = &package("yaggui_0.4.0_amd64.deb");
        let apt = upgrade_command(InstallChannel::Deb, Some(deb), tools(&["sudo", "apt"])).unwrap();
        assert_eq!(
            apt,
            command(
                "/usr/bin/sudo",
                &["/usr/bin/apt", "install", &deb.to_string_lossy()]
            )
        );

        let rpm = &package("yaggui-0.4.0-1.x86_64.rpm");
        let rpm_arg = rpm.to_string_lossy();
        let dnf = upgrade_command(
            InstallChannel::Rpm,
            Some(rpm),
            tools(&["sudo", "dnf", "zypper"]),
        )
        .unwrap();
        assert_eq!(
            dnf,
            command("/usr/bin/sudo", &["/usr/bin/dnf", "install", &rpm_arg])
        );
        let zypper =
            upgrade_command(InstallChannel::Rpm, Some(rpm), tools(&["sudo", "zypper"])).unwrap();
        assert_eq!(
            zypper,
            command(
                "/usr/bin/sudo",
                &[
                    "/usr/bin/zypper",
                    "install",
                    "--allow-unsigned-rpm",
                    &rpm_arg
                ]
            )
        );
    }

    #[test]
    fn an_upgrade_without_its_tools_or_package_is_a_typed_error() {
        let deb = package("yaggui.deb");
        let deb = deb.as_path();
        for (channel, package, names) in [
            (InstallChannel::Deb, Some(deb), &["apt"][..]),
            (InstallChannel::Deb, Some(deb), &["sudo"][..]),
            (InstallChannel::Rpm, Some(deb), &["sudo", "apt"][..]),
            (InstallChannel::Manual, None, &["sudo", "apt"][..]),
            (InstallChannel::SelfUpdate, None, &["sudo", "apt"][..]),
        ] {
            let names: &'static [&'static str] = names;
            let err = upgrade_command(channel, package, tools(names)).unwrap_err();
            assert_eq!(err.code, ErrorCode::UpdateInstallFailed, "{channel:?}");
        }
        for package in [None, Some(Path::new("yaggui.deb"))] {
            let err =
                upgrade_command(InstallChannel::Deb, package, tools(&["sudo", "apt"])).unwrap_err();
            assert_eq!(err.code, ErrorCode::Internal);
        }
    }

    #[test]
    fn release_packages_are_named_like_the_bundler_names_them() {
        let version = semver::Version::new(0, 4, 0);
        assert_eq!(
            package_asset(InstallChannel::Deb, &version, "x86_64").as_deref(),
            Some("yaggui_0.4.0_amd64.deb")
        );
        assert_eq!(
            package_asset(InstallChannel::Rpm, &version, "x86_64").as_deref(),
            Some("yaggui-0.4.0-1.x86_64.rpm")
        );
        assert_eq!(
            package_asset(InstallChannel::Deb, &version, "aarch64"),
            None
        );
        assert_eq!(package_asset(InstallChannel::Aur, &version, "x86_64"), None);
    }

    #[test]
    fn the_checksum_of_an_asset_is_read_from_the_sums() {
        let deb = "0b66918684626bf7d698e384311e27cbca1427c02ecf20280180b208230de3ea";
        let sums = format!(
            "8ba21d75112c0a79a098e5946abb8656535275a189a5159cca7f528cdd53a7dd  latest.json\n\
             {}  yaggui_0.3.0_amd64.deb\n\
             332ec9dbaa2b418fb691a563924a342b414dcf6091ba68dbfbd495bb9da4818c *yaggui-0.3.0-1.x86_64.rpm\n",
            deb.to_uppercase()
        );
        assert_eq!(
            expected_checksum(&sums, "yaggui_0.3.0_amd64.deb").as_deref(),
            Some(deb)
        );
        assert!(expected_checksum(&sums, "yaggui-0.3.0-1.x86_64.rpm").is_some());
        assert_eq!(
            expected_checksum(&sums, "yaggui_0.3.0_amd64.AppImage"),
            None
        );
        assert_eq!(expected_checksum("nothex  yaggui.deb", "yaggui.deb"), None);
    }

    #[test]
    fn download_progress_is_reported_once_per_percent() {
        let mut seen = Vec::new();
        let mut progress = Progress::new(|percent| seen.push(percent));
        for _ in 0..4 {
            progress.advance(1, Some(400));
        }
        progress.advance(396, Some(400));
        progress.advance(10, None);
        assert_eq!(seen, [Some(0), Some(1), Some(100), None]);
    }

    /// Downloads and checks a published package. Needs the network:
    /// `cargo test --lib updates::tests::a_published_package_downloads_and_checks -- --ignored`
    #[test]
    #[ignore]
    fn a_published_package_downloads_and_checks() {
        let folder = tempfile::tempdir().unwrap();
        let mut last = None;
        let path = download_package(InstallChannel::Deb, "0.3.0", folder.path(), |percent| {
            last = percent;
        })
        .unwrap();
        assert_eq!(last, Some(100));
        assert_eq!(path, folder.path().join("yaggui_0.3.0_amd64.deb"));
        assert!(path.metadata().unwrap().len() > 1024 * 1024);
    }
}
