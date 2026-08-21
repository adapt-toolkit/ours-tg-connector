import type { ReceiptState } from './receipts';

export interface ReceiptHistoryItem {
  wire_id: string;
  peer: { id: string; name: string };
  direction: 'in' | 'out';
  delivery_state: 'sent' | 'delivered' | 'read' | null;
}

export interface ReceiptHistoryClient {
  listHistory(a: {
    direction: 'out';
    limit: number;
    before_seq?: number;
  }): Promise<{
    items: ReceiptHistoryItem[];
    next_cursor: number | null;
  }>;
}

// Reconcile receipts that landed while the notification watch was offline.
// History pages newest-first, so the SDK cursor is followed until every retained
// map row has been found or history is exhausted. Applying remains monotonic in
// MessageMap, making replayed pages and duplicate notifications harmless.
export async function reconcileReceiptHistory(
  client: ReceiptHistoryClient,
  retainedWireIds: ReadonlySet<string>,
  apply: (senderCid: string, kind: ReceiptState, wireIds: string[]) => Promise<void>,
): Promise<number> {
  if (retainedWireIds.size === 0) return 0;
  const remaining = new Set(retainedWireIds);
  let beforeSeq: number | undefined;
  let reconciled = 0;
  for (;;) {
    const page = await client.listHistory({
      direction: 'out',
      limit: 200,
      ...(beforeSeq !== undefined ? { before_seq: beforeSeq } : {}),
    });
    for (const item of page.items) {
      if (!remaining.delete(item.wire_id)) continue;
      if (item.delivery_state === 'delivered' || item.delivery_state === 'read') {
        await apply(item.peer.id, item.delivery_state, [item.wire_id]);
        reconciled += 1;
      }
    }
    if (remaining.size === 0 || page.next_cursor === null) return reconciled;
    beforeSeq = page.next_cursor;
  }
}
