export interface TextPart {
  text: string;
  href?: string;
  /** Set for an email address; `href` is then its mailto: link. */
  addr?: string;
  /** The address can imitate another one: an internationalized domain or a user name before the host. */
  suspicious?: boolean;
}

// Like Delta Chat's message parser, a link needs its scheme. Invisible formatting characters end it,
// so that e.g. a right-to-left override cannot disguise where it leads.
const LINK = /\bhttps?:\/\/[^\s<>"`\p{Cc}\p{Cf}]+/giu;
const LABEL = '[\\p{L}\\p{N}_](?:[\\p{L}\\p{N}_-]*[\\p{L}\\p{N}])?';
const EMAIL = new RegExp(`(?<![\\p{L}\\p{N}+._%@-])[\\p{L}\\p{N}+_%-]+(?:\\.[\\p{L}\\p{N}+_%-]+)*@${LABEL}(?:\\.${LABEL})+`, 'gu');
const TRAILING = new Set([...'.,:;!?\'"’”*_~']);
const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

const count = (s: string, c: string) => s.split(c).length - 1;

function trimEnd(raw: string): string {
  let s = raw;
  for (;;) {
    const last = s.at(-1) ?? '';
    const open = PAIRS[last];
    const unbalanced = open !== undefined && count(s, last) > count(s, open);
    if (!TRAILING.has(last) && !unbalanced) return s;
    s = s.slice(0, -1);
  }
}

function splitAddresses(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let pos = 0;
  for (const m of text.matchAll(EMAIL)) {
    if (m.index > pos) parts.push({ text: text.slice(pos, m.index) });
    parts.push({ text: m[0], href: `mailto:${m[0]}`, addr: m[0] });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos) });
  return parts;
}

export function splitLinks(text: string): TextPart[] {
  return splitUrls(text).flatMap(p => p.href ? [p] : splitAddresses(p.text));
}

function splitUrls(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let pos = 0;
  for (const m of text.matchAll(LINK)) {
    const raw = trimEnd(m[0]);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (!url.hostname) continue;
    if (m.index > pos) parts.push({ text: text.slice(pos, m.index) });
    const suspicious = url.hostname.split('.').some(l => l.startsWith('xn--')) || !!url.username || !!url.password;
    parts.push({ text: raw, href: url.href, ...suspicious ? { suspicious } : {} });
    pos = m.index + raw.length;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos) });
  return parts;
}
