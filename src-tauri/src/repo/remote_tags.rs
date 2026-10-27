//! Tags present on the remotes (opt-in `remoteTags` preference), for the cloud on the tag
//! labels of the graph. The frontend honors the preference: it only asks while it is on, so
//! no `ls-remote` runs otherwise.

use std::collections::BTreeMap;

use crate::git::cli::GitCommand;
use crate::git::errors::YagguiError;
use crate::git::read::remote_tags::{RemoteTag, local_tags, matching, parse_ls_remote};

use super::{RepoManager, lock};

impl RepoManager {
    /// Local tags found on the remotes. `refresh` (after a fetch, pull or push) lists the tags
    /// of every remote again; otherwise the last listing of the session is compared with the
    /// current local tags, and the remotes are only asked the first time. A remote that cannot
    /// be reached keeps its previous listing: this decoration never fails for the network.
    pub fn remote_tags(&self, repo_id: u32, refresh: bool) -> Result<Vec<RemoteTag>, YagguiError> {
        let session = self.session(repo_id)?;
        let repo = session.repo()?.to_thread_local();
        let remotes: Vec<String> = repo
            .remote_names()
            .iter()
            .map(|name| name.to_string())
            // Never read as an option by `ls-remote`; such a name cannot be configured anyway.
            .filter(|name| !name.starts_with('-'))
            .collect();
        // Held across the listing: concurrent requests wait for it rather than ask again.
        let mut cache = lock(&session.remote_tags);
        let first = cache.is_none();
        let listed = cache.get_or_insert_with(BTreeMap::new);
        listed.retain(|remote, _| remotes.contains(remote));
        if refresh || first {
            for remote in &remotes {
                let command = GitCommand::new(["ls-remote", "--tags", "--refs", remote.as_str()])
                    .cwd(&session.workdir)
                    .repo(repo_id);
                match self.git.run(&command) {
                    Ok(output) => {
                        listed.insert(remote.clone(), parse_ls_remote(&output.stdout));
                    }
                    Err(err) => tracing::warn!(error = %err, remote, "cannot list the remote tags"),
                }
            }
        }
        Ok(matching(&local_tags(&repo)?, listed))
    }
}
