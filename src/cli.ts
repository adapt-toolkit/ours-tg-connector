#!/usr/bin/env node
//
// ours-tg-connector — CLI / daemon manager.
//
// The connector runs as ONE long-lived background daemon that hosts every
// bot↔proxy bridge (see connector.ts). This CLI starts/stops/inspects that
// daemon and adds/lists/removes connections against it through its localhost
// control API.
//
//   ours-tg-connector add_new_connection --name <n> --bot-token <t> --chat-id <c> [--label <l>]
//   ours-tg-connector list_connections
//   ours-tg-connector remove_connection <name>
//   ours-tg-connector start | stop | restart | status | serve
//   ours-tg-connector install-service | uninstall-service
//
// `add_new_connection` auto-starts the daemon if it is not already running, then
// creates the connection live (so the new packet is online to complete its invite
// handshake) and prints the invite to paste into the proxy node.
//
// Config precedence per field: env var > config.json (OURS_TG_CONFIG, else
// ~/.ours-telegram/config.json) > default:
//   OURS_TG_DAEMON_URL       the ours daemon to attach to (default: the SDK's selection)
//   OURS_TG_DAEMON_STATE_DIR its state directory — REQUIRED alongside a URL, see config.ts
//   OURS_TG_CONTROL_PORT  localhost control API port (default 3051)
//   OURS_TG_STATE_DIR     state + pid/log dir (default ~/.ours-telegram)
//   OURS_TG_POLL_TIMEOUT  Telegram long-poll seconds (default 30)

import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as fs from 'node:fs';

import { loadConfig } from './config';
import { serviceEnvironment } from './service-definition';
import { looksLikeBotToken } from './routing';

const CONFIG = loadConfig();
const STATE_DIR = CONFIG.stateDir;
const PORT = CONFIG.controlPort;
const PID_PATH = join(STATE_DIR, 'daemon.pid');
const LOG_PATH = join(STATE_DIR, 'daemon.log');
const BASE = `http://127.0.0.1:${PORT}`;

const SELF = fileURLToPath(import.meta.url);
const out = (...p: unknown[]) => process.stdout.write(`${p.join(' ')}\n`);
const err = (...p: unknown[]) => process.stderr.write(`${p.join(' ')}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ----- daemon lifecycle -------------------------------------------------------
function readPid(): number | null {
  try {
    const n = parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runningPid(): number | null {
  const pid = readPid();
  if (pid && isAlive(pid)) return pid;
  if (pid) {
    try {
      fs.rmSync(PID_PATH, { force: true });
    } catch {
      /* ignore */
    }
  }
  return null;
}

function portOpen(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      sock.destroy();
      res(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function waitForPort(port: number, totalMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(400);
  }
  return false;
}

async function cmdStart(): Promise<void> {
  const existing = runningPid();
  if (existing) {
    out(`ours-tg-connector is already running (pid ${existing}, control port ${PORT}).`);
    return;
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const logFd = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [SELF, 'serve'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  if (!child.pid) {
    err('failed to spawn the daemon.');
    process.exit(1);
  }
  fs.writeFileSync(PID_PATH, String(child.pid));
  out(`starting ours-tg-connector (pid ${child.pid})…`);
  const ready = await waitForPort(PORT);
  if (ready) {
    out(`up on ${BASE}`);
    out(`  daemon: ${CONFIG.daemonUrl || '(default selection)'}`);
    out(`  state:  ${STATE_DIR}`);
    out(`  logs:   ${LOG_PATH}`);
  } else {
    err(`daemon started (pid ${child.pid}) but control port ${PORT} did not open within 30s — check ${LOG_PATH}.`);
    process.exit(1);
  }
}

async function cmdStop(): Promise<void> {
  const pid = runningPid();
  if (!pid) {
    out('ours-tg-connector is not running.');
    return;
  }
  out(`stopping (pid ${pid})…`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    err(`failed to signal pid ${pid}: ${String(e)}`);
  }
  for (let i = 0; i < 25 && isAlive(pid); i++) await sleep(200);
  if (isAlive(pid)) {
    err(`pid ${pid} did not exit; sending SIGKILL.`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(PID_PATH, { force: true });
  } catch {
    /* ignore */
  }
  out('stopped.');
}

async function cmdStatus(): Promise<void> {
  const pid = runningPid();
  const up = await portOpen(PORT);
  if (!pid && !up) {
    out('ours-tg-connector: stopped');
    process.exitCode = 1;
    return;
  }
  out('ours-tg-connector: running');
  if (pid) out(`  pid:    ${pid}`);
  out(`  url:    ${BASE} ${up ? '(reachable)' : '(port not answering!)'}`);
  out(`  daemon: ${CONFIG.daemonUrl || '(default selection)'}`);
  out(`  state:  ${STATE_DIR}`);
  out(`  logs:   ${LOG_PATH}`);
  if (up) {
    try {
      const res = await fetch(`${BASE}/connections`);
      const body = (await res.json()) as { connections?: Array<{ name: string }> };
      out(`  connections: ${body.connections?.length ?? 0}`);
    } catch {
      /* ignore */
    }
  }
}

// Ensure the daemon is up before a control call; auto-start it if needed.
async function ensureDaemon(): Promise<void> {
  if (await portOpen(PORT)) return;
  out('daemon not running — starting it…');
  await cmdStart();
  if (!(await portOpen(PORT))) {
    err('daemon did not come up; aborting.');
    process.exit(1);
  }
}

// ----- arg parsing ------------------------------------------------------------
function flagValue(argv: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const i = argv.indexOf(name);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  }
  return undefined;
}

// ----- bot commands -----------------------------------------------------------
async function cmdAddBot(argv: string[]): Promise<void> {
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const flagged = new Set<string>();
  for (const f of ['--name', '--bot-token', '--token']) {
    const i = argv.indexOf(f);
    if (i >= 0 && i + 1 < argv.length) flagged.add(argv[i + 1]);
  }
  const pos = positionals.filter((p) => !flagged.has(p));

  let name = (flagValue(argv, '--name') ?? '').trim();
  let token = (flagValue(argv, '--bot-token', '--token') ?? '').trim();
  // Positional form, order-independent: `add_bot <name> <token>` OR
  // `add_bot <token> <name>` — the «digits:rest» shape identifies the token.
  for (const p of pos) {
    if (!token && looksLikeBotToken(p)) token = p;
    else if (!name) name = p;
  }

  if (!name || !token) {
    err('add_bot requires a name and a bot token');
    err('  e.g. ours-tg-connector add_bot supportbot 123456:ABC-DEF...');
    err('       ours-tg-connector add_bot --name supportbot --bot-token 123456:ABC...');
    process.exit(1);
  }

  await ensureDaemon();
  let res: Response;
  try {
    res = await fetch(`${BASE}/bots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, botToken: token }),
    });
  } catch (e) {
    err(`failed to reach the daemon control API: ${String(e)}`);
    process.exit(1);
  }
  const body = (await res.json()) as { ok: boolean; name?: string; username?: string; error?: string };
  if (!body.ok) {
    err(`add_bot failed: ${body.error ?? `HTTP ${res.status}`}`);
    process.exit(1);
  }
  out(`Bot "${body.name}" registered (@${body.username}).`);
  out(`Add a chat route on it:`);
  out(`  ours-tg-connector add_new_connection --name <route> --bot ${body.name} --chat-id <id>`);
}

async function cmdListBots(): Promise<void> {
  if (!(await portOpen(PORT))) {
    out('daemon not running — no live bots. (Persisted ones load on `start`.)');
    return;
  }
  const res = await fetch(`${BASE}/bots`);
  const body = (await res.json()) as {
    bots?: Array<{ name: string; username: string | null; tokenMasked: string; routeCount: number; routes: string[]; polling: boolean; createdAt: string }>;
  };
  const list = body.bots ?? [];
  if (list.length === 0) {
    out('No bots. Register one with `add_bot <name> <token>`.');
    return;
  }
  out(`Bots (${list.length}):`);
  for (const b of list) {
    out(`• ${b.name}${b.username ? ` (@${b.username})` : ''}`);
    out(`    token:  ${b.tokenMasked}`);
    out(`    routes: ${b.routeCount}${b.routes.length ? ` — ${b.routes.join(', ')}` : ''}${b.polling ? '' : ' (idle, not polling)'}`);
  }
}

async function cmdRemoveBot(name: string): Promise<void> {
  if (!name) {
    err('remove_bot requires a bot name.');
    process.exit(1);
  }
  if (!(await portOpen(PORT))) {
    err('daemon not running — start it first to remove a bot.');
    process.exit(1);
  }
  const res = await fetch(`${BASE}/bots/${encodeURIComponent(name)}`, { method: 'DELETE' });
  const body = (await res.json()) as { ok: boolean; error?: string };
  if (!body.ok) {
    err(`remove_bot failed: ${body.error ?? `HTTP ${res.status}`}`);
    process.exit(1);
  }
  out(`Removed bot "${name}".`);
}

// ----- connection commands ----------------------------------------------------
async function cmdAddConnection(argv: string[]): Promise<void> {
  // Flags take precedence; positionals fill in as: <name> <bot-name> <chat-id>.
  const positionals = argv.filter((a) => !a.startsWith('--'));
  // Drop positionals that are actually flag VALUES.
  const flagged = new Set<string>();
  for (const f of ['--name', '--bot', '--chat-id', '--thread-id', '--label', '--bio', '--payload-mode']) {
    const i = argv.indexOf(f);
    if (i >= 0 && i + 1 < argv.length) flagged.add(argv[i + 1]);
  }
  const pos = positionals.filter((p) => !flagged.has(p));

  const name = (flagValue(argv, '--name') ?? pos[0] ?? '').trim();
  const botName = (flagValue(argv, '--bot') ?? pos[1] ?? '').trim();
  const chatId = (flagValue(argv, '--chat-id', '--chat') ?? pos[2] ?? '').trim();
  const threadId = (flagValue(argv, '--thread-id', '--topic') ?? '').trim();
  const label = (flagValue(argv, '--label') ?? '').trim();
  const bio = (flagValue(argv, '--bio') ?? '').trim();
  const payloadMode = (flagValue(argv, '--payload-mode') ?? (argv.includes('--plain') ? 'plain' : 'envelope')).trim();

  if (!name || !botName || !chatId) {
    err('add_new_connection requires --name, --bot and --chat-id');
    err('  (register the bot first: ours-tg-connector add_bot <name> <token>)');
    err('  e.g. ours-tg-connector add_new_connection --name support \\');
    err('         --bot supportbot --chat-id -1001234567890 \\');
    err('         [--thread-id 42] [--bio "ACME #support — paying customers"]');
    process.exit(1);
  }
  if (payloadMode !== 'plain' && payloadMode !== 'envelope') {
    err('add_new_connection --payload-mode must be "plain" or "envelope"');
    process.exit(1);
  }

  await ensureDaemon();
  let res: Response;
  try {
    res = await fetch(`${BASE}/connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, botName, chatId, threadId, label, bio, payloadMode }),
    });
  } catch (e) {
    err(`failed to reach the daemon control API: ${String(e)}`);
    process.exit(1);
  }
  const body = (await res.json()) as { ok: boolean; cid?: string; invite?: string; botUsername?: string; error?: string };
  if (!body.ok || !body.invite) {
    err(`add_new_connection failed: ${body.error ?? `HTTP ${res.status}`}`);
    process.exit(1);
  }

  out('');
  out(`Connection "${name}" created.`);
  out(`  identity (container id): ${body.cid}`);
  out(`  telegram bot:            ${botName}${body.botUsername ? ` (@${body.botUsername})` : ''}`);
  out(`  bridged chat id:         ${chatId}${threadId ? `  (topic ${threadId})` : ''}`);
  if (bio) out(`  identity bio:            ${bio}`);
  out(`  inbound payload mode:     ${payloadMode}`);
  out('');
  out('Paste this invite into your proxy agent (ours `add_contact`):');
  out('');
  out(body.invite);
  out('');
  out('Once the proxy agent accepts it, the bridge is live:');
  out('  • messages in this Telegram chat/topic → forwarded to the proxy agent');
  out('  • messages from the proxy agent        → delivered back to this chat/topic');
  out('');
  out(`Re-run with --bot ${botName} and a different --chat-id (or --thread-id)`);
  out('to bridge more chats through this one bot — each becomes its own identity.');
}

async function cmdListConnections(): Promise<void> {
  if (!(await portOpen(PORT))) {
    out('daemon not running — no live connections. (Persisted ones load on `start`.)');
    return;
  }
  const res = await fetch(`${BASE}/connections`);
  const body = (await res.json()) as {
    connections?: Array<{
      name: string;
      cid: string;
      botName: string;
      botUsername: string | null;
      chatId: string;
      threadId: string | null;
      label: string;
      bio: string | null;
      payloadMode: 'plain' | 'envelope';
      peerCid: string | null;
      contacts: Array<{ name: string; cid: string }>;
    }>;
  };
  const conns = body.connections ?? [];
  if (conns.length === 0) {
    out('No connections.');
    return;
  }
  // Group routes under their shared bot so the "one bot, many chats" shape is visible.
  const byBot = new Map<string, typeof conns>();
  for (const c of conns) {
    (byBot.get(c.botName) ?? byBot.set(c.botName, []).get(c.botName)!).push(c);
  }
  out(`Connections (${conns.length}) across ${byBot.size} bot(s):`);
  for (const [botName, routes] of byBot) {
    const uname = routes[0]?.botUsername;
    out(`▸ bot ${botName}${uname ? ` (@${uname})` : ''} — ${routes.length} route(s)`);
    for (const c of routes) {
      const peer = c.peerCid ? `proxy ${c.peerCid}` : 'awaiting proxy';
      const chat = c.chatId === '0' || c.chatId === '' ? 'any chat (catch-all)' : `${c.chatId}${c.threadId ? ` · topic ${c.threadId}` : ''}`;
      out(`    • ${c.name}${c.label ? ` (${c.label})` : ''}`);
      out(`        identity: ${c.cid}`);
      out(`        chat:     ${chat}`);
      if (c.bio) out(`        bio:      ${c.bio}`);
      out(`        payload:  ${c.payloadMode}`);
      out(`        status:   ${peer}`);
      if (c.contacts.length) out(`        contacts: ${c.contacts.map((x) => `${x.name} (${x.cid})`).join(', ')}`);
    }
  }
}



async function cmdRemoveConnection(name: string): Promise<void> {
  if (!name) {
    err('remove_connection requires a connection name.');
    process.exit(1);
  }
  if (!(await portOpen(PORT))) {
    err('daemon not running — start it first to remove a live connection.');
    process.exit(1);
  }
  const res = await fetch(`${BASE}/connections/${encodeURIComponent(name)}`, { method: 'DELETE' });
  const body = (await res.json()) as { ok: boolean; error?: string };
  if (!body.ok) {
    err(`remove_connection failed: ${body.error ?? `HTTP ${res.status}`}`);
    process.exit(1);
  }
  out(`Removed connection "${name}" and its state.`);
}

// ----- boot-persistent service (systemd / launchd) ----------------------------
// Installs a user-level service that runs `serve` and survives reboots. The
// resolved config (broker / control port / state dir / poll timeout) is baked
// into the unit so the daemon comes up with the same settings as this CLI.
const SYSTEMD_UNIT = 'ours-telegram.service';
const LAUNCHD_LABEL = 'solutions.adaptframework.ours-telegram';

function systemdUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function run(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  return r.status === 0;
}

// Env baked into the service definition so the daemon resolves the same config.
// An UNCHOSEN daemon selection produces no line at all — see service-definition.ts
// for why an empty baked value is worse than an absent one.
const serviceEnv = (): Record<string, string> => serviceEnvironment(CONFIG, STATE_DIR);

function installSystemd(): void {
  const unitPath = systemdUnitPath();
  fs.mkdirSync(dirname(unitPath), { recursive: true });
  const env = serviceEnv();
  const envLines = Object.entries(env)
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join('\n');
  const unit = `[Unit]
Description=ours Telegram connector (bridge Telegram bots to ours proxy nodes)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${SELF} serve
${envLines}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitPath, unit);
  out(`wrote ${unitPath}`);

  run('systemctl', ['--user', 'daemon-reload']);
  if (!run('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT])) {
    err('failed to enable/start the service via systemctl --user.');
    process.exit(1);
  }
  // Linger lets the user service keep running (and start at boot) with no active
  // login session — this is what makes it survive a server reboot.
  if (!run('loginctl', ['enable-linger', userInfo().username])) {
    err('warning: could not enable linger — the daemon may not start until you log in.');
    err(`  run manually: loginctl enable-linger ${userInfo().username}`);
  }
  out('');
  out('ours-tg-connector installed as a systemd user service and started.');
  out(`  status:  systemctl --user status ${SYSTEMD_UNIT}`);
  out(`  logs:    journalctl --user -u ${SYSTEMD_UNIT} -f`);
  out(`  remove:  ours-tg-connector uninstall-service`);
}

function uninstallSystemd(): void {
  run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
  const unitPath = systemdUnitPath();
  try {
    fs.rmSync(unitPath, { force: true });
    out(`removed ${unitPath}`);
  } catch (e) {
    err(`failed to remove ${unitPath}: ${String(e)}`);
  }
  run('systemctl', ['--user', 'daemon-reload']);
  out('ours-tg-connector service uninstalled.');
}

function installLaunchd(): void {
  const plistPath = launchdPlistPath();
  fs.mkdirSync(dirname(plistPath), { recursive: true });
  const env = serviceEnv();
  const envEntries = Object.entries(env)
    .map(([k, v]) => `    <key>${k}</key><string>${v}</string>`)
    .join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${SELF}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_PATH}</string>
  <key>StandardErrorPath</key><string>${LOG_PATH}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist);
  out(`wrote ${plistPath}`);

  run('launchctl', ['unload', plistPath]);
  if (!run('launchctl', ['load', '-w', plistPath])) {
    err('failed to load the launchd agent.');
    process.exit(1);
  }
  out('');
  out('ours-tg-connector installed as a launchd agent and started.');
  out('  remove:  ours-tg-connector uninstall-service');
}

function uninstallLaunchd(): void {
  const plistPath = launchdPlistPath();
  run('launchctl', ['unload', plistPath]);
  try {
    fs.rmSync(plistPath, { force: true });
    out(`removed ${plistPath}`);
  } catch (e) {
    err(`failed to remove ${plistPath}: ${String(e)}`);
  }
  out('ours-tg-connector service uninstalled.');
}

async function cmdInstallService(): Promise<void> {
  // Stop any background daemon first so the service takes over the control port.
  await cmdStop();
  if (process.platform === 'linux') return installSystemd();
  if (process.platform === 'darwin') return installLaunchd();
  err(`install-service: unsupported platform "${process.platform}" (only linux/systemd and macOS/launchd).`);
  process.exit(1);
}

function cmdUninstallService(): void {
  if (process.platform === 'linux') return uninstallSystemd();
  if (process.platform === 'darwin') return uninstallLaunchd();
  err(`uninstall-service: unsupported platform "${process.platform}".`);
  process.exit(1);
}

function usage(): void {
  out('ours-tg-connector — bridge Telegram bots to ours proxy nodes');
  out('');
  out('Usage: ours-tg-connector <command>');
  out('  bots:');
  out('  add_bot              register a Telegram bot under a name (validates via getMe)');
  out('     --name <n> --bot-token <t>   (positional, any order: add_bot <name> <token>)');
  out('  list_bots            list registered bots: @username, masked token, route count');
  out('  remove_bot <name>    delete a registered bot (refused while routes reference it)');
  out('');
  out('  routes:');
  out('  add_new_connection   create a chat↔agent route (one identity) and print an invite');
  out('     --name <n> --bot <bot-name> --chat-id <c> [--thread-id <topic>] [--label <l>] [--bio <text>]');
  out('     [--payload-mode envelope|plain] [--plain]');
  out('     (positional also accepted: add_new_connection <name> <bot-name> <chat-id>)');
  out('     reuse the same --bot with different --chat-id/--thread-id to bridge many');
  out('     chats/topics through one bot; --bio gives the agent that chat\'s context');
  out('     envelope is the safe default for groups; plain forwards DM text without JSON metadata');
  out('  list_connections     list configured routes grouped by bot');
  out('  remove_connection <name>   delete a route and its state');
  out('');
  out('  start    start the daemon in the background');
  out('  stop     stop the running daemon');
  out('  restart  stop then start');
  out('  status   show whether the daemon is running');
  out('  serve    run the daemon in the foreground (used by start; handy for debugging)');
  out('');
  out('  install-service    install + start a boot-persistent service (systemd/launchd)');
  out('  uninstall-service  stop + remove that service');
  out('');
  out('Config precedence (per field): env var > config.json > default.');
  out('  config.json: OURS_TG_CONFIG, else ~/.ours-telegram/config.json');
  out('  env: OURS_TG_DAEMON_URL + OURS_TG_DAEMON_STATE_DIR (both, or neither), OURS_TG_CONTROL_PORT (3051),');
  out('       OURS_TG_STATE_DIR, OURS_TG_POLL_TIMEOUT (30)');
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'help';
  switch (cmd) {
    case 'serve':
    case 'run': {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(PID_PATH, String(process.pid));
      const cleanup = () => {
        try {
          fs.rmSync(PID_PATH, { force: true });
        } catch {
          /* ignore */
        }
      };
      process.on('exit', cleanup);
      for (const sig of ['SIGTERM', 'SIGINT'] as const) {
        process.on(sig, () => {
          cleanup();
          process.exit(0);
        });
      }
      // Load the daemon from the sibling bundle at runtime (computed specifier
      // keeps esbuild from inlining the server into the CLI bundle).
      await import(pathToFileURL(join(dirname(SELF), 'connector.js')).href);
      break;
    }
    case 'add_bot':
    case 'add-bot':
      await cmdAddBot(process.argv.slice(3));
      break;
    case 'list_bots':
    case 'list-bots':
      await cmdListBots();
      break;
    case 'remove_bot':
    case 'remove-bot':
      await cmdRemoveBot(process.argv[3]);
      break;
    case 'add_new_connection':
    case 'add-connection':
      await cmdAddConnection(process.argv.slice(3));
      break;
    case 'list_connections':
    case 'list-connections':
    case 'list':
      await cmdListConnections();
      break;
    case 'remove_connection':
    case 'remove-connection':
    case 'remove':
      await cmdRemoveConnection(process.argv[3]);
      break;
    case 'start':
      await cmdStart();
      break;
    case 'stop':
      await cmdStop();
      break;
    case 'restart':
      await cmdStop();
      await cmdStart();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'install-service':
      await cmdInstallService();
      break;
    case 'uninstall-service':
      cmdUninstallService();
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      err(`unknown command: ${cmd}\n`);
      usage();
      process.exit(1);
  }
}

main().catch((e) => {
  err(`ours-tg-connector error: ${e?.stack ?? e}`);
  process.exit(1);
});
