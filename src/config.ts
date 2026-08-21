// Shared runtime configuration for the ours Telegram connector.
//
// Per field, precedence is: explicit env var > config.json > built-in default.
// The config file lives at OURS_TG_CONFIG, else <home>/.ours-telegram/
// config.json — a FIXED home location, independent of a configured stateDir.

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';

export interface ConnectorConfig {
  // WHICH OURS DAEMON TO ATTACH TO. Both are OPTIONAL and both are passed
  // straight to the SDK's resolveDaemonConfig, which owns precedence, source
  // tracking and the coherence refusal. Setting daemonUrl WITHOUT daemonStateDir
  // is refused by that resolver before any credential is read — that is the
  // reproduced credential-disclosure case (ours-sdk 43ca743), and it is refused
  // there rather than here so there is exactly one implementation of the rule.
  // SDK 2 also rejects legacy OURS_INSTANCE and ignores OURS_AUTOSTART/autoStart:
  // the connector always attaches and never starts or embeds a daemon.
  daemonUrl: string;      // '' => the SDK's default selection
  daemonStateDir: string; // '' => the SDK's default selection
  controlPort: number; // localhost JSON control API (add/list/remove connections)
  stateDir: string;    // this connector's OWN config dir (bots.json + one subdir per route)
  pollTimeoutSec: number; // Telegram long-poll timeout per getUpdates call
  // Telegram network path hardening (see src/telegram.ts). Default is the robust
  // path: force IPv4 so a configured-but-unreachable IPv6 can't stall/fail fetch.
  tgForceIpv4: boolean;        // pin Telegram requests to the IPv4 A record
  tgConnectTimeoutMs: number;  // bound a stalled connect (fail fast, not ~30s)
  tgFetchRetries: number;      // transient-error retries for transactional calls
  tgFetchRetryBaseMs: number;  // base backoff between those retries (ms)
  attachmentMaxBytes: number; // max media size forwarded inline (base64) before degrading to a metadata-only stub
  outboundFileMaxBytes: number; // max size of a received file we will upload to Telegram (bot upload limit is 50 MB)
  // Speech-to-text for inbound voice notes (opt-in).
  //
  // WHAT `false` PROMISES, PRECISELY: that THIS PROCESS does not send audio to a
  // speech-to-text provider. It does NOT promise the audio is never transcribed.
  // The connector is a client of a daemon that runs its OWN STT when the
  // receiving side pulls a voice note, under configuration this operator does
  // not control. As a host, `false` covered the whole path; attached, it cannot.
  sttEnabled: boolean;
  sttApiKey: string;        // secret; env-preferred, masked on config.json rewrite
  sttBaseUrl: string;       // OpenAI-compatible endpoint root
  sttModel: string;         // transcription model
  sttLanguage: string;      // '' => provider auto-detects
  sttKinds: string[];       // attachment kinds to transcribe
  sttMaxBytes: number;      // skip STT above this (cost/latency guard)
  sttTimeoutMs: number;     // per-call abort deadline
  forwardVoiceAudio: boolean; // also send_file the transcribed audio
}

export const DEFAULT_CONFIG: ConnectorConfig = {
  daemonUrl: '',
  daemonStateDir: '',
  controlPort: 3051,
  stateDir: resolve(homedir(), '.ours-telegram'),
  pollTimeoutSec: 30,
  tgForceIpv4: true,
  tgConnectTimeoutMs: 10_000,
  tgFetchRetries: 3,
  tgFetchRetryBaseMs: 300,
  attachmentMaxBytes: 10 * 1024 * 1024, // 10 MB (encoded ≈ 13.5 MB; under Telegram's 20 MB bot-API download limit)
  outboundFileMaxBytes: 50 * 1024 * 1024, // Telegram bot sendDocument upper bound
  sttEnabled: false,
  sttApiKey: '',
  sttBaseUrl: 'https://api.openai.com/v1',
  sttModel: 'whisper-1',
  sttLanguage: '',
  sttKinds: ['voice'],
  sttMaxBytes: 5 * 1024 * 1024, // 5 MB
  sttTimeoutMs: 60000,
  forwardVoiceAudio: false,
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
  if (typeof parsed.daemonUrl === 'string') out.daemonUrl = parsed.daemonUrl;
  if (typeof parsed.daemonStateDir === 'string') out.daemonStateDir = resolve(parsed.daemonStateDir);
  if (typeof parsed.controlPort === 'number' && Number.isFinite(parsed.controlPort)) out.controlPort = parsed.controlPort;
  if (typeof parsed.stateDir === 'string') out.stateDir = resolve(parsed.stateDir);
  if (typeof parsed.pollTimeoutSec === 'number' && Number.isFinite(parsed.pollTimeoutSec)) {
    out.pollTimeoutSec = parsed.pollTimeoutSec;
  }
  if (typeof parsed.tgForceIpv4 === 'boolean') out.tgForceIpv4 = parsed.tgForceIpv4;
  if (typeof parsed.tgConnectTimeoutMs === 'number' && Number.isFinite(parsed.tgConnectTimeoutMs)) {
    out.tgConnectTimeoutMs = parsed.tgConnectTimeoutMs;
  }
  if (typeof parsed.tgFetchRetries === 'number' && Number.isFinite(parsed.tgFetchRetries)) {
    out.tgFetchRetries = parsed.tgFetchRetries;
  }
  if (typeof parsed.tgFetchRetryBaseMs === 'number' && Number.isFinite(parsed.tgFetchRetryBaseMs)) {
    out.tgFetchRetryBaseMs = parsed.tgFetchRetryBaseMs;
  }
  if (typeof parsed.attachmentMaxBytes === 'number' && Number.isFinite(parsed.attachmentMaxBytes)) {
    out.attachmentMaxBytes = parsed.attachmentMaxBytes;
  }
  if (typeof parsed.outboundFileMaxBytes === 'number' && Number.isFinite(parsed.outboundFileMaxBytes)) {
    out.outboundFileMaxBytes = parsed.outboundFileMaxBytes;
  }
  if (typeof parsed.sttEnabled === 'boolean') out.sttEnabled = parsed.sttEnabled;
  if (typeof parsed.sttApiKey === 'string') out.sttApiKey = parsed.sttApiKey;
  if (typeof parsed.sttBaseUrl === 'string') out.sttBaseUrl = parsed.sttBaseUrl;
  if (typeof parsed.sttModel === 'string') out.sttModel = parsed.sttModel;
  if (typeof parsed.sttLanguage === 'string') out.sttLanguage = parsed.sttLanguage;
  if (Array.isArray(parsed.sttKinds)) out.sttKinds = parsed.sttKinds.filter((k): k is string => typeof k === 'string');
  if (typeof parsed.sttMaxBytes === 'number' && Number.isFinite(parsed.sttMaxBytes)) out.sttMaxBytes = parsed.sttMaxBytes;
  if (typeof parsed.sttTimeoutMs === 'number' && Number.isFinite(parsed.sttTimeoutMs)) out.sttTimeoutMs = parsed.sttTimeoutMs;
  if (typeof parsed.forwardVoiceAudio === 'boolean') out.forwardVoiceAudio = parsed.forwardVoiceAudio;
  return out;
}

function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === '1' || v.toLowerCase() === 'true';
}

export function loadConfig(): ConnectorConfig {
  const file = readFileConfig();
  return {
    // NOTE: no OURS_TG_BROKER_URL any more. The connector does not talk to a
    // broker — the daemon does. A stale one in a config file is now ignored
    // rather than half-honoured.
    daemonUrl: process.env.OURS_TG_DAEMON_URL ?? file.daemonUrl ?? DEFAULT_CONFIG.daemonUrl,
    daemonStateDir: process.env.OURS_TG_DAEMON_STATE_DIR ?? file.daemonStateDir ?? DEFAULT_CONFIG.daemonStateDir,
    controlPort: envInt('OURS_TG_CONTROL_PORT') ?? file.controlPort ?? DEFAULT_CONFIG.controlPort,
    stateDir: resolve(process.env.OURS_TG_STATE_DIR ?? file.stateDir ?? DEFAULT_CONFIG.stateDir),
    pollTimeoutSec: envInt('OURS_TG_POLL_TIMEOUT') ?? file.pollTimeoutSec ?? DEFAULT_CONFIG.pollTimeoutSec,
    tgForceIpv4: envBool('OURS_TG_FORCE_IPV4') ?? file.tgForceIpv4 ?? DEFAULT_CONFIG.tgForceIpv4,
    tgConnectTimeoutMs: envInt('OURS_TG_CONNECT_TIMEOUT_MS') ?? file.tgConnectTimeoutMs ?? DEFAULT_CONFIG.tgConnectTimeoutMs,
    tgFetchRetries: envInt('OURS_TG_FETCH_RETRIES') ?? file.tgFetchRetries ?? DEFAULT_CONFIG.tgFetchRetries,
    tgFetchRetryBaseMs: envInt('OURS_TG_FETCH_RETRY_BASE_MS') ?? file.tgFetchRetryBaseMs ?? DEFAULT_CONFIG.tgFetchRetryBaseMs,
    attachmentMaxBytes: envInt('OURS_TG_ATTACHMENT_MAX_BYTES') ?? file.attachmentMaxBytes ?? DEFAULT_CONFIG.attachmentMaxBytes,
    outboundFileMaxBytes: envInt('OURS_TG_OUTBOUND_FILE_MAX_BYTES') ?? file.outboundFileMaxBytes ?? DEFAULT_CONFIG.outboundFileMaxBytes,
    sttEnabled: envBool('OURS_TG_STT_ENABLED') ?? file.sttEnabled ?? DEFAULT_CONFIG.sttEnabled,
    sttApiKey: process.env.OURS_TG_STT_API_KEY ?? file.sttApiKey ?? DEFAULT_CONFIG.sttApiKey,
    sttBaseUrl: process.env.OURS_TG_STT_BASE_URL ?? file.sttBaseUrl ?? DEFAULT_CONFIG.sttBaseUrl,
    sttModel: process.env.OURS_TG_STT_MODEL ?? file.sttModel ?? DEFAULT_CONFIG.sttModel,
    sttLanguage: process.env.OURS_TG_STT_LANGUAGE ?? file.sttLanguage ?? DEFAULT_CONFIG.sttLanguage,
    sttKinds: process.env.OURS_TG_STT_KINDS?.split(',').map((s) => s.trim()).filter(Boolean) ?? file.sttKinds ?? DEFAULT_CONFIG.sttKinds,
    sttMaxBytes: envInt('OURS_TG_STT_MAX_BYTES') ?? file.sttMaxBytes ?? DEFAULT_CONFIG.sttMaxBytes,
    sttTimeoutMs: envInt('OURS_TG_STT_TIMEOUT_MS') ?? file.sttTimeoutMs ?? DEFAULT_CONFIG.sttTimeoutMs,
    forwardVoiceAudio: envBool('OURS_TG_FORWARD_VOICE_AUDIO') ?? file.forwardVoiceAudio ?? DEFAULT_CONFIG.forwardVoiceAudio,
  };
}

export function writeConfig(cfg: ConnectorConfig): string {
  const path = configPath();
  fs.mkdirSync(dirname(path), { recursive: true });
  // Never persist the STT secret in clear — operators supply it via
  // OURS_TG_STT_API_KEY. Mirror the token-at-rest hygiene used for bots.json.
  const onDisk: ConnectorConfig = { ...cfg, sttApiKey: cfg.sttApiKey ? `${cfg.sttApiKey.slice(0, 4)}…(set via env)` : '' };
  fs.writeFileSync(path, JSON.stringify(onDisk, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(path, 0o600);
  } catch {
    /* best effort: platforms without POSIX modes */
  }
  return path;
}
