#!/usr/bin/env node
// Telegram widgets (src/widgets.ts + the widget methods of src/telegram.ts).
// Local fixtures only: a mocked Bot API (injected fetch), synthetic updates and
// the real SDK command dispatch over an injected daemon transport. Nothing here
// reaches Telegram or a daemon.
//
// Run: node_modules/.bin/tsx tests/widgets.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { OursClient } from '@ours.network/sdk';
import { TelegramClient, telegramErrorText } from '../src/telegram.ts';
import { drainMessages } from '../src/history-delivery.ts';
import {
  WidgetStore, widgetCommands, handleWidgetQuery, htmlProblem, compressedSize, widgetEligible,
  sendWidgetCommand, updateWidgetCommand, MAX_WIDGETS, ACCEPTED_ANSWER, REFUSED_ANSWER, QUERY_NOTE,
  SEND_COMMAND, UPDATE_COMMAND,
} from '../src/widgets.ts';

const TOKEN = '123456:FAKE-token_for_tests_only_000000';
const AGENT_A = 'A'.repeat(64);
const AGENT_B = 'B'.repeat(64);
const STRANGER = 'C'.repeat(64);
const CHAT_A = '1111';
const CHAT_B = '2222';
const tmpDirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'tg-widgets-')); tmpDirs.push(d); return d; };
const ctx = (cid, wire = 'req-wire') => Object.freeze({ sender_cid: cid, sender_name: 'label', request_wire_id: wire });
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const HTML = readFileSync(new URL('../examples/widget-choice.html', import.meta.url), 'utf8');

// A mocked Bot API. `script[method]` is a queue of responses (or a function);
// every call's method and parsed JSON body is recorded.
function mockTelegram(script = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = url.split('/').pop();
    assert.ok(url.startsWith(`https://api.telegram.org/bot${TOKEN}/`), 'Bot API URL');
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ method, body });
    const q = script[method];
    const next = typeof q === 'function' ? q(body) : Array.isArray(q) && q.length ? q.shift() : null;
    if (next instanceof Error) throw next;
    if (next) return next;
    if (method === 'sendWidget') return json({ ok: true, result: { message_id: 500 + calls.length, chat: { id: body.chat_id } } });
    return json({ ok: true, result: true });
  };
  const tg = new TelegramClient(TOKEN, 1, () => {}, { retries: 1, retryBaseMs: 1 }, fetchImpl);
  return { tg, calls, of: (m) => calls.filter((c) => c.method === m) };
}

function routeDeps({ chatId = CHAT_A, threadId = '', peerCid = AGENT_A, tg, dir = tmp(), name = 'route-a' } = {}) {
  const view = { name, chatId, threadId, peerCid };
  return { view, deps: { route: () => ({ ...view }), tg, store: new WidgetStore(dir, () => {}), log: () => {} }, dir };
}

const query = (over = {}) => ({
  update_id: 1, id: `q-${randomBytes(4).toString('hex')}`, from_id: Number(CHAT_A), from: 'Alice',
  chat_id: Number(CHAT_A), chat_type: 'private', message_id: 0, inline: false, shared: false,
  queryType: 'data', data: 'pick:0', ...over,
});

let n = 0;
async function test(name, fn) {
  n += 1;
  await fn();
  console.log(`  ✓ ${name}`);
}

try {
  console.log('=== HTML and state limits (local pre-checks) ===');
  await test('the example widget passes raw and compressed limits', () => {
    assert.equal(htmlProblem(HTML), null);
    assert.ok(compressedSize(HTML) < 4096);
  });
  await test('empty, NUL and lone-surrogate HTML is refused', () => {
    assert.match(htmlProblem(''), /empty/);
    assert.match(htmlProblem('<b>a\0b</b>'), /NUL/);
    assert.match(htmlProblem('<b>\uD800</b>'), /lone surrogate/);
    assert.equal(htmlProblem('<b>😀</b>'), null, 'a surrogate pair is fine');
  });
  await test('over 32768 UTF-8 bytes is refused even if it compresses well', () => {
    const big = 'é'.repeat(16385); // 32770 bytes, compresses to a few dozen
    assert.match(htmlProblem(big), /32770 UTF-8 bytes/);
  });
  await test('under 32 KB but over 4096 compressed bytes is refused', () => {
    const noisy = `<p>${randomBytes(6000).toString('base64')}</p>`;
    assert.ok(Buffer.byteLength(noisy) < 32768);
    assert.match(htmlProblem(noisy), /compresses to \d+ bytes/);
  });
  await test('eligibility: positive private chat only, no topic, no catch-all, no group', () => {
    assert.equal(widgetEligible('1111', ''), true);
    assert.equal(widgetEligible('-1001234', ''), false);
    assert.equal(widgetEligible('1111', '7'), false);
    assert.equal(widgetEligible('0', ''), false);
    assert.equal(widgetEligible('', ''), false);
  });

  console.log('=== Bot API serialization and outcomes (mocked fetch) ===');
  await test('sendWidget body: allow_queries, never is_shared, exactly the given fields', async () => {
    const t = mockTelegram();
    const { deps } = routeDeps({ tg: t.tg });
    const r = await sendWidgetCommand(deps, { request_id: 'r1', html: HTML, chat_data: '{"n":0}', caption: 'Choose' }, ctx(AGENT_A));
    assert.equal(r.status, 'sent');
    assert.match(r.widget_ref, /^w_[A-Za-z0-9_-]{12}$/);
    const [call] = t.of('sendWidget');
    assert.deepEqual(call.body, { chat_id: 1111, html: HTML, chat_data: '{"n":0}', caption: 'Choose', allow_queries: true });
    assert.equal(r.message_id, call && 501);
  });
  await test('a transport failure is unknown and is NOT retried', async () => {
    const err = new TypeError('fetch failed'); err.cause = { code: 'ECONNRESET' };
    const t = mockTelegram({ sendWidget: [err, err] });
    const { deps } = routeDeps({ tg: t.tg });
    const r = await sendWidgetCommand(deps, { request_id: 'r1', html: HTML }, ctx(AGENT_A));
    assert.equal(r.status, 'unknown');
    assert.equal(t.of('sendWidget').length, 1, 'one request only');
    const again = await sendWidgetCommand(deps, { request_id: 'r1', html: HTML }, ctx(AGENT_A));
    assert.equal(again.status, 'unknown');
    assert.equal(again.duplicate, true);
    assert.equal(t.of('sendWidget').length, 1, 'a repeated request_id is never re-sent');
  });
  await test('HTTP 502 / unparseable reply is unknown; a 4xx refusal is rejected with a sanitized description', async () => {
    const t = mockTelegram({ sendWidget: [
      new Response('<html>bad gateway</html>', { status: 502 }),
      json({ ok: false, error_code: 400, description: `Bad Request: INPUT_MEDIA_WIDGET_TOO_LARGE bot${TOKEN}/sendWidget` }, 400),
    ] });
    const { deps } = routeDeps({ tg: t.tg });
    assert.equal((await sendWidgetCommand(deps, { request_id: 'a', html: HTML }, ctx(AGENT_A))).status, 'unknown');
    const r = await sendWidgetCommand(deps, { request_id: 'b', html: HTML }, ctx(AGENT_A));
    assert.equal(r.status, 'rejected');
    assert.equal(r.code, 'telegram_refused');
    assert.equal(r.telegram_error_code, 400);
    assert.match(r.description, /INPUT_MEDIA_WIDGET_TOO_LARGE/);
    assert.ok(!r.description.includes(TOKEN.split(':')[1]), 'token redacted');
    assert.ok(!JSON.stringify(r).includes('<script'), 'HTML never echoed');
  });
  await test('telegramErrorText bounds and redacts', () => {
    const s = telegramErrorText(`x ${TOKEN} ${'y'.repeat(500)}`);
    assert.ok(s.length <= 200);
    assert.ok(!s.includes('FAKE-token'));
  });
  await test('editMessageWidgetData: not-modified is updated/unchanged; 5xx/transport is unknown; 4xx rejected', async () => {
    const t = mockTelegram({ editMessageWidgetData: [
      json({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }, 400),
      json({ ok: false, error_code: 500, description: 'Internal Server Error' }, 500),
      json({ ok: false, error_code: 400, description: 'Bad Request: WIDGET_DATA_INVALID' }, 400),
    ] });
    assert.deepEqual(await t.tg.editMessageWidgetData(1, 2, { chat_data: 'x' }), { status: 'updated', changed: false });
    assert.equal((await t.tg.editMessageWidgetData(1, 2, { chat_data: 'x' })).status, 'unknown');
    assert.equal((await t.tg.editMessageWidgetData(1, 2, { chat_data: 'x' })).status, 'rejected');
    assert.deepEqual(t.of('editMessageWidgetData')[0].body, { chat_id: 1, message_id: 2, chat_data: 'x' });
  });

  console.log('=== command authorization and validation ===');
  await test('only the route\'s connected agent may send; no Telegram call otherwise', async () => {
    const t = mockTelegram();
    const { deps } = routeDeps({ tg: t.tg });
    assert.equal((await sendWidgetCommand(deps, { request_id: 'r', html: HTML }, ctx(STRANGER))).code, 'not_authorized');
    const unbound = routeDeps({ tg: t.tg, peerCid: '' });
    assert.equal((await sendWidgetCommand(unbound.deps, { request_id: 'r', html: HTML }, ctx(AGENT_A))).code, 'not_authorized');
    for (const [chatId, threadId] of [['-100123', ''], ['1111', '9'], ['0', '']]) {
      const r = routeDeps({ tg: t.tg, chatId, threadId });
      assert.equal((await sendWidgetCommand(r.deps, { request_id: 'r', html: HTML }, ctx(AGENT_A))).code, 'unsupported_route');
    }
    assert.equal(t.calls.length, 0);
  });
  await test('target chat comes from the route, never from arguments', async () => {
    const t = mockTelegram();
    const { deps } = routeDeps({ tg: t.tg });
    const r = await sendWidgetCommand(deps, { request_id: 'r', html: HTML, chat_id: 999 }, ctx(AGENT_A));
    assert.equal(r.code, 'invalid_arguments');
    assert.equal(t.calls.length, 0);
  });
  await test('invalid html/state is refused before anything is recorded or sent', async () => {
    const t = mockTelegram();
    const { deps } = routeDeps({ tg: t.tg });
    assert.equal((await sendWidgetCommand(deps, { request_id: 'r', html: 'a\0' }, ctx(AGENT_A))).code, 'invalid_html');
    assert.equal((await sendWidgetCommand(deps, { request_id: 'r', html: HTML, chat_data: 'я'.repeat(513) }, ctx(AGENT_A))).code, 'invalid_state');
    assert.equal((await sendWidgetCommand(deps, { request_id: 'bad id!', html: HTML }, ctx(AGENT_A))).code, 'invalid_arguments');
    assert.equal(t.calls.length, 0);
    assert.equal(deps.store.byRequest(AGENT_A, 'r'), undefined);
  });
  await test('same request_id: same payload returns the stored outcome; different payload conflicts; neither re-sends', async () => {
    const t = mockTelegram();
    const { deps } = routeDeps({ tg: t.tg });
    const first = await sendWidgetCommand(deps, { request_id: 'r', html: HTML, chat_data: '1' }, ctx(AGENT_A));
    const dup = await sendWidgetCommand(deps, { chat_data: '1', html: HTML, request_id: 'r' }, ctx(AGENT_A));
    assert.equal(dup.duplicate, true);
    assert.equal(dup.widget_ref, first.widget_ref);
    assert.equal(dup.message_id, first.message_id);
    const conflict = await sendWidgetCommand(deps, { request_id: 'r', html: HTML, chat_data: '2' }, ctx(AGENT_A));
    assert.equal(conflict.code, 'request_id_conflict');
    assert.equal(conflict.original_status, 'sent');
    assert.equal(t.of('sendWidget').length, 1);
  });

  console.log('=== ledger persistence ===');
  await test('restart: records survive; an interrupted "sending" becomes unknown and is not re-sent', async () => {
    const t = mockTelegram();
    const { deps, dir } = routeDeps({ tg: t.tg });
    const sent = await sendWidgetCommand(deps, { request_id: 'done', html: HTML }, ctx(AGENT_A));
    deps.store.begin(AGENT_A, 'crash', 'h', CHAT_A); // persisted, then "the process dies"
    const reborn = routeDeps({ tg: t.tg, dir });
    assert.equal(reborn.deps.store.byRef(sent.widget_ref).messageId, sent.message_id);
    assert.equal(reborn.deps.store.byRequest(AGENT_A, 'crash').status, 'unknown');
    const disk = JSON.parse(readFileSync(join(dir, 'widgets.json'), 'utf8'));
    assert.equal(disk.widgets.find((w) => w.requestId === 'crash').status, 'unknown', 'the downgrade is persisted');
    const upd = await updateWidgetCommand(reborn.deps, { widget_ref: sent.widget_ref, chat_data: '{"n":1}' }, ctx(AGENT_A));
    assert.equal(upd.status, 'updated', 'a restored widget can still be updated');
    assert.equal(t.of('sendWidget').length, 1);
  });
  await test('a corrupt ledger fails closed: no send, no update, queries refused, file kept', async () => {
    const t = mockTelegram();
    const dir = tmp();
    writeFileSync(join(dir, 'widgets.json'), '{"v":1,"widgets":[{"ref":"nope"}],"queries":[]}');
    const { deps } = routeDeps({ tg: t.tg, dir });
    assert.ok(deps.store.broken);
    assert.equal((await sendWidgetCommand(deps, { request_id: 'r', html: HTML }, ctx(AGENT_A))).code, 'ledger_unavailable');
    assert.equal((await updateWidgetCommand(deps, { widget_ref: 'w_AAAAAAAAAAAA', chat_data: '1' }, ctx(AGENT_A))).code, 'ledger_unavailable');
    const out = await handleWidgetQuery(query({ message_id: 1 }), deps, t.tg, async () => assert.fail('forwarded'), () => {});
    assert.equal(out, 'refused');
    assert.deepEqual(t.of('answerWidgetQuery')[0].body, { widget_query_id: t.of('answerWidgetQuery')[0].body.widget_query_id, data: REFUSED_ANSWER });
    assert.equal(t.of('sendWidget').length, 0);
    assert.match(readFileSync(join(dir, 'widgets.json'), 'utf8'), /nope/, 'not overwritten');
  });
  await test('ledger at capacity refuses new sends but keeps old widgets working', async () => {
    const t = mockTelegram();
    const dir = tmp();
    const widgets = Array.from({ length: MAX_WIDGETS }, (_, i) => ({
      ref: `w_${String(i).padStart(12, '0')}`, requestId: `r${i}`, payloadHash: 'h', owner: AGENT_A,
      chatId: CHAT_A, messageId: i + 1, status: 'sent', createdAt: new Date().toISOString(),
    }));
    writeFileSync(join(dir, 'widgets.json'), JSON.stringify({ v: 1, widgets, queries: [] }));
    const { deps } = routeDeps({ tg: t.tg, dir });
    assert.equal((await sendWidgetCommand(deps, { request_id: 'new', html: HTML }, ctx(AGENT_A))).code, 'ledger_full');
    assert.equal((await sendWidgetCommand(deps, { request_id: 'r5', html: HTML }, ctx(AGENT_A))).code, 'request_id_conflict');
    assert.equal((await updateWidgetCommand(deps, { widget_ref: widgets[0].ref, chat_data: '1' }, ctx(AGENT_A))).status, 'updated');
    assert.equal(t.of('sendWidget').length, 0);
  });
  await test('an unwritable ledger means nothing is sent', async () => {
    const t = mockTelegram();
    const dir = tmp();
    const { deps } = routeDeps({ tg: t.tg, dir: join(dir, 'not-a-dir') });
    writeFileSync(join(dir, 'not-a-dir'), 'file in the way');
    const r = await sendWidgetCommand(deps, { request_id: 'r', html: HTML }, ctx(AGENT_A));
    assert.equal(r.code, 'state_unwritable');
    assert.equal(t.of('sendWidget').length, 0);
  });

  console.log('=== update ===');
  await test('update uses the stored chat/message; foreign, unknown and unsent refs are refused alike', async () => {
    const t = mockTelegram({ sendWidget: [json({ ok: true, result: { message_id: 77 } }), new Response('x', { status: 503 })] });
    const { deps } = routeDeps({ tg: t.tg });
    const sent = await sendWidgetCommand(deps, { request_id: 'r', html: HTML }, ctx(AGENT_A));
    const unknown = await sendWidgetCommand(deps, { request_id: 'u', html: HTML }, ctx(AGENT_A));
    assert.equal(unknown.status, 'unknown');
    const ok = await updateWidgetCommand(deps, { widget_ref: sent.widget_ref, chat_data: '{"pick":0}', public_data: '' }, ctx(AGENT_A));
    assert.deepEqual(ok, { status: 'updated', widget_ref: sent.widget_ref, changed: true });
    assert.deepEqual(t.of('editMessageWidgetData')[0].body, { chat_id: 1111, message_id: 77, chat_data: '{"pick":0}', public_data: '' });
    assert.equal((await updateWidgetCommand(deps, { widget_ref: sent.widget_ref, chat_data: '1' }, ctx(STRANGER))).code, 'not_authorized');
    assert.equal((await updateWidgetCommand(deps, { widget_ref: unknown.widget_ref, chat_data: '1' }, ctx(AGENT_A))).code, 'unknown_widget');
    assert.equal((await updateWidgetCommand(deps, { widget_ref: 'w_guessedguess', chat_data: '1' }, ctx(AGENT_A))).code, 'unknown_widget');
    assert.equal((await updateWidgetCommand(deps, { widget_ref: sent.widget_ref }, ctx(AGENT_A))).code, 'invalid_arguments');
    assert.equal((await updateWidgetCommand(deps, { widget_ref: sent.widget_ref, chat_id: 5, chat_data: '1' }, ctx(AGENT_A))).code, 'invalid_arguments');
    assert.equal(t.of('editMessageWidgetData').length, 1);
  });
  await test('an ambiguous edit is reported unknown, not rejected', async () => {
    const t = mockTelegram({ editMessageWidgetData: [json({ ok: false, error_code: 502 }, 502)] });
    const { deps } = routeDeps({ tg: t.tg });
    const sent = await sendWidgetCommand(deps, { request_id: 'r', html: HTML }, ctx(AGENT_A));
    const r = await updateWidgetCommand(deps, { widget_ref: sent.widget_ref, chat_data: '1' }, ctx(AGENT_A));
    assert.equal(r.status, 'unknown');
  });

  console.log('=== inbound widget queries ===');
  async function sentWidget(over = {}) {
    const t = mockTelegram(over.script);
    const r = routeDeps({ tg: t.tg, ...over.route });
    const sent = await sendWidgetCommand(r.deps, { request_id: 'r', html: HTML }, ctx(r.view.peerCid));
    return { t, ...r, sent };
  }
  await test('a bound query is answered first with the fixed ack, then forwarded as untrusted data', async () => {
    const { t, deps, sent } = await sentWidget();
    const order = [];
    const forwarded = [];
    const q = query({ message_id: sent.message_id, data: 'pick:1' });
    const tg = { answerWidgetQuery: async (id, data) => { order.push('answer'); return t.tg.answerWidgetQuery(id, data); } };
    const out = await handleWidgetQuery(q, deps, tg, async (owner, text) => { order.push('forward'); forwarded.push({ owner, text }); }, () => {});
    assert.equal(out, 'forwarded');
    assert.deepEqual(order, ['answer', 'forward']);
    assert.deepEqual(t.of('answerWidgetQuery')[0].body, { widget_query_id: q.id, data: ACCEPTED_ANSWER });
    assert.equal(forwarded[0].owner, AGENT_A);
    assert.deepEqual(JSON.parse(forwarded[0].text), {
      type: 'telegram_widget_query', widget_ref: sent.widget_ref, request_id: 'r', message_id: sent.message_id,
      from: { id: 1111, label: 'Alice' }, data: 'pick:1', note: QUERY_NOTE,
    });
  });
  await test('a duplicate update is neither answered nor forwarded twice, also after a restart', async () => {
    const { t, deps, dir, sent } = await sentWidget();
    const q = query({ message_id: sent.message_id });
    let forwards = 0;
    assert.equal(await handleWidgetQuery(q, deps, t.tg, async () => { forwards += 1; }, () => {}), 'forwarded');
    assert.equal(await handleWidgetQuery(q, deps, t.tg, async () => { forwards += 1; }, () => {}), 'duplicate');
    const reborn = routeDeps({ tg: t.tg, dir });
    assert.equal(await handleWidgetQuery(q, reborn.deps, t.tg, async () => { forwards += 1; }, () => {}), 'duplicate');
    assert.equal(forwards, 1);
    assert.equal(t.of('answerWidgetQuery').length, 1);
  });
  await test('a stale query ("query is too old") is never forwarded', async () => {
    const { t, deps, sent } = await sentWidget({ script: { answerWidgetQuery: [json({ ok: false, error_code: 400, description: 'Bad Request: query is too old and response timeout expired or query ID is invalid' }, 400)] } });
    const out = await handleWidgetQuery(query({ message_id: sent.message_id }), deps, t.tg, async () => assert.fail('forwarded'), () => {});
    assert.equal(out, 'stale');
  });
  await test('unknown, foreign-chat, group, impersonated, wallet, inline/shared and oversize queries are refused and not forwarded', async () => {
    const { t, deps, sent } = await sentWidget();
    const m = sent.message_id;
    const cases = [
      query({ message_id: 9999 }),
      query({ message_id: m, chat_id: 3333, from_id: 3333 }),
      query({ message_id: m, chat_type: 'group', chat_id: -100, from_id: 1111 }),
      query({ message_id: m, from_id: 4444 }),
      query({ message_id: m, queryType: 'sign_data' }),
      query({ message_id: m, inline: true }),
      query({ message_id: m, shared: true }),
      query({ message_id: m, data: 'x'.repeat(65) }),
      query({ message_id: m, data: '' }),
    ];
    for (const q of cases) {
      assert.equal(await handleWidgetQuery(q, deps, t.tg, async () => assert.fail(`forwarded ${JSON.stringify(q)}`), () => {}), 'refused');
    }
    assert.ok(t.of('answerWidgetQuery').every((c) => c.body.data === REFUSED_ANSWER));
    // Refused ids never entered the dedupe ring: the same id, now valid, still goes through.
    const reused = query({ id: cases[0].id, message_id: m });
    assert.equal(await handleWidgetQuery(reused, deps, t.tg, async () => {}, () => {}), 'forwarded');
    assert.equal(await handleWidgetQuery(query(), null, t.tg, async () => assert.fail('forwarded'), () => {}), 'refused');
  });
  await test('a widget whose agent was replaced does not forward to anyone', async () => {
    const { t, deps, sent, view } = await sentWidget();
    view.peerCid = AGENT_B;
    const out = await handleWidgetQuery(query({ message_id: sent.message_id }), deps, t.tg, async () => assert.fail('forwarded'), () => {});
    assert.equal(out, 'refused');
  });
  await test('two agents, two chats: each sees only its own widgets and queries', async () => {
    const t = mockTelegram();
    const a = routeDeps({ tg: t.tg, chatId: CHAT_A, peerCid: AGENT_A, name: 'a' });
    const b = routeDeps({ tg: t.tg, chatId: CHAT_B, peerCid: AGENT_B, name: 'b' });
    const wa = await sendWidgetCommand(a.deps, { request_id: 'same', html: HTML }, ctx(AGENT_A));
    const wb = await sendWidgetCommand(b.deps, { request_id: 'same', html: HTML }, ctx(AGENT_B));
    assert.deepEqual(t.of('sendWidget').map((c) => c.body.chat_id), [1111, 2222]);
    assert.equal((await sendWidgetCommand(b.deps, { request_id: 'x', html: HTML }, ctx(AGENT_A))).code, 'not_authorized');
    assert.equal((await updateWidgetCommand(b.deps, { widget_ref: wa.widget_ref, chat_data: '1' }, ctx(AGENT_B))).code, 'unknown_widget');
    const got = { a: [], b: [] };
    const fwd = (k) => async (owner, text) => got[k].push({ owner, ref: JSON.parse(text).widget_ref });
    // A's message id presented in B's chat (and vice versa) matches nothing.
    assert.equal(await handleWidgetQuery(query({ chat_id: 2222, from_id: 2222, message_id: wa.message_id }), b.deps, t.tg, fwd('b'), () => {}), 'refused');
    assert.equal(await handleWidgetQuery(query({ message_id: wb.message_id }), a.deps, t.tg, fwd('a'), () => {}), 'refused');
    assert.equal(await handleWidgetQuery(query({ message_id: wa.message_id }), a.deps, t.tg, fwd('a'), () => {}), 'forwarded');
    assert.equal(await handleWidgetQuery(query({ chat_id: 2222, from_id: 2222, message_id: wb.message_id }), b.deps, t.tg, fwd('b'), () => {}), 'forwarded');
    assert.deepEqual(got, { a: [{ owner: AGENT_A, ref: wa.widget_ref }], b: [{ owner: AGENT_B, ref: wb.widget_ref }] });
  });

  console.log('=== one poller: messages and widget queries ===');
  await test('getUpdates asks for widget_query; messages still reach onMessage unchanged', async () => {
    let tg;
    const t = mockTelegram({ getUpdates: [json({ ok: true, result: [
      { update_id: 10, message: { message_id: 1, date: 1, chat: { id: 1111, type: 'private' }, from: { id: 1111, first_name: 'Alice' }, text: 'hello' } },
      { update_id: 11, widget_query: { id: 'q1', from: { id: 1111, first_name: 'Alice' }, chat: { id: 1111, type: 'private' }, message_id: 5, chat_instance: '9', type: { type: 'data' }, data: 'inc' } },
    ] })] });
    tg = t.tg;
    const messages = [];
    const queries = [];
    await tg.poll((m) => { messages.push(m); }, (q) => { queries.push(q); tg.stop(); });
    assert.deepEqual(t.of('getUpdates')[0].body.allowed_updates, ['message', 'widget_query']);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, 'hello');
    assert.deepEqual(queries[0], {
      update_id: 11, id: 'q1', from_id: 1111, from: 'Alice', chat_id: 1111, chat_type: 'private', message_id: 5,
      inline: false, shared: false, queryType: 'data', data: 'inc',
    });
  });
  await test('without a widget handler the allowlist is unchanged', async () => {
    let tg;
    const t = mockTelegram({ getUpdates: [json({ ok: true, result: [
      { update_id: 1, message: { message_id: 1, date: 1, chat: { id: 1 }, text: 'x' } },
    ] })] });
    tg = t.tg;
    await tg.poll(() => tg.stop());
    assert.deepEqual(t.of('getUpdates')[0].body.allowed_updates, ['message']);
  });

  console.log('=== real SDK command dispatch through the ordered drain ===');
  await test('text → command → command_result → text: texts go to Telegram, the command runs once, nothing else is posted', async () => {
    const t = mockTelegram();
    const { deps } = routeDeps({ tg: t.tg });
    const row = (wire_id, message_kind, body, from = AGENT_A) => ({
      seq: 0, msg_id: 0, wire_id, message_kind, from: { id: from, name: 'agent' }, peer: { id: from, name: 'agent' },
      direction: 'in', text: body, body, inbox_state: 'unread', status: 'unread', reply_to: null,
    });
    const unread = [
      row('t1', 'text', 'before'),
      row('c1', 'command', JSON.stringify({ command: SEND_COMMAND, arguments: { request_id: 'r', html: HTML } })),
      row('cr', 'command_result', '{"ok":true}'),
      row('t2', 'text', 'after'),
    ];
    const daemon = [];
    const client = new OursClient({
      url: 'http://fixture.invalid', leaseToken: 'fixture-only',
      fetch: async (url, init) => {
        const method = new URL(url).pathname.split('/').at(-1);
        const args = JSON.parse(init.body);
        daemon.push({ method, args });
        let value = {};
        if (method === 'listIncomingMessages') value = unread.map(({ wire_id, message_kind }) => ({ wire_id, message_kind }));
        if (method === 'getHistoryItem') value = unread.find((m) => m.wire_id === args.wire_id) ?? null;
        if (method === 'getMessages') value = { messages: unread.splice(0, args.limit), remaining: unread.length };
        return new Response(JSON.stringify(value), { status: 200 });
      },
    });
    await client.registerCommands(widgetCommands(deps));
    const catalog = JSON.parse(daemon.find((c) => c.method === 'setCommandCatalog').args.catalog);
    assert.deepEqual(catalog.commands.map((c) => c.name), [SEND_COMMAND, UPDATE_COMMAND]);
    const posted = [];
    assert.equal(await drainMessages(client, async (m) => { posted.push(m.body); }), 2);
    assert.deepEqual(posted, ['before', 'after']);
    assert.equal(t.of('sendWidget').length, 1);
    const results = daemon.filter((c) => c.method === 'sendCommandResult');
    assert.equal(results.length, 1);
    assert.equal(results[0].args.contact, AGENT_A);
    assert.equal(results[0].args.reply_to_wire_id, 'c1');
    assert.equal(results[0].args.outcome.ok, true);
    assert.equal(results[0].args.outcome.result.status, 'sent');
    assert.ok(daemon.filter((c) => c.method === 'getMessages').every((c) => c.args.limit === 1));
  });
  await test('a command from another contact is answered with not_authorized and sends nothing', async () => {
    const t = mockTelegram();
    const { deps } = routeDeps({ tg: t.tg });
    const sent = [];
    const unread = [{ wire_id: 'c1', message_kind: 'command', from: { id: STRANGER, name: 'x' }, body: JSON.stringify({ command: SEND_COMMAND, arguments: { request_id: 'r', html: HTML } }) }];
    const client = new OursClient({
      url: 'http://fixture.invalid', leaseToken: 'fixture-only',
      fetch: async (url, init) => {
        const method = new URL(url).pathname.split('/').at(-1);
        const args = JSON.parse(init.body);
        if (method === 'sendCommandResult') sent.push(args);
        const value = method === 'listIncomingMessages' ? unread.map(({ wire_id, message_kind }) => ({ wire_id, message_kind }))
          : method === 'getMessages' ? { messages: unread.splice(0, 1), remaining: 0 } : {};
        return new Response(JSON.stringify(value), { status: 200 });
      },
    });
    await client.registerCommands(widgetCommands(deps));
    await drainMessages(client, async () => assert.fail('posted to Telegram'));
    assert.equal(sent[0].outcome.result.code, 'not_authorized');
    assert.equal(t.of('sendWidget').length, 0);
  });
  await test('a drain ack that is not the expected command fails instead of skipping a row', async () => {
    const client = {
      async listIncomingMessages() { return [{ wire_id: 'c1', message_kind: 'command' }]; },
      async getHistoryItem() { assert.fail('commands are not looked up for delivery'); },
      async getMessages() { return { messages: [{ wire_id: 't9' }], command_results: [], commands_handled: 0, remaining: 0 }; },
    };
    await assert.rejects(() => drainMessages(client, async () => assert.fail('posted')), /command ack mismatch: expected c1, got t9/);
  });

  console.log(`\n${n} widget checks passed (local fixtures only; no Telegram, no daemon)`);
} finally {
  for (const d of tmpDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
}
