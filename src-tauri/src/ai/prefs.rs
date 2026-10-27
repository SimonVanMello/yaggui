//! Validation of the AI preferences before they are stored.

use serde_json::Value;

use super::types::*;
use crate::git::errors::YagguiError;

/// Longest model id or skill name accepted.
const NAME_MAX: usize = 200;

impl AiPreferences {
    /// The settings as they will be stored: texts trimmed, lists cleaned. Rejects values out
    /// of range and names that could be taken for an option once passed as an argument.
    pub fn normalized(&self) -> Result<Self, YagguiError> {
        let mut ai = self.clone();
        check_range(
            ai.max_diff_bytes,
            &AI_DIFF_BYTES_RANGE,
            "Maximum diff size",
            "Taille maximale du diff",
        )?;
        check_range(
            ai.max_file_bytes,
            &AI_FILE_BYTES_RANGE,
            "Maximum size per file",
            "Taille maximale par fichier",
        )?;
        check_range(
            ai.recent_subjects,
            &AI_RECENT_SUBJECTS_RANGE,
            "Recent subjects",
            "Sujets récents",
        )?;
        check_range(
            ai.timeout_seconds,
            &AI_TIMEOUT_RANGE,
            "Time limit (seconds)",
            "Délai (secondes)",
        )?;

        let model = ai.claude_api.model.trim();
        ai.claude_api.model = if model.is_empty() {
            DEFAULT_CLAUDE_API_MODEL.to_owned()
        } else {
            clean_name(model, "model")?
        };
        ai.claude_code.model = optional_name(ai.claude_code.model.take(), "model")?;
        ai.claude_code.skill = optional_name(ai.claude_code.skill.take(), "skill")?;

        ai.custom_prompt = ai.custom_prompt.take().filter(|p| !p.trim().is_empty());
        if let Some(prompt) = &ai.custom_prompt
            && prompt.chars().count() > AI_PROMPT_MAX as usize
        {
            return Err(YagguiError::invalid_argument(
                format!("The prompt is limited to {AI_PROMPT_MAX} characters."),
                format!("Le prompt est limité à {AI_PROMPT_MAX} caractères."),
            ));
        }

        let mut patterns: Vec<String> = Vec::new();
        for pattern in &ai.excluded_paths {
            let pattern = pattern.trim();
            if pattern.is_empty() || patterns.iter().any(|p| p == pattern) {
                continue;
            }
            if pattern.chars().count() > NAME_MAX || pattern.chars().any(char::is_control) {
                return Err(YagguiError::invalid_argument(
                    format!("\"{pattern}\" is not a valid path pattern."),
                    format!("« {pattern} » n'est pas un motif de chemin valide."),
                ));
            }
            patterns.push(pattern.to_owned());
        }
        if patterns.len() > AI_EXCLUDED_PATHS_MAX {
            return Err(YagguiError::invalid_argument(
                format!("At most {AI_EXCLUDED_PATHS_MAX} excluded paths are supported."),
                format!("{AI_EXCLUDED_PATHS_MAX} chemins exclus au plus sont pris en charge."),
            ));
        }
        ai.excluded_paths = patterns;
        Ok(ai)
    }
}

impl AiPreferences {
    /// Reads settings saved by any version: keys missing (an older version) take their
    /// default, unknown keys (a newer one) are ignored, and an unreadable value falls back to
    /// the defaults rather than breaking the preferences.
    pub fn from_json(value: Value) -> Self {
        let Ok(defaults) = serde_json::to_value(Self::default()) else {
            return Self::default();
        };
        serde_json::from_value(merge_json(defaults, value)).unwrap_or_else(|err| {
            tracing::warn!(error = %err, "ignoring unreadable AI preferences");
            Self::default()
        })
    }
}

/// `overlay`'s values over `base`, object by object: what `overlay` lacks keeps `base`'s.
pub fn merge_json(base: Value, overlay: Value) -> Value {
    match (base, overlay) {
        (Value::Object(mut base), Value::Object(overlay)) => {
            for (key, value) in overlay {
                let merged = match base.remove(&key) {
                    Some(previous) => merge_json(previous, value),
                    None => value,
                };
                base.insert(key, merged);
            }
            Value::Object(base)
        }
        (_, overlay) => overlay,
    }
}

fn check_range<T: PartialOrd + std::fmt::Display>(
    value: T,
    range: &std::ops::RangeInclusive<T>,
    en: &str,
    fr: &str,
) -> Result<(), YagguiError> {
    if range.contains(&value) {
        return Ok(());
    }
    Err(YagguiError::invalid_argument(
        format!(
            "{en} must be between {} and {}.",
            range.start(),
            range.end()
        ),
        format!(
            "{fr} : une valeur entre {} et {} est attendue.",
            range.start(),
            range.end()
        ),
    ))
}

/// A model id or a skill name: it ends up in a command-line argument or a request, so it
/// stays a plain word (`claude-haiku-5-5`, `plugin:commit`, `us.anthropic.x-v1:0`).
pub fn is_plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= NAME_MAX
        && !name.starts_with(['-', '.', '/'])
        && name.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '@' | '/' | '[' | ']')
        })
}

fn clean_name(name: &str, kind: &str) -> Result<String, YagguiError> {
    if is_plain_name(name) {
        return Ok(name.to_owned());
    }
    let (en, fr) = match kind {
        "skill" => ("skill name", "nom de skill"),
        _ => ("model name", "nom de modèle"),
    };
    Err(YagguiError::invalid_argument(
        format!("\"{name}\" is not a valid {en} (letters, digits, - _ . : @ / only)."),
        format!("« {name} » n'est pas un {fr} valide (lettres, chiffres, - _ . : @ / seulement)."),
    ))
}

fn optional_name(value: Option<String>, kind: &str) -> Result<Option<String>, YagguiError> {
    let Some(value) = value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    clean_name(&value, kind).map(Some)
}

/// A program path typed by the user (`claude`): trimmed, `None` when empty, refused when it
/// could be read as an option.
pub fn clean_program_path(value: Option<String>) -> Result<Option<String>, YagguiError> {
    let Some(value) = value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if value.len() > 1024 || value.chars().any(char::is_control) || value.starts_with('-') {
        return Err(YagguiError::invalid_argument(
            "The Claude Code path must be a program name or a path.",
            "Le chemin de Claude Code doit être un nom de programme ou un chemin.",
        ));
    }
    Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_partial_and_newer_settings() {
        let ai = AiPreferences::from_json(serde_json::json!({
            "provider": "claudeCode",
            "claudeCode": { "skill": "commit" },
            "futureKey": 1,
        }));
        assert_eq!(ai.provider, AiProviderKind::ClaudeCode);
        assert_eq!(ai.claude_code.skill.as_deref(), Some("commit"));
        assert_eq!(ai.claude_api.model, DEFAULT_CLAUDE_API_MODEL);
        assert_eq!(ai.max_diff_bytes, DEFAULT_AI_DIFF_BYTES);
        assert_eq!(
            AiPreferences::from_json(serde_json::json!({ "provider": 3 })),
            AiPreferences::default()
        );
    }

    #[test]
    fn defaults_are_valid() {
        let ai = AiPreferences::default();
        assert_eq!(ai.normalized().unwrap(), ai);
    }

    #[test]
    fn cleans_lists_and_names() {
        let ai = AiPreferences {
            excluded_paths: vec![" *.lock ".into(), "".into(), "*.lock".into()],
            custom_prompt: Some("  ".into()),
            claude_api: ClaudeApiSettings { model: " ".into() },
            claude_code: ClaudeCodeSettings {
                model: Some(" haiku ".into()),
                skill: Some("".into()),
            },
            ..AiPreferences::default()
        }
        .normalized()
        .unwrap();
        assert_eq!(ai.excluded_paths, vec!["*.lock".to_owned()]);
        assert_eq!(ai.custom_prompt, None);
        assert_eq!(ai.claude_api.model, DEFAULT_CLAUDE_API_MODEL);
        assert_eq!(ai.claude_code.model.as_deref(), Some("haiku"));
        assert_eq!(ai.claude_code.skill, None);
    }

    #[test]
    fn refuses_option_like_names_and_out_of_range_values() {
        let with_skill = |skill: &str| AiPreferences {
            claude_code: ClaudeCodeSettings {
                model: None,
                skill: Some(skill.into()),
            },
            ..AiPreferences::default()
        };
        assert!(
            with_skill("--dangerously-skip-permissions")
                .normalized()
                .is_err()
        );
        assert!(with_skill("commit me").normalized().is_err());
        assert!(with_skill("plugin:commit").normalized().is_ok());
        let tiny = AiPreferences {
            max_diff_bytes: 10,
            ..AiPreferences::default()
        };
        assert!(tiny.normalized().is_err());
        assert!(clean_program_path(Some("-x".into())).is_err());
        assert_eq!(
            clean_program_path(Some(" /usr/bin/claude ".into())).unwrap(),
            Some("/usr/bin/claude".into())
        );
    }
}
