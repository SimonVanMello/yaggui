#!/usr/bin/env bash
# Graph benchmark (P-02, P-03): prepares the test repositories in <dir> (once) and measures a
# cold graph load, with and without commit-graph.
#
# Usage: scripts/bench-graph.sh <dir> [commits]
#   <dir>/git        partial clone of git/git (~80k commits, --filter=blob:none)
#   <dir>/synthetic  synthetic history of [commits] commits (default 1 300 000) via fast-import
set -euo pipefail

dir=${1:?usage: scripts/bench-graph.sh <dir> [commits]}
commits=${2:-1300000}
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$dir"

cargo build --release --quiet --manifest-path "$root/src-tauri/Cargo.toml" --example graph-bench
bench="$root/src-tauri/target/release/examples/graph-bench"

if [ ! -d "$dir/git" ]; then
  git clone --filter=blob:none --no-checkout https://github.com/git/git.git "$dir/git"
fi
if [ ! -d "$dir/synthetic" ]; then
  git init -q -b main "$dir/synthetic"
  "$bench" gen "$commits" | git -C "$dir/synthetic" fast-import --quiet
  # fast-import keeps every topic branch: keep the last 12, like a real repository.
  git -C "$dir/synthetic" for-each-ref --format='delete %(refname)' refs/heads/topic |
    awk '{ line[NR] = $0 } END { for (i = 1; i <= NR - 12; i++) print line[i] }' | git -C "$dir/synthetic" update-ref --stdin
  git -C "$dir/synthetic" pack-refs --all
fi

graph_file() { echo "$1/.git/objects/info/commit-graph"; }

for repo in "$dir/git" "$dir/synthetic"; do
  for mode in without with; do
    rm -f "$(graph_file "$repo")"
    rm -rf "$repo/.git/objects/info/commit-graphs"
    if [ "$mode" = with ]; then
      git -C "$repo" commit-graph write --reachable --no-progress
    fi
    echo "=== $(basename "$repo"), $mode commit-graph"
    # Second run: the first one also measures the OS file cache warming up.
    "$bench" run "$repo" >/dev/null
    "$bench" run "$repo" --search "fix" --path "Documentation/RelNotes"
  done
done
