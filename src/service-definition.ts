// What gets BAKED into the connector's service definition.
//
// Lives here rather than inline in cli.ts for the same reason ours-mcp keeps
// buildSystemdUnit in its own module: cli.ts runs `main()` on import, so nothing
// inside it can be exercised by a test, and the baked environment is precisely
// the part that decides which daemon this connector attaches to after a reboot.
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
// anyone. (ours-cowork's serviceEnvironment already omits absent daemon fields
// the same way, and @ours.network/cli declines to bake OURS_PORT for the same
// reason: a baked value silently outranks a later edit.)

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
