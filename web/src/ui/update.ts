import { t } from '../i18n';
import { h } from './dom';

const CHECK_INTERVAL = 15 * 60_000;

// Built file names carry content hashes, so they change with every deployed version.
function assetsOf(doc: Document): string {
  return [...doc.querySelectorAll('script[type=module][src], link[rel=stylesheet][href]')]
    .map(el => new URL(el.getAttribute('src') ?? el.getAttribute('href') ?? '', document.baseURI).pathname)
    .sort()
    .join(' ');
}

// Taken at startup, before lazily loaded chunks add their own stylesheets.
const running = assetsOf(document);
let bar: HTMLElement | undefined;

export async function checkForUpdate() {
  if (bar || !running) return;
  try {
    const res = await fetch(new URL('index.html', document.baseURI), { cache: 'no-store' });
    if (!res.ok) return;
    const latest = assetsOf(new DOMParser().parseFromString(await res.text(), 'text/html'));
    if (latest && latest !== running) showBar();
  } catch {
    // Offline: the next trigger checks again.
  }
}

function showBar() {
  if (bar) return;
  const el = h('div', { class: 'update-bar', role: 'status' });
  const render = () => el.replaceChildren(
    h('span', {}, h('strong', {}, t('update.available')), ' ', h('small', {}, t('update.hint'))),
    h('button', { class: 'primary', onclick: () => location.reload() }, t('update.reload')));
  render();
  // setLanguage() sets <html lang>; the bar lives outside #app, which is rebuilt on a switch.
  new MutationObserver(render).observe(document.documentElement, { attributeFilter: ['lang'] });
  document.body.prepend(el);
  bar = el;
}

export function watchForUpdates() {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void checkForUpdate(); });
  // Files of the old version are gone after a deploy, so lazy loading fails until a reload.
  window.addEventListener('vite:preloadError', () => void checkForUpdate());
  setInterval(() => void checkForUpdate(), CHECK_INTERVAL);
}
