// tests/launchd-plist.test.mjs
//
// A launchd plist is XML, and every value interpolated into one is XML TEXT.
// installLaunchd interpolated them raw, and a legal macOS path is allowed to
// contain the characters that makes ill-formed:
//
//     /Users/ben/Library/Ben & Co/.ours-telegram
//
// produced `<string>/Users/ben/Library/Ben & Co/.ours-telegram</string>`, which a
// strict XML parser rejects — "not well-formed (invalid token)" — so `launchctl
// load` has nothing valid to read and the connector never starts at boot.
//
// This test PARSES the generated plist rather than pattern-matching it. A regex
// would only re-state the implementation; parsing asks the question launchd asks.
// The parse is a deliberately small, strict, dependency-free XML reader: it
// rejects a bare `&` exactly where a conforming parser must, and it decodes the
// five predefined entities so the round-trip can be asserted byte-for-byte.
import assert from 'node:assert/strict';
import { launchdPlist, xmlText } from '../src/service-definition.ts';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };

// ---- a strict-enough XML text reader ----------------------------------------
// Well-formedness rule under test: `&` may appear ONLY as the opening of a
// reference (&name; or &#nn;). Anything else is an invalid token.
function parsePlistStrings(xml) {
  for (const match of xml.matchAll(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)/g)) {
    throw new Error(`not well-formed (invalid token) at index ${match.index}`);
  }
  if (/<(?![?!/a-zA-Z])/.test(xml)) throw new Error('not well-formed (invalid token): bare <');
  const decode = (text) => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  })[name]);
  return [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => decode(m[1]));
}

// Guard the guard: the reader must reject the exact document the old code emitted.
{
  const raw = '<plist><string>/Users/ben/Ben & Co/x</string></plist>';
  let threw = false;
  try { parsePlistStrings(raw); } catch { threw = true; }
  ok(threw, 'the checker itself rejects a raw ampersand, so a pass below means something');
}

const STATE_DIR = '/Users/ben/Library/Ben & Co/.ours-telegram';

// ---- 1. the document is well-formed, and the value survives intact -----------
{
  const plist = launchdPlist({
    label: 'solutions.adaptframework.ours-telegram',
    execPath: '/usr/local/bin/node',
    self: '/usr/local/lib/node_modules/@ours.network/tg-connector/dist/cli.js',
    logPath: `${STATE_DIR}/daemon.log`,
    env: { OURS_TG_STATE_DIR: STATE_DIR, OURS_TG_CONTROL_PORT: '3051' },
  });
  const strings = parsePlistStrings(plist);   // throws if ill-formed
  ok(strings.includes(STATE_DIR),
    'the state directory round-trips through the plist byte-for-byte');
  ok(strings.includes(`${STATE_DIR}/daemon.log`),
    'and so does the log path built from it');
  ok(!/&(?!(?:amp|lt|gt|quot|apos);)/.test(plist),
    'no bare ampersand survives anywhere in the document');
}

// ---- 2. the other metacharacters, including in a KEY -------------------------
// Keys come from the environment map; they are escaped for the same reason values
// are, so that no future field can reintroduce this by carrying an odd name.
{
  const nasty = '/tmp/a<b>c"d\'e&f';
  const plist = launchdPlist({
    label: 'x', execPath: '/usr/local/bin/node', self: '/x/cli.js',
    logPath: '/tmp/x.log', env: { OURS_TG_STATE_DIR: nasty },
  });
  const strings = parsePlistStrings(plist);
  ok(strings.includes(nasty), 'every predefined entity is escaped and decodes back to the original');
}

// ---- 3. xmlText matches ours-mcp's, character for character ------------------
// Two implementations of one rule drift when they differ in the details. This
// mirrors packages/core/src/service-instance.ts, &apos; included.
{
  ok(xmlText(`&<>"'`) === '&amp;&lt;&gt;&quot;&apos;',
    'xmlText escapes all five predefined entities, matching ours-mcp');
  ok(xmlText(3051) === '3051', 'and accepts a number the way the plist builder needs');
}

console.log(`\n${pass} assertions passed`);
