import { de } from './de';
import { en } from './en';

export type Lang = 'en' | 'de';
export type Key = keyof typeof en;

export const LANGUAGES: Record<Lang, string> = { en: 'English', de: 'Deutsch' };
const MESSAGES: Record<Lang, Record<Key, string>> = { en, de };
const STORAGE_KEY = 'kitepost-lang';
// Shared with the landing page and the invite pages on the same host.
const COOKIE = 'kitepost_lang';

function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && v in MESSAGES;
}

/** The saved choice, otherwise the first supported browser language, otherwise English. */
function detect(): Lang {
  const cookie = new RegExp(`(?:^|; )${COOKIE}=(\\w+)`).exec(document.cookie)?.[1];
  if (isLang(cookie)) return cookie;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    // Storage can be blocked.
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.toLowerCase().split('-')[0];
    if (isLang(base)) return base;
  }
  return 'en';
}

let lang: Lang = detect();
document.documentElement.lang = lang;

export function getLanguage(): Lang {
  return lang;
}

export function setLanguage(next: Lang) {
  lang = next;
  document.documentElement.lang = next;
  document.cookie = `${COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // The choice then only lasts until the page is reloaded.
  }
}

export function t(key: Key, params: Record<string, string | number> = {}): string {
  return MESSAGES[lang][key].replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}
