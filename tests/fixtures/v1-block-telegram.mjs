// Test-only: block external fetches and observe actual daemon responses.
import { createHash } from 'node:crypto';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? input);
  if (process.env.V1_PROVISION_BOT === '1' && url.hostname === 'api.telegram.org' && url.pathname === '/bot1:synthetic-fixture/getMe') {
    return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' } });
  }
  if (url.hostname !== '127.0.0.1') throw new Error('External transport disabled in V1 lifecycle fixture');
  const headers = new Headers(init?.headers ?? input?.headers);
  const result = await originalFetch(input, init);
  console.log('V1_HTTP ' + JSON.stringify({ at: Date.now(), path: url.pathname,
    owner: headers.get('x-ours-lease-token'), mode: headers.get('x-ours-session-mode'),
    credential: createHash('sha256').update(headers.get('x-ours-api-token') ?? '').digest('hex'),
    status: result.status }));
  return result;
};
