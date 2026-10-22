pub mod commands;
pub mod events;
pub mod git;
pub mod graph;
pub mod repo;
pub mod state;
pub mod store;
pub mod system;

use std::sync::Arc;

use tauri::Manager;
use tauri_specta::{Builder, collect_commands, collect_events};
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

/// Path of the generated TypeScript bindings, relative to the `src-tauri` crate root.
pub const BINDINGS_PATH: &str = "../src/ipc/bindings.ts";

/// Single source of truth for the IPC surface: every command exposed to the
/// frontend is registered here, so the generated bindings always match.
pub fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::app::app_info,
            commands::app::launch_path,
            commands::app::changelog,
            commands::repo::open_repo,
            commands::repo::close_repo,
            commands::repo::repo_state,
            commands::repo::cancel_op,
            commands::repo::remove_stale_index_lock,
            commands::repo::add_safe_directory,
            commands::graph::graph_page,
            commands::graph::graph_index_of,
            commands::graph::search_commits,
            commands::graph::commit_detail,
            commands::graph::list_refs,
            commands::store::list_repos,
            commands::store::set_repo_favorite,
            commands::store::forget_repo,
            commands::store::get_tabs,
            commands::store::save_tabs,
            commands::store::get_repo_ui_state,
            commands::store::save_repo_ui_state,
            commands::store::get_preferences,
            commands::store::set_preferences,
            commands::store::git_binary_info,
            commands::store::migrate_legacy_preferences,
            commands::settings::get_keybindings,
            commands::settings::set_keybindings,
            commands::settings::export_preferences,
            commands::settings::preview_preferences_import,
            commands::settings::apply_preferences_import,
            commands::settings::git_config_list,
            commands::settings::git_config_set,
            commands::settings::check_external_tool,
            commands::settings::open_in_editor,
            commands::log::command_log,
            commands::log::clear_command_log,
            commands::system::open_terminal,
            commands::system::pick_repo_folder,
            commands::avatars::avatar,
            commands::avatars::clear_avatar_cache,
            commands::updates::check_for_update,
            commands::updates::install_update,
            commands::updates::open_release_page,
            commands::updates::update_in_terminal,
            commands::updates::restart_app,
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_close,
            commands::create::new_repo_defaults,
            commands::create::clone_repo,
            commands::create::cancel_clone,
            commands::create::init_repo,
            commands::diff::changed_files,
            commands::diff::file_diff,
            commands::diff::worktree_file,
            commands::write::stage_paths,
            commands::write::unstage_paths,
            commands::write::stage_hunks,
            commands::write::unstage_hunks,
            commands::write::discard_hunks,
            commands::write::discard_paths,
            commands::write::save_worktree_file,
            commands::write::commit,
            commands::write::last_commit_message,
            commands::write::git_identity,
            commands::write::set_git_identity,
            commands::refs::validate_ref_name,
            commands::refs::checkout,
            commands::refs::create_branch,
            commands::refs::rename_branch,
            commands::refs::delete_branch,
            commands::refs::set_upstream,
            commands::refs::unset_upstream,
            commands::refs::stash_push,
            commands::refs::stash_apply,
            commands::refs::stash_apply_file,
            commands::refs::stash_pop,
            commands::refs::stash_drop,
            commands::refs::stash_rename,
            commands::refs::stash_branch,
            commands::refs::create_tag,
            commands::refs::delete_tag,
            commands::history::merge,
            commands::history::rebase,
            commands::history::cherry_pick,
            commands::history::revert,
            commands::history::reset_preview,
            commands::history::reset,
            commands::history::operation_detail,
            commands::history::continue_operation,
            commands::history::skip_operation,
            commands::history::abort_operation,
            commands::history::list_conflicts,
            commands::history::resolve_conflicts,
            commands::history::conflict_versions,
            commands::history::conflict_image,
            commands::history::merge_tool,
            commands::history::run_merge_tool,
            commands::history::interactive_rebase_plan,
            commands::history::interactive_rebase,
            commands::history::reword_commit,
            commands::history::commit_fixup,
            commands::history::autosquash_plan,
            commands::inspect::file_history,
            commands::inspect::line_history,
            commands::inspect::blame,
            commands::inspect::reflog,
            commands::inspect::cancel_read,
            commands::network::list_remotes,
            commands::network::pull_default_strategy,
            commands::network::fetch,
            commands::network::pull,
            commands::network::push,
            commands::network::force_push_preview,
            commands::network::push_tag,
            commands::network::delete_remote_tag,
            commands::network::delete_remote_branch,
            commands::remotes::validate_remote_name,
            commands::remotes::remote_removal_preview,
            commands::remotes::add_remote,
            commands::remotes::rename_remote,
            commands::remotes::set_remote_urls,
            commands::remotes::remove_remote,
            commands::remotes::push_all_tags,
            commands::remotes::fetch_tags,
            commands::undo::undo,
            commands::undo::redo,
            commands::undo::undo_state,
            commands::undo::op_history,
            commands::workspaces::list_workspaces,
            commands::workspaces::create_workspace,
            commands::workspaces::rename_workspace,
            commands::workspaces::delete_workspace,
            commands::workspaces::add_to_workspace,
            commands::workspaces::remove_from_workspace,
            commands::workspaces::repo_overview,
            commands::workspaces::fetch_known_repo,
            commands::workspaces::scan_folder,
            commands::workspaces::cancel_scan,
            commands::workspaces::import_repos,
            commands::workspaces::relocate_repo,
            commands::modules::submodule_status,
            commands::modules::update_submodules,
            commands::modules::create_worktree,
            commands::modules::worktree_remove_preview,
            commands::modules::remove_worktree,
            commands::modules::prune_worktrees,
            commands::modules::lfs_status,
            commands::modules::lfs_pull,
            commands::modules::lfs_track,
            commands::commit_tools::commit_settings,
            commands::commit_tools::verify_commit_signature,
            commands::commit_tools::recent_commit_messages,
            commands::commit_tools::list_commit_templates,
            commands::commit_tools::save_commit_template,
            commands::commit_tools::delete_commit_template,
            commands::commit_tools::list_identity_profiles,
            commands::commit_tools::save_identity_profile,
            commands::commit_tools::delete_identity_profile,
            commands::commit_tools::gitignore_preview,
            commands::commit_tools::add_to_gitignore,
            commands::commit_tools::stash_push_paths,
            commands::graph_tools::graph_filter,
            commands::graph_tools::set_graph_filter,
            commands::graph_tools::merge_base,
            commands::graph_tools::compare_revisions,
            commands::graph_tools::diff_image,
            commands::graph_tools::run_diff_tool,
            commands::graph_tools::reveal_path,
            commands::graph_tools::branch_cleanup,
            commands::graph_tools::delete_branches,
        ])
        .events(collect_events![
            events::CommandLogged,
            events::OpStarted,
            events::OpProgress,
            events::CloneProgress,
            events::UpdateProgress,
            events::ScanProgress,
            events::OpFinished,
            events::StatusChanged,
            events::RefsChanged,
            events::GraphProgress,
            events::JournalChanged,
            events::PtyOutput,
            events::PtyExited,
        ])
        .constant("GRAPH_COLORS", graph::types::GRAPH_COLORS)
        .constant("GRAPH_MAX_LANES", graph::types::GRAPH_MAX_LANES)
        .constant("GRAPH_PAGE_SIZE", graph::types::GRAPH_PAGE_SIZE)
        .constant("FONT_SIZE_MIN", *store::FONT_SIZE_RANGE.start())
        .constant("FONT_SIZE_MAX", *store::FONT_SIZE_RANGE.end())
        .constant("AUTO_FETCH_MIN_MINUTES", *store::AUTO_FETCH_RANGE.start())
        .constant("AUTO_FETCH_MAX_MINUTES", *store::AUTO_FETCH_RANGE.end())
        .constant("EDGE_NORMAL", graph::types::edge_kind::NORMAL)
        .constant("EDGE_MERGE", graph::types::edge_kind::MERGE)
        .constant("EDGE_WIP", graph::types::edge_kind::WIP)
        .constant("SIGNATURE_NONE", graph::types::signature_code::NONE)
        .constant("SIGNATURE_GPG", graph::types::signature_code::GPG)
        .constant("SIGNATURE_SSH", graph::types::signature_code::SSH)
        .constant("SIGNATURE_X509", graph::types::signature_code::X509)
        .constant("SIGNATURE_UNKNOWN", graph::types::signature_code::UNKNOWN)
        .constant("REBASE_PLAN_MAX", git::ops::types::REBASE_PLAN_MAX)
        .constant("JOURNAL_PATHS_MAX", git::ops::types::JOURNAL_PATHS_MAX)
        .constant(
            "GITIGNORE_PREVIEW_MAX",
            git::ops::types::GITIGNORE_PREVIEW_MAX,
        )
        .constant("SCAN_DEPTH_MIN", *repo::scan::SCAN_DEPTH_RANGE.start())
        .constant("SCAN_DEPTH_MAX", *repo::scan::SCAN_DEPTH_RANGE.end())
        .constant("WORKSPACE_NAME_MAX", store::MAX_WORKSPACE_NAME)
        .constant("COMPARE_MAX_COMMITS", graph::types::COMPARE_MAX_COMMITS)
        .constant("GRAPH_FILTER_MAX", graph::types::GRAPH_FILTER_MAX)
}

/// Writes the TypeScript bindings to `path`.
pub fn export_bindings(path: &std::path::Path) -> Result<(), specta_typescript::Error> {
    specta_builder().export(
        specta_typescript::Typescript::default().header("// Regenerate with `pnpm bindings`."),
        path,
    )
}

/// The main window starts hidden (no unstyled flash) and the frontend shows it once rendered.
/// If the frontend never gets there (crash before mount, failed load), show it anyway so the
/// user is not left with an invisible app.
/// Longer in debug builds: Vite serves every module separately there, so the first render
/// regularly takes more than 2 s.
const SHOW_WINDOW_FALLBACK: std::time::Duration = if cfg!(debug_assertions) {
    std::time::Duration::from_secs(8)
} else {
    std::time::Duration::from_secs(2)
};

fn show_window_fallback(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(SHOW_WINDOW_FALLBACK);
        let Some(window) = app.get_webview_window("main") else {
            tracing::warn!("main window not found for the show fallback");
            return;
        };
        if window.is_visible().unwrap_or(false) {
            return;
        }
        tracing::warn!("frontend did not show the window in time, showing it as a fallback");
        if let Err(err) = window.show() {
            tracing::error!(error = %err, "failed to show the main window");
        }
    });
}

/// Set to measure the startup (P-01, `scripts/measure-startup.mjs`): prints when the window
/// becomes visible, then quits.
pub const PERF_PROBE_ENV: &str = "YAGGUI_PERF_PROBE";

/// The frontend shows the window once the restored tabs are rendered: visible means usable.
fn perf_probe(app: tauri::AppHandle, started: std::time::Instant) {
    std::thread::spawn(move || {
        let deadline = started + std::time::Duration::from_secs(20);
        while std::time::Instant::now() < deadline {
            let visible = app
                .get_webview_window("main")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);
            if visible {
                let since_epoch = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or_default();
                println!(
                    "yaggui-perf window-visible since_run_ms={} unix_ms={since_epoch}",
                    started.elapsed().as_millis()
                );
                // Let pending IPC (tab saving) finish before quitting.
                std::thread::sleep(std::time::Duration::from_millis(400));
                app.exit(0);
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        println!("yaggui-perf timeout");
        app.exit(2);
    });
}

pub fn run() {
    let started = std::time::Instant::now();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    // Before the webview reads its text input settings.
    system::keyboard::enable_key_repeat();
    // In the background: the first Git command waits for it only if it is still running.
    system::shell_env::resolve_in_background();

    let builder = specta_builder();

    match tauri::Builder::default()
        // The macOS menu is built by the frontend (localized, wired to the tab shortcuts);
        // Tauri's default one would bind ⌘W to "Close Window".
        .enable_macos_default_menu(false)
        // Only used from Rust (`pick_repo_folder`): no dialog permission is granted to the webview.
        .plugin(tauri_plugin_dialog::init())
        // Only used from Rust (`install_update`), like the dialog plugin.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            let config_dir = state::config_dir(app.path().app_config_dir()?);
            tracing::info!(path = %config_dir.display(), "config folder");
            let cache_dir = state::cache_dir(app.path().app_cache_dir()?);
            let sink = Arc::new(events::TauriSink(app.handle().clone()));
            app.manage(AppState::new(
                state::open_store(&config_dir),
                sink,
                &config_dir,
                &cache_dir,
            ));
            show_window_fallback(app.handle().clone());
            if std::env::var_os(PERF_PROBE_ENV).is_some() {
                perf_probe(app.handle().clone(), started);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
    {
        Ok(app) => app.run(|app, event| {
            // Shells must not outlive the app (Unix would hang them up, Windows would not).
            if let tauri::RunEvent::Exit = event
                && let Some(state) = app.try_state::<AppState>()
            {
                state.ptys.close_all();
            }
        }),
        Err(err) => {
            tracing::error!(error = %err, "failed to run the Tauri application");
            std::process::exit(1);
        }
    }
}
