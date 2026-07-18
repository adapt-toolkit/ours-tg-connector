#!/usr/bin/env bash
#
# EPHEMERAL nightly versioning for the single-package tg-connector, mirroring ours-mcp's
# nightly mode (scripts/bump-versions.sh) but for one package.json.
#
# Computes  <patch-bump(base)>-nightly.N  where:
#   base = max(local package.json version, npm-published @latest)   — always publishable
#   N    = 1 + the highest existing <base'>-nightly.* index on npm  — collision-free
# and writes it into the WORKING TREE only. It is NEVER committed or pushed, so N re-derives
# from npm every run and the prerelease branch history stays clean. By semver every
# X.Y.Z-nightly.N sorts BELOW the clean X.Y.Z, so a nightly can never move @latest.
#
# Unlike ours-mcp (which bumps the MINOR because its lockstep cycle targets a clean minor),
# the connector has no lockstep cycle: we bump the PATCH so nightlies track the connector's own
# semver line (e.g. published 0.1.7 -> nightlies 0.1.8-nightly.N). Override the level with
# NIGHTLY_BUMP_LEVEL=minor|patch if a cycle ever targets a clean minor instead.
#
# OURS_BUMP_DRY_RUN=1: patch the working tree, print the version, exit WITHOUT any git/npm side
# effects beyond the local edit (caller reverts).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
PKG="package.json"
NAME="$(jq -r .name "$PKG")"
LEVEL="${NIGHTLY_BUMP_LEVEL:-patch}"

emit() { [[ -n "${GITHUB_OUTPUT:-}" ]] && printf '%s\n' "$1" >> "$GITHUB_OUTPUT" || true; }
log()  { printf '[nightly-bump] %s\n' "$*"; }

bump() { # <version> <level>
  local a b c; IFS=. read -r a b c <<<"$1"
  case "$2" in
    minor) echo "${a}.$((b + 1)).0" ;;
    patch|*) echo "${a}.${b}.$((c + 1))" ;;
  esac
}

# Highest existing <base>-nightly.<N> index published on npm, else 0. Robust against npm view
# returning a JSON array, a single string, or nothing.
nightly_max_index() { # <pkg-name> <base>
  npm view "$1" versions --json 2>/dev/null | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      let a; try { a = JSON.parse(s || "[]"); } catch { a = []; }
      if (!Array.isArray(a)) a = [a];
      const re = new RegExp("^" + process.argv[1].replace(/[.]/g,"\\.") + "-nightly\\.(\\d+)$");
      let max = 0;
      for (const v of a) { const m = re.exec(String(v)); if (m) max = Math.max(max, parseInt(m[1],10)); }
      process.stdout.write(String(max));
    });
  ' "$2"
}

local_v="$(jq -r .version "$PKG")"
pub_v="$(npm view "$NAME" version 2>/dev/null || echo "0.0.0")"   # @latest only; nightlies never raise the base
base="$(printf '%s\n%s\n' "$local_v" "$pub_v" | sort -V | tail -1)"
log "$NAME: local $local_v, published(@latest) $pub_v -> base $base"

nightly_base="$(bump "$base" "$LEVEL")"                            # e.g. 0.1.7 -> 0.1.8
maxn="$(nightly_max_index "$NAME" "$nightly_base")"
UNIFIED="${nightly_base}-nightly.$((maxn + 1))"
log "nightly: base $base -> $nightly_base -> $UNIFIED (N = $maxn + 1)"

# Patch the working tree (surgical sed; minimal diff).
esc="${local_v//./\\.}"
sed -i -E "s|^(\\s*\"version\"\\s*:\\s*\")${esc}(\")|\\1${UNIFIED}\\2|" "$PKG"
grep -qE "^\\s*\"version\"\\s*:\\s*\"${UNIFIED//./\\.}\"" "$PKG" \
  || { echo "[nightly-bump] failed to patch version in $PKG" >&2; exit 1; }

if [[ -n "${OURS_BUMP_DRY_RUN:-}" ]]; then
  log "DRY RUN — working tree at $(jq -r .version "$PKG"); no commit/push."
  emit "bumped=true"; emit "version=${UNIFIED}"
  exit 0
fi

# EPHEMERAL: version is set in the working tree for the publish job; NOT committed or pushed.
log "nightly: version $UNIFIED set in the working tree; NOT committing (publish runs from here)."
emit "bumped=true"
emit "version=${UNIFIED}"
emit "new-sha=${GITHUB_SHA:-$(git rev-parse HEAD)}"
