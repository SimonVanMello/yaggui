#!/usr/bin/env bash
# Builds a fixture repository for the integration tests. Fixtures are always generated,
# never committed as binary `.git` folders.
#
# Usage: make-fixture.sh <scenario> <empty-target-dir>
# The worktree is created at <target>/repo (plus <target>/origin.git when a remote is needed).
#
# Scenarios: clean, dirty, detached, rebase, merge, diverged, unborn, stale-lock, worktree,
# not-a-repo, history, history-detached, diff, wide, inspect, submodule, lfs, branches
set -euo pipefail

scenario=$1
target=$2
mkdir -p "$target"
cd "$target"

# Isolate from the machine's Git configuration (signing, hooks, default branch…).
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME="yaggui Tests" GIT_AUTHOR_EMAIL="tests@yaggui.dev"
export GIT_COMMITTER_NAME="yaggui Tests" GIT_COMMITTER_EMAIL="tests@yaggui.dev"
export GIT_AUTHOR_DATE="2026-01-01T12:00:00Z" GIT_COMMITTER_DATE="2026-01-01T12:00:00Z"
export GIT_EDITOR=: GIT_SEQUENCE_EDITOR=:

commit() { # commit <file> <content> <message>
  printf '%s\n' "$2" > "$1"
  git add -- "$1"
  git commit -q -m "$3"
}

# One minute later than the previous commit: distinct dates make `git log` order unambiguous.
tick=0
tick() {
  tick=$((tick + 1))
  local date="@$((1767268800 + tick * 60)) +0000"
  export GIT_AUTHOR_DATE="$date" GIT_COMMITTER_DATE="$date"
}
dated() { # dated <file> <content> <message>
  tick
  commit "$@"
}
merge() { # merge <message> <ref>...
  local message=$1
  shift
  tick
  git merge -q --no-ff -m "$message" "$@" >/dev/null
}

# History with every graph shape: forks, merges, criss-cross, octopus, orphan branch,
# light and annotated tags, a remote, an unpushed commit and a stash.
history() {
  git init -q --bare -b main origin.git
  git init -q -b main repo
  cd repo
  dated a.txt 1 "initial"
  dated a.txt 2 "main 2"
  git checkout -q -b feat/a
  dated b.txt 1 "a 1"
  dated b.txt 2 "a 2"
  git checkout -q main
  dated a.txt 3 "main 3"
  git checkout -q -b feat/b HEAD~1
  dated c.txt 1 "b 1"
  git checkout -q main
  merge "Merge feat/a" feat/a
  git checkout -q -b x
  dated x.txt 1 "x 1"
  git checkout -q -b y main
  dated y.txt 1 "y 1"
  git checkout -q x
  merge "Merge y into x" y
  git checkout -q y
  merge "Merge x into y" x~1
  for n in 1 2 3; do
    git checkout -q -b "o$n" main
    dated "o$n.txt" "$n" "octo $n"
  done
  git checkout -q main
  merge "Octopus" o1 o2 o3
  git branch -q -D o1 o2 o3
  git checkout -q --orphan pages
  git rm -rqf .
  dated index.html 1 "pages 1"
  dated index.html 2 "pages 2"
  git checkout -q main
  git tag v0.1 main~2
  tick
  git tag -a v0.2 -m "Release 0.2" main
  git remote add origin ../origin.git
  git push -q origin main feat/b
  git branch -q -u origin/main
  dated a.txt 4 "main 4"
  printf 'dirty\n' >> a.txt
  tick
  git stash -q
}

# Repo with two commits on main, pushed to a bare `origin` and tracking it.
base_with_origin() {
  git init -q --bare -b main origin.git
  git init -q -b main repo
  cd repo
  commit README.md "# Fixture" "initial commit"
  commit src.txt "line 1" "add src"
  git remote add origin ../origin.git
  git push -q -u origin main
}

case "$scenario" in
  clean)
    base_with_origin
    ;;
  dirty)
    base_with_origin
    printf 'build/\n' > .gitignore
    git add .gitignore && git commit -q -m "ignore build"
    git push -q
    printf 'changed\n' >> src.txt                     # unstaged
    printf 'new\n' > staged.txt && git add staged.txt  # staged
    printf 'both\n' >> README.md && git add README.md  # staged…
    printf 'again\n' >> README.md                      # …and unstaged
    printf 'notes\n' > notes.txt                       # untracked
    mkdir -p newdir build
    printf 'a\n' > newdir/a.txt && printf 'b\n' > newdir/b.txt  # untracked dir (one entry)
    printf 'obj\n' > build/out.o                       # ignored
    ;;
  detached)
    base_with_origin
    git checkout -q --detach HEAD~1
    ;;
  diverged)
    base_with_origin
    # Two commits pushed from elsewhere, one local commit not pushed.
    git clone -q ../origin.git ../other
    (cd ../other && commit remote1.txt "r1" "remote 1" && commit remote2.txt "r2" "remote 2" && git push -q)
    commit local.txt "l1" "local 1"
    git fetch -q
    ;;
  rebase)
    base_with_origin
    git checkout -q -b feature
    commit src.txt "feature change" "feature: edit src"
    commit feature.txt "more" "feature: add file"
    git checkout -q main
    commit src.txt "main change" "main: edit src"
    git checkout -q feature
    # Conflicts on the first of two commits: stops at step 1/2.
    git rebase main >/dev/null 2>&1 || true
    ;;
  merge)
    base_with_origin
    git checkout -q -b other
    commit src.txt "other change" "other: edit src"
    git checkout -q main
    commit src.txt "main change" "main: edit src"
    git merge other >/dev/null 2>&1 || true
    ;;
  unborn)
    git init -q -b main repo
    ;;
  stale-lock)
    base_with_origin
    : > .git/index.lock
    # `-t` is understood by both GNU and BSD touch.
    touch -t 202001010000 .git/index.lock
    ;;
  worktree)
    # Linked worktree at <target>/wt, sharing refs and config with <target>/repo.
    base_with_origin
    git worktree add -q -b wt ../wt
    ;;
  history)
    history
    ;;
  history-detached)
    history
    git checkout -q --detach main~1
    ;;
  not-a-repo)
    mkdir -p repo
    printf 'plain folder\n' > repo/file.txt
    ;;
  diff)
    # One commit touching every kind of change the diff view handles, then staged,
    # unstaged and untracked changes on top.
    git init -q -b main repo
    cd repo
    mkdir -p src docs assets
    printf 'export const a = 1;\nexport function hello() {\n  return "hi";\n}\n' > src/app.ts
    printf '# Remove me\n' > docs/remove.md
    for i in $(seq 1 15); do printf 'const value%s = %s;\n' "$i" "$i"; done > src/old_name.ts
    printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x01' > assets/logo.png
    awk 'BEGIN { for (i = 1; i <= 120000; i++) printf "line %06d of a large generated file....\n", i }' > big.txt
    printf 'one\ntwo\nthree\n' > crlf.txt
    printf '#!/bin/sh\necho hi\n' > run.sh
    printf 'caf\xe9\n' > latin1.txt
    git add -A
    # Modes go through the index: Windows has no exec bit (`core.fileMode=false`).
    git update-index --chmod=-x run.sh
    git update-index --add --cacheinfo 160000,1111111111111111111111111111111111111111,libs/sub
    mkdir -p libs/sub  # unpopulated submodule, so `git add -A` keeps the gitlink
    git commit -q -m "base"
    # The showcase commit.
    printf 'export const a = 2;\nexport function hello() {\n  return "hello";\n}\n' > src/app.ts
    git rm -q docs/remove.md
    git mv src/old_name.ts src/new_name.ts
    sed -i.bak -e 's/value3 = 3/value3 = 33/' -e 's/value9 = 9/value9 = 99/' src/new_name.ts
    rm src/new_name.ts.bak
    printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x02\x00\x03' > assets/logo.png
    sed -i.bak 's/line 060000 of/line 060000 OF/' big.txt && rm big.txt.bak
    awk 'BEGIN { for (i = 1; i <= 6000; i++) printf "{\"id\": %d},\n", i }' > generated.json
    printf 'one\r\ntwo\r\nthree\r\n' > crlf.txt
    chmod +x run.sh
    printf 'caf\xe9 cr\xe8me\n' > latin1.txt
    mkdir -p docs && printf 'new file\n' > docs/added.md
    git add -A
    git update-index --chmod=+x run.sh
    git update-index --cacheinfo 160000,2222222222222222222222222222222222222222,libs/sub
    git commit -q -m "diff showcase"
    # Working tree.
    printf 'export const a = 3;\nexport function hello() {\n  return "hello";\n}\n' > src/app.ts
    git add src/app.ts                                    # staged
    printf 'staged\n' > docs/staged.md && git add docs/staged.md
    printf 'one\r\ntwo\r\nthree\r\nfour\r\n' > crlf.txt     # unstaged
    rm docs/added.md                                      # unstaged deletion
    printf 'notes\n' > notes.txt                          # untracked
    ;;
  inspect)
    # File history, blame and reflog (M4-4): a file renamed twice (with an edit, then pure),
    # edited on both sides of a merge, a binary, reflog moves and uncommitted changes.
    git init -q -b main repo
    cd repo
    mkdir -p src assets
    lines() { printf '%s\n' "$@"; }
    lines one two three four five > src/lib.txt
    lines other > other.txt
    git add -A && tick && git commit -q -m "add lib"
    lines one TWO three four five > src/lib.txt
    git add -A && tick && git commit -q -m "edit lib"
    lines noise > other.txt
    git add -A && tick && git commit -q -m "touch other"
    mkdir -p core && git mv src/lib.txt core/lib.txt
    lines one TWO three four five six > core/lib.txt
    git add -A && tick && git commit -q -m "move lib to core"
    git checkout -q -b side
    lines one TWO three four FIVE six > core/lib.txt
    git add -A && tick && git commit -q -m "side: edit lib"
    git checkout -q main
    lines ONE TWO three four five six > core/lib.txt
    git add -A && tick && git commit -q -m "main: edit lib"
    merge "merge side" side
    git mv core/lib.txt core/library.txt
    tick && git commit -q -m "rename to library"
    printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x01' > assets/logo.png
    git add -A && tick && git commit -q -m "add logo"
    # Reflog: a checkout round trip, a commit undone by a reset.
    git checkout -q side && git checkout -q main
    lines oops > oops.txt
    git add -A && tick && git commit -q -m "oops"
    git reset -q --hard HEAD~1
    # Working tree: an uncommitted edit, a file only staged, an untracked one.
    lines ONE TWO local four FIVE six > core/library.txt
    lines staged > staged.txt && git add staged.txt
    lines untracked > untracked.txt
    ;;
  wide)
    # P-05: a large flat-ish worktree, YAGGUI_WIDE_FILES files (default 50 000) in folders of
    # 100, plus a .gitignore'd build folder, all committed.
    files=${YAGGUI_WIDE_FILES:-50000}
    git init -q -b main repo
    cd repo
    awk -v n="$files" 'BEGIN {
      for (i = 0; i < n; i++) {
        dir = sprintf("src/m%03d/d%03d", int(i / 10000), int(i / 100) % 100)
        if (i % 100 == 0) system("mkdir -p " dir)
        printf "file %d\nline two\nline three\n", i > (dir "/f" i ".txt")
        close(dir "/f" i ".txt")
      }
    }'
    printf 'target/\n' > .gitignore
    mkdir -p target && printf 'build\n' > target/out.o
    git add -A
    git commit -q -m "wide"
    ;;
  submodule)
    # <target>/lib (2 commits) is the submodule's upstream. The repo records it twice:
    # libs/lib checked out, libs/other declared but not initialized.
    git init -q -b main lib
    (cd lib && commit lib.txt "lib 1" "lib 1" && commit lib.txt "lib 2" "lib 2")
    git init -q -b main repo
    cd repo
    commit README.md "# Fixture" "initial commit"
    git -c protocol.file.allow=always submodule add -q ../lib libs/lib
    git -c protocol.file.allow=always submodule add -q ../lib libs/other
    git commit -q -m "add submodules"
    git submodule deinit -q -f libs/other
    rm -rf .git/modules/libs/other
    ;;
  lfs)
    # Files routed to LFS by .gitattributes, committed as pointers (no git-lfs needed): one
    # changed pointer in the working tree, one plain file next to them.
    git init -q -b main repo
    cd repo
    printf '*.bin filter=lfs diff=lfs merge=lfs -text\n' > .gitattributes
    mkdir -p assets
    pointer() { # pointer <file> <hex digit> <size>
      printf 'version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %s\n' \
        "$(printf "%064d" 0 | tr 0 "$2")" "$3" > "$1"
    }
    pointer assets/model.bin a 1048576
    pointer assets/other.bin b 42
    printf 'plain\n' > notes.txt
    git add -A
    git commit -q -m "lfs files"
    pointer assets/model.bin c 2097152
    git add assets/model.bin
    git commit -q -m "bigger model"
    pointer assets/model.bin d 3145728
    printf 'plain, edited\n' > notes.txt
    ;;
  branches)
    # Branch cleanup, comparison and image diffs (M4-7b): merged, unmerged, [gone], protected
    # and worktree branches; a PNG and an SVG changed by a commit and in the working tree.
    base_with_origin
    git branch merged
    git branch release/1
    git checkout -q -b feat/wip
    dated wip.txt 1 "wip 1"
    dated wip.txt 2 "wip 2"
    git checkout -q -b gone
    dated gone.txt 1 "gone 1"
    git push -q -u origin gone
    git push -q origin --delete gone
    git fetch -q --prune
    git checkout -q main
    git worktree add -q ../wt -b in-worktree
    dated main.txt 1 "main 3"
    printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x01' > logo.png
    printf '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>\n' > icon.svg
    git add logo.png icon.svg
    tick
    git commit -q -m "images"
    printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x02' > logo.png
    git add logo.png
    tick
    git commit -q -m "bigger logo"
    printf '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>\n' > icon.svg
    ;;
  *)
    echo "unknown scenario: $scenario" >&2
    exit 2
    ;;
esac
