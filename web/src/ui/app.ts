import { fileReader, readBackup } from '../dc/backup';
import { DcClient } from '../dc/client';
import { createHandoff, handoffAvailable, handoffState } from '../dc/handoff';
import type { Chat, Message } from '../dc/types';
import { getLanguage, LANGUAGES, setLanguage, t, type Lang } from '../i18n';
import { Store } from '../store';
import { importKeypair, publicKeyInfo, qrSvg, type AttachmentData } from '../wasm';
import { base64ToBlob, blobToBase64, clear, dialog, flashLabel, formatDateTime, formatTime, h, trustedSvg, whileBusy } from './dom';
import { attachEmojiCompletion, emojiPicker, insertAtCursor, popover } from './emoji';
import { checkForUpdate } from './update';

// Relative so the client works under any subdirectory, e.g. /app/ -> /bridge.
let DEFAULT_RELAY = 'nine.testrun.org';
let DEFAULT_BRIDGE = '../bridge';
let HANDOFF_URL = '../join/';
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
    if (typeof cfg.handoffUrl === 'string') HANDOFF_URL = cfg.handoffUrl;
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

function errorDialog(e: unknown) {
  dialog(t('error.title'), h('p', {}, e instanceof Error ? e.message : String(e)), [{ label: t('ok'), primary: true }]);
}

/** A click handler that keeps its button busy while `job` runs and reports failures. */
const busyClick = (job: () => Promise<unknown>) => (ev: Event) =>
  void whileBusy(ev.currentTarget as HTMLButtonElement, job).catch(errorDialog);

function renderUnlock() {
  const pass = h('input', { type: 'password', id: 'current-password', name: 'current-password', autocomplete: 'current-password', required: true });
  const remember = rememberField();
  const err = errorBox();
  const submit = h('button', { class: 'primary', type: 'submit' }, t('unlock.button'));
  const form = h('form', {
    onsubmit: async (ev: Event) => {
      ev.preventDefault();
      form.classList.add('busy');
      await whileBusy(submit, async () => {
        const store = await Store.unlock(pass.value);
        if (remember.box.checked) await store.remember();
        await openStore(store);
      }).catch(e => showError(err, e));
      form.classList.remove('busy');
    },
  },
  passwordManagerUsername(),
  field(t('passphrase.label'), pass),
  remember.el,
  err,
  submit,
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
  const submit = h('button', { class: 'primary', type: 'submit' }, t('continue'));
  const form = h('form', {
    onsubmit: async (ev: Event) => {
      ev.preventDefault();
      if (pass.value !== pass2.value) return showError(err, t('passphrase.mismatch'));
      form.classList.add('busy');
      await whileBusy(submit, async () => {
        const store = await Store.create(pass.value);
        if (remember.box.checked) await store.remember();
        renderAccountSetup(store);
      }).catch(e => showError(err, e));
      form.classList.remove('busy');
    },
  },
  h('p', {}, t('welcome.text')),
  passwordManagerUsername(),
  field(t('passphrase.label'), pass, t('passphrase.hint')),
  field(t('passphrase.repeat'), pass2),
  remember.el,
  err,
  submit);
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
  const submit = h('button', { class: 'primary', type: 'submit' }, t('setup.create'));
  const form = h('form', {
    onsubmit: async (ev: Event) => {
      ev.preventDefault();
      form.classList.add('busy');
      await whileBusy(submit, async () => {
        const params = existing.checked
          ? { addr: addr.value, password: password.value }
          : { addr: `${randomAlnum(9)}@${relay.value.trim().toLowerCase()}`, password: randomAlnum(22) };
        const client = await DcClient.setup(store, { ...params, displayName: name.value, bridgeUrl: bridge.value.trim() || DEFAULT_BRIDGE });
        if (await handoffAvailable(handoffBase(), client.config.addr)) renderPhoneSetup(client);
        else await renderConnectPhone(client);
      }).catch(e => showError(err, e));
      form.classList.remove('busy');
    },
  },
  field(t('setup.displayName'), name),
  relayField,
  h('div', {}, h('label', { class: 'check' }, existing, t('setup.existing')), h('small', { class: 'hint' }, t('setup.existingHint'))),
  existingFields,
  h('details', {}, h('summary', {}, t('setup.advanced')), field(t('setup.bridge'), bridge, t('setup.bridgeHint'))),
  err,
  submit);

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
      const client = await whileBusy(importButton, job);
      if (client) startMain(client);
      else importStatus.hidden = true;
    } catch (e) {
      importStatus.hidden = true;
      showError(importErr, e);
    } finally {
      importBox.classList.remove('busy');
    }
  };
  const importButton = h('button', { type: 'button', class: 'primary', onclick: () => backup.click() }, t('import.file'));
  const importBox = h('div', { class: 'import' }, importStatus, importErr, h('div', { class: 'row' }, importButton), backup);
  backup.addEventListener('change', () => {
    const file = backup.files?.[0];
    backup.value = '';
    if (file) void busy(() => importFrom(file));
  });

  // The two ways to an existing profile only differ in where the backup comes from.
  const restoreWay = (text: string, exportStep: string) => {
    const steps = h('ol', { class: 'steps' },
      h('li', {}, exportStep), h('li', {}, t('way.transfer')), h('li', {}, t('way.importHere')));
    return h('div', { class: 'way', hidden: true }, h('p', {}, text), steps, h('p', { class: 'hint' }, t('way.oneKey')));
  };
  const ways = {
    new: h('div', { class: 'way' }, form),
    deltaChat: restoreWay(t('way.deltaChatText'), t('way.deltaChatExport')),
    otherBrowser: restoreWay(t('way.otherBrowserText'), t('way.otherBrowserExport')),
  };
  ways.deltaChat.append(importBox);
  const choice = h('fieldset', { class: 'ways' }, h('legend', {}, t('way.legend')),
    ...(['new', 'deltaChat', 'otherBrowser'] as const).map(key => h('label', {},
      h('input', { type: 'radio', name: 'way', value: key, checked: key === 'new', onchange: () => show(key) }),
      t(`way.${key}`))));
  const show = (key: keyof typeof ways) => {
    for (const [k, el] of Object.entries(ways)) el.hidden = k !== key;
    if (key !== 'new') ways[key].append(importBox);
  };
  // An invite link brings a new address, so there is nothing to choose.
  const fromInvite = existing.checked;
  screen(t('setup.title'), () => renderAccountSetup(store), ...(fromInvite ? [form] : [choice, ...Object.values(ways)]));
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

const handoffBase = () => (HANDOFF_URL ? new URL(HANDOFF_URL, location.href).href : '');

/** A QR code that moves this profile to Delta Chat on a phone; polling stops when `signal` aborts. */
function phoneSetup(client: DcClient, signal: AbortSignal): HTMLElement {
  const box = h('div', { class: 'phone-setup' });
  const newCode = () => h('button', { type: 'button', onclick: () => void show() }, t('phone.newCode'));
  const show = async () => {
    box.replaceChildren(h('p', { class: 'hint' }, t('phone.preparing')));
    try {
      const handoff = await createHandoff(handoffBase(), client);
      box.replaceChildren(h('div', { class: 'qr' }, trustedSvg(qrSvg(handoff.url))),
        h('p', { class: 'hint' }, t('phone.waiting')),
        h('p', { class: 'hint' }, h('a', { href: handoff.url, target: '_blank', rel: 'noopener noreferrer' }, t('phone.thisDevice'))));
      while (!signal.aborted) {
        await new Promise(r => setTimeout(r, 2000));
        if (signal.aborted) return;
        const state = await handoffState(handoff).catch(() => 'waiting');
        if (state === 'fetched') return box.replaceChildren(h('p', { class: 'ok' }, t('phone.fetched')));
        if (state === 'expired') return box.replaceChildren(h('p', {}, t('phone.expired')), newCode());
      }
    } catch (e) {
      console.warn('handoff failed', e);
      box.replaceChildren(h('p', { class: 'error' }, t('phone.failed')), newCode());
    }
  };
  void show();
  return box;
}

function renderPhoneSetup(client: DcClient) {
  const polling = new AbortController();
  const setup = phoneSetup(client, polling.signal);
  const leave = (next: () => unknown) => () => { polling.abort(); void next(); };
  const render = () => screen(t('phone.title'), render,
    h('p', {}, t('phone.text')),
    setup,
    h('button', { class: 'primary', onclick: leave(() => startMain(client)) }, t('continue')),
    h('p', {}, h('button', { type: 'button', class: 'link', onclick: busyClick(() => { polling.abort(); return renderConnectPhone(client); }) }, t('phone.otherProfile'))));
  render();
}

function phoneDialog(client: DcClient) {
  const polling = new AbortController();
  const dlg = dialog(t('profile.phone'), h('div', { class: 'invite' }, h('p', {}, t('phone.text')), phoneSetup(client, polling.signal)),
    [{ label: t('close'), primary: true }]);
  dlg.addEventListener('close', () => polling.abort());
}

// ------------------------------------------------------------------ main view

let canHandoff = false;

// Listeners of the previous main view, removed when it is rebuilt, e.g. after a language change.
let mainListeners: AbortController | undefined;

function startMain(client: DcClient, initialChat?: string) {
  mainListeners?.abort();
  mainListeners = new AbortController();
  const { signal } = mainListeners;
  let current = initialChat;
  let shown: { chatId: string; header: Element; headerKey: string; footer: Element; footerKey: string; list: HTMLElement } | undefined;
  const rendered = new Map<string, { node: Element; key: string; urls: string[] }>();
  let startReply: ((m: Message) => void) | undefined;
  let startEdit: ((m: Message) => void) | undefined;
  // Like core's send_edit_request(): own text messages only.
  const canEdit = (chat: Chat, m: Message) => m.from === 'self' && !m.info && !!m.text && m.id.includes('@') && !chat.left;

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
      action(ICONS.qr, t('nav.myInvite'), busyClick(() => showInvite(client))),
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

  function attachmentView(a: AttachmentData, urls: string[]): Node {
    const safeImage = INLINE_IMAGE_TYPES.has(a.mime);
    const url = URL.createObjectURL(base64ToBlob(a.data_b64, safeImage ? a.mime : 'application/octet-stream'));
    urls.push(url);
    const link = h('a', { href: url, download: a.filename, rel: 'noopener' }, `📎 ${a.filename}`);
    return safeImage ? h('div', { class: 'attachment' }, h('img', { src: url, alt: a.filename }), link) : h('div', { class: 'attachment' }, link);
  }

  const authorName = (from: string) => from === 'self' ? t('me') : client.contactName(from);
  const repliedTo = (chat: Chat, m: Message) => m.replyTo ? client.messages.get(chat.id)?.find(x => x.id === m.replyTo) : undefined;

  /** Everything `messageView` shows, so that unchanged messages keep their nodes. */
  function messageKey(chat: Chat, m: Message): string {
    const parent = m.quote !== undefined ? repliedTo(chat, m) : undefined;
    return JSON.stringify([m.text, m.info, m.state, m.error, m.edited, m.reactions, formatTime(m.timestamp),
      m.attachments.map(a => [a.filename, a.mime, a.data_b64.length]), m.quote, parent && authorName(parent.from),
      chat.left, chat.isRequest, chat.type === 'group' && m.from !== 'self' ? client.contactName(m.from) : '']);
  }

  function deleteDialog(chat: Chat, m: Message) {
    const remove = (forAll: boolean) => () => client.deleteMessage(chat.id, m.id, forAll);
    const forAll = m.from === 'self' && m.id.includes('@') && !chat.left;
    dialog(t('chat.deleteMessageTitle'), h('p', {}, t(forAll ? 'chat.deleteMessageTextOwn' : 'chat.deleteMessageText')), [
      { label: t('cancel') },
      { label: t('chat.deleteForMe'), primary: !forAll, onClick: remove(false) },
      ...forAll ? [{ label: t('chat.deleteForAll'), primary: true, onClick: remove(true) }] : [],
    ]);
  }

  /** Like core's MsgId::get_info(), as far as Kitepost keeps the data. */
  function infoDialog(m: Message) {
    const rows: [string, Node | string][] = [[t('info.sent'), `${formatDateTime(m.timestamp)} · ${authorName(m.from)}`]];
    if (m.from !== 'self' && m.addedAt) rows.push([t('info.received'), formatDateTime(m.addedAt)]);
    const readBy = Object.entries(m.readBy ?? {});
    if (readBy.length) {
      rows.push([t('info.readBy'), h('ul', {}, ...readBy.map(([fp, ts]) => h('li', {}, `${client.contactName(fp)} · ${formatDateTime(ts)}`)))]);
    }
    rows.push([t('info.state'), t(`state.${m.state}`) + (m.edited ? ` · ${t('chat.edited')}` : '')]);
    rows.push([t('info.encryption'), t('info.e2ee')]);
    const reactions = Object.entries(m.reactions);
    if (reactions.length) rows.push([t('info.reactions'), h('ul', {}, ...reactions.map(([from, r]) => h('li', {}, `${r} ${authorName(from)}`)))]);
    for (const a of m.attachments) {
      rows.push([t('info.attachment'), `${a.filename} · ${a.mime} · ${Math.ceil((a.size ?? a.data_b64.length * 3 / 4) / 1024)} KB`]);
    }
    if (m.error) rows.push([t('info.error'), m.error]);
    if (m.id.includes('@')) rows.push([t('info.messageId'), h('span', { class: 'message-id' }, m.id)]);
    dialog(t('chat.messageInfo'), h('dl', { class: 'info-list' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])), [{ label: t('close') }]);
  }

  function jumpTo(id: string) {
    const node = rendered.get(id)?.node;
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1200);
  }

  function quoteView(chat: Chat, m: Message): Element | null {
    if (m.quote === undefined) return null;
    const parent = repliedTo(chat, m);
    return h('blockquote', { class: parent ? 'quote linked' : 'quote', onclick: parent ? () => jumpTo(parent.id) : undefined },
      parent ? h('strong', {}, authorName(parent.from)) : null,
      h('span', {}, m.quote || '…'));
  }

  function messageView(chat: Chat, m: Message, urls: string[]): Element {
    if (m.info) return h('div', { class: 'info' }, m.text);
    const out = m.from === 'self';
    const state = out && m.state !== 'received' ? stateMark(m.state) : null;
    const canReact = !chat.left && !chat.isRequest && m.id.includes('@');
    const mine = m.reactions.self;
    // One reaction per person: choosing the own one again removes it.
    const react = (emoji: string) => client.sendReaction(chat.id, m.id, emoji === mine ? '' : emoji);
    const counts = new Map<string, number>();
    for (const r of Object.values(m.reactions)) counts.set(r, (counts.get(r) ?? 0) + 1);
    const reactButton = canReact ? h('button', { type: 'button', class: 'react', title: t('chat.react'), 'aria-label': t('chat.react') }) : null;
    reactButton?.append(icon(ICONS.react));
    reactButton?.addEventListener('click', () => openReactions(reactButton, e => void whileBusy(reactButton, () => react(e)).catch(errorDialog)));
    const replyButton = canReact ? h('button', { type: 'button', class: 'reply', title: t('chat.reply'), 'aria-label': t('chat.reply'), onclick: () => startReply?.(m) }) : null;
    replyButton?.append(icon(ICONS.reply));
    const editButton = canEdit(chat, m) ? h('button', { type: 'button', class: 'edit', title: t('chat.edit'), 'aria-label': t('chat.edit'), onclick: () => startEdit?.(m) }) : null;
    editButton?.append(icon(ICONS.edit));
    const deleteButton = h('button', { type: 'button', class: 'delete', title: t('chat.deleteMessage'), 'aria-label': t('chat.deleteMessage'), onclick: () => deleteDialog(chat, m) });
    deleteButton.append(icon(ICONS.trash));
    const infoButton = h('button', { type: 'button', class: 'info-button', title: t('chat.messageInfo'), 'aria-label': t('chat.messageInfo'), onclick: () => infoDialog(m) });
    infoButton.append(icon(ICONS.info));
    return h('div', { class: `msg ${out ? 'out' : 'in'}` },
      !out && chat.type === 'group' ? h('div', { class: 'sender' }, client.contactName(m.from)) : null,
      quoteView(chat, m),
      ...m.attachments.map(a => attachmentView(a, urls)),
      m.text ? h('div', { class: 'text' }, m.text) : null,
      h('div', { class: 'meta' }, m.edited ? `${t('chat.edited')} · ` : '', formatTime(m.timestamp), state, m.error ? ` ${m.error}` : ''),
      counts.size ? h('div', { class: 'reactions' }, ...[...counts].map(([r, n]) => h('button', {
        type: 'button', class: r === mine ? 'reaction mine' : 'reaction', disabled: !canReact, onclick: busyClick(() => react(r)),
      }, n > 1 ? `${r} ${n}` : r))) : null,
      h('div', { class: 'actions' }, infoButton, deleteButton, editButton, replyButton, reactButton));
  }

  function forgetMessages() {
    for (const r of rendered.values()) for (const u of r.urls) URL.revokeObjectURL(u);
    rendered.clear();
  }

  function chatHeader(chat: Chat): [string, Element] {
    const contact = chat.contact ? client.contacts.get(chat.contact) : undefined;
    const subtitle = chat.type === 'self'
      ? t('chat.savedSubtitle')
      : chat.type === 'group'
      ? t('chat.members', { n: chat.members.length + 1 })
      : contact ? contact.addr : '';
    const key = JSON.stringify([client.chatTitle(chat), subtitle, chat.type, chat.grpid, contact?.fingerprint, contact?.addr]);
    return [key, h('header', { class: 'chathead' },
      h('button', { class: 'back', onclick: () => { current = undefined; renderAll(); } }, '‹'),
      chatAvatar(client, chat),
      h('div', { class: 'who' }, h('strong', {}, client.chatTitle(chat)), h('small', {}, subtitle)),
      chat.type === 'group' ? h('button', { onclick: busyClick(() => showInvite(client, chat.id)) }, t('invite.link')) : null,
      contact ? h('button', { onclick: () => fingerprintDialog(client, contact.fingerprint) }, t('chat.encryption')) : null,
      h('button', { onclick: () => dialog(t('chat.deleteTitle'), h('p', {}, t('chat.deleteText')), [
        { label: t('cancel') },
        { label: t('delete'), primary: true, onClick: async () => { await client.deleteChat(chat.id); current = undefined; renderAll(); } },
      ]) }, t('delete')))];
  }

  const footerKey = (chat: Chat) => JSON.stringify([chat.isRequest, chat.left]);

  function chatFooter(chat: Chat): Element {
    return chat.isRequest
      ? h('div', { class: 'request' },
        h('span', {}, t('chat.request')),
        h('button', { class: 'primary', onclick: busyClick(() => client.acceptChat(chat.id)) }, t('accept')),
        h('button', { onclick: busyClick(async () => { await client.blockChat(chat.id); current = undefined; renderAll(); }) }, t('block')))
      : composer(chat);
  }

  function renderPane() {
    const chat = current ? client.chats.get(current) : undefined;
    if (!chat) {
      shown = undefined;
      forgetMessages();
      pane.replaceChildren(h('div', { class: 'placeholder' }, h('p', {}, t('pane.select')), h('p', {}, t('pane.e2e'))));
      return;
    }
    if (shown?.chatId !== chat.id) {
      forgetMessages();
      const [headerKey, header] = chatHeader(chat);
      const footer = chatFooter(chat);
      const list = h('div', { class: 'messages' });
      shown = { chatId: chat.id, header, headerKey, footer, footerKey: footerKey(chat), list };
      // Narrow and touch screens show a message's actions only while it is selected by a tap.
      list.addEventListener('click', ev => {
        const target = ev.target as Element;
        if (target.closest('button, a, .quote')) return;
        const msg = target.closest('.msg');
        for (const el of list.querySelectorAll('.msg.selected')) if (el !== msg) el.classList.remove('selected');
        msg?.classList.toggle('selected');
      });
      // Scroll anchoring keeps the top in place when the growing composer shrinks the list.
      let height = 0;
      new ResizeObserver(() => {
        if (list.scrollHeight - list.scrollTop - height < 40) list.scrollTop = list.scrollHeight;
        height = list.clientHeight;
      }).observe(list);
      pane.replaceChildren(header, shown.list, footer);
    } else {
      const [headerKey, header] = chatHeader(chat);
      if (headerKey !== shown.headerKey) {
        shown.header.replaceWith(header);
        Object.assign(shown, { header, headerKey });
      }
      if (footerKey(chat) !== shown.footerKey) {
        const footer = chatFooter(chat);
        shown.footer.replaceWith(footer);
        Object.assign(shown, { footer, footerKey: footerKey(chat) });
      }
    }
    renderMessages(chat, shown.list);
    if (!document.hidden) void client.markRead(chat.id);
  }

  function renderMessages(chat: Chat, list: HTMLElement) {
    const msgs = client.messages.get(chat.id) ?? [];
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const ownNew = msgs.some(m => m.from === 'self' && !m.info && !rendered.has(m.id));
    const ids = new Set(msgs.map(m => m.id));
    for (const [id, r] of rendered) {
      if (ids.has(id)) continue;
      r.node.remove();
      for (const u of r.urls) URL.revokeObjectURL(u);
      rendered.delete(id);
    }
    let prev: Element | null = null;
    for (const m of msgs) {
      const key = messageKey(chat, m);
      let r = rendered.get(m.id);
      if (r?.key !== key) {
        const urls: string[] = [];
        const node = messageView(chat, m, urls);
        if (r) {
          r.node.replaceWith(node);
          for (const u of r.urls) URL.revokeObjectURL(u);
        }
        r = { node, key, urls };
        rendered.set(m.id, r);
      }
      if ((prev ? prev.nextElementSibling : list.firstElementChild) !== r.node) {
        if (prev) prev.after(r.node);
        else list.prepend(r.node);
      }
      prev = r.node;
    }
    if (atBottom || ownNew) list.scrollTop = list.scrollHeight;
  }

  function composer(chat: Chat): Element {
    let attachment: AttachmentData | undefined;
    let quoted: Message | undefined;
    let editing: Message | undefined;
    const input = h('textarea', { rows: '1', placeholder: chat.left ? t('chat.notMember') : t('chat.message'), disabled: chat.left });
    const file = h('input', { type: 'file', hidden: true });
    const chip = h('span', { class: 'chip', hidden: true });
    const replyBox = h('div', { class: 'reply', hidden: true });
    /** Shows what the next message replies to or which message it edits; without `kind` neither. */
    const setContext = (kind?: 'reply' | 'edit', m?: Message) => {
      if (editing && kind !== 'edit') input.value = '';
      quoted = kind === 'reply' ? m : undefined;
      editing = kind === 'edit' ? m : undefined;
      replyBox.hidden = !m;
      replyBox.replaceChildren();
      if (!m) return;
      const cancel = t(kind === 'edit' ? 'chat.editCancel' : 'chat.replyCancel');
      replyBox.append(
        h('div', {}, h('strong', {}, kind === 'edit' ? t('chat.editing') : authorName(m.from)), h('span', {}, m.text || m.attachments[0]?.filename || '')),
        h('button', { type: 'button', class: 'icon', title: cancel, 'aria-label': cancel, onclick: () => { setContext(); input.focus(); } }, '✕'));
      if (kind === 'edit') {
        attachment = undefined;
        chip.hidden = true;
        input.value = m.text;
      }
      input.focus();
    };
    startReply = m => setContext('reply', m);
    startEdit = m => setContext('edit', m);
    const sendEdit = async (m: Message, text: string) => {
      setContext();
      try {
        await client.sendEdit(chat.id, m.id, text);
      } catch (e) {
        setContext('edit', m);
        input.value = text;
        errorDialog(e);
      }
    };
    const send = async () => {
      const text = input.value.trim();
      if (editing) return text ? sendEdit(editing, text) : undefined;
      if (!text && !attachment) return;
      const att = attachment;
      const q = quoted;
      const before = client.messages.get(chat.id)?.length ?? 0;
      input.value = '';
      attachment = undefined;
      chip.hidden = true;
      setContext();
      try {
        await client.sendText(chat.id, text, att, q);
      } catch (e) {
        // A message that was created shows its error itself.
        if ((client.messages.get(chat.id)?.length ?? 0) > before) return console.warn(e);
        const ta = pane.querySelector('textarea');
        if (ta && !ta.value) ta.value = text;
        if (q && !quoted) setContext('reply', q);
        errorDialog(e);
      }
    };
    const attach = async (f: File) => {
      if (editing) setContext();
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
    const grow = h('div', { class: 'grow' }, replyBox, chip, input);
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
      } else if (ev.key === 'Escape' && (quoted || editing)) {
        ev.preventDefault();
        setContext();
      } else if (ev.key === 'ArrowUp' && !input.value && !editing) {
        const last = [...client.messages.get(chat.id) ?? []].reverse().find(m => m.from === 'self' && !m.info);
        if (last && canEdit(chat, last)) {
          ev.preventDefault();
          setContext('edit', last);
        }
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

  let connected = false;
  client.addEventListener('change', ev => {
    const what = (ev as CustomEvent<string>).detail;
    if (what === 'status') {
      if (client.status === 'connected' && !connected) void checkForUpdate();
      connected = client.status === 'connected';
      return renderStatus();
    }
    renderList();
    if (what === 'config') renderProfile();
    if (what === 'chats' || what === `messages:${current}` || what === 'config') renderPane();
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
  void handoffAvailable(handoffBase(), client.config.addr).then(ok => { canHandoff = ok; });
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
  reply: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  react: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 14.5s1.3 1.8 3.5 1.8 3.5-1.8 3.5-1.8M9 9.5h.01M15 9.5h.01',
  star: 'M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9z',
  group: 'M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM22 20v-1.5a4 4 0 0 0-3-3.87M16 4.13a3.5 3.5 0 0 1 0 6.75',
};

/** The state of an own message as an icon whose label says what it means. */
function stateMark(state: Exclude<Message['state'], 'received'>): Element {
  const label = t(`mark.${state}`);
  const mark = h('span', { class: 'state', 'data-state': state, role: 'img', 'aria-label': label, title: label });
  mark.append(icon(STATE_ICONS[state]));
  return mark;
}

const STATE_ICONS = {
  pending: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  sent: 'M4 12.5 9 17.5 20 6.5',
  read: 'M1.5 12.5 6.5 17.5 17.5 6.5M11.5 16.5l1 1 11-11',
  failed: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5v5.5M12 16.5h.01',
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

function action(d: string, label: string, onclick: (ev: Event) => void) {
  const b = h('button', { onclick }, h('span', {}, label));
  b.prepend(icon(d));
  return b;
}

/** Letter avatar with a stable color per address, like Delta Chat's. */
function avatar(name: string, key: string, content?: Node) {
  let hash = 0;
  for (const c of key) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const el = h('span', { class: 'avatar', 'aria-hidden': 'true' }, content ?? h('span', {}, ([...name.trim()][0] ?? '?').toUpperCase()));
  el.style.background = `hsl(${hash % 360} 42% 42%)`;
  return el;
}

function chatAvatar(client: DcClient, chat: Chat) {
  if (chat.type === 'self') return avatar('', 'self', icon(ICONS.star));
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
    {
      label: t('invite.copy'), onClick: async button => {
        try {
          await navigator.clipboard.writeText(link);
          flashLabel(button, t('invite.copied'));
        } catch {
          body.querySelector('input')?.select();
          flashLabel(button, t('invite.copyFailed'));
        }
        return false;
      },
    },
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
    ...(canHandoff ? [{ label: t('profile.phone'), onClick: () => { phoneDialog(client); } }] : []),
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
