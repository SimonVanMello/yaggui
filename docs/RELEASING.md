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

## Signing

The builds are not signed yet. The macOS app is only ad-hoc signed (`signingIdentity: "-"`), so Gatekeeper blocks it on first launch until the user allows it in System Settings → Privacy & Security; Windows SmartScreen warns about an unknown publisher. Apple notarization and Windows code signing come with their own task.

Versions are plain `X.Y.Z`: the Windows MSI bundler rejects pre-release suffixes.
