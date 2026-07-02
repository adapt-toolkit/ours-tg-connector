// Shared runtime configuration for the ours Telegram connector.
//
// Per field, precedence is: explicit env var > config.json > built-in default.
// The config file lives at OURS_TG_CONFIG, else <home>/.ours-telegram/
// config.json — a FIXED home location, independent of a configured stateDir.

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';

export interface ConnectorConfig {
  brokerUrl: string;   // the ADAPT broker every hosted packet connects through
  controlPort: number; // localhost JSON control API (add/list/remove connections)
  stateDir: string;    // one subdir per connection: stateDir/<name>/
  pollTimeoutSec: number; // Telegram long-poll timeout per getUpdates call
  attachmentMaxBytes: number; // max media size forwarded inline (base64) before degrading to a metadata-only stub
  outboundFileMaxBytes: number; // max size of a received file we will upload to Telegram (bot upload limit is 50 MB)
}

export const DEFAULT_CONFIG: ConnectorConfig = {
  brokerUrl: 'wss://ours.network/broker_new',
  controlPort: 3051,
  stateDir: resolve(homedir(), '.ours-telegram'),
  pollTimeoutSec: 30,
  attachmentMaxBytes: 10 * 1024 * 1024, // 10 MB (encoded ≈ 13.5 MB; under Telegram's 20 MB bot-API download limit)
  outboundFileMaxBytes: 50 * 1024 * 1024, // Telegram bot sendDocument upper bound
};

export function configPath(): string {
  return process.env.OURS_TG_CONFIG ?? join(homedir(), '.ours-telegram', 'config.json');
}

function readFileConfig(): Partial<ConnectorConfig> {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath(), 'utf8');
  } catch {
    return {};
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
  const out: Partial<ConnectorConfig> = {};
  if (typeof parsed.brokerUrl === 'string') out.brokerUrl = parsed.brokerUrl;
  if (typeof parsed.controlPort === 'number' && Number.isFinite(parsed.controlPort)) out.controlPort = parsed.controlPort;
  if (typeof parsed.stateDir === 'string') out.stateDir = resolve(parsed.stateDir);
  if (typeof parsed.pollTimeoutSec === 'number' && Number.isFinite(parsed.pollTimeoutSec)) {
    out.pollTimeoutSec = parsed.pollTimeoutSec;
  }
  if (typeof parsed.attachmentMaxBytes === 'number' && Number.isFinite(parsed.attachmentMaxBytes)) {
    out.attachmentMaxBytes = parsed.attachmentMaxBytes;
  }
  if (typeof parsed.outboundFileMaxBytes === 'number' && Number.isFinite(parsed.outboundFileMaxBytes)) {
    out.outboundFileMaxBytes = parsed.outboundFileMaxBytes;
  }
  return out;
}

function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

export function loadConfig(): ConnectorConfig {
  const file = readFileConfig();
  return {
    brokerUrl: process.env.OURS_TG_BROKER_URL ?? file.brokerUrl ?? DEFAULT_CONFIG.brokerUrl,
    controlPort: envInt('OURS_TG_CONTROL_PORT') ?? file.controlPort ?? DEFAULT_CONFIG.controlPort,
    stateDir: resolve(process.env.OURS_TG_STATE_DIR ?? file.stateDir ?? DEFAULT_CONFIG.stateDir),
    pollTimeoutSec: envInt('OURS_TG_POLL_TIMEOUT') ?? file.pollTimeoutSec ?? DEFAULT_CONFIG.pollTimeoutSec,
    attachmentMaxBytes: envInt('OURS_TG_ATTACHMENT_MAX_BYTES') ?? file.attachmentMaxBytes ?? DEFAULT_CONFIG.attachmentMaxBytes,
    outboundFileMaxBytes: envInt('OURS_TG_OUTBOUND_FILE_MAX_BYTES') ?? file.outboundFileMaxBytes ?? DEFAULT_CONFIG.outboundFileMaxBytes,
  };
}

export function writeConfig(cfg: ConnectorConfig): string {
  const path = configPath();
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(path, 0o600);
  } catch {
    /* best effort: platforms without POSIX modes */
  }
  return path;
}
