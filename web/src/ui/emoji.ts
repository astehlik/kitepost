import { getLanguage, t, type Lang } from '../i18n';
import { h } from './dom';

// Emoji names and keywords come from Unicode CLDR via emojibase, in the UI language, plus the
// GitHub shortcodes (:thumbsup:) that people type in any language. Loaded on first use.

export interface Emoji {
  unicode: string;
  label: string;
  group: number;
  shortcodes: string[];
  terms: string[];
}

export interface EmojiData {
  emojis: Emoji[];
  groups: { id: number; name: string }[];
  /** Hidden Emoji versions, undefined if support could not be detected. */
  unsupported?: string[];
}

const COMPONENT_GROUP = 2;

// One emoji per Emoji version that older fonts may lack, ZWJ sequences where a version only has those.
const VERSION_SAMPLES: Record<string, string> = {
  '12.1': '🧑‍🦰', '13': '🥲', '13.1': '😶‍🌫️', '14': '🫠', '15': '🫨', '15.1': '🙂‍↔️', '16': '🫩', '17': '🫪', '18': '🫫',
};

const REFERENCES = ['😀', '🦊', '🍕', '🚀'];

/** Whether `emoji` renders as one colored glyph; fonts without it show a box or split a sequence. */
function rendersAsEmoji(ctx: CanvasRenderingContext2D, emoji: string, width: number): boolean {
  if (ctx.measureText(emoji).width > width * 1.5) return false;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillText(emoji, 0, 0);
  const { data } = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 128 && Math.max(Math.abs(data[i] - data[i + 1]), Math.abs(data[i + 1] - data[i + 2])) > 40) return true;
  }
  return false;
}

/** Emoji versions this browser cannot display, e.g. Firefox's bundled font lags behind the system's. */
async function unsupportedVersions(): Promise<Set<string> | undefined> {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.canvas.width = ctx.canvas.height = 40;
  ctx.font = `32px ${getComputedStyle(document.body).fontFamily}`;
  ctx.textBaseline = 'top';
  await document.fonts.ready;
  // A fresh browser may still be loading its emoji font, which would look like missing support.
  for (let attempt = 0; attempt < 10; attempt++) {
    // Text fonts such as DejaVu Sans draw some emojis like 😀 in black, so one colored reference suffices.
    const reference = REFERENCES.find(e => rendersAsEmoji(ctx, e, Infinity));
    if (reference) {
      const width = ctx.measureText(reference).width;
      return new Set(Object.entries(VERSION_SAMPLES).filter(([, e]) => !rendersAsEmoji(ctx, e, width)).map(([v]) => v));
    }
    await new Promise(r => setTimeout(r, 100));
  }
  // Without a reliable reference, e.g. with canvas fingerprinting protection, hide nothing.
  return undefined;
}

const baseHexcode = (hex: string) => hex.replace(/-FE0F/g, '');
const cache = new Map<Lang, Promise<EmojiData>>();

async function fetchData(lang: Lang) {
  const [compact, messages, shortcodes, versions, unsupported] = await Promise.all([
    lang === 'de' ? import('emojibase-data/de/compact.json') : import('emojibase-data/en/compact.json'),
    lang === 'de' ? import('emojibase-data/de/messages.json') : import('emojibase-data/en/messages.json'),
    import('emojibase-data/en/shortcodes/github.json'),
    import('emojibase-data/versions/emoji.json'),
    unsupportedVersions(),
  ]);
  const hidden = new Set([...unsupported ?? []].flatMap(v => (versions.default as Record<string, string[]>)[v] ?? []).map(baseHexcode));
  return {
    compact: compact.default.filter(e => !hidden.has(baseHexcode(e.hexcode))),
    messages: messages.default,
    shortcodes: shortcodes.default as Record<string, string | string[]>,
    unsupported: unsupported && [...unsupported],
  };
}

export function loadEmojis(): Promise<EmojiData> {
  const lang = getLanguage();
  let data = cache.get(lang);
  if (!data) {
    data = fetchData(lang).then(({ compact, messages, shortcodes, unsupported }) => {
      const emojis = compact
        .filter(e => e.group !== undefined && e.group !== COMPONENT_GROUP)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(e => {
          const codes = shortcodes[e.hexcode] ?? [];
          const list = (Array.isArray(codes) ? codes : [codes]).map(c => c.toLowerCase());
          return {
            unicode: e.unicode, label: e.label, group: e.group!, shortcodes: list,
            terms: [e.label, ...(e.tags ?? [])].map(s => s.toLowerCase()),
          };
        });
      const groups = messages.groups
        .filter(g => g.order !== COMPONENT_GROUP && emojis.some(e => e.group === g.order))
        .map(g => ({ id: g.order, name: g.message }));
      return { emojis, groups, unsupported };
    });
    cache.set(lang, data);
  }
  return data;
}

/** Shortcode matches first, then names and keywords that start with the query, then any match. */
export function searchEmojis(emojis: Emoji[], query: string, limit = 50): Emoji[] {
  const q = query.trim().toLowerCase();
  if (!q) return emojis.slice(0, limit);
  const scored: [number, number, Emoji][] = [];
  emojis.forEach((e, i) => {
    let score = 0;
    if (e.shortcodes.includes(q)) score = 6;
    else if (e.terms[0] === q) score = 5;
    else if (e.shortcodes.some(c => c.startsWith(q))) score = 4;
    else if (e.terms.some(term => term.split(/[\s:-]+/).some(word => word.startsWith(q)))) score = 3;
    else if (e.terms.some(term => term.includes(q)) || e.shortcodes.some(c => c.includes(q))) score = 1;
    if (score) scored.push([score, i, e]);
  });
  return scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, limit).map(s => s[2]);
}

function emojiButton(e: Emoji, onPick: (emoji: string) => void) {
  return h('button', { type: 'button', class: 'emoji', title: e.label, 'aria-label': e.label, onclick: () => onPick(e.unicode) }, e.unicode);
}

/** A searchable emoji grid by category. */
export function emojiPicker(onPick: (emoji: string) => void): HTMLElement {
  const search = h('input', { type: 'search', placeholder: t('emoji.search'), 'aria-label': t('emoji.search') });
  const grid = h('div', { class: 'emoji-grid' }, h('p', { class: 'hint' }, t('emoji.loading')));
  const picker = h('div', { class: 'emoji-picker', role: 'dialog', 'aria-label': t('emoji.title') }, search, grid);
  void loadEmojis().then(({ emojis, groups, unsupported }) => {
    picker.dataset.unsupported = unsupported ? unsupported.join(' ') || 'none' : 'unknown';
    const render = () => {
      const q = search.value;
      if (q.trim()) {
        const found = searchEmojis(emojis, q, 120);
        grid.replaceChildren(found.length
          ? h('div', { class: 'emoji-row' }, ...found.map(e => emojiButton(e, onPick)))
          : h('p', { class: 'hint' }, t('emoji.none')));
        return;
      }
      grid.replaceChildren(...groups.flatMap(g => [
        h('h3', {}, g.name),
        h('div', { class: 'emoji-row' }, ...emojis.filter(e => e.group === g.id).map(e => emojiButton(e, onPick))),
      ]));
    };
    search.addEventListener('input', render);
    render();
  });
  setTimeout(() => search.focus());
  return picker;
}

/** Opens `content` above `anchor` and closes it on Escape, outside clicks or when `close` is called. */
export function popover(anchor: HTMLElement, content: HTMLElement): () => void {
  const box = h('div', { class: 'popover' }, content);
  const rect = anchor.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 340))}px`;
  box.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  const close = () => {
    box.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape, true);
  };
  const outside = (ev: Event) => { if (!box.contains(ev.target as Node) && ev.target !== anchor) close(); };
  const escape = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', escape, true);
  document.body.append(box);
  return close;
}

/** Inserts `text` at the cursor of `input`, replacing `from`..cursor. */
export function insertAtCursor(input: HTMLTextAreaElement, text: string, from = input.selectionStart) {
  const end = input.selectionEnd;
  input.setRangeText(text, from, end, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

/**
 * Suggests emojis while typing `:query` (at the start or after whitespace, so times and URLs
 * do not trigger it). Arrow keys choose, Enter or Tab insert, Escape closes.
 */
export function attachEmojiCompletion(input: HTMLTextAreaElement, container: HTMLElement) {
  const list = h('ul', { class: 'emoji-suggest', role: 'listbox', hidden: true });
  container.append(list);
  let matches: Emoji[] = [];
  let active = 0;
  let start = -1;

  const hide = () => { list.hidden = true; matches = []; };
  const pick = (e: Emoji) => {
    insertAtCursor(input, e.unicode, start);
    hide();
  };
  const render = () => {
    list.replaceChildren(...matches.map((e, i) => h('li', {
      role: 'option', class: i === active ? 'active' : '', 'aria-selected': String(i === active),
      onpointerdown: (ev: Event) => { ev.preventDefault(); pick(e); },
    }, h('span', { class: 'emoji' }, e.unicode), h('span', {}, e.shortcodes[0] ? `:${e.shortcodes[0]}:` : e.label))));
    list.hidden = !matches.length;
  };

  input.addEventListener('input', async () => {
    const before = input.value.slice(0, input.selectionStart);
    const m = /(?:^|\s):([\p{L}\p{N}_+-]{2,})$/u.exec(before);
    if (!m) return hide();
    start = input.selectionStart - m[1].length - 1;
    const { emojis } = await loadEmojis();
    matches = searchEmojis(emojis, m[1], 8);
    active = 0;
    render();
  });
  input.addEventListener('keydown', ev => {
    if (list.hidden || !matches.length) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      active = (active + (ev.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
      render();
    } else if (ev.key === 'Enter' || ev.key === 'Tab') {
      pick(matches[active]);
    } else if (ev.key === 'Escape') {
      hide();
    } else {
      return;
    }
    ev.preventDefault();
    ev.stopImmediatePropagation();
  });
  input.addEventListener('blur', () => setTimeout(hide, 100));
}
