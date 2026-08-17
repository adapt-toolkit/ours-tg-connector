# Telegram voice-message interoperability contract

This connector bridges Telegram's semantic `message.voice` attachment to the
ours file channel. The official
[Telegram Bot API](https://core.telegram.org/bots/api#voice) defines these voice
recordings as OGG containers encoded with Opus; the connector forwards the
downloaded bytes without transcoding.

## Wire contract

When an attachment descriptor has `kind: "voice"` and its bytes are forwarded:

- `send_file.filename` is `voice_<telegram-message-id>.ogg`;
- `send_file.mime` is exactly
  `audio/ogg; x-ours-kind=voice-message`;
- the v2 message envelope's `attachment.filename` and `attachment.mime` are
  byte-for-byte identical to the `send_file` values;
- `attachment.wire_id` is the `wire_id` returned by that successful
  `send_file`;
- the downloaded bytes are passed unchanged.

The semantic Telegram attachment kind is the only voice classification source.
Filename or MIME guessing must not promote a normal `kind: "audio"` attachment:
`recording.ogg` with plain `audio/ogg` stays ordinary audio.

Malformed filename or MIME fields on a semantic voice descriptor are ignored.
The connector generates the safe `.ogg` filename and fixed marked MIME above.
If `send_file` fails, the envelope reports `error: "file transfer failed"` and
does not claim a `transport` or `wire_id`.

## Transcription: who does it, and when

**Not this connector.** It had its own speech-to-text client (`src/stt.ts`); that
client and its nine `stt*`/`forwardVoiceAudio` settings are removed, so there is
exactly one transcription implementation in the system and it belongs to the ours
SDK on the receiving side.

| Case | File forwarded? | Voice MIME marker? | Who transcribes |
| --- | --- | --- | --- |
| Semantic `kind: "voice"`, bytes resolved | **always** | yes, file + envelope | the RECEIVING daemon, on its `get_files` |
| Semantic `kind: "voice"`, download failed/over cap | no | not applicable | nobody — the envelope reports the failure |
| Ordinary `kind: "audio"` (even `audio/ogg`) | yes | **no** | nobody — an unmarked file is never transcribed |

Two properties this table is really asserting:

- **The audio is always forwarded when it resolved.** There is no longer any
  condition under which a successfully downloaded voice note is withheld. The old
  `forwardVoiceAudio: false` default suppressed exactly those bytes on a successful
  local transcription; keeping it would leave the receiving daemon nothing to work
  with.
- **The envelope carries no transcript.** There is no `transcription` block, and a
  caption-less voice note arrives with `"text": ""`. The transcript reaches the
  agent on the receiving SDK's own voice delivery line, and only if that side has
  configured `stt` in its `~/.ours/config.json`.

The marker is therefore the entire mechanism, and it is applied on semantic kind
alone — which is also why an operator who had `sttKinds: ["voice","audio"]` loses
transcription for `audio`: nothing marks it, so nothing transcribes it.

## Receiver evidence

ours-sdk `main` (`src/transcribe.ts`) recognizes the case-insensitive MIME
parameter `x-ours-kind=voice-message` via `isVoiceMessage()` and deliberately
rejects an unmarked `audio/ogg` file. `src/render/adapt-to-json.ts`
(`writeIncomingFiles`) is what runs it: every incoming file matching that detector
is transcribed inside `getFiles()` under the receiver's `stt` config, with no
separate call from the consumer. `test/transcribe-detect.test.mjs` and
`test/transcribe-stt.test.mjs` lock those behaviours in that repository — not this
one.

Independent checks in this repository:

```sh
node --import tsx tests/envelope.test.mjs
node --import tsx tests/config-stt-removed.test.mjs
node --import tsx tests/voice.test.mjs
```

The first two are pure local tests: envelope shaping, and the startup warning that
names every removed `stt*` setting an operator still has configured. The voice
integration test uses placeholder OGG/Opus-signature bytes and a real ours daemon
driven through `@ours.network/sdk`; it requires no Telegram token, no STT key and
no real media.

That test asserts a negative that used to need a carefully scoped spy — that **no**
transcription endpoint is called by this process. It can now be a blanket check,
because the connector has no transcription client to call one with. The receiving
daemon's own transcription is not stubbed and not asserted here; with no `stt` key
configured for the test agent, the SDK records a `configured: false` outcome and
the bytes still land, which is the property this repository cares about.
