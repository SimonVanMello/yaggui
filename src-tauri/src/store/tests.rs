use super::*;
use crate::git::ops::types::PullStrategy;

fn store() -> Store {
    Store::open_in_memory().unwrap()
}

#[test]
fn migrates_to_latest_version() {
    let store = store();
    let version: i64 = store
        .conn()
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, migrations::latest_version());
}

#[test]
fn reopening_a_file_database_keeps_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested").join(DB_FILE);
    let id = Store::open(&path).unwrap().touch_repo("/a", "a").unwrap();
    let reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened.repo(id).unwrap().map(|r| r.path),
        Some("/a".into())
    );
}

#[test]
fn touching_a_repo_is_idempotent() {
    let store = store();
    let first = store.touch_repo("/r/one", "one").unwrap();
    let second = store.touch_repo("/r/two", "two").unwrap();
    assert_ne!(first, second);
    assert_eq!(store.touch_repo("/r/one", "one").unwrap(), first);
    assert_eq!(store.list_repos().unwrap().len(), 2);
}

#[test]
fn lists_most_recent_first_and_flags_missing_folders() {
    let store = store();
    let dir = tempfile::tempdir().unwrap();
    let existing = dir.path().to_string_lossy().into_owned();
    store.touch_repo("/definitely/missing", "missing").unwrap();
    store.touch_repo(&existing, "existing").unwrap();
    // Same second: the id breaks the tie, so the latest insert comes first.
    let repos = store.list_repos().unwrap();
    assert_eq!(repos[0].name, "existing");
    assert!(repos[0].exists);
    assert!(!repos[1].exists);
}

#[test]
fn toggles_favorites_and_forgets_repos() {
    let store = store();
    let id = store.touch_repo("/r", "r").unwrap();
    store.set_favorite(id, true).unwrap();
    assert!(store.repo(id).unwrap().unwrap().favorite);
    assert!(store.set_favorite(999, true).is_err());
    store.forget_repo(id).unwrap();
    assert!(store.repo(id).unwrap().is_none());
}

#[test]
fn saves_tabs_in_order() {
    let store = store();
    let id = store.touch_repo("/r", "r").unwrap();
    let state = TabsState {
        tabs: vec![
            Tab {
                id: "b".into(),
                repo_id: Some(id),
                ui_state: Some(r#"{"sidebar":240}"#.into()),
            },
            Tab {
                id: "a".into(),
                repo_id: None,
                ui_state: None,
            },
        ],
        active_tab_id: Some("a".into()),
    };
    store.save_tabs(&state).unwrap();
    assert_eq!(store.tabs().unwrap(), state);

    // Replacing drops removed tabs.
    let fewer = TabsState {
        tabs: vec![state.tabs[1].clone()],
        active_tab_id: None,
    };
    store.save_tabs(&fewer).unwrap();
    assert_eq!(store.tabs().unwrap(), fewer);
}

#[test]
fn tabs_survive_forgotten_or_unknown_repos() {
    let store = store();
    let id = store.touch_repo("/r", "r").unwrap();
    let tab = |repo_id| Tab {
        id: format!("t{repo_id:?}"),
        repo_id,
        ui_state: None,
    };
    store
        .save_tabs(&TabsState {
            tabs: vec![tab(Some(id)), tab(Some(4242))],
            active_tab_id: Some("missing".into()),
        })
        .unwrap();
    store.forget_repo(id).unwrap();
    let tabs = store.tabs().unwrap();
    assert!(tabs.tabs.iter().all(|t| t.repo_id.is_none()));
    assert_eq!(tabs.active_tab_id, None);
}

#[test]
fn stores_preferences() {
    let store = store();
    assert_eq!(store.preferences().unwrap(), Preferences::default());
    let prefs = Preferences {
        theme: ThemePreference::Dark,
        style: ThemeStyle::Terminal,
        locale: Some(Locale::Fr),
        terminal: Some("kitty".into()),
        terminal_mode: TerminalMode::External,
        editor: Some("code".into()),
        diff_tool: Some("meld".into()),
        merge_tool: Some("kdiff3".into()),
        diff_view: DiffViewMode::Unified,
        diff_options: DiffPreferences {
            wrap: true,
            ignore_whitespace: true,
            context_lines: 10,
            full_file: true,
        },
        high_contrast: true,
        density: Density::Compact,
        ui_font: Some("Helvetica Neue".into()),
        code_font: Some("Fira Code".into()),
        font_size: 15,
        git_path: Some("/opt/git/bin/git".into()),
        auto_fetch: false,
        auto_fetch_minutes: 30,
        prune: false,
        pull_strategy: Some(PullStrategy::Rebase),
        protected_branches: vec!["main".into(), "hotfix/*".into()],
        disabled_confirmations: vec![ConfirmationKind::DropStash],
        gravatar: true,
    };
    assert_eq!(store.set_preferences(&prefs).unwrap(), prefs);
    // The same values after reopening: they are in the database, not in memory.
    assert_eq!(store.preferences().unwrap(), prefs);
    let cleared = Preferences {
        locale: None,
        terminal: None,
        ..prefs
    };
    assert_eq!(store.set_preferences(&cleared).unwrap(), cleared);
}

#[test]
fn external_tools_are_cleaned_and_validated() {
    let store = store();
    let prefs = Preferences {
        editor: Some("  zed  ".into()),
        diff_tool: Some(" meld ".into()),
        merge_tool: Some("   ".into()),
        ..Preferences::default()
    };
    let stored = store.set_preferences(&prefs).unwrap();
    assert_eq!(stored.editor.as_deref(), Some("zed"));
    assert_eq!(stored.diff_tool.as_deref(), Some("meld"));
    assert_eq!(stored.merge_tool, None);
    for bad in ["--tool=evil", "two words", "a;b", "-x"] {
        let err = store
            .set_preferences(&Preferences {
                merge_tool: Some(bad.into()),
                ..Preferences::default()
            })
            .unwrap_err();
        assert_eq!(
            err.code,
            crate::git::errors::ErrorCode::InvalidArgument,
            "{bad}"
        );
    }
    for bad in ["-x", "a\nb"] {
        let err = store
            .set_preferences(&Preferences {
                editor: Some(bad.into()),
                ..Preferences::default()
            })
            .unwrap_err();
        assert_eq!(
            err.code,
            crate::git::errors::ErrorCode::InvalidArgument,
            "{bad}"
        );
    }
}

#[test]
fn migrates_legacy_preferences_once() {
    let store = store();
    let legacy = LegacyPreferences {
        theme: Some(ThemePreference::Light),
        locale: Some(Locale::Fr),
    };
    let migrated = store.migrate_legacy_preferences(&legacy).unwrap();
    assert_eq!(
        migrated,
        Preferences {
            theme: ThemePreference::Light,
            locale: Some(Locale::Fr),
            ..Preferences::default()
        }
    );
    let again = store
        .migrate_legacy_preferences(&LegacyPreferences {
            theme: Some(ThemePreference::Dark),
            locale: None,
        })
        .unwrap();
    assert_eq!(again, migrated);
}

#[test]
fn ignores_unreadable_preference_values() {
    let store = store();
    store
        .conn()
        .execute(
            "INSERT INTO preferences (key, value) VALUES ('theme', '\"sepia\"')",
            [],
        )
        .unwrap();
    assert_eq!(store.preferences().unwrap().theme, ThemePreference::System);
}

#[test]
fn new_preferences_default_when_nothing_is_stored() {
    let prefs = store().preferences().unwrap();
    assert!(prefs.auto_fetch);
    assert_eq!(prefs.auto_fetch_minutes, 10);
    assert_eq!(prefs.font_size, 13);
    assert_eq!(prefs.density, Density::Comfortable);
    assert_eq!(
        prefs.protected_branches,
        ["main", "master", "develop", "release/*"]
    );
}

#[test]
fn rejects_out_of_range_preferences() {
    let store = store();
    let bad = |prefs: Preferences| store.set_preferences(&prefs).unwrap_err().code;
    let base = Preferences::default();
    assert_eq!(
        bad(Preferences {
            font_size: 40,
            ..base.clone()
        }),
        crate::git::errors::ErrorCode::InvalidArgument
    );
    assert_eq!(
        bad(Preferences {
            auto_fetch_minutes: 0,
            ..base.clone()
        }),
        crate::git::errors::ErrorCode::InvalidArgument
    );
    assert_eq!(
        bad(Preferences {
            ui_font: Some("a; b".into()),
            ..base.clone()
        }),
        crate::git::errors::ErrorCode::InvalidArgument
    );
    assert_eq!(
        bad(Preferences {
            protected_branches: vec!["a b".into()],
            ..base
        }),
        crate::git::errors::ErrorCode::InvalidArgument
    );
    assert_eq!(store.preferences().unwrap(), Preferences::default());
}

#[test]
fn cleans_lists_and_never_disables_the_force_push_confirmation() {
    let store = store();
    let saved = store
        .set_preferences(&Preferences {
            protected_branches: vec![" main ".into(), "".into(), "main".into(), "dev".into()],
            disabled_confirmations: vec![
                ConfirmationKind::ForcePush,
                ConfirmationKind::DeleteTag,
                ConfirmationKind::DeleteTag,
            ],
            ui_font: Some("  ".into()),
            git_path: Some(" ".into()),
            ..Preferences::default()
        })
        .unwrap();
    assert_eq!(saved.protected_branches, ["main", "dev"]);
    assert_eq!(saved.disabled_confirmations, [ConfirmationKind::DeleteTag]);
    assert_eq!(saved.ui_font, None);
    assert_eq!(saved.git_path, None);
}

#[test]
fn v1_database_upgrades_to_v2_keeping_its_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DB_FILE);
    {
        // A database as released before M2-6: schema v1 only.
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(migrations::schema_for_tests(1)).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        conn.execute(
            "INSERT INTO preferences (key, value) VALUES ('theme', '\"dark\"')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO repos (path, name, last_opened_at) VALUES ('/r', 'r', 1)",
            [],
        )
        .unwrap();
    }
    let store = Store::open(&path).unwrap();
    let version: i64 = store
        .conn()
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, migrations::latest_version());
    assert_eq!(store.preferences().unwrap().theme, ThemePreference::Dark);
    assert_eq!(store.list_repos().unwrap().len(), 1);
    // The table added by v2 works.
    store
        .touch_recent_dir(&dir.path().display().to_string())
        .unwrap();
    assert_eq!(
        store.last_recent_dir().unwrap(),
        Some(dir.path().display().to_string())
    );
}

#[test]
fn remembers_the_last_existing_folder_and_keeps_ten() {
    let dir = tempfile::tempdir().unwrap();
    let store = store();
    let old = dir.path().join("old");
    std::fs::create_dir(&old).unwrap();
    store.touch_recent_dir(&old.display().to_string()).unwrap();
    store.touch_recent_dir("/does/not/exist/anymore").unwrap();
    // The most recent folder is gone: the previous one is proposed.
    assert_eq!(
        store.last_recent_dir().unwrap(),
        Some(old.display().to_string())
    );
    for n in 0..15 {
        store.touch_recent_dir(&format!("/many/{n}")).unwrap();
    }
    let kept: i64 = store
        .conn()
        .query_row("SELECT COUNT(*) FROM recent_dirs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(kept, 10);
}

#[test]
fn stores_graph_filters_per_repo() {
    use crate::graph::types::GraphFilter;
    let store = store();
    let id = store.touch_repo("/r", "r").unwrap();
    let other = store.touch_repo("/o", "o").unwrap();
    assert_eq!(store.graph_filter(id).unwrap(), GraphFilter::default());
    let filter = GraphFilter {
        hidden: vec!["refs/heads/a".into()],
        solo: Some("refs/heads/b".into()),
        hide_remotes: true,
        hide_stashes: false,
    };
    store.set_graph_filter(id, &filter).unwrap();
    assert_eq!(store.graph_filter(id).unwrap(), filter);
    assert_eq!(store.graph_filter(other).unwrap(), GraphFilter::default());
    // Forgetting the repository drops its filter.
    store.forget_repo(id).unwrap();
    let again = store.touch_repo("/r", "r").unwrap();
    assert_eq!(store.graph_filter(again).unwrap(), GraphFilter::default());
    // Showing everything removes the row.
    store.set_graph_filter(other, &filter).unwrap();
    store
        .set_graph_filter(other, &GraphFilter::default())
        .unwrap();
    assert_eq!(store.graph_filter(other).unwrap(), GraphFilter::default());
}
