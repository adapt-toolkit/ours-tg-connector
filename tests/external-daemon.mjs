import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OURS_CLI = join(ROOT, 'node_modules', '@ours.network', 'cli', 'dist', 'cli.js');

export const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    server.close((err) => err ? reject(err) : resolvePort(port));
  });
});

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * Launch the released operator CLI as a separate foreground daemon process.
 * Application code never imports daemon internals in SDK 2; tests use the same
 * public lifecycle boundary an operator does.
 */
export async function startExternalDaemon({ stateDir, port = undefined }) {
  const selectedPort = port ?? await freePort();
  const url = `http://127.0.0.1:${selectedPort}`;
  const child = spawn(process.execPath, [
    OURS_CLI, 'daemon', 'serve',
    '--port', String(selectedPort),
    '--state-dir', stateDir,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      OURS_BROKER_URL: 'wss://invalid.local/none',
      OURS_API_VISIBILITY: 'open',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let exited = null;
  const exit = new Promise((resolveExit) => child.once('exit', (code, signal) => {
    exited = { code, signal };
    resolveExit(exited);
  }));

  const stop = async () => {
    if (exited) return;
    child.kill('SIGTERM');
    const stopped = await Promise.race([exit, sleep(10_000).then(() => null)]);
    if (!stopped && !exited) {
      child.kill('SIGKILL');
      await exit;
    }
  };

  const deadline = Date.now() + 60_000;
  try {
    while (Date.now() < deadline) {
      if (exited) throw new Error(`external ours daemon exited before ready (${JSON.stringify(exited)}):\n${output}`);
      try {
        const response = await fetch(`${url}/state-dir`);
        if (response.ok) {
          const body = await response.json();
          if (body.stateDir === stateDir) return { child, url, port: selectedPort, output: () => output, close: stop };
        }
      } catch {
        // The CLI is still starting.
      }
      await sleep(100);
    }
    throw new Error(`external ours daemon did not become ready at ${url}:\n${output}`);
  } catch (err) {
    await stop();
    throw err;
  }
}
