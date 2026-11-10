// Ordered external delivery over the SDK's host-history boundary.
//
// listIncoming* is read-only. Bodies/bytes are resolved without changing inbox
// state, Telegram gets the item, and only then does the matching consume call
// commit the read transition. There is deliberately no defer/requeue fallback:
// a failed external delivery leaves the oldest row unread for the next pass.
//
// Typed ours commands share the message inbox. A `command` row is never posted
// to Telegram: consuming it through getMessages makes the SDK run the
// registered handler and send its command_result back. A stray
// `command_result` row is consumed and dropped.

export type MessageKind = 'text' | 'command' | 'command_result';

export interface IncomingMessageRef {
  wire_id: string;
  message_kind?: MessageKind; // absent on older daemons: text
}

export interface HistoryMessageItem extends IncomingMessageRef {
  msg_id: number;
  from: { id: string; name: string };
  direction: 'in' | 'out';
  text: string;
  body: string;
  inbox_state: 'pending_introduction' | 'unread' | 'read';
  reply_to: { wire_id: string; sentence?: number } | null;
}

export interface IncomingFileItem extends IncomingMessageRef {
  file_id: number;
  from: { id: string; name: string };
  filename: string;
  mime: string;
  byte_length: number;
  reply_to: { wire_id: string; sentence?: number } | null;
}

export interface HistoryDeliveryClient {
  listIncomingMessages(): Promise<IncomingMessageRef[]>;
  getHistoryItem(a: { wire_id: string }): Promise<HistoryMessageItem | null>;
  getMessages(a: { limit: number }): Promise<{
    messages: HistoryMessageItem[];
    command_results?: Array<{ wire_id: string }>;
    commands_handled?: number;
    remaining: number;
  }>;
  listIncomingFiles(): Promise<IncomingFileItem[]>;
  fetchFile(wireId: string): Promise<Uint8Array>;
  getFiles(a: { wire_ids: string[] }): Promise<{
    files: Array<{ wire_id: string }>;
    remaining: number;
  }>;
}

export async function drainMessages(
  client: Pick<HistoryDeliveryClient, 'listIncomingMessages' | 'getHistoryItem' | 'getMessages'>,
  deliver: (item: HistoryMessageItem) => Promise<void>,
): Promise<number> {
  let delivered = 0;
  for (;;) {
    const pending = await client.listIncomingMessages();
    if (pending.length === 0) return delivered;
    for (const ref of pending) {
      if (ref.message_kind === 'command' || ref.message_kind === 'command_result') {
        await consumeTyped(client, ref);
        continue;
      }
      const item = await client.getHistoryItem({ wire_id: ref.wire_id });
      if (!item || item.direction !== 'in' || item.inbox_state !== 'unread') {
        throw new Error(`history lookup for unread message ${ref.wire_id} did not return that unread inbound row`);
      }
      await deliver(item);
      const ack = await client.getMessages({ limit: 1 });
      if (ack.messages.length !== 1 || ack.messages[0].wire_id !== ref.wire_id) {
        const got = ack.messages.map((m) => m.wire_id).join(', ') || '<none>';
        throw new Error(`oldest-first message ack mismatch: expected ${ref.wire_id}, got ${got}`);
      }
      delivered += 1;
    }
  }
}

// Consume exactly the oldest unread row, which must be this command (the SDK
// dispatches it) or command result. Nothing reaches Telegram.
async function consumeTyped(
  client: Pick<HistoryDeliveryClient, 'getMessages'>,
  ref: IncomingMessageRef,
): Promise<void> {
  const ack = await client.getMessages({ limit: 1 });
  const results = ack.command_results ?? [];
  const ok = ref.message_kind === 'command'
    ? ack.messages.length === 0 && results.length === 0 && ack.commands_handled === 1
    : ack.messages.length === 0 && results.length === 1 && results[0].wire_id === ref.wire_id && !ack.commands_handled;
  if (!ok) {
    const got = [...ack.messages.map((m) => m.wire_id), ...results.map((r) => r.wire_id)].join(', ') ||
      `${ack.commands_handled ?? 0} command(s)`;
    throw new Error(`oldest-first ${ref.message_kind} ack mismatch: expected ${ref.wire_id}, got ${got}`);
  }
}

export async function drainFiles(
  client: Pick<HistoryDeliveryClient, 'listIncomingFiles' | 'fetchFile' | 'getFiles'>,
  deliver: (item: IncomingFileItem, bytes: Uint8Array) => Promise<void>,
): Promise<number> {
  let delivered = 0;
  for (;;) {
    const pending = await client.listIncomingFiles();
    if (pending.length === 0) return delivered;
    for (const item of pending) {
      const bytes = await client.fetchFile(item.wire_id);
      await deliver(item, bytes);
      const ack = await client.getFiles({ wire_ids: [item.wire_id] });
      if (ack.files.length !== 1 || ack.files[0].wire_id !== item.wire_id) {
        const got = ack.files.map((f) => f.wire_id).join(', ') || '<none>';
        throw new Error(`selected file ack mismatch: expected ${item.wire_id}, got ${got}`);
      }
      delivered += 1;
    }
  }
}
