// ADAPT host layer: one native wrapper hosting N messenger packets.
//
// This is the messaging-only distillation of the ours-mcp daemon's SDK
// driving (the proven multi-container pattern: one adapt_wrapper, many packets,
// each an independent self-sovereign node). The Telegram connector creates one
// packet per bot/connection; every packet speaks the SAME compiled messenger
// unit (actor.mu), so its invites are byte-compatible with the ours-mcp
// `add_contact` tool — the human pastes the invite into their proxy node exactly
// as if it came from another agent.

import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';

import { adapt_wrapper } from '@adapt-toolkit/sdk/executables';
import { PacketWrapperConfigurator } from '@adapt-toolkit/sdk/wrappers';
import type { AdaptWrapper, AdaptPacketWrapper } from '@adapt-toolkit/sdk/wrappers';
import type { AdaptValue } from '@adapt-toolkit/sdk/backend';
import { object_to_adapt_value } from '@adapt-toolkit/sdk/wrapper';
import { AdaptObjectLifetime } from '@adapt-toolkit/sdk/common';

export type { AdaptValue };
export { AdaptObjectLifetime };

export type Logger = (...parts: unknown[]) => void;

// ----- AdaptValue lifetime management -----------------------------------------
// AdaptValues are manually memory-managed (no GC of JS-referenced native objects
// in the WASM deployment). Every value handed back by ExecuteTransaction / Reduce /
// GetKeys / object_to_adapt_value must be Destroy()'d, or attached to an
// AdaptObjectLifetime that frees it on Finalize() — else it leaks for the daemon's
// whole life. withScope runs a unit of work inside a scratch lifetime and
// Finalize()s it on exit; because Reduce/GetKeys children inherit their parent's
// lifetime, attaching a tx-root to `lt` pulls the whole derived value tree into the
// scope. The callback must return only JS primitives/Buffers — never a live
// AdaptValue (it would be freed under the caller).
export function withScope<T>(fn: (lt: AdaptObjectLifetime) => T): T {
  const lt = new AdaptObjectLifetime();
  try {
    return fn(lt);
  } finally {
    lt.Finalize();
  }
}

// Async variant: the scratch lifetime stays open across awaits (a mutating-tx
// round-trip), then frees everything attached to it.
export async function withScopeAsync<T>(fn: (lt: AdaptObjectLifetime) => Promise<T>): Promise<T> {
  const lt = new AdaptObjectLifetime();
  try {
    return await fn(lt);
  } finally {
    lt.Finalize();
  }
}

// ----- mufl unit discovery ---------------------------------------------------
// The unit is shared by every packet. We read its bytes ONCE and feed them to
// packet_manager.create_packet directly: the wrapper's create_packet_local
// re-reads the file and double-fires the create callback for the 2nd packet
// sharing a unit (a known SDK quirk this sidesteps).
export interface Unit {
  dir: string;
  hash: string;
  contents: Uint8Array;
}

export function locateUnit(): Unit {
  const here = dirname(fileURLToPath(import.meta.url));
  const override = process.env.OURS_TG_UNIT_DIR;
  const candidates = override
    ? [resolve(override)]
    : [join(here, 'mufl_code'), join(here, '..', 'mufl_code')];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const muflo = fs.readdirSync(dir).find((f) => f.endsWith('.muflo'));
    if (muflo) {
      const hash = muflo.slice(0, -'.muflo'.length);
      const contents = new Uint8Array(fs.readFileSync(join(dir, muflo)));
      return { dir, hash, contents };
    }
  }
  throw new Error(`no compiled .muflo packet found (looked in: ${candidates.join(', ')})`);
}

// ----- per-packet transaction plumbing ---------------------------------------
type Pending = {
  resolve: (v: AdaptValue) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type NotifyHandler = (event: string, payload: AdaptValue) => void;

// One hosted node. Mutating transactions go through add_client_message and their
// result surfaces on the async per-packet on_return_data; a FIFO of pending
// resolvers plus a per-packet mutex (withLock) keeps each result paired with the
// call that produced it (single-writer-per-packet).
export class Packet {
  pending: Pending[] = [];
  private lock: Promise<void> = Promise.resolve();

  constructor(
    public readonly name: string,
    public readonly cid: string,
    public readonly pw: AdaptPacketWrapper,
  ) {}

  // Read-only transaction. The envelope is detached scratch that ExecuteTransaction
  // clones synchronously, so we Destroy it immediately. The result is attached to
  // `lt` when supplied (callers wrap in withScope); without `lt` the caller owns the
  // returned value and must free it.
  readonlyTx(name: string, lt?: AdaptObjectLifetime): AdaptValue {
    const envelope = object_to_adapt_value({ name, targ: undefined } as never) as AdaptValue;
    const result = this.pw.packet.ExecuteTransaction(envelope);
    envelope.Destroy();
    return lt ? result.Attach(lt) : result;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private enqueue(envelope: AdaptValue, timeoutMs: number): Promise<AdaptValue> {
    return new Promise<AdaptValue>((res, rej) => {
      const timer = setTimeout(() => {
        const i = this.pending.findIndex((p) => p.timer === timer);
        if (i >= 0) this.pending.splice(i, 1);
        rej(new Error('timed out waiting for the transaction result'));
      }, timeoutMs);
      this.pending.push({ resolve: res, reject: rej, timer });
      this.pw.add_client_message(envelope);
    });
  }

  // Mutating transaction. The envelope is detached scratch (add_client_message
  // copies it, it is not taken over), so we Destroy it once the transaction
  // settles. The result is attached to `lt` when supplied; without one the caller
  // owns the returned value and must free it.
  mutatingTx(name: string, targ: unknown, lt?: AdaptObjectLifetime, timeoutMs = 25_000): Promise<AdaptValue> {
    const envelope = object_to_adapt_value({ name, targ } as never) as AdaptValue;
    return this.withLock(() => this.enqueue(envelope, timeoutMs)).then(
      (payload) => {
        envelope.Destroy();
        return lt ? payload.Attach(lt) : payload;
      },
      (err) => {
        try {
          envelope.Destroy();
        } catch {
          /* already gone */
        }
        throw err;
      },
    );
  }

  newBinary(buf: Buffer, lt?: AdaptObjectLifetime): AdaptValue {
    const v = this.pw.packet.NewBinaryFromBuffer(buf);
    return lt ? v.Attach(lt) : v;
  }
}

// Wire the async return-data routing. save_state and notify_agent are delegated
// to the caller's hooks; every other return resolves this packet's FIFO head.
export function wireHandlers(
  pkt: Packet,
  hooks: { onSaveState: () => void; onNotify: NotifyHandler },
  log: Logger,
): void {
  pkt.pw.on_return_data = (data: AdaptValue) => {
    // `data` arrives detached and this callback OWNS it (that is why it and its
    // reductions leaked). Scope the whole body in a scratch lifetime; the only
    // value that escapes — the payload resolved to the awaiting mutatingTx caller —
    // is Detach()'d first so Finalize frees everything else but not it. onNotify
    // reduces its payload synchronously, so it is done before Finalize runs.
    const lt = new AdaptObjectLifetime();
    data.Attach(lt);
    try {
      const kind = data.Reduce('kind').Visualize();
      if (kind === 'save_state') {
        hooks.onSaveState();
        return;
      }
      if (kind === 'notify_agent') {
        const payload = data.Reduce('payload');
        hooks.onNotify(payload.Reduce('event').Visualize(), payload);
        return;
      }
      const p = pkt.pending.shift();
      if (!p) return;
      clearTimeout(p.timer);
      p.resolve(data.Reduce('payload').Detach());
    } finally {
      lt.Finalize();
    }
  };

  pkt.pw.on_transaction_failure = (message: string) => {
    const p = pkt.pending.shift();
    if (p) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    } else {
      log(`[${pkt.name}] inbound transaction rejected:`, message);
    }
  };
}

// ----- the wrapper host -------------------------------------------------------
export class AdaptHost {
  private wrapper!: AdaptWrapper;
  readonly unit: Unit;

  constructor(
    private readonly brokerUrl: string,
    private readonly log: Logger,
  ) {
    this.unit = locateUnit();
  }

  async boot(): Promise<void> {
    const argv = [
      '--broker_address', this.brokerUrl,
      '--test_mode',
      '--logger_config', '--level', 'INFO', '--stdout', 'stderr', '--logger_config_end',
    ];
    this.log(`booting wrapper (unit ${this.unit.hash.slice(0, 12)}…, broker ${this.brokerUrl})`);
    this.wrapper = await adapt_wrapper.start(argv);
    this.wrapper.on_packet_created_cb = (cid: string) => this.log(`wrapper: packet ready ${cid.slice(0, 12)}…`);
    this.wrapper.start();
  }

  createPacket(name: string, seed: string, signingSecret?: string): Promise<Packet> {
    const config = new PacketWrapperConfigurator();
    const args = [
      '--unit_hash', this.unit.hash,
      '--seed_phrase', seed,
      '--unit_dir_path', this.unit.dir,
    ];
    // A persisted SIGN secret (adapt #77) is the Serialize()-hex of the secretkey_sign
    // (see exportSigningSecret). Deliver it through the wrapper's normal init_arg
    // channel: actor.mu's __init deserializes it (_hex_string_to_binary ->
    // _read_or_abort) and reseeds, restoring the container address — no pre-created
    // packet, so the wrapper still runs its own protocol/attestation setup.
    if (signingSecret) {
      args.push('--init_trn_argument', JSON.stringify(signingSecret));
    }
    config.process_arguments(args);
    return new Promise<Packet>((resolveCreate, rejectCreate) => {
      const timer = setTimeout(
        () => rejectCreate(new Error(`packet creation for "${name}" timed out`)),
        30_000,
      );
      this.wrapper.packet_manager.create_packet(
        config,
        (pw: AdaptPacketWrapper) => {
          clearTimeout(timer);
          const cid = withScope((lt) => pw.packet.GetContainerID().Attach(lt).Visualize());
          this.log(`[${name}] packet created — container id ${cid}`);
          resolveCreate(new Packet(name, cid, pw));
        },
        this.unit.contents,
      );
    });
  }

  removePacket(cid: string): void {
    this.wrapper.remove_packet(cid);
  }
}

// ----- invite blob packing ----------------------------------------------------
// base64url(brotli(raw _write blob)) — no version prefix. The ours proxy's
// `add_contact` must use the SAME encoding (brotli, no prefix) to decode it.
export function packInvite(raw: Buffer): string {
  const compressed = brotliCompressSync(raw, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
  return compressed.toString('base64url');
}

export function unpackInvite(b64: string): Buffer {
  const outer = Buffer.from(b64.replace(/\s+/g, ''), 'base64url');
  if (outer.length < 1) throw new Error('the invite blob is empty or not valid base64');
  return Buffer.from(brotliDecompressSync(outer));
}

// ----- AdaptValue → plain output ----------------------------------------------
export interface InboxMsg {
  msg_id: number;
  sender_id: string;
  sender_name: string;
  text: string;
  date: string;
  status: string;
  wire_id: string;
}

export function renderInbox(v: AdaptValue): InboxMsg[] {
  const out: InboxMsg[] = [];
  if (v.IsNil()) return out;
  for (let i = 0; ; i++) {
    const m = v.Reduce(i);
    if (m.IsNil()) break;
    out.push({
      msg_id: parseInt(m.Reduce('msg_id').Visualize(), 10),
      sender_id: m.Reduce('sender_id').Visualize(),
      sender_name: m.Reduce('sender_name').Visualize(),
      text: m.Reduce('text').Visualize(),
      date: m.Reduce('date').Visualize(),
      status: m.Reduce('status').Visualize(),
      wire_id: m.Reduce('wire_id').Visualize(),
    });
  }
  return out;
}

export interface InboxFile {
  file_id: number;
  sender_id: string;
  sender_name: string;
  filename: string;
  mime: string;
  bytes: Buffer;
  date: string;
  wire_id: string;
}

// Decode a file_t[] AdaptValue (from ::actor::get_files' $files or
// ::actor::list_incoming_files) into plain objects, pulling the raw bytes out of
// the bin field via GetBinary (mirrors how the invite blob is read).
export function renderFiles(v: AdaptValue): InboxFile[] {
  const out: InboxFile[] = [];
  if (v.IsNil()) return out;
  for (let i = 0; ; i++) {
    const f = v.Reduce(i);
    if (f.IsNil()) break;
    out.push({
      file_id: parseInt(f.Reduce('file_id').Visualize(), 10),
      sender_id: f.Reduce('sender_id').Visualize(),
      sender_name: f.Reduce('sender_name').Visualize(),
      filename: f.Reduce('filename').Visualize(),
      mime: f.Reduce('mime').Visualize(),
      bytes: Buffer.from(f.Reduce('data').GetBinary()),
      date: f.Reduce('date').Visualize(),
      wire_id: f.Reduce('wire_id').Visualize(),
    });
  }
  return out;
}

// A queued control-channel request drained from the packet's control_inbox via
// ::actor::get_control_requests. The payload is the opaque JSON the control
// plane (messenger) sent through ::a2a_control::send_control.
export interface ControlRequest {
  senderCid: string;
  senderName: string;
  payload: string;
  date: string;
}

export function renderControlRequests(v: AdaptValue): ControlRequest[] {
  const out: ControlRequest[] = [];
  if (v.IsNil()) return out;
  for (let i = 0; ; i++) {
    const m = v.Reduce(i);
    if (m.IsNil()) break;
    out.push({
      senderCid: m.Reduce('sender_cid').Visualize(),
      senderName: m.Reduce('sender_name').Visualize(),
      payload: m.Reduce('payload').Visualize(),
      date: m.Reduce('date').Visualize(),
    });
  }
  return out;
}

// Observable monitoring/control state from ::actor::get_monitoring_status. The
// bound proxy (proxyCid) is the only contact authorized to drive the config
// capability verbs.
export interface MonitoringStatus {
  proxyCid: string;
  proxyPending: boolean;
  controlQueued: number;
}

export function renderMonitoringStatus(v: AdaptValue): MonitoringStatus {
  return {
    proxyCid: v.Reduce('proxy_cid').Visualize(),
    proxyPending: v.Reduce('proxy_pending').GetBoolean(),
    controlQueued: parseInt(v.Reduce('control_queued').Visualize(), 10) || 0,
  };
}

export interface Contact {
  name: string;
  container_id: string;
}

export function renderContacts(v: AdaptValue): Contact[] {
  const out: Contact[] = [];
  if (v.IsNil()) return out;
  for (const key of v.GetKeys()) {
    const c = v.Reduce(key);
    if (c.IsNil()) continue;
    out.push({
      name: c.Reduce('name').Visualize(),
      container_id: c.Reduce('container_id').Visualize(),
    });
  }
  return out;
}
