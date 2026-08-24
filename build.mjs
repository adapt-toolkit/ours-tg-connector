// Bundles the connector into self-contained ESM so it runs straight from a clone.
// Outputs:
//   dist/connector.js  ← the daemon (loaded by the CLI's `serve`)
//   dist/cli.js        ← the CLI entrypoint (bin: ours-tg-connector)
//
// Run via `npm run build`.

import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // THE ALIAS IS LOAD-BEARING. A banner is raw text injected AFTER bundling, so
  // esbuild's renamer never sees its identifiers. esbuild renames the bundled
  // dependencies' `createRequire` imports to createRequire2, createRequire16,
  // createRequire29 … and leaves ONE un-suffixed; with a bare banner that one
  // collided, and dist/connector.js died at load with
  //   SyntaxError: Identifier 'createRequire' has already been declared
  // while `npm run build` exited 0. Do not "simplify" this back.
  banner: { js: "import { createRequire as __tgCreateRequire } from 'node:module'; const require = __tgCreateRequire(import.meta.url);" },
  // THE CONNECTOR NO LONGER BUNDLES AN ENGINE. It is an HTTP client of a running
  // ours daemon, so there is no native NAPI addon, no WASM blob and no ADAPT SDK
  // here at all — the whole `external` list went with them. @ours.network/sdk IS
  // bundled: only its typed client and the daemon-selection resolver are reached
  // from this tree, and neither touches the engine.
  logLevel: 'info',
};

await build({
  ...shared,
  entryPoints: [resolve(root, 'src/connector.ts')],
  outfile: resolve(dist, 'connector.js'),
});

await build({
  ...shared,
  entryPoints: [resolve(root, 'src/cli.ts')],
  outfile: resolve(dist, 'cli.js'),
});

// NO MUFL IS SHIPPED. This repo used to carry its own actor.mu, its own
// protocol_container.mm and a core submodule pinned at edbb11a, compile them, and
// copy the packet into dist/. All of it is gone: the daemon owns the packet, and
// @ours.network/sdk ships it inside its own tarball.
//
// The pin moved as a CONSEQUENCE OF THE DELETION, not by a submodule bump —
// edbb11a -> 4b6704ff in one step, because there is no longer a second core to
// disagree. That is a protocol-compatibility change for a deployed connector
// node, and it is authorised (see the PR body).
