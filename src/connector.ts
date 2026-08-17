#!/usr/bin/env node
//
// ours.network Telegram connector — daemon.
//
// THE CONNECTOR IS A CLIENT NOW, NOT A HOST. It used to run its own native ADAPT
// wrapper and its own MUFL packet per route. It runs neither: it attaches over
// HTTP to an ALREADY-RUNNING ours daemon and drives it through the typed API in
// @ours.network/sdk. That is what "share the daemon between the connector and
// ours-mcp" means — one engine on the box, not two.
//
// What went with the host: src/adapt.ts, the whole mufl_code/ tree including its
// core submodule, packet lifecycle, state persistence, the e2e-restore commit,
// and the deferred/migration/contact-restore sweeps. Every one of those is
// something THE DAEMON ALREADY DOES FOR ITSELF; the connector only ever ran them
// because it was its own host. There is deliberately no typed operation for any
// of them — exporting them would re-export the daemon's internals.
//
// Two layers, unchanged:
//
//   BOT   — one Telegram bot token == one getUpdates poll loop (Telegram allows
//           only ONE consumer per token). A bot fans its updates out to many
//           routes by chat-key.
//   ROUTE — one ours.network identity (in the DAEMON) pinned to one chat-key. A chat-key is a
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
// Persistence — AND NOTE WHAT IS NO LONGER HERE:
//   STATE_DIR/bots.json          { name: { name, token, username, createdAt } }
//   STATE_DIR/<route-name>/connection.json
//                                { botName, chatId, threadId, bio, label,
//                                  peerCid, leaseToken, ... }
//
// identity.key and state_data.bin ARE GONE. The daemon owns identity material and
// packet state; this process holds nothing an attacker would want except the
// Telegram bot tokens and its own lease tokens. `leaseToken` is new and is what
// makes a route's daemon session survive a connector restart: it IS the session,
// so a route that regenerated one on every boot would look like a new client to
// the daemon's lease table every time.
//
// On boot the bot registry is loaded first (one TelegramClient per bot, no poll
// yet), then the daemon is SELECTED AND PROVED (see attachToDaemon), then every
// persisted route binds its identity in the daemon and starts watching its
// notification stream, then each bot's single poll starts.
//
// A localhost-only JSON control API (default :3051) is how the CLI adds / lists /
// removes routes against the live daemon, so a new packet is online to complete
// its invite handshake the moment the user pastes it.

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import * as fs from 'node:fs';

import { loadConfig, rawFileConfig, removedSttWarnings } from './config';
import {
  OursClient,
  OursError,
  resolveDaemonConfig,
  describeDaemonConfig,
  assertDaemonStateDir,
} from '@ours.network/sdk';
import type { ResolvedDaemonConfig } from '@ours.network/sdk';
import { TelegramClient } from './telegram';
import type { TelegramMessage, AttachmentDescriptor } from './telegram';
import { buildEnvelope, buildPlainPayload, attachmentMeta } from './envelope';
import type { PayloadMode, ResolvedAttachment } from './envelope';
import { watchWithRetry } from './watch';
import { chatKey, isCatchAll, resolveRoute, deliveryTarget, isIdCommand, formatChatIdReply, DEFAULT_DENIED } from './routing';

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


// ----- connection (route) model ----------------------------------------------
interface ConnectionFile {
  v: 1;
  name: string;
  botName: string; // the registered bot this route rides on (see bots.json); token is resolved from the registry
  chatId: string; // the ALLOWED Telegram chat ('' or '0' => catch-all); string preserves large/negative ids
  threadId: string; // forum topic id ('' => whole chat); pins the route to a single topic
  label: string;
  bio: string; // group/topic context set on the identity (embedded in its invite, read by the agent)
  payloadMode: PayloadMode; // envelope preserves Telegram metadata; plain forwards DM text directly
  deniedMessage: string; // reply sent to a non-routed chat when the bot serves exactly one route
  peerCid: string; // the proxy agent's container id once it accepts the invite ('' until then)
  // This route's daemon lease token. PERSISTED ON PURPOSE: the token IS the
  // session, so regenerating it on every boot would make the daemon's lease table
  // see a brand-new client each time and the route would have to re-bind rather
  // than resume. Absent in routes created before the SDK conversion — those get
  // one minted on first restore, which re-binds once and then stays stable.
  leaseToken?: string;
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
  /** This route's own session with the daemon. One client per route: the lease
   *  token IS the session, so two routes sharing one would share a binding. */
  client: OursClient;
  dir: string;
  cfg: ConnectionFile;
  bot: Bot;
  lastChat: { chatId: string; threadId: string } | null; // most recent inbound origin (reverse-delivery target for non-topic-pinned routes)
  /** Stops this route's notification watch on removal / shutdown. */
  watch: AbortController | null;
}

// ----- the daemon this connector is attached to ------------------------------
// Resolved and PROVED once at boot, then shared by every route's client.
//
// The connector implements NO credential resolution of its own, on purpose. The
// SDK's resolveDaemonConfig tracks the SOURCE of every auth-affecting field and
// refuses an incoherent combination BEFORE reading a token or opening a socket —
// selecting an endpoint while the state directory stays defaulted would otherwise
// read the live ~/.ours token and send it wherever the endpoint points. That is a
// reproduced credential-disclosure bug (ours-sdk 43ca743), and a second
// implementation here is exactly how it would come back.
let daemon: ResolvedDaemonConfig | null = null;

async function attachToDaemon(): Promise<ResolvedDaemonConfig> {
  const cfg = resolveDaemonConfig({
    ...(CONFIG.daemonUrl ? { endpoint: CONFIG.daemonUrl } : {}),
    ...(CONFIG.daemonStateDir ? { stateDir: CONFIG.daemonStateDir } : {}),
  });
  // Prove WHICH daemon answered before any credential is sent. The probe is the
  // unauthenticated /state-dir route, which is why it is safe to send it to an
  // address that has not identified itself yet.
  await assertDaemonStateDir(cfg);
  log(`attached to daemon ${JSON.stringify(describeDaemonConfig(cfg))}`);
  return cfg;
}

/**
 * This route's session with the daemon. The lease token is persisted per route
 * (see ConnectionFile.leaseToken) so a restart RESUMES the session rather than
 * arriving as a new client.
 */
function clientFor(cfg: ConnectionFile): OursClient {
  if (!daemon) throw new Error('not attached to a daemon yet');
  return new OursClient({
    url: daemon.baseUrl.value,
    leaseToken: cfg.leaseToken!,
    ...(daemon.token ? { apiToken: daemon.token.value } : {}),
  });
}
const connections = new Map<string, Connection>(); // route name -> route
const bots = new Map<string, Bot>(); // bot name -> bot


// Route names are BOTH an on-disk directory component here AND an identity name
// in the daemon. The daemon enforces its own rule and will reject a bad one on
// createIdentity — this check exists for the half it cannot see: a name that
// would escape STATE_DIR. Deliberately NOT a copy of the daemon's NAME_RE; two
// copies of one rule drift, and the daemon's answer is the authoritative one.
function routeNameError(name: string): string | null {
  if (!name) return 'name is required';
  if (name.length > 64) return 'name must be at most 64 characters';
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    return `"${name}" is not usable as a directory name`;
  }
  return null;
}


// ----- per-route paths --------------------------------------------------------
// identity.key and state_data.bin are NOT here any more, and neither are their
// path helpers: the daemon owns identity material and packet state. A route
// directory holds connection.json and nothing else.
const connDir = (name: string) => join(STATE_DIR, name);
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
  if (cfg.payloadMode !== 'plain' && cfg.payloadMode !== 'envelope') cfg.payloadMode = 'envelope';
  return cfg;
}

function writeMeta(dir: string, cfg: ConnectionFile): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${metaPath(dir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, metaPath(dir));
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

// There is no re-index helper any more: a route's chat-key was only ever edited
// in flight by the control plane's set_config, which went with the control plane.
// A chat-key now changes by removing the route and adding it back.

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

/**
 * Watch this route's notification stream and react. THIS REPLACES wireHandlers.
 *
 * As a host the connector installed packet callbacks and got `notify_agent`
 * events synchronously. As a client it long-polls
 * `GET /identities/<name>/notifications`, which the daemon serves from the same
 * durable notifications.log those callbacks used to write. The events are the
 * SAME NAMES with the SAME content-free payloads, so the arms below are the old
 * ones minus the packet plumbing.
 *
 * WHAT IS DELIBERATELY GONE: every migration/e2e proof line. Those were
 * observability for an engine THIS PROCESS NO LONGER RUNS — the daemon logs them,
 * and re-logging them here would claim knowledge of a session we do not hold.
 *
 * THE WATCH IS KEPT ALIVE ACROSS TRANSIENT FAILURES (see src/watch.ts). A
 * callback could not stop; a long poll can, and the SDK generator throws out of
 * `for await` on any fetch failure or daemon-side error. Giving up there would
 * leave the route reading Telegram and never answering it.
 */
function watchRoute(conn: Connection): void {
  if (conn.watch) return;
  const ctrl = new AbortController();
  conn.watch = ctrl;
  const { cfg, client } = conn;
  void watchWithRetry(
    // `since: 'tip'` skips the backlog: anything already in the log was handled
    // before this restart, and get_messages is the source of truth regardless —
    // a replayed event would at worst cause one redundant, empty poll.
    () => client.watchNotifications(cfg.name, { since: 'tip', signal: ctrl.signal }),
    {
      signal: ctrl.signal,
      onEvent: async (ev) => {
        const event = String(ev.event ?? '');
        try {
          if (event === 'message_received') {
            await forwardToTelegram(conn);
          } else if (event === 'file_received') {
            await forwardFilesToTelegram(conn);
          } else if (event === 'contact_accepted' || event === 'sibling_contact_added' || event === 'local_contact_added') {
            // The FIRST accepted contact is the proxy agent (telegram traffic routes
            // there). Later contacts must NOT clobber it, so only set peerCid while
            // it is still empty.
            const name = String(ev.from ?? ev.name ?? '');
            const cid = String(ev.container_id ?? ev.cid ?? '');
            if (cid && !cfg.peerCid) {
              cfg.peerCid = cid;
              writeMeta(conn.dir, cfg);
              log(`[${cfg.name}] proxy agent connected: "${name}" (${cid})`);
            } else {
              log(`[${cfg.name}] contact added: "${name}" (${cid})`);
            }
          } else if (event === 'contact_restored') {
            // Observability only now: the DAEMON drains the deferred queue on its
            // own sweep. As a host this arm called flush_deferred itself.
            log(`[${cfg.name}] contact "${String(ev.from ?? '')}" restored (re-keyed) — daemon will drain the queue`);
          }
        } catch (err) {
          // One bad event must not tear the stream down.
          log(`[${cfg.name}] handling ${event} failed:`, String(err));
        }
      },
      // The re-armed watch primes at `tip` like the first one, so it does not
      // replay what landed while it was down. This is the same drain
      // restoreConnection does on boot, for the same reason.
      onResume: async () => {
        log(`[${cfg.name}] notification watch resumed — draining what arrived while it was down`);
        await forwardToTelegram(conn);
        await forwardFilesToTelegram(conn);
      },
      onError: (err, delayMs) => {
        log(`[${cfg.name}] notification watch failed (retrying in ${delayMs}ms):`, String(err));
      },
    },
  );
}

// invite yet, there is no contact and the message is dropped with a log line.
async function forwardToNode(conn: Connection, m: TelegramMessage): Promise<void> {
  const { client, cfg } = conn;
  const resolved = m.attachment ? await resolveAttachment(conn, m.attachment) : undefined;

  // THE AUDIO IS ALWAYS FORWARDED WHEN IT RESOLVED. This connector no longer
  // transcribes anything: transcription belongs to the ours SDK, and the SDK
  // only ever sees a voice note if the bytes actually reach the receiver. The
  // old `forwardVoiceAudio: false` default suppressed exactly those bytes on a
  // successful local transcription, so keeping it while deleting src/stt.ts
  // would have delivered nothing at all. There is deliberately no condition
  // here any more.
  //
  // What makes this work without a transcription client: attachmentMeta() stamps
  // `audio/ogg; x-ours-kind=voice-message` (envelope.ts VOICE_MESSAGE_MIME) on
  // every semantic `voice` attachment, and that marker is precisely what the
  // SDK's isVoiceMessage() matches when the receiving side pulls the file with
  // get_files. The transcript is produced there, once, under the RECEIVER's
  // `stt` config in ~/.ours/config.json.
  const sendAudio = !!(resolved?.ok);

  const targets: string[] = [];
  if (cfg.peerCid) {
    targets.push(cfg.peerCid);
  } else {
    try {
      for (const c of (await client.listContacts()).contacts) targets.push(c.container_id);
    } catch (err) {
      log(`[${cfg.name}] list_contacts failed:`, String(err));
    }
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
      try {
        // data_base64 rather than a path: the bytes came off Telegram and are in
        // memory. Writing them to a temp file just to name it would put message
        // content on this box's disk for no reason.
        const r = await client.sendFile({
          contact: target,
          data_base64: Buffer.from(resolved.bytes).toString('base64'),
          filename: meta.filename,
          mime: meta.mime,
        });
        // `introduced` is the one outcome with no wireId — it means the send took
        // the introduction-request path and there is nothing yet to reference.
        fileWireId = 'wireId' in r ? r.wireId : undefined;
      } catch (err) {
        log(`[${cfg.name}] send_file to ${target} failed:`, String(err));
      }
    }
    // `sendAudio` is now simply "the bytes resolved", so the envelope announces
    // the attachment exactly when one was sent. The text-only-transcript case
    // that used to omit it no longer exists here.
    const body = cfg.payloadMode === 'plain'
      ? buildPlainPayload(m, resolved, fileWireId)
      : buildEnvelope(m, sendAudio ? resolved : undefined, fileWireId);
    // In plain mode, a caption-less attachment is represented completely by
    // send_file. Do not manufacture an empty text message or a JSON wrapper.
    if (body === undefined) continue;
    try {
      const sent = await client.sendMessage({ contact: target, text: body });
      if (sent.kind === 'deferred') {
        log(`[${cfg.name}] message to ${target} queued — contact restore in progress (${sent.queued} queued)`);
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
  const { client, cfg, bot } = conn;
  let fresh;
  try {
    fresh = (await client.getMessages()).messages;
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
      await client.deferMessages({ msg_ids: fresh.map((m) => Number(m.msg_id)) });
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
        await client.deferMessages({ msg_ids: [Number(m.msg_id)] });
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
  const { client, cfg, bot } = conn;
  let fresh;
  try {
    fresh = (await client.getFiles()).files;
  } catch (err) {
    log(`[${cfg.name}] get_files failed:`, String(err));
    return;
  }
  if (fresh.length === 0) return;
  const target = deliveryTarget(cfg.chatId, cfg.threadId, conn.lastChat);
  if (!target || !target.chatId || isCatchAll(target.chatId)) {
    log(`[${cfg.name}] ${fresh.length} agent file(s) with no known destination chat — deferring`);
    try {
      await client.deferFiles({ file_ids: fresh.map((f) => Number(f.file_id)) });
    } catch {
      /* best effort */
    }
    return;
  }
  for (const f of fresh) {
    // THE BYTES ARE NOT IN THE RESULT. getFiles writes each file into the
    // daemon-owned identity folder and reports metadata; GET /files/<wire_id>
    // serves it back, scoped to THIS session's bound identity. That indirection
    // is what keeps a multi-megabyte upload out of a JSON body.
    let bytes: Uint8Array;
    try {
      bytes = await client.fetchFile(f.wire_id);
    } catch (err) {
      log(`[${cfg.name}] fetching file #${f.file_id} from the daemon failed:`, String(err));
      try { await client.deferFiles({ file_ids: [Number(f.file_id)] }); } catch { /* best effort */ }
      continue;
    }
    // Guard Telegram's upload ceiling (a contact can send more than we can upload).
    if (bytes.length > CONFIG.outboundFileMaxBytes) {
      log(`[${cfg.name}] file #${f.file_id} "${f.filename}" (${bytes.length} B) exceeds the ${CONFIG.outboundFileMaxBytes}-byte upload cap — skipping`);
      continue; // dropped from the queue (already marked processed); see OQ3
    }
    try {
      await bot.tg.sendDocument(target.chatId, Buffer.from(bytes), f.filename, f.mime || undefined, target.threadId || undefined);
    } catch (err) {
      log(`[${cfg.name}] telegram file delivery failed for #${f.file_id}:`, String(err));
      // THE DATA-LOSS PATH deferFiles exists for: the file is already marked
      // processed daemon-side, so without this hand-back a transient Telegram
      // outage loses it silently.
      try {
        await client.deferFiles({ file_ids: [Number(f.file_id)] });
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


// Start (or restart) a bot's single Telegram long-poll loop, if not already
// running. One getUpdates consumer per token — every route on the bot is served
// by this one loop via onBotMessage.
function activateBot(bot: Bot): void {
  if (bot.pollHandle) return;
  bot.pollHandle = bot.tg.poll((m) => onBotMessage(bot, m));
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
  payloadMode: PayloadMode;
}): Promise<{ cid: string; invite: string; botUsername: string }> {
  const bot = bots.get(args.botName);
  if (!bot) throw new Error(`no bot named "${args.botName}" — register it with add_bot`);
  try {
    // Fail before minting an identity if the slot is taken.
    const slotErr = routeSlotConflict(bot, args.chatId, args.threadId);
    if (slotErr) throw new Error(slotErr);

    const dir = connDir(args.name);
    fs.mkdirSync(dir, { recursive: true });
    const cfg: ConnectionFile = {
      v: 1,
      name: args.name,
      botName: args.botName,
      chatId: args.chatId,
      threadId: args.threadId,
      label: args.label,
      bio: args.bio,
      payloadMode: args.payloadMode,
      deniedMessage: DEFAULT_DENIED,
      peerCid: '',
      // Minted once, here, and persisted. See ConnectionFile.leaseToken.
      leaseToken: randomBytes(24).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    const client = clientFor(cfg);
    const conn: Connection = { client, dir, cfg, bot, lastChat: null, watch: null };
    connections.set(args.name, conn);
    const conflict = registerRoute(conn);
    if (conflict) throw new Error(conflict);

    // The daemon mints the identity, names it and binds it to THIS route's
    // session. exposeLocal is false: a route identity is reached by invite, not
    // by the host contact book.
    const made = await client.createIdentity({
      name: args.name, bio: args.bio, exposeLocal: false, localAutoAccept: true,
    });
    writeMeta(dir, cfg);
    watchRoute(conn);
    activateBot(bot); // idempotent — the bot already polls from add_bot

    // bio is embedded in the invite, so generate it AFTER createIdentity set it.
    const invite = await client.generateInvite({});
    const key = isCatchAll(cfg.chatId) ? 'any chat' : chatKey(cfg.chatId, cfg.threadId || undefined);
    log(`[${args.name}] route created (bot ${botLabel(bot)}, ${key})`);
    return { cid: made.info.cid, invite: invite.blob, botUsername: bot.username };
  } catch (err) {
    // Roll back the half-created route so a retry with the same name works. The
    // bot keeps polling regardless — it polls from registration so /id stays live.
    if (connections.has(args.name)) await removeConnection(args.name);
    throw err;
  }
}

// Recreate a persisted route on boot. Does NOT start the bot poll — main() starts
// each bot's poll once after all its routes are registered.
async function restoreConnection(name: string): Promise<void> {
  const dir = connDir(name);
  const cfg = readMeta(dir);
  const bot = bots.get(cfg.botName);
  if (!bot) throw new Error(`route "${name}" references unknown bot "${cfg.botName}"`);
  // A route created before the SDK conversion has no lease token. Mint one and
  // persist it: it re-binds once here and is stable from then on.
  if (!cfg.leaseToken) {
    cfg.leaseToken = randomBytes(24).toString('hex');
    writeMeta(dir, cfg);
    log(`[${name}] minted a lease token (route predates the daemon-attach conversion)`);
  }
  const client = clientFor(cfg);
  const conn: Connection = { client, dir, cfg, bot, lastChat: null, watch: null };

  // BIND, DO NOT CREATE. The identity lives in the daemon and survived this
  // process restarting; choose_identity re-attaches this session to it. `force`
  // is false on purpose — if another live session holds it, that is a real
  // conflict and the route must say so rather than steal the binding.
  try {
    await client.chooseIdentity({ name, force: false });
  } catch (err) {
    if (err instanceof OursError && err.code === 'NO_SUCH_IDENTITY') {
      throw new Error(
        `route "${name}" has no identity in the daemon at ${daemon?.baseUrl.value}. ` +
        'Either this is the wrong daemon, or the identity was removed — the route is NOT being ' +
        'recreated, because that would mint a new container id and silently break every contact.',
      );
    }
    throw err;
  }
  connections.set(name, conn);
  const conflict = registerRoute(conn);
  if (conflict) throw new Error(conflict);
  watchRoute(conn);
  // Anything that arrived while this process was down is already in the daemon;
  // one drain now rather than waiting for the next notification.
  await forwardToTelegram(conn);
  await forwardFilesToTelegram(conn);
  log(`[${name}] route restored (bot ${botLabel(bot)})`);
}

async function removeConnection(name: string): Promise<string | null> {
  const conn = connections.get(name);
  if (!conn) return `no connection named "${name}"`;
  unregisterRoute(conn);
  conn.watch?.abort();
  conn.watch = null;
  // RELEASE THE LEASE, DO NOT DELETE THE IDENTITY. As a host, removing a route
  // destroyed its packet — the identity WAS the route. Attached, the identity
  // lives in a daemon this connector shares with other clients, so tearing it
  // down here would delete something that is not ours to delete. The route's
  // config goes; the identity stays until someone removes it deliberately.
  try {
    await conn.client.releaseLease();
  } catch (err) {
    log(`[${name}] releasing the daemon lease failed:`, String(err));
  }
  connections.delete(name);
  try {
    fs.rmSync(conn.dir, { recursive: true, force: true });
  } catch (err) {
    return `deleting ${conn.dir} failed: ${String(err)}`;
  }
  log(`[${name}] route removed (its identity remains in the daemon)`);
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

async function describeConnection(conn: Connection): Promise<Record<string, unknown>> {
  // Contacts are read from the daemon. The monitoring/control-plane fields this
  // used to report — controlPlaneCid, bound — are gone with messenger
  // manageability; nothing reports them because nothing can be bound any more.
  let contacts: { name: string; cid: string }[] = [];
  let cid: string | null = null;
  try {
    contacts = (await conn.client.listContacts()).contacts.map((c) => ({ name: c.name, cid: c.container_id }));
    cid = (await conn.client.currentIdentity()).cid;
  } catch (err) {
    log(`[${conn.cfg.name}] reading route state from the daemon failed:`, String(err));
  }
  return {
    name: conn.cfg.name,
    cid,
    botName: conn.cfg.botName,
    botUsername: conn.bot.username || null,
    chatId: conn.cfg.chatId,
    threadId: conn.cfg.threadId || null,
    label: conn.cfg.label,
    bio: conn.cfg.bio || null,
    payloadMode: conn.cfg.payloadMode,
    deniedMessage: conn.cfg.deniedMessage || DEFAULT_DENIED,
    peerCid: conn.cfg.peerCid || null,
    contacts,
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
        const payloadMode = String(body.payloadMode ?? 'envelope').trim();
        const bad = routeNameError(name);
        if (bad) return sendJson(res, 400, { ok: false, error: bad });
        if (!botName) return sendJson(res, 400, { ok: false, error: 'botName is required (register a bot with add_bot first)' });
        if (!chatId) return sendJson(res, 400, { ok: false, error: 'chatId is required (use 0 for a catch-all route)' });
        if (payloadMode !== 'plain' && payloadMode !== 'envelope') {
          return sendJson(res, 400, { ok: false, error: 'payloadMode must be "plain" or "envelope"' });
        }
        if (!bots.has(botName)) return sendJson(res, 404, { ok: false, error: `no bot named "${botName}" — register it with add_bot` });
        if (connections.has(name)) return sendJson(res, 409, { ok: false, error: `a connection named "${name}" already exists` });
        try {
          const out = await createConnection({
            name, botName, chatId, threadId, label, bio, payloadMode,
          });
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
        const bad = routeNameError(name);
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

      // REMOVED WITH MESSENGER MANAGEABILITY: POST /connections/<n>/cp-invite and
      // POST /connections/<n>/bind. They minted an invite for the ours messenger
      // and started the 6-digit control-plane bind. The connector is no longer a
      // managed node, so there is nothing to invite and nothing to bind; the CLI
      // commands that drove them (cp_invite, bind_proxy) are gone too.

      const delMatch = url.pathname.match(/^\/connections\/(.+)$/);
      if (req.method === 'DELETE' && delMatch) {
        const name = decodeURIComponent(delMatch[1]);
        const fail = await removeConnection(name);
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
    // NOTHING TO SAVE. The daemon owns packet state; this process holds only
    // config, which is written on change. What DOES need doing on the way out is
    // stopping the notification watches so the daemon's long-polls close cleanly
    // rather than waiting out their deadline.
    for (const conn of connections.values()) conn.watch?.abort();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// The contact-restore retry timer went with contactRestoreSweep — the daemon
// runs its own sweep, and a second one here would be a client retrying repairs
// on a session it does not hold. The 'contact_restored' notify is observability
// now (see watchRoute), not a trigger.

// ----- startup ----------------------------------------------------------------
async function main(): Promise<void> {
  log(`booting (config ${STATE_DIR})`);

  // Before anything else, and regardless of how many routes exist: tell an
  // operator who still has the removed stt* settings that they are inert. This
  // runs first so it cannot be buried under route-restore output.
  for (const line of removedSttWarnings(rawFileConfig(), process.env)) log(line);

  daemon = await attachToDaemon();

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
