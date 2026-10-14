//! Fails when `src/ipc/bindings.ts` is out of date with the Rust commands.

use std::path::Path;

#[test]
fn bindings_are_up_to_date() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let committed_path = manifest_dir.join(yaggui_lib::BINDINGS_PATH);
    let fresh_path =
        std::env::temp_dir().join(format!("yaggui-bindings-{}.ts", std::process::id()));

    yaggui_lib::export_bindings(&fresh_path).expect("export bindings");
    let fresh = std::fs::read_to_string(&fresh_path).expect("read fresh bindings");
    let _ = std::fs::remove_file(&fresh_path);
    let committed = std::fs::read_to_string(&committed_path).expect("read committed bindings");

    assert!(
        fresh == committed,
        "src/ipc/bindings.ts is stale: run `pnpm bindings` and commit the result"
    );
}
