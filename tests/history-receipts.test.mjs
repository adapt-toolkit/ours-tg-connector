import assert from 'node:assert/strict';

import { reconcileReceiptHistory } from '../src/history-receipts.ts';

console.log('=== receipt catch-up follows newest-first history cursors ===');
{
  const calls = [];
  const client = {
    async listHistory(input) {
      calls.push(input);
      if (calls.length === 1) {
        return {
          items: Array.from({ length: 200 }, (_, i) => ({
            wire_id: `new-${i}`,
            peer: { id: 'agent', name: 'Agent' },
            direction: 'out',
            delivery_state: 'sent',
          })),
          next_cursor: 50,
        };
      }
      return {
        items: [{
          wire_id: 'retained-old',
          peer: { id: 'agent-cid', name: 'Agent' },
          direction: 'out',
          delivery_state: 'read',
        }],
        next_cursor: null,
      };
    },
  };
  const applied = [];
  const count = await reconcileReceiptHistory(
    client,
    new Set(['retained-old']),
    async (sender, kind, wires) => { applied.push({ sender, kind, wires }); },
  );
  assert.equal(count, 1);
  assert.deepEqual(calls, [
    { direction: 'out', limit: 200 },
    { direction: 'out', limit: 200, before_seq: 50 },
  ]);
  assert.deepEqual(applied, [{ sender: 'agent-cid', kind: 'read', wires: ['retained-old'] }]);
}

console.log('history receipt reconciliation OK');
