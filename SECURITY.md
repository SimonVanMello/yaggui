# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/SimonVanMello/yaggui/security/advisories/new), not in a public issue.

Include the yaggui version, your OS, and the steps or the repository content that trigger the problem. The fix ships in a patch release, credited to you unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes. yaggui checks for updates at startup when you allow it, and **Check for updates** in the command palette checks on demand.

## Scope

yaggui runs your own `git` on repositories you open, and a repository's content is untrusted. In scope, for example:

- a repository whose content (file names, refs, config, hooks it does not run on its own) makes yaggui run a program or a command it should not;
- a way for repository content or a remote to run script in the yaggui window;
- credentials written in clear to the command log, the log files or a bug report.

Out of scope: what Git runs because of your own configuration (your hooks, filters and aliases), and the absence of code signing on the current builds (tracked in `docs/PLAN.md`, task M6-5).
