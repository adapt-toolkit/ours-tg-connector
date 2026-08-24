#!/usr/bin/env node
// Unit tests for src/format.ts — Telegram entities → Markdown (inbound) and
// Markdown → MarkdownV2 (outbound), plus the length/chunking rules.
//
// The two behaviours worth being paranoid about, and why:
//   • UTF-16 OFFSETS. Telegram counts entity offsets in UTF-16 code units. A JS
//     string already IS code units, so plain slice() is correct — the failure mode
//     in JS is "helpfully" switching to code points, which slides every offset
//     after the first emoji. The astral-plane cells below pin that down.
//   • ONE UNESCAPED DOT KILLS THE SEND. MarkdownV2 reserves 18 characters; the
//     escaping must land on text leaves only, never on the markup we generated.
//
// Run: node_modules/.bin/tsx tests/format.test.mjs

import {
  entitiesToMarkdown,
  escapeMarkdownV2,
  toMarkdownV2,
  isParseEntitiesError,
  utf16Len,
  TELEGRAM_TEXT_LIMIT,
} from '../src/format.ts';
import { splitForMarkdownV2, parseReply, messageMarkdown } from '../src/telegram.ts';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  assert(actual === expected, `${msg}${actual === expected ? '' : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`}`);
}

console.log('=== inbound: entities → Markdown ===');
{
  eq(entitiesToMarkdown('plain text', []), 'plain text', 'no entities => text unchanged');
  eq(entitiesToMarkdown('plain text', undefined), 'plain text', 'absent entities => text unchanged');

  eq(entitiesToMarkdown('bold here', [{ type: 'bold', offset: 0, length: 4 }]), '**bold** here', 'bold');
  eq(entitiesToMarkdown('an italic word', [{ type: 'italic', offset: 3, length: 6 }]), 'an _italic_ word', 'italic');
  eq(entitiesToMarkdown('under', [{ type: 'underline', offset: 0, length: 5 }]), '__under__', 'underline');
  eq(entitiesToMarkdown('gone', [{ type: 'strikethrough', offset: 0, length: 4 }]), '~~gone~~', 'strikethrough');
  eq(entitiesToMarkdown('secret', [{ type: 'spoiler', offset: 0, length: 6 }]), '||secret||', 'spoiler');
  eq(entitiesToMarkdown('run x()', [{ type: 'code', offset: 4, length: 3 }]), 'run `x()`', 'inline code');
  eq(
    entitiesToMarkdown('see it', [{ type: 'text_link', offset: 0, length: 3, url: 'https://ours.network/a.b' }]),
    '[see](https://ours.network/a.b) it',
    'text_link',
  );
  eq(
    entitiesToMarkdown('Vit wrote', [{ type: 'text_mention', offset: 0, length: 3, user: { id: 4242 } }]),
    '[Vit](tg://user?id=4242) wrote',
    'text_mention becomes a tg:// link',
  );

  eq(
    entitiesToMarkdown('const x = 1;', [{ type: 'pre', offset: 0, length: 12, language: 'ts' }]),
    '```ts\nconst x = 1;\n```',
    'pre keeps its language',
  );
  eq(
    entitiesToMarkdown('line one\nline two', [{ type: 'blockquote', offset: 0, length: 17 }]),
    '> line one\n> line two',
    'blockquote prefixes every line',
  );

  // A code entity is verbatim: inner entities must NOT be interpreted, or the
  // agent would read markup that was never in the code.
  eq(
    entitiesToMarkdown('a*b', [{ type: 'code', offset: 0, length: 3 }, { type: 'bold', offset: 1, length: 1 }]),
    '`a*b`',
    'code is verbatim — nested entities are not rendered inside it',
  );

  // Nesting + adjacency.
  eq(
    entitiesToMarkdown('bolditalic', [{ type: 'bold', offset: 0, length: 10 }, { type: 'italic', offset: 4, length: 6 }]),
    '**bold_italic_**',
    'nested italic inside bold',
  );
  eq(
    entitiesToMarkdown('ab', [{ type: 'bold', offset: 0, length: 1 }, { type: 'italic', offset: 1, length: 1 }]),
    '**a**_b_',
    'adjacent sibling entities',
  );

  // A custom emoji is premium-only: keep Telegram's stand-in glyph, add nothing.
  eq(
    entitiesToMarkdown('hi 🙂', [{ type: 'custom_emoji', offset: 3, length: 2, custom_emoji_id: '5' }]),
    'hi 🙂',
    'custom_emoji degrades to the stand-in text',
  );

  // Unsupported / decorative types are left alone rather than decorated.
  eq(entitiesToMarkdown('@someone', [{ type: 'mention', offset: 0, length: 8 }]), '@someone', 'mention is left verbatim');
}

console.log('\n=== inbound: UTF-16 code-unit offsets (the astral-plane trap) ===');
{
  // '🎉' is one astral character: TWO UTF-16 code units, ONE code point. Telegram
  // counts the 2. Indexing by code point would put the bold one character early.
  const text = '🎉 party';
  eq(utf16Len('🎉'), 2, 'an astral character is 2 UTF-16 code units');
  eq(
    entitiesToMarkdown(text, [{ type: 'bold', offset: 3, length: 5 }]),
    '🎉 **party**',
    'offsets after an emoji land exactly (code units, not code points)',
  );
  // Bolding the emoji itself: offset 0, length 2 — the whole surrogate pair.
  eq(entitiesToMarkdown(text, [{ type: 'bold', offset: 0, length: 2 }]), '**🎉** party', 'an emoji can itself be an entity');
  // A family emoji is a ZWJ sequence — many code units, still exact.
  const fam = '👨‍👩‍👧 kids';
  eq(
    entitiesToMarkdown(fam, [{ type: 'italic', offset: utf16Len('👨‍👩‍👧 '), length: 4 }]),
    '👨‍👩‍👧 _kids_',
    'a ZWJ emoji sequence does not slide the following offsets',
  );
  // Out-of-range entities are clamped, never thrown on.
  eq(entitiesToMarkdown('abc', [{ type: 'bold', offset: 2, length: 99 }]), 'ab**c**', 'an over-long entity is clamped to the text');
  eq(entitiesToMarkdown('abc', [{ type: 'bold', offset: 9, length: 2 }]), 'abc', 'an out-of-range entity is dropped');
  eq(entitiesToMarkdown('abc', [{ type: 'bold', offset: 1, length: 0 }]), 'abc', 'a zero-length entity is dropped');
}

console.log('\n=== outbound: MarkdownV2 escaping ===');
{
  eq(escapeMarkdownV2('a.b'), 'a\\.b', 'the dot — the character that fails a whole send — is escaped');
  eq(escapeMarkdownV2('1-2!'), '1\\-2\\!', 'hyphen and bang are escaped');
  eq(
    escapeMarkdownV2('_*[]()~`>#+-=|{}.!'),
    '\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!',
    'every one of the 18 reserved characters is escaped',
  );
  eq(escapeMarkdownV2('🎉 ok'), '🎉 ok', 'emoji pass through untouched');

  eq(toMarkdownV2('Done. Next: a-b!'), 'Done\\. Next: a\\-b\\!', 'plain agent text is escaped, not styled');
  eq(toMarkdownV2('**bold**'), '*bold*', '**bold** becomes MarkdownV2 *bold*');
  eq(toMarkdownV2('_it_'), '_it_', '_italic_ stays italic');
  eq(toMarkdownV2('*it*'), '_it_', 'single-asterisk italic maps to MarkdownV2 italic');
  eq(toMarkdownV2('__u__'), '__u__', 'underline');
  eq(toMarkdownV2('~~s~~'), '~s~', 'strikethrough collapses to the single tilde MarkdownV2 uses');
  eq(toMarkdownV2('||sp||'), '||sp||', 'spoiler');
  eq(toMarkdownV2('`a.b`'), '`a.b`', 'inside code only ` and \\ are special — the dot stays literal');
  eq(toMarkdownV2('a `b` c.'), 'a `b` c\\.', 'code span with escaped text around it');
  eq(toMarkdownV2('```py\nx = 1.0\n```'), '```py\nx = 1.0\n```', 'fenced block keeps its language and body verbatim');
  eq(toMarkdownV2('[t.x](https://a.b/c)'), '[t\\.x](https://a.b/c)', 'link label is escaped, url is not');
  eq(toMarkdownV2('> quoted.'), '>quoted\\.', 'blockquote');
  eq(toMarkdownV2('**b. and _i_**'), '*b\\. and _i_*', 'nested emphasis, text leaves escaped individually');
  eq(toMarkdownV2('\\*literal\\*'), '\\*literal\\*', 'a backslash-escaped marker stays literal');

  // The regression that matters most for a code-adjacent agent: identifiers.
  eq(toMarkdownV2('foo_bar_baz'), 'foo\\_bar\\_baz', 'snake_case is NOT italicised (intraword _ stays literal)');
  eq(toMarkdownV2('2*3*4'), '2\\*3\\*4', 'arithmetic is NOT italicised (intraword * stays literal)');
  eq(toMarkdownV2('a _ b'), 'a \\_ b', 'a lone marker followed by space is literal');
  eq(toMarkdownV2('_unclosed'), '\\_unclosed', 'an unclosed marker is literal');
}

console.log('\n=== outbound: length limit counted AFTER escaping ===');
{
  // 3000 dots escape to 6000 characters: measured on the source it "fits", on the
  // rendered text it does not. Splitting must happen on the rendered length.
  const dots = '.'.repeat(3000);
  assert(dots.length < TELEGRAM_TEXT_LIMIT, 'the source is under the limit');
  assert(escapeMarkdownV2(dots).length > TELEGRAM_TEXT_LIMIT, 'the ESCAPED form is over the limit');
  const pieces = splitForMarkdownV2(dots);
  assert(pieces.length > 1, 'a source that only overflows once escaped is still split');
  assert(pieces.every((p) => toMarkdownV2(p).length <= TELEGRAM_TEXT_LIMIT), 'every piece fits once rendered');
  eq(pieces.join(''), dots, 'the split loses nothing (pieces rejoin to the source)');

  const short = 'fits fine.';
  eq(splitForMarkdownV2(short).length, 1, 'a short message is one piece');

  // A piece must never end on a dangling backslash — that alone fails the parse.
  assert(pieces.every((p) => !/\\$/.test(toMarkdownV2(p))), 'no rendered piece ends on a dangling escape');

  // A long formatted message: splitting must keep every piece parseable and lose
  // nothing, even when the split lands inside an emphasis run.
  const long = `${'word. '.repeat(900)}**emphasised tail.**`;
  const longPieces = splitForMarkdownV2(long);
  assert(longPieces.length > 1, 'a long formatted message is split');
  assert(longPieces.every((p) => toMarkdownV2(p).length <= TELEGRAM_TEXT_LIMIT), 'every formatted piece fits');
  eq(longPieces.join(''), long, 'the formatted split is lossless');
}

console.log('\n=== the mandatory fallback trigger ===');
{
  assert(isParseEntitiesError(new Error("Bad Request: can't parse entities: unexpected end")), "Telegram's \"can't parse entities\" is recognised");
  assert(isParseEntitiesError('sendMessage failed (HTTP 400): {"description":"Bad Request: can\'t parse entities"}'), 'recognised inside the raw body we throw');
  assert(isParseEntitiesError(new Error('Too Many Requests')) === false, 'an unrelated 4xx is NOT treated as a markup failure');
}

console.log('\n=== telegram.ts wiring: message text arrives as Markdown ===');
{
  eq(
    messageMarkdown({ text: 'hello world', entities: [{ type: 'bold', offset: 0, length: 5 }] }),
    '**hello** world',
    'message entities are folded at the parse boundary',
  );
  eq(
    messageMarkdown({ caption: 'a photo', caption_entities: [{ type: 'italic', offset: 2, length: 5 }] }),
    'a _photo_',
    'caption_entities are honoured for media messages',
  );
  eq(messageMarkdown({ text: 'x_y' }), 'x_y', 'text with no entities is byte-for-byte unchanged');
  eq(messageMarkdown({}), '', 'an empty message stays empty');

  const r = parseReply({ reply_to_message: { message_id: 7, text: 'quoted bit', entities: [{ type: 'code', offset: 0, length: 6 }] } });
  eq(r.message_id, 7, 'reply_to keeps the message_id');
  eq(r.text, '`quoted` bit', 'the replied-to snapshot keeps its own formatting');
}

console.log('\n=== acceptance: Telegram → agent → Telegram round-trip ===');
{
  // Each cell is one supported formatting kind: it goes in as Telegram
  // entities, is read by the agent as Markdown, and comes back out as the
  // MarkdownV2 that reproduces the SAME formatting. Nothing may be lost.
  const cells = [
    ['bold', 'bold text', [{ type: 'bold', offset: 0, length: 4 }], '**bold** text', '*bold* text'],
    ['italic', 'italic text', [{ type: 'italic', offset: 0, length: 6 }], '_italic_ text', '_italic_ text'],
    ['strikethrough', 'gone text', [{ type: 'strikethrough', offset: 0, length: 4 }], '~~gone~~ text', '~gone~ text'],
    ['spoiler', 'shh text', [{ type: 'spoiler', offset: 0, length: 3 }], '||shh|| text', '||shh|| text'],
    ['inline code', 'run a.b() now', [{ type: 'code', offset: 4, length: 5 }], 'run `a.b()` now', 'run `a.b()` now'],
    ['pre with language', 'x = 1.0', [{ type: 'pre', offset: 0, length: 7, language: 'py' }], '```py\nx = 1.0\n```', '```py\nx = 1.0\n```'],
    ['blockquote', 'said this', [{ type: 'blockquote', offset: 0, length: 9 }], '> said this', '>said this'],
    ['text_link', 'docs here', [{ type: 'text_link', offset: 0, length: 4, url: 'https://ours.network/x.y' }], '[docs](https://ours.network/x.y) here', '[docs](https://ours.network/x.y) here'],
    ['underline', 'under text', [{ type: 'underline', offset: 0, length: 5 }], '__under__ text', '__under__ text'],
  ];
  for (const [name, text, ents, markdown, mdv2] of cells) {
    const asAgentSees = entitiesToMarkdown(text, ents);
    eq(asAgentSees, markdown, `${name}: Telegram → agent Markdown`);
    eq(toMarkdownV2(asAgentSees), mdv2, `${name}: agent Markdown → Telegram MarkdownV2`);
  }

  // Reserved punctuation and a non-BMP emoji survive the outbound leg intact.
  const hairy = 'Ready. Step-1! 100% 🎉 (see notes)';
  const rendered = toMarkdownV2(hairy);
  eq(rendered, 'Ready\\. Step\\-1\\! 100% 🎉 \\(see notes\\)', 'dots, hyphens, bangs and parens escaped; emoji untouched');
  eq(rendered.replace(/\\(.)/g, '$1'), hairy, 'un-escaping the rendered text returns the original exactly');
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
