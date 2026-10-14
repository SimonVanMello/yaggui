# Releasing

The [`Release`](../.github/workflows/release.yml) workflow builds the installers of every platform. A `vX.Y.Z` tag attaches them to a draft GitHub Release; a pull request that touches the packaging (the workflow, `scripts/version.mjs`, `src-tauri/tauri.conf.json`) only builds them and keeps them as workflow artifacts.

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
3. The workflow checks that the tag matches the version of the four files, builds every platform, then creates a **draft** release with the installers, a `SHA256SUMS.txt` and notes generated from the merged PRs.
4. Check the draft (notes, assets), then publish it. The package manager channels follow published releases only.

If a build fails, the release is not created: fix, delete the tag (`git push origin :v0.2.0`, `git tag -d v0.2.0`) and tag again. To rebuild a tag whose draft already exists, delete the draft first.

## Artifacts

| Platform | Runner | Files |
|---|---|---|
| macOS Apple Silicon | `macos-latest` | `yaggui_<version>_aarch64.dmg` |
| macOS Intel | `macos-latest` (cross-compiled) | `yaggui_<version>_x64.dmg` |
| Linux x86_64 | `ubuntu-22.04` | `yaggui_<version>_amd64.deb`, `yaggui-<version>-1.x86_64.rpm`, `yaggui_<version>_amd64.AppImage` |
| Windows x64 | `windows-latest` | `yaggui_<version>_x64_en-US.msi`, `yaggui_<version>_x64-setup.exe` |

Linux is built on the oldest supported Ubuntu so the binaries run on older glibc. The `.deb` and `.rpm` depend on `git`; on macOS and Windows, Git must be installed separately.

## Package managers

Each channel has its own workflow, triggered when a release is **published** (not while it is a draft), and runnable by hand from the Actions tab for an existing tag.

### AUR

[`AUR`](../.github/workflows/aur.yml) publishes [`yaggui-bin`](https://aur.archlinux.org/packages/yaggui-bin), which repackages the `.deb` of the release. [`scripts/aur.mjs`](../scripts/aur.mjs) generates the `PKGBUILD` and `.SRCINFO` with the sum from `SHA256SUMS.txt`; the workflow checks the `.SRCINFO` against `makepkg --printsrcinfo`, builds and installs the package in an `archlinux` container, then pushes both files to `ssh://aur@aur.archlinux.org/yaggui-bin.git`. Pull requests that touch the packaging run every step but the push, on the latest release.

Requires the `AUR_SSH_PRIVATE_KEY` repository secret: the private half of a key registered on the AUR account that maintains the package (My Account → SSH Public Key).

To fix the package without a new app version, change the generator, then run the workflow by hand with the same tag and `pkgrel` bumped to `2`.

## Signing

The builds are not signed yet. The macOS app is only ad-hoc signed (`signingIdentity: "-"`), so Gatekeeper blocks it on first launch until the user allows it in System Settings → Privacy & Security; Windows SmartScreen warns about an unknown publisher. Apple notarization and Windows code signing come with their own task.

Versions are plain `X.Y.Z`: the Windows MSI bundler rejects pre-release suffixes.
