#!/usr/bin/env node
//
// a2adapt Telegram connector — daemon.
//
// One process == one native ADAPT wrapper hosting N messenger packets. Two layers:
//
//   BOT   — one Telegram bot token == one getUpdates poll loop (Telegram allows
//           only ONE consumer per token). A bot fans its updates out to many
//           routes by chat-key.
//   ROUTE — one a2adapt identity (packet) pinned to one chat-key. A chat-key is a
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

import { loadConfig } from './config';
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
import type { ResolvedAttachment } from './envelope';
import { chatKey, isCatchAll, resolveRoute, deliveryTarget, isIdCommand, formatChatIdReply } from './routing';

const CONFIG = loadConfig();
const STATE_DIR = CONFIG.stateDir;

const log = (...parts: unknown[]) => process.stderr.write(`a2adapt-tg: ${parts.join(' ')}\n`);

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
    const bytes = withScope((lt) => Buffer.from(pkt.readonlyTx('::actor::export_state', lt).Serialize()));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${dataPath(dir)}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, dataPath(dir));
  } catch (err) {
    log(`[${pkt.name}] failed to save state:`, String(err));
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
  const tg = new TelegramClient(rec.token, CONFIG.pollTimeoutSec, (m) => log(`[bot ${rec.name}] tg: ${m}`));
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
  const tg = new TelegramClient(token, CONFIG.pollTimeoutSec, (m) => log(`[bot ${name}] tg: ${m}`));
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

// ----- the bridge -------------------------------------------------------------
// Telegram → agent: forward an inbound message to the route's proxy as a JSON
// envelope (sender/chat/reply/forward metadata + the text, plus the file inline
// as base64 for a media message). We send to the route's peer if known, else to
// every contact (covers the one proxy agent). If the agent has not accepted the
// invite yet, there is no contact and the message is dropped with a log line.
async function forwardToNode(conn: Connection, m: TelegramMessage): Promise<void> {
  const { pkt, cfg } = conn;
  const resolved = m.attachment ? await resolveAttachment(conn, m.attachment) : undefined;
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
    if (m.attachment && resolved?.ok) {
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
    const body = buildEnvelope(m, resolved, fileWireId);
    try {
      await withScopeAsync((lt) => pkt.mutatingTx('::a2a_messaging::send_message', { contact: target, text: body }, lt));
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
      onSaveState: () => saveState(pkt, dir),
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

// ----- control plane (a2adapt messenger) --------------------------------------
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
    try {
      const buf = fs.readFileSync(dataPath(dir));
      await withScopeAsync(async (lt) => {
        const adaptData = pkt.pw.packet.ParseValue(new Uint8Array(buf)).Attach(lt);
        await pkt.mutatingTx('::actor::import_state', adaptData, lt);
      });
    } catch (err) {
      log(`[${name}] failed to import saved state (continuing fresh):`, String(err));
    }
  }
  const key = isCatchAll(cfg.chatId) ? 'any chat' : chatKey(cfg.chatId, cfg.threadId || undefined);
  log(`[${name}] restored (bot ${botLabel(bot)}, ${key}${cfg.peerCid ? `, peer ${cfg.peerCid}` : ', awaiting proxy'})`);
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
  log(`ready (bots=${bots.size}, routes=${connections.size})`);
}

main().catch((err) => {
  log(`fatal startup error: ${err?.stack ?? err}`);
  process.exit(1);
});
