import { getLanguage } from '../i18n';
type Child = Node | string | false | null | undefined;
type Attrs = Record<string, string | boolean | ((ev: Event) => void) | undefined>;

/** Creates an element. Strings become text nodes, never HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

export function clear(el: Element) {
  el.replaceChildren();
}

/** Disables `button` and marks it busy while `job` runs; clicks meanwhile are ignored. */
export async function whileBusy<T>(button: HTMLButtonElement, job: () => Promise<T>): Promise<T | undefined> {
  if (button.getAttribute('aria-busy') === 'true') return undefined;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    return await job();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

/** Shows `text` on `button` for a moment, e.g. "Copied". */
export function flashLabel(button: HTMLButtonElement, text: string) {
  const label = button.dataset.label ?? button.textContent ?? '';
  button.dataset.label = label;
  button.textContent = text;
  clearTimeout(Number(button.dataset.timer));
  button.dataset.timer = String(setTimeout(() => { button.textContent = label; delete button.dataset.label; }, 2500));
}

type DialogAction = { label: string; primary?: boolean; onClick?: (button: HTMLButtonElement) => boolean | void | Promise<boolean | void> };

export function dialog(title: string, body: Node, actions: DialogAction[]) {
  const dlg = h('dialog', { class: 'dialog' });
  const error = h('p', { class: 'error', hidden: true });
  let running = false;
  const buttons: HTMLButtonElement[] = actions.map(a => {
    const button = h('button', { class: a.primary ? 'primary' : '' }, a.label);
    button.addEventListener('click', async () => {
      if (running) return;
      running = true;
      error.hidden = true;
      for (const b of buttons) b.disabled = true;
      button.setAttribute('aria-busy', 'true');
      try {
        if ((await a.onClick?.(button)) !== false) dlg.close();
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
        error.hidden = false;
      } finally {
        running = false;
        for (const b of buttons) b.disabled = false;
        button.removeAttribute('aria-busy');
      }
    });
    return button;
  });
  // Escape would close the dialog while its action is still running.
  dlg.addEventListener('cancel', ev => { if (running) ev.preventDefault(); });
  dlg.append(h('h2', {}, title), body, error, h('div', { class: 'actions' }, ...buttons));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

/** Inserts an SVG that our own WASM generated from a fixed template. */
export function trustedSvg(svg: string): Element {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName !== 'svg' || root.querySelector('script,foreignObject')) throw new Error('bad svg');
  return document.importNode(root, true);
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(getLanguage(), { dateStyle: 'medium', timeStyle: 'medium' });
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(getLanguage(), { day: 'numeric', month: 'short' });
}

export function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export function blobToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',', 2)[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
