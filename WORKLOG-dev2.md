# Developer-2 — WORKLOG (connector DR migration host/manifest gap)

## 2026-07-18 22:5x — Session start / onboarding
- Bound ours identity Developer-2; reconciled bio+persona to THIS briefing (prior holder's identity had a stale "broker persistent stats" mission — overwrote).
- Armed persistent Monitor `ours-mcp watch "Developer-2"`. Announced online + oriented to FleetCoordinator.
- Dev-7 port-4175 heads-up (mail #27) = STALE/resolved: pid 459837 gone, :4175 now served by a live process. Ignored.
- Read brief `/home/fleet/.ours-fleet/agents/FleetCoordinator/bug-connector-migration-host-manifest-gap.md` + Dev-9 WORKLOG handoff (lines 566-601, dated 2026-07-18 = TODAY; task is CURRENT, deadline tomorrow AM).

## State inherited (Dev-9)
- ours-mufl-core PR#13: branch dev9/e2e-dr-core-nightly-snapshot @ d152aa8b (DR core, wire_version 8, e2e_route).
- ours-tg-connector PR#8: branch dev9/e2e-dr-integration @ 1ec8650 (submodule->d152aa8b; @adapt-toolkit/{sdk,sdk-native,mufl}->0.10.7). Builds/typecheck/tests GREEN.
- WORKS: case1 (both old=legacy), case2 (mixed=legacy backcompat). case3b (born-DR) LIKELY works via AD $e2e_bundle — LIVE-CONFIRM.
- BROKEN: case3a (existing contacts auto-migrate) — connector host+manifest don't drive migration.

## GAP to close (my task)
- TASK A (manifest): mufl_code/actor.mu build_manifest — advertise a2a_capabilities::cap_e2e ("core.e2e") + cap_e2e_migrate ("core.e2e.migrate"), same shape as cap_connect block. Recompile via scripts/compile-mufl.sh.
- TASK B (host wiring): port mcp packages/core/src/index.ts migration wiring into connector src/ — OURS_ADVERTISE_MIGRATE staged boot + <dir>-nocap variant (OPTIONAL for MVP), advertise_migrate trigger at boot/after-bind, §4 send/recv proof lines, legacy-plaintext-from-migrated-peer downgrade-DROP (SECURITY-CRITICAL).
- TASK C (live proof): 2 isolated daemons vs wss://broker1.ours.network; capture JSON envelope box vs double-ratchet for 3 cases.

## Worktree
- /home/fleet/work/dev2-migration-gap  branch dev2/e2e-dr-migration-gap (off origin/dev9/e2e-dr-integration @ 1ec8650)
- submodule mufl_code/core @ d152aa8b (DR core). Never touch main. PR-only, republish OWNER-GATED.

## Investigation findings (code-verified, not assumed)
- **Cap constants** (core/a2a_capabilities.mm): cap_e2e="core.e2e" (L96), cap_e2e_migrate="core.e2e.migrate" (L105).
- **What gates auto-migration**: `mig_should_trigger` (a2a_messaging.mm:837-848) requires `self_advertises(cap_e2e_migrate)` == TRUE. `self_advertises` reads `self_caps` = **init's `$supported ∪ $advertise`** (a2a_capabilities.mm:239-247) — NOT the describe() build_manifest map. So the LOAD-BEARING fix is adding cap_e2e+cap_e2e_migrate to the `$advertise` list in the connector's `a2a_capabilities::init` call. The build_manifest describe() map feeds get_manifest/self_supports (control-plane surface) — add there too for completeness.
- **Peer learning**: peers learn my caps via the `self_cap_ids` piggyback (`$caps` on invite/restore/migration legs) which also reads self_caps → $advertise. So $advertise is what makes the AGENT learn the connector is migrate-capable (into contact_caps) → its mig_should_trigger fires too.
- **Task A template** = ours-mcp-migconv actor.mu:531 `$advertise -> [ cap_e2e, cap_e2e_migrate ]` (+ describe caps 491-493). Connector currently passes NO $advertise (actor.mu:515-520) and `$supported -> []`.
- **Boot driver (corrected vs Dev-9 90%-ctx handoff)**: Dev-9 loosely said "call advertise_migrate at boot". CORE d152aa8b docs say otherwise: `advertise_migrate` (3299) is RUNTIME cap-enable (staged flow when cap starts OFF). `sweep_e2e_migrations` (3362) is the documented BOOT/GC reconciler — re-drives in-flight migrations AND proactively offers to eligible zero-traffic contacts (core comment: "the ONLY path that covers the post-version-bump default-cap boot with pre-existing e2e contacts and NO inbound traffic"). Connector core d152aa8b has restore_degraded_contacts+advertise_migrate+sweep_e2e_migrations; it does NOT have readvertise_on_upgrade (that's a NEWER migconv-core addition).
- **Deployed-nightly behavior**: work/ours-mcp (0.10.3, same core gen as d152aa8b) does NOT boot-sweep — case 3a fires via inbound-traffic `mig_trigger_actions` once BOTH advertise, + the manual advertise_migrate tool. So TASK A alone makes case 3a auto-fire on the connector↔agent traffic that always flows. I ADD sweep_e2e_migrations at boot+GC (idempotent, fail-closed) so case 3a is IMMEDIATE for idle contacts too — a documented, strictly-safer enhancement for this core.
- **Send/receive are core-mediated**: connector forwardToNode calls `::a2a_messaging::send_message` (connector.ts:498, returns deferred/queued for the migrating-queue), receive via `::actor::get_messages`. Core decides e2e/box/refused route + DROPS legacy-plaintext-from-migrated-peer internally + emits notifies. So NO mcp send-side verdict logic needed on the connector; downgrade-DROP is already in core — I only port the `downgrade_refused` notify SURFACING (security observability).
- **Notify events to port** (from mcp index.ts 1918-1973): migration_active, e2e_app_send, e2e_app_recv, migration_deferred_flush, migration_stalled, downgrade_refused.

## Integration points (connector src/)
- Manifest: mufl_code/actor.mu build_manifest (485-508) + init (515-520). [Task A]
- Boot sweep: mirror `contactRestoreSweep` (connector.ts:267) → add `migrationSweep` calling `::a2a_messaging::sweep_e2e_migrations`; call in recreateRoute (after contactRestoreSweep, ~846) + periodic timer (startRestoreSweepTimer, ~1077). [Task B.2]
- Notify handlers: activateRoute onNotify (connector.ts:655-682) — add the 6 migration events. [Task B.3]
- Skip -nocap staged variant (MVP per Dev-9). [Task B.1 deferred]

## Plan
A. actor.mu: add $advertise + describe caps. B. connector.ts: migrationSweep + notify handlers. Build (npm i → compile-mufl → build.mjs → typecheck → test). C. Live 2-daemon proof vs wss://broker1.ours.network capturing box-vs-DR envelope for cases 1/2/3a/3b.

## Protocol finding (verified by reading core send path) — IMPORTANT
- In core d152aa8b, a FRESH v2 contact ("born-DR") does NOT ride the double ratchet: send_message (a2a_messaging.mm:1246) gates the DR-delivery on `e2e_pinned || contact_e2e_epoch != NIL`; a fresh-v2 e2e route FALLS THROUGH to the legacy box (comment L1269 "fresh-v2 'e2e', box legacy-allowed"). So in THIS core BOTH case 3a (existing) AND 3b (new both-new) reach DR via the MIGRATION FSM (offer→ack→commit→confirm → epoch pin), not a handshake-free born-DR. Dev-9's "born-DR from msg#1, no handshake" note is loose for d152aa8b. Implementation unaffected (Task A+B drive migration); it just means the DR proof signal is `send_message route=="e2e"` AFTER migration + the e2e_app_send/migration_active notifies.
- DR observability: send_message return carries `$route -> $e2e` ONLY on the ratchet path (core:1265); box send has NO route field; migrating → `$migrating`. e2e_app_send notify carries olm_type + session_id. Wire: receive_e2e_message_tx (DR) vs receive_message_tx (box).

## Progress
- [done] npm install; baseline green (compile-mufl 7518511B, typecheck, build, test).
- [done] TASK A (manifest): actor.mu — $advertise + build_manifest caps. Recompiles to BD0FABB9 (both cap ids baked in).
- [done] TASK B (host): connector.ts — migrationSweep (boot + GC) via sweep_e2e_migrations; 6 migration notify handlers (incl. security downgrade_refused surface) + binHexField helper.
- [done] TEST: tests/migration.test.mjs — in-process 2-packet. PROVES Task A (manifest advertises both caps) + migration→DR (route="e2e" both dirs; migration_active + e2e_app_send notifies fire). FULL npm test GREEN (5 files). typecheck+build GREEN.
- [done] committed 1f2c962 (feat: close DR migration host+manifest gap). .muflo gitignored.
- [done] TASK C — LIVE 2-daemon proof over wss://broker1.ours.network. Findings:
  - Native wrapper is a per-PROCESS singleton → cross-version needs 2 separate processes. Built harness: proof-evidence/{worker,coordinator,reconnect}.mjs (JSON-lines worker per daemon).
  - Broker connectivity confirmed (DEBUG: ws open + b2w_reg_ok). AdaptHost --test_mode still connects to real broker (mcp daemon uses it too).
  - Gotcha fixed: list_contacts is a MAP (GetKeys), not numeric-indexed → my first worker parse bug made pairing look broken.
  - **CASE 3 both-new = DR: PROVEN** (proof-evidence/S2-both-new-DR.txt). route e2e both ways; matching epoch 002ed877.. + session_id 95fb2bc4.. (initiator+responder); e2e_app_send/recv olm_type=1 ok=TRUE; real content delivered over ratchet.
  - **CASE 3a existing legacy contact = box→DR on RECONNECT: PROVEN** (proof-evidence/S3-existing-contact-reconnect-DR.txt). advertise alone (ordinary traffic) does NOT trigger (caps not refreshed); a reconnect/re-pair refreshes caps → migration fires → route flips box→e2e. Matches Dev-9 flag (WORKLOG 519/523).
  - Deployed nightly mcp (0.10.3 + prerelease) advertises EXACTLY [cap_e2e, cap_e2e_migrate] == my connector → real owner topology is symmetric → works.
  - Full writeup + deploy runbook + core-level findings (born-DR gate; existing-contact reconnect; asymmetry edge) = MIGRATION-PROOF.md.
  - OUTSTANDING: case 2 mixed with a GENUINELY-old (no-DR-core, no bundle) peer — my OLD unit 7518511B carries the DR core so it triggers the asymmetry edge instead of a clean box. Requested an old @ours.network/mcp from FC to capture the clean mixed-box envelope. Structurally guaranteed regardless.

## Status: DONE (case 3a/3b live-proven) pending FC review + old-mcp for the mixed-box envelope. Branch NOT pushed/merged (FC opens PR; republish owner-gated).

## 2026-07-18 late — INTEROP FINDING (flagged to FC, blocker-level for real deploy)
- Installed real published @ours.network/mcp nightlies to test case-2 old-peer + real owner topology.
- nightly.2/.3 = stable-0.11.2 packet (AD-v1) → "Invalid address document version" intro break with AD-v2 DR connector (known 0.11↔0.12 boundary, separate issue).
- nightly.4/.6/.7 = AD-v2 + migration. mcp.7↔mcp.7 = DR OK via BORN-DR (migration_active=0, route e2e) — published mcp core HAS born-DR that connector core d152aa8b lacks.
- connector(d152aa8b) ↔ mcp .4/.6/.7 = BROKEN: intro ok, but downgrade_refused (connector can't parse mcp $e2e_bundle → SAFE cast to record failed) + migrating stuck, 0 delivered. Under identical SDK, connector↔connector + mcp↔mcp both work → genuine CORE AD-bundle skew. Connector's pinned d152aa8b is OLDER/incompatible with published mcp nightly cores.
- Evidence: proof-evidence/INTEROP-MATRIX.txt, S4-connector-x-mcp7-BROKEN.err.txt.
- Sent FC the finding + questions: (1) deployed agent's exact core? (2) re-pin connector submodule to the deployed/published core (Dev-10/core owner)? Offered to re-pin+rebuild+re-prove connector↔agent once target core known.
- STATE: host/manifest gap fix DONE + proven for connector's core (S2/S3). BLOCKED on core-version confirmation for connector↔real-agent DR proof. Awaiting FC.

## 2026-07-19 early — CORE RE-PIN d152aa8b→acd9cf6 + born-DR proven + core file finding
- FC identified correct core = ours-mufl-core feat/migration-impl HEAD acd9cf6 (deployed nightly.7 agent's committed core; d152aa8b was a divergent dead-end reconstruction).
- Re-pinned submodule → acd9cf6, recompiled connector (unit 08950466); my actor.mu $advertise + host wiring compiled unchanged. commit e552d26.
- LIVE connector(acd9cf6) ↔ mcp nightly.7 (real owner topology): pairs clean, NO errors, BORN-DR (route e2e from msg#1, migration_active empty), e2e_app_send/recv ok, message delivered over DR. Evidence proof-evidence/S5-*.txt. Resolves the interop break + delivers case 3b born-DR + the "pin same core as agent" review concern.
- Updated tests/migration.test.mjs to born-DR semantics; migration test + text DoDs pass.
- NEW CORE-LEVEL FINDING (flagged): born-DR FILE delivery directionally broken — send_file INVITER→REDEEMER not delivered (get_files=[]), REDEEMER→INVITER ok; messages fine. Reproduces mcp-nightly.7↔mcp-nightly.7 (agent's OWN core) → core bug, not connector. Owner's Telegram→connector→agent voice-file path is the failing direction. proof-evidence/CORE-FINDING-bornDR-file.txt. Out of scope for connector gap; Dev-10/core owner.
- voice.test.mjs file DoDs fail under born-DR core = this core bug surfacing (not a connector regression); text DoDs pass on real broker.
- STATE: migration host/manifest gap CLOSED + core re-pinned + born-DR messages PROVEN live with the real agent. Branch pushed. Core-level born-DR file bug flagged to FC. Awaiting FC steer on the file bug + review.

## 2026-07-19 — born-DR file bug ROOT-CAUSED (FC #32: dig in)
- NOT file-specific. Real bug: born-DR delivers only the FIRST message per direction until the peer REPLIES; every subsequent pre-key (olm_type=0) message (text OR file) is dropped.
- LOCATION: @adapt-toolkit/mufl/mufl_stdlib/cryptography/e2e.mm  fn decrypt_and_commit L406-414. The pre-key REPLAY guard `if existing!=NIL && session_matches(existing,ct) { return replayed() }` fires for EVERY genuine pre-key-phase message (v1 multi-use fallback key => all olm_type=0 until reply; all match the live session). Author anticipated replayed-handshake vs new-handshake, MISSED new-message-on-same-not-yet-bidirectional-session.
- Evidence: proof-evidence/ROOTCAUSE-bornDR-second-message.txt + instrumented run (2nd C->G text ALSO fails; olm_type=0 on the dropped file; e2e_app_recv ok=FALSE). Reproduces mcp-nightly.7<->mcp-nightly.7 (agent's own core).
- Fix is CRATE/SDK-level (adapt-e2e-core + e2e.mm), owner-gated, NOT the connector gap. A pre-key matching the live session must be DECRYPTED on it (advance ratchet), dropping only a true already-seen-index replay — needs a crate primitive (decrypt pre-key on existing session / index-aware replay). Dev-9 (adapt-e2e-core author) likely right implementer. Did NOT hack a half-fix (naive guard removal would double-deliver true replays).
- Reported to FC. My connector migration host/manifest deliverable remains ACCEPTED+complete; this is a separate shipped-crypto bug I root-caused.
