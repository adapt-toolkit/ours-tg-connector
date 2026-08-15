// RUN THE SHIPPED ARTEFACT. Not "was a file written" — RUN it.
//
// THIS TEST EXISTS BECAUSE THE PIPELINE WAS GREEN AND THE PUBLISHED BUNDLE COULD
// NOT LOAD. `npm run build` exited 0 and printed a size; `npm test` ran every
// suite through tsx FROM SOURCE and passed. Nothing in either step ever executed
// dist/, and publish.yml then did `npm ci && npm run build && npm publish`. So the
// gate proved THE SOURCE WORKS while the pipeline shipped THE BUNDLE, and no step
// connected the two. `ours-tg-connector serve` died at load with:
//
//   SyntaxError: Identifier 'createRequire' has already been declared
//
// BOTH ENTRY POINTS ARE CHECKED, and that is the point rather than thoroughness
// for its own sake. The build emits dist/cli.js (~27 KB, no SDK — it parsed fine)
// and dist/connector.js (~3.2 MB, bundles the SDK — it did not). cli.js loads
// connector.js only for `serve`, so `--help` and `status` worked and the one
// command anybody runs was dead. Checking only the file `bin` points at would
// have passed on the broken build.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };

const ENTRIES = ['dist/cli.js', 'dist/connector.js'];

for (const rel of ENTRIES) {
  const file = join(ROOT, rel);
  // A missing artefact is a failure, not a skip: a suite that quietly skips when
  // dist/ is absent is green on a bundle nobody built.
  const size = statSync(file).size;
  ok(size > 10_000, `${rel} exists and is a real bundle (${Math.round(size / 1024)} KB)`);

  // PARSE-CHECK EVERY ENTRY. `node --check` compiles the module without running
  // it, so this is safe for connector.js, which would otherwise start connecting.
  const res = await new Promise((r) => {
    const c = spawn(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => (err += d));
    c.on('exit', (code) => r({ code, err }));
  });
  ok(res.code === 0, `${rel} PARSES${res.code === 0 ? '' : `\n    ${res.err.split('\n').slice(0, 3).join('\n    ')}`}`);
}

// And actually EXECUTE the one that is safe to execute. Parsing is necessary and
// not sufficient — a bundle can parse and still fail on its first top-level await.
const help = await new Promise((r) => {
  const c = spawn(process.execPath, [join(ROOT, 'dist/cli.js'), '--help'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  c.stdout.on('data', (d) => (out += d));
  c.stderr.on('data', (d) => (err += d));
  c.on('exit', (code) => r({ code, out, err }));
});
ok(help.code === 0, `\`node dist/cli.js --help\` exits 0${help.code === 0 ? '' : `\n    ${help.err.slice(0, 200)}`}`);
ok(help.out.includes('ours-tg-connector'), 'and prints its usage on stdout');

console.log(`\nbundle-loads OK (${pass} checks)`);
process.exit(0);
