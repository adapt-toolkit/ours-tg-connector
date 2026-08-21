# ours-tg-connector — put your AI agents in Telegram

**Let people talk to your agents from a Telegram chat, group, or forum topic —
and let your agents reply, send files, even understand voice notes.** One
Telegram bot can proxy **many chats at once — each chat (or forum topic) wired to
its own agent** over an end-to-end-encrypted channel, all on a single shared poll
loop.

```
                       ┌──────── one bot token ────────┐
 chat A ─┐             │   single getUpdates poll loop  │
 chat B ─┤  Telegram   │        (demux by chat-key)     │
 topic#7 ┘             └──┬──────────┬──────────┬───────┘
                          ▼          ▼          ▼
                    identity A  identity B  identity C   ← daemon identity per chat-key
                          │          │          │  send_message
                          ▼          ▼          ▼
                      Agent X     Agent X     Agent Y    ← same agent can serve many
```

Two layers:

- **Bot** — a Telegram bot token **registered once under a friendly name**
  (`add_bot`). One token == one `getUpdates` poll loop (Telegram allows only one
  consumer per token). The loop demultiplexes each update to a route by **chat-key**
  (`chatId`, or `chatId:threadId` for a forum topic).
- **Route** — one ours identity in the shared daemon pinned to one chat-key,
  bridged to one proxy agent. A route **references its bot by name**, so the token
  lives in exactly one place; many routes share a bot. The invite a route emits is
  byte-compatible with the ours `add_contact` tool.

Because each identity is pinned to exactly one chat-key, **reverse delivery is
structural**: an agent's reply arrives on the identity that *is* the chat, so it
can only ever go back to its origin. The **same agent can serve several chats** by
being a contact of several route identities — it tells them apart by which contact
(name + **bio**) a message is on, never by parsing the text. Each route's bio
carries the group/topic context the agent should know ("ACME #billing — paying
customers; escalate refunds to a human").

## How it works

1. You run `add_bot` once per Telegram bot, giving it a name + its token. The
   connector validates the token (`getMe`), captures the `@username`, and records
   it in the bot registry (`bots.json`).
2. You run `add_new_connection` referencing that bot by name (`--bot <name>`) plus a
   chat id (+ optional `--thread-id` for a forum topic and `--bio` for the agent's
   context). The connector mints a fresh identity, sets its name + bio, and prints
   an **invite blob**.
3. You paste that blob into your proxy agent via its `add_contact`. The connector
   route identity — already live through the daemon — completes the encrypted-channel handshake.
4. From then on:
   - every message in that chat/topic is forwarded to its agent as a JSON
     **message envelope** (sender + chat metadata, reply/forward context, and any
     attached file via the core 3.1 file channel — see
     [Message envelope](#message-envelope) and [File transfer](#file-transfer-core-31));
   - every message the agent sends back is delivered to that same chat/topic with
     Markdown formatting and exact reply threading when `reply_to.wire_id` is
     available; a file the agent sends is delivered with `sendDocument`.
5. Re-run `add_new_connection` with the **same `--bot`** and a different
   `--chat-id`/`--thread-id` to add more routes on the one bot. Point two routes at
   the same agent and it sees two distinct contacts (distinct bios) — one per chat.

For a one-to-one route, add `--payload-mode plain` (or `--plain`) to forward
message text directly without the Telegram JSON envelope. The default remains
`envelope`, which is required for groups/topics where per-message sender and chat
metadata distinguishes participants. Files always use the core file channel in
both modes; Telegram voice notes retain the protocol MIME marker
`audio/ogg; x-ours-kind=voice-message`, allowing the receiving daemon to invoke
its native voice-transcription path even when no companion text is sent.

Messages are end-to-end encrypted between the connector's route identity and the agent (ADAPT
encrypted channels). The connector never persists message bodies to disk — only the
bot registry (`bot name`, `token`, `@username`), route metadata (`bot name`,
`chat id`, `thread id`, `bio`, `peer cid`, and stable daemon lease), and a bounded
30-day wire-id ↔ Telegram-message-id map with per-route receipt settings. Those
persisted route names are also the connector's simple list of identities it
created. The list is organizational bookkeeping, not an authorization or
provenance boundary; identity keys and packet state stay in the shared daemon.

### Routing rules

- A **topic message** (in a forum supergroup) prefers an exact `chatId:threadId`
  route; failing that it falls to a whole-chat `chatId` route, then the bot's
  catch-all. A topic-pinned route always replies into its own topic.
- A **whole-chat route** (no `--thread-id`) handles a non-forum group, or every
  topic of a forum that has no topic-specific route; it replies into the topic the
  message came from (best-effort — one route per topic is the unambiguous setup).
- `--chat-id 0` makes a **catch-all** route: it handles any chat the bot sees that
  no other route claims, replying to whichever chat last spoke.
- A chat the bot is in with **no** matching route is ignored (a bot can sit in many
  groups it doesn't serve). The classic denial reply is sent only when a bot serves
  exactly one chat and that route set a denial message.

> **Bot privacy mode:** to proxy *all* messages in a group, the bot must either be
> a group **admin** or have privacy mode **disabled** via BotFather `/setprivacy`
> (then removed and re-added to the group). Otherwise Telegram only delivers
> commands, replies, and @mentions to the bot. Forum topic management
> (`createForumTopic`, …) needs admin with `can_manage_topics`.

### Discovering a chat id (`/id`)

Every bot answers a built-in out-of-band command — send **`/id`** (or
**`/id@<bot_username>`**) in any chat, group, or forum topic the bot is in and it
replies immediately with that chat's identifiers: `chat id`, type, title/@username,
the `message_thread_id` (in a forum topic), your user id, and a ready-to-paste
`add_new_connection` line. A bot polls from the moment you `add_bot` it (no route
required), and the probe is handled before routing — so the **normal first-run flow
works**: `add_bot`, drop the bot in the group, send `/id`, then feed the returned
`--chat-id`/`--thread-id` into `add_new_connection`. It never reaches an agent and
bypasses normal processing entirely.

In a **privacy-mode** group only the `/id@<bot_username>` form is delivered (see the
note above); in DMs and privacy-off groups bare `/id` works too. In a group with
several bots, only the one named in `/id@<bot_username>` answers.

### Message envelope

Each inbound Telegram message is forwarded to the agent as a single **JSON
envelope** (it is the `text` of the underlying `send_message`). This gives the
agent context it otherwise could not have: in a group chat every Telegram user
arrives on the *same* ours contact, so the per-message `from`/`chat` metadata
is the only way to tell who is speaking and where.

```json
{
  "v": 2,
  "source": "telegram",
  "message_id": 4521,
  "date": "2026-06-22T14:30:02Z",
  "from":  { "id": 12345, "name": "Alice Smith", "username": "alice" },
  "chat":  { "id": -1001234567890, "type": "supergroup",
             "title": "ACME Support", "username": "acmesupport", "thread_id": 7 },
  "reply_to": { "message_id": 678, "text": "earlier message excerpt…" },
  "forwarded_from": { "type": "channel", "name": "ACME News",
                      "username": "acmenews", "message_id": 99 },
  "text": "Can you check my refund?",
  "attachment": { "kind": "document", "filename": "receipt.pdf", "mime": "application/pdf",
                  "size": 48211, "transport": "send_file", "wire_id": "ours-file-…" }
}
```

- **Absent optional fields are omitted** (no `username` when the sender has none;
  no `reply_to` / `forwarded_from` / `attachment` when not applicable). `text` is
  always present (`""` for a caption-less media message). `v` versions the shape
  (now **2** — see [File transfer](#file-transfer-core-31)).
- **Attachments** carry only metadata under `attachment`; the file **bytes travel
  separately** on the core 3.1 file channel (no more base64 inline). `kind` is one
  of `photo · document · video · audio · voice · video_note · animation ·
  sticker`. On a successful transfer the block carries `transport: "send_file"`
  and the file's `wire_id`, which correlates the separately-arriving file to this
  message. A file over the size cap (or one that fails to download) is still
  announced — the `attachment` object is present with its metadata but **no
  `wire_id`** (no file was sent), plus an `omitted` (over cap) or `error`
  (download failed) note. The inbound cap is `attachmentMaxBytes` (default
  **10 MB**; see [Configuration](#configuration)).

### File transfer (core 3.1)

Core 3.1 adds a first-class file-transfer pair (`send_file` / `receive_file`),
distinct from `send_message`, so files and text are always separate messages.

- **Inbound (Telegram → agent).** A media message's bytes are sent to the proxy
  agent via **`send_file`** (raw bytes on the file channel); its caption + sender/
  chat metadata ride the **v2 envelope** on `send_message`. The envelope's
  `attachment.wire_id` is the `send_file` wire id, so the agent correlates the two.
  This replaces the interim base64-in-`text` transport. **The proxy agent must
  read files from the file channel and correlate by `attachment.wire_id`** — an
  agent that still expects inline base64 will not see the bytes.
- **Outbound (agent → Telegram).** A file the agent sends arrives via
  `receive_file`, is stored in the daemon's durable per-identity history, and is
  delivered to the chat (and forum topic, if pinned) with Telegram
  **`sendDocument`** — preserving the original filename. The connector first
  lists unread metadata, reads the immutable blob, uploads it to Telegram, and
  only then acknowledges that exact `wire_id` with selected `getFiles`.
- **Caps.** Inbound media is bounded by `attachmentMaxBytes`
  (`OURS_TG_ATTACHMENT_MAX_BYTES`, **10 MB**, under Telegram's 20 MB bot
  download limit). A file a contact sends outbound is bounded by
  `outboundFileMaxBytes` (`OURS_TG_OUTBOUND_FILE_MAX_BYTES`, **50 MB**,
  Telegram's `sendDocument` upper bound); an over-cap outbound file is skipped and
  logged.

### Replies, formatting, and receipts

- Telegram entities (bold, italic, code, links, quotes, and related formatting)
  are converted to Markdown for the agent. Agent Markdown is rendered as
  Telegram MarkdownV2, with a plain-text fallback if Telegram rejects the parse.
- The bounded wire-id map lets agent `reply_to.wire_id` pointers become native
  Telegram replies. Telegram replies are likewise sent with a structured ours
  reply pointer when their exact mapped message is still retained. Missing or
  expired mappings degrade to an unthreaded message; the connector never guesses.
- Delivery and read receipts become one Telegram reaction per message (`👀` then
  `👌` by default). `/receipts` and `/emoji` configure them per route, and
  `/help` reports the active settings. Receipt state is monotonic and is caught
  up from durable outbound history after a restart or `sync_required` event.

### External delivery boundary

Agent messages are delivered oldest-first from the daemon's durable history.
The connector uses `listIncomingMessages` plus `getHistoryItem` to inspect one
unread body without changing state, sends it to Telegram, then acknowledges it
with `getMessages({limit:1})` and verifies the returned `wire_id` is the one it
just delivered. Per-route single-flight drains prevent concurrent notifications
from racing acknowledgements. Telegram failures leave the oldest item unread.

There is one unavoidable external side-effect window: if Telegram accepts a
message or file and the process crashes before the daemon acknowledgement, the
item stays unread and may be delivered again after restart. The connector favors
recoverability over silently losing content and does not depend on removed
defer/requeue or conversation-policy APIs.

### Voice transcription (speech-to-text)

A Telegram **voice note** carries no caption, so a bridged agent (a text LLM)
would otherwise receive an empty `text` and an unreadable audio blob. With STT
enabled, the connector transcribes the voice note and delivers the transcript
**through the normal envelope as ordinary `text`**, so any agent understands a
spoken message with **zero agent-side changes**. A small `transcription` block is
added for provenance:

```jsonc
{
  "v": 2,
  "text": "let's ship it friday",        // the transcript (voice notes have no caption)
  "transcription": {
    "text":   "let's ship it friday",
    "engine": "openai",                    // best-effort label from the provider host
    "model":  "whisper-1",
    "lang":   "en",                        // only if the provider returns it
    "status": "ok"                         // "ok" | "error"  (on error: "error":"<reason>", no text)
  }
}
```

- **Opt-in, and it covers THIS PROCESS ONLY.** Off by default
  (`sttEnabled:false`), which means *the connector* sends no audio to a
  speech-to-text provider. It does **not** mean the audio is never transcribed:
  the connector is a client of an ours daemon, and **the daemon runs its own
  speech-to-text** when the receiving side pulls a voice note — under
  configuration this connector's operator does not control and may not know
  exists. When the connector was its own host, `sttEnabled:false` did cover the
  whole path; attached, it no longer can. Turn it on and supply a key to
  transcribe here as well (see [Configuration](#configuration)).
- **No transcoding.** Telegram voice is **OGG/Opus**, which OpenAI-compatible
  transcription endpoints accept directly — the connector adds **no ffmpeg** and no
  new dependency (just built-in `fetch`).
- **Provider-agnostic.** The endpoint is `{sttBaseUrl}/audio/transcriptions` with a
  `Bearer` key — point it at OpenAI (`whisper-1`), Groq
  (`whisper-large-v3-turbo`, faster/cheaper), or a **self-hosted** `whisper.cpp`
  server. One config switch, no lock-in.
- **Audio forwarding.** By default a successfully transcribed voice note is
  delivered as **text only** (no `send_file`, no `attachment` block — the
  `transcription` block already signals it came from voice). Set
  `forwardVoiceAudio:true` to also `send_file` the `.ogg` alongside the transcript.
- **Receiver interoperability.** Whenever a semantic Telegram `voice` attachment
  is forwarded (STT is off/unavailable/fails/is over the cap, or
  `forwardVoiceAudio:true`), the original OGG/Opus bytes travel unchanged under
  a path-safe `voice_<message-id>.ogg` filename. Both `send_file.mime` and the
  correlated envelope's `attachment.mime` are exactly
  `audio/ogg; x-ours-kind=voice-message`, which is the ours-mcp recognition
  contract. The semantic Telegram attachment kind is authoritative: an ordinary
  `audio` attachment whose MIME is plain `audio/ogg` is not marked as voice.
  See [the connector/receiver contract](docs/voice-message-contract.md) for the
  independent verification matrix.
- **Graceful degradation.** If STT is disabled, fails, times out, or the audio is
  over `sttMaxBytes`, the bridge falls back to file forwarding — the
  `.ogg` is still forwarded via `send_file` and nothing the user sent is lost. When
  STT was attempted and failed, the envelope adds `transcription.status:"error"`
  (e.g. `error:"too_large"` for the size guard); the daemon logs a single line
  **without the key** and keeps polling.
- **Cost & data egress.** Transcription bills to the configured provider
  (whisper-1 ≈ **$0.006/min**, billed to the nearest second; operators pick the
  provider and bear the cost). **Audio bytes leave the host** for that provider —
  point `sttBaseUrl` at a self-hosted server to keep audio local. Per-message cost
  and latency are bounded by `sttMaxBytes` and `sttTimeoutMs`.

**Secret handling.** Supply the key via `OURS_TG_STT_API_KEY` (preferred). If it
is placed in `config.json` instead, the file stays mode `0600` and the key is
**masked** whenever the daemon rewrites config — it is never persisted in clear
and never written to logs.

## Install

Install the CLI globally from npm:

```sh
npm install -g @ours.network/tg-connector
```

Or run it from a clone of this repo:

```sh
npm install
npm run build
```

Requires Node ≥ 20, and **an ours daemon already running on this box** — the
connector attaches to it over `/api/v1` and drives it through
[`@ours.network/sdk`](https://www.npmjs.com/package/@ours.network/sdk). It runs
no engine of its own: there is no native ADAPT SDK and no MUFL packet here, so
nothing beyond `npm install` is resolved at runtime.

## Usage

```sh
# 1. register a bot ONCE under a name (validates the token via getMe)
ours-tg-connector add_bot \
  --name supportbot --bot-token 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
# positional form also works (order auto-detected by the token's «digits:rest» shape):
ours-tg-connector add_bot supportbot 123456:ABC...

ours-tg-connector list_bots             # name, @username, masked token, route count

# 2. create a route on that bot (auto-starts the connector process if needed;
#    the shared ours daemon must already be running) and print an invite
ours-tg-connector add_new_connection \
  --name support \
  --bot supportbot \
  --chat-id -1001234567890 \
  --bio "ACME support group — paying customers, reply concisely"
# positional form also works:
ours-tg-connector add_new_connection support supportbot -1001234567890

# add MORE routes on the SAME bot — different chats/topics, their own identities:
ours-tg-connector add_new_connection \
  --name sales --bot supportbot --chat-id -1009876543210
ours-tg-connector add_new_connection \
  --name billing --bot supportbot --chat-id -1001234567890 --thread-id 42 \
  --bio "ACME forum, #billing topic"

ours-tg-connector list_connections     # routes grouped by bot
ours-tg-connector remove_connection sales  # removes the route and its name-listed daemon identity
ours-tg-connector remove_bot supportbot   # refused while any route still uses it

# connector-process lifecycle (never starts or stops the shared ours daemon)
ours-tg-connector start | stop | restart | status
ours-tg-connector serve     # foreground (debugging)

# boot-persistent service (survives reboots)
ours-tg-connector install-service     # systemd (Linux) / launchd (macOS)
ours-tg-connector uninstall-service

```

`install-service` registers a **user-level** service running `serve`, bakes the
resolved config into the unit, and (on Linux) enables linger so it starts at boot
with no active login session. Inspect/follow it with
`systemctl --user status ours-telegram.service` /
`journalctl --user -u ours-telegram.service -f`.

`add_bot` registers a bot under a name and is a prerequisite for any route — the
token is given here and nowhere else. `remove_bot` deletes a registered bot but is
refused while any route still references it (remove those routes first).

For `add_new_connection`: `--name` is both the on-disk route name and the display
name the agent sees. `--bot` is the **name of a registered bot** (from `add_bot`).
`--chat-id` is the chat this route bridges (get it from the bot's updates, e.g.
message a group the bot is in and read `getUpdates`); only messages from that chat
are forwarded, and replies go back to it. `--thread-id` pins the route to one forum
topic within that chat. `--bio` is the context the agent reads about this chat
(embedded in the invite, visible when it accepts). `--chat-id 0` makes a catch-all
route for any chat the bot sees that no other route claims. Reuse the same `--bot`
across routes to multiplex one bot over many chats/topics.

`remove_connection` releases that route's daemon lease, then removes the daemon
identity by its recorded route name and deletes the local route record. Because
the ownership list is intentionally name-only, an operator who manually removes
and recreates a same-name identity has deliberately replaced it; removing the
route can remove that replacement too. Use the `ours` operator CLI to repair
orphaned or deliberately replaced identities.

## Configuration

Precedence per field: **env var > `config.json` > default**. The config file is
`OURS_TG_CONFIG`, else `~/.ours-telegram/config.json`.

| field          | env var                   | default                                         |
|----------------|---------------------------|-------------------------------------------------|
| daemon URL     | `OURS_TG_DAEMON_URL`   | `''` (the SDK's own default selection) |
| daemon state dir | `OURS_TG_DAEMON_STATE_DIR` | `''` (the SDK's own default selection) |
| control port   | `OURS_TG_CONTROL_PORT` | `3051` (localhost only)                         |
| state dir      | `OURS_TG_STATE_DIR`    | `~/.ours-telegram`                            |
| poll timeout   | `OURS_TG_POLL_TIMEOUT` | `30` (seconds, Telegram long-poll)              |
| force IPv4     | `OURS_TG_FORCE_IPV4`   | `true` (pin Telegram requests to the IPv4 A record via a dedicated undici dispatcher — avoids the intermittent `fetch failed` when IPv6 is configured but unreachable; set `0`/`false` to restore Node default resolution) |
| connect timeout | `OURS_TG_CONNECT_TIMEOUT_MS` | `10000` (bound a stalled TCP/TLS connect so a bad address fails fast, not after ~30s) |
| fetch retries  | `OURS_TG_FETCH_RETRIES` | `3` (transient-error retries for transactional calls — `sendMessage`/`sendDocument`/`getFile`/download — so one `fetch failed` doesn't drop a message; `getUpdates` runs its own backoff) |
| retry backoff  | `OURS_TG_FETCH_RETRY_BASE_MS` | `300` (base delay between those retries; grows exponentially with jitter) |
| attachment cap | `OURS_TG_ATTACHMENT_MAX_BYTES` | `10485760` (10 MB; larger inbound media forwarded as a metadata-only stub) |
| outbound file cap | `OURS_TG_OUTBOUND_FILE_MAX_BYTES` | `52428800` (50 MB; a larger file from a contact is skipped + logged — Telegram's `sendDocument` limit) |
| STT enabled    | `OURS_TG_STT_ENABLED`     | `false` (whether **this connector** transcribes voice; the attached daemon runs its own STT regardless — see [Voice](#voice-messages--speech-to-text)) |
| STT API key    | `OURS_TG_STT_API_KEY`     | `''` (secret; env preferred — masked if placed in `config.json`, never logged) |
| STT base URL   | `OURS_TG_STT_BASE_URL`    | `https://api.openai.com/v1` (OpenAI-compatible endpoint root; e.g. `https://api.groq.com/openai/v1` or a self-hosted whisper server) |
| STT model      | `OURS_TG_STT_MODEL`       | `whisper-1` (e.g. `whisper-large-v3-turbo` on Groq) |
| STT language   | `OURS_TG_STT_LANGUAGE`    | *(unset)* (optional ISO-639-1 hint; omit ⇒ provider auto-detects) |
| STT kinds      | `OURS_TG_STT_KINDS`       | `voice` (comma-list of attachment kinds to transcribe; e.g. `voice,audio`) |
| STT size guard | `OURS_TG_STT_MAX_BYTES`   | `5242880` (5 MB; audio over this skips STT and is forwarded as a file — cost/latency guard) |
| STT timeout    | `OURS_TG_STT_TIMEOUT_MS`  | `60000` (per-transcription abort deadline, ms) |
| forward voice audio | `OURS_TG_FORWARD_VOICE_AUDIO` | `false` (also `send_file` the `.ogg` alongside a successful transcript) |

`OURS_TG_DAEMON_URL` and `OURS_TG_DAEMON_STATE_DIR` are a coherent pair: set
both or neither. SDK 2 refuses an explicitly selected endpoint without its state
directory before reading a daemon token. Legacy `OURS_INSTANCE` is rejected, and
`OURS_AUTOSTART`/`autoStart` are ignored. This connector never embeds or starts an
ours daemon; operate the shared daemon separately with `ours daemon start` or
`ours daemon install-service`.

The control API is bound to `127.0.0.1` and unauthenticated — it manages bot
tokens, so do not expose the control port off-host.

## Control plane (removed)

The connector used to be a **managed node**: it advertised an app manifest
(`network.ours.telegram-connector`) and the ours messenger could bind to it over
the a2a_control channel and edit the allowed chat id and denial message live.
That is gone — messenger manageability was removed by ruling, and with it the
`cp_invite` and `bind_proxy` commands, the `get_manifest` / `get_config` /
`set_config` verbs, and the bind ceremony.

A route is configured when it is created (`add_new_connection`) and changed by
removing it and adding it back. There is no live reconfiguration path, and
nothing to bind.

## Learn more

- **How it works — the protocol, in depth:** the shared agent-to-agent core and
  wire format is documented in
  **[ours-mufl-core](https://github.com/adapt-toolkit/ours-mufl-core)**.
- **The whole project:** [ours.network](https://ours.network) ·
  [umbrella repo](https://github.com/adapt-toolkit/ours-network)

## Support ours.network

ours.network is built by a small, independent team who believe agents — and the people behind them — deserve communication that's private by construction: self-sovereign identity, end-to-end encryption, and no central party that can read, throttle, or cut you off. We release everything as free, FSL source-available software, and we run the broker and relay services that actually connect agents at our own cost.

We're at the alpha stage: we have a clear roadmap and, if this stage proves itself, proper funding will come later — but right now there is no funding and no monetization behind the project. We pay for the servers and build everything on our own time, which makes this exactly the moment when support matters most. Every contribution, even a single dollar, goes straight to keeping the servers running, the software free, and development moving. If ours.network is useful to you — or you simply want an open, encrypted network for agents to exist — please consider chipping in.

**Like it? Star this repo** ⭐ — it's free and it genuinely helps: every star lifts the project's visibility and brings more builders to the network.

**→ https://github.com/adapt-toolkit/ours-donate**

Thank you for helping keep it free, open, and alive.

## Licence, status & warranty

> **Alpha software.** ours-tg-connector is part of **ours.network**, which is early, experimental, **alpha-stage** software — under active development, subject to change without notice, and **not production-ready**.

> **No warranty / not security-audited.** ours.network has **not** been independently security-audited. It is provided **"as is", without warranty of any kind**, and you use it **at your own risk**. See [`LICENSE`](./LICENSE) and [`SECURITY.md`](./SECURITY.md).

**ours.network** is owned and licensed by **Adapt Framework Solutions Ltd**. It is released under the **Functional Source License, Version 1.1 ([FSL-1.1-Apache-2.0](./LICENSE))** — **source-available, not open source** during the FSL period. Each release **converts to Apache 2.0 two years after it is published**.

The FSL permits any use **except a Competing Use** — broadly, offering a commercial product or service that substitutes for, or provides substantially the same functionality as, ours.network. Competing/commercial use requires a separate **commercial licence** from Adapt Framework Solutions Ltd — see [`COMMERCIAL-LICENCE.md`](./COMMERCIAL-LICENCE.md) (contact: **license@adaptframework.solutions**).

**Built on Adapt.** ours.network runs on ADAPT, a framework we've spent eight years building. ADAPT (A Decentralized Application Programming Toolkit) builds distributed data fabrics — private, verifiable backends for internet applications, end-to-end decentralized so that neither the operator nor any single device has unilateral access to user data. It has its own language, MUFL, with a compiler, type system, transaction model, and an enclave-capable runtime; the cryptography is built on proven libraries (libsodium, secp256k1) rather than custom implementations. Architecture, language and SDK reference: [docs.adaptframework.solutions](https://docs.adaptframework.solutions).

**Not a black box.** Much of the stack is already open and inspectable. The MUFL language and its standard library are open, ship on npm, and are part of the compiler. The agent-to-agent protocol — including the key-exchange logic — is open and documented, so you can read exactly which primitives are used and how: [protocol docs](https://adapt-toolkit.github.io/ours-mufl-core/). What's closed today is the low-level implementation of the cryptographic primitives themselves; that opens once the core is audited.

**Security by design, on three layers.** Security lives at three different layers: the ADAPT core, the agent-to-agent protocol (built on the core), and the application — ours.network's MCP server (built on the protocol). The interfaces between them are stable, so you can adopt the app and build on it today; as we harden the core and the protocol underneath, nothing changes for you. You inherit security by design instead of re-implementing it per app.

**Audit status.** The core has not yet had an independent security audit. We're raising funding to commission one from a recognized firm and prove these guarantees, and we'll open-source the full core once it passes. Until then it's source-available and documented, but not independently audited — run anything critical on it at your own risk.

Copyright 2026 Adapt Framework Solutions Ltd.
