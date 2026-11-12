const root = document.getElementById('admin');
let token = sessionStorage.getItem('invite-admin-token') ?? '';

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
    throw new Error('Wrong admin token');
  }
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

const fmt = ts => (ts ? new Date(ts).toLocaleString() : 'never');

function login(error) {
  const input = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Admin token' });
  root.replaceChildren(h('h1', {}, 'Invites'), h('form', {
    onsubmit: e => {
      e.preventDefault();
      token = input.value;
      sessionStorage.setItem('invite-admin-token', token);
      render();
    },
  }, input, ' ', h('button', { class: 'primary', type: 'submit' }, 'Sign in')), error ? h('p', { class: 'error' }, error) : null);
  input.focus();
}

async function render(created) {
  let list;
  try {
    list = await api('GET', 'api/invites');
  } catch (e) {
    return login(e.message);
  }
  const note = h('input', { name: 'note', maxlength: '200', placeholder: 'For whom? (shown on the invite page)' });
  const days = h('input', { name: 'days', type: 'number', min: '0', max: '365', value: '7' });
  const uses = h('input', { name: 'uses', type: 'number', min: '1', max: '100', value: '1' });
  const form = h('form', {
    class: 'grid',
    onsubmit: async e => {
      e.preventDefault();
      const inv = await api('POST', 'api/invites', { note: note.value, expiresDays: Number(days.value), uses: Number(uses.value) });
      render(new URL(inv.token, location.href).href);
    },
  },
  h('label', { class: 'wide' }, h('span', {}, 'Note'), note),
  h('label', {}, h('span', {}, 'Valid for days (0 = no expiry)'), days),
  h('label', {}, h('span', {}, 'Number of accounts'), uses),
  h('div', { class: 'wide' }, h('button', { class: 'primary', type: 'submit' }, 'Create invite link')));

  const box = created ? h('div', { class: 'created' },
    h('strong', {}, 'New invite link (shown only once):'), h('br'), h('code', { id: 'link' }, created), h('br'),
    h('button', { onclick: () => navigator.clipboard.writeText(created) }, 'Copy')) : null;

  const rows = list.map(inv => h('tr', {},
    h('td', {}, inv.note || h('span', { class: 'muted' }, '—')),
    h('td', {}, inv.revoked ? 'revoked' : inv.active ? `open (${inv.usesLeft} left)` : inv.usesLeft ? 'expired' : 'used'),
    h('td', {}, ...inv.redeemed.flatMap(r => [r.addr, h('br')])),
    h('td', { class: 'muted' }, `created ${fmt(inv.created)}`, h('br'), `expires ${fmt(inv.expires)}`),
    h('td', {}, inv.active ? h('button', { onclick: async () => { await api('DELETE', `api/invites/${inv.id}`); render(); } }, 'Revoke') : null)));

  root.replaceChildren(h('h1', {}, 'Invites'), form, box ?? '',
    h('table', {}, h('thead', {}, h('tr', {}, ...['Note', 'Status', 'Accounts', 'Dates', ''].map(t => h('th', {}, t)))), h('tbody', {}, ...rows)),
    h('p', {}, h('button', { onclick: () => { sessionStorage.removeItem('invite-admin-token'); token = ''; login(); } }, 'Sign out')));
}

token ? render() : login();
