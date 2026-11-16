const root = document.getElementById('admin');

// The server renders the page in the request's language.
const MESSAGES = {
  en: {
    wrongToken: 'Wrong admin token', failed: 'Request failed ({status})', token: 'Admin token', title: 'Invites', signIn: 'Sign in',
    notePlaceholder: 'For whom? (shown on the invite page)', note: 'Note', days: 'Valid for days (0 = no expiry)',
    uses: 'Number of accounts', create: 'Create invite link', created: 'New invite link (shown only once):', copy: 'Copy', copied: 'Copied ✓', copyFailed: 'Link selected, copy it with Ctrl+C',
    revoke: 'Revoke', status: 'Status', accounts: 'Accounts', valid: 'Valid', signOut: 'Sign out', never: 'never',
    revoked: 'revoked', open: 'open · {n} left', expired: 'expired', used: 'used',
  },
  de: {
    wrongToken: 'Falsches Admin-Token', failed: 'Anfrage fehlgeschlagen ({status})', token: 'Admin-Token', title: 'Einladungen', signIn: 'Anmelden',
    notePlaceholder: 'Für wen? (steht auf der Einladungsseite)', note: 'Notiz', days: 'Gültig für Tage (0 = unbegrenzt)',
    uses: 'Anzahl Konten', create: 'Einladungslink erstellen', created: 'Neuer Einladungslink (wird nur einmal angezeigt):', copy: 'Kopieren', copied: 'Kopiert ✓', copyFailed: 'Link markiert, mit Strg+C kopieren',
    revoke: 'Widerrufen', status: 'Status', accounts: 'Konten', valid: 'Gültig', signOut: 'Abmelden', never: 'nie',
    revoked: 'widerrufen', open: 'offen · noch {n}', expired: 'abgelaufen', used: 'benutzt',
  },
};
const lang = document.documentElement.lang in MESSAGES ? document.documentElement.lang : 'en';
const T = (key, params = {}) => MESSAGES[lang][key].replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
let token = sessionStorage.getItem('invite-admin-token') ?? '';

/** Disables `button` while `job` runs and shows a failure in `errorBox`. */
async function whileBusy(button, job, errorBox) {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (errorBox) errorBox.hidden = true;
  try {
    await job();
  } catch (e) {
    if (!token) return login(e.message);
    errorBox.textContent = e.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

async function copyLink(button, text) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = T('copied');
  } catch {
    // The clipboard API needs a secure context and permission; fall back to a selection.
    getSelection().selectAllChildren(document.getElementById('link'));
    button.textContent = T('copyFailed');
  }
  clearTimeout(button.reset);
  button.reset = setTimeout(() => { button.textContent = T('copy'); }, 2500);
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    sessionStorage.removeItem('invite-admin-token');
    token = '';
    throw new Error(T('wrongToken'));
  }
  if (!res.ok) throw new Error(T('failed', { status: res.status }));
  return res.json();
}

// Long addresses may only wrap before the @.
const addrParts = addr => { const i = addr.lastIndexOf('@'); return i > 0 ? [addr.slice(0, i), h('wbr'), addr.slice(i)] : [addr]; };
const fmt = ts => (ts ? new Date(ts).toLocaleDateString(lang, { dateStyle: 'medium' }) : T('never'));

function login(error) {
  const input = h('input', { type: 'password', autocomplete: 'current-password', placeholder: T('token') });
  const submit = h('button', { class: 'primary', type: 'submit' }, T('signIn'));
  const children = [h('h1', {}, T('title')), h('form', {
    class: 'signin',
    onsubmit: e => {
      e.preventDefault();
      token = input.value;
      sessionStorage.setItem('invite-admin-token', token);
      whileBusy(submit, render);
    },
  }, input, submit)];
  if (error) children.push(h('p', { class: 'error' }, error));
  root.replaceChildren(...children);
  input.focus();
}

async function render(created) {
  let list;
  try {
    list = await api('GET', 'api/invites');
  } catch (e) {
    return login(e.message);
  }
  const note = h('input', { name: 'note', maxlength: '200', placeholder: T('notePlaceholder') });
  const days = h('input', { name: 'days', type: 'number', min: '0', max: '365', value: '7' });
  const uses = h('input', { name: 'uses', type: 'number', min: '1', max: '100', value: '1' });
  const error = h('p', { class: 'error', hidden: true });
  const submit = h('button', { class: 'primary', type: 'submit' }, T('create'));
  const form = h('form', {
    class: 'grid',
    onsubmit: e => {
      e.preventDefault();
      whileBusy(submit, async () => {
        const inv = await api('POST', 'api/invites', { note: note.value, expiresDays: Number(days.value), uses: Number(uses.value) });
        await render(new URL(inv.token, location.href).href);
      }, error);
    },
  },
  h('label', { class: 'wide' }, h('span', {}, T('note')), note),
  h('label', {}, h('span', {}, T('days')), days),
  h('label', {}, h('span', {}, T('uses')), uses),
  h('div', { class: 'wide' }, submit));

  const box = created ? h('div', { class: 'created' },
    h('strong', {}, T('created')),
    h('div', { class: 'linkrow' }, h('code', { id: 'link' }, created),
      h('button', { onclick: e => copyLink(e.currentTarget, created) }, T('copy')))) : null;

  const rows = list.map(inv => h('tr', {},
    h('td', {}, inv.note || h('span', { class: 'muted' }, '—')),
    h('td', { class: 'status' }, T(inv.revoked ? 'revoked' : inv.active ? 'open' : inv.usesLeft ? 'expired' : 'used', { n: inv.usesLeft })),
    h('td', { class: 'accounts' }, ...inv.redeemed.flatMap(r => [...addrParts(r.addr), h('br')])),
    h('td', { class: 'muted dates' }, h('span', {}, `${fmt(inv.created)} –`), ' ', h('span', {}, fmt(inv.expires))),
    h('td', { class: 'action' }, inv.active ? h('button', {
      class: 'compact',
      onclick: e => whileBusy(e.currentTarget, async () => { await api('DELETE', `api/invites/${inv.id}`); await render(); }, error),
    }, T('revoke')) : null)));

  root.replaceChildren(h('h1', {}, T('title')), form, error, ...(box ? [box] : []),
    h('table', {}, h('thead', {}, h('tr', {}, ...[T('note'), T('status'), T('accounts'), T('valid'), ''].map(t => h('th', {}, t)))), h('tbody', {}, ...rows)),
    h('p', {}, h('button', { onclick: () => { sessionStorage.removeItem('invite-admin-token'); token = ''; login(); } }, T('signOut'))));
}

token ? render() : login();
