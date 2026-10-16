# Releasing

The [`Release`](../.github/workflows/release.yml) workflow builds the installers of every platform. A `vX.Y.Z` tag attaches them to a draft GitHub Release; a pull request that touches the packaging (the workflow, `scripts/version.mjs`, `src-tauri/tauri.conf.json`) only builds them and keeps them as workflow artifacts. A pull request whose only packaging change is the version (step 1 below) checks the version without building: the tag builds the same bundles.

## Cutting a release

1. On a branch, set the version and open a PR:
   ```bash
   pnpm release:version 0.2.0   # package.json, tauri.conf.json, Cargo.toml, Cargo.lock
   ```
2. Once the PR is merged, tag the merge commit on `master` and push the tag:
   ```bash
   git checkout master && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```
3. The workflow checks that the tag matches the version of the four files, builds every platform, then creates a **draft** release with the installers, the update manifest `latest.json`, a `SHA256SUMS.txt` and notes generated from the merged PRs.
4. Check the draft (notes, assets), then publish it. The package manager channels and the in-app update check follow published releases only.

If a build fails, the release is not created: fix, delete the tag (`git push origin :v0.2.0`, `git tag -d v0.2.0`) and tag again. To rebuild a tag whose draft already exists, delete the draft first.

## Artifacts

| Platform | Runner | Files |
|---|---|---|
| macOS Apple Silicon | `macos-latest` | `yaggui_<version>_aarch64.dmg`, `yaggui_<version>_aarch64.app.tar.gz` (updater) |
| macOS Intel | `macos-latest` (cross-compiled) | `yaggui_<version>_x64.dmg`, `yaggui_<version>_x64.app.tar.gz` (updater) |
| Linux x86_64 | `ubuntu-22.04` | `yaggui_<version>_amd64.deb`, `yaggui-<version>-1.x86_64.rpm`, `yaggui_<version>_amd64.AppImage` |
| Windows x64 | `windows-latest` | `yaggui_<version>_x64_en-US.msi`, `yaggui_<version>_x64-setup.exe` |

Plus `latest.json`, the update manifest (see [Updates](#updates)).

Linux is built on the oldest supported Ubuntu so the binaries run on older glibc. The `.deb` and `.rpm` depend on `git`; on macOS and Windows, Git must be installed separately.

## Package managers

Each channel has its own workflow, triggered when a release is **published** (not while it is a draft), and runnable by hand from the Actions tab for an existing tag.

### AUR

[`AUR`](../.github/workflows/aur.yml) publishes [`yaggui-bin`](https://aur.archlinux.org/packages/yaggui-bin), which repackages the `.deb` of the release. [`scripts/aur.mjs`](../scripts/aur.mjs) generates the `PKGBUILD` and `.SRCINFO` with the sum from `SHA256SUMS.txt`; the workflow checks the `.SRCINFO` against `makepkg --printsrcinfo`, builds and installs the package in an `archlinux` container, then pushes both files to `ssh://aur@aur.archlinux.org/yaggui-bin.git`. Pull requests that touch the packaging run every step but the push, on the latest release.

Requires the `AUR_SSH_PRIVATE_KEY` repository secret: the private half of a key registered on the AUR account that maintains the package (My Account → SSH Public Key).

To fix the package without a new app version, change the generator, then run the workflow by hand with the same tag and `pkgrel` bumped to `2`.

### Homebrew

[`Homebrew`](../.github/workflows/homebrew.yml) publishes the `yaggui` cask to the third-party tap [`SimonVanMello/homebrew-yaggui`](https://github.com/SimonVanMello/homebrew-yaggui). [`scripts/homebrew.mjs`](../scripts/homebrew.mjs) generates `Casks/yaggui.rb` with the sums of `yaggui_<version>_aarch64.dmg` and `yaggui_<version>_x64.dmg` from `SHA256SUMS.txt`; the workflow audits the cask from a temporary local tap (`brew style`, `brew audit --strict --online`), installs and uninstalls it on a `macos-latest` runner, then pushes it to the `main` branch of the tap with the commit message `yaggui <version>`. Pull requests that touch the packaging run every step but the push, on the latest release.

Users install it with:

```bash
brew install --cask simonvanmello/yaggui/yaggui
```

The cask has a `caveats` block that explains how to clear the quarantine attribute, because the app is not notarized (see [Signing](#signing)). Remove it from the generator (between the `BEGIN`/`END quarantine caveat` comments) once notarization lands.

One-time setup:

1. Create the public repository `SimonVanMello/homebrew-yaggui` (it can stay empty: the first run creates `main`).
2. Generate a key pair without a passphrase:
   ```bash
   ssh-keygen -t ed25519 -N '' -C 'yaggui homebrew tap' -f homebrew-tap
   ```
3. On `homebrew-yaggui`, Settings → Deploy keys → Add deploy key: paste `homebrew-tap.pub` and check **Allow write access**.
4. On `yaggui`, Settings → Secrets and variables → Actions → New repository secret: name it `HOMEBREW_TAP_SSH_PRIVATE_KEY` and paste the content of `homebrew-tap`. Then delete both local files.

To publish an existing release by hand (first publication, or after a fix to the generator): Actions → Homebrew → Run workflow, keep "Use workflow from: master", enter the tag (`vX.Y.Z`). A run that produces the same cask as the tap pushes nothing.

## Updates

The app can check for a newer version (opt-in: asked once at first launch, then in Preferences → Behavior, and "Check for updates" in the palette). It reads `https://github.com/SimonVanMello/yaggui/releases/latest/download/latest.json`, which always points to the newest **published** release. What it offers depends on how the copy was installed ([`system/updates.rs`](../src-tauri/src/system/updates.rs)):

| Installed from | Offer |
|---|---|
| Windows installer (`.exe`, `.msi`), macOS `.dmg`, AppImage | "Update and restart": the [Tauri updater](https://v2.tauri.app/plugin/updater/) downloads the bundle, checks its signature, installs it and restarts |
| Homebrew cask | copy `brew update && brew upgrade --cask yaggui` (the updater would replace the app behind Homebrew's back) |
| AUR (`yaggui-bin`) | copy `yay -Syu yaggui-bin` |
| `.deb`, `.rpm` | open the release page |

[`scripts/updater-manifest.mjs`](../scripts/updater-manifest.mjs) writes `latest.json` from the updater bundles and their `.sig` files; the release job fails rather than publish a manifest that leaves a platform out. A release published before this manifest existed (0.1.0) has none: the check reports nothing.

The updater bundles are signed with a minisign key, unrelated to Apple or Windows code signing. One-time setup:

1. Generate the key pair, with a password:
   ```bash
   pnpm tauri signer generate -w ~/.tauri/yaggui.key
   ```
2. Put the content of `~/.tauri/yaggui.key.pub` in `plugins.updater.pubkey` of `src-tauri/tauri.conf.json`. Tag builds fail while it is empty.
3. On `yaggui`, add the repository secrets `TAURI_SIGNING_PRIVATE_KEY` (the content of `~/.tauri/yaggui.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Tag builds fail without them; pull request builds skip the updater bundles.
4. Keep the private key and its password in a password manager. **Losing them means the installed copies can never update themselves again**: they only accept bundles signed with the key they were built with.

## Signing

The builds are not signed yet. The macOS app is only ad-hoc signed (`signingIdentity: "-"`), so Gatekeeper blocks it on first launch until the user allows it in System Settings → Privacy & Security; Windows SmartScreen warns about an unknown publisher. Apple notarization and Windows code signing come with their own task.

Versions are plain `X.Y.Z`: the Windows MSI bundler rejects pre-release suffixes.
