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

function baseMime(mime: string): string {
  return mime.split(';', 1)[0].trim() || 'application/octet-stream';
}

function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

export async function transcribe(bytes: Buffer, filename: string, mime: string, opts: SttOptions): Promise<SttResult> {
  if (!opts.apiKey) return { ok: false, error: 'no STT api key configured' };
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), opts.timeoutMs);
  try {
    const form = new FormData();
    // Copy into a plain Uint8Array — a Buffer is not a valid BlobPart (see sendDocument).
    // Connector wire metadata may include the ours voice-message marker; STT
    // providers receive only the real container MIME.
    form.set('file', new Blob([new Uint8Array(bytes)], { type: baseMime(mime) }), filename);
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
      const safeDetail = redactSecret(detail, opts.apiKey).slice(0, 200);
      return { ok: false, error: `STT HTTP ${resp.status}${safeDetail ? `: ${safeDetail}` : ''}` };
    }
    const body = (await resp.json()) as { text?: string; language?: string };
    if (typeof body.text !== 'string') return { ok: false, error: 'STT response missing text' };
    return { ok: true, text: body.text, lang: body.language };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'AbortError') return { ok: false, error: `STT timeout after ${opts.timeoutMs}ms` };
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: redactSecret(detail, opts.apiKey) };
  } finally {
    clearTimeout(timer);
  }
}
