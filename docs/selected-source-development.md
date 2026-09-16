# Development before the selected SDK/CLI is published

This delivery uses SDK/CLI APIs not provided by the registry releases with the same version labels. For this source selection, plain registry installation is not the supported development recipe. Do not infer API compatibility from a version string.

Build the selected SDK repository and its CLI first, at the reviewed commit:

```sh
cd "$SDK_SOURCE"
git submodule update --init --recursive
npm ci
bash scripts/compile-mufl.sh
npm run build
npm run build:cli
npm pack --ignore-scripts --pack-destination "$PACKAGE_OUT"
(cd packages/cli && npm pack --ignore-scripts --pack-destination "$PACKAGE_OUT")
```

`SDK_SOURCE` is the selected SDK checkout; `PACKAGE_OUT` is an existing absolute output directory outside the repositories. Use private test HOME/config/state when exercising lifecycle tests. Do not point tests at an existing deployment.

In this consumer checkout, install the two actual archives as development inputs:

```sh
npm install --no-save "$PACKAGE_OUT/ours.network-sdk-3.8.0.tgz" "$PACKAGE_OUT/ours.network-cli-2.8.0.tgz"
npm run build
npm test
```

Use the filenames emitted by `npm pack` if versions change. The archives must come from the same selected SDK/CLI source, not arbitrary packages carrying those version strings. This local installation does not rewrite published dependency declarations; do not commit generated local lockfile paths. A later plain `npm install`/`npm ci` can replace these inputs with registry bytes, so repeat the explicit archive installation after changing dependencies.

For a portable delivery artifact, use the repository-owned `scripts/build-selected.mjs --sdk PATH --cli PATH --out-dir PATH` recipe instead. It stages the selected archives privately and produces the package consumed by the installer. Development installation, portable package construction, and final installation must be verified separately. Until compatible versions are published and selected, no registry-only development or release qualification is implied.
