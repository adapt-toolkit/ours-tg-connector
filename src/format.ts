// Telegram ⇄ Markdown formatting, both directions. Pure (no network, no disk, no
// ADAPT) so every rule below is unit-tested in isolation — see tests/format.test.mjs.
//
// INBOUND (Telegram → agent). An update carries `entities` / `caption_entities`:
// (type, offset, length) triples over the message text. We fold them back into
// Markdown so the agent reads formatting as text instead of losing it.
//
//   OFFSETS ARE UTF-16 CODE UNITS. A JavaScript string IS a UTF-16 code-unit
//   sequence, so `text.slice(offset, offset + length)` is EXACTLY right here and
//   emoji / non-BMP characters survive. The hazard in JS is the opposite of the
//   one in Python: do NOT "fix" this by going through Array.from(text),
//   [...text], or codePointAt — those index by code POINT and would slide every
//   offset after the first astral character. utf16Len() exists for the same
//   reason (length in code units, never code points).
//
// OUTBOUND (agent → Telegram). The agent writes ordinary Markdown; Telegram wants
// MarkdownV2, where `_ * [ ] ( ) ~ ` > # + - = | { } . !` are all reserved and ONE
// unescaped dot rejects the whole send. So we parse the agent's Markdown into a
// node tree and escape the TEXT LEAVES only — never the assembled string, which
// would escape our own markup right back into literals.
//
// The dialect is deliberately the intersection of what agents write and what
// MarkdownV2 can express, so a message round-trips Telegram → agent → Telegram:
//
//   **bold**  _italic_ / *italic*  __underline__  ~~strike~~  ||spoiler||
//   `code`  ```lang\nblock\n```  > quote  [text](url)
//
// Emphasis uses a conservative boundary rule (see EMPHASIS_MARKS): `foo_bar_baz`
// and `2*3*4` stay literal, because an identifier silently turning into italics is
// a worse failure than un-rendered emphasis.

// ----- inbound: entities → Markdown ------------------------------------------

// One Telegram message entity, as delivered in `entities` / `caption_entities`.
export interface TelegramEntity {
  type: string;
  offset: number; // UTF-16 code units
  length: number; // UTF-16 code units
  url?: string; // text_link
  user?: { id?: number; first_name?: string; last_name?: string; username?: string }; // text_mention
  language?: string; // pre
  custom_emoji_id?: string; // custom_emoji
}

// Entity types we fold into Markdown. Anything else (mention, hashtag, url,
// email, phone_number, bot_command, cashtag) is already legible verbatim in the
// text, so it is left untouched rather than decorated.
const RENDERED_TYPES = new Set([
  'bold', 'italic', 'underline', 'strikethrough', 'spoiler',
  'code', 'pre', 'blockquote', 'expandable_blockquote',
  'text_link', 'text_mention', 'custom_emoji',
]);

// A length in UTF-16 code units — the unit Telegram counts offsets in, and the
// unit `String.prototype.length` already reports. Named so the next reader does
// not "improve" it into a code-point count.
export function utf16Len(s: string): number {
  return s.length;
}

interface Ent extends TelegramEntity {
  start: number;
  end: number;
}

// Clamp, drop and order the entity list so the renderer can walk it as a tree:
// outermost first at each offset (length descending), which makes a nested
// entity always follow its parent.
function normalizeEntities(text: string, entities: TelegramEntity[]): Ent[] {
  const max = utf16Len(text);
  const out: Ent[] = [];
  for (const e of entities) {
    if (!RENDERED_TYPES.has(e.type)) continue;
    if (!Number.isFinite(e.offset) || !Number.isFinite(e.length)) continue;
    const start = Math.max(0, Math.min(max, Math.trunc(e.offset)));
    const end = Math.max(start, Math.min(max, start + Math.trunc(e.length)));
    if (end <= start) continue; // zero-length entities carry nothing
    out.push({ ...e, start, end });
  }
  out.sort((a, b) => (a.start - b.start) || (b.end - a.end));
  return out;
}

function quotePrefix(inner: string, expandable: boolean): string {
  const body = inner.split('\n').map((l) => `> ${l}`).join('\n');
  // The expandable variant has no Markdown spelling; say so rather than lose it.
  return expandable ? `${body}\n> (expandable)` : body;
}

function mentionTarget(e: Ent): string {
  const id = e.user?.id;
  return id === undefined ? 'tg://user' : `tg://user?id=${id}`;
}

// Wrap one entity's already-rendered inner text in its Markdown markup. `raw` is
// the untouched source slice, used by the verbatim kinds (code/pre) where inner
// entities must NOT be interpreted.
function wrapEntity(e: Ent, inner: string, raw: string): string {
  switch (e.type) {
    case 'bold': return `**${inner}**`;
    case 'italic': return `_${inner}_`;
    case 'underline': return `__${inner}__`;
    case 'strikethrough': return `~~${inner}~~`;
    case 'spoiler': return `||${inner}||`;
    case 'code': return `\`${raw}\``;
    case 'pre': return `\`\`\`${e.language ?? ''}\n${raw}\n\`\`\``;
    case 'blockquote': return quotePrefix(inner, false);
    case 'expandable_blockquote': return quotePrefix(inner, true);
    case 'text_link': return e.url ? `[${inner}](${e.url})` : inner;
    case 'text_mention': return `[${inner}](${mentionTarget(e)})`;
    // A custom emoji is premium-only and cannot be reproduced. Telegram already
    // put a stand-in emoji in the text at this offset — keep exactly that.
    case 'custom_emoji': return inner;
    default: return inner;
  }
}

function renderRange(text: string, ents: Ent[], start: number, end: number): string {
  let out = '';
  let i = start;
  let k = 0;
  while (k < ents.length) {
    const e = ents[k];
    const eStart = Math.max(e.start, start);
    const eEnd = Math.min(e.end, end);
    if (eEnd <= i) { k += 1; continue; } // already covered by a preceding sibling
    if (eStart > i) { out += text.slice(i, eStart); i = eStart; }
    // Every following entity that begins inside this one is its child; a child
    // overhanging the parent's end is clipped by the recursive call's `end`.
    const kids: Ent[] = [];
    let j = k + 1;
    while (j < ents.length && ents[j].start < eEnd) { kids.push(ents[j]); j += 1; }
    const raw = text.slice(eStart, eEnd);
    const verbatim = e.type === 'code' || e.type === 'pre';
    out += wrapEntity(e, verbatim ? raw : renderRange(text, kids, eStart, eEnd), raw);
    i = eEnd;
    k = j;
  }
  if (i < end) out += text.slice(i, end);
  return out;
}

// Fold Telegram entities into Markdown. Returns `text` unchanged when there is
// nothing to render, so a plain message is never rewritten.
export function entitiesToMarkdown(text: string, entities?: TelegramEntity[] | null): string {
  if (!text || !entities || entities.length === 0) return text;
  const ents = normalizeEntities(text, entities);
  if (ents.length === 0) return text;
  return renderRange(text, ents, 0, utf16Len(text));
}

// ----- outbound: Markdown → MarkdownV2 ----------------------------------------

// Reserved in MarkdownV2 body text. One unescaped '.' fails the whole sendMessage.
const MDV2_RESERVED = '_*[]()~`>#+-=|{}.!';

export function escapeMarkdownV2(s: string): string {
  let out = '';
  for (const ch of s) out += MDV2_RESERVED.includes(ch) ? `\\${ch}` : ch;
  return out;
}

// Inside `code` / ```pre``` only the fence character and the backslash are special.
function escapeCode(s: string): string {
  return s.replace(/([\\`])/g, '\\$1');
}

// Inside a (url) only ')' and '\' are special.
function escapeUrl(s: string): string {
  return s.replace(/([\\)])/g, '\\$1');
}

type Node =
  | { t: 'text'; text: string }
  | { t: 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler'; kids: Node[] }
  | { t: 'code'; text: string }
  | { t: 'pre'; text: string; lang: string }
  | { t: 'link'; url: string; kids: Node[] }
  | { t: 'quote'; kids: Node[] };

// Inline emphasis markers, longest-first so `**` is tried before `*` and `__`
// before `_`. `word` marks the markers that must not fire inside a word: it is
// what keeps `foo_bar_baz` and `2*3*4` literal.
const EMPHASIS_MARKS: Array<{ mark: string; t: 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler'; word: boolean }> = [
  { mark: '**', t: 'bold', word: false },
  { mark: '__', t: 'underline', word: false },
  { mark: '~~', t: 'strike', word: false },
  { mark: '||', t: 'spoiler', word: false },
  { mark: '*', t: 'italic', word: true },
  { mark: '_', t: 'italic', word: true },
];

const WORD_RE = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_RE.test(ch);
}

// A run opens only when the marker is followed by non-space, and (for the
// intraword-prone single-character markers) is not glued to a word on its left.
function opens(src: string, i: number, m: { mark: string; word: boolean }): boolean {
  const after = src[i + m.mark.length];
  if (after === undefined || /\s/.test(after)) return false;
  if (m.word && isWordChar(src[i - 1])) return false;
  return true;
}

// Find the matching closer: preceded by non-space and, for a word-prone marker,
// not glued to a word on its right.
function findCloser(src: string, from: number, m: { mark: string; word: boolean }): number {
  for (let i = from; i <= src.length - m.mark.length; i += 1) {
    if (!src.startsWith(m.mark, i)) continue;
    if (i === from) continue; // no empty runs
    const before = src[i - 1];
    if (before === undefined || /\s/.test(before)) continue;
    if (m.word && isWordChar(src[i + m.mark.length])) continue;
    return i;
  }
  return -1;
}

function parseInline(src: string): Node[] {
  const out: Node[] = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', text: buf }); buf = ''; } };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // Backslash escape: the next character is a literal, marker or not.
    if (ch === '\\' && i + 1 < src.length) { buf += src[i + 1]; i += 2; continue; }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) { flush(); out.push({ t: 'code', text: src.slice(i + 1, end) }); i = end + 1; continue; }
    }
    if (ch === '[') {
      const link = parseLink(src, i);
      if (link) { flush(); out.push(link.node); i = link.next; continue; }
    }
    let matched = false;
    for (const m of EMPHASIS_MARKS) {
      if (!src.startsWith(m.mark, i) || !opens(src, i, m)) continue;
      const close = findCloser(src, i + m.mark.length, m);
      if (close < 0) continue;
      flush();
      out.push({ t: m.t, kids: parseInline(src.slice(i + m.mark.length, close)) });
      i = close + m.mark.length;
      matched = true;
      break;
    }
    if (matched) continue;
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

// `[label](url)` — the label may itself be formatted; the url is taken verbatim.
function parseLink(src: string, i: number): { node: Node; next: number } | null {
  let depth = 0;
  let close = -1;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '\\') { j += 1; continue; }
    if (src[j] === '[') depth += 1;
    else if (src[j] === ']') { depth -= 1; if (depth === 0) { close = j; break; } }
  }
  if (close < 0 || src[close + 1] !== '(') return null;
  const urlEnd = src.indexOf(')', close + 2);
  if (urlEnd < 0) return null;
  const label = src.slice(i + 1, close);
  const url = src.slice(close + 2, urlEnd).trim();
  if (!label || !url || /\s/.test(url)) return null;
  return { node: { t: 'link', url, kids: parseInline(label) }, next: urlEnd + 1 };
}

// Block level: fenced code and '>' quotes are line-oriented, everything else
// falls through to the inline parser.
function parseBlocks(src: string): Node[] {
  const lines = src.split('\n');
  const out: Node[] = [];
  let plain: string[] = [];
  const flushPlain = () => {
    if (plain.length === 0) return;
    out.push(...parseInline(plain.join('\n')));
    plain = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j += 1) {
        if (/^```\s*$/.test(lines[j])) { closed = true; break; }
        body.push(lines[j]);
      }
      if (closed) {
        flushPlain();
        out.push({ t: 'pre', text: body.join('\n'), lang: fence[1].trim() });
        i = j;
        continue;
      }
      // Unterminated fence — treat the line as ordinary text.
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      let j = i;
      for (; j < lines.length && /^>\s?/.test(lines[j]); j += 1) body.push(lines[j].replace(/^>\s?/, ''));
      flushPlain();
      out.push({ t: 'quote', kids: parseInline(body.join('\n')) });
      i = j - 1;
      continue;
    }
    plain.push(line);
  }
  flushPlain();
  // Re-join the '\n' the block split consumed between sibling blocks.
  return out;
}

function renderNodes(nodes: Node[]): string {
  return nodes.map(renderNode).join('');
}

function renderNode(n: Node): string {
  switch (n.t) {
    case 'text': return escapeMarkdownV2(n.text);
    case 'bold': return `*${renderNodes(n.kids)}*`;
    case 'italic': return `_${renderNodes(n.kids)}_`;
    case 'underline': return `__${renderNodes(n.kids)}__`;
    case 'strike': return `~${renderNodes(n.kids)}~`;
    case 'spoiler': return `||${renderNodes(n.kids)}||`;
    case 'code': return `\`${escapeCode(n.text)}\``;
    case 'pre': return `\`\`\`${escapeCode(n.lang)}\n${escapeCode(n.text)}\n\`\`\``;
    case 'link': return `[${renderNodes(n.kids)}](${escapeUrl(n.url)})`;
    case 'quote': return renderNodes(n.kids).split('\n').map((l) => `>${l}`).join('\n');
  }
}

// Convert the agent's Markdown into a MarkdownV2 string with every text leaf
// escaped. Blocks are separated by the newline the block parse consumed.
export function toMarkdownV2(src: string): string {
  const blocks = parseBlocks(src);
  const parts: string[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    const prev = blocks[i - 1];
    // A pre/quote block was cut out of its surrounding text on a line boundary;
    // put that boundary back so the rendering keeps the original layout.
    if (i > 0 && (b.t === 'pre' || b.t === 'quote' || prev?.t === 'pre' || prev?.t === 'quote')) parts.push('\n');
    parts.push(renderNode(b));
  }
  return parts.join('');
}

// ----- length -----------------------------------------------------------------

// Telegram's per-message ceiling. Counted on the ESCAPED text, since that is what
// is actually sent — measuring the source would cut a long formatted message in
// the wrong place.
export const TELEGRAM_TEXT_LIMIT = 4096;

// The split itself lives in telegram.ts (splitForMarkdownV2): it splits the
// Markdown SOURCE rather than the rendered string, which is what lets the
// plain-text fallback resend a piece verbatim.

// Telegram's "unparseable markup" refusal, which the caller answers by resending
// the same text with no parse_mode (the message matters more than its styling).
export function isParseEntitiesError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /can't parse entities|can not parse entities|cant parse entities/i.test(msg);
}
