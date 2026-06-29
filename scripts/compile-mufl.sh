#!/bin/bash
# Compile the connector packet (mufl_code/actor.mu) into a content-hashed
# .muflo and install it into mufl_code/ (replacing the old one — build.mjs
# copies whatever single .muflo it finds via locateUnit).
#
#   ADAPT_TOOLKIT=/path/to/adapt-toolkit scripts/compile-mufl.sh
#
# The compiler binary is NOT in @adapt-toolkit/sdk (that package only loads an
# existing .muflo). Build it once from the toolkit checkout:
#   python3 build.py --compiler_release   # -> build/mufl-compile
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
src_dir="$here/mufl_code"

toolkit="${ADAPT_TOOLKIT:-/home/shakhvit/work/adapt/adapt-toolkit}"
if [ ! -d "$toolkit" ]; then
  echo "error: ADAPT toolkit not found at '$toolkit' (set ADAPT_TOOLKIT)." >&2
  exit 1
fi

platform="$(uname | tr '[:upper:]' '[:lower:]')"
mufl_compile=""
for cand in \
  "$toolkit/build/mufl-compile" \
  "$toolkit/build.$platform.release/mufl-compile" \
  "$toolkit/build.$platform.debug/mufl-compile"; do
  if [ -x "$cand" ]; then mufl_compile="$cand"; break; fi
done
if [ -z "$mufl_compile" ]; then
  echo "error: mufl-compile not found under '$toolkit' — build it with 'python3 build.py --compiler_release'." >&2
  exit 1
fi

if [ ! -f "$src_dir/core/config.mufl" ]; then
  echo "error: shared mufl core missing at '$src_dir/core' — run 'git submodule update --init'." >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
cp "$src_dir/actor.mu" "$src_dir/config.mufl" "$tmp_dir/"
mkdir "$tmp_dir/core"
cp "$src_dir/core/config.mufl" "$src_dir/core"/*.mm "$tmp_dir/core/"

echo "compiling actor.mu with $mufl_compile …"
( cd "$tmp_dir" && MUFL_STDLIB_PATH="$toolkit/mufl_stdlib" \
    "$mufl_compile" -mp "$toolkit/meta" -mp "$toolkit/transactions" -d-c actor.mu >/dev/null )

muflo="$(cd "$tmp_dir" && ls *.muflo)"
rm -f "$src_dir"/*.muflo
cp "$tmp_dir/$muflo" "$src_dir/"
echo "done: $src_dir/$muflo"
