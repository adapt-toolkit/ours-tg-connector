// Test-only preload: only loopback (the fixture daemon) is reachable. Any other
// request, including the Telegram Bot API, is answered locally with a 401 so the
// bot backs off; nothing leaves the machine. Each blocked request is logged.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.hostname === '127.0.0.1') return originalFetch(input, init);
  console.log(`NO_EXTERNAL_FETCH blocked ${url.hostname}${url.pathname.replace(/\/bot[^/]+/, '/bot<token>')}`);
  return Response.json({ ok: false, error_code: 401, description: 'Unauthorized (test fixture)' }, { status: 401 });
};
