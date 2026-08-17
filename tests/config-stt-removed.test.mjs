#!/usr/bin/env node
// Pure unit test for src/config.ts removedSttWarnings() — the operator-facing
// half of removing the connector's speech-to-text.
//
// WHY THIS TEST EXISTS AT ALL: deleting src/stt.ts silently would take a
// capability away from an operator who deliberately turned it on. The rule this
// file enforces is that every surviving stt* setting is named individually, and
// that a non-voice entry in sttKinds — the one thing nothing transcribes any
// more — is called out as a loss by name rather than folded into a generic
// notice.
//
// Pure: no config file, no process.env, no network.
//
// Run: node_modules/.bin/tsx tests/config-stt-removed.test.mjs

import { removedSttWarnings, REMOVED_STT_SETTINGS, SDK_TRANSCRIBABLE_KIND } from '../src/config.ts';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}
const joined = (lines) => lines.join('\n');

console.log('=== config: removed STT settings are announced, never silently dropped ===');

// Silence when there is nothing to say.
{
  assert(removedSttWarnings({}, {}).length === 0, 'no warnings for an operator who never configured STT');
  assert(removedSttWarnings({ controlPort: 3051, stateDir: '/tmp/x' }, { OURS_TG_POLL_TIMEOUT: '30' }).length === 0,
    'unrelated config keys and env vars produce no STT warning');
}

// Every removed setting is detected, from the file and from the environment.
{
  for (const { key, env } of REMOVED_STT_SETTINGS) {
    const fromFile = removedSttWarnings({ [key]: 'x' }, {});
    assert(fromFile.length > 0 && joined(fromFile).includes(`config.json "${key}"`),
      `config.json "${key}" is named individually`);
    const fromEnv = removedSttWarnings({}, { [env]: 'x' });
    assert(fromEnv.length > 0 && joined(fromEnv).includes(`env ${env}`),
      `env ${env} is named individually`);
  }
}

// A key set in BOTH places is reported as both, on one line.
{
  const out = joined(removedSttWarnings({ sttModel: 'whisper-1' }, { OURS_TG_STT_MODEL: 'whisper-1' }));
  assert(/config\.json "sttModel" and env OURS_TG_STT_MODEL/.test(out),
    'a setting present in file AND env names both sources');
}

// The warning must not become one vague line, and must point at where
// transcription actually lives now.
{
  const lines = removedSttWarnings({ sttEnabled: true, sttApiKey: 'sk-secret-value' }, {});
  assert(lines.length >= 4, 'a configured operator gets a header, a line per setting, and the where-it-went line');
  const out = joined(lines);
  assert(out.includes('~/.ours/config.json'), 'names the file transcription is configured in now');
  assert(/RECEIVING/.test(out), 'says plainly that the receiving side now owns transcription');
}

// SECRET HYGIENE: the API key VALUE must never be echoed back to the console.
{
  const out = joined(removedSttWarnings({ sttApiKey: 'sk-live-do-not-print' }, { OURS_TG_STT_API_KEY: 'sk-env-secret' }));
  assert(out.includes('sttApiKey'), 'the sttApiKey SETTING is named');
  assert(!out.includes('sk-live-do-not-print') && !out.includes('sk-env-secret'),
    'the sttApiKey VALUE is never printed, from either source');
}

// THE ONE REAL CAPABILITY LOSS, named by kind.
{
  const out = joined(removedSttWarnings({ sttEnabled: true, sttKinds: ['voice', 'audio', 'video_note'] }, {}));
  assert(/CAPABILITY LOST/.test(out), 'a non-voice sttKind is reported as a loss, not a deprecation');
  assert(out.includes('"audio"') && out.includes('"video_note"'), 'each orphaned kind is named');
  assert(!/"voice"[,)]/.test(out.split('CAPABILITY LOST')[1] ?? ''),
    'the still-supported "voice" kind is not listed as lost');
}
{
  const out = joined(removedSttWarnings({ sttEnabled: true, sttKinds: ['voice'] }, {}));
  assert(!/CAPABILITY LOST/.test(out), 'the default sttKinds:["voice"] loses nothing and says so by staying quiet');
  assert(SDK_TRANSCRIBABLE_KIND === 'voice', 'voice is the kind the SDK can still transcribe');
}
{
  // env sttKinds overrides the file's, matching the old loadConfig precedence.
  const out = joined(removedSttWarnings({ sttKinds: ['voice'] }, { OURS_TG_STT_KINDS: 'voice, document' }));
  assert(/CAPABILITY LOST/.test(out) && out.includes('"document"'),
    'OURS_TG_STT_KINDS takes precedence over the file when reporting the loss');
}
{
  // Off today: still report it, but do not imply something breaks right now.
  const out = joined(removedSttWarnings({ sttEnabled: false, sttKinds: ['voice', 'audio'] }, {}));
  assert(/CAPABILITY LOST/.test(out), 'an orphaned kind is reported even when STT was disabled');
  assert(/STT was already disabled/.test(out), 'and says nothing changes today when it was disabled');
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
