// What gets BAKED into the connector's service definition.
//
// This lives outside cli.ts because cli.ts runs `main()` on import and cannot be
// safely imported by unit tests. The baked environment decides which daemon the
// connector attaches to after a reboot and therefore needs direct coverage.
//
// THE RULE, and it is the whole reason this file exists: a value the operator has
// NOT chosen must produce NO LINE AT ALL.
//
// `Environment=OURS_TG_DAEMON_URL=` does not leave the variable unset — systemd
// sets it to the EMPTY STRING (unsetting needs UnsetEnvironment=), and launchd's
// <string></string> does the same. loadConfig then resolves with `??`, which falls
// back only on null/undefined, so `'' ?? file.daemonUrl` is `''`: an empty baked
// value BEATS config.json for ever after. Someone who installs the service before
// choosing a daemon and then sets daemonUrl/daemonStateDir in
// ~/.ours-telegram/config.json would be silently ignored and left on the SDK's
// default selection — the wrong-daemon attachment this connector's whole SDK
// integration exists to prevent — with no repair short of hand-editing the unit.
//
// Omitting is deliberately preferred over REFUSING to write a service without a
// daemon selection: refusing would turn a silent misconfiguration into a hard
// failure for deployments that currently work on the default selection by
// accident. Omission gives the config file back its authority without breaking
// those deployments: a baked value would silently outrank a later config edit.

import type { ConnectorConfig } from './config';

/**
 * The environment baked into the systemd unit / launchd plist.
 *
 * Every value here is one the operator either chose or that has a real default.
 * A field whose value is empty — meaning "no selection was made" — is left out
 * entirely, so the config file remains authoritative for it.
 */
export function serviceEnvironment(config: ConnectorConfig, stateDir: string): Record<string, string> {
  const env: Record<string, string> = {
    OURS_TG_CONTROL_PORT: String(config.controlPort),
    OURS_TG_STATE_DIR: stateDir,
    OURS_TG_POLL_TIMEOUT: String(config.pollTimeoutSec),
  };
  // The daemon selection: baked only when there IS one.
  if (config.daemonUrl) env.OURS_TG_DAEMON_URL = config.daemonUrl;
  if (config.daemonStateDir) env.OURS_TG_DAEMON_STATE_DIR = config.daemonStateDir;
  return env;
}

// ── The launchd plist ──────────────────────────────────────────────────────────
//
// Every value interpolated into a plist is XML TEXT and has to be escaped as such.
// This was interpolated raw, and a path is allowed to contain the characters that
// makes ill-formed: `/Users/ben/Library/Ben & Co/.ours-telegram` produced
//
//     <key>OURS_TG_STATE_DIR</key><string>/Users/ben/Library/Ben & Co/…</string>
//
// which a strict XML parser rejects outright — "not well-formed (invalid token)"
// — so `launchctl load` has nothing valid to read and the connector silently never
// starts at boot. ours-mcp escapes the identical fields through its own xmlText
// (packages/core/src/service-instance.ts), and the escaped form round-trips the
// path back byte-for-byte. This is the same rule, in the second place that needs it.
//
// `'` is escaped as &apos; deliberately, matching ours-mcp: it is not required in
// element text, but two implementations of one rule that differ in the details are
// how the details drift.
export function xmlText(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]!);
}

export interface LaunchdPlistInput {
  readonly label: string;
  readonly execPath: string;
  /** Absolute path to the installed cli.js the agent runs with `serve`. */
  readonly self: string;
  readonly logPath: string;
  readonly env: Record<string, string>;
}

/** The launchd agent plist text. Emitted here so it is testable without launchd. */
export function launchdPlist(input: LaunchdPlistInput): string {
  const envEntries = Object.entries(input.env)
    .map(([key, value]) => `    <key>${xmlText(key)}</key><string>${xmlText(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlText(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlText(input.execPath)}</string>
    <string>${xmlText(input.self)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlText(input.logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlText(input.logPath)}</string>
</dict>
</plist>
`;
}
