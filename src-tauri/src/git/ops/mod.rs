//! Write operations, always executed through `cli.rs` via the per-repo `OpQueue`.

pub mod commit_graph;
pub mod config;
pub mod gitignore;
pub mod modules;
pub mod patch;
pub mod rebase_todo;
pub mod remotes;
pub mod types;
