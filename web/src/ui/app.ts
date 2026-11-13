import { DcClient } from '../dc/client';
import type { Chat, Message } from '../dc/types';
import { Store } from '../store';
import { qrSvg, type AttachmentData } from '../wasm';
import { base64ToBlob, blobToBase64, clear, dialog, formatTime, h, trustedSvg } from './dom';

// Relative so the client works under any subdirectory, e.g. /app/ -> /bridge.
let DEFAULT_RELAY = 'nine.testrun.org';
let DEFAULT_BRIDGE = '../bridge';
const MAX_UPLOAD = 10 * 1024 * 1024;
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const root = () => document.getElementById('app')!;

function randomAlnum(n: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const out: string[] = [];
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
      if (b < 252 && out.length < n) out.push(alphabet[b % 36]);
    }
  }
  return out.join('');
}

function field(label: string, input: HTMLElement, hint?: string) {
  return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', {}, hint) : null);
}

function errorBox() {
  return h('p', { class: 'error', hidden: true });
}

function showError(box: HTMLElement, e: unknown) {
  box.textContent = e instanceof Error ? e.message : String(e);
  box.hidden = false;
}

// ------------------------------------------------------------------ lock & onboarding

async function loadRuntimeConfig() {
  try {
    const res = await fetch('./config.json', { cache: 'no-store' });
    if (!res.ok) return;
    const cfg = await res.json();
    if (typeof cfg.bridgeUrl === 'string' && cfg.bridgeUrl) DEFAULT_BRIDGE = cfg.bridgeUrl;
    if (typeof cfg.defaultRelay === 'string' && cfg.defaultRelay) DEFAULT_RELAY = cfg.defaultRelay;
  } catch {
    // Optional file.
  }
}

interface Login {
  addr: string;
  password: string;
}

// Credentials from an invite page arrive in the fragment, which never reaches a server.
function takeLoginFromUrl(): Login | undefined {
  const m = /[#&]login=([^&]+)/.exec(location.hash);
  if (!m) return undefined;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const [target, query = ''] = decodeURIComponent(m[1]).replace(/^dclogin:(\/\/)?/i, '').split('?', 2);
    const addr = decodeURIComponent(target.replace(/\/$/, '')).trim().toLowerCase();
    const password = new URLSearchParams(query).get('p') ?? '';
    return /^[^@\s]+@[^@\s]+$/.test(addr) && password ? { addr, password } : undefined;
  } catch {
    return undefined;
  }
}

let pendingLogin: Login | undefined;

export async function boot() {
  pendingLogin = takeLoginFromUrl();
  await loadRuntimeConfig();
  if (await Store.exists()) renderUnlock();
  else renderPassphraseSetup();
}

function screen(title: string, ...content: Node[]) {
  clear(root());
  root().append(h('main', { class: 'onboarding' }, h('div', { class: 'card' }, h('h1', {}, title), ...content)));
}

function renderUnlock() {
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const err = errorBox();
  const form = h('form', {
    onsubmit: async (ev: Event) => {
      ev.preventDefault();
      form.classList.add('busy');
      try {
        const store = await Store.unlock(pass.value);
        const client = await DcClient.load(store);
        if (client) startMain(client);
        else renderAccountSetup(store);
      } catch (e) {
        showError(err, e);
      } finally {
        form.classList.remove('busy');
      }
    },
  },
  field('Passphrase', pass),
  err,
  h('button', { class: 'primary', type: 'submit' }, 'Unlock'),
  h('button', {
    type: 'button', class: 'link danger',
    onclick: () => dialog('Delete profile?', h('p', {}, 'All messages and keys stored in this browser will be erased. This cannot be undone.'), [
      { label: 'Cancel' },
      { label: 'Delete', primary: true, onClick: async () => { await Store.destroy(); location.reload(); } },
    ]),
  }, 'Forgot passphrase? Delete profile'));
  screen('Unlock Kitepost', form);
  pass.focus();
}

function renderPassphraseSetup() {
  const pass = h('input', { type: 'password', autocomplete: 'new-password', minlength: '10', required: true });
  const pass2 = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const err = errorBox();
  const form = h('form', {
    onsubmit: async (ev: Event) => {
      ev.preventDefault();
      if (pass.value !== pass2.value) return showError(err, 'Passphrases do not match');
      form.classList.add('busy');
      try {
        renderAccountSetup(await Store.create(pass.value));
      } catch (e) {
        showError(err, e);
        form.classList.remove('busy');
      }
    },
  },
  h('p', {}, 'Your keys and messages are stored encrypted in this browser. Choose a passphrase to protect them; it never leaves this device.'),
  field('Passphrase', pass, 'At least 10 characters.'),
  field('Repeat passphrase', pass2),
  err,
  h('button', { class: 'primary', type: 'submit' }, 'Continue'));
  screen('Welcome to Kitepost', form);
  pass.focus();
}

function renderAccountSetup(store: Store) {
  const name = h('input', { type: 'text', maxlength: '100', placeholder: 'Your name' });
  const relay = h('input', { type: 'text', value: DEFAULT_RELAY, required: true, spellcheck: 'false' });
  const existing = h('input', { type: 'checkbox' });
  const addr = h('input', { type: 'text', inputmode: 'email', spellcheck: 'false', placeholder: 'you@example.org', autocomplete: 'username' });
  const password = h('input', { type: 'password', autocomplete: 'current-password' });
  const bridge = h('input', { type: 'text', value: DEFAULT_BRIDGE, spellcheck: 'false' });
  const existingFields = h('div', { hidden: true }, field('E-mail address', addr), field('Password', password));
  const relayField = field('Chatmail relay', relay, 'A new random address is created on this relay.');
  existing.addEventListener('change', () => {
    existingFields.hidden = !existing.checked;
    relayField.hidden = existing.checked;
  });
  if (pendingLogin) {
    existing.checked = true;
    addr.value = pendingLogin.addr;
    password.value = pendingLogin.password;
    existingFields.hidden = false;
    relayField.hidden = true;
    pendingLogin = undefined;
  }
  const err = errorBox();
  const form = h('form', {
    onsubmit: async (ev: Event) => {
      ev.preventDefault();
      form.classList.add('busy');
      try {
        const params = existing.checked
          ? { addr: addr.value, password: password.value }
          : { addr: `${randomAlnum(9)}@${relay.value.trim().toLowerCase()}`, password: randomAlnum(22) };
        const client = await DcClient.setup(store, { ...params, displayName: name.value, bridgeUrl: bridge.value.trim() || DEFAULT_BRIDGE });
        await renderConnectPhone(client);
      } catch (e) {
        showError(err, e);
      } finally {
        form.classList.remove('busy');
      }
    },
  },
  field('Display name', name),
  relayField,
  h('label', { class: 'check' }, existing, 'Use an existing chatmail or e-mail address'),
  existingFields,
  h('details', {}, h('summary', {}, 'Advanced'), field('Bridge URL', bridge, 'WebSocket bridge that relays the end-to-end TLS stream.')),
  err,
  h('button', { class: 'primary', type: 'submit' }, 'Create profile'));
  screen('Set up your profile', form);
  name.focus();
}

async function renderConnectPhone(client: DcClient) {
  const link = await client.inviteLink();
  const done = () => {
    client.removeEventListener('change', onChange);
    startMain(client);
  };
  // The handshake runs over IMAP, so the client must already be online while the code is shown.
  const onChange = (ev: Event) => { if ((ev as CustomEvent<string>).detail === 'chats' && client.chats.size) done(); };
  client.addEventListener('change', onChange);
  client.start();
  screen('Connect your phone',
    h('p', {}, 'Open Delta Chat on your phone, tap the QR code button and scan this code. Your phone and Kitepost become verified contacts, so you can message between them right away.'),
    h('div', { class: 'qr' }, trustedSvg(qrSvg(link))),
    h('input', { type: 'text', readonly: true, value: link, 'aria-label': 'Invite link', onfocus: (e: Event) => (e.target as HTMLInputElement).select() }),
    h('p', {}, h('small', {}, 'No Delta Chat yet? Get it from delta.chat, or skip this and share your invite later via My invite.')),
    h('button', { class: 'primary', onclick: done }, 'Continue'));
}

// ------------------------------------------------------------------ main view

function startMain(client: DcClient) {
  let current: string | undefined;
  const objectUrls: string[] = [];

  const status = h('span', { class: 'status' });
  const chatList = h('ul', { class: 'chatlist' });
  const pane = h('section', { class: 'pane' });
  const sidebar = h('aside', { class: 'sidebar' },
    h('header', { class: 'profile' },
      h('div', { class: 'who' }, h('strong', {}, client.config.displayName || 'Me'), h('small', {}, client.config.addr)),
      status),
    h('div', { class: 'toolbar' },
      h('button', { onclick: () => showInvite(client) }, 'My invite'),
      h('button', { onclick: () => joinDialog(client, open) }, 'Add contact'),
      h('button', { onclick: () => groupDialog(client, open) }, 'New group'),
      h('button', { onclick: () => profileDialog(client) }, 'Profile')),
    chatList);
  clear(root());
  root().append(h('div', { class: 'layout' }, sidebar, pane));

  function renderStatus() {
    status.textContent = client.status === 'connected' ? '● online' : client.status === 'connecting' ? '○ connecting' : '○ offline';
    status.title = client.status;
    status.className = `status ${client.status === 'connected' ? 'ok' : ''}`;
  }

  function renderList() {
    clear(chatList);
    let unread = 0;
    for (const chat of client.sortedChats()) {
      unread += chat.unread;
      const msgs = client.messages.get(chat.id) ?? [];
      const last = msgs[msgs.length - 1];
      chatList.append(h('li', { class: chat.id === current ? 'active' : '', onclick: () => open(chat.id) },
        h('div', { class: 'row' },
          h('strong', {}, client.chatTitle(chat) || '…'),
          chat.unread ? h('span', { class: 'badge' }, String(chat.unread)) : null),
        h('small', {}, chat.isRequest ? 'Contact request' : last ? `${last.from === 'self' && !last.info ? 'Me: ' : ''}${last.text || (last.attachments[0]?.filename ?? '')}` : '')));
    }
    if (!chatList.children.length) chatList.append(h('li', { class: 'empty' }, 'No chats yet. Share your invite link or add a contact.'));
    document.title = unread ? `(${unread}) Kitepost` : 'Kitepost';
  }

  function attachmentView(a: AttachmentData): Node {
    const safeImage = INLINE_IMAGE_TYPES.has(a.mime);
    const url = URL.createObjectURL(base64ToBlob(a.data_b64, safeImage ? a.mime : 'application/octet-stream'));
    objectUrls.push(url);
    const link = h('a', { href: url, download: a.filename, rel: 'noopener' }, `📎 ${a.filename}`);
    return safeImage ? h('div', { class: 'attachment' }, h('img', { src: url, alt: a.filename }), link) : h('div', { class: 'attachment' }, link);
  }

  function messageView(chat: Chat, m: Message): Node {
    if (m.info) return h('div', { class: 'info' }, m.text);
    const out = m.from === 'self';
    const reactions = Object.values(m.reactions);
    const state = out ? { pending: '⏳', sent: '✓', read: '✓✓', failed: '⚠', received: '' }[m.state] : '';
    return h('div', { class: `msg ${out ? 'out' : 'in'}` },
      !out && chat.type === 'group' ? h('div', { class: 'sender' }, client.contactName(m.from)) : null,
      ...m.attachments.map(attachmentView),
      m.text ? h('div', { class: 'text' }, m.text) : null,
      h('div', { class: 'meta' }, m.edited ? 'edited · ' : '', formatTime(m.timestamp), state ? ` ${state}` : '', m.error ? ` ${m.error}` : ''),
      reactions.length ? h('div', { class: 'reactions' }, reactions.join(' ')) : null);
  }

  function renderPane() {
    for (const u of objectUrls.splice(0)) URL.revokeObjectURL(u);
    clear(pane);
    const chat = current ? client.chats.get(current) : undefined;
    if (!chat) {
      pane.append(h('div', { class: 'placeholder' }, h('p', {}, 'Select a chat.'), h('p', {}, 'Everything is end-to-end encrypted and decrypted only in this browser.')));
      return;
    }
    const contact = chat.contact ? client.contacts.get(chat.contact) : undefined;
    const subtitle = chat.type === 'group'
      ? `${chat.members.length + 1} members`
      : contact ? `${contact.addr}${contact.verified ? ' · ✔ verified' : ''}` : '';
    const header = h('header', { class: 'chathead' },
      h('button', { class: 'back', onclick: () => { current = undefined; renderAll(); } }, '‹'),
      h('div', { class: 'who' }, h('strong', {}, client.chatTitle(chat)), h('small', {}, subtitle)),
      chat.type === 'group' ? h('button', { onclick: () => showInvite(client, chat.id) }, 'Invite link') : null,
      contact ? h('button', { onclick: () => fingerprintDialog(client, contact.fingerprint) }, 'Encryption') : null,
      h('button', { onclick: () => dialog('Delete chat?', h('p', {}, 'Messages are deleted from this browser only.'), [
        { label: 'Cancel' },
        { label: 'Delete', primary: true, onClick: async () => { await client.deleteChat(chat.id); current = undefined; renderAll(); } },
      ]) }, 'Delete'));

    const list = h('div', { class: 'messages' });
    for (const m of client.messages.get(chat.id) ?? []) list.append(messageView(chat, m));

    const request = chat.isRequest
      ? h('div', { class: 'request' },
        h('span', {}, 'This is a contact request. Accept it to reply.'),
        h('button', { class: 'primary', onclick: () => client.acceptChat(chat.id) }, 'Accept'),
        h('button', { onclick: async () => { await client.blockChat(chat.id); current = undefined; renderAll(); } }, 'Block'))
      : null;

    pane.append(header, list, request ?? composer(chat));
    list.scrollTop = list.scrollHeight;
    void client.markRead(chat.id);
  }

  function composer(chat: Chat): Node {
    let attachment: AttachmentData | undefined;
    const input = h('textarea', { rows: '1', placeholder: chat.left ? 'You are not a member of this group' : 'Message', disabled: chat.left });
    const file = h('input', { type: 'file', hidden: true });
    const chip = h('span', { class: 'chip', hidden: true });
    const send = async () => {
      const text = input.value.trim();
      if (!text && !attachment) return;
      const att = attachment;
      input.value = '';
      attachment = undefined;
      chip.hidden = true;
      try {
        await client.sendText(chat.id, text, att);
      } catch (e) {
        console.warn(e);
      }
    };
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      if (f.size > MAX_UPLOAD) return void dialog('File too large', h('p', {}, 'Files up to 10 MB can be sent.'), [{ label: 'OK' }]);
      attachment = { filename: f.name.replace(/[\\/\p{Cc}]/gu, '_'), mime: f.type || 'application/octet-stream', data_b64: await blobToBase64(f) };
      chip.textContent = `📎 ${attachment.filename} ✕`;
      chip.hidden = false;
    });
    chip.addEventListener('click', () => { attachment = undefined; chip.hidden = true; });
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        void send();
      }
    });
    return h('footer', { class: 'composer' },
      h('button', { class: 'icon', title: 'Attach file', disabled: chat.left, onclick: () => file.click() }, '📎'),
      h('div', { class: 'grow' }, chip, input), file,
      h('button', { class: 'primary', disabled: chat.left, onclick: send }, 'Send'));
  }

  function open(chatId: string) {
    current = chatId;
    renderAll();
  }

  function renderAll() {
    root().querySelector('.layout')?.classList.toggle('chat-open', !!current);
    renderList();
    renderPane();
    renderStatus();
  }

  client.addEventListener('change', ev => {
    const what = (ev as CustomEvent<string>).detail;
    if (what === 'status') return renderStatus();
    renderList();
    if (what === 'chats' || what === `messages:${current}` || what === 'config') {
      const draft = pane.querySelector('textarea')?.value;
      renderPane();
      const ta = pane.querySelector('textarea');
      if (ta && draft) ta.value = draft;
    }
  });
  client.addEventListener('incoming', ev => {
    const { chatId } = (ev as CustomEvent<{ chatId: string }>).detail;
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const chat = client.chats.get(chatId);
      if (chat && !chat.isRequest) new Notification(client.chatTitle(chat), { body: 'New message' });
    }
  });
  if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) client.poke(); });
  renderAll();
  client.start();
}

// ------------------------------------------------------------------ dialogs

async function showInvite(client: DcClient, chatId?: string) {
  const link = await client.inviteLink(chatId);
  const body = h('div', { class: 'invite' },
    h('p', {}, chatId
      ? 'Anyone with this link can join the group. Share it only through a channel you trust.'
      : 'Share this link or let the other person scan the QR code with Delta Chat. Whoever uses it gets a verified, end-to-end encrypted connection to you.'),
    h('div', { class: 'qr' }, trustedSvg(qrSvg(link))),
    h('input', { type: 'text', readonly: true, value: link, onfocus: (e: Event) => (e.target as HTMLInputElement).select() }));
  dialog(chatId ? 'Group invite' : 'My invite', body, [
    { label: 'Copy link', onClick: async () => { await navigator.clipboard.writeText(link); return false; } },
    { label: 'Close', primary: true },
  ]);
}

function joinDialog(client: DcClient, open: (id: string) => void) {
  const input = h('textarea', { rows: '3', placeholder: 'https://i.delta.chat/#…', spellcheck: 'false' });
  dialog('Add contact or join group', h('div', {}, h('p', {}, 'Paste an invite link from Delta Chat.'), input), [
    { label: 'Cancel' },
    { label: 'Connect', primary: true, onClick: async () => open(await client.joinInvite(input.value)) },
  ]);
  input.focus();
}

function groupDialog(client: DcClient, open: (id: string) => void) {
  const name = h('input', { type: 'text', maxlength: '100', placeholder: 'Group name' });
  const boxes = [...client.contacts.values()]
    .filter(c => c.publicKey && !c.blocked)
    .map(c => ({ fp: c.fingerprint, box: h('input', { type: 'checkbox' }), label: c.name || c.addr }));
  const list = h('div', { class: 'members' }, ...boxes.map(b => h('label', { class: 'check' }, b.box, b.label)));
  if (!boxes.length) list.append(h('p', {}, 'Add contacts first.'));
  dialog('New group', h('div', {}, field('Name', name), list), [
    { label: 'Cancel' },
    {
      label: 'Create', primary: true, onClick: async () => {
        if (!name.value.trim()) throw new Error('Please enter a name');
        open(await client.createGroup(name.value, boxes.filter(b => b.box.checked).map(b => b.fp)));
      },
    },
  ]);
  name.focus();
}

function formatFingerprint(fp: string): string {
  return (fp.match(/.{1,4}/g) ?? []).join(' ');
}

function fingerprintDialog(client: DcClient, fp: string) {
  const c = client.contacts.get(fp);
  dialog('End-to-end encryption', h('div', { class: 'fingerprints' },
    h('p', {}, c?.verified ? '✔ Verified through an invite link.' : 'Not verified. Compare fingerprints in person or connect via an invite link.'),
    h('h3', {}, client.config.displayName || 'Me'), h('code', {}, formatFingerprint(client.config.fingerprint)),
    h('h3', {}, client.contactName(fp)), h('code', {}, formatFingerprint(fp))), [{ label: 'Close', primary: true }]);
}

function profileDialog(client: DcClient) {
  const name = h('input', { type: 'text', maxlength: '100', value: client.config.displayName });
  dialog('Profile', h('div', {},
    field('Display name', name),
    h('p', {}, h('small', {}, `Address: ${client.config.addr}`)),
    h('p', {}, h('small', {}, `Fingerprint: ${formatFingerprint(client.config.fingerprint)}`))), [
    { label: 'Lock', onClick: () => location.reload() },
    { label: 'Save', primary: true, onClick: () => client.setDisplayName(name.value) },
  ]);
}

