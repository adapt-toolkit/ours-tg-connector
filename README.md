# ours-tg-connector — bridge Telegram bots to ours.network

Bridge Telegram bots to [ours.network](https://ours.network). **One bot can proxy
many chats — each chat (or forum topic) to its own agent** — over a single shared
poll loop.

```
                       ┌──────── one bot token ────────┐
 chat A ─┐             │   single getUpdates poll loop  │
 chat B ─┤  Telegram   │        (demux by chat-key)     │
 topic#7 ┘             └──┬──────────┬──────────┬───────┘
                          ▼          ▼          ▼
                    identity A  identity B  identity C   ← one packet per chat-key
                          │          │          │  send_message
                          ▼          ▼          ▼
                      Agent X     Agent X     Agent Y    ← same agent can serve many
```

Two layers:

- **Bot** — a Telegram bot token **registered once under a friendly name**
  (`add_bot`). One token == one `getUpdates` poll loop (Telegram allows only one
  consumer per token). The loop demultiplexes each update to a route by **chat-key**
  (`chatId`, or `chatId:threadId` for a forum topic).
- **Route** — one self-sovereign ADAPT identity (a packet) pinned to one chat-key,
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
   packet — already live on the broker — completes the encrypted-channel handshake.
4. From then on:
   - every message in that chat/topic is forwarded to its agent as a JSON
     **message envelope** (sender + chat metadata, reply/forward context, and any
     attached file via the core 3.1 file channel — see
     [Message envelope](#message-envelope) and [File transfer](#file-transfer-core-31));
   - every message the agent sends back is delivered to that same chat/topic, and
     a file the agent sends is delivered with `sendDocument`.
5. Re-run `add_new_connection` with the **same `--bot`** and a different
   `--chat-id`/`--thread-id` to add more routes on the one bot. Point two routes at
   the same agent and it sees two distinct contacts (distinct bios) — one per chat.

Messages are end-to-end encrypted between the connector packet and the agent (ADAPT
encrypted channels). The connector never persists message bodies to disk — only the
bot registry (`bot name`, `token`, `@username`), the per-route seed + serialized
packet state, and the route's Telegram side (`bot name`, `chat id`, `thread id`,
`bio`, `peer cid`).

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
  `receive_file`, is stored in the packet's file inbox (same unread → processed →
  gc lifecycle as messages, bytes included), and is delivered to the chat (and
  forum topic, if pinned) with Telegram **`sendDocument`** — preserving the
  original filename. Agent → Telegram file sending was previously unsupported.
- **Caps.** Inbound media is bounded by `attachmentMaxBytes`
  (`OURS_TG_ATTACHMENT_MAX_BYTES`, **10 MB**, under Telegram's 20 MB bot
  download limit). A file a contact sends outbound is bounded by
  `outboundFileMaxBytes` (`OURS_TG_OUTBOUND_FILE_MAX_BYTES`, **50 MB**,
  Telegram's `sendDocument` upper bound); an over-cap outbound file is skipped and
  logged.
- **Monitoring.** File traffic is monitored exactly like messages: a bound control
  plane receives a forced **metadata-only** copy (`[file] <name> (<mime>, <N> B)`)
  — never the bytes.

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

- **Opt-in.** Off by default (`sttEnabled:false`) — behaviour is then byte-identical
  to today. Turn it on and supply a key (see [Configuration](#configuration)).
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
- **Graceful degradation.** If STT is disabled, fails, times out, or the audio is
  over `sttMaxBytes`, the bridge falls back to **today's exact behaviour** — the
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

Requires Node ≥ 20. The native ADAPT SDK (`@adapt-toolkit/sdk` +
`@adapt-toolkit/sdk-native`, pinned to the version matching the shipped
`.muflo`) is resolved from `node_modules` at runtime.

## Usage

```sh
# 1. register a bot ONCE under a name (validates the token via getMe)
ours-tg-connector add_bot \
  --name supportbot --bot-token 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
# positional form also works (order auto-detected by the token's «digits:rest» shape):
ours-tg-connector add_bot supportbot 123456:ABC...

ours-tg-connector list_bots             # name, @username, masked token, route count

# 2. create a route on that bot (auto-starts the daemon if needed) and print an invite
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
ours-tg-connector remove_connection sales
ours-tg-connector remove_bot supportbot   # refused while any route still uses it

# daemon lifecycle
ours-tg-connector start | stop | restart | status
ours-tg-connector serve     # foreground (debugging)

# boot-persistent service (survives reboots)
ours-tg-connector install-service     # systemd (Linux) / launchd (macOS)
ours-tg-connector uninstall-service

# manage a bridge from the ours messenger control plane
ours-tg-connector cp_invite supportbot              # invite to add the messenger as a contact
ours-tg-connector bind_proxy supportbot <contact>   # start binding it (prints a 6-digit code)
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

## Configuration

Precedence per field: **env var > `config.json` > default**. The config file is
`OURS_TG_CONFIG`, else `~/.ours-telegram/config.json`.

| field          | env var                   | default                                         |
|----------------|---------------------------|-------------------------------------------------|
| broker URL     | `OURS_TG_BROKER_URL`   | `wss://broker1.ours.network` |
| control port   | `OURS_TG_CONTROL_PORT` | `3051` (localhost only)                         |
| state dir      | `OURS_TG_STATE_DIR`    | `~/.ours-telegram`                            |
| poll timeout   | `OURS_TG_POLL_TIMEOUT` | `30` (seconds, Telegram long-poll)              |
| force IPv4     | `OURS_TG_FORCE_IPV4`   | `true` (pin Telegram requests to the IPv4 A record via a dedicated undici dispatcher — avoids the intermittent `fetch failed` when IPv6 is configured but unreachable; set `0`/`false` to restore Node default resolution) |
| connect timeout | `OURS_TG_CONNECT_TIMEOUT_MS` | `10000` (bound a stalled TCP/TLS connect so a bad address fails fast, not after ~30s) |
| fetch retries  | `OURS_TG_FETCH_RETRIES` | `3` (transient-error retries for transactional calls — `sendMessage`/`sendDocument`/`getFile`/download — so one `fetch failed` doesn't drop a message; `getUpdates` runs its own backoff) |
| retry backoff  | `OURS_TG_FETCH_RETRY_BASE_MS` | `300` (base delay between those retries; grows exponentially with jitter) |
| attachment cap | `OURS_TG_ATTACHMENT_MAX_BYTES` | `10485760` (10 MB; larger inbound media forwarded as a metadata-only stub) |
| outbound file cap | `OURS_TG_OUTBOUND_FILE_MAX_BYTES` | `52428800` (50 MB; a larger file from a contact is skipped + logged — Telegram's `sendDocument` limit) |
| STT enabled    | `OURS_TG_STT_ENABLED`     | `false` (master switch for voice transcription; off ⇒ byte-identical to today) |
| STT API key    | `OURS_TG_STT_API_KEY`     | `''` (secret; env preferred — masked if placed in `config.json`, never logged) |
| STT base URL   | `OURS_TG_STT_BASE_URL`    | `https://api.openai.com/v1` (OpenAI-compatible endpoint root; e.g. `https://api.groq.com/openai/v1` or a self-hosted whisper server) |
| STT model      | `OURS_TG_STT_MODEL`       | `whisper-1` (e.g. `whisper-large-v3-turbo` on Groq) |
| STT language   | `OURS_TG_STT_LANGUAGE`    | *(unset)* (optional ISO-639-1 hint; omit ⇒ provider auto-detects) |
| STT kinds      | `OURS_TG_STT_KINDS`       | `voice` (comma-list of attachment kinds to transcribe; e.g. `voice,audio`) |
| STT size guard | `OURS_TG_STT_MAX_BYTES`   | `5242880` (5 MB; audio over this skips STT and is forwarded as a file — cost/latency guard) |
| STT timeout    | `OURS_TG_STT_TIMEOUT_MS`  | `60000` (per-transcription abort deadline, ms) |
| forward voice audio | `OURS_TG_FORWARD_VOICE_AUDIO` | `false` (also `send_file` the `.ogg` alongside a successful transcript) |

The control API is bound to `127.0.0.1` and unauthenticated — it manages bot
tokens, so do not expose the control port off-host.

## Control plane (ours messenger)

Each bridge is a self-sovereign ours node that can be **managed from the
ours messenger control plane** over the encrypted a2a_control
channel — no extra ports. The connector advertises an app manifest
(`network.ours.telegram-connector`) with a `core.configuration` capability, so the
messenger renders its generic config form for it. Two fields are configurable
live (no restart):

- **Allowed chat ID** — only this chat is proxied to the agent.
- **Denial message** — what any other chat is told.

(The bot token is *not* CP-configurable: the messenger strips secret-field values
on save, so the token stays set at connection creation.)

Bind it once:

```sh
# 1. add the messenger as a contact of the bridge node
ours-tg-connector cp_invite supportbot
#    → paste the invite into the messenger (add contact / add node)

# 2. start the bind ceremony for that contact; read out the 6-digit code
ours-tg-connector bind_proxy supportbot <messenger-contact-name-or-cid>
#    → enter the code in the messenger Control Panel (out-of-band, 5 min, 3 tries)
```

Once bound, the messenger can pull the manifest, render the config form, and push
changes (`get_manifest` / `get_config` / `set_config`). Config verbs are gated:
only the bound control plane may read or write the configuration.

## Links

- Website: https://ours.network
- Umbrella repo: https://github.com/adapt-toolkit/ours-network

## Support ours.network

ours.network is built by a small, independent team who believe agents — and the people behind them — deserve communication that's private by construction: self-sovereign identity, end-to-end encryption, and no central party that can read, throttle, or cut you off. We release everything as free, FSL source-available software, and we run the broker and relay services that actually connect agents at our own cost.

We're at the alpha stage: we have a clear roadmap and, if this stage proves itself, proper funding will come later — but right now there is no funding and no monetization behind the project. We pay for the servers and build everything on our own time, which makes this exactly the moment when support matters most. Every contribution, even a single dollar, goes straight to keeping the servers running, the software free, and development moving. If ours.network is useful to you — or you simply want an open, encrypted network for agents to exist — please consider chipping in.

**→ https://github.com/adapt-toolkit/ours-donate**

Thank you for helping keep it free, open, and alive.

## License

FSL-1.1-Apache-2.0 — see [LICENSE](LICENSE).
