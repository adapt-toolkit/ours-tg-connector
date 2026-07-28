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

## STT decision matrix

| Connector-side state | File forwarded? | Voice MIME marker? | Transcription block |
| --- | --- | --- | --- |
| STT disabled | yes | yes, file + envelope | absent |
| STT enabled without a key | yes | yes, file + envelope | `status: "error"` |
| STT provider failure/timeout | yes | yes, file + envelope | `status: "error"` |
| Over `sttMaxBytes` | yes | yes, file + envelope | `status: "error", error: "too_large"` |
| STT succeeds, `forwardVoiceAudio: false` | no | not applicable | `status: "ok"`; transcript folds into text |
| STT succeeds, `forwardVoiceAudio: true` | yes | yes, file + envelope | `status: "ok"` |

The ours MIME parameter is wire metadata, not a provider media type. Before an
STT upload, the connector strips parameters and sends the provider the base
`audio/ogg` MIME.

## Receiver evidence

ours-mcp commit `c8dd602` (`packages/core/src/transcribe.ts`) recognizes the
case-insensitive MIME parameter `x-ours-kind=voice-message` and deliberately
rejects an unmarked `audio/ogg` file. Its
`packages/core/test/transcribe-detect.test.mjs` test locks both behaviors.

Independent checks in this repository:

```sh
node --import tsx tests/envelope.test.mjs
node --import tsx tests/stt.test.mjs
node --import tsx tests/voice.test.mjs
```

The first two are pure local tests. The voice integration test uses placeholder
OGG/Opus-signature bytes, an in-process ADAPT host, and a stubbed STT provider;
it requires no Telegram token, STT token, or real media.
