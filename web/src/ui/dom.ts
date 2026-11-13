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

export function dialog(title: string, body: Node, actions: { label: string; primary?: boolean; onClick?: () => boolean | void | Promise<boolean | void> }[]) {
  const dlg = h('dialog', { class: 'dialog' });
  const error = h('p', { class: 'error', hidden: true });
  const buttons = actions.map(a =>
    h('button', {
      class: a.primary ? 'primary' : '',
      onclick: async () => {
        error.hidden = true;
        try {
          if ((await a.onClick?.()) !== false) dlg.close();
        } catch (e) {
          error.textContent = e instanceof Error ? e.message : String(e);
          error.hidden = false;
        }
      },
    }, a.label),
  );
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
