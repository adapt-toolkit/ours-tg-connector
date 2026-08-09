# Two engine tests were removed here, and this says where their coverage lives

`tests/migration.test.mjs` and `tests/pre137-import.test.mjs` both stood up an
`AdaptHost` from `src/adapt.ts` and drove the engine directly. The connector has
no engine any more — it is an HTTP client of a daemon — so neither can run, and
neither *should*: both test the **core's** behaviour, not the connector's.

Deleting a test without saying where its subject went is how coverage disappears
quietly, so:

| removed | what it proved | where that is proved now |
|---|---|---|
| `migration.test.mjs` | a connector packet's `get_manifest` advertises `core.e2e` + `core.e2e.migrate`, and an established contact migrates to the Olm double ratchet (offer→ack→commit→confirm → epoch pin) | `ours-sdk/test/mig1867-verify.test.mjs` and `ours-mufl-core`'s own `tests/mig.mjs` / `tests/migapp.mjs`. The daemon is the packet now, so the daemon's repo is where the packet's manifest and migration are gated. |
| `pre137-import.test.mjs` | a pre-#137 state blob imports without losing identity or app state | `ours-mcp/packages/core/test/pre137-blob-import-regression.test.mjs`, against the same fixture. `import_state` is the daemon's; it is deliberately **not** a typed operation, because a client has no business importing packet state. |

The fixture `tests/fixtures/pre-137-tg-state.json` is kept: it was exported from a
real pre-#137 **tg** packet tuple, and it is the only copy of that particular
history. Whoever needs it next will need it in a repo that has an engine.

`tests/voice.test.mjs` was **not** deleted — it was rewritten. The STT and
envelope logic it covers (`src/stt.ts`, `src/envelope.ts`) is still the
connector's own; only the transport underneath it moved.
