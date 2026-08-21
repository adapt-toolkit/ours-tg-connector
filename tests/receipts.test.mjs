#!/usr/bin/env node
// Unit tests for the receipt/reaction layer: the emoji allowlist, the MONOTONIC
// (peer, wire_id) rule, the per-connection commands, the persisted wire_id ⇄
// Telegram message map with its retention, and the TelegramClient calls the
// feature adds (reply_parameters, setMessageReaction, the markdown fallback).
//
// No real network or daemon; durable-history receipt catch-up has its own focused test.
//
// Run: node_modules/.bin/tsx tests/receipts.test.mjs

import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from 'undici';

import {
  ALLOWED_REACTIONS,
  canonicalReaction,
  normalizeEmoji,
  isReceiptUpgrade,
  receiptRank,
  emojiFor,
  defaultSettings,
  normalizeSettings,
  parseReceiptCommand,
  formatStatus,
  formatHelp,
  CONNECTOR_COMMANDS,
  telegramCommandList,
  DEFAULT_EMOJI_DELIVERED,
  DEFAULT_EMOJI_READ,
} from '../src/receipts.ts';
import { MessageMap, pruneRows, parseMapFile, MAX_ROWS, RETENTION_DAYS } from '../src/msgmap.ts';
import { TelegramClient, DEFAULT_NET_OPTIONS } from '../src/telegram.ts';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  assert(actual === expected, `${msg}${actual === expected ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

console.log('=== Telegram reaction allowlist (validated BEFORE saving) ===');
{
  eq(canonicalReaction('👀'), '👀', 'the delivered default is an allowed reaction');
  eq(canonicalReaction('👌'), '👌', 'the read default is an allowed reaction');
  eq(canonicalReaction('❤️'), '❤', 'a typed variation selector is normalised to the listed spelling');
  eq(normalizeEmoji('❤️'), '❤', 'normalizeEmoji strips U+FE0F');
  eq(canonicalReaction(' 🔥 '), '🔥', 'surrounding whitespace is trimmed');
  eq(canonicalReaction('🥑'), null, 'an emoji Telegram does not allow is rejected');
  eq(canonicalReaction('not an emoji'), null, 'arbitrary text is rejected');
  eq(canonicalReaction(''), null, 'empty input is rejected');

  // The spec's proposed read default is NOT on Telegram's bot list — the reason
  // the connector ships 👌 instead. Pinned here so the substitution is visible.
  eq(canonicalReaction('✅'), null, "✅ is NOT an allowed bot reaction (why the read default is 👌, not ✅)");
  eq(DEFAULT_EMOJI_DELIVERED, '👀', 'delivered default is the spec\'s 👀');
  assert(ALLOWED_REACTIONS.includes(DEFAULT_EMOJI_READ), 'the shipped read default is on the allowlist');
}

console.log('\n=== monotonic (peer, wire_id): unknown < sent < delivered < read ===');
{
  assert(receiptRank('unknown') < receiptRank('sent'), 'sent outranks unknown');
  assert(receiptRank('sent') < receiptRank('delivered'), 'delivered outranks sent');
  assert(receiptRank('delivered') < receiptRank('read'), 'read outranks delivered');

  assert(isReceiptUpgrade('sent', 'delivered'), 'sent → delivered is an upgrade');
  assert(isReceiptUpgrade('delivered', 'read'), 'delivered → read is an upgrade');
  assert(isReceiptUpgrade('delivered', 'delivered') === false, 'a DUPLICATE delivered is a no-op');
  assert(isReceiptUpgrade('read', 'delivered') === false, 'an OUT-OF-ORDER delivered after read never rolls back');
  assert(isReceiptUpgrade('read', 'read') === false, 'a duplicate read is a no-op');

  const s = defaultSettings('now');
  eq(emojiFor('delivered', s), '👀', 'delivered maps to its emoji');
  eq(emojiFor('read', s), DEFAULT_EMOJI_READ, 'read maps to its emoji');
  eq(emojiFor('sent', s), null, "'sent' is our own bookkeeping — no reaction");
}

console.log('\n=== per-connection commands (parsed in code, never in a prompt) ===');
{
  eq(parseReceiptCommand('hello there'), null, 'an ordinary message is not a command');
  eq(parseReceiptCommand('/id'), null, 'the /id probe is not ours');

  assert(parseReceiptCommand('/receipts on').kind === 'receipts' && parseReceiptCommand('/receipts on').on === true, '/receipts on');
  assert(parseReceiptCommand('/receipts off').on === false, '/receipts off');
  eq(parseReceiptCommand('/receipts status').kind, 'status', '/receipts status');
  eq(parseReceiptCommand('/receipts').kind, 'status', 'bare /receipts reports status');
  eq(parseReceiptCommand('/receipts maybe').kind, 'error', 'an unknown argument is an error, not a silent default');

  const d = parseReceiptCommand('/emoji delivered 🔥');
  assert(d.kind === 'emoji' && d.slot === 'delivered' && d.emoji === '🔥', '/emoji delivered <emoji>');
  const r = parseReceiptCommand('/emoji read 💯');
  assert(r.kind === 'emoji' && r.slot === 'read' && r.emoji === '💯', '/emoji read <emoji>');
  eq(parseReceiptCommand('/emoji reset').kind, 'reset', '/emoji reset');

  const bad = parseReceiptCommand('/emoji read 🥑');
  eq(bad.kind, 'error', 'an invalid emoji is refused BEFORE saving');
  assert(bad.message.includes('🥑'), 'the error names the rejected input');
  assert(bad.message.includes('👀') && bad.message.includes('👌'), 'the error lists the valid emoji');
  eq(parseReceiptCommand('/emoji read').kind, 'error', 'a missing emoji argument is an error');
  eq(parseReceiptCommand('/emoji sideways 🔥').kind, 'error', 'an unknown slot is an error');

  // Multi-bot groups: Telegram delivers /cmd@thebot.
  eq(parseReceiptCommand('/receipts@mybot on', 'mybot').kind, 'receipts', 'a command addressed to this bot is handled');
  eq(parseReceiptCommand('/receipts@otherbot on', 'mybot'), null, 'a command addressed to ANOTHER bot is ignored');
  eq(parseReceiptCommand('/RECEIPTS ON').kind, 'receipts', 'commands are case-insensitive');

  const status = formatStatus(defaultSettings('now'), 'my-route', true);
  assert(status.includes('my-route') && status.includes('on') && status.includes('👀'), 'status names the connection and its settings');
  assert(formatStatus(defaultSettings('now'), 'r', false).includes('no agent connected yet'), 'status says so when no agent is paired');
}

console.log('\n=== /help: handled locally, and NOT a text-swallower ===');
{
  eq(parseReceiptCommand('/help').kind, 'help', 'bare /help is the connector\'s own command');
  eq(parseReceiptCommand('/HELP').kind, 'help', '/help is case-insensitive like the rest');
  eq(parseReceiptCommand('  /help  ').kind, 'help', 'surrounding whitespace does not hide the command');
  eq(parseReceiptCommand('/help@mybot', 'mybot').kind, 'help', '/help@thisbot is handled in a multi-bot group');
  eq(parseReceiptCommand('/help@otherbot', 'mybot'), null, '/help@otherbot belongs to the other bot');

  // THE GUARD RAIL: /help must not start eating messages meant for the agent.
  eq(parseReceiptCommand('/help me write the release note'), null, '/help WITH ARGS is a message for the agent, not a command');
  eq(parseReceiptCommand('/help me'), null, 'even a single trailing word falls through to the agent');
  eq(parseReceiptCommand('/helpme'), null, '/helpme is not /help');
  eq(parseReceiptCommand('/help_desk'), null, 'a longer slash word starting with help is not ours');
  eq(parseReceiptCommand('please /help'), null, '/help must be the first token, as Telegram delivers commands');
  eq(parseReceiptCommand('/start'), null, 'a slash word the connector does not own is relayed unchanged');
  eq(parseReceiptCommand('/deploy prod'), null, 'an arbitrary slash command is relayed unchanged');

  // The reply: the command list, then the live settings for this connection.
  const help = formatHelp(defaultSettings('now'), 'my-route', true);
  for (const c of CONNECTOR_COMMANDS) assert(help.includes(`/${c.command}`), `/help lists /${c.command}`);
  assert(help.includes('my-route') && help.includes('👀') && help.includes('👌'), '/help reports the current receipt settings');
  assert(help.includes('relayed to the agent'), '/help says plainly that everything else goes to the agent');
  assert(!help.includes('*') && !help.includes('_'), '/help is plain text — no markdown that could fail its own send');

  // No route yet: the command list still answers, without inventing settings.
  const noRoute = formatHelp(null, '', false);
  assert(noRoute.includes('/id') && noRoute.includes('no route yet'), '/help in an unrouted chat lists commands and says there is no route');
  assert(!noRoute.includes('delivery/read reactions'), 'and does not report settings it does not have');
}

console.log('\n=== the slash-menu command list ===');
{
  assert(CONNECTOR_COMMANDS.length > 0, 'there is a command list to register');
  for (const c of CONNECTOR_COMMANDS) {
    assert(/^[a-z0-9_]{1,32}$/.test(c.command), `"${c.command}" satisfies Telegram's command-name rule (no slash, 1-32 [a-z0-9_])`);
    assert(c.description.length > 0 && c.description.length <= 256, `"${c.command}" has a description within Telegram's 256-char limit`);
  }
  // Every registered command must actually be intercepted somewhere, or the menu
  // advertises a command that falls through to the agent as text.
  for (const c of CONNECTOR_COMMANDS) {
    const parsed = parseReceiptCommand(`/${c.command}`);
    const isIdProbe = c.command === 'id'; // parsed in routing.ts, before route resolution
    assert(parsed !== null || isIdProbe, `/${c.command} is claimed by the connector, not relayed`);
  }
  const list = telegramCommandList();
  eq(list.length, CONNECTOR_COMMANDS.length, 'the registration list covers every command');
  assert(list.every((c) => Object.keys(c).sort().join(',') === 'command,description'), 'setMyCommands gets exactly {command, description}');
}

console.log('\n=== settings normalisation (hand-edited / stale file) ===');
{
  const s = normalizeSettings({ receiptsEnabled: false, emojiDelivered: '🥑', emojiRead: '❤️' }, 'now');
  eq(s.receiptsEnabled, false, 'an explicit off is preserved');
  eq(s.emojiDelivered, '👀', 'an emoji Telegram no longer allows falls back to the default');
  eq(s.emojiRead, '❤', 'a variation-selector spelling is normalised');
  eq(normalizeSettings(null, 'now').receiptsEnabled, true, 'a missing record defaults to receipts on');
  eq(normalizeSettings('garbage', 'now').emojiRead, DEFAULT_EMOJI_READ, 'a garbage record falls back wholesale');
}

console.log('\n=== the message map: retention, validation, monotonic apply ===');
{
  const now = Date.UTC(2026, 7, 20);
  const day = 86_400_000;
  const rows = {
    fresh: { chatId: '-100', messageId: 5, contactCid: 'c', direction: 'inbound', receiptState: 'sent', createdAt: new Date(now - day).toISOString() },
    stale: { chatId: '-100', messageId: 6, contactCid: 'c', direction: 'inbound', receiptState: 'sent', createdAt: new Date(now - (RETENTION_DAYS + 1) * day).toISOString() },
    bogus: { chatId: '-100', messageId: 7, contactCid: 'c', direction: 'inbound', receiptState: 'sent', createdAt: 'not a date' },
  };
  const removed = pruneRows(rows, now);
  eq(removed, 2, 'the over-horizon and undated rows are pruned');
  assert(rows.fresh && !rows.stale && !rows.bogus, `only the fresh row survives ${RETENTION_DAYS}-day retention`);

  // The cap: oldest first.
  const many = {};
  for (let i = 0; i < MAX_ROWS + 5; i += 1) {
    many[`w${i}`] = { chatId: '1', messageId: i + 1, contactCid: 'c', direction: 'inbound', receiptState: 'sent', createdAt: new Date(now - (MAX_ROWS + 5 - i) * 1000).toISOString() };
  }
  eq(pruneRows(many, now), 5, 'the row cap drops exactly the overflow');
  eq(Object.keys(many).length, MAX_ROWS, 'the cap is respected');
  assert(many[`w${MAX_ROWS + 4}`] !== undefined && many.w0 === undefined, 'the OLDEST rows are the ones dropped');

  // A corrupt/hostile file must not be able to make us react on a garbage target.
  const parsed = parseMapFile(JSON.stringify({
    v: 1,
    messages: {
      ok: { chatId: '-100', messageId: 9, contactCid: 'c', direction: 'inbound', receiptState: 'read', createdAt: new Date(now).toISOString() },
      noChat: { messageId: 9, direction: 'inbound', receiptState: 'sent', createdAt: new Date(now).toISOString() },
      badId: { chatId: '-100', messageId: -3, direction: 'inbound', receiptState: 'sent', createdAt: new Date(now).toISOString() },
      floatId: { chatId: '-100', messageId: 1.5, direction: 'inbound', receiptState: 'sent', createdAt: new Date(now).toISOString() },
    },
    settings: { cid1: { receiptsEnabled: false } },
  }), now);
  eq(Object.keys(parsed.messages).length, 1, 'rows with no chat id / a non-positive / non-integer message id are dropped');
  eq(parsed.messages.ok.receiptState, 'read', 'a valid row keeps its receipt state');
  eq(parsed.settings.cid1.receiptsEnabled, false, 'settings survive the round trip');
  eq(Object.keys(parseMapFile('{not json', now).messages).length, 0, 'an unparseable file starts clean instead of throwing');
}

console.log('\n=== the message map: persistence across a restart ===');
{
  const dir = fs.mkdtempSync(join(tmpdir(), 'tgmap-'));
  try {
    const m1 = new MessageMap(dir);
    m1.record('wire-A', { chatId: '-1001', messageId: 42, contactCid: 'peer1', direction: 'inbound' });
    eq(m1.get('wire-A').messageId, 42, 'a recorded wire_id resolves to its Telegram message');
    eq(m1.get('nope'), undefined, 'an unmapped wire_id resolves to nothing (never a "similar" message)');
    eq(m1.get(''), undefined, 'an empty wire_id resolves to nothing');

    // Monotonic application, through the persisted row.
    eq(m1.applyReceipt('wire-A', 'delivered').messageId, 42, 'delivered is applied and names its message');
    eq(m1.applyReceipt('wire-A', 'delivered'), null, 'a duplicate delivered is a no-op (no second reaction)');
    eq(m1.applyReceipt('wire-A', 'read').messageId, 42, 'read is applied over delivered');
    eq(m1.applyReceipt('wire-A', 'delivered'), null, 'an out-of-order delivered after read is a no-op');
    eq(m1.applyReceipt('unknown-wire', 'read'), null, 'a receipt for an unknown wire_id is a no-op');

    m1.updateSettings('peer1', { receiptsEnabled: false });
    m1.updateSettings('peer2', { emojiRead: '🔥' });

    // Restart: a fresh instance over the same dir.
    const m2 = new MessageMap(dir);
    eq(m2.get('wire-A').messageId, 42, 'the wire_id → message mapping survives a daemon restart');
    eq(m2.get('wire-A').receiptState, 'read', 'the receipt state survives too (no reaction is re-sent)');
    eq(m2.settingsFor('peer1').receiptsEnabled, false, '/receipts off survives a restart');
    eq(m2.settingsFor('peer2').receiptsEnabled, true, 'per-contact scoping: peer2 is unaffected by peer1');
    eq(m2.settingsFor('peer2').emojiRead, '🔥', 'peer2 keeps its own emoji');
    eq(m2.settingsFor('never-seen').emojiRead, DEFAULT_EMOJI_READ, 'an unknown contact gets defaults');

    // /emoji reset restores the emoji pair but must not re-enable receipts.
    m2.updateSettings('peer3', { receiptsEnabled: false, emojiDelivered: '🔥' });
    const reset = m2.resetSettings('peer3');
    eq(reset.emojiDelivered, '👀', '/emoji reset restores the default emoji');
    eq(reset.receiptsEnabled, false, '/emoji reset does NOT silently turn receipts back on');

    // Re-recording an existing wire_id must not reset an already-applied receipt.
    m2.record('wire-A', { chatId: '-1001', messageId: 42, contactCid: 'peer1', direction: 'inbound' });
    eq(m2.get('wire-A').receiptState, 'read', 're-recording a wire_id keeps its receipt state (idempotent)');

    // A receipt only ever confirms a message WE sent over ours — an inbound row.
    // An outbound row (the agent's own message, delivered to Telegram) must never
    // pick up a reaction.
    m2.record('wire-OUT', { chatId: '-1001', messageId: 99, contactCid: 'peer1', direction: 'outbound' });
    eq(m2.applyReceipt('wire-OUT', 'delivered'), null, 'an outbound row is never confirmed by a receipt');

    // Settings set BEFORE an agent exists (no contact id) must still apply once
    // it connects — otherwise /receipts off silently un-does itself on pairing.
    const m3 = new MessageMap(dir);
    m3.updateSettings('', { receiptsEnabled: false, emojiDelivered: '🔥' });
    eq(m3.settingsFor('brand-new-peer').receiptsEnabled, false, 'a pre-pairing /receipts off still applies to the agent that connects');
    eq(m3.settingsFor('brand-new-peer').emojiDelivered, '🔥', 'a pre-pairing emoji choice carries over');
    m3.updateSettings('brand-new-peer', { receiptsEnabled: true });
    eq(m3.settingsFor('brand-new-peer').receiptsEnabled, true, 'an explicit per-contact setting overrides the route-wide one');
    eq(m3.settingsFor('another-peer').receiptsEnabled, false, 'and does not leak to a different contact');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n=== TelegramClient: reply_parameters, reactions, markdown fallback ===');
{
  const calls = [];
  const client = (handler) => new TelegramClient('123:tok', 30, () => {}, DEFAULT_NET_OPTIONS, async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ url, body, dispatcher: init?.dispatcher });
    return handler(url, body);
  });

  // A reply carries reply_parameters.message_id and returns the new message id.
  let c = client(() => jsonResponse({ ok: true, result: { message_id: 777 } }));
  const ids = await c.sendMessage(-1001, 'answering that.', undefined, { replyToMessageId: 42, markdown: true });
  eq(calls[0].body.reply_parameters.message_id, 42, 'a reply is sent with reply_parameters.message_id');
  eq(calls[0].body.reply_parameters.allow_sending_without_reply, true, 'a deleted target degrades to an unthreaded send, not a failure');
  eq(calls[0].body.parse_mode, 'MarkdownV2', 'markdown mode sets parse_mode');
  eq(calls[0].body.text, 'answering that\\.', 'the text is escaped for MarkdownV2');
  eq(ids[0], 777, 'sendMessage returns the new message_id for the map');

  // No reply pointer => no reply_parameters at all.
  calls.length = 0;
  c = client(() => jsonResponse({ ok: true, result: { message_id: 1 } }));
  await c.sendMessage(-1001, 'plain', undefined, { markdown: true });
  eq(calls[0].body.reply_parameters, undefined, 'without a mapped message no reply parameter is invented');

  // THE MANDATORY FALLBACK: Telegram refuses the markup, we resend as plain text.
  calls.length = 0;
  let attempt = 0;
  c = client(() => {
    attempt += 1;
    if (attempt === 1) return jsonResponse({ ok: false, description: "Bad Request: can't parse entities: bad offset" }, 400);
    return jsonResponse({ ok: true, result: { message_id: 9 } });
  });
  const fbIds = await c.sendMessage(-1001, 'weird *markup', undefined, { markdown: true });
  eq(calls.length, 2, 'a markup refusal triggers exactly one retry');
  eq(calls[1].body.parse_mode, undefined, 'the retry carries NO parse_mode');
  eq(calls[1].body.text, 'weird *markup', 'the retry sends the SAME text, unescaped — the message is not lost');
  eq(fbIds[0], 9, 'the fallback send still reports its message id');

  // Any other failure is NOT swallowed by the fallback.
  calls.length = 0;
  c = client(() => jsonResponse({ ok: false, description: 'Forbidden: bot was blocked by the user' }, 403));
  let threw = false;
  try { await c.sendMessage(-1001, 'x', undefined, { markdown: true }); } catch { threw = true; }
  assert(threw && calls.length === 1, 'a non-markup failure is raised, not retried as plain text');

  // setMessageReaction: one reaction, replacing whatever was there.
  calls.length = 0;
  c = client(() => jsonResponse({ ok: true, result: true }));
  await c.setMessageReaction(-1001, 42, '👀');
  eq(calls[0].url.endsWith('/setMessageReaction'), true, 'setMessageReaction is the API method used');
  eq(calls[0].body.reaction.length, 1, 'exactly ONE reaction is sent (a bot cannot hold two)');
  eq(calls[0].body.reaction[0].emoji, '👀', 'the configured emoji is sent');
  eq(calls[0].body.reaction[0].type, 'emoji', 'the reaction type is "emoji"');
  eq(calls[0].body.message_id, 42, 'the reaction targets the mapped message');
  assert(calls[0].dispatcher instanceof Agent, 'the reaction call rides the IPv4-forced dispatcher too');

  calls.length = 0;
  await c.setMessageReaction(-1001, 42, null);
  eq(calls[0].body.reaction.length, 0, 'a null emoji clears the reaction');

  // A refusal must surface to the caller (which logs it and carries on).
  c = client(() => jsonResponse({ ok: false, description: 'Bad Request: REACTIONS_NOT_ALLOWED' }, 400));
  let reactThrew = false;
  try { await c.setMessageReaction(-1001, 42, '👀'); } catch (e) { reactThrew = /REACTIONS_NOT_ALLOWED/.test(String(e)); }
  assert(reactThrew, 'a Telegram reaction refusal is raised with its full text for the caller to log');

  // setMyCommands: the slash menu, registered at DEFAULT scope.
  calls.length = 0;
  c = client(() => jsonResponse({ ok: true, result: true }));
  await c.setMyCommands(telegramCommandList());
  eq(calls[0].url.endsWith('/setMyCommands'), true, 'setMyCommands is the API method used');
  eq(calls[0].body.scope, undefined, 'NO scope field — the default scope covers every chat the bot serves');
  eq(calls[0].body.commands.length, CONNECTOR_COMMANDS.length, 'every connector command is registered');
  assert(calls[0].body.commands.every((x) => !x.command.startsWith('/')), 'commands are registered without the leading slash');
  assert(calls[0].dispatcher instanceof Agent, 'the registration call rides the IPv4-forced dispatcher too');

  // A refusal must surface (the caller logs it and keeps polling).
  c = client(() => jsonResponse({ ok: false, description: 'Bad Request: BOT_COMMAND_INVALID' }, 400));
  let cmdThrew = false;
  try { await c.setMyCommands([{ command: 'Bad Cmd', description: 'x' }]); } catch (e) { cmdThrew = /BOT_COMMAND_INVALID/.test(String(e)); }
  assert(cmdThrew, 'a rejected command list is raised, not silently reported as registered');

  // …including the 200-with-ok:false shape.
  c = client(() => jsonResponse({ ok: false, description: 'nope' }, 200));
  let softThrew = false;
  try { await c.setMyCommands(telegramCommandList()); } catch (e) { softThrew = /nope/.test(String(e)); }
  assert(softThrew, 'an HTTP 200 carrying ok:false is still treated as a failure');
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
