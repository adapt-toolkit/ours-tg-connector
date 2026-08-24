# Engine-bound tests removed here, and where their coverage lives

`tests/migration.test.mjs` and `tests/pre137-import.test.mjs` both stood up an
`AdaptHost` from `src/adapt.ts` and drove the engine directly. The connector has
no engine any more — it is an HTTP client of a daemon — so neither can run, and
neither *should*: both test the **core's** behaviour, not the connector's.

Deleting a test without saying where its subject went is how coverage disappears
quietly, so:

| removed | what it proved | where that is proved now |
|---|---|---|
| `migration.test.mjs` | a connector packet's `get_manifest` advertises `core.e2e` + `core.e2e.migrate`, and an established contact migrates to the Olm double ratchet (offer→ack→commit→confirm → epoch pin) | [`ours-sdk/test/mig1867-verify.test.mjs`](https://github.com/adapt-toolkit/ours-sdk/blob/main/test/mig1867-verify.test.mjs) and ours-mufl-core's [`tests/mig.mjs`](https://github.com/adapt-toolkit/ours-mufl-core/blob/main/tests/mig.mjs) / [`tests/migapp.mjs`](https://github.com/adapt-toolkit/ours-mufl-core/blob/main/tests/migapp.mjs). The daemon owns the packet, so its repositories gate manifest and migration behavior. |
| `pre137-import.test.mjs` | a pre-#137 state blob imports without losing identity or app state | [`ours-mcp/packages/core/test/pre137-blob-import-regression.test.mjs`](https://github.com/adapt-toolkit/ours-mcp/blob/main/packages/core/test/pre137-blob-import-regression.test.mjs), against the same fixture. `import_state` belongs to the daemon and is intentionally not a typed client operation. |

The fixture `tests/fixtures/pre-137-tg-state.json` is kept: it was exported from a
real pre-#137 **tg** packet tuple and remains useful to daemon/core migration tests.

`tests/voice.test.mjs` was **not** deleted — it was rewritten. The STT and
envelope logic it covers (`src/stt.ts`, `src/envelope.ts`) is still the
connector's own; only the transport underneath it moved.

## `payload-mode.test.mjs`, removed when main's plain-payload feature merged in

`tests/payload-mode.test.mjs` arrived on `main` with the plain-payload feature
(#16) and imported `CONFIG_SCHEMA`, `configValues` and `applyConfig` from
`src/control.ts`. The shared-daemon client architecture has no managed-node
control plane, so the test cannot import those deleted APIs.

The **feature** survives the merge intact: `buildPlainPayload`, the
`--payload-mode`/`--plain` CLI flags, the `payloadMode` field on
`ConnectionFile`, its `readMeta` normalisation, the `POST /connections`
validation, and the `forwardToNode` branch are all merged. What is gone is the
**control-plane path to change it after creation**, because there is no control
plane. `payloadMode` is now a create-time route property only.

Its behavioural coverage lives in `tests/envelope.test.mjs`, which asserts the
five `buildPlainPayload` outcomes directly (text forwarded verbatim, no
companion text for a caption-less voice file, transcript forwarded as ordinary
text, and the two attachment-failure strings). Only the schema/`applyConfig`
assertions had no surviving subject.

## `replies-receipts.test.mjs`, not carried from the engine-host branch

That integration test imported the deleted `src/adapt.ts` host and connector
packet sources, so it cannot run in the shared-daemon client architecture. The
connector-side behavior remains covered by `tests/receipts.test.mjs`,
`tests/history-receipts.test.mjs`, and `tests/history-delivery.test.mjs`; receipt
transport and emission belong to the daemon.
