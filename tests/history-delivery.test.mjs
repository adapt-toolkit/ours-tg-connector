import assert from 'node:assert/strict';

import { drainMessages, drainFiles } from '../src/history-delivery.ts';

const message = (n) => ({
  msg_id: n,
  wire_id: `w${n}`,
  from: { id: 'agent-cid', name: 'Agent' },
  direction: 'in',
  text: `message ${n}`,
  body: `message ${n}`,
  inbox_state: 'unread',
  reply_to: null,
});

console.log('=== ordered message delivery and post-success acknowledgement ===');
{
  const unread = Array.from({ length: 205 }, (_, i) => message(i + 1));
  const delivered = [];
  const limits = [];
  const client = {
    async listIncomingMessages() { return unread.map(({ wire_id }) => ({ wire_id })); },
    async getHistoryItem({ wire_id }) { return unread.find((m) => m.wire_id === wire_id) ?? null; },
    async getMessages({ limit }) {
      limits.push(limit);
      return { messages: unread.splice(0, limit), remaining: unread.length };
    },
  };
  assert.equal(await drainMessages(client, async (m) => { delivered.push(m.wire_id); }), 205);
  assert.deepEqual(delivered, Array.from({ length: 205 }, (_, i) => `w${i + 1}`));
  assert.ok(limits.every((limit) => limit === 1), 'every message ack uses getMessages({limit:1})');
  assert.equal(unread.length, 0);
}

console.log('=== Telegram failure leaves the oldest message unread ===');
{
  const unread = [message(1)];
  let ackCalls = 0;
  const client = {
    async listIncomingMessages() { return unread.map(({ wire_id }) => ({ wire_id })); },
    async getHistoryItem() { return unread[0]; },
    async getMessages() { ackCalls += 1; return { messages: unread.splice(0, 1), remaining: 0 }; },
  };
  await assert.rejects(() => drainMessages(client, async () => { throw new Error('Telegram unavailable'); }), /Telegram unavailable/);
  assert.equal(ackCalls, 0);
  assert.equal(unread[0].wire_id, 'w1');
}

console.log('=== oldest-first acknowledgement is matched exactly ===');
{
  const expected = message(1);
  const client = {
    async listIncomingMessages() { return [{ wire_id: expected.wire_id }]; },
    async getHistoryItem() { return expected; },
    async getMessages({ limit }) {
      assert.equal(limit, 1);
      return { messages: [message(2)], remaining: 0 };
    },
  };
  await assert.rejects(() => drainMessages(client, async () => {}), /oldest-first message ack mismatch: expected w1, got w2/);
}

console.log('=== files use read-only fetch, delivery, then selected acknowledgement ===');
{
  const file = {
    file_id: 7,
    wire_id: 'file-wire',
    from: { id: 'agent-cid', name: 'Agent' },
    filename: 'voice.ogg',
    mime: 'audio/ogg',
    byte_length: 3,
    reply_to: null,
  };
  let unread = true;
  const order = [];
  const client = {
    async listIncomingFiles() { return unread ? [file] : []; },
    async fetchFile(wireId) { order.push(`fetch:${wireId}`); return Uint8Array.from([1, 2, 3]); },
    async getFiles({ wire_ids }) {
      order.push(`ack:${wire_ids.join(',')}`);
      unread = false;
      return { files: [{ wire_id: 'file-wire' }], remaining: 0 };
    },
  };
  assert.equal(await drainFiles(client, async (item, bytes) => {
    order.push(`deliver:${item.wire_id}:${bytes.length}`);
  }), 1);
  assert.deepEqual(order, ['fetch:file-wire', 'deliver:file-wire:3', 'ack:file-wire']);
}

console.log('=== file delivery failure never calls selected acknowledgement ===');
{
  const file = {
    file_id: 8,
    wire_id: 'file-unread',
    from: { id: 'agent-cid', name: 'Agent' },
    filename: 'kept.bin',
    mime: 'application/octet-stream',
    byte_length: 1,
    reply_to: null,
  };
  let ackCalls = 0;
  const client = {
    async listIncomingFiles() { return [file]; },
    async fetchFile() { return Uint8Array.from([9]); },
    async getFiles() { ackCalls += 1; return { files: [], remaining: 1 }; },
  };
  await assert.rejects(() => drainFiles(client, async () => { throw new Error('upload refused'); }), /upload refused/);
  assert.equal(ackCalls, 0);
}

console.log('history delivery OK');
