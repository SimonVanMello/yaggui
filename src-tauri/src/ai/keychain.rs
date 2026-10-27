//! API keys in the OS keychain (F-073): Keychain on macOS, Credential Manager on Windows,
//! Secret Service on Linux. Never in `yaggui.db`, never logged, never sent to the frontend.

use std::collections::HashMap;
use std::sync::Mutex;

use super::types::AiProviderKind;

/// Service name of the keychain entries.
const SERVICE: &str = "dev.tropico.yaggui";

/// Where API keys are kept. Tests use [`MemorySecrets`]; the app, [`OsKeychain`].
pub trait SecretStore: Send + Sync {
    /// `Err` holds why the keychain cannot be used (for the status and the error detail).
    fn get(&self, provider: AiProviderKind) -> Result<Option<String>, String>;
    fn set(&self, provider: AiProviderKind, key: &str) -> Result<(), String>;
    /// Removing a key that is not there succeeds.
    fn delete(&self, provider: AiProviderKind) -> Result<(), String>;
    /// `Err` with the reason when the keychain cannot be used at all.
    fn available(&self) -> Result<(), String>;
}

/// The entry's account name: one per provider that takes a key.
fn account(provider: AiProviderKind) -> &'static str {
    match provider {
        AiProviderKind::ClaudeApi => "anthropic-api-key",
        AiProviderKind::ClaudeCode => "claude-code",
    }
}

pub struct OsKeychain;

impl OsKeychain {
    fn entry(provider: AiProviderKind) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, account(provider)).map_err(|e| e.to_string())
    }
}

impl SecretStore for OsKeychain {
    fn get(&self, provider: AiProviderKind) -> Result<Option<String>, String> {
        match Self::entry(provider)?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }

    fn set(&self, provider: AiProviderKind, key: &str) -> Result<(), String> {
        Self::entry(provider)?
            .set_password(key)
            .map_err(|e| e.to_string())
    }

    fn delete(&self, provider: AiProviderKind) -> Result<(), String> {
        match Self::entry(provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }

    fn available(&self) -> Result<(), String> {
        keyring::Entry::store_status()
            .as_ref()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// In-memory store for tests; `unavailable` simulates a machine without a keychain.
#[derive(Default)]
pub struct MemorySecrets {
    keys: Mutex<HashMap<AiProviderKind, String>>,
    pub unavailable: bool,
}

impl MemorySecrets {
    pub fn unavailable() -> Self {
        Self {
            keys: Mutex::default(),
            unavailable: true,
        }
    }

    fn check(&self) -> Result<(), String> {
        if self.unavailable {
            Err("no keychain".to_owned())
        } else {
            Ok(())
        }
    }

    fn keys(&self) -> std::sync::MutexGuard<'_, HashMap<AiProviderKind, String>> {
        self.keys
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl SecretStore for MemorySecrets {
    fn get(&self, provider: AiProviderKind) -> Result<Option<String>, String> {
        self.check()?;
        Ok(self.keys().get(&provider).cloned())
    }

    fn set(&self, provider: AiProviderKind, key: &str) -> Result<(), String> {
        self.check()?;
        self.keys().insert(provider, key.to_owned());
        Ok(())
    }

    fn delete(&self, provider: AiProviderKind) -> Result<(), String> {
        self.check()?;
        self.keys().remove(&provider);
        Ok(())
    }

    fn available(&self) -> Result<(), String> {
        self.check()
    }
}
