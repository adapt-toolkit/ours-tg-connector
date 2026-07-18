# Connector DR Migration — Gap Closure + Live Proof (Developer-2)

Branch `dev2/e2e-dr-migration-gap` off `dev9/e2e-dr-integration` (@1ec8650, submodule
`mufl_code/core` @ d152aa8b DR core, @adapt-toolkit stack 0.10.7).

## What the gap was
The DR-routing core + DR-capable SDK already shipped in the connector, but the
connector's HOST + MANIFEST didn't drive migration:
- The manifest advertised only `core.configuration` + `core.connect`, so
  `mig_should_trigger`'s `self_advertises(core.e2e.migrate)` was FALSE and peers
  never learned the connector's e2e/migrate caps → **existing contacts never
  auto-migrated** (case 3a broken).
- `src/` had none of the mcp's migration host wiring.

## The fix (commit 1f2c962)
- **Manifest** (`mufl_code/actor.mu`): advertise `core.e2e` + `core.e2e.migrate`.
  Load-bearing part = adding them to `a2a_capabilities::init` **`$advertise`**
  (self_caps → `self_advertises` gates `mig_should_trigger`, and peers learn the
  caps via the `self_cap_ids` wire piggyback). Also added to `build_manifest` for
  `get_manifest`/`self_supports`. Matches the blessed mcp exactly
  (`$advertise -> [cap_e2e, cap_e2e_migrate]`, verified vs ours-mcp 0.10.3 + migconv).
- **Host** (`src/connector.ts`):
  - `migrationSweep()` → `::a2a_messaging::sweep_e2e_migrations` at boot (after the
    contact-restore sweep, once broker-registered) + on the periodic GC cadence.
    Idempotent + fail-closed in core (no-op until this node advertises the cap;
    never re-offers an in-flight/migrated pair).
  - Ported the 6 migration proof notifies into `onNotify`: `migration_active`,
    `e2e_app_send`, `e2e_app_recv`, `migration_deferred_flush`, `migration_stalled`,
    and the security `downgrade_refused` surface (core already DROPS the legacy
    plaintext from a migrated peer; the daemon surfaces it). Send/recv stay
    core-mediated → no daemon-side route-verdict logic needed.

## Envelope evidence semantics (how box vs double-ratchet is observed)
- `send_message` returns `$route -> $e2e` ONLY on the ratchet path (core:1265); a
  legacy box send has NO `route` field; commit-window → `$migrating`.
- Double-ratchet send/recv emit `e2e_app_send` / `e2e_app_recv` notifies carrying
  `olm_type` + `session_id`; box traffic emits `message_received`.
- Wire tx name: `receive_e2e_message_tx` (double ratchet) vs `receive_message_tx` (box).

## LIVE PROOF — 2 separate daemons over the PUBLIC broker wss://broker1.ours.network
Two independent native wrappers (separate OS processes) over broker1. Harness +
raw captures under `proof-evidence/`. OLD unit = 7518511B (does NOT advertise the
migrate cap); NEW unit = BD0FABB9 (my build, advertises).

### CASE 3 (both NEW) — auto-migrate to the double ratchet  ✅ PROVEN
`proof-evidence/S2-both-new-DR.txt`. Two NEW connector daemons pair over broker1,
then auto-migrate:
- `route A→B = e2e`, `route B→A = e2e`.
- `migration_active` on BOTH sides with a **matching epoch**
  `002ed877dee769e93ce9e0e0537ea7a4123aa9f0f8778d71a07914cf147ad04b` and **matching
  session_id** `95fb2bc4bbb0ad44dc37c74ca7b1fad3a530b75c1620da12e7fe581554dd70ce`
  (one initiator, one responder — the migration FSM completed).
- `e2e_app_send` + `e2e_app_recv` both directions, `olm_type=1` (established ratchet,
  not prekey), `ok=TRUE`.
- **Actual message content delivered over the double ratchet** (B decrypted A's
  message and vice-versa).

### CASE 3a (existing legacy contact) — flips box→DR on reconnect  ✅ PROVEN
`proof-evidence/S3-existing-contact-reconnect-DR.txt`. Two daemons pair as an
established **legacy** contact (`route=box`, message delivered over box). Then both
enable migrate (the runtime analog of upgrading + restarting on the NEW build):
- After `advertise` on ordinary traffic alone: **route stays box** — because caps
  are only re-learned on invite/restore/migration legs, not ordinary traffic
  (Dev-9 WORKLOG 519), and pv-detection can't help (wire_version is 8, gate needs
  the cap). This is expected and is why the deploy must induce a reconnect.
- After a **reconnect** (cap-refreshing re-handshake): **route flips box→e2e**,
  `migration_active` on both sides, `e2e_app_send` fires. The existing contact
  migrated to the double ratchet.

## Findings for the core-level review (flagged to FC; owner decision, NOT connector bugs)
1. **"Born-DR" is box-until-migration in this core (d152aa8b).** A fresh v2 contact
   ("born-DR") does NOT ride the double ratchet from msg#1: `send_message` gates the
   DR-delivery path on `e2e_pinned || contact_e2e_epoch != NIL` (`a2a_messaging.mm:1246`),
   and a fresh-v2 "e2e" route falls through to the legacy box (`L1269`). So in this
   core BOTH case 3a and 3b reach DR via the migration FSM, not a handshake-free
   born-DR. The owner asked for "DR from the first message" — that's a possible
   spec gap at the CORE level (affects mcp + connector identically), not a connector
   bug. Do NOT "fix" it in the connector (would diverge from the mcp).
2. **Existing pre-upgrade contacts need a cap-refreshing reconnect to migrate**
   (proven above). Ordinary traffic does not refresh caps. The connector restart on
   deploy induces the reconnect; worst case a one-time re-pair. This matches Dev-9's
   flag (WORKLOG 519/523).
3. **Asymmetry edge (theoretical, not a real deployment state):** a node that has the
   DR core but does NOT advertise `core.e2e` will e2e-send to a peer that advertises
   it, while that peer rejects the e2e message (accept-gate `committed_match ||
   e2e_pinned(sender)`, core:2685) → drop. This only arises with a "DR-core-but-not-
   advertising" hybrid, which is not a released build: the mcp added DR-core and the
   advertise together, and my connector change advertises. A genuinely-old peer (no
   DR core, no `$e2e_bundle`) boxes cleanly both ways with no asymmetry.

## Still to verify against a genuinely-old daemon (case 2 mixed)
The mixed old↔new = legacy-box envelope is structurally guaranteed for a genuinely
pre-DR peer (no `$e2e_bundle` → `e2e_route`=legacy → box; the old peer has no e2e
crypto → boxes). I did not have a genuinely-old (no-DR-core) unit on hand — my "OLD"
7518511B carries the DR core (it just doesn't advertise), which triggers the
theoretical asymmetry in finding #3 rather than a clean box. FC offered to source an
old `@ours.network/mcp` — running NEW connector ↔ that old mcp would capture the
clean mixed-box envelope. Requested.

## Deploy + seed runbook (investigate; do NOT execute without owner go)
- Deploy = rebuild the connector (CI `publish.yml` runs `scripts/compile-mufl.sh` →
  the DR `.muflo`) + republish (OWNER-GATED) + restart the connector daemon.
- The restart re-registers packets on the broker → reconnect/re-handshake with
  existing contacts refreshes caps → `migrationSweep` (boot) + inbound triggers →
  existing contacts migrate to the double ratchet. If a healthy contact does not
  auto-reconnect, a one-time re-pair of that contact triggers migration.
- Verify post-deploy: send an agent↔connector message; the connector log shows
  `[migration] active … epoch=… session_id=…` and `[e2e-app] send/recv …
  olm_type=…`; `send_message` route is `e2e`. Envelope on the wire is
  `receive_e2e_message_tx` (double ratchet), not `receive_message_tx` (box).
