// Bundles the connector into self-contained ESM so it runs straight from a clone
// (only the native ADAPT SDK stays external — see below). Outputs:
//   dist/connector.js  ← the daemon (loaded by the CLI's `serve`)
//   dist/cli.js        ← the CLI entrypoint (bin: ours-tg-connector)
//
// Run via `npm run build`.

import { build } from 'esbuild';
import { mkdir, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  // The ADAPT SDK pulls in a native NAPI addon + WASM blob that cannot be
  // bundled — keep it external and resolve from node_modules at runtime.
  external: ['@adapt-toolkit/sdk', '@adapt-toolkit/sdk/*', '@adapt-toolkit/sdk-native'],
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

// Ship the compiled MUFL packet alongside the bundle; the daemon loads the
// single .muflo it finds in dist/mufl_code/ at runtime (see locateUnit()).
const muflSrc = resolve(root, 'mufl_code');
if (existsSync(muflSrc)) {
  await cp(muflSrc, resolve(dist, 'mufl_code'), {
    recursive: true,
    filter: (src) => !src.includes('/core/.git') && !src.endsWith('/.git'),
  });
}
