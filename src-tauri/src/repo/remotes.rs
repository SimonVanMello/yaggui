//! Remote management and tag transfers of `RepoManager` (M4-7c). Writes run on the
//! repository's `OpQueue` and go through `git/cli.rs`; names are checked with
//! `git check-ref-format`, names and URLs are separate arguments after `--`. Network commands
//! run with `--progress` and are cancellable, like those of `network.rs`.

use crate::events::OpKind;
use gix::bstr::ByteSlice;

use crate::git::errors::YagguiError;
use crate::git::ops::remotes::{
    PushedRef, RemoteRemovalPreview, RemovedRemote, TagPushResult, check_remote_name,
    check_remote_url, parse_porcelain, tag_of, tag_rejection,
};
use crate::git::ops::types::{DeletedRef, FetchTarget, JournalOp, UndoBlock};
use crate::git::read::state::gix;

use super::RepoManager;
use super::journal::{Mode, Plan};
use super::network::{checked_remote, classify, run_network};
use super::ref_ops::find_ref;
use super::write::WriteContext;

impl RepoManager {
    /// In-process check of a new remote name, for the live verdict of the name field:
    /// `invalidRemoteName`, or `remoteExists`.
    pub fn validate_remote_name(&self, repo_id: u32, name: &str) -> Result<(), YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        check_remote_name(name)?;
        if has_remote(&repo, name) {
            return Err(YagguiError::remote_exists(name));
        }
        Ok(())
    }

    /// Tracking branches and upstreams a removal of `name` drops. Read-only, not queued.
    pub fn remote_removal_preview(
        &self,
        repo_id: u32,
        name: &str,
    ) -> Result<RemoteRemovalPreview, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        if !has_remote(&repo, name) {
            return Err(YagguiError::remote_not_found().with_detail(name));
        }
        let tracking = tracking_refs(&repo, name)?
            .into_iter()
            .filter_map(|r| r.full_name.strip_prefix("refs/remotes/").map(str::to_owned))
            .collect();
        let upstream_of = upstreams_on(&repo, name)?
            .into_iter()
            .map(|(branch, _)| branch)
            .collect();
        Ok(RemoteRemovalPreview {
            tracking,
            upstream_of,
        })
    }

    /// `git remote add`, then the distinct push URL when one is given.
    pub fn add_remote(
        &self,
        repo_id: u32,
        name: &str,
        url: &str,
        push_url: Option<String>,
    ) -> Result<(), YagguiError> {
        let name = name.to_owned();
        let url = check_remote_url(url)?;
        let push_url = push_url.as_deref().map(check_remote_url).transpose()?;
        self.journal_op(repo_id, OpKind::Remote, false, false, move |ctx| {
            check_new_remote(ctx, &name)?;
            ctx.run(&ctx.command(["remote", "add", "--", &name, &url]))?;
            if let Some(push_url) = push_url {
                ctx.run(&ctx.command(["remote", "set-url", "--push", "--", &name, &push_url]))?;
            }
            let change = RemoteChange::Added {
                config: remote_config(ctx, &name)?,
                name: name.clone(),
            };
            Ok((
                (),
                Some(Plan::new(
                    JournalOp::AddRemote { name },
                    Mode::Remote(change),
                )),
            ))
        })
    }

    /// `git remote rename`: tracking branches and upstreams follow the new name.
    pub fn rename_remote(
        &self,
        repo_id: u32,
        name: &str,
        new_name: &str,
    ) -> Result<(), YagguiError> {
        let (name, new_name) = (name.to_owned(), new_name.to_owned());
        self.journal_op(repo_id, OpKind::Remote, false, false, move |ctx| {
            let name = checked_remote(ctx, &name)?;
            check_new_remote(ctx, &new_name)?;
            ctx.run(&ctx.command(["remote", "rename", "--", &name, &new_name]))?;
            let change = RemoteChange::Renamed {
                from: name.clone(),
                to: new_name.clone(),
            };
            let op = JournalOp::RenameRemote {
                from: name,
                to: new_name,
            };
            Ok(((), Some(Plan::new(op, Mode::Remote(change)))))
        })
    }

    /// Sets the fetch URL, and the push URL: `None` removes it (pushes then use the fetch URL).
    pub fn set_remote_urls(
        &self,
        repo_id: u32,
        name: &str,
        url: &str,
        push_url: Option<String>,
    ) -> Result<(), YagguiError> {
        let name = name.to_owned();
        let url = check_remote_url(url)?;
        let push_url = push_url.as_deref().map(check_remote_url).transpose()?;
        self.journal_op(repo_id, OpKind::Remote, false, false, move |ctx| {
            let name = checked_remote(ctx, &name)?;
            let before = remote_urls(ctx, &name)?;
            ctx.run(&ctx.command(["remote", "set-url", "--", &name, &url]))?;
            match push_url {
                Some(push_url) => {
                    ctx.run(&ctx.command(["remote", "set-url", "--push", "--", &name, &push_url]))?;
                }
                None => unset_key(ctx, &format!("remote.{name}.pushurl"))?,
            }
            let after = remote_urls(ctx, &name)?;
            let plan = (before != after).then(|| {
                Plan::new(
                    JournalOp::SetRemoteUrls { name: name.clone() },
                    Mode::Remote(RemoteChange::Urls {
                        name,
                        before,
                        after,
                    }),
                )
            });
            Ok(((), plan))
        })
    }

    /// `git remote remove`: its tracking branches go, and local branches lose their upstream.
    pub fn remove_remote(&self, repo_id: u32, name: &str) -> Result<RemovedRemote, YagguiError> {
        let name = name.to_owned();
        self.journal_op(repo_id, OpKind::Remote, false, false, move |ctx| {
            let name = checked_remote(ctx, &name)?;
            let config = remote_config(ctx, &name)?;
            let get = |key: &str| {
                config
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(&format!("remote.{name}.{key}")))
                    .map(|(_, v)| v.clone())
            };
            let tracking = tracking_refs(ctx.repo, &name)?;
            let removed = RemovedRemote {
                url: get("url"),
                push_url: get("pushurl"),
                tracking: tracking.clone(),
                name: name.clone(),
            };
            let upstreams = upstreams_on(ctx.repo, &name)?;
            ctx.run(&ctx.command(["remote", "remove", "--", &name]))?;
            let change = RemoteChange::Removed {
                name: name.clone(),
                config,
                tracking,
                upstreams,
            };
            Ok((
                removed,
                Some(Plan::new(
                    JournalOp::RemoveRemote { name },
                    Mode::Remote(change),
                )),
            ))
        })
    }

    /// Pushes every local tag to `remote` (`refs/tags/*`); branches are left alone.
    pub fn push_all_tags(&self, repo_id: u32, remote: &str) -> Result<TagPushResult, YagguiError> {
        let remote = remote.to_owned();
        self.journal_op(repo_id, OpKind::Push, true, false, move |ctx| {
            let remote = checked_remote(ctx, &remote)?;
            let result = push_tags(ctx, &remote, "refs/tags/*:refs/tags/*")?;
            let plan = (!result.pushed.is_empty())
                .then(|| Plan::blocked(JournalOp::PushTags { remote }, UndoBlock::Published));
            Ok((result, plan))
        })
    }

    /// `git fetch --tags` of one remote or all: every tag of the remote, even those on
    /// commits no fetched branch reaches. Tags are never pruned here.
    pub fn fetch_tags(&self, repo_id: u32, target: FetchTarget) -> Result<(), YagguiError> {
        self.write_op(repo_id, OpKind::Fetch, true, move |ctx| {
            let mut args = vec![
                "fetch".to_owned(),
                "--progress".to_owned(),
                "--tags".to_owned(),
            ];
            match target {
                FetchTarget::All => args.push("--all".into()),
                FetchTarget::Remote { name } => args.push(checked_remote(ctx, &name)?),
            }
            run_network(ctx, &ctx.command(args)).map(drop)
        })
    }
}

/// Pushes `refspec` (tags only) and reads the porcelain report; a refused tag is `tagRejected`.
pub(super) fn push_tags(
    ctx: &WriteContext<'_>,
    remote: &str,
    refspec: &str,
) -> Result<TagPushResult, YagguiError> {
    let run =
        ctx.run_progress(&ctx.command(["push", "--progress", "--porcelain", remote, refspec]))?;
    let refs = parse_porcelain(&run.stdout);
    if !run.success {
        return Err(match tag_rejection(&refs) {
            Some(error) => error.with_detail(format!("{}\n{}", run.stderr, run.stdout)),
            None => classify(ctx, &run),
        });
    }
    let tags = |keep: fn(&PushedRef) -> bool| {
        refs.iter()
            .filter(move |r| keep(r))
            .filter_map(|r| tag_of(&r.to))
    };
    let mut pushed: Vec<String> = tags(|r| r.flag != '=').map(str::to_owned).collect();
    pushed.sort();
    Ok(TagPushResult {
        pushed,
        up_to_date: u32::try_from(tags(|r| r.flag == '=').count()).unwrap_or(u32::MAX),
    })
}

/// A new remote name: valid for `git check-ref-format` and not taken (`remoteExists`).
fn check_new_remote(ctx: &WriteContext<'_>, name: &str) -> Result<(), YagguiError> {
    check_remote_name(name)?;
    let probe = format!("refs/remotes/{name}/test");
    let run = ctx
        .git
        .run_raw(&ctx.command(["check-ref-format", &probe]), None, None)?;
    if !run.success {
        return Err(YagguiError::invalid_remote_name(name));
    }
    let output = ctx.run(&ctx.command(["remote"]))?;
    if output.stdout.lines().any(|r| r.trim() == name) {
        return Err(YagguiError::remote_exists(name));
    }
    Ok(())
}

fn has_remote(repo: &gix::Repository, name: &str) -> bool {
    repo.remote_names()
        .iter()
        .any(|r| r.as_bytes() == name.as_bytes())
}

/// Direct refs under `prefix`, with their target.
fn refs_with_prefix(
    repo: &gix::Repository,
    prefix: &str,
) -> Result<Vec<(String, String)>, YagguiError> {
    let platform = repo.references().map_err(gix("list refs"))?;
    let mut found = Vec::new();
    for reference in platform.all().map_err(gix("list refs"))? {
        let reference = reference.map_err(gix("list refs"))?;
        let full = reference.name().as_bstr().to_string();
        if !full.starts_with(prefix) {
            continue;
        }
        if let gix::refs::TargetRef::Object(id) = reference.target() {
            found.push((full, id.to_string()));
        }
    }
    found.sort();
    Ok(found)
}

/// Remote-tracking refs of `remote` (`origin/HEAD`, symbolic, excluded).
fn tracking_refs(repo: &gix::Repository, remote: &str) -> Result<Vec<DeletedRef>, YagguiError> {
    Ok(refs_with_prefix(repo, &format!("refs/remotes/{remote}/"))?
        .into_iter()
        .map(|(full_name, sha)| DeletedRef { full_name, sha })
        .collect())
}

/// Local branches whose upstream is on `remote`, with their `branch.<b>.merge`, sorted.
fn upstreams_on(
    repo: &gix::Repository,
    remote: &str,
) -> Result<Vec<(String, String)>, YagguiError> {
    let config = repo.config_snapshot();
    let mut found = Vec::new();
    for (full, _) in refs_with_prefix(repo, "refs/heads/")? {
        let branch = &full["refs/heads/".len()..];
        let on_remote = config
            .string(format!("branch.{branch}.remote").as_str())
            .is_some_and(|r| r.as_bytes() == remote.as_bytes());
        if !on_remote {
            continue;
        }
        let merge = config
            .string(format!("branch.{branch}.merge").as_str())
            .map(|m| m.to_string())
            .unwrap_or_default();
        found.push((branch.to_owned(), merge));
    }
    Ok(found)
}

// --- Undo / redo ---------------------------------------------------------------------------

/// What a remote operation changed, for its undo and redo (journal `Mode::Remote`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum RemoteChange {
    /// `config`: the remote's section once added, put back by the redo.
    Added {
        name: String,
        config: Vec<(String, String)>,
    },
    Renamed {
        from: String,
        to: String,
    },
    /// `url` / `pushurl` entries before and after `set-url`.
    Urls {
        name: String,
        before: Vec<(String, String)>,
        after: Vec<(String, String)>,
    },
    /// What the removal took: config section, tracking refs, upstreams `(branch, merge)`.
    Removed {
        name: String,
        config: Vec<(String, String)>,
        tracking: Vec<DeletedRef>,
        upstreams: Vec<(String, String)>,
    },
}

/// Undo (`undo`) or redo of a remote operation. Refused with `undoDiverged` when the remote
/// is no longer as the operation left it (removed, added or renamed elsewhere since).
pub(super) fn remote_step(
    ctx: &WriteContext<'_>,
    change: &RemoteChange,
    undo: bool,
) -> Result<(), YagguiError> {
    let exists = |name: &str| -> Result<bool, YagguiError> {
        let output = ctx.run(&ctx.command(["remote"]))?;
        Ok(output.stdout.lines().any(|r| r.trim() == name))
    };
    let diverged =
        |name: &str| YagguiError::undo_diverged(vec![format!("remote.{name}")], Vec::new());
    match change {
        RemoteChange::Renamed { from, to } => {
            let (current, target) = if undo { (to, from) } else { (from, to) };
            if !exists(current)? || exists(target)? {
                return Err(diverged(current));
            }
            ctx.run(&ctx.command(["remote", "rename", "--", current, target]))
                .map(drop)
        }
        RemoteChange::Urls {
            name,
            before,
            after,
        } => {
            let (current, target) = if undo {
                (after, before)
            } else {
                (before, after)
            };
            if !exists(name)? || remote_urls(ctx, name)? != *current {
                return Err(diverged(name));
            }
            for key in ["url", "pushurl"] {
                unset_key(ctx, &format!("remote.{name}.{key}"))?;
            }
            for (key, value) in target {
                ctx.run(&ctx.command(["config", "--add", key, value]))?;
            }
            Ok(())
        }
        RemoteChange::Added { name, config } | RemoteChange::Removed { name, config, .. } => {
            // Undoing an addition or redoing a removal removes it; the other way adds it back.
            let removes = undo == matches!(change, RemoteChange::Added { .. });
            if removes {
                if !exists(name)? {
                    return Err(diverged(name));
                }
                return ctx
                    .run(&ctx.command(["remote", "remove", "--", name]))
                    .map(drop);
            }
            if exists(name)? {
                return Err(diverged(name));
            }
            for (key, value) in config {
                ctx.run(&ctx.command(["config", "--add", key, value]))?;
            }
            if let RemoteChange::Removed {
                tracking,
                upstreams,
                ..
            } = change
            {
                restore_tracking(ctx, name, tracking, upstreams)?;
            }
            Ok(())
        }
    }
}

/// Puts back the tracking refs (those not fetched again since) and the upstreams of the
/// branches that still exist and have none.
fn restore_tracking(
    ctx: &WriteContext<'_>,
    name: &str,
    tracking: &[DeletedRef],
    upstreams: &[(String, String)],
) -> Result<(), YagguiError> {
    for r in tracking {
        if find_ref(ctx.repo, &r.full_name)?.is_none() {
            ctx.run(&ctx.command(["update-ref", "-m", "yaggui: undo", &r.full_name, &r.sha, ""]))?;
        }
    }
    let config = ctx.repo.config_snapshot();
    for (branch, merge) in upstreams {
        let present = find_ref(ctx.repo, &format!("refs/heads/{branch}"))?.is_some();
        let free = config
            .string(format!("branch.{branch}.remote").as_str())
            .is_none();
        if present && free {
            ctx.run(&ctx.command(["config", &format!("branch.{branch}.remote"), name]))?;
            if !merge.is_empty() {
                ctx.run(&ctx.command(["config", &format!("branch.{branch}.merge"), merge]))?;
            }
        }
    }
    Ok(())
}

/// The `remote.<name>.*` entries, in file order (`url`, `fetch`, `pushurl`…).
fn remote_config(ctx: &WriteContext<'_>, name: &str) -> Result<Vec<(String, String)>, YagguiError> {
    let pattern = format!("^remote\\.{}\\.", regex_escape(name));
    let run = ctx.git.run_raw(
        &ctx.command(["config", "--local", "--null", "--get-regexp", &pattern]),
        Some(ctx.cancel),
        None,
    )?;
    // 1: no match.
    if !run.success && run.exit_code != Some(1) {
        return Err(classify(ctx, &run));
    }
    Ok(run
        .stdout
        .split('\0')
        .filter_map(|entry| {
            let (key, value) = entry.split_once('\n')?;
            Some((key.to_owned(), value.to_owned()))
        })
        .collect())
}

/// The `url` and `pushurl` entries of `name`, in file order.
fn remote_urls(ctx: &WriteContext<'_>, name: &str) -> Result<Vec<(String, String)>, YagguiError> {
    let (url, push_url) = (
        format!("remote.{name}.url"),
        format!("remote.{name}.pushurl"),
    );
    Ok(remote_config(ctx, name)?
        .into_iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case(&url) || key.eq_ignore_ascii_case(&push_url))
        .collect())
}

/// `git config --unset-all key`; a key that is not set is not an error.
fn unset_key(ctx: &WriteContext<'_>, key: &str) -> Result<(), YagguiError> {
    let run = ctx.git.run_raw(
        &ctx.command(["config", "--unset-all", key]),
        Some(ctx.cancel),
        None,
    )?;
    // 5: the key was not set, nothing to remove.
    if run.success || run.exit_code == Some(5) {
        Ok(())
    } else {
        Err(classify(ctx, &run))
    }
}

/// `name` matched literally in a `git config --get-regexp` pattern.
fn regex_escape(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if "\\.^$|?*+()[]{}".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}
