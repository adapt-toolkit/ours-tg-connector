#!/usr/bin/env bash
#
# Auto-bumps package.json version and commits + pushes the result with
# [skip ci]. Designed to run after gates on pushes to main. Override the
# target manifest with PKG_PATH (defaults to the repo-root package.json).
#
# Bump level is derived from the HEAD commit's subject using Conventional
# Commits (https://www.conventionalcommits.org):
#
#   feat:                              minor   (0.1.0 -> 0.2.0)
#   fix:                               patch   (0.1.0 -> 0.1.1)
#   feat!: / fix!: / BREAKING CHANGE:  major   (0.x.y -> 1.0.0)
#   refactor:/perf:/style:/build:/     patch   (safe default)
#     revert: / any other prefix
#   ci: / test: / docs: / chore:       none    (no bump, no commit)
#
# A commit subject containing [skip ci] or [ci skip] is always a no-op, which is
# how this avoids running on its own bump commits.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
PKG="${PKG_PATH:-package.json}"

emit() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s\n' "$1" >> "$GITHUB_OUTPUT"
  fi
}

log() { printf '[bump] %s\n' "$*"; }

no_bump() {
  log "no bump: $1"
  emit "bumped=false"
  emit "new-sha=${GITHUB_SHA:-$(git rev-parse HEAD)}"
  emit "version=$(jq -r .version "$PKG")"
  exit 0
}

# ----- parse commit message --------------------------------------------------

msg=$(git log -1 --pretty=%B HEAD)
subject=$(printf '%s\n' "$msg" | head -n1)
body=$(printf '%s\n' "$msg" | tail -n +2)

log "head subject: $subject"

if printf '%s\n' "$msg" | grep -qiE '\[skip ci\]|\[ci skip\]'; then
  no_bump "[skip ci] marker present"
fi

if printf '%s\n' "$subject" | grep -qE '^[a-z]+(\([^)]+\))?!:' \
   || printf '%s\n' "$body" | grep -qE '^BREAKING CHANGE:'; then
  level=major
else
  type=$(printf '%s\n' "$subject" | grep -oE '^[a-z]+' || true)
  case "$type" in
    feat)                                level=minor ;;
    fix)                                 level=patch ;;
    ci|test|docs|chore)                  level=none  ;;
    refactor|perf|style|build|revert|"") level=patch ;;
    *)                                   level=patch ;;
  esac
fi

if [[ "$level" == none ]]; then
  no_bump "non-shipping commit type (${type:-<empty>})"
fi

log "bump level: $level"

# ----- compute new version ---------------------------------------------------

cur=$(jq -r .version "$PKG")
IFS=. read -r major minor patch <<<"$cur"
case "$level" in
  major) new="$((major + 1)).0.0" ;;
  minor) new="${major}.$((minor + 1)).0" ;;
  patch) new="${major}.${minor}.$((patch + 1))" ;;
esac

log "version: $cur -> $new"

# ----- patch package.json (surgical sed, minimal diff) -----------------------

esc_old=${cur//./\\.}
sed -i -E "s|^(\\s*\"version\"\\s*:\\s*\")${esc_old}(\")|\\1${new}\\2|" "$PKG"
if ! grep -qE "^\\s*\"version\"\\s*:\\s*\"${new}\"" "$PKG"; then
  echo "[bump] failed to patch version in $PKG" >&2
  exit 1
fi

# ----- commit + push ---------------------------------------------------------

git config user.name  "ours-ci-version-bump[bot]"
git config user.email "ours-ci-version-bump[bot]@users.noreply.github.com"
git add "$PKG"

if git diff --cached --quiet; then
  no_bump "no changes after patch (already at target version)"
fi

src_sha=$(git rev-parse --short HEAD)
src_subj=$(printf '%s' "$subject" | head -c 200)

commit_msg=$(cat <<EOF
chore(release): v${new} [skip ci]

Triggered by ${src_sha}: ${src_subj}
EOF
)

git commit -m "$commit_msg"
git push origin "HEAD:${GITHUB_REF_NAME:-main}"

new_sha=$(git rev-parse HEAD)
log "pushed bump commit ${new_sha}"

emit "bumped=true"
emit "new-sha=${new_sha}"
emit "version=${new}"
emit "level=${level}"
