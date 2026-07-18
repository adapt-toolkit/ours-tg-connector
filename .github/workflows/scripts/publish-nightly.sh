#!/usr/bin/env bash
#
# The ONLY way this repo publishes a nightly. Atomically: run the fail-closed guard, then
# `npm publish --tag nightly`. The `--tag nightly` is hardcoded here and the guard runs in the
# same process, so there is no arrangement of CI steps that publishes a nightly to any other tag
# (in particular never the default @latest) — a nightly either reaches the `nightly` tag or fails.
#
# Single-package repo (unlike ours-mcp's monorepo): the package.json is the repo root.
#
# Usage: publish-nightly.sh   (no args; publishes the root package to the nightly tag)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pkg_json="package.json"
[[ -f "$pkg_json" ]] || { echo "publish-nightly: no package.json at repo root" >&2; exit 1; }

# Fail closed BEFORE the publish: version must be -nightly.N and the tag must be `nightly`.
bash "$here/publish-guard.sh" nightly "$pkg_json" nightly

npm publish --tag nightly --access public
