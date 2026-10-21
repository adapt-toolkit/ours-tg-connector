import { randomUUID } from 'node:crypto';
// Optional startup input, shared by ordinary host and container installations.
import { lstatSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

type Route = { name: string; botName: string; chatId: string; threadId: string;
  label: string; bio: string; payloadMode: 'plain' | 'envelope' };
type Operations = {
  bots: ReadonlyMap<string, { token: string }>;
  connections: ReadonlyMap<string, Route>;
  addBot(name: string, token: string): Promise<unknown>;
  createConnection(route: Route): Promise<{ cid: string; invite: string; botUsername: string }>;
};

function privateJson(path: string): unknown | undefined {
  let info;
  try { info = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!info.isFile() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) throw new Error('Provision files must be private, owned regular files');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid Telegram provision fields');
  return value as Record<string, unknown>;
}
function text(value: unknown, required = false): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || (required && !value.trim())) throw new Error('Invalid Telegram provision string');
  return value.trim();
}

export async function applyProvision(stateDir: string, operations: Operations): Promise<boolean> {
  const input = privateJson(join(stateDir, 'provision.json'));
  if (input === undefined) return false;
  const doc = object(input, ['bots', 'connections']);
  if (!Array.isArray(doc.bots) || !Array.isArray(doc.connections)) throw new Error('Telegram provision arrays are required');
  const bots = doc.bots.map(value => {
    const bot = object(value, ['name', 'botToken']);
    return { name: text(bot.name, true), botToken: text(bot.botToken, true) };
  });
  if (new Set(bots.map(bot => bot.name)).size !== bots.length ||
      new Set(bots.map(bot => bot.botToken)).size !== bots.length) throw new Error('Telegram bot names and tokens must be unique');
  const routes: Route[] = doc.connections.map(value => {
    const row = object(value, ['name', 'botName', 'chatId', 'threadId', 'label', 'bio', 'payloadMode']);
    const payloadMode = row.payloadMode ?? 'envelope';
    if (payloadMode !== 'plain' && payloadMode !== 'envelope') throw new Error('Invalid Telegram payloadMode');
    const botName = text(row.botName, true);
    if (!bots.some(bot => bot.name === botName)) throw new Error('Telegram connection references an undeclared bot');
    return { name: text(row.name, true), botName, chatId: text(row.chatId, true),
      threadId: text(row.threadId), label: text(row.label), bio: text(row.bio), payloadMode };
  });
  if (new Set(routes.map(route => route.name)).size !== routes.length) throw new Error('Telegram connection names must be unique');

  // Detect conflicts before adding anything. Only the owning component sees full tokens.
  for (const bot of bots) {
    const existing = operations.bots.get(bot.name);
    if ((existing && existing.token !== bot.botToken) || [...operations.bots].some(([name, entry]) => name !== bot.name && entry.token === bot.botToken)) {
      throw new Error('Existing Telegram bot conflicts with requested configuration');
    }
  }
  for (const route of routes) {
    const existing = operations.connections.get(route.name);
    if (existing && Object.entries(route).some(([key, value]) => existing[key as keyof Route] !== value)) {
      throw new Error('Existing Telegram connection conflicts with requested configuration');
    }
  }
  const outputPath = join(stateDir, 'provision-output.json');
  const output = (privateJson(outputPath) ?? { version: 1, connections: [] }) as {
    version: number; connections: Array<{ name: string; result: unknown }>;
  };
  if (output?.version !== 1 || !Array.isArray(output.connections)) throw new Error('Existing Telegram provision output is malformed');
  for (const bot of bots) if (!operations.bots.has(bot.name)) await operations.addBot(bot.name, bot.botToken);
  for (const route of routes) {
    if (operations.connections.has(route.name)) continue;
    const result = await operations.createConnection(route);
    output.connections = output.connections.filter(entry => entry?.name !== route.name);
    output.connections.push({ name: route.name, result: { ok: true, ...result } });
    const temporary = `${outputPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(output, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, outputPath);
    } finally { rmSync(temporary, { force: true }); }
  }
  return true;
}
