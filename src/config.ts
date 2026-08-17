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
  // NO SPEECH-TO-TEXT SETTINGS LIVE HERE ANY MORE. The connector had its own STT
  // client (src/stt.ts) configured by sttEnabled/sttApiKey/sttBaseUrl/sttModel/
  // sttLanguage/sttKinds/sttMaxBytes/sttTimeoutMs/forwardVoiceAudio. All nine are
  // gone: transcription is the ours SDK's job and there is now exactly one
  // transcription client in the system, on the receiving side.
  //
  // Any of those keys still sitting in an operator's config.json or environment
  // is INERT — so it is reported loudly at startup rather than ignored. See
  // removedSttWarnings() at the bottom of this file.
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
};

export function configPath(): string {
  return process.env.OURS_TG_CONFIG ?? join(homedir(), '.ours-telegram', 'config.json');
}

// The config file exactly as it is on disk, before any field is recognised. Only
// removedSttWarnings() needs this: it has to see keys that loadConfig no longer
// knows about. Unreadable or malformed => {} , same as readFileConfig.
export function rawFileConfig(): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath(), 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readFileConfig(): Partial<ConnectorConfig> {
  const parsed = rawFileConfig();
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
  // The nine stt*/forwardVoiceAudio keys are deliberately NOT read here — they no
  // longer exist. rawFileConfig() below hands the untouched parse to
  // removedSttWarnings() so a surviving key is announced, not silently dropped.
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
  };
}

export function writeConfig(cfg: ConnectorConfig): string {
  const path = configPath();
  // A rewrite drops every key this build no longer knows about, including the
  // removed stt* block. Say so BEFORE overwriting rather than letting the
  // operator discover it from a diff — there is no sttApiKey field left to mask
  // here any more, because there is no STT client left to configure.
  const losing = removedSttWarnings(rawFileConfig(), {});
  if (losing.length) {
    process.stderr.write(`${losing.join('\n')}\n`);
    process.stderr.write(`[config] rewriting ${path} now REMOVES those keys from the file.\n`);
  }
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(path, 0o600);
  } catch {
    /* best effort: platforms without POSIX modes */
  }
  return path;
}

// ----- removed speech-to-text settings ----------------------------------------
//
// The connector's own STT is gone (src/stt.ts deleted). These nine settings are
// therefore INERT, and an operator who has them set today is losing a capability
// they deliberately turned on — so every surviving one is named, individually,
// at startup. A generic "some settings are obsolete" line would be worse than
// nothing: it tells an operator something changed without telling them what they
// lost.

/** config.json keys that no longer do anything, paired with their env var. */
export const REMOVED_STT_SETTINGS: ReadonlyArray<{ key: string; env: string }> = [
  { key: 'sttEnabled', env: 'OURS_TG_STT_ENABLED' },
  { key: 'sttApiKey', env: 'OURS_TG_STT_API_KEY' },
  { key: 'sttBaseUrl', env: 'OURS_TG_STT_BASE_URL' },
  { key: 'sttModel', env: 'OURS_TG_STT_MODEL' },
  { key: 'sttLanguage', env: 'OURS_TG_STT_LANGUAGE' },
  { key: 'sttKinds', env: 'OURS_TG_STT_KINDS' },
  { key: 'sttMaxBytes', env: 'OURS_TG_STT_MAX_BYTES' },
  { key: 'sttTimeoutMs', env: 'OURS_TG_STT_TIMEOUT_MS' },
  { key: 'forwardVoiceAudio', env: 'OURS_TG_FORWARD_VOICE_AUDIO' },
];

/**
 * The one attachment kind the SDK can still transcribe. `voice` is Telegram's
 * SEMANTIC voice-note kind, and it is the only kind this connector stamps with
 * `x-ours-kind=voice-message` — which is exactly what the SDK's isVoiceMessage()
 * matches. Any other kind an operator had in sttKinds is transcribed by nobody
 * now, and that is the one real capability loss in this change.
 */
export const SDK_TRANSCRIBABLE_KIND = 'voice';

function parseKinds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((k): k is string => typeof k === 'string');
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * One warning line per surviving removed setting, plus an explicit line naming
 * the non-voice kinds that lose transcription outright. Pure — takes the raw
 * config object and an env map — so it is unit-testable without a daemon, a
 * config file, or process.env.
 *
 * Returns [] when the operator has none of them set, which is the common case:
 * silence when there is nothing to say.
 */
export function removedSttWarnings(
  raw: Record<string, unknown>,
  env: Record<string, string | undefined>,
): string[] {
  const present = REMOVED_STT_SETTINGS.filter(
    ({ key, env: name }) => raw[key] !== undefined || env[name] !== undefined,
  );
  if (present.length === 0) return [];

  const lines = [
    '[config] SPEECH-TO-TEXT HAS MOVED OUT OF THIS CONNECTOR and the following ' +
      'settings no longer do anything:',
  ];
  for (const { key, env: name } of present) {
    const where: string[] = [];
    if (raw[key] !== undefined) where.push(`config.json "${key}"`);
    if (env[name] !== undefined) where.push(`env ${name}`);
    // The value is never echoed: one of these keys is an API key.
    lines.push(`[config]   - ${where.join(' and ')} — ignored`);
  }
  lines.push(
    '[config] Voice notes are now forwarded as audio and transcribed ONCE, by the ' +
      'RECEIVING side\'s ours daemon, using the `stt` key in ITS ~/.ours/config.json. ' +
      'Transcription is off there until that key is configured — and configuring it ' +
      'is no longer something this operator controls.',
  );

  // The specific loss, named. Only meaningful when STT was actually on.
  const enabled = raw.sttEnabled === true || env.OURS_TG_STT_ENABLED === '1' ||
    env.OURS_TG_STT_ENABLED?.toLowerCase() === 'true';
  const kinds = env.OURS_TG_STT_KINDS !== undefined
    ? parseKinds(env.OURS_TG_STT_KINDS)
    : parseKinds(raw.sttKinds);
  const orphaned = kinds.filter((k) => k !== SDK_TRANSCRIBABLE_KIND);
  if (orphaned.length) {
    lines.push(
      `[config] CAPABILITY LOST: sttKinds included ${orphaned.map((k) => `"${k}"`).join(', ')}, ` +
        `which ${orphaned.length === 1 ? 'is' : 'are'} NOT transcribed by anything now. The SDK only ` +
        `transcribes Telegram's semantic "${SDK_TRANSCRIBABLE_KIND}" notes (the only kind carrying the ` +
        `x-ours-kind=voice-message marker its detector matches). Such attachments are now ` +
        `delivered as plain files with no transcript` +
        `${enabled ? '' : ' (STT was already disabled, so nothing changes today)'}.`,
    );
  }
  return lines;
}
