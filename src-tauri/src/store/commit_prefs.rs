//! What the commit panel remembers (M4-7a): identity profiles (F-070), message templates
//! (F-067) and the recent messages of each repo (F-068).

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::{Store, now, to_id};
use crate::git::errors::YagguiError;

/// Recent messages kept per repo; the oldest are forgotten first.
pub const RECENT_MESSAGES_KEPT: u32 = 30;
/// Longest accepted template body, in bytes.
pub const MAX_COMMIT_TEMPLATE: u32 = 16 * 1024;
const MAX_LABEL: usize = 100;

/// A name / email pair the user can apply to a repo (`git config --local`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IdentityProfile {
    /// `None` when saving a new profile.
    pub id: Option<u32>,
    /// Shown in the picker ("Personal", "Work").
    pub label: String,
    pub name: String,
    pub email: String,
}

/// A commit message template written in yaggui (the one of `commit.template` is read from Git).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitTemplate {
    pub id: Option<u32>,
    pub name: String,
    /// Full message: summary line, blank line, description.
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecentCommitMessage {
    pub message: String,
    /// Unix time, milliseconds.
    pub used_at: f64,
}

fn invalid(en: impl Into<String>, fr: impl Into<String>) -> YagguiError {
    YagguiError::invalid_argument(en, fr)
}

/// One line, not blank, without what `git config` or an ident would choke on.
fn one_line(value: &str, ident: bool) -> Option<String> {
    let value = value.trim();
    let bad = value.is_empty()
        || value.chars().count() > MAX_LABEL * 3
        || value.contains(['\n', '\r', '\0'])
        || (ident && value.contains(['<', '>']));
    (!bad).then(|| value.to_owned())
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
        .floor()
}

impl Store {
    // ---- Identity profiles -------------------------------------------------------------

    /// Profiles sorted by label (case-insensitive).
    pub fn identity_profiles(&self) -> Result<Vec<IdentityProfile>, YagguiError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, label, name, email FROM identity_profiles
             ORDER BY label COLLATE NOCASE, id",
        )?;
        let profiles = stmt
            .query_map([], |row| {
                Ok(IdentityProfile {
                    id: u32::try_from(row.get::<_, i64>(0)?).ok(),
                    label: row.get(1)?,
                    name: row.get(2)?,
                    email: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(profiles)
    }

    /// Creates (`id` of `None`) or replaces a profile; returns it with its id.
    pub fn save_identity_profile(
        &self,
        profile: &IdentityProfile,
    ) -> Result<IdentityProfile, YagguiError> {
        let (Some(label), Some(name), Some(email)) = (
            one_line(&profile.label, false).filter(|l| l.chars().count() <= MAX_LABEL),
            one_line(&profile.name, true),
            one_line(&profile.email, true).filter(|e| e.contains('@') && !e.contains(' ')),
        ) else {
            return Err(invalid(
                "A profile needs a label, a name and an email address, each on one line.",
                "Un profil demande un libellé, un nom et une adresse e-mail, chacun sur une ligne.",
            ));
        };
        let conn = self.conn();
        let id = match profile.id {
            Some(id) => {
                let changed = conn.execute(
                    "UPDATE identity_profiles SET label = ?2, name = ?3, email = ?4 WHERE id = ?1",
                    params![id, label, name, email],
                )?;
                if changed == 0 {
                    return Err(unknown("profile", "profil", id));
                }
                id
            }
            None => {
                conn.execute(
                    "INSERT INTO identity_profiles (label, name, email, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![label, name, email, now()],
                )?;
                to_id(conn.last_insert_rowid())?
            }
        };
        Ok(IdentityProfile {
            id: Some(id),
            label,
            name,
            email,
        })
    }

    pub fn delete_identity_profile(&self, id: u32) -> Result<(), YagguiError> {
        self.conn()
            .execute("DELETE FROM identity_profiles WHERE id = ?1", [id])?;
        Ok(())
    }

    // ---- Commit templates --------------------------------------------------------------

    pub fn commit_templates(&self) -> Result<Vec<CommitTemplate>, YagguiError> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT id, name, body FROM commit_templates ORDER BY name COLLATE NOCASE")?;
        let templates = stmt
            .query_map([], |row| {
                Ok(CommitTemplate {
                    id: u32::try_from(row.get::<_, i64>(0)?).ok(),
                    name: row.get(1)?,
                    body: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(templates)
    }

    /// Creates or replaces a template. Names are unique (case-insensitive).
    pub fn save_commit_template(
        &self,
        template: &CommitTemplate,
    ) -> Result<CommitTemplate, YagguiError> {
        let Some(name) = one_line(&template.name, false).filter(|n| n.chars().count() <= MAX_LABEL)
        else {
            return Err(invalid(
                "A template needs a name, on one line.",
                "Un modèle demande un nom, sur une ligne.",
            ));
        };
        let body = template.body.trim_end().to_owned();
        if body.trim().is_empty()
            || body.len() > MAX_COMMIT_TEMPLATE as usize
            || body.contains('\0')
        {
            return Err(invalid(
                format!("A template needs a text of at most {MAX_COMMIT_TEMPLATE} bytes."),
                format!("Un modèle demande un texte d'au plus {MAX_COMMIT_TEMPLATE} octets."),
            ));
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let clash: Option<i64> = tx
            .query_row(
                "SELECT id FROM commit_templates WHERE name = ?1 COLLATE NOCASE",
                [&name],
                |row| row.get(0),
            )
            .optional()?;
        if clash.is_some_and(|other| Some(other) != template.id.map(i64::from)) {
            return Err(invalid(
                format!("A template named \"{name}\" already exists."),
                format!("Un modèle nommé « {name} » existe déjà."),
            ));
        }
        let id = match template.id {
            Some(id) => {
                let changed = tx.execute(
                    "UPDATE commit_templates SET name = ?2, body = ?3 WHERE id = ?1",
                    params![id, name, body],
                )?;
                if changed == 0 {
                    return Err(unknown("template", "modèle", id));
                }
                id
            }
            None => {
                tx.execute(
                    "INSERT INTO commit_templates (name, body, created_at) VALUES (?1, ?2, ?3)",
                    params![name, body, now()],
                )?;
                to_id(tx.last_insert_rowid())?
            }
        };
        tx.commit()?;
        Ok(CommitTemplate {
            id: Some(id),
            name,
            body,
        })
    }

    pub fn delete_commit_template(&self, id: u32) -> Result<(), YagguiError> {
        self.conn()
            .execute("DELETE FROM commit_templates WHERE id = ?1", [id])?;
        Ok(())
    }

    // ---- Recent commit messages --------------------------------------------------------

    /// Remembers a message committed in `repo_id` (moved to the top if already known).
    pub fn add_recent_commit_message(
        &self,
        repo_id: u32,
        message: &str,
    ) -> Result<(), YagguiError> {
        let message = message.trim();
        if message.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        // Strictly increasing, so two commits in the same millisecond keep their order.
        let last: Option<f64> = tx.query_row(
            "SELECT MAX(used_at) FROM recent_commit_messages WHERE repo_id = ?1",
            [repo_id],
            |row| row.get(0),
        )?;
        let used_at = last.map_or(now_ms(), |last| now_ms().max(last + 1.0));
        tx.execute(
            "INSERT INTO recent_commit_messages (repo_id, message, used_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(repo_id, message) DO UPDATE SET used_at = excluded.used_at",
            params![repo_id, message, used_at],
        )?;
        tx.execute(
            "DELETE FROM recent_commit_messages WHERE repo_id = ?1 AND message NOT IN
             (SELECT message FROM recent_commit_messages WHERE repo_id = ?1
              ORDER BY used_at DESC LIMIT ?2)",
            params![repo_id, RECENT_MESSAGES_KEPT],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Messages of `repo_id`, most recent first.
    pub fn recent_commit_messages(
        &self,
        repo_id: u32,
    ) -> Result<Vec<RecentCommitMessage>, YagguiError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT message, used_at FROM recent_commit_messages WHERE repo_id = ?1
             ORDER BY used_at DESC",
        )?;
        let messages = stmt
            .query_map([repo_id], |row| {
                Ok(RecentCommitMessage {
                    message: row.get(0)?,
                    used_at: row.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(messages)
    }
}

fn unknown(en: &str, fr: &str, id: u32) -> YagguiError {
    invalid(
        format!("Unknown {en} #{id}."),
        format!("{fr} n°{id} inconnu."),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    #[test]
    fn profiles_are_saved_updated_and_deleted() {
        let store = store();
        let work = store
            .save_identity_profile(&IdentityProfile {
                id: None,
                label: " Work ".into(),
                name: "Ada Lovelace".into(),
                email: "ada@corp.example".into(),
            })
            .unwrap();
        assert_eq!(work.label, "Work");
        let id = work.id.unwrap();
        store
            .save_identity_profile(&IdentityProfile {
                label: "Job".into(),
                ..work.clone()
            })
            .unwrap();
        assert_eq!(store.identity_profiles().unwrap()[0].label, "Job");
        let bad = IdentityProfile {
            id: None,
            label: "x".into(),
            name: "Eve <evil>".into(),
            email: "e@x".into(),
        };
        assert!(store.save_identity_profile(&bad).is_err());
        store.delete_identity_profile(id).unwrap();
        assert!(store.identity_profiles().unwrap().is_empty());
    }

    #[test]
    fn template_names_are_unique() {
        let store = store();
        let t = store
            .save_commit_template(&CommitTemplate {
                id: None,
                name: "Fix".into(),
                body: "fix: \n\nRefs #\n\n".into(),
            })
            .unwrap();
        assert_eq!(t.body, "fix: \n\nRefs #");
        let clash = CommitTemplate {
            id: None,
            name: "fix".into(),
            body: "x".into(),
        };
        assert!(store.save_commit_template(&clash).is_err());
        // Renaming itself is fine.
        store
            .save_commit_template(&CommitTemplate {
                name: "FIX".into(),
                ..t
            })
            .unwrap();
        assert_eq!(store.commit_templates().unwrap()[0].name, "FIX");
    }

    #[test]
    fn recent_messages_are_deduplicated_and_capped() {
        let store = store();
        let repo = store.touch_repo("/tmp/r", "r").unwrap();
        for i in 0..(RECENT_MESSAGES_KEPT + 5) {
            store
                .add_recent_commit_message(repo, &format!("message {i}"))
                .unwrap();
        }
        store.add_recent_commit_message(repo, "message 0").unwrap();
        let messages = store.recent_commit_messages(repo).unwrap();
        assert_eq!(messages.len(), RECENT_MESSAGES_KEPT as usize);
        assert_eq!(messages[0].message, "message 0");
        store.forget_repo(repo).unwrap();
        assert!(store.recent_commit_messages(repo).unwrap().is_empty());
    }
}
