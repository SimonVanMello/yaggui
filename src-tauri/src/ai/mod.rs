//! AI commit messages (F-072 to F-075): context building, prompt, providers and parsing.
//!
//! Off until the user turns it on. A provider implements [`provider::CommitMessageProvider`];
//! [`service::AiService`] reads the context, builds the prompt, runs the provider, records the
//! call in the command log and parses the answer.

pub mod claude_api;
pub mod claude_code;
pub mod context;
pub mod glob;
pub mod keychain;
pub mod parse;
pub mod prefs;
pub mod prompt;
pub mod provider;
pub mod service;
pub mod skills;
pub mod types;

pub use service::AiService;
pub use types::*;
