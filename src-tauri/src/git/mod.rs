//! Git access. Reads go through `gix` (`read/`), writes through the `git` binary (`cli.rs`, `ops/`).

pub mod cli;
pub mod errors;
pub mod log;
pub mod ops;
pub mod read;
pub mod redact;
