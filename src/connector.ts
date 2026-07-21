#!/usr/bin/env node
//
// ours.network Telegram connector — daemon.
//
// One process == one native ADAPT wrapper hosting N messenger packets. Two layers:
//
//   BOT   — one Telegram bot token == one getUpdates poll loop (Telegram allows
//           only ONE consumer per token). A bot fans its updates out to many
//           routes by chat-key.
//   ROUTE — one ours.network identity (packet) pinned to one chat-key. A chat-key is a
//           whole chat (`chatId`) or a single forum topic (`chatId:threadId`). The
//           route bridges that chat-key to one proxy agent:
//
//   Telegram chat/topic ──getUpdates──▶ bot demux ──▶ route packet ──send_message──▶ agent
//   Telegram chat/topic ◀─sendMessage── bot ◀── route packet ◀──(encrypted)─── agent
//
// Because each route's identity is pinned to exactly one chat-key, reverse
// delivery is structural: an agent's reply arrives on the identity that *is* the
// chat, so it can only ever go back to its origin. The SAME agent can serve many
// chats by being a contact of many route identities — it tells them apart by
// which contact (name + bio) a message is on, never by parsing the text. Each
// route's bio carries the group/topic context the agent should know about.
//
// A bot is registered ONCE under a friendly name (see cli.ts `add_bot`): the
// connector validates the token (getMe), captures the @username, and records it in
// the bot registry. Routes then reference a bot by that name, so the token is held
// in exactly one place. Setup is then one command per route (`add_new_connection
// --bot <name>`): the connector mints a fresh identity, sets its name + bio,
// generates an invite, and returns it. The human pastes that invite into the proxy
// agent's `add_contact`; the packet — already live on the broker — completes the
// handshake and the bridge is open. Routes naming the same bot share its single
// poll loop.
//
// Persistence:
//   STATE_DIR/bots.json          { name: { name, token, username, createdAt } }
//   STATE_DIR/<route-name>/      one dir per route:
//     identity.key      the exported root SIGN secret (adapt #77) — recreating
//                        the packet and reseeding from this keeps the container
//                        id stable across restarts, regardless of the (ephemeral,
//                        unpersisted) seed phrase used to recreate the packet
//     state_data.bin    serialized packet state (contacts + encrypted channels)
//     connection.json   { botName, chatId, threadId, bio, label, peerCid, ... }
//
// On boot the bot registry is loaded first (one TelegramClient per bot, no poll
// yet), then every persisted route is recreated so its packet re-registers on the
// broker, then each bot that has at least one route gets its single poll started.
//
// A localhost-only JSON control API (default :3040) is how the CLI adds / lists /
// removes routes against the live daemon, so a new packet is online to complete
// its invite handshake the moment the user pastes it.

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import * as fs from 'node:fs';

// Own package version, for the pre-migration blob retention key. Resolved from the
// package root in both layouts (src/../ and dist/../).
const PKG_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

import { loadConfig } from './config';
import type { AdaptValue } from './adapt';
import {
  AdaptHost,
  Packet,
  wireHandlers,
  packInvite,
  renderInbox,
  renderFiles,
  renderContacts,
  renderControlRequests,
  withScope,
  withScopeAsync,
} from './adapt';
import { DEFAULT_DENIED, monitoringStatus, dispatchControlRequest } from './control';
import { TelegramClient } from './telegram';
import type { TelegramMessage, AttachmentDescriptor } from './telegram';
import { buildEnvelope, attachmentMeta } from './envelope';
import type { ResolvedAttachment, TranscriptionResult } from './envelope';
import { transcribe } from './stt';
import { chatKey, isCatchAll, resolveRoute, deliveryTarget, isIdCommand, formatChatIdReply } from './routing';

const CONFIG = loadConfig();
const STATE_DIR = CONFIG.stateDir;

// Telegram network hardening, shared by every TelegramClient (see src/telegram.ts).
const TG_NET = {
  forceIpv4: CONFIG.tgForceIpv4,
  connectTimeoutMs: CONFIG.tgConnectTimeoutMs,
  retries: CONFIG.tgFetchRetries,
  retryBaseMs: CONFIG.tgFetchRetryBaseMs,
};

const log = (...parts: unknown[]) => process.stderr.write(`ours-tg: ${parts.join(' ')}\n`);

// Render a `bin` field of a notify payload as lowercase hex ('' when absent) — for
// the e2e migration proof lines (epoch / session_id arrive as binary).
function binHexField(av: AdaptValue, field: string): string {
  const x = av.Reduce(field);
  return x.IsNil() ? '' : Buffer.from(x.GetBinary()).toString('hex');
}

// Route names double as on-disk directory names and peer-visible display names,
// so keep them simple and path-safe.
const NAME_RE = /^[A-Za-z0-9 _.-]{1,64}$/;
function validateName(name: string): string | null {
  if (!NAME_RE.test(name)) return 'name must be 1-64 chars of letters, digits, space, _ . or -';
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return 'invalid name';
  return null;
}

// ----- connection (route) model ----------------------------------------------
interface ConnectionFile {
  v: 1;
  name: string;
  botName: string; // the registered bot this route rides on (see bots.json); token is resolved from the registry
  chatId: string; // the ALLOWED Telegram chat ('' or '0' => catch-all); string preserves large/negative ids
  threadId: string; // forum topic id ('' => whole chat); pins the route to a single topic
  label: string;
  bio: string; // group/topic context set on the identity (embedded in its invite, read by the agent)
  deniedMessage: string; // reply sent to a non-routed chat when the bot serves exactly one route
  peerCid: string; // the proxy agent's container id once it accepts the invite ('' until then)
  createdAt: string;
}

// A registered bot. {name, token, username, createdAt} are persisted in
// bots.json; the rest is runtime. One bot == one poll loop, fanned out to its
// routes by chat-key.
interface Bot {
  name: string; // friendly registry name; how routes reference it
  token: string;
  tg: TelegramClient;
  username: string; // @username from getMe (best-effort; '' until known)
  createdAt: string;
  exact: Map<string, Connection>; // chatKey -> route
  catchAll: Connection | null; // the chatId '0'/'' route, if any
  pollHandle: Promise<void> | null;
}

// Persisted bot-registry record (the subset of Bot stored in bots.json).
interface BotFile {
  name: string;
  token: string;
  username: string;
  createdAt: string;
}

interface Connection {
  pkt: Packet;
  dir: string;
  cfg: ConnectionFile;
  bot: Bot;
  lastChat: { chatId: string; threadId: string } | null; // most recent inbound origin (reverse-delivery target for non-topic-pinned routes)
}

const host = new AdaptHost(CONFIG.brokerUrl, log);
const connections = new Map<string, Connection>(); // route name -> route
const bots = new Map<string, Bot>(); // bot name -> bot

// ----- per-route paths --------------------------------------------------------
const connDir = (name: string) => join(STATE_DIR, name);
const keyPath = (dir: string) => join(dir, 'identity.key');
const dataPath = (dir: string) => join(dir, 'state_data.bin');
const metaPath = (dir: string) => join(dir, 'connection.json');
const botsPath = () => join(STATE_DIR, 'bots.json');

function listPersistedNames(): string[] {
  if (!fs.existsSync(STATE_DIR)) return [];
  return fs
    .readdirSync(STATE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(metaPath(join(STATE_DIR, d.name))))
    .map((d) => d.name);
}

function readMeta(dir: string): ConnectionFile {
  const cfg = JSON.parse(fs.readFileSync(metaPath(dir), 'utf8')) as ConnectionFile;
  // Backfill fields added after the single-chat era so old metas keep working.
  if (typeof cfg.threadId !== 'string') cfg.threadId = '';
  if (typeof cfg.bio !== 'string') cfg.bio = '';
  if (typeof cfg.deniedMessage !== 'string') cfg.deniedMessage = DEFAULT_DENIED;
  return cfg;
}

function writeMeta(dir: string, cfg: ConnectionFile): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${metaPath(dir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, metaPath(dir));
}

// ----- persistence (data-level) -----------------------------------------------
function hasSavedState(dir: string): boolean {
  try {
    return fs.existsSync(dataPath(dir)) && fs.statSync(dataPath(dir)).size > 0;
  } catch {
    return false;
  }
}

// Export the root SIGN secret (adapt #77) so it can be persisted to identity.key
// and later reparsed + injected to reseed a recreated packet onto the same
// container id. secretkey_sign is a domain-typed leaf: GetBinary() throws
// "Invalid domain", so we Serialize() it (self-contained, reparses cross-host)
// and hex-encode the bytes.
function exportSigningSecret(pkt: Packet): string {
  return withScope((lt) => Buffer.from(pkt.readonlyTx('::actor::export_signing_secret', lt).Serialize()).toString('hex'));
}

function saveState(pkt: Packet, dir: string): void {
  try {
    saveStateFailClosed(pkt, dir);
  } catch (err) {
    log(`[${pkt.name}] failed to save state:`, String(err));
  }
}

// Fail-closed persist (APP-GUARANTEE-1, DR-ROLLOUT-PLAN §6.3): DR ratchet state must be
// durably on disk before any network effect of the same transaction — a swallowed write
// failure here turns the next crash into a stale-ratchet restore. On failure this THROWS;
// wired as the save_state RET hook, the throw propagates into the wrapper's action loop,
// which (on the 0.10.12 SDK's SEND durability barrier) withholds the transaction's
// buffered SENDs. fsync on file AND dir: rename alone is not durable.
function saveStateFailClosed(pkt: Packet, dir: string): void {
  const bytes = withScope((lt) => Buffer.from(pkt.readonlyTx('::actor::export_state', lt).Serialize()));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${dataPath(dir)}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dataPath(dir));
  const dirFd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

// ----- contact restore (host driving) ------------------------------------
// The packet self-heals degraded contacts (known cid, no encryption keys —
// the outcome of a breaking-change migration that dropped peer_ads) through
// the signed request_contact_restore handshake. The host's jobs: fire the
// sweep on boot + the periodic restore-retry timer, and drain deferred queues
// once a contact heals ($contact_restored notify, or the sweep for a flush
// lost to a crash).
function renderDegraded(av: AdaptValue): Array<{ cid: string; name: string; attempts: number; queued: number }> {
  const out: Array<{ cid: string; name: string; attempts: number; queued: number }> = [];
  const arr = av.Reduce('degraded');
  if (arr.IsNil()) return out;
  for (let i = 0; ; i++) {
    const e = arr.Reduce(i);
    if (e.IsNil()) break;
    out.push({
      cid: e.Reduce('container_id').Visualize(),
      name: e.Reduce('name').Visualize(),
      attempts: Number(e.Reduce('attempts').Visualize()),
      queued: Number(e.Reduce('queued').Visualize()),
    });
  }
  return out;
}

function renderDeferredQueues(av: AdaptValue): Array<{ cid: string; queued: number; degraded: boolean }> {
  const out: Array<{ cid: string; queued: number; degraded: boolean }> = [];
  const arr = av.Reduce('queues');
  if (arr.IsNil()) return out;
  for (let i = 0; ; i++) {
    const e = arr.Reduce(i);
    if (e.IsNil()) break;
    out.push({
      cid: e.Reduce('container_id').Visualize(),
      queued: Number(e.Reduce('queued').Visualize()),
      degraded: e.Reduce('degraded').GetBoolean(),
    });
  }
  return out;
}

// Drain messages queued while a contact was degraded. Idempotent (empty or
// still-degraded queue → flushed 0), so re-firing is always safe.
async function flushDeferredFor(pkt: Packet, contactCid: string): Promise<void> {
  try {
    const flushed = await withScopeAsync(async (lt) => {
      const r = await pkt.mutatingTx('::a2a_messaging::flush_deferred', { contact: contactCid }, lt);
      return Number(r.Reduce('flushed').Visualize());
    });
    if (flushed > 0) log(`[${pkt.name}] flushed ${flushed} deferred message(s) to ${contactCid.slice(0, 12)}…`);
  } catch (err) {
    log(`[${pkt.name}] deferred flush to ${contactCid.slice(0, 12)}… failed:`, String(err));
  }
}

// Boot + periodic sweep: (re)request restores for degraded contacts and flush any
// healed-but-still-queued contact (a crash between restore and flush).
async function contactRestoreSweep(pkt: Packet): Promise<void> {
  try {
    const requested = await withScopeAsync(async (lt) => {
      const r = await pkt.mutatingTx('::a2a_messaging::restore_degraded_contacts', {}, lt);
      return Number(r.Reduce('requested').Visualize());
    });
    if (requested > 0) log(`[${pkt.name}] contact restore requested for ${requested} degraded contact(s)`);
    const queues = withScope((lt) => renderDeferredQueues(pkt.readonlyTx('::a2a_messaging::list_deferred_queues', lt)));
    for (const q of queues) {
      if (!q.degraded) await flushDeferredFor(pkt, q.cid);
    }
  } catch (err) {
    log(`[${pkt.name}] contact-restore sweep failed:`, String(err));
  }
}

// Boot + periodic e2e migration reconciler (core 0.9.0 §5.6). Re-drives any
// in-flight migration handshake AND proactively OFFERS to every already-e2e
// contact that both sides can now migrate (mig_should_trigger). This is the path
// that makes case-3a — existing contacts auto-migrate to the double ratchet —
// fire IMMEDIATELY, even for an idle contact with no inbound traffic (the receive
// triggers need traffic; advertise_migrate is the runtime staged-enable). Inert +
// idempotent + fail-closed IN CORE: sweep_e2e_migrations does nothing until this
// node advertises core.e2e.migrate (the actor manifest $advertise) and never
// re-offers an in-flight or already-migrated pair, so it is safe on every boot and
// GC tick. Peer-facing sends ride the legacy encrypted channel (the migration
// carve-out), so the packet must already be registered on the broker when called.
async function migrationSweep(pkt: Packet): Promise<void> {
  try {
    const { initiated, redriven, superseded, stalled } = await withScopeAsync(async (lt) => {
      const r = await pkt.mutatingTx('::a2a_messaging::sweep_e2e_migrations', {}, lt);
      return {
        initiated: Number(r.Reduce('initiated').Visualize()),
        redriven: Number(r.Reduce('redriven').Visualize()),
        superseded: Number(r.Reduce('superseded').Visualize()),
        stalled: Number(r.Reduce('stalled').Visualize()),
      };
    });
    if (initiated + redriven + superseded + stalled > 0) {
      log(`[${pkt.name}] e2e migration sweep: ${initiated} offered, ${redriven} re-driven, ${superseded} superseded, ${stalled} stalled`);
    }
  } catch (err) {
    log(`[${pkt.name}] e2e migration sweep failed:`, String(err));
  }
}

// Boot/upgrade RE-ADVERTISE (DAEMON CONTRACT, core 0.10 B1) — mirrors the mcp host.
// Pushes this route's fresh v2 AD (+ caps piggyback) to every PRE-EXISTING LEGACY
// contact over the legacy channel. A v2 peer ingests it (handle_readvertise_ad →
// learns our caps/pv, refreshes its stored AD) and offers migration back; a still-v1
// peer ignores it. This is the ONLY bootstrap for a stable-era contact whose stored
// peer AD predates DR — without it neither migrationSweep nor advertise_migrate can
// find it eligible (they only offer to already-known-0.9 peers), so an existing
// contact would never auto-migrate after both sides upgrade. Connector identities are
// FLAT (self-sovereign packets, no delegation cert), so the mcp's role-cert re-mint
// does NOT apply here — the readvertise carries a NIL cert (flat-identity verify path)
// and is accepted. The core trn is STATELESS + idempotent (legacy-only filter; no
// _save_state), so it is safe on every boot and GC tick; the packet must already be
// registered on the broker (called after restore, like migrationSweep). The push is
// delivered only while the PEER is online, so re-fire on a short schedule to catch a
// peer that reconnects shortly after us.
async function readvertiseOnUpgrade(pkt: Packet): Promise<void> {
  try {
    const readvertised = await withScopeAsync(async (lt) => {
      const r = await pkt.mutatingTx('::a2a_messaging::readvertise_on_upgrade', {}, lt);
      return Number(r.Reduce('readvertised').Visualize());
    });
    if (readvertised > 0) log(`[${pkt.name}] re-advertised v2 AD to ${readvertised} pre-existing legacy contact(s) (migration bootstrap)`);
  } catch (err) {
    log(`[${pkt.name}] readvertise-on-upgrade sweep failed:`, String(err));
  }
}

// Boot/GC SESSION-RECOVERY sweep (core 0.11 self-heal, DAEMON CONTRACT) — mirrors the
// mcp prerelease host's e2eRecoverySweep. Complements readvertiseOnUpgrade (legacy-only)
// and migrationSweep (sweep_e2e_migrations, already run above). Two extra core legs the
// connector historically skipped:
//   - readvertise_e2e_recovery: pushes this route's FRESH AD to every E2E-CAPABLE contact
//     (complement of the legacy-only upgrade sweep). Since the persist-primary change the
//     Olm account + live sessions normally SURVIVE a restart (validated $e2e_sessions
//     import), so this is the FALLBACK layer for true loss: a rejected/absent state blob
//     re-mints the account, leaving every peer's stored e2e_bundle for me stale until a
//     fresh AD lands, and an in-flight migration always loses its staged session
//     (m_staged is deliberately not persisted).
//   - redrive_unacked_sweep: TTL-purges plaintext a peer never receipted (a withholder
//     cannot pin it forever) then re-drives aged-but-live unacked ratchet sends.
// Both are idempotent / attempt-capped / budgeted (bounded, resumable via an exported
// cursor) — safe on every boot and GC tick, and a near no-op refresh when persist
// restored everything. The packet must already be registered on the broker (called after
// restore, like migrationSweep) since the recovery re-advertise rides the encrypted channel.
async function e2eRecoverySweep(pkt: Packet): Promise<void> {
  try {
    const readvertised = await withScopeAsync(async (lt) => {
      const r = await pkt.mutatingTx('::a2a_messaging::readvertise_e2e_recovery', {}, lt);
      return Number(r.Reduce('readvertised').Visualize());
    });
    if (readvertised > 0) log(`[${pkt.name}] re-advertised fresh AD to ${readvertised} e2e contact(s) (session recovery)`);
  } catch (err) {
    log(`[${pkt.name}] e2e recovery re-advertise failed:`, String(err));
  }
  try {
    // Report what ACTUALLY happened — redriven / TTL-purged / deferred (cursor-batched)
    // are different outcomes and must not be conflated (mirrors mcp review #15).
    const s = await withScopeAsync(async (lt) => {
      const r = await pkt.mutatingTx('::a2a_messaging::redrive_unacked_sweep', {}, lt);
      const num = (f: string): number => (r.Reduce(f).IsNil() ? 0 : Number(r.Reduce(f).Visualize()));
      return { redriven: num('redriven_contacts'), purged: num('purged_contacts'), deferred: num('deferred_contacts') };
    });
    if (s.redriven > 0 || s.purged > 0 || s.deferred > 0) {
      log(`[${pkt.name}] unacked sweep: redriven=${s.redriven} ttl_purged=${s.purged} deferred=${s.deferred} contact(s)`);
    }
  } catch (err) {
    log(`[${pkt.name}] unacked redrive sweep failed:`, String(err));
  }
}

// ----- bot registry -----------------------------------------------------------
function botLabel(bot: Bot): string {
  return bot.username ? `${bot.name} (@${bot.username})` : bot.name;
}

function loadBotRegistry(): BotFile[] {
  try {
    const raw = JSON.parse(fs.readFileSync(botsPath(), 'utf8')) as { v: number; bots: Record<string, BotFile> };
    return Object.values(raw.bots ?? {});
  } catch {
    return []; // missing/corrupt registry => start empty (clean install)
  }
}

function saveBotRegistry(): void {
  const data = {
    v: 1,
    bots: Object.fromEntries(
      [...bots.values()].map((b) => [b.name, { name: b.name, token: b.token, username: b.username, createdAt: b.createdAt } satisfies BotFile]),
    ),
  };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${botsPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); // holds tokens
  fs.renameSync(tmp, botsPath());
}

// Build the runtime Bot (one TelegramClient) and index it by name. Does NOT poll —
// activateBot starts the loop once the bot has a route.
function instantiateBot(rec: BotFile): Bot {
  const tg = new TelegramClient(rec.token, CONFIG.pollTimeoutSec, (m) => log(`[bot ${rec.name}] tg: ${m}`), TG_NET);
  const bot: Bot = { name: rec.name, token: rec.token, tg, username: rec.username, createdAt: rec.createdAt, exact: new Map(), catchAll: null, pollHandle: null };
  bots.set(rec.name, bot);
  return bot;
}

// Register a brand-new bot: reject a duplicate name or token, validate the token
// via getMe (fails before anything is written), then persist. A token maps to at
// most one bot — two pollers on one token would fight over getUpdates.
async function addBot(name: string, token: string): Promise<{ name: string; username: string }> {
  if (bots.has(name)) throw new Error(`a bot named "${name}" already exists`);
  for (const b of bots.values()) if (b.token === token) throw new Error(`that token is already registered as bot "${b.name}"`);
  const tg = new TelegramClient(token, CONFIG.pollTimeoutSec, (m) => log(`[bot ${name}] tg: ${m}`), TG_NET);
  const me = await tg.getMe(); // throws on a bad token — nothing persisted yet
  const bot: Bot = { name, token, tg, username: me.username, createdAt: new Date().toISOString(), exact: new Map(), catchAll: null, pollHandle: null };
  bots.set(name, bot);
  saveBotRegistry();
  activateBot(bot); // poll immediately so the /id probe answers before any route exists
  log(`bot "${name}" registered (@${me.username})`);
  return { name, username: me.username };
}

// Delete a registered bot. Refused while any route still rides on it (the caller
// is told which routes to remove first).
function removeBot(name: string): string | null {
  const bot = bots.get(name);
  if (!bot) return `no bot named "${name}"`;
  const routes = [...bot.exact.values()].map((c) => c.cfg.name);
  if (bot.catchAll) routes.push(bot.catchAll.cfg.name);
  if (routes.length) return `bot "${name}" still has ${routes.length} route(s): ${routes.join(', ')} — remove them first`;
  try {
    bot.tg.stop();
  } catch {
    /* best effort */
  }
  bots.delete(name);
  saveBotRegistry();
  log(`bot "${name}" removed`);
  return null;
}

// ----- demux ------------------------------------------------------------------

// Index a route into its bot's demux. Returns an error string if the chat-key (or
// the single catch-all slot) is already taken by another route on the same bot.
function registerRoute(conn: Connection): string | null {
  const { bot, cfg } = conn;
  if (isCatchAll(cfg.chatId)) {
    if (bot.catchAll && bot.catchAll !== conn) return `bot ${botLabel(bot)} already has a catch-all route ("${bot.catchAll.cfg.name}")`;
    bot.catchAll = conn;
  } else {
    const key = chatKey(cfg.chatId, cfg.threadId || undefined);
    const existing = bot.exact.get(key);
    if (existing && existing !== conn) return `bot ${botLabel(bot)} already routes ${key} to "${existing.cfg.name}"`;
    bot.exact.set(key, conn);
  }
  return null;
}

// Remove a route from its bot's demux (scans by identity so it is correct even if
// the cfg chat-key was just edited out from under it).
function unregisterRoute(conn: Connection): void {
  for (const [k, v] of conn.bot.exact) if (v === conn) conn.bot.exact.delete(k);
  if (conn.bot.catchAll === conn) conn.bot.catchAll = null;
}

// Re-index a route after its chat-key changed (control-plane set_config). Returns
// a conflict string if the new slot is taken.
function reregisterRoute(conn: Connection): string | null {
  unregisterRoute(conn);
  return registerRoute(conn);
}

// Is the chat-key (or the single catch-all slot) already claimed on this bot?
// Lets createConnection fail before minting an identity.
function routeSlotConflict(bot: Bot, chatId: string, threadId: string): string | null {
  if (isCatchAll(chatId)) {
    if (bot.catchAll) return `bot ${botLabel(bot)} already has a catch-all route ("${bot.catchAll.cfg.name}")`;
    return null;
  }
  const key = chatKey(chatId, threadId || undefined);
  const existing = bot.exact.get(key);
  return existing ? `bot ${botLabel(bot)} already routes ${key} to "${existing.cfg.name}"` : null;
}

// Fetch a media message's bytes, honoring the configured size cap. Returns a
// ResolvedAttachment the envelope renders verbatim: the bytes on success, or a
// metadata-only stub (omitted/error) so the agent still learns a file arrived.
// The cap is checked against Telegram's reported size BEFORE downloading when
// available, and against the actual length after, as a backstop.
async function resolveAttachment(conn: Connection, d: AttachmentDescriptor): Promise<ResolvedAttachment> {
  const cap = CONFIG.attachmentMaxBytes;
  if (d.file_size !== undefined && d.file_size > cap) {
    return { ok: false, reason: 'too_large', detail: `exceeds ${cap}-byte cap (size ${d.file_size})` };
  }
  try {
    const bytes = await conn.bot.tg.downloadFile(d.file_id);
    if (bytes.length > cap) {
      return { ok: false, reason: 'too_large', detail: `exceeds ${cap}-byte cap (size ${bytes.length})` };
    }
    return { ok: true, bytes };
  } catch (err) {
    return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}

// Best-effort provider label from the STT base URL host (e.g.
// https://api.openai.com/v1 -> "openai", https://api.groq.com/openai/v1 ->
// "groq"). Cosmetic only — recorded in the envelope's transcription block.
function sttEngineLabel(baseUrl: string): string {
  try { return new URL(baseUrl).hostname.replace(/^api\./, '').split('.')[0]; } catch { return 'stt'; }
}

// ----- the bridge -------------------------------------------------------------
// Telegram → agent: forward an inbound message to the route's proxy as a JSON
// envelope (sender/chat/reply/forward metadata + the text, plus the file inline
// as base64 for a media message). We send to the route's peer if known, else to
// every contact (covers the one proxy agent). If the agent has not accepted the
// invite yet, there is no contact and the message is dropped with a log line.
async function forwardToNode(conn: Connection, m: TelegramMessage): Promise<void> {
  const { pkt, cfg } = conn;
  const resolved = m.attachment ? await resolveAttachment(conn, m.attachment) : undefined;

  // Speech-to-text for voice (and any other configured kinds). Only when
  // enabled, the kind opted in, and the bytes resolved within the STT size
  // guard. Failures degrade to the file-forward path — never crash the poll
  // loop (mirrors resolveAttachment).
  let transcription: TranscriptionResult | undefined;
  const kind = m.attachment?.kind;
  if (CONFIG.sttEnabled && kind && CONFIG.sttKinds.includes(kind) && resolved?.ok) {
    const engine = sttEngineLabel(CONFIG.sttBaseUrl);
    if (resolved.bytes.length > CONFIG.sttMaxBytes) {
      transcription = { status: 'error', error: 'too_large', engine, model: CONFIG.sttModel };
    } else {
      const meta = attachmentMeta(m.attachment!, m.message_id);
      const r = await transcribe(resolved.bytes, meta.filename, meta.mime, {
        baseUrl: CONFIG.sttBaseUrl, apiKey: CONFIG.sttApiKey, model: CONFIG.sttModel,
        language: CONFIG.sttLanguage || undefined, timeoutMs: CONFIG.sttTimeoutMs,
      });
      transcription = r.ok
        ? { status: 'ok', text: r.text, engine, model: CONFIG.sttModel, lang: r.lang }
        : { status: 'error', error: r.error, engine, model: CONFIG.sttModel };
      if (!r.ok) log(`[${cfg.name}] STT failed for ${kind} from ${m.from}: ${r.error}`); // never logs the key
    }
  }
  // Whether to still send the audio bytes: yes unless we successfully
  // transcribed AND the operator did not ask to keep the audio.
  const sendAudio = !!(resolved?.ok) && !(transcription?.status === 'ok' && !CONFIG.forwardVoiceAudio);

  const targets: string[] = [];
  if (cfg.peerCid) {
    targets.push(cfg.peerCid);
  } else {
    withScope((lt) => {
      for (const c of renderContacts(pkt.readonlyTx('::a2a_messaging::list_contacts', lt))) targets.push(c.container_id);
    });
  }
  if (targets.length === 0) {
    log(`[${cfg.name}] telegram message from ${m.from} dropped — proxy agent has not accepted the invite yet`);
    return;
  }
  for (const target of targets) {
    // Files and text are distinct messages (core 3.1). When the bytes resolved,
    // send them on the file channel first and capture the wire_id; the envelope
    // then references it so the agent correlates the two. Over-cap/failed
    // downloads send no file — the envelope still announces it (omitted/error).
    let fileWireId: string | undefined;
    if (m.attachment && resolved?.ok && sendAudio) {
      const meta = attachmentMeta(m.attachment, m.message_id);
      const fileBytes = resolved.bytes;
      try {
        fileWireId = await withScopeAsync(async (lt) => {
          const r = await pkt.mutatingTx('::a2a_messaging::send_file',
            { contact: target, filename: meta.filename, mime: meta.mime, data: pkt.newBinary(fileBytes, lt) }, lt);
          return r.Reduce('wire_id').Visualize();
        });
      } catch (err) {
        log(`[${cfg.name}] send_file to ${target} failed:`, String(err));
      }
    }
    // Omit `resolved` from the envelope when we are not announcing the audio, so
    // no attachment block is emitted for a text-only transcript (SPEC §4.5).
    const body = buildEnvelope(m, sendAudio ? resolved : undefined, fileWireId, transcription);
    try {
      const { deferred, queued } = await withScopeAsync(async (lt) => {
        const sent = await pkt.mutatingTx('::a2a_messaging::send_message', { contact: target, text: body }, lt);
        const defAv = sent.Reduce('deferred');
        return {
          deferred: !defAv.IsNil(),
          queued: defAv.IsNil() ? 0 : Number(sent.Reduce('queued').Visualize()),
        };
      });
      if (deferred) {
        log(`[${cfg.name}] message to ${target} queued — contact restore in progress (${queued} queued)`);
      }
    } catch (err) {
      log(`[${cfg.name}] send_message to ${target} failed:`, String(err));
    }
  }
}

// agent → Telegram: pull freshly-received messages out of the route's packet and
// deliver each body to its chat (and topic, if pinned). Triggered by the
// message_received notify.
async function forwardToTelegram(conn: Connection): Promise<void> {
  const { pkt, cfg, bot } = conn;
  let fresh;
  try {
    fresh = await withScopeAsync(async (lt) => renderInbox((await pkt.mutatingTx('::actor::get_messages', {}, lt)).Reduce('messages')));
  } catch (err) {
    log(`[${cfg.name}] get_messages failed:`, String(err));
    return;
  }
  if (fresh.length === 0) return;
  const target = deliveryTarget(cfg.chatId, cfg.threadId, conn.lastChat);
  if (!target || !target.chatId || isCatchAll(target.chatId)) {
    // A catch-all route that has not yet seen an inbound message has nowhere to
    // deliver — hand the messages back so a later attempt re-delivers them once
    // an origin chat is known, rather than dropping them.
    log(`[${cfg.name}] ${fresh.length} agent message(s) with no known destination chat — deferring`);
    try {
      await withScopeAsync((lt) => pkt.mutatingTx('::actor::defer_messages', { msg_ids: fresh.map((m) => m.msg_id) }, lt));
    } catch {
      /* best effort */
    }
    return;
  }
  for (const m of fresh) {
    try {
      await bot.tg.sendMessage(target.chatId, m.text, target.threadId || undefined);
    } catch (err) {
      log(`[${cfg.name}] telegram delivery failed for #${m.msg_id}:`, String(err));
      // Hand the message back so a later attempt re-delivers it rather than
      // silently losing it on a transient Telegram outage.
      try {
        await withScopeAsync((lt) => pkt.mutatingTx('::actor::defer_messages', { msg_ids: [m.msg_id] }, lt));
      } catch {
        /* best effort */
      }
    }
  }
}

// contact → Telegram: pull freshly-received files out of the route's packet and
// upload each to its chat (and topic, if pinned). Triggered by the file_received
// notify. Mirrors forwardToTelegram: defers undelivered files so a transient
// Telegram outage never loses them.
async function forwardFilesToTelegram(conn: Connection): Promise<void> {
  const { pkt, cfg, bot } = conn;
  let fresh;
  try {
    fresh = await withScopeAsync(async (lt) => renderFiles((await pkt.mutatingTx('::actor::get_files', {}, lt)).Reduce('files')));
  } catch (err) {
    log(`[${cfg.name}] get_files failed:`, String(err));
    return;
  }
  if (fresh.length === 0) return;
  const target = deliveryTarget(cfg.chatId, cfg.threadId, conn.lastChat);
  if (!target || !target.chatId || isCatchAll(target.chatId)) {
    log(`[${cfg.name}] ${fresh.length} agent file(s) with no known destination chat — deferring`);
    try {
      await withScopeAsync((lt) => pkt.mutatingTx('::actor::defer_files', { file_ids: fresh.map((f) => f.file_id) }, lt));
    } catch {
      /* best effort */
    }
    return;
  }
  for (const f of fresh) {
    // Guard Telegram's upload ceiling (a contact can send more than we can upload).
    if (f.bytes.length > CONFIG.outboundFileMaxBytes) {
      log(`[${cfg.name}] file #${f.file_id} "${f.filename}" (${f.bytes.length} B) exceeds the ${CONFIG.outboundFileMaxBytes}-byte upload cap — skipping`);
      continue; // dropped from the queue (already marked processed); see OQ3
    }
    try {
      await bot.tg.sendDocument(target.chatId, f.bytes, f.filename, f.mime || undefined, target.threadId || undefined);
    } catch (err) {
      log(`[${cfg.name}] telegram file delivery failed for #${f.file_id}:`, String(err));
      try {
        await withScopeAsync((lt) => pkt.mutatingTx('::actor::defer_files', { file_ids: [f.file_id] }, lt));
      } catch {
        /* best effort */
      }
    }
  }
}

// One bot's single poll handler: demux each update to its route and forward to the
// agent. An update for a chat with no route is dropped (a bot may sit in many
// groups it does not serve); the classic single-route deny is preserved only when
// the bot serves exactly one chat and that route configured a denial message.
async function onBotMessage(bot: Bot, m: TelegramMessage): Promise<void> {
  // Out-of-band /id probe: answer immediately with the chat's identifiers and
  // STOP — it is handled before route resolution so it works in any chat the bot
  // sees, including ones with no route yet (the point is discovering the chat id).
  if (isIdCommand(m.text, bot.username)) {
    const reply = formatChatIdReply({
      chatId: m.chat_id,
      chatType: m.chat_type,
      chatTitle: m.chat_title,
      chatUsername: m.chat_username,
      threadId: m.thread_id,
      isTopic: m.is_topic,
      fromId: m.from_id,
      fromLabel: m.from,
      botName: bot.name,
      botUsername: bot.username,
    });
    try {
      await bot.tg.sendMessage(m.chat_id, reply, m.thread_id);
    } catch (err) {
      log(`[bot ${botLabel(bot)}] failed to answer /id in chat ${m.chat_id}:`, String(err));
    }
    return;
  }

  const conn = resolveRoute(bot.exact, bot.catchAll, m.chat_id, m.thread_id);
  if (!conn) {
    const only = bot.exact.size === 1 && !bot.catchAll ? [...bot.exact.values()][0] : null;
    if (only && only.cfg.deniedMessage) {
      try {
        await bot.tg.sendMessage(m.chat_id, only.cfg.deniedMessage, m.thread_id);
      } catch (err) {
        log(`[bot ${botLabel(bot)}] failed to send denial to chat ${m.chat_id}:`, String(err));
      }
    } else {
      log(`[bot ${botLabel(bot)}] no route for ${chatKey(m.chat_id, m.thread_id)} — ignoring`);
    }
    return;
  }
  conn.lastChat = { chatId: String(m.chat_id), threadId: m.thread_id ? String(m.thread_id) : '' };
  await forwardToNode(conn, m);
}

// ----- activation -------------------------------------------------------------
// Wire a route packet's notify routing to the Telegram side. (The poll loop lives
// on the bot, not the route — see activateBot.)
function activateRoute(conn: Connection): void {
  const { pkt, dir, cfg } = conn;
  wireHandlers(
    pkt,
    {
      onSaveState: () => saveStateFailClosed(pkt, dir),
      onNotify: (event, payload) => {
        if (event === 'message_received') {
          process.nextTick(() => void forwardToTelegram(conn));
        } else if (event === 'file_received') {
          process.nextTick(() => void forwardFilesToTelegram(conn));
        } else if (event === 'control_request') {
          process.nextTick(() => void processControlRequests(conn));
        } else if (event === 'contact_accepted' || event === 'sibling_contact_added') {
          const cid = payload.Reduce('container_id').Visualize();
          const name = payload.Reduce('name').Visualize();
          // The FIRST accepted contact is the proxy agent (telegram traffic routes
          // there). Later contacts — e.g. the messenger control plane — must NOT
          // clobber it, so only set peerCid while it is still empty.
          if (cid && !cfg.peerCid) {
            cfg.peerCid = cid;
            writeMeta(dir, cfg);
            log(`[${cfg.name}] proxy agent connected: "${name}" (${cid})`);
          } else {
            log(`[${cfg.name}] contact added: "${name}" (${cid})`);
          }
        } else if (event === 'contact_restored') {
          // A degraded contact (post-upgrade re-key) finished the signed
          // restore handshake. Drain anything queued toward it; content-free log line.
          const name = payload.Reduce('name').Visualize();
          const cid = payload.Reduce('container_id').Visualize();
          log(`[${cfg.name}] contact "${name}" restored (re-keyed)`);
          process.nextTick(() => void flushDeferredFor(pkt, String(cid)));
        } else if (event === 'migration_active') {
          // The e2e migration pin is set for this contact — the session is now the
          // double ratchet (epoch + session_id of the migrated session). Proof line
          // (DAEMON-INTEGRATION §4); epoch/session_id are bin -> hex.
          const cid = payload.Reduce('cid').Visualize();
          const role = payload.Reduce('role').Visualize();
          const epoch = binHexField(payload, 'epoch');
          const sid = binHexField(payload, 'session_id');
          log(`[${cfg.name}] [migration] active cid=${cid} role=${role}${epoch ? ` epoch=${epoch}` : ''}${sid ? ` session_id=${sid}` : ''}`);
        } else if (event === 'e2e_app_send') {
          // §4 app-SEND proof: core delivered an app message over the migrated
          // (double-ratchet) session. session_id (bin->hex) == active_session_id.
          const cid = payload.Reduce('cid').Visualize();
          const sid = binHexField(payload, 'session_id');
          const olm = payload.Reduce('olm_type').Visualize();
          const wireId = payload.Reduce('wire_id').Visualize();
          log(`[${cfg.name}] [e2e-app] send cid=${cid} session_id=${sid} olm_type=${olm} wire_id=${wireId}`);
        } else if (event === 'e2e_app_recv') {
          // §4 app-RECV proof: core decrypted an inbound app message over the
          // migrated (double-ratchet) session on this peer.
          const cid = payload.Reduce('cid').Visualize();
          const sid = binHexField(payload, 'session_id');
          const ok = payload.Reduce('ok').GetBoolean();
          const wireId = payload.Reduce('wire_id').Visualize();
          log(`[${cfg.name}] [e2e-app] recv cid=${cid} session_id=${sid} ok=${ok} wire_id=${wireId}`);
        } else if (event === 'migration_deferred_flush') {
          // One notify per app message drained onto the now-active migrated session
          // (FIFO). Core performs the re-drive (each surfaces as an e2e_app_send);
          // this is observability only — NEVER box, NEVER drop silently.
          const cid = payload.Reduce('cid').Visualize();
          const wireId = payload.Reduce('wire_id').Visualize();
          log(`[${cfg.name}] [migration] flush-notify cid=${cid} wire_id=${wireId} (deferred->e2e; core delivers)`);
        } else if (event === 'migration_stalled') {
          // Migration didn't reach active in its window. UX/log only — core re-drives
          // via the sweep; legacy still flows (nothing silently downgrades).
          const cid = payload.Reduce('cid').Visualize();
          const phase = payload.Reduce('phase').Visualize();
          const attempts = payload.Reduce('attempts').Visualize();
          log(`[${cfg.name}] [migration] stalled-notify cid=${cid} phase=${phase} attempts=${attempts} (core re-drives via sweep)`);
        } else if (event === 'downgrade_refused') {
          // SECURITY: core DROPPED an inbound legacy plaintext app message from an
          // epoch-pinned (migrated) contact — post-migration all app data is e2e, so a
          // legacy plaintext is a downgrade attack. Core already dropped it; surface it.
          const cid = payload.Reduce('cid').Visualize();
          const wireAv = payload.Reduce('wire_id');
          const wireId = wireAv.IsNil() ? '' : String(wireAv.Visualize());
          log(`[${cfg.name}] [e2e-route] downgrade-dropped cid=${cid}${wireId ? ` wire_id=${wireId}` : ''} (legacy plaintext from a migrated peer — dropped by core)`);
        }
      },
    },
    log,
  );
}

// Start (or restart) a bot's single Telegram long-poll loop, if not already
// running. One getUpdates consumer per token — every route on the bot is served
// by this one loop via onBotMessage.
function activateBot(bot: Bot): void {
  if (bot.pollHandle) return;
  bot.pollHandle = bot.tg.poll((m) => onBotMessage(bot, m));
}

// ----- control plane (ours messenger) --------------------------------------
// Each route is itself a self-sovereign node bound + configured from the messenger
// control plane over the a2a_control channel. Verb dispatch lives in control.ts
// (shared with the e2e test); here we just drain the queue and supply the
// persist/log hooks, then re-index the route if its chat-key was changed.

const controlBusy = new Set<string>();
async function processControlRequests(conn: Connection): Promise<void> {
  if (controlBusy.has(conn.cfg.name)) return;
  controlBusy.add(conn.cfg.name);
  try {
    for (;;) {
      const reqs = await withScopeAsync(async (lt) => renderControlRequests((await conn.pkt.mutatingTx('::actor::get_control_requests', {}, lt)).Reduce('requests')));
      if (reqs.length === 0) return;
      for (const req of reqs) {
        const beforeKey = `${conn.cfg.chatId} ${conn.cfg.threadId}`;
        await dispatchControlRequest(conn.pkt, conn.cfg, req, {
          persist: () => writeMeta(conn.dir, conn.cfg),
          log: (m) => log(`[${conn.cfg.name}] ${m}`),
        });
        const afterKey = `${conn.cfg.chatId} ${conn.cfg.threadId}`;
        if (beforeKey !== afterKey) {
          const conflict = reregisterRoute(conn);
          if (conflict) log(`[${conn.cfg.name}] re-route after config change failed: ${conflict}`);
          else log(`[${conn.cfg.name}] re-routed to ${chatKey(conn.cfg.chatId, conn.cfg.threadId || undefined)} after config change`);
        }
      }
    }
  } catch (err) {
    log(`[${conn.cfg.name}] control dispatch failed:`, String(err));
  } finally {
    controlBusy.delete(conn.cfg.name);
  }
}

// Start binding the messenger control plane: generate a 6-digit code bound to an
// existing contact (the messenger must already be a contact — see /cp-invite).
// The user reads the code OUT OF BAND and enters it in the Control Panel.
async function startBind(conn: Connection, contactRef: string): Promise<string> {
  const code = String(randomBytes(3).readUIntBE(0, 3) % 1_000_000).padStart(6, '0');
  await withScopeAsync((lt) => conn.pkt.mutatingTx('::a2a_messaging::set_proxy_pending', { code, proxy: contactRef }, lt));
  log(`[${conn.cfg.name}] proxy bind started for "${contactRef}" — code ${code}`);
  return code;
}

// ----- create / restore / remove ----------------------------------------------
// Create a brand-new route live on an already-registered bot: mint a fresh packet,
// set display name + bio, persist, register in the demux, ensure the bot poll is
// running, generate an invite, return the blob to hand out.
async function createConnection(args: {
  name: string;
  botName: string;
  chatId: string;
  threadId: string;
  label: string;
  bio: string;
}): Promise<{ cid: string; invite: string; botUsername: string }> {
  const bot = bots.get(args.botName);
  if (!bot) throw new Error(`no bot named "${args.botName}" — register it with add_bot`);
  try {
    // Fail before minting an identity if the slot is taken.
    const slotErr = routeSlotConflict(bot, args.chatId, args.threadId);
    if (slotErr) throw new Error(slotErr);

    const dir = connDir(args.name);
    fs.mkdirSync(dir, { recursive: true });
    const seed = randomBytes(24).toString('hex'); // ephemeral entropy, not persisted
    const pkt = await host.createPacket(args.name, seed);
    fs.writeFileSync(keyPath(dir), exportSigningSecret(pkt), { mode: 0o600 });
    const cfg: ConnectionFile = {
      v: 1,
      name: args.name,
      botName: args.botName,
      chatId: args.chatId,
      threadId: args.threadId,
      label: args.label,
      bio: args.bio,
      deniedMessage: DEFAULT_DENIED,
      peerCid: '',
      createdAt: new Date().toISOString(),
    };
    const conn: Connection = { pkt, dir, cfg, bot, lastChat: null };
    connections.set(args.name, conn);
    // Wire handlers BEFORE the first mutating tx so save_state/notify route.
    activateRoute(conn);
    const conflict = registerRoute(conn);
    if (conflict) throw new Error(conflict);

    await withScopeAsync((lt) => pkt.mutatingTx('::a2a_messaging::set_my_name', { name: args.name }, lt));
    if (args.bio) await withScopeAsync((lt) => pkt.mutatingTx('::a2a_messaging::set_my_bio', { bio: args.bio }, lt));
    writeMeta(dir, cfg);
    saveState(pkt, dir);
    activateBot(bot); // idempotent — the bot already polls from add_bot

    // bio is embedded in the invite, so generate it AFTER set_my_bio.
    const invite = await withScopeAsync(async (lt) =>
      packInvite(Buffer.from((await pkt.mutatingTx('::a2a_messaging::generate_invite', {}, lt)).Reduce('invite').GetBinary())),
    );
    const key = isCatchAll(cfg.chatId) ? 'any chat' : chatKey(cfg.chatId, cfg.threadId || undefined);
    log(`[${args.name}] route created (bot ${botLabel(bot)}, ${key})`);
    return { cid: pkt.cid, invite, botUsername: bot.username };
  } catch (err) {
    // Roll back the half-created route so a retry with the same name works. The
    // bot keeps polling regardless — it polls from registration so /id stays live.
    if (connections.has(args.name)) removeConnection(args.name);
    throw err;
  }
}

// Recreate a persisted route on boot. Does NOT start the bot poll — main() starts
// each bot's poll once after all its routes are registered.
async function restoreConnection(name: string): Promise<void> {
  const dir = connDir(name);
  const cfg = readMeta(dir);
  const bot = bots.get(cfg.botName);
  if (!bot) {
    log(`[${name}] references unknown bot "${cfg.botName}" — skipping (add_bot then restart)`);
    return;
  }
  // Reseed from the persisted SIGN secret (adapt #77) — the seed phrase is
  // irrelevant once reseed_identity_from_secret overwrites the container id.
  const secret = fs.readFileSync(keyPath(dir), 'utf8').trim();
  const pkt = await host.createPacket(name, '', secret);
  const conn: Connection = { pkt, dir, cfg, bot, lastChat: null };
  connections.set(name, conn);
  activateRoute(conn);
  const conflict = registerRoute(conn);
  if (conflict) log(`[${name}] route conflict on restore: ${conflict} — left unrouted`);
  if (hasSavedState(dir)) {
    // Pre-migration retention (DR-ROLLOUT-PLAN §7.3): on the FIRST boot of this version
    // over an existing blob, keep a copy keyed by the new version — the last state the
    // previous version wrote. A lossy-but-successful core migration otherwise overwrites
    // in place and leaves no rollback artifact (.failed-* only covers import *failure*).
    // Same-version reboots skip (the file exists), so the copy stays the true pre-upgrade
    // blob. Same secrecy class as the live blob (0600).
    const preCopy = `${dataPath(dir)}.pre-${PKG_VERSION}`;
    if (!fs.existsSync(preCopy)) {
      try {
        fs.copyFileSync(dataPath(dir), preCopy);
        fs.chmodSync(preCopy, 0o600);
        log(`[${name}] pre-migration blob retained as ${preCopy.split('/').pop()}`);
      } catch (err) {
        log(`[${name}] pre-migration retention failed (continuing):`, String(err));
      }
    }
    try {
      const buf = fs.readFileSync(dataPath(dir));
      await withScopeAsync(async (lt) => {
        const adaptData = pkt.pw.packet.ParseValue(new Uint8Array(buf)).Attach(lt);
        await pkt.mutatingTx('::actor::import_state', adaptData, lt);
      });
    } catch (err) {
      log(`[${name}] FAILED TO IMPORT SAVED STATE — continuing with the reseeded identity; ` +
        `surviving contacts (if the blob was partially migrated) self-heal via contact restore:`, String(err));
      try {
        fs.renameSync(dataPath(dir), `${dataPath(dir)}.failed-${Date.now()}`);
        log(`[${name}] unreadable state blob preserved as state_data.bin.failed-*`);
      } catch {
        /* best effort */
      }
    }
  }
  const key = isCatchAll(cfg.chatId) ? 'any chat' : chatKey(cfg.chatId, cfg.threadId || undefined);
  log(`[${name}] restored (bot ${botLabel(bot)}, ${key}${cfg.peerCid ? `, peer ${cfg.peerCid}` : ', awaiting proxy'})`);
  // Eager restore: re-key degraded contacts + flush queues orphaned by a crash.
  await contactRestoreSweep(pkt);
  // Boot/upgrade re-advertise FIRST so a pre-existing legacy peer learns we are now
  // e2e-capable (refreshes its stored AD/caps → it offers migration back); re-fire on
  // a short schedule to catch a peer that reconnects shortly after us. Idempotent.
  await readvertiseOnUpgrade(pkt);
  for (const ms of [10_000, 30_000, 90_000]) {
    setTimeout(() => { void readvertiseOnUpgrade(pkt); }, ms);
  }
  // Proactively migrate already-e2e contacts to the double ratchet (case 3a), even
  // if they are idle — runs after restore so state is imported + the packet is
  // registered on the broker (the migration offer rides the encrypted channel).
  await migrationSweep(pkt);
  // Session-recovery fallback (self-heal after a lost/rejected state blob): re-advertise
  // a fresh AD to e2e contacts and redrive/TTL-purge unacked ratchet sends. Idempotent +
  // budgeted; re-fire on the same short schedule as readvertiseOnUpgrade so a peer that
  // reconnects shortly after us is reached. Mirrors the mcp prerelease boot sequence.
  await e2eRecoverySweep(pkt);
  for (const ms of [10_000, 30_000, 90_000]) {
    setTimeout(() => { void e2eRecoverySweep(pkt); }, ms);
  }
  // Drain any control requests queued by the control plane while we were down.
  process.nextTick(() => void processControlRequests(conn));
}

function removeConnection(name: string): string | null {
  const conn = connections.get(name);
  if (!conn) return `no connection named "${name}"`;
  unregisterRoute(conn);
  try {
    host.removePacket(conn.pkt.cid);
  } catch (err) {
    log(`[${name}] remove_packet failed:`, String(err));
  }
  connections.delete(name);
  try {
    fs.rmSync(conn.dir, { recursive: true, force: true });
  } catch (err) {
    return `deleting ${conn.dir} failed: ${String(err)}`;
  }
  return null;
}

// ----- control HTTP API (localhost) -------------------------------------------
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
}

function describeBot(bot: Bot): Record<string, unknown> {
  const routes = [...bot.exact.values()].map((c) => c.cfg.name);
  if (bot.catchAll) routes.push(bot.catchAll.cfg.name);
  return {
    name: bot.name,
    username: bot.username || null,
    tokenMasked: `${bot.token.slice(0, 8)}…`,
    routeCount: routes.length,
    routes,
    polling: bot.pollHandle !== null,
    createdAt: bot.createdAt,
  };
}

function describeConnection(conn: Connection): Record<string, unknown> {
  const contacts = withScope((lt) => renderContacts(conn.pkt.readonlyTx('::a2a_messaging::list_contacts', lt)));
  const mon = monitoringStatus(conn.pkt);
  return {
    name: conn.cfg.name,
    cid: conn.pkt.cid,
    botName: conn.cfg.botName,
    botUsername: conn.bot.username || null,
    chatId: conn.cfg.chatId,
    threadId: conn.cfg.threadId || null,
    label: conn.cfg.label,
    bio: conn.cfg.bio || null,
    deniedMessage: conn.cfg.deniedMessage || DEFAULT_DENIED,
    peerCid: conn.cfg.peerCid || null,
    controlPlaneCid: mon.proxyCid || null,
    bound: mon.proxyCid !== '',
    contacts: contacts.map((c) => ({ name: c.name, cid: c.container_id })),
    createdAt: conn.cfg.createdAt,
  };
}

function startControlServer(): void {
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${CONFIG.controlPort}`);
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, stateDir: STATE_DIR, connections: connections.size, bots: bots.size });
      }

      if (req.method === 'GET' && url.pathname === '/connections') {
        return sendJson(res, 200, { ok: true, connections: [...connections.values()].map(describeConnection) });
      }

      if (req.method === 'POST' && url.pathname === '/connections') {
        const body = (await readBody(req)) as Record<string, unknown>;
        const name = String(body.name ?? '').trim();
        const botName = String(body.botName ?? '').trim();
        const chatId = String(body.chatId ?? '').trim();
        const threadId = String(body.threadId ?? '').trim();
        const label = String(body.label ?? '').trim();
        const bio = String(body.bio ?? '').trim();
        const bad = validateName(name);
        if (bad) return sendJson(res, 400, { ok: false, error: bad });
        if (!botName) return sendJson(res, 400, { ok: false, error: 'botName is required (register a bot with add_bot first)' });
        if (!chatId) return sendJson(res, 400, { ok: false, error: 'chatId is required (use 0 for a catch-all route)' });
        if (!bots.has(botName)) return sendJson(res, 404, { ok: false, error: `no bot named "${botName}" — register it with add_bot` });
        if (connections.has(name)) return sendJson(res, 409, { ok: false, error: `a connection named "${name}" already exists` });
        try {
          const out = await createConnection({ name, botName, chatId, threadId, label, bio });
          return sendJson(res, 201, { ok: true, ...out });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String(err) });
        }
      }

      // ----- bots -----
      if (req.method === 'GET' && url.pathname === '/bots') {
        return sendJson(res, 200, { ok: true, bots: [...bots.values()].map(describeBot) });
      }

      if (req.method === 'POST' && url.pathname === '/bots') {
        const body = (await readBody(req)) as Record<string, unknown>;
        const name = String(body.name ?? '').trim();
        const botToken = String(body.botToken ?? '').trim();
        const bad = validateName(name);
        if (bad) return sendJson(res, 400, { ok: false, error: bad });
        if (!botToken) return sendJson(res, 400, { ok: false, error: 'botToken is required' });
        try {
          const out = await addBot(name, botToken);
          return sendJson(res, 201, { ok: true, ...out });
        } catch (err) {
          const msg = String(err);
          return sendJson(res, /already exists|already registered/.test(msg) ? 409 : 400, { ok: false, error: msg });
        }
      }

      const botDelMatch = url.pathname.match(/^\/bots\/(.+)$/);
      if (req.method === 'DELETE' && botDelMatch) {
        const name = decodeURIComponent(botDelMatch[1]);
        const fail = removeBot(name);
        if (fail) return sendJson(res, fail.startsWith('no bot') ? 404 : 409, { ok: false, error: fail });
        return sendJson(res, 200, { ok: true, removed: name });
      }

      // Generate a fresh invite to hand to the messenger control plane so it can
      // add this route's node as a contact (prerequisite for binding).
      const inviteMatch = url.pathname.match(/^\/connections\/([^/]+)\/cp-invite$/);
      if (req.method === 'POST' && inviteMatch) {
        const name = decodeURIComponent(inviteMatch[1]);
        const conn = connections.get(name);
        if (!conn) return sendJson(res, 404, { ok: false, error: `no connection named "${name}"` });
        try {
          const invite = await withScopeAsync(async (lt) =>
            packInvite(Buffer.from((await conn.pkt.mutatingTx('::a2a_messaging::generate_invite', {}, lt)).Reduce('invite').GetBinary())),
          );
          return sendJson(res, 200, { ok: true, invite });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String(err) });
        }
      }

      // Start binding the control plane: generate a 6-digit code bound to an
      // existing contact (the messenger). The user enters it in the Control Panel.
      const bindMatch = url.pathname.match(/^\/connections\/([^/]+)\/bind$/);
      if (req.method === 'POST' && bindMatch) {
        const name = decodeURIComponent(bindMatch[1]);
        const conn = connections.get(name);
        if (!conn) return sendJson(res, 404, { ok: false, error: `no connection named "${name}"` });
        const body = (await readBody(req)) as Record<string, unknown>;
        const contact = String(body.contact ?? '').trim();
        if (!contact) return sendJson(res, 400, { ok: false, error: 'contact (name or container id) is required' });
        try {
          const code = await startBind(conn, contact);
          return sendJson(res, 200, { ok: true, code });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String(err) });
        }
      }

      const delMatch = url.pathname.match(/^\/connections\/(.+)$/);
      if (req.method === 'DELETE' && delMatch) {
        const name = decodeURIComponent(delMatch[1]);
        const fail = removeConnection(name);
        if (fail) return sendJson(res, fail.startsWith('no connection') ? 404 : 500, { ok: false, error: fail });
        return sendJson(res, 200, { ok: true, removed: name });
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      log('control handler error:', String(err));
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
    }
  });

  // Bind to loopback only — the control API has no auth and manages bot tokens.
  server.listen(CONFIG.controlPort, '127.0.0.1', () => {
    log(`control API on http://127.0.0.1:${CONFIG.controlPort} (POST/GET/DELETE /connections)`);
  });

  const shutdown = () => {
    log('shutting down…');
    for (const bot of bots.values()) {
      try {
        bot.tg.stop();
      } catch {
        /* best effort */
      }
    }
    for (const conn of connections.values()) saveState(conn.pkt, conn.dir);
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ----- contact restore / DR self-heal retry timer ------------------------
// A periodic backstop for the four boot sweeps (contactRestoreSweep,
// readvertiseOnUpgrade, migrationSweep, e2eRecoverySweep — all also run on boot
// per route, and contactRestoreSweep again once a contact heals via the
// 'contact_restored' notify): retries restore requests for contacts still
// degraded, flushes anything queued by a heal whose notify was lost to a crash,
// re-drives stalled migrations, and re-advertises / redrives for e2e session
// recovery. All are idempotent, so a steady GC-cadence re-fire is safe. The
// reentrancy guard skips a tick if the previous sweep still runs. Mirrors the
// mcp prerelease GC timer's per-identity sweep set.
const RESTORE_SWEEP_INTERVAL_MS = 3_600_000;
let restoreSweepRunning = false;
function startRestoreSweepTimer(): void {
  setInterval(() => {
    if (restoreSweepRunning) return;
    restoreSweepRunning = true;
    void (async () => {
      try {
        for (const conn of connections.values()) {
          await contactRestoreSweep(conn.pkt);
          await readvertiseOnUpgrade(conn.pkt);
          await migrationSweep(conn.pkt);
          await e2eRecoverySweep(conn.pkt);
        }
      } finally {
        restoreSweepRunning = false;
      }
    })();
  }, RESTORE_SWEEP_INTERVAL_MS).unref();
  log(`contact restore-retry timer armed (every ${RESTORE_SWEEP_INTERVAL_MS}ms)`);
}

// ----- startup ----------------------------------------------------------------
async function main(): Promise<void> {
  log(`booting (state ${STATE_DIR}, broker ${CONFIG.brokerUrl})`);
  await host.boot();

  // 1. Load the bot registry first (one TelegramClient per bot; no poll yet).
  const botRecs = loadBotRegistry();
  for (const rec of botRecs) instantiateBot(rec);
  if (botRecs.length) log(`loaded ${botRecs.length} bot(s): ${botRecs.map((b) => b.name).join(', ')}`);

  // 2. Restore persisted routes; each resolves its bot by name.
  const names = listPersistedNames();
  if (names.length === 0) {
    log('no persisted routes — add a bot with `add_bot`, then a route with `add_new_connection`');
  } else {
    log(`restoring ${names.length} route(s): ${names.join(', ')}`);
    for (const name of names) {
      try {
        await restoreConnection(name);
      } catch (err) {
        log(`failed to restore "${name}":`, String(err));
      }
    }
  }

  // 3. One poll loop per REGISTERED bot — even with zero routes — so the built-in
  // /id probe answers in any chat the bot is in (you use it to discover the chat
  // id for the bot's first route). getMe refresh is best-effort: a transient
  // failure leaves the stored username in place rather than stopping the poll.
  for (const bot of bots.values()) {
    try {
      if (!bot.username) bot.username = (await bot.tg.getMe()).username;
    } catch (err) {
      log(`[bot ${botLabel(bot)}] getMe failed (polling anyway):`, String(err));
    }
    activateBot(bot);
  }

  startControlServer();
  startRestoreSweepTimer();
  log(`ready (bots=${bots.size}, routes=${connections.size})`);
}

main().catch((err) => {
  log(`fatal startup error: ${err?.stack ?? err}`);
  process.exit(1);
});
