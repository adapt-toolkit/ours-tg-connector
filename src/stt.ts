// Speech-to-text client for inbound Telegram voice notes. Dependency-free (bare
// fetch), OpenAI-compatible transcription endpoint. Telegram voice is OGG/Opus,
// which the endpoint accepts directly — no transcoding. Never throws to the
// caller and never logs the key (mirrors resolveAttachment's degrade-not-crash).

export interface SttOptions {
  baseUrl: string;   // e.g. https://api.openai.com/v1
  apiKey: string;
  model: string;     // e.g. whisper-1
  language?: string; // ISO-639-1 hint; omit => auto-detect
  timeoutMs: number;
}

export type SttResult =
  | { ok: true; text: string; lang?: string }
  | { ok: false; error: string };

export async function transcribe(bytes: Buffer, filename: string, mime: string, opts: SttOptions): Promise<SttResult> {
  if (!opts.apiKey) return { ok: false, error: 'no STT api key configured' };
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), opts.timeoutMs);
  try {
    const form = new FormData();
    // Copy into a plain Uint8Array — a Buffer is not a valid BlobPart (see sendDocument).
    form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    form.set('model', opts.model);
    form.set('response_format', 'json');
    if (opts.language) form.set('language', opts.language);
    const resp = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` }, // fetch sets the multipart boundary
      body: form,
      signal: aborter.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return { ok: false, error: `STT HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` };
    }
    const body = (await resp.json()) as { text?: string; language?: string };
    if (typeof body.text !== 'string') return { ok: false, error: 'STT response missing text' };
    return { ok: true, text: body.text, lang: body.language };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'AbortError') return { ok: false, error: `STT timeout after ${opts.timeoutMs}ms` };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
