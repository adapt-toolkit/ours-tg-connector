// Control-plane (ours messenger) integration for the connector node.
//
// The messenger manages this node over the a2a_control channel using a JSON-RPC
// protocol ({v,id,t,...}) — daemon-mediated, NOT direct core transactions. This
// module owns the verb dispatch (bind / get_manifest / get_config / set_config)
// and the manifest + config schema the messenger renders. app_id is unknown to
// the messenger, so it falls back to its GENERIC configuration template.
//
// Both config fields are plain strings so they ride the config wire; a `secret`
// field's value is stripped by the messenger on save, so the bot token is NOT
// configurable here (it is set at connection creation).

import type { Packet } from './adapt';
import { renderMonitoringStatus, withScope, withScopeAsync, type ControlRequest, type MonitoringStatus } from './adapt';

export const APP_ID = 'network.ours.telegram-connector';
export const DEFAULT_DENIED = 'You are not allowed to speak to this bot, please contact the admin.';

export const CONFIG_SCHEMA = {
  version: '1',
  groups: [
    {
      id: 'routing',
      title: 'Telegram routing',
      desc: 'Control which Telegram chat may talk to this bot, and what everyone else is told.',
      fields: [
        {
          key: 'allowedChatId',
          label: 'Allowed chat ID',
          type: 'string',
          required: true,
          help: 'Only messages from this Telegram chat are proxied to the agent. Any other chat receives the denial message.',
          placeholder: '-1001234567890',
        },
        {
          key: 'deniedMessage',
          label: 'Denial message',
          type: 'string',
          required: true,
          help: 'Sent back to any chat that is not the allowed one.',
          placeholder: DEFAULT_DENIED,
        },
      ],
    },
  ],
} as const;

// The mutable slice of a connection the control plane configures.
export interface NodeConfig {
  name: string;
  label: string;
  chatId: string; // the allowed chat
  deniedMessage: string;
}

export function monitoringStatus(pkt: Packet): MonitoringStatus {
  // core 1.15 owns the monitoring gate (forced copies key off this binding).
  return withScope((lt) => renderMonitoringStatus(pkt.readonlyTx('::a2a_messaging::get_monitoring_status', lt)));
}

export async function sendControl(pkt: Packet, contactCid: string, payload: unknown): Promise<void> {
  await withScopeAsync((lt) =>
    pkt.mutatingTx('::a2a_control::send_control', { contact: contactCid, payload: JSON.stringify(payload) }, lt),
  );
}

// The capability ids the packet's own manifest advertises. Read straight from
// ::a2a_capabilities::get_manifest (the live MUFL describe() hook) and passed
// through verbatim — the enablement decision lives solely in the packet's
// `supports_connect` bool, so this is plumbing, never a place to whitelist or
// drop a capability (dropping core.connect here would silently disable Connect).
export function readPacketCapabilities(pkt: Packet): string[] {
  return withScope((lt) => {
    const caps = pkt.readonlyTx('::a2a_capabilities::get_manifest', lt).Reduce('capabilities');
    if (caps.IsNil()) return [];
    return caps.GetKeys().map((k) => k.Visualize());
  });
}

export function buildManifest(pkt: Packet, cfg: NodeConfig, bound: boolean): Record<string, unknown> {
  return {
    version: '1',
    app_id: APP_ID,
    name: cfg.label || cfg.name,
    description: 'Bridges a Telegram bot to an ours proxy node.',
    monitoring_status: bound ? 'bound' : 'unbound',
    capabilities: readPacketCapabilities(pkt),
  };
}

export function configValues(cfg: NodeConfig): Record<string, unknown> {
  return {
    allowedChatId: cfg.chatId,
    deniedMessage: cfg.deniedMessage || DEFAULT_DENIED,
  };
}

// Apply an inbound config blob (mutates cfg in place). Returns whether anything
// changed. Only the two operational strings are honoured.
export function applyConfig(cfg: NodeConfig, values: Record<string, unknown>): boolean {
  let changed = false;
  if (typeof values.allowedChatId === 'string') {
    const v = values.allowedChatId.trim();
    if (v !== cfg.chatId) { cfg.chatId = v; changed = true; }
  }
  if (typeof values.deniedMessage === 'string' && values.deniedMessage !== cfg.deniedMessage) {
    cfg.deniedMessage = values.deniedMessage;
    changed = true;
  }
  return changed;
}

export interface DispatchHooks {
  persist: () => void;      // called after a config change to write cfg to disk
  log: (msg: string) => void;
}

// Route one drained control request. bind is open; every other verb requires the
// sender to BE the bound monitoring proxy. Replies over send_control.
export async function dispatchControlRequest(
  pkt: Packet,
  cfg: NodeConfig,
  req: ControlRequest,
  hooks: DispatchHooks,
): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    const parsed = JSON.parse(req.payload) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    msg = parsed as Record<string, unknown>;
  } catch {
    hooks.log(`dropping unparseable control request from ${req.senderName}`);
    return;
  }
  if (msg.v !== 1 || typeof msg.t !== 'string') {
    hooks.log(`dropping control request with unknown envelope from ${req.senderName}`);
    return;
  }
  const reply = async (data: Record<string, unknown>): Promise<void> => {
    try {
      await sendControl(pkt, req.senderCid, { v: 1, t: 'res', id: msg.id ?? null, req: msg.t, ...data });
    } catch (err) {
      hooks.log(`control reply to ${req.senderName} failed: ${String(err)}`);
    }
  };

  try {
    if (msg.t === 'bind') {
      const verdict = await withScopeAsync(async (lt) => {
        const data = await pkt.mutatingTx(
          '::a2a_messaging::verify_proxy_code',
          { code: String(msg.code ?? ''), sender: req.senderCid },
          lt,
        );
        return { verified: data.Reduce('verified').GetBoolean(), reason: data.Reduce('reason').Visualize() };
      });
      if (!verdict.verified) {
        hooks.log(`proxy bind attempt from ${req.senderName} rejected (${verdict.reason})`);
        await reply({ ok: false, error: verdict.reason });
        return;
      }
      hooks.log(`control plane bound: ${req.senderName} (${req.senderCid})`);
      await reply({ ok: true, manifest: buildManifest(pkt, cfg, true) });
      return;
    }

    const proxyCid = monitoringStatus(pkt).proxyCid;
    if (!proxyCid || proxyCid !== req.senderCid) {
      await reply({ ok: false, error: 'not_authorized' });
      return;
    }

    switch (msg.t) {
      case 'get_manifest':
        await reply({ ok: true, manifest: buildManifest(pkt, cfg, true) });
        return;
      case 'get_config':
        await reply({ ok: true, config: { schema: CONFIG_SCHEMA, values: configValues(cfg) } });
        return;
      case 'set_config': {
        let values: Record<string, unknown>;
        try {
          values = JSON.parse(String(msg.config ?? '{}')) as Record<string, unknown>;
        } catch {
          await reply({ ok: false, error: 'config is not valid JSON' });
          return;
        }
        if (applyConfig(cfg, values)) hooks.persist();
        hooks.log(`config updated: allowedChatId=${cfg.chatId || '(any)'} deniedMessage=${JSON.stringify(cfg.deniedMessage)}`);
        await reply({ ok: true, config: { schema: CONFIG_SCHEMA, values: configValues(cfg) } });
        return;
      }
      default:
        await reply({ ok: false, error: `unknown request type "${msg.t}"` });
    }
  } catch (err) {
    await reply({ ok: false, error: String(err) });
  }
}
