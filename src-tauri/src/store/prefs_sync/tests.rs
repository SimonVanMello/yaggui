use super::*;
use crate::git::errors::ErrorCode;
use crate::store::{DiffViewMode, ThemePreference};

fn setup() -> (Store, tempfile::TempDir) {
    (
        Store::open_in_memory().unwrap(),
        tempfile::tempdir().unwrap(),
    )
}

fn binding(action: &str, shortcut: Option<&str>) -> KeybindingOverride {
    KeybindingOverride {
        action: action.into(),
        shortcut: shortcut.map(Into::into),
    }
}

fn write_file(dir: &tempfile::TempDir, text: &str) -> std::path::PathBuf {
    let path = dir.path().join("sync.json");
    std::fs::write(&path, text).unwrap();
    path
}

#[test]
fn export_leaves_machine_specific_settings_out() {
    let prefs = Preferences {
        git_path: Some("/opt/git/bin/git".into()),
        editor: Some("code".into()),
        terminal: Some("iTerm".into()),
        diff_tool: Some("meld".into()),
        merge_tool: Some("meld".into()),
        check_updates: Some(true),
        font_size: 15,
        ..Preferences::default()
    };
    let text = export_text(&prefs, &[binding("tab.new", Some("Mod+N"))]).unwrap();
    let file: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(file["format"], FORMAT);
    assert_eq!(file["version"], VERSION);
    let exported = file["preferences"].as_object().unwrap();
    for key in MACHINE_SPECIFIC {
        assert!(!exported.contains_key(key), "{key} must not be exported");
    }
    assert_eq!(exported.len(), PORTABLE.len());
    assert_eq!(exported["fontSize"], 15);
    assert_eq!(file["keybindings"][0]["action"], "tab.new");
}

#[test]
fn every_setting_is_portable_or_machine_specific() {
    let keys = to_object(&Preferences::default()).unwrap();
    for key in keys.keys() {
        let known = PORTABLE.contains(&key.as_str()) ^ MACHINE_SPECIFIC.contains(&key.as_str());
        assert!(known, "{key} must be listed exactly once");
    }
    assert_eq!(keys.len(), PORTABLE.len() + MACHINE_SPECIFIC.len());
}

#[test]
fn export_then_import_round_trips() {
    let (source, source_dir) = setup();
    let wanted = Preferences {
        theme: ThemePreference::Dark,
        diff_view: DiffViewMode::Unified,
        font_size: 16,
        protected_branches: vec!["main".into(), "hotfix/*".into()],
        ..source.preferences().unwrap()
    };
    source.set_preferences(&wanted).unwrap();
    keybindings::write(
        source_dir.path(),
        &[binding("tab.new", Some("Mod+N")), binding("git.push", None)],
    )
    .unwrap();
    let file = source_dir.path().join("export.json");
    export_to(&file, &source, source_dir.path()).unwrap();

    let (target, target_dir) = setup();
    target
        .set_preferences(&Preferences {
            editor: Some("vim".into()),
            ..Preferences::default()
        })
        .unwrap();
    let preview = preview_from(&file, &target, target_dir.path()).unwrap();
    let keys: Vec<_> = preview.changes.iter().map(|c| c.key.as_str()).collect();
    assert_eq!(keys, ["theme", "diffView", "fontSize", "protectedBranches"]);
    assert_eq!(preview.keybinding_changes.len(), 2);
    assert!(preview.ignored.is_empty());

    let applied = apply_from(&file, &target, target_dir.path()).unwrap();
    assert_eq!(applied.preferences.theme, ThemePreference::Dark);
    assert_eq!(applied.preferences.font_size, 16);
    assert_eq!(applied.preferences, target.preferences().unwrap());
    // A machine-specific setting of the target is untouched.
    assert_eq!(applied.preferences.editor.as_deref(), Some("vim"));
    assert_eq!(applied.keybindings.overrides.len(), 2);
    assert!(
        preview_from(&file, &target, target_dir.path())
            .unwrap()
            .changes
            .is_empty()
    );
}

#[test]
fn import_replaces_the_shortcuts_and_keeps_absent_preferences() {
    let (store, dir) = setup();
    keybindings::write(dir.path(), &[binding("tab.close", Some("Mod+Q"))]).unwrap();
    let path = write_file(
        &dir,
        r#"{"format":"yaggui-preferences","version":1,"preferences":{"density":"compact"},
            "keybindings":[{"action":"tab.new","shortcut":"Mod+N"}]}"#,
    );
    let preview = preview_from(&path, &store, dir.path()).unwrap();
    assert_eq!(preview.changes.len(), 1);
    let removed = preview
        .keybinding_changes
        .iter()
        .find(|c| c.action == "tab.close")
        .unwrap();
    assert!(removed.before.custom && !removed.after.custom);
    apply_from(&path, &store, dir.path()).unwrap();
    let overrides = keybindings::read(dir.path()).overrides;
    assert_eq!(overrides, [binding("tab.new", Some("Mod+N"))]);
    assert_eq!(store.preferences().unwrap().font_size, 13);
}

#[test]
fn machine_specific_and_unknown_keys_are_ignored_and_listed() {
    let (store, dir) = setup();
    let path = write_file(
        &dir,
        r#"{"format":"yaggui-preferences","version":1,"preferences":
            {"gitPath":"/usr/bin/git","editor":"code","futureSetting":1,"prune":false}}"#,
    );
    let preview = preview_from(&path, &store, dir.path()).unwrap();
    assert_eq!(preview.changes.len(), 1);
    let ignored: Vec<_> = preview
        .ignored
        .iter()
        .map(|i| (i.key.as_str(), i.reason))
        .collect();
    assert!(ignored.contains(&("gitPath", IgnoredReason::MachineSpecific)));
    assert!(ignored.contains(&("editor", IgnoredReason::MachineSpecific)));
    assert!(ignored.contains(&("futureSetting", IgnoredReason::Unknown)));
    apply_from(&path, &store, dir.path()).unwrap();
    let prefs = store.preferences().unwrap();
    assert!(!prefs.prune);
    assert_eq!(prefs.git_path, None);
    assert_eq!(prefs.editor, None);
}

#[test]
fn a_file_with_the_former_terminal_style_keeps_its_colors() {
    let (store, dir) = setup();
    let path = write_file(
        &dir,
        r#"{"format":"yaggui-preferences","version":1,"preferences":
            {"theme":"light","style":"terminal"}}"#,
    );
    apply_from(&path, &store, dir.path()).unwrap();
    let prefs = store.preferences().unwrap();
    assert_eq!(prefs.dark_theme, "terminal");
    assert_eq!(prefs.theme, crate::store::ThemePreference::Dark);
}

#[test]
fn theme_ids_travel_between_machines() {
    let (store, dir) = setup();
    let path = write_file(
        &dir,
        r#"{"format":"yaggui-preferences","version":1,"preferences":
            {"lightTheme":"latte","darkTheme":"mocha","style":"terminal"}}"#,
    );
    apply_from(&path, &store, dir.path()).unwrap();
    let prefs = store.preferences().unwrap();
    assert_eq!(
        (prefs.light_theme.as_str(), prefs.dark_theme.as_str()),
        ("latte", "mocha")
    );
}

fn code_of(text: &str) -> ErrorCode {
    parse(text, &Preferences::default()).err().unwrap().code
}

#[test]
fn invalid_files_are_rejected_with_a_typed_error() {
    for text in [
        "not json",
        "[]",
        r#"{"version":1,"preferences":{}}"#,
        r#"{"format":"other","version":1}"#,
        r#"{"format":"yaggui-preferences","version":"1"}"#,
        r#"{"format":"yaggui-preferences","version":0}"#,
        r#"{"format":"yaggui-preferences","version":1,"preferences":[]}"#,
        r#"{"format":"yaggui-preferences","version":1,"preferences":{"theme":"neon"}}"#,
        r#"{"format":"yaggui-preferences","version":1,"preferences":{"fontSize":99}}"#,
        r#"{"format":"yaggui-preferences","version":1,"preferences":{"fontSize":"big"}}"#,
        r#"{"format":"yaggui-preferences","version":1,"preferences":{"autoFetchMinutes":0}}"#,
        r#"{"format":"yaggui-preferences","version":1,"keybindings":{"tab.new":"Mod+N"}}"#,
        r#"{"format":"yaggui-preferences","version":1,"keybindings":[{"action":"tab.new","shortcut":"Hyper+N"}]}"#,
        r#"{"format":"yaggui-preferences","version":1,"keybindings":[{"action":"bad id","shortcut":null}]}"#,
    ] {
        assert_eq!(code_of(text), ErrorCode::PreferencesFileInvalid, "{text}");
    }
}

#[test]
fn a_newer_version_is_refused_with_its_own_error() {
    let err = parse(
        r#"{"format":"yaggui-preferences","version":2,"preferences":{}}"#,
        &Preferences::default(),
    )
    .err()
    .unwrap();
    assert_eq!(err.code, ErrorCode::PreferencesFileTooNew);
    assert!(err.message.en.contains("version 2"));
}

#[test]
fn one_bad_value_rejects_the_whole_file_and_changes_nothing() {
    let (store, dir) = setup();
    keybindings::write(dir.path(), &[binding("tab.close", Some("Mod+Q"))]).unwrap();
    let path = write_file(
        &dir,
        r#"{"format":"yaggui-preferences","version":1,
            "preferences":{"density":"compact","fontSize":99},"keybindings":[]}"#,
    );
    let err = apply_from(&path, &store, dir.path()).unwrap_err();
    assert_eq!(err.code, ErrorCode::PreferencesFileInvalid);
    assert!(err.detail.unwrap().contains("fontSize"));
    assert_eq!(store.preferences().unwrap(), Preferences::default());
    assert_eq!(keybindings::read(dir.path()).overrides.len(), 1);
}

#[test]
fn a_missing_or_oversized_file_is_invalid() {
    let (store, dir) = setup();
    let missing = dir.path().join("nope.json");
    assert_eq!(
        preview_from(&missing, &store, dir.path()).unwrap_err().code,
        ErrorCode::PreferencesFileInvalid
    );
    let path = write_file(
        &dir,
        &" ".repeat(usize::try_from(MAX_FILE_BYTES).unwrap() + 1),
    );
    assert_eq!(
        preview_from(&path, &store, dir.path()).unwrap_err().code,
        ErrorCode::PreferencesFileInvalid
    );
}

#[test]
fn identical_files_change_nothing() {
    let (store, dir) = setup();
    let path = dir.path().join("same.json");
    export_to(&path, &store, dir.path()).unwrap();
    let preview = preview_from(&path, &store, dir.path()).unwrap();
    assert!(preview.changes.is_empty() && preview.keybinding_changes.is_empty());
}
