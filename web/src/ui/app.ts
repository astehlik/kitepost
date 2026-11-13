import { fileReader, readBackup } from '../dc/backup';
import { DcClient } from '../dc/client';
import type { Chat, Message } from '../dc/types';
import { getLanguage, LANGUAGES, setLanguage, t, type Lang } from '../i18n';
import { Store } from '../store';
import { importKeypair, publicKeyInfo, qrSvg, type AttachmentData } from '../wasm';
import { base64ToBlob, blobToBase64, clear, dialog, formatTime, h, trustedSvg } from './dom';
import { attachEmojiCompletion, emojiPicker, insertAtCursor, popover } from './emoji';

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

/**
 * Password managers file a passphrase under a username. Without a username field, KeePassXC
 * misreads the first of two passphrase fields, so both forms get the same fixed one.
 */
function passwordManagerUsername() {
  return h('input', {
    type: 'text', name: 'username', autocomplete: 'username', value: 'Kitepost', readonly: true,
    tabindex: '-1', 'aria-hidden': 'true', class: 'visually-hidden',
  });
}

function rememberField() {
  const box = h('input', { type: 'checkbox' });
  const el = h('div', { class: 'remember' },
    h('label', { class: 'check' }, box, t('remember.label')),
    h('small', { class: 'hint' }, t('remember.hint')));
  return { el, box };
}

async function openStore(store: Store) {
  const client = await DcClient.load(store);
  if (client) startMain(client);
  else renderAccountSetup(store);
}

function languageSelect(onChange: () => void) {
  const select = h('select', { 'aria-label': t('language') },
    ...Object.entries(LANGUAGES).map(([code, name]) => h('option', { value: code, selected: code === getLanguage() }, name)));
  select.addEventListener('change', () => {
    setLanguage(select.value as Lang);
    onChange();
  });
  return select;
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
  if (!(await Store.exists())) return renderPassphraseSetup();
  const remembered = await Store.unlockRemembered();
  if (remembered) await openStore(remembered);
  else renderUnlock();
}

/** An onboarding card; `rerender` redraws it after the language changed. */
function screen(title: string, rerender: () => void, ...content: Node[]) {
  clear(root());
  root().append(h('main', { class: 'onboarding' },
    h('div', { class: 'card' }, h('h1', {}, title), ...content,
      h('div', { class: 'card-footer' }, languageSelect(rerender)))));
}

function renderUnlock() {
  const pass = h('input', { type: 'password', id: 'current-password', name: 'current-password', autocomplete: 'current-password', required: true });
  const remember = rememberField();
  const err = errorBox();
  const form = h('form', {
    onsubmit: async (ev: Event) => {
      ev.preventDefault();
      form.classList.add('busy');
      try {
        const store = await Store.unlock(pass.value);
        if (remember.box.checked) await store.remember();
        await openStore(store);
      } catch (e) {
        showError(err, e);
      } finally {
        form.classList.remove('busy');
      }
    },
  },
  passwordManagerUsername(),
  field(t('passphrase.label'), pass),
  remember.el,
  err,
  h('button', { class: 'primary', type: 'submit' }, t('unlock.button')),
  h('button', {
    type: 'button', class: 'link danger',
    onclick: () => dialog(t('unlock.deleteTitle'), h('p', {}, t('unlock.deleteText')), [
      { label: t('cancel') },
      { label: t('delete'), primary: true, onClick: async () => { await Store.destroy(); location.reload(); } },
    ]),
  }, t('unlock.forgot')));
  screen(t('unlock.title'), renderUnlock, form);
  pass.focus();
}

function renderPassphraseSetup() {
  const pass = h('input', { type: 'password', id: 'new-password', name: 'new-password', autocomplete: 'new-password', minlength: '10', required: true });
  const pass2 = h('input', { type: 'password', id: 'confirm-password', name: 'confirm-password', autocomplete: 'new-password', required: true });
  const remember = rememberField();
  const err = errorBox();
  const form = h('form', {
    onsubmit: async (ev: Event) => {
      ev.preventDefault();
      if (pass.value !== pass2.value) return showError(err, t('passphrase.mismatch'));
      form.classList.add('busy');
      try {
        const store = await Store.create(pass.value);
        if (remember.box.checked) await store.remember();
        renderAccountSetup(store);
      } catch (e) {
        showError(err, e);
        form.classList.remove('busy');
      }
    },
  },
  h('p', {}, t('welcome.text')),
  passwordManagerUsername(),
  field(t('passphrase.label'), pass, t('passphrase.hint')),
  field(t('passphrase.repeat'), pass2),
  remember.el,
  err,
  h('button', { class: 'primary', type: 'submit' }, t('continue')));
  screen(t('welcome.title'), renderPassphraseSetup, form);
  pass.focus();
}

function renderAccountSetup(store: Store) {
  const name = h('input', { type: 'text', maxlength: '100', placeholder: t('setup.yourName') });
  const relay = h('input', { type: 'text', value: DEFAULT_RELAY, required: true, spellcheck: 'false' });
  const existing = h('input', { type: 'checkbox' });
  const addr = h('input', { type: 'text', inputmode: 'email', spellcheck: 'false', placeholder: 'you@example.org', autocomplete: 'username' });
  const password = h('input', { type: 'password', autocomplete: 'current-password' });
  const bridge = h('input', { type: 'text', value: DEFAULT_BRIDGE, spellcheck: 'false' });
  const existingFields = h('div', { hidden: true }, field(t('setup.email'), addr), field(t('setup.password'), password));
  const relayField = field(t('setup.relay'), relay, t('setup.relayHint'));
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
  field(t('setup.displayName'), name),
  relayField,
  h('label', { class: 'check' }, existing, t('setup.existing')),
  existingFields,
  h('details', {}, h('summary', {}, t('setup.advanced')), field(t('setup.bridge'), bridge, t('setup.bridgeHint'))),
  err,
  h('button', { class: 'primary', type: 'submit' }, t('setup.create')));

  const backup = h('input', { type: 'file', accept: '.tar,application/x-tar', hidden: true });
  const importStatus = h('p', { class: 'hint', hidden: true });
  const importErr = errorBox();
  const bridgeUrl = () => bridge.value.trim() || DEFAULT_BRIDGE;
  const say = (text: string) => { importStatus.textContent = text; };
  const importFrom = async (blob: Blob) => {
    const profile = await readBackup(fileReader(blob), blob.size, importKeypair, publicKeyInfo, say);
    say(t('import.signingIn', { addr: profile.addr }));
    return DcClient.importBackup(store, profile, bridgeUrl());
  };
  const busy = async (job: () => Promise<DcClient | undefined>) => {
    importErr.hidden = true;
    importStatus.hidden = false;
    importBox.classList.add('busy');
    try {
      const client = await job();
      if (client) startMain(client);
      else importStatus.hidden = true;
    } catch (e) {
      importStatus.hidden = true;
      showError(importErr, e);
    } finally {
      importBox.classList.remove('busy');
    }
  };
  const importBox = h('div', { class: 'import' },
    h('h2', {}, t('import.title')),
    h('p', {}, t('import.text')),
    importStatus, importErr,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'primary', onclick: () => backup.click() }, t('import.file'))),
    h('small', {}, t('import.note')),
    backup);
  backup.addEventListener('change', () => {
    const file = backup.files?.[0];
    backup.value = '';
    if (file) void busy(() => importFrom(file));
  });
  screen(t('setup.title'), () => renderAccountSetup(store), form, importBox);
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
  const render = () => screen(t('connect.title'), render,
    h('p', {}, t('connect.text')),
    h('div', { class: 'qr' }, trustedSvg(qrSvg(link))),
    h('input', { type: 'text', readonly: true, value: link, 'aria-label': t('invite.link'), onfocus: (e: Event) => (e.target as HTMLInputElement).select() }),
    h('p', {}, h('small', {}, t('connect.noApp'))),
    h('button', { class: 'primary', onclick: done }, t('continue')));
  render();
}

// ------------------------------------------------------------------ main view

// Listeners of the previous main view, removed when it is rebuilt, e.g. after a language change.
let mainListeners: AbortController | undefined;

function startMain(client: DcClient, initialChat?: string) {
  mainListeners?.abort();
  mainListeners = new AbortController();
  const { signal } = mainListeners;
  let current = initialChat;
  const objectUrls: string[] = [];

  const status = h('span', { class: 'status' });
  const chatList = h('ul', { class: 'chatlist' });
  const pane = h('section', { class: 'pane' });
  const me = h('div', { class: 'me' });
  const edit = h('button', {
    class: 'icon-button', title: t('nav.editProfile'), 'aria-label': t('nav.editProfile'),
    onclick: () => profileDialog(client, () => startMain(client, current)),
  });
  edit.append(icon(ICONS.edit));
  const sidebar = h('aside', { class: 'sidebar' },
    h('header', { class: 'profile' }, me, status, edit),
    h('nav', { class: 'nav-actions' },
      action(ICONS.qr, t('nav.myInvite'), () => showInvite(client)),
      action(ICONS.addContact, t('nav.addContact'), () => joinDialog(client, open)),
      action(ICONS.group, t('nav.newGroup'), () => groupDialog(client, open))),
    chatList);

  function renderProfile() {
    const name = client.config.displayName || t('me');
    me.replaceChildren(avatar(name, client.config.addr),
      h('span', { class: 'who' }, h('strong', {}, name), h('small', {}, client.config.addr)));
  }
  clear(root());
  root().append(h('div', { class: 'layout' }, sidebar, pane));

  function renderStatus() {
    status.textContent = t(client.status === 'connected' ? 'status.online' : client.status === 'connecting' ? 'status.connecting' : 'status.offline');
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
        chatAvatar(client, chat),
        h('div', { class: 'item' },
          h('div', { class: 'row' },
            h('strong', {}, client.chatTitle(chat) || '…'),
            chat.unread ? h('span', { class: 'badge' }, String(chat.unread)) : null),
          h('small', {}, chat.isRequest ? t('list.request') : last ? `${last.from === 'self' && !last.info ? t('list.mePrefix') : ''}${last.text || (last.attachments[0]?.filename ?? '')}` : ''))));
    }
    if (!chatList.children.length) chatList.append(h('li', { class: 'empty' }, t('list.empty')));
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
    const state = out ? { pending: '⏳', sent: '✓', read: '✓✓', failed: '⚠', received: '' }[m.state] : '';
    const canReact = !chat.left && !chat.isRequest && m.id.includes('@');
    const mine = m.reactions.self;
    // One reaction per person: choosing the own one again removes it.
    const react = (emoji: string) => void client.sendReaction(chat.id, m.id, emoji === mine ? '' : emoji).catch(e => console.warn(e));
    const counts = new Map<string, number>();
    for (const r of Object.values(m.reactions)) counts.set(r, (counts.get(r) ?? 0) + 1);
    const reactButton = canReact ? h('button', { type: 'button', class: 'react', title: t('chat.react'), 'aria-label': t('chat.react') }, '☺') : null;
    reactButton?.addEventListener('click', () => openReactions(reactButton, react));
    return h('div', { class: `msg ${out ? 'out' : 'in'}` },
      !out && chat.type === 'group' ? h('div', { class: 'sender' }, client.contactName(m.from)) : null,
      ...m.attachments.map(attachmentView),
      m.text ? h('div', { class: 'text' }, m.text) : null,
      h('div', { class: 'meta' }, m.edited ? `${t('chat.edited')} · ` : '', formatTime(m.timestamp), state ? ` ${state}` : '', m.error ? ` ${m.error}` : ''),
      counts.size ? h('div', { class: 'reactions' }, ...[...counts].map(([r, n]) => h('button', {
        type: 'button', class: r === mine ? 'reaction mine' : 'reaction', disabled: !canReact, onclick: () => react(r),
      }, n > 1 ? `${r} ${n}` : r))) : null,
      reactButton);
  }

  function renderPane() {
    for (const u of objectUrls.splice(0)) URL.revokeObjectURL(u);
    clear(pane);
    const chat = current ? client.chats.get(current) : undefined;
    if (!chat) {
      pane.append(h('div', { class: 'placeholder' }, h('p', {}, t('pane.select')), h('p', {}, t('pane.e2e'))));
      return;
    }
    const contact = chat.contact ? client.contacts.get(chat.contact) : undefined;
    const subtitle = chat.type === 'self'
      ? t('chat.savedSubtitle')
      : chat.type === 'group'
      ? t('chat.members', { n: chat.members.length + 1 })
      : contact ? contact.addr : '';
    const header = h('header', { class: 'chathead' },
      h('button', { class: 'back', onclick: () => { current = undefined; renderAll(); } }, '‹'),
      chatAvatar(client, chat),
      h('div', { class: 'who' }, h('strong', {}, client.chatTitle(chat)), h('small', {}, subtitle)),
      chat.type === 'group' ? h('button', { onclick: () => showInvite(client, chat.id) }, t('invite.link')) : null,
      contact ? h('button', { onclick: () => fingerprintDialog(client, contact.fingerprint) }, t('chat.encryption')) : null,
      h('button', { onclick: () => dialog(t('chat.deleteTitle'), h('p', {}, t('chat.deleteText')), [
        { label: t('cancel') },
        { label: t('delete'), primary: true, onClick: async () => { await client.deleteChat(chat.id); current = undefined; renderAll(); } },
      ]) }, t('delete')));

    const list = h('div', { class: 'messages' });
    for (const m of client.messages.get(chat.id) ?? []) list.append(messageView(chat, m));

    const request = chat.isRequest
      ? h('div', { class: 'request' },
        h('span', {}, t('chat.request')),
        h('button', { class: 'primary', onclick: () => client.acceptChat(chat.id) }, t('accept')),
        h('button', { onclick: async () => { await client.blockChat(chat.id); current = undefined; renderAll(); } }, t('block')))
      : null;

    pane.append(header, list, request ?? composer(chat));
    list.scrollTop = list.scrollHeight;
    if (!document.hidden) void client.markRead(chat.id);
  }

  function composer(chat: Chat): Node {
    let attachment: AttachmentData | undefined;
    const input = h('textarea', { rows: '1', placeholder: chat.left ? t('chat.notMember') : t('chat.message'), disabled: chat.left });
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
    const attach = async (f: File) => {
      if (f.size > MAX_UPLOAD) return void dialog(t('chat.tooLargeTitle'), h('p', {}, t('chat.tooLargeText')), [{ label: t('ok') }]);
      attachment = { filename: f.name.replace(/[\\/\p{Cc}]/gu, '_') || 'file', mime: f.type || 'application/octet-stream', data_b64: await blobToBase64(f) };
      chip.textContent = `📎 ${attachment.filename} ✕`;
      chip.hidden = false;
    };
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      file.value = '';
      if (f) void attach(f);
    });
    // Office apps put an image of copied text on the clipboard too, so text wins.
    input.addEventListener('paste', ev => {
      const f = ev.clipboardData?.files[0];
      if (!f || ev.clipboardData?.getData('text/plain')) return;
      ev.preventDefault();
      void attach(f);
    });
    chip.addEventListener('click', () => { attachment = undefined; chip.hidden = true; });
    const grow = h('div', { class: 'grow' }, chip, input);
    // Before the Enter handler below, so that Enter picks a suggestion instead of sending.
    attachEmojiCompletion(input, grow);
    const emojiButton = h('button', { class: 'icon', type: 'button', title: t('chat.emoji'), 'aria-label': t('chat.emoji'), disabled: chat.left }, '😊');
    emojiButton.addEventListener('click', () => {
      const close = popover(emojiButton, emojiPicker(emoji => { close(); insertAtCursor(input, emoji); }));
    });
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        void send();
      }
    });
    return h('footer', { class: 'composer' },
      h('button', { class: 'icon', title: t('chat.attach'), 'aria-label': t('chat.attach'), disabled: chat.left, onclick: () => file.click() }, '📎'),
      emojiButton, grow, file,
      h('button', { class: 'primary', disabled: chat.left, onclick: send }, t('chat.send')));
  }

  function open(chatId: string) {
    current = chatId;
    renderAll();
  }

  function renderAll() {
    root().querySelector('.layout')?.classList.toggle('chat-open', !!current);
    renderProfile();
    renderList();
    renderPane();
    renderStatus();
  }

  client.addEventListener('change', ev => {
    const what = (ev as CustomEvent<string>).detail;
    if (what === 'status') return renderStatus();
    renderList();
    if (what === 'config') renderProfile();
    if (what === 'chats' || what === `messages:${current}` || what === 'config') {
      const draft = pane.querySelector('textarea')?.value;
      renderPane();
      const ta = pane.querySelector('textarea');
      if (ta && draft) ta.value = draft;
    }
  }, { signal });
  client.addEventListener('incoming', ev => {
    const { chatId } = (ev as CustomEvent<{ chatId: string }>).detail;
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const chat = client.chats.get(chatId);
      if (chat && !chat.isRequest) new Notification(client.chatTitle(chat), { body: t('chat.newMessage') });
    }
  }, { signal });
  if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (current) void client.markRead(current);
    client.poke();
  }, { signal });
  renderAll();
  client.start();
}

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

function openReactions(anchor: HTMLElement, react: (emoji: string) => void) {
  const box = h('div', { class: 'quick-reactions' });
  const close = popover(anchor, box);
  const choose = (emoji: string) => { close(); react(emoji); };
  box.append(...QUICK_REACTIONS.map(e => h('button', { type: 'button', class: 'emoji', onclick: () => choose(e) }, e)),
    h('button', { type: 'button', class: 'emoji more', title: t('emoji.more'), 'aria-label': t('emoji.more'), onclick: () => box.replaceChildren(emojiPicker(choose)) }, '＋'));
}

// ------------------------------------------------------------------ avatars & icons

const ICONS = {
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
  addContact: 'M15 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M8.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19 8v6M22 11h-6',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  group: 'M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM22 20v-1.5a4 4 0 0 0-3-3.87M16 4.13a3.5 3.5 0 0 1 0 6.75',
};

function icon(d: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

function action(d: string, label: string, onclick: () => void) {
  const b = h('button', { onclick }, h('span', {}, label));
  b.prepend(icon(d));
  return b;
}

/** Letter avatar with a stable color per address, like Delta Chat's. */
function avatar(name: string, key: string, letter?: string) {
  let hash = 0;
  for (const c of key) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const el = h('span', { class: 'avatar', 'aria-hidden': 'true' }, letter ?? ([...name.trim()][0] ?? '?').toUpperCase());
  el.style.background = `hsl(${hash % 360} 42% 42%)`;
  return el;
}

function chatAvatar(client: DcClient, chat: Chat) {
  if (chat.type === 'self') return avatar('', 'self', '★');
  const key = chat.type === 'single' ? client.contacts.get(chat.contact ?? '')?.addr ?? chat.id : chat.grpid ?? chat.id;
  return avatar(client.chatTitle(chat), key);
}

// ------------------------------------------------------------------ dialogs

async function showInvite(client: DcClient, chatId?: string) {
  const link = await client.inviteLink(chatId);
  const body = h('div', { class: 'invite' },
    h('p', {}, t(chatId ? 'invite.groupText' : 'invite.myText')),
    h('div', { class: 'qr' }, trustedSvg(qrSvg(link))),
    h('input', { type: 'text', readonly: true, value: link, 'aria-label': t('invite.link'), onfocus: (e: Event) => (e.target as HTMLInputElement).select() }));
  dialog(t(chatId ? 'invite.groupTitle' : 'invite.myTitle'), body, [
    { label: t('invite.copy'), onClick: async () => { await navigator.clipboard.writeText(link); return false; } },
    { label: t('close'), primary: true },
  ]);
}

function joinDialog(client: DcClient, open: (id: string) => void) {
  const input = h('textarea', { rows: '3', placeholder: 'https://i.delta.chat/#…', spellcheck: 'false' });
  dialog(t('join.title'), h('div', {}, h('p', {}, t('join.text')), input), [
    { label: t('cancel') },
    { label: t('connect'), primary: true, onClick: async () => open(await client.joinInvite(input.value)) },
  ]);
  input.focus();
}

function groupDialog(client: DcClient, open: (id: string) => void) {
  const name = h('input', { type: 'text', maxlength: '100', placeholder: t('group.namePlaceholder') });
  const boxes = [...client.contacts.values()]
    .filter(c => c.publicKey && !c.blocked)
    .map(c => ({ fp: c.fingerprint, box: h('input', { type: 'checkbox' }), label: c.name || c.addr }));
  const list = h('div', { class: 'members' }, ...boxes.map(b => h('label', { class: 'check' }, b.box, b.label)));
  if (!boxes.length) list.append(h('p', {}, t('group.addContactsFirst')));
  dialog(t('group.title'), h('div', {}, field(t('group.name'), name), list), [
    { label: t('cancel') },
    {
      label: t('create'), primary: true, onClick: async () => {
        if (!name.value.trim()) throw new Error(t('group.enterName'));
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
  dialog(t('e2e.title'), h('div', { class: 'fingerprints' },
    h('p', {}, t(c?.verified ? 'e2e.invite' : 'e2e.compare')),
    h('h3', {}, client.config.displayName || t('me')), h('code', {}, formatFingerprint(client.config.fingerprint)),
    h('h3', {}, client.contactName(fp)), h('code', {}, formatFingerprint(fp))), [{ label: t('close'), primary: true }]);
}

function exportDialog(client: DcClient) {
  dialog(t('export.title'), h('div', {},
    h('p', {}, t('export.text')),
    h('p', { class: 'warning' }, t('export.warning'))), [
    { label: t('cancel') },
    {
      label: t('export.download'), primary: true, onClick: async () => {
        const { blob, filename } = await client.exportBackup();
        const url = URL.createObjectURL(blob);
        h('a', { href: url, download: filename }).click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      },
    },
  ]);
}

/** `rebuild` redraws the main view after the language changed. */
function profileDialog(client: DcClient, rebuild: () => void) {
  const name = h('input', { type: 'text', maxlength: '100', value: client.config.displayName });
  const remember = rememberField();
  void client.isRemembered().then(on => { remember.box.checked = on; });
  const receipts = h('input', { type: 'checkbox', checked: client.readReceipts });
  const receiptsField = h('div', { class: 'remember' },
    h('label', { class: 'check' }, receipts, t('profile.readReceipts')),
    h('small', { class: 'hint' }, t('profile.readReceiptsHint')));
  const lang = languageSelect(() => {
    document.querySelector('dialog')?.close();
    rebuild();
    profileDialog(client, rebuild);
  });
  dialog(t('profile.title'), h('div', {},
    field(t('setup.displayName'), name),
    field(t('language'), lang),
    receiptsField,
    remember.el,
    h('div', { class: 'profile-info' },
      h('small', {}, t('profile.address', { addr: client.config.addr })),
      h('small', {}, t('profile.fingerprint', { fp: formatFingerprint(client.config.fingerprint) })))), [
    { label: t('profile.export'), onClick: () => { exportDialog(client); } },
    { label: t('profile.lock'), onClick: async () => { await client.setRemembered(false); location.reload(); } },
    {
      label: t('save'), primary: true, onClick: async () => {
        await client.setDisplayName(name.value);
        await client.setRemembered(remember.box.checked);
        await client.setReadReceipts(receipts.checked);
      },
    },
  ]);
}
