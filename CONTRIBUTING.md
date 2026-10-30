# Contributing to yaggui

Thanks for your interest. Bug reports, ideas and pull requests are welcome.

## Reporting a bug

Use **Report a bug…** in yaggui (Preferences › General › Troubleshooting, or the command palette): it copies a diagnostic report and opens the bug form, where you paste it. See [Report a bug](https://yaggui.tropico.dev/docs/help/troubleshooting/#report-a-bug). Security issues go through [SECURITY.md](SECURITY.md) instead.

## Before writing code

Read these first; they are the sources of truth of the project:

- [`CLAUDE.md`](CLAUDE.md): stack, layout, commands, architecture rules and code conventions. It applies to people as much as to coding agents.
- [`docs/SPEC.md`](docs/SPEC.md): the requirements (`F-xxx`, `P-xx`) and the UX principles.
- [`docs/PLAN.md`](docs/PLAN.md): the tasks; one task is one pull request.

For anything beyond a small fix, open an issue first so we can agree on the approach.

## Setting up

```bash
mise install    # Node, pnpm and Rust at the versions of mise.toml (optional)
pnpm install
pnpm dev        # frontend alone in the browser, on a mocked backend
pnpm tauri dev  # the full app
```

The Linux system packages Tauri needs are listed in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## Pull requests

- Branch from `master`, one change per pull request, commits in [Conventional Commits](https://www.conventionalcommits.org/) form (`feat(graph): …`, `fix(ipc): …`).
- Run `pnpm check`, then `cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test`. CI runs them on Linux, macOS and Windows, plus Playwright.
- Fill in the [pull request template](.github/pull_request_template.md). A change users can see updates the docs of the site in English and French in the same pull request (see the "Documentation" section of `CLAUDE.md`).
- UI text goes through `src/i18n/en.json` and `fr.json`, both together. Both themes must stay correct.

By contributing, you agree that your contribution is licensed under the [GPL-3.0-or-later](LICENSE), like the rest of yaggui.
