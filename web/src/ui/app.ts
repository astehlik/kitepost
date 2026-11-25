import { fileReader, readBackup } from '../dc/backup';
import { canDeleteForAll, canResend, DcClient, formatDuration, MAX_RELAYS, pinnable, savable } from '../dc/client';
import { createHandoff, handoffAvailable, handoffState, HandoffTooLarge } from '../dc/handoff';
import { looksLikeBackupQr, receiveBackup } from '../dc/transfer';
import { byChatOrder, type Chat, type Message } from '../dc/types';
import { getLanguage, LANGUAGES, setLanguage, t, type Lang } from '../i18n';
import { avatarDataUrl } from '../dc/avatar';
import { isVcard, parseVcard, type VcardContact } from '../dc/vcard';
import { Store } from '../store';
import { importKeypair, publicKeyInfo, qrSvg, type AttachmentData } from '../wasm';
import { applyTheme, base64ToBlob, blobToBase64, clear, DATE_LOCALES, dateLocale, dialog, flashLabel, formatAgo, formatDateTime, formatTime, getDateLocale, getTheme, setDateLocale, setTheme, THEMES, type DateLocale, type Theme, h, trustedSvg, whileBusy } from './dom';
import { attachEmojiCompletion, emojiPicker, insertAtCursor, popover } from './emoji';
import { splitLinks } from './links';
import { pastedFiles, pasteIncomplete } from './paste';
import { scanQr } from './scanner';
import { sendErrorKind } from './send-error';
import { checkForUpdate } from './update';

// Relative so the client works under any subdirectory, e.g. /app/ -> /bridge.
let DEFAULT_RELAY = 'nine.testrun.org';
let DEFAULT_BRIDGE = '../bridge';
let HANDOFF_URL = '../join/';
const MAX_UPLOAD = 10 * 1024 * 1024;
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const INLINE_VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/ogg']);
const playableVideo = (mime: string) => INLINE_VIDEO_TYPES.has(mime) && document.createElement('video').canPlayType(mime) !== '';

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
  applyTheme();
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
  const raw = e instanceof Error ? e.message : String(e);
  const kind = sendErrorKind(raw);
  dialog(t('error.title'), h('div', {}, h('p', {}, kind ? t(`sendError.${kind}`) : raw), kind ? h('p', { class: 'error-detail' }, raw) : null),
    [{ label: t('ok'), primary: true }]);
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
  const busy = async (button: HTMLButtonElement, job: () => Promise<DcClient | undefined>) => {
    importErr.hidden = true;
    importStatus.hidden = false;
    importBox.classList.add('busy');
    try {
      const client = await whileBusy(button, job);
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
  const scanButton = h('button', {
    type: 'button',
    onclick: () => busy(scanButton, async () => {
      const qr = await scanQr(t('import.scanTitle'), t('import.scanHint'), looksLikeBackupQr);
      if (!qr) return undefined;
      let client: DcClient | undefined;
      say(t('import.connecting'));
      await receiveBackup(qr, (got, total) => say(t('import.receiving', { percent: total ? Math.min(100, Math.round((got / total) * 100)) : 0 })), async blob => {
        client = await importFrom(blob);
      });
      return client;
    }),
  }, t('import.scan'));
  const scanNote = h('small', { class: 'hint' }, t('import.scanNote'));
  const importBox = h('div', { class: 'import' }, importStatus, importErr, h('div', { class: 'row' }, importButton, scanButton), scanNote, backup);
  backup.addEventListener('change', () => {
    const file = backup.files?.[0];
    backup.value = '';
    if (file) void busy(importButton, () => importFrom(file));
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
    scanButton.hidden = scanNote.hidden = key !== 'deltaChat';
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
    const status = h('p', { class: 'hint' }, t('phone.preparing'));
    box.replaceChildren(status);
    try {
      const handoff = await createHandoff(handoffBase(), client, share => {
        status.textContent = t('phone.uploading', { percent: Math.round(share * 100) });
      });
      box.replaceChildren(h('div', { class: 'qr' }, trustedSvg(qrSvg(handoff.url))),
        h('p', { class: 'hint' }, t('phone.waiting')),
        h('p', { class: 'hint' }, h('a', { href: handoff.url, target: '_blank', rel: 'noopener noreferrer' }, t('phone.thisDevice'))));
      while (!signal.aborted) {
        await new Promise(r => setTimeout(r, 2000));
        if (signal.aborted) return;
        const state = await handoffState(handoff).catch(() => 'waiting');
        if (state === 'fetched') {
          void client.markSecured();
          return box.replaceChildren(h('p', { class: 'ok' }, t('phone.fetched')));
        }
        if (state === 'expired') return box.replaceChildren(h('p', {}, t('phone.expired')), newCode());
      }
    } catch (e) {
      console.warn('handoff failed', e);
      if (e instanceof HandoffTooLarge) {
        const mb = (n: number) => String(Math.ceil(n / 1024 / 1024));
        return box.replaceChildren(h('p', { class: 'error' }, t('phone.tooLarge', { size: mb(e.size), max: mb(e.max) })),
          h('button', { type: 'button', onclick: () => exportDialog(client) }, t('profile.export')));
      }
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
    h('button', { class: 'primary', onclick: leave(() => client.config.secured ? startMain(client) : renderBackupReminder(client)) }, t('continue')),
    h('p', {}, h('button', { type: 'button', class: 'link', onclick: busyClick(() => { polling.abort(); return renderConnectPhone(client); }) }, t('phone.otherProfile'))));
  render();
}

/** Offered after setup without a phone: the profile only lives in this browser. */
function renderBackupReminder(client: DcClient) {
  const render = () => screen(t('backup.title'), render,
    h('p', {}, t('backup.text')),
    h('button', { class: 'primary', onclick: () => exportDialog(client, () => startMain(client)) }, t('profile.export')),
    h('p', {}, h('button', { type: 'button', class: 'link', onclick: () => startMain(client) }, t('backup.later'))));
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

function startMain(client: DcClient, initialChat?: string, initialSettings = false) {
  mainListeners?.abort();
  mainListeners = new AbortController();
  const { signal } = mainListeners;
  let current = initialChat;
  // A contact's profile returns to the chat or list it was opened from.
  type GroupView = { group: string };
  let view: 'settings' | 'newChat' | { contact: string; from?: string | GroupView } | GroupView | undefined = initialSettings ? 'settings' : undefined;
  let contactShown: { key: string; el: Element } | undefined;
  let groupShown: { key: string; el: Element; refresh: () => void } | undefined;
  let settings: { key: string; el: Element } | undefined;
  let newChat: ReturnType<typeof newChatView> | undefined;
  let shown: { chatId: string; header: Element; headerKey: string; footer: Element; footerKey: string; list: HTMLElement; pinbar: HTMLButtonElement; pinnedIds?: string; pinnedAt?: string } | undefined;
  const rendered = new Map<string, { node: Element; key: string; urls: string[] }>();
  let startReply: ((m: Message) => void) | undefined;
  let startEdit: ((m: Message) => void) | undefined;
  let dropTarget: { chatId: string; attach: (files: File[]) => Promise<void> } | undefined;
  // Like core's send_edit_request(): own text messages only.
  const canEdit = (chat: Chat, m: Message) => m.from === 'self' && !m.info && !!m.text && m.id.includes('@') && !chat.left;

  const status = h('span', { class: 'status' });
  const chatList = h('ul', { class: 'chatlist' });
  let showArchived = false;
  listenForChatMenu();
  const pane = h('section', { class: 'pane' });
  const droppable = (ev: DragEvent) => {
    const chat = current ? client.chats.get(current) : undefined;
    return !!ev.dataTransfer?.types.includes('Files') && dropTarget?.chatId === chat?.id && !chat?.isRequest && !chat?.left;
  };
  pane.addEventListener('dragover', ev => {
    if (!droppable(ev)) return;
    ev.preventDefault();
    pane.classList.add('dropping');
  });
  pane.addEventListener('dragleave', ev => { if (!pane.contains(ev.relatedTarget as Node | null)) pane.classList.remove('dropping'); });
  pane.addEventListener('drop', ev => {
    pane.classList.remove('dropping');
    if (!droppable(ev)) return;
    ev.preventDefault();
    void dropTarget?.attach([...ev.dataTransfer?.files ?? []]);
  });
  const me = h('div', { class: 'me' });
  const keyWarning = h('div', { class: 'key-warning', role: 'alert', hidden: true });
  const notifyBar = h('div', { class: 'notify-bar', hidden: true });
  const edit = h('button', {
    class: 'icon-button', title: t('nav.settings'), 'aria-label': t('nav.settings'),
    onclick: () => { view = 'settings'; current = undefined; renderAll(); },
  });
  edit.append(icon(ICONS.settings));
  const sidebar = h('aside', { class: 'sidebar' },
    h('header', { class: 'profile' }, me, status, edit),
    keyWarning,
    notifyBar,
    h('nav', { class: 'nav-actions' },
      action(ICONS.qr, t('nav.myInvite'), busyClick(() => showInvite(client))),
      action(ICONS.newChat, t('nav.newChat'), () => { view = 'newChat'; current = undefined; renderAll(); })),
    chatList);

  function renderNotifyBar() {
    notifyBar.hidden = notificationState() !== 'default' || notifyLater();
    notifyBar.replaceChildren(...notifyBar.hidden ? [] : [
      h('p', {}, t('notify.ask')),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: busyClick(askNotifications) }, t('notify.enable')),
        h('button', { onclick: () => { setNotifyLater(); renderNotifyBar(); } }, t('notify.later')))]);
  }

  window.addEventListener('notify-permission', renderNotifyBar, { signal });

  function renderProfile() {
    renderNotifyBar();
    keyWarning.hidden = !client.foreignKeyWarning;
    keyWarning.replaceChildren(...keyWarning.hidden ? [] : [
      h('p', {}, `${t('key.warning')} ${t(canHandoff ? 'key.replacePhone' : 'key.replaceBackup')}`),
      h('div', { class: 'row' },
        canHandoff
          ? h('button', { class: 'primary', onclick: () => phoneDialog(client) }, t('profile.phone'))
          : h('button', { class: 'primary', onclick: () => exportDialog(client) }, t('profile.export')),
        h('button', { onclick: busyClick(() => client.hideForeignKeyWarning()) }, t('key.hide')))]);
    const unsecured = !client.config.secured;
    edit.classList.toggle('attention', unsecured);
    const label = unsecured ? `${t('nav.settings')} – ${t('backup.attention')}` : t('nav.settings');
    edit.title = label;
    edit.setAttribute('aria-label', label);
    const name = client.config.displayName || t('me');
    me.replaceChildren(avatar(name, client.config.addr, undefined, client.config.avatar),
      h('span', { class: 'who' }, h('strong', {}, name)));
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
    const chats = client.sortedChats();
    const archived = chats.filter(c => c.visibility === 'archived');
    if (!archived.length) showArchived = false;
    const unread = chats.reduce((n, c) => n + c.unread, 0);
    if (showArchived) {
      chatList.append(h('li', { class: 'archive-link', title: t('list.back'), onclick: () => { showArchived = false; renderList(); } },
        icon(ICONS.back), h('strong', {}, t('list.archived'))));
    }
    for (const chat of showArchived ? archived : chats.filter(c => c.visibility !== 'archived')) {
      const msgs = client.messages.get(chat.id) ?? [];
      const last = msgs[msgs.length - 1];
      chatList.append(h('li', { class: chat.id === current ? 'active' : '', 'data-chat': chat.id, onclick: () => open(chat.id) },
        chatAvatar(client, chat),
        h('div', { class: 'item' },
          h('div', { class: 'row' },
            h('strong', {}, client.chatTitle(chat) || '…'),
            chat.visibility === 'pinned' ? metaMark(ICONS.pin, 'mark.pinnedChat') : null,
            chat.unread ? h('span', { class: 'badge' }, String(chat.unread)) : null),
          h('small', {}, chat.isRequest ? t('list.request') : last ? `${last.from === 'self' && !last.info ? t('list.mePrefix') : ''}${last.text || attachmentSummary(last.attachments[0])}` : chat.type === 'self' ? t('chat.savedSubtitle') : ''))));
    }
    if (!showArchived && archived.length) {
      const archivedUnread = archived.reduce((n, c) => n + c.unread, 0);
      chatList.append(h('li', { class: 'archive-link', onclick: () => { showArchived = true; renderList(); } },
        icon(ICONS.archive), h('strong', {}, t('list.archived')),
        h('span', { class: 'count' }, String(archived.length)),
        archivedUnread ? h('span', { class: 'badge' }, String(archivedUnread)) : null));
    }
    if (!chatList.children.length) chatList.append(h('li', { class: 'empty' }, t('list.empty')));
    document.title = unread ? `(${unread}) Kitepost` : 'Kitepost';
  }

  function attachmentView(a: AttachmentData, urls: string[]): Node {
    const card = vcardOf(a);
    if (card) {
      const name = card.name || card.addr;
      return h('div', { class: 'attachment' }, h('button', { type: 'button', class: 'vcard', title: t('contacts.chatWith', { name }), onclick: () => openCard(card) },
        avatar(name, card.addr, undefined, card.photo ? avatarDataUrl(card.photo) : undefined),
        h('span', { class: 'names' }, h('strong', {}, name), h('small', {}, card.addr))));
    }
    const kind = INLINE_IMAGE_TYPES.has(a.mime) ? 'image' : playableVideo(a.mime) ? 'video' : undefined;
    const blob = base64ToBlob(a.data_b64, kind ? a.mime : 'application/octet-stream');
    const url = URL.createObjectURL(blob);
    urls.push(url);
    const link = h('a', { href: url, download: a.filename, rel: 'noopener' }, `📎 ${a.filename}`);
    if (!kind) return h('div', { class: 'attachment' }, link);
    const media = kind === 'image'
      ? h('img', { src: url, alt: a.filename })
      : h('video', { src: url, preload: 'metadata', muted: true, playsinline: true, tabindex: '-1', 'aria-hidden': 'true' });
    mediaFiles.set(media, { blob, name: a.filename });
    const open = h('button', {
      type: 'button', class: `image ${kind}`, title: t(kind === 'image' ? 'image.open' : 'video.play'),
      'aria-label': kind === 'video' ? `${t('video.play')}: ${a.filename}` : undefined,
      onclick: ev => lightbox(ev.currentTarget as HTMLElement),
    }, media, kind === 'video' ? h('span', { class: 'play' }, icon(ICONS.play)) : null);
    return h('div', { class: 'attachment' }, open, link);
  }

  const authorName = (from: string) => from === 'self' ? t('me') : client.contactName(from);
  const repliedTo = (chat: Chat, m: Message) => m.replyTo ? client.messages.get(chat.id)?.find(x => x.id === m.replyTo) : undefined;

  /** Everything `messageView` shows, so that unchanged messages keep their nodes. */
  function messageKey(chat: Chat, m: Message): string {
    const parent = m.quote !== undefined ? repliedTo(chat, m) : undefined;
    return JSON.stringify([m.text, m.info, m.state, m.error, m.edited, m.pinned, !!client.savedCopy(m), m.ephemeralTimer, m.reactions, formatTime(m.timestamp),
      m.attachments.map(a => [a.filename, a.mime, a.data_b64.length]), m.quote, parent && authorName(parent.from),
      chat.left, chat.isRequest, chat.type === 'group' && m.from !== 'self' ? client.contactName(m.from) : '', originChat(m)?.id, originChat(m) && client.chatTitle(originChat(m)!)]);
  }

  function deleteDialog(chat: Chat, msgs: Message[]) {
    const remove = (forAll: boolean) => async () => {
      await client.deleteMessages(chat.id, msgs.map(m => m.id), forAll);
      clearSelection();
    };
    const self = chat.type === 'self';
    const forAll = canDeleteForAll(chat, msgs);
    const title = msgs.length > 1 ? t('chat.deleteMessagesTitle', { n: msgs.length }) : t('chat.deleteMessageTitle');
    dialog(title, h('p', {}, t(self ? 'chat.deleteMessageTextSelf' : forAll ? 'chat.deleteMessageTextOwn' : 'chat.deleteMessageText')), [
      { label: t('cancel') },
      { label: t(self ? 'chat.delete' : 'chat.deleteForMe'), primary: !forAll, onClick: remove(false) },
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

  function originChat(m: Message): Chat | undefined {
    const orig = client.originalOf(m);
    return orig && client.chats.get(orig.chatId);
  }

  function showOriginal(m: Message) {
    const orig = client.originalOf(m);
    if (!orig) return;
    open(orig.chatId);
    jumpTo(orig.id);
  }

  function showSaved(m: Message) {
    const copy = client.savedCopy(m);
    if (!copy) return;
    open(copy.chatId);
    jumpTo(copy.id);
  }

  function savedMark(m: Message): Element | null {
    if (!client.savedCopy(m)) return null;
    const b = h('button', { type: 'button', class: 'mark', title: t('mark.showSaved'), 'aria-label': t('mark.showSaved'), onclick: () => showSaved(m) });
    b.append(icon(ICONS.star));
    return b;
  }

  function originView(m: Message): Element | null {
    const chat = originChat(m);
    if (!chat) return null;
    const b = h('button', { type: 'button', class: 'origin', title: t('chat.showOriginal'), onclick: () => showOriginal(m) }, h('span', {}, client.chatTitle(chat)));
    b.prepend(icon(ICONS.forward));
    return b;
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
    if (m.info) {
      return m.replyTo
        ? h('button', { type: 'button', class: 'info linked', 'data-id': m.id, onclick: () => jumpTo(m.replyTo!) }, m.text)
        : h('div', { class: 'info', 'data-id': m.id }, m.text);
    }
    const out = m.from === 'self';
    const state = out && m.state !== 'received' ? stateMark(m.state) : null;
    const canReact = !chat.left && !chat.isRequest && m.id.includes('@');
    const mine = m.reactions.self;
    // One reaction per person: choosing the own one again removes it.
    const react = (emoji: string) => client.sendReaction(chat.id, m.id, emoji === mine ? '' : emoji);
    const counts = new Map<string, number>();
    for (const r of Object.values(m.reactions)) counts.set(r, (counts.get(r) ?? 0) + 1);
    const actions = messageActions(chat, [m]);
    const hover = actions.filter(a => a.icon === ICONS.react || a.icon === ICONS.reply).map(actionButton);
    const more = iconButton(ICONS.more, t('chat.more'), ev => openMenu(chat, m, more, undefined, (ev as MouseEvent).detail === 0));
    return h('div', { class: `msg ${out ? 'out' : 'in'}${counts.size ? ' reacted' : ''}`, 'data-id': m.id },
      !out && chat.type === 'group' ? h('div', { class: 'sender' }, client.contactName(m.from)) : null,
      originView(m),
      quoteView(chat, m),
      ...m.attachments.map(a => attachmentView(a, urls)),
      m.text ? h('div', { class: 'text' }, ...linkified(m.text, openAddress)) : null,
      h('div', { class: 'meta' }, m.ephemeralTimer ? metaMark(ICONS.timer, 'mark.ephemeral') : null, savedMark(m), m.pinned ? metaMark(ICONS.pin, 'mark.pinned') : null, m.edited ? `${t('chat.edited')} · ` : '', formatTime(m.timestamp), state, m.error ? ` ${t(`sendError.${sendErrorKind(m.error) ?? 'other'}`)}` : ''),
      counts.size ? h('button', {
        type: 'button', class: 'reactions', 'aria-label': t('info.reactions'),
        onclick: (ev: Event) => openReactedBy(ev.currentTarget as HTMLElement, m, canReact ? () => react(mine!) : undefined),
      }, ...[...counts].map(([r, n]) => h('span', { class: r === mine ? 'reaction mine' : 'reaction' }, n > 1 ? `${r} ${n}` : r))) : null,
      h('div', { class: 'actions' }, ...hover, more));
  }

  /** Who reacted, like WhatsApp's overlay on a tap on the reactions; the own one can be removed there. */
  function openReactedBy(anchor: HTMLElement, m: Message, remove?: () => Promise<unknown>) {
    const entries = Object.entries(m.reactions).sort(([a], [b]) => Number(b === 'self') - Number(a === 'self'));
    const box = h('ul', { class: 'reacted-by', 'aria-label': t('info.reactions') }, ...entries.map(([from, r]) => h('li', {},
      h('span', { class: 'emoji' }, r),
      h('span', { class: 'name' }, authorName(from)),
      from === 'self' && remove ? h('button', { type: 'button', class: 'link', onclick: busyClick(async () => { await remove(); close(); }) }, t('reactions.remove')) : null)));
    const close = popover(anchor, box);
  }

  type MsgAction = { label: string; icon: string; run: (anchor: HTMLElement) => unknown };

  /** Android's message actions: all for one message, those that make sense for several. */
  function messageActions(chat: Chat, msgs: Message[]): MsgAction[] {
    const one = msgs.length === 1 ? msgs[0] : undefined;
    const canReact = one && !one.info && !chat.left && !chat.isRequest && one.id.includes('@');
    const done = <T>(f: () => T) => () => { clearSelection(); return f(); };
    const text = copyText(msgs);
    const actions: (MsgAction | false | undefined)[] = [
      canReact && { label: t('chat.react'), icon: ICONS.react, run: anchor => openReactions(anchor, e => {
        clearSelection();
        // One reaction per person: choosing the own one again removes it.
        const send = () => client.sendReaction(chat.id, one.id, e === one.reactions.self ? '' : e);
        void (anchor instanceof HTMLButtonElement ? whileBusy(anchor, send) : send()).catch(errorDialog);
      }) },
      canReact && { label: t('chat.reply'), icon: ICONS.reply, run: done(() => startReply?.(one)) },
      one && canEdit(chat, one) && { label: t('chat.edit'), icon: ICONS.edit, run: done(() => startEdit?.(one)) },
      canResend(chat, msgs) && { label: t('chat.resend'), icon: ICONS.resend, run: done(() => client.resend(chat.id, [...msgs].sort(byChatOrder).map(m => m.id)).catch(errorDialog)) },
      one && { label: t('chat.messageInfo'), icon: ICONS.info, run: done(() => infoDialog(one)) },
      one && originChat(one) && { label: t('chat.showOriginal'), icon: ICONS.forward, run: done(() => showOriginal(one)) },
      one && pinnable(one) && !chat.left && !chat.isRequest && {
        label: t(one.pinned ? 'chat.unpin' : 'chat.pin'), icon: ICONS.pin, run: done(() => client.setPinned(chat.id, one.id, !one.pinned).catch(errorDialog)),
      },
      one && savable(one) && saveAction(one),
      !!text && { label: t('chat.copy'), icon: ICONS.copy, run: done(() => navigator.clipboard.writeText(text).catch(errorDialog)) },
      { label: t('chat.deleteMessage'), icon: ICONS.trash, run: () => deleteDialog(chat, msgs) },
    ];
    return actions.filter((a): a is MsgAction => !!a);
  }

  function saveAction(m: Message): MsgAction {
    const copy = client.savedCopy(m);
    const run = () => {
      clearSelection();
      const job = copy ? client.deleteMessages(copy.chatId, [copy.id], false) : client.saveToSelf(m.chatId, m.id);
      return job.catch(errorDialog);
    };
    return { label: t(copy ? 'chat.unsave' : 'chat.save'), icon: ICONS.star, run };
  }

  /** Like Android's handleCopyMessage(): several messages get the sender's name whenever it changes. */
  function copyText(msgs: Message[]): string {
    if (msgs.length === 1) return msgs[0].text;
    let last: string | undefined;
    const parts: string[] = [];
    for (const m of msgs) {
      const body = m.text || m.attachments.map(a => a.filename).join(', ');
      if (!body) continue;
      parts.push(m.from === last ? body : `${client.contactName(m.from)}:\n${body}`);
      last = m.from;
    }
    return parts.join('\n\n');
  }

  function actionButton(a: MsgAction): HTMLButtonElement {
    const b: HTMLButtonElement = iconButton(a.icon, a.label, () => a.run(b));
    return b;
  }

  function openMenu(chat: Chat, m: Message, anchor: HTMLElement, at?: DOMRect, byKeyboard = false) {
    const item = (label: string, d: string, run: () => unknown) => {
      const b = h('button', { type: 'button', role: 'menuitem', onclick: () => { close(); run(); } }, h('span', {}, label));
      b.prepend(icon(d));
      return b;
    };
    const box = h('div', { class: 'menu', role: 'menu' },
      ...messageActions(chat, [m]).map(a => item(a.label, a.icon, () => a.run(anchor))),
      item(t('chat.select'), ICONS.select, () => toggleSelected(m.id)));
    const close = popover(anchor, box, at);
    if (byKeyboard) box.querySelector('button')?.focus();
  }

  // ---------------------------------------------------------------- selection mode, like Android's action mode

  const selected = new Set<string>();
  const selbar = h('header', { class: 'selbar' });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && selected.size && !document.querySelector('dialog[open], .popover')) clearSelection();
  }, { signal });

  /** Pin and archive like Delta Chat's chatlist menu: right click, or a long press on touch screens. */
  function listenForChatMenu() {
    listenForItemMenu(chatList, 'li[data-chat]', (li, at) => {
      const chat = client.chats.get(li.dataset.chat!);
      if (!chat) return;
      const set = (v: Chat['visibility']) => () => void client.setVisibility(chat.id, v).catch(errorDialog);
      showMenu(li, at,
        chat.left || chat.isRequest ? null : [t('timer.title'), ICONS.timer, () => timerDialog(chat)],
        chat.visibility === 'pinned' ? [t('chat.unpinChat'), ICONS.pin, set(undefined)] : [t('chat.pinChat'), ICONS.pin, set('pinned')],
        chat.visibility === 'archived' ? [t('chat.unarchive'), ICONS.archive, set(undefined)] : [t('chat.archive'), ICONS.archive, set('archived')]);
    });
  }

  function listenForSelection(list: HTMLElement) {
    const msgOf = (target: EventTarget | null) => (target as Element | null)?.closest<HTMLElement>('.msg[data-id], .info[data-id]');
    let press: { timer: number; x: number; y: number } | undefined;
    let longPressed = false;
    let touch = false;
    const cancel = () => {
      if (press) clearTimeout(press.timer);
      press = undefined;
    };
    list.addEventListener('pointerdown', ev => {
      touch = ev.pointerType === 'touch';
      longPressed = false;
      const msg = msgOf(ev.target);
      if (!touch || !msg || selected.size) return;
      const timer = window.setTimeout(() => {
        press = undefined;
        longPressed = true;
        toggleSelected(msg.dataset.id!);
      }, 500);
      press = { timer, x: ev.clientX, y: ev.clientY };
    });
    list.addEventListener('pointermove', ev => {
      if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 10) cancel();
    });
    list.addEventListener('pointerup', cancel);
    list.addEventListener('pointercancel', cancel);
    list.addEventListener('contextmenu', ev => {
      const msg = msgOf(ev.target);
      const chat = current ? client.chats.get(current) : undefined;
      const m = msg && chat && client.messages.get(chat.id)?.find(x => x.id === msg.dataset.id);
      if (!m || !chat || window.getSelection()?.toString() || (ev.target as Element).closest('a.link')) return;
      ev.preventDefault();
      if (!touch && !selected.size) openMenu(chat, m, msg, new DOMRect(ev.clientX, ev.clientY, 0, 0));
    });
    // Capturing, so that in selection mode a tap on a quote or reaction selects instead.
    list.addEventListener('click', ev => {
      const msg = msgOf(ev.target);
      const link = (ev.target as Element).closest('a');
      const selects = selected.size ? !link?.hasAttribute('download') : !link && (ev.ctrlKey || ev.metaKey);
      if (longPressed || (msg && selects)) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!longPressed && msg) toggleSelected(msg.dataset.id!);
        longPressed = false;
      }
    }, true);
  }

  function toggleSelected(id: string) {
    if (!selected.delete(id)) selected.add(id);
    const chat = current ? client.chats.get(current) : undefined;
    if (chat && shown) renderMessages(chat, shown.list);
  }

  function clearSelection() {
    if (!selected.size) return;
    selected.clear();
    const chat = current ? client.chats.get(current) : undefined;
    if (chat && shown) renderMessages(chat, shown.list);
  }

  function renderSelection(chat: Chat, list: HTMLElement) {
    const msgs = (client.messages.get(chat.id) ?? []).filter(m => selected.has(m.id));
    for (const id of [...selected]) if (!msgs.some(m => m.id === id)) selected.delete(id);
    pane.classList.toggle('selecting', msgs.length > 0);
    list.classList.toggle('selecting', msgs.length > 0);
    if (!msgs.length) return selbar.replaceChildren();
    selbar.replaceChildren(
      iconButton(ICONS.close, t('chat.selectCancel'), clearSelection),
      h('strong', { class: 'count' }, t('chat.selected', { n: msgs.length })),
      ...messageActions(chat, msgs).map(actionButton));
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
      : contact?.lastSeen ? t('chat.lastSeen', { when: formatAgo(contact.lastSeen) }) : '';
    const key = JSON.stringify([client.chatTitle(chat), subtitle, chat.type, chat.grpid, contact?.fingerprint, contact?.addr, contact?.avatar?.slice(-24), chat.avatar?.slice(-24), contact && client.freshness(contact) === 'recent', chat.ephemeralTimer]);
    const timerLabel = chat.ephemeralTimer ? t('timer.current', { duration: formatDuration(chat.ephemeralTimer) }) : '';
    const settings = () => {
      if (chat.type === 'single' && chat.contact) return showContact(chat.contact, chat.id);
      view = { group: chat.id };
      current = undefined;
      renderAll();
    };
    return [key, h('header', { class: 'chathead' },
      h('button', { class: 'back', onclick: () => { current = undefined; renderAll(); } }, '‹'),
      chatAvatar(client, chat),
      h('button', { type: 'button', class: 'who', title: t('chat.settings'), onclick: settings }, h('strong', {}, client.chatTitle(chat)), subtitle ? h('small', {}, subtitle) : null),
      chat.ephemeralTimer ? h('button', { class: 'icon-button', title: timerLabel, 'aria-label': timerLabel, onclick: () => timerDialog(chat) }, icon(ICONS.timer)) : null,
      chat.type === 'group' ? h('button', { onclick: busyClick(() => showInvite(client, chat.id)) }, t('invite.link')) : null,
      chat.type === 'self' ? h('button', { class: 'icon-button', title: t('saved.about'), 'aria-label': t('saved.about'), onclick: savedInfo }, icon(ICONS.info)) : null,
      h('button', { class: 'icon-button edit-chat', title: t('chat.settings'), 'aria-label': t('chat.settings'), onclick: settings }, icon(ICONS.edit)))];
  }

  function savedInfo() {
    dialog(t('chat.saved'), h('div', {}, ...(['saved.notes', 'saved.copies', 'saved.sync'] as const).map(k => h('p', {}, t(k)))), [{ label: t('close') }]);
  }

  function leaveChat() {
    shown = undefined;
    selected.clear();
    pane.classList.remove('selecting');
    forgetMessages();
  }

  const footerKey = (chat: Chat) => JSON.stringify([chat.isRequest, chat.left]);

  function chatFooter(chat: Chat): Element {
    return chat.isRequest
      ? h('div', { class: 'request' },
        h('span', {}, t('chat.request')),
        h('button', { class: 'primary', onclick: busyClick(() => client.acceptChat(chat.id, true)) }, t('accept')),
        h('button', { onclick: busyClick(async () => { await client.blockChat(chat.id); current = undefined; renderAll(); }) }, t('block')))
      : composer(chat);
  }

  function renderPane() {
    const chat = current ? client.chats.get(current) : undefined;
    if (chat && client.isBlockedChat(chat)) {
      current = undefined;
      return renderAll();
    }
    if (view === 'newChat') {
      if (newChat && pane.contains(newChat.el)) return newChat.refresh();
      leaveChat();
      newChat = newChatView(client, open, fp => showContact(fp, 'newChat'), () => { view = undefined; renderAll(); });
      pane.replaceChildren(newChat.el);
      return;
    }
    if (typeof view === 'object' && 'group' in view) {
      const chatId = view.group;
      const chat = client.chats.get(chatId);
      const back = () => chat && client.chats.has(chatId) ? open(chatId) : (view = undefined, renderAll());
      if (!chat) return back();
      const key = JSON.stringify([chatId, client.chatTitle(chat), chat.left, chat.avatar?.slice(-24), client.config.bccSelf]);
      if (groupShown?.key === key && pane.contains(groupShown.el)) return groupShown.refresh();
      leaveChat();
      const self = view;
      groupShown = { key, ...groupView(client, chat, fp => showContact(fp, self), back, () => { view = undefined; renderAll(); }) };
      pane.replaceChildren(groupShown.el);
      return;
    }
    if (typeof view === 'object') {
      const { contact: fp, from } = view;
      const c = client.contacts.get(fp);
      // The view shows nickname edits itself; rebuilding it would swallow a click in Firefox.
      const key = JSON.stringify([fp, c && { ...c, nickname: undefined }, client.chats.has(`c-${fp}`), client.sortedChats().filter(g => g.type === 'group' && g.members.includes(fp)).map(g => [g.id, g.name, g.left])]);
      if (contactShown?.key === key && pane.contains(contactShown.el)) return;
      leaveChat();
      const back = () => {
        if (from === 'newChat') view = 'newChat';
        else if (typeof from === 'object' && client.chats.has(from.group)) view = from;
        else if (typeof from === 'string' && client.chats.has(from)) return open(from);
        else view = undefined;
        renderAll();
      };
      const el = contactView(client, fp, open, back);
      if (!el) return back();
      contactShown = { key, el };
      pane.replaceChildren(el);
      return;
    }
    if (view === 'settings') {
      const key = JSON.stringify([client.config.secured, canHandoff, client.config.displayName, client.config.avatarChangedAt, client.selfAddrs()]);
      if (settings?.key === key && pane.contains(settings.el)) return;
      leaveChat();
      settings = { key, el: settingsView(client, () => startMain(client, undefined, true), () => { view = undefined; renderAll(); }) };
      pane.replaceChildren(settings.el);
      return;
    }
    if (!chat) {
      leaveChat();
      pane.replaceChildren(h('div', { class: 'placeholder' }, h('p', {}, t('pane.select')), h('p', {}, t('pane.e2e'))));
      return;
    }
    if (shown?.chatId !== chat.id) {
      forgetMessages();
      const [headerKey, header] = chatHeader(chat);
      const footer = chatFooter(chat);
      const list = h('div', { class: 'messages' });
      const pinbar = h('button', { type: 'button', class: 'pinbar', hidden: true, onclick: () => showPinned(chat.id) });
      shown = { chatId: chat.id, header, headerKey, footer, footerKey: footerKey(chat), list, pinbar };
      selected.clear();
      listenForSelection(list);
      // Scroll anchoring keeps the top in place when the growing composer shrinks the list.
      let height = 0;
      new ResizeObserver(() => {
        if (list.scrollHeight - list.scrollTop - height < 40) list.scrollTop = list.scrollHeight;
        height = list.clientHeight;
      }).observe(list);
      pane.replaceChildren(header, selbar, pinbar, shown.list, footer);
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
    renderPinned(chat);
    if (!document.hidden) void client.markRead(chat.id);
  }

  /** Like core's get_pinned_messages(): the bar starts at the newest and steps back with every tap. */
  function renderPinned(chat: Chat) {
    if (!shown) return;
    const pinned = (client.messages.get(chat.id) ?? []).filter(m => m.pinned);
    const ids = pinned.map(x => x.id).join(' ');
    if (ids !== shown.pinnedIds) Object.assign(shown, { pinnedIds: ids, pinnedAt: undefined });
    const m = pinned.find(x => x.id === shown!.pinnedAt) ?? pinned.at(-1);
    shown.pinnedAt = m?.id;
    shown.pinbar.hidden = !m;
    if (!m) return;
    const label = pinned.length > 1 ? t('chat.pinnedOf', { n: pinned.indexOf(m) + 1, count: pinned.length }) : t('chat.pinned');
    shown.pinbar.replaceChildren(icon(ICONS.pin), h('span', {},
      h('strong', {}, label),
      h('span', {}, m.text || m.attachments[0]?.filename || '')));
  }

  function showPinned(chatId: string) {
    const chat = client.chats.get(chatId);
    if (!shown || !chat) return;
    const pinned = (client.messages.get(chatId) ?? []).filter(m => m.pinned);
    const i = pinned.findIndex(m => m.id === shown!.pinnedAt);
    if (i < 0) return;
    jumpTo(pinned[i].id);
    shown.pinnedAt = pinned[(i - 1 + pinned.length) % pinned.length].id;
    renderPinned(chat);
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
      r.node.classList.toggle('selected', selected.has(m.id));
      prev = r.node;
    }
    renderSelection(chat, list);
    if (atBottom || ownNew) list.scrollTop = list.scrollHeight;
  }

  function composer(chat: Chat): Element {
    let attachments: AttachmentData[] = [];
    let quoted: Message | undefined;
    let editing: Message | undefined;
    const input = h('textarea', { rows: '1', placeholder: chat.left ? t('chat.notMember') : t('chat.message'), disabled: chat.left });
    const file = h('input', { type: 'file', multiple: true, hidden: true });
    const chips = h('div', { class: 'chips' });
    const renderChips = () => chips.replaceChildren(...attachments.map(a => h('button', {
      type: 'button', class: 'chip', title: t('chat.removeFile'),
      onclick: () => { attachments = attachments.filter(x => x !== a); renderChips(); input.focus(); },
    }, `📎 ${a.filename} ✕`)));
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
        attachments = [];
        renderChips();
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
      if (!text && !attachments.length) return;
      const atts = attachments;
      const q = quoted;
      const before = client.messages.get(chat.id)?.length ?? 0;
      input.value = '';
      attachments = [];
      renderChips();
      setContext();
      try {
        // Delta Chat shows one file per message; the text and the reply go with the first.
        await client.sendText(chat.id, text, atts[0], q);
        for (const a of atts.slice(1)) await client.sendText(chat.id, '', a);
      } catch (e) {
        // A message that was created shows its error itself.
        if ((client.messages.get(chat.id)?.length ?? 0) > before) return console.warn(e);
        const ta = pane.querySelector('textarea');
        if (ta && !ta.value) ta.value = text;
        if (q && !quoted) setContext('reply', q);
        errorDialog(e);
      }
    };
    const attach = async (files: File[]) => {
      if (editing) setContext();
      if (files.some(f => f.size > MAX_UPLOAD)) void dialog(t('chat.tooLargeTitle'), h('p', {}, t('chat.tooLargeText')), [{ label: t('ok') }]);
      for (const f of files.filter(f => f.size <= MAX_UPLOAD)) {
        attachments.push({ filename: f.name.replace(/[\\/\p{Cc}]/gu, '_') || 'file', mime: f.type || 'application/octet-stream', data_b64: await blobToBase64(f) });
      }
      renderChips();
      input.focus();
    };
    dropTarget = { chatId: chat.id, attach };
    file.addEventListener('change', () => {
      const files = [...file.files ?? []];
      file.value = '';
      void attach(files);
    });
    input.addEventListener('paste', ev => {
      const data = ev.clipboardData;
      if (!data) return;
      const args: [File[], string, string] = [[...data.files], data.getData('text/plain'), data.getData('text/uri-list')];
      const files = pastedFiles(...args);
      if (!files) return;
      ev.preventDefault();
      void attach(files);
      const missing = pasteIncomplete(...args);
      if (missing) dialog(t('chat.pasteIncompleteTitle'), h('p', {}, t('chat.pasteIncompleteText', missing)), [{ label: t('ok'), primary: true }]);
    });
    const grow = h('div', { class: 'grow' }, replyBox, chips, input);
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
      emojiButton, grow,
      h('button', { class: 'icon', title: t('chat.attach'), 'aria-label': t('chat.attach'), disabled: chat.left, onclick: () => file.click() }, '📎'),
      file,
      h('button', { class: 'primary', disabled: chat.left, onclick: send }, t('chat.send')));
  }

  function open(chatId: string) {
    current = chatId;
    view = undefined;
    renderAll();
  }

  function openCard(card: VcardContact) {
    const name = card.name || card.addr;
    dialog(name, h('p', {}, t('contacts.chatWith', { name })), [
      { label: t('cancel') },
      {
        label: t('ok'), primary: true, onClick: async () => {
          const fp = await client.importVcardContact(card);
          if (!fp) return;
          if (client.contacts.get(fp)?.blocked) showContact(fp);
          else open(await client.chatWith(fp));
        },
      },
    ]);
  }

  /** A known contact's address offers a chat, others open the mail program. */
  function openAddress(addr: string, ev: Event) {
    const lower = addr.toLowerCase();
    const c = [...client.contacts.values()].find(c => c.publicKey && c.addr === lower && c.fingerprint !== client.config.fingerprint);
    if (!c) return;
    ev.preventDefault();
    const name = client.contactName(c.fingerprint);
    dialog(name, h('p', {}, t('contacts.chatWith', { name })), [
      { label: t('cancel') },
      { label: t('ok'), primary: true, onClick: async () => c.blocked ? showContact(c.fingerprint) : open(await client.chatWith(c.fingerprint)) },
    ]);
  }

  function showContact(fp: string, from?: string | GroupView) {
    view = { contact: fp, from };
    current = undefined;
    renderAll();
  }

  function renderAll() {
    root().querySelector('.layout')?.classList.toggle('chat-open', !!current || !!view);
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
    if (what === 'chats' || what === 'contacts' || what === `messages:${current}` || what === 'config') renderPane();
  }, { signal });
  // "Last seen" and the green dot age without any event.
  const tick = setInterval(() => { renderList(); renderPane(); }, 60_000);
  signal.addEventListener('abort', () => clearInterval(tick));
  client.addEventListener('incoming', ev => {
    const d = (ev as CustomEvent<Incoming>).detail;
    const chat = client.chats.get(d.chatId);
    if (document.hidden && chat && !chat.isRequest && 'Notification' in window && Notification.permission === 'granted') notify(chat, d);
  }, { signal });

  /** Like Delta Chat's ephemeral timer dialog; the choices of Delta Chat Desktop. */
  function timerDialog(chat: Chat) {
    const current = chat.ephemeralTimer ?? 0;
    const choices = [0, 300, 1800, 3600, 86_400, 604_800, 3_024_000, 31_536_000];
    if (!choices.includes(current)) choices.push(current);
    const select = h('select', { 'aria-label': t('timer.title') },
      ...choices.sort((a, b) => a - b).map(s => h('option', { value: String(s), selected: s === current }, s ? formatDuration(s) : t('timer.off'))));
    dialog(t('timer.title'), h('div', {}, h('p', {}, t('timer.text')), select), [
      { label: t('cancel') },
      { label: t('save'), primary: true, onClick: () => client.setEphemeralTimer(chat.id, Number(select.value)) },
    ]);
  }

  /** Like Delta Chat's notifications: one per chat, replaced by the next one. */
  function notify(chat: Chat, d: Incoming) {
    const details = client.notifyDetails;
    const sender = client.contactName(d.from);
    const m = client.messages.get(chat.id)?.find(x => x.id === d.msgId);
    const group = chat.type === 'group';
    let body = t('chat.newMessage');
    if (details === 'all' && d.reaction) body = t('notify.reacted', { name: sender, reaction: d.reaction });
    else if (details === 'all' && m) body = `${group ? `${sender}: ` : ''}${m.text || attachmentKind(m.attachments[0]?.mime ?? '')}`;
    else if (details === 'sender' && group) body = `${sender}: ${body}`;
    const title = details === 'none' ? 'Kitepost' : client.chatTitle(chat);
    const n = new Notification(title, {
      body: body.length > 200 ? `${body.slice(0, 199)}…` : body, tag: chat.id,
      icon: details === 'none' ? undefined
        : chatImage(client, chat) || avatarImage(client.chatTitle(chat), chatAvatarKey(client, chat)),
      renotify: true,
    } as NotificationOptions);
    n.onclick = () => {
      window.focus();
      open(chat.id);
      n.close();
    };
  }
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
  settings: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  reply: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  react: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 14.5s1.3 1.8 3.5 1.8 3.5-1.8 3.5-1.8M9 9.5h.01M15 9.5h.01',
  star: 'M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9z',
  more: 'M4 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0M11 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0M18 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  select: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12l3 3 5-6',
  pin: 'M12 17v5M9 4h6M10 4v6l-3.5 4v3h11v-3L14 10V4',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  timer: 'M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9',
  back: 'M15 18l-6-6 6-6',
  forward: 'M9 6l6 6-6 6',
  resend: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  close: 'M6 6l12 12M18 6 6 18',
  play: 'M8 5.5v13l10.5-6.5z',
  newChat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12zM12 8.5v7M8.5 12h7',
  group: 'M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM22 20v-1.5a4 4 0 0 0-3-3.87M16 4.13a3.5 3.5 0 0 1 0 6.75',
};

/** The state of an own message as an icon whose label says what it means. */
function stateMark(state: Exclude<Message['state'], 'received'>): Element {
  const label = t(`mark.${state}`);
  const mark = h('span', { class: 'state', 'data-state': state, role: 'img', 'aria-label': label, title: label });
  mark.append(icon(STATE_ICONS[state]));
  return mark;
}

function metaMark(d: string, key: 'mark.pinned' | 'mark.pinnedChat' | 'mark.ephemeral'): Element {
  const label = t(key);
  const mark = h('span', { class: 'mark', role: 'img', 'aria-label': label, title: label });
  mark.append(icon(d));
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

/** Calls `show` on a right-click or, on touch screens, a long press on an item of `list`. */
function listenForItemMenu(list: HTMLElement, selector: string, show: (item: HTMLElement, at: DOMRect) => void) {
  const itemOf = (target: EventTarget | null) => (target as Element | null)?.closest<HTMLElement>(selector);
  let press: { timer: number; x: number; y: number } | undefined;
  let longPressed = false;
  const cancel = () => {
    if (press) clearTimeout(press.timer);
    press = undefined;
  };
  list.addEventListener('contextmenu', ev => {
    const item = itemOf(ev.target);
    if (!item) return;
    ev.preventDefault();
    if (!press && !longPressed) show(item, new DOMRect(ev.clientX, ev.clientY, 0, 0));
  });
  list.addEventListener('pointerdown', ev => {
    longPressed = false;
    const item = itemOf(ev.target);
    if (ev.pointerType !== 'touch' || !item) return;
    const timer = window.setTimeout(() => {
      press = undefined;
      longPressed = true;
      show(item, new DOMRect(ev.clientX, ev.clientY, 0, 0));
    }, 500);
    press = { timer, x: ev.clientX, y: ev.clientY };
  });
  list.addEventListener('pointermove', ev => {
    if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 10) cancel();
  });
  list.addEventListener('pointerup', cancel);
  list.addEventListener('pointercancel', cancel);
  list.addEventListener('click', ev => {
    if (!longPressed) return;
    ev.preventDefault();
    ev.stopPropagation();
    longPressed = false;
  }, true);
}

function showMenu(anchor: HTMLElement, at: DOMRect, ...items: ([label: string, d: string, run: () => void] | null)[]) {
  const box = h('div', { class: 'menu', role: 'menu' }, ...items.map(i => {
    if (!i) return null;
    const b = h('button', { type: 'button', role: 'menuitem', onclick: () => { close(); i[2](); } }, h('span', {}, i[0]));
    b.prepend(icon(i[1]));
    return b;
  }));
  const close = popover(anchor, box, at);
}

function iconButton(d: string, label: string, onclick: (ev: Event) => void): HTMLButtonElement {
  const b = h('button', { type: 'button', title: label, 'aria-label': label, onclick });
  b.append(icon(d));
  return b;
}

function action(d: string, label: string, onclick: (ev: Event) => void) {
  const b = h('button', { onclick }, h('span', {}, label));
  b.prepend(icon(d));
  return b;
}

/** Letter avatar with a stable color per address, like Delta Chat's. */
function avatar(name: string, key: string, content?: Node, image?: string) {
  const el = h('span', { class: 'avatar', 'aria-hidden': 'true' },
    image ? h('img', { src: image, alt: '' }) : content ?? h('span', {}, ([...name.trim()][0] ?? '?').toUpperCase()));
  el.style.background = `hsl(${avatarHue(key)} 42% 42%)`;
  return el;
}

const NOTIFY_LATER = 'kitepost-notify-later';

function notificationState(): NotificationPermission | 'unsupported' {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

async function askNotifications() {
  await Notification.requestPermission();
  window.dispatchEvent(new Event('notify-permission'));
}

function notifyLater(): boolean {
  try {
    return localStorage.getItem(NOTIFY_LATER) === '1';
  } catch {
    return false;
  }
}

function setNotifyLater() {
  try {
    localStorage.setItem(NOTIFY_LATER, '1');
  } catch {
    // Storage can be blocked; the bar then returns on the next load.
  }
}

type Incoming = { chatId: string; from: string; msgId: string; reaction?: string };

const chatAvatarKey = (client: DcClient, chat: Chat) =>
  chat.type === 'self' ? 'self' : (chat.type === 'single' ? client.contacts.get(chat.contact ?? '')?.addr : chat.grpid) ?? chat.id;

const avatarHue = (key: string) => {
  let hash = 0;
  for (const c of key) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return hash % 360;
};

/** The letter avatar as an image, for notifications. */
function avatarImage(name: string, key: string): string {
  const canvas = h('canvas', { width: '96', height: '96' });
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = `hsl(${avatarHue(key)} 42% 42%)`;
  ctx.arc(48, 48, 48, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = '600 48px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(([...name.trim()][0] ?? '?').toUpperCase(), 48, 51);
  return canvas.toDataURL();
}

function vcardOf(a: AttachmentData): VcardContact | undefined {
  if (!isVcard(a)) return undefined;
  try {
    return parseVcard(new TextDecoder().decode(Uint8Array.from(atob(a.data_b64), c => c.charCodeAt(0))))[0];
  } catch {
    return undefined;
  }
}

/** Like core's summary of a vCard: the contact's name. */
function attachmentSummary(a: AttachmentData | undefined): string {
  if (!a) return '';
  const card = vcardOf(a);
  return card ? `👤 ${card.name || card.addr}` : a.filename;
}

function attachmentKind(mime: string): string {
  if (/^text\/(x-)?vcard$/i.test(mime)) return t('notify.contact');
  const kind = mime.split('/')[0];
  return t(kind === 'image' ? 'notify.image' : kind === 'video' ? 'notify.video' : kind === 'audio' ? 'notify.audio' : 'notify.file');
}

const chatImage = (client: DcClient, chat: Chat) =>
  chat.type === 'single' ? client.contacts.get(chat.contact ?? '')?.avatar : chat.avatar;

function chatAvatar(client: DcClient, chat: Chat) {
  if (chat.type === 'self') return avatar('', 'self', icon(ICONS.star));
  const contact = chat.type === 'single' ? client.contacts.get(chat.contact ?? '') : undefined;
  const el = avatar(client.chatTitle(chat), chatAvatarKey(client, chat), undefined, chatImage(client, chat));
  if (contact && client.freshness(contact) === 'recent') el.classList.add('seen');
  return el;
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

/** Like Delta Chat's "Edit relay", for the password only. */
function editRelayDialog(client: DcClient, addr: string) {
  const password = h('input', { type: 'password', autocomplete: 'new-password' });
  const first = addr === client.config.addr;
  dialog(t('relays.editTitle', { addr }), h('div', {}, h('p', {}, t('relays.editText')), field(t('setup.password'), password),
    first ? h('p', { class: 'hint' }, t('relays.editFirst')) : null), [
    { label: t('cancel') },
    { label: t('save'), primary: true, onClick: () => client.changeRelayPassword(addr, password.value) },
  ]);
  password.focus();
}

/** Like the setup: a new random address on a chatmail relay, or the login of an existing address. */
function addRelayDialog(client: DcClient) {
  const relay = h('input', { type: 'text', spellcheck: 'false', placeholder: DEFAULT_RELAY });
  const existing = h('input', { type: 'checkbox' });
  const addr = h('input', { type: 'text', inputmode: 'email', spellcheck: 'false', placeholder: 'you@example.org', autocomplete: 'off' });
  const password = h('input', { type: 'password', autocomplete: 'new-password' });
  const relayField = field(t('setup.relay'), relay, t('setup.relayHint'));
  const existingFields = h('div', { class: 'existing', hidden: true }, field(t('setup.email'), addr), field(t('setup.password'), password));
  existing.addEventListener('change', () => {
    existingFields.hidden = !existing.checked;
    relayField.hidden = existing.checked;
  });
  dialog(t('relays.add'), h('div', {}, h('p', {}, t('relays.addText')), relayField,
    h('div', { class: 'remember' }, h('label', { class: 'check' }, existing, t('relays.existing'))), existingFields), [
    { label: t('cancel') },
    {
      label: t('relays.add'), primary: true, onClick: () => existing.checked
        ? client.addRelay(addr.value, password.value)
        : client.addRelay(`${randomAlnum(9)}@${relay.value.trim().toLowerCase() || DEFAULT_RELAY}`, randomAlnum(22)),
    },
  ]);
  relay.focus();
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
    .filter(c => c.publicKey && !c.blocked && !c.hidden)
    .map(c => ({ fp: c.fingerprint, box: h('input', { type: 'checkbox' }), label: client.contactName(c.fingerprint) }));
  const list = h('div', { class: 'members' }, ...boxes.map(b => h('label', { class: 'check' }, b.box, b.label)));
  if (!boxes.length) list.append(h('p', {}, t('group.addContactsFirst')));
  let image: string | undefined;
  const picker = avatarPicker(() => avatar(name.value || t('group.default'), 'new-group', undefined, image), () => image, async v => { image = v; });
  dialog(t('group.title'), h('div', { class: 'new-group' }, picker, field(t('group.name'), name), list), [
    { label: t('cancel') },
    {
      label: t('create'), primary: true, onClick: async () => {
        if (!name.value.trim()) throw new Error(t('group.enterName'));
        open(await client.createGroup(name.value, boxes.filter(b => b.box.checked).map(b => b.fp), image));
      },
    },
  ]);
  name.focus();
}

/** Like Delta Chat's "New chat" screen: new contact and new group, then the contacts. */
/** A row clicks, checks a box that the caller keeps across refreshes, or, with neither, only shows; `extra` follows it, e.g. a remove button. */
type ListRow = { name: string; sub?: string; badge: Element; onclick?: (ev: Event) => void; check?: HTMLInputElement; extra?: Element | null; attrs?: Record<string, string> };

/** A search field over a list of contacts or chats, filtering by name and address; `lead` rows show only without a query. */
function searchList(o: { label: string; rows: () => ListRow[]; lead?: () => ListRow[]; empty: () => string; class?: string }) {
  const search = h('input', { type: 'search', placeholder: o.label, 'aria-label': o.label });
  const list = h('ul', { class: `chatlist contacts ${o.class ?? ''}`.trim() });
  const item = (r: ListRow) => {
    const content = [r.check ?? null, r.badge, h('div', { class: 'item' }, h('strong', {}, r.name), r.sub ? h('small', {}, r.sub) : null)];
    const main = r.check ? h('label', {}, ...content)
      : r.onclick ? h('button', { type: 'button', onclick: r.onclick }, ...content)
      : h('div', {}, ...content);
    return h('li', r.attrs ?? {}, main, r.extra ?? null);
  };
  function refresh() {
    const q = search.value.trim().toLowerCase();
    const rows = o.rows().filter(r => !q || r.name.toLowerCase().includes(q) || !!r.sub?.toLowerCase().includes(q));
    list.replaceChildren(...(q ? [] : o.lead?.() ?? []).map(item), ...rows.map(item));
    if (!rows.length) list.append(h('li', { class: 'empty' }, q ? t('contacts.noMatch') : o.empty()));
  }
  search.addEventListener('input', refresh);
  refresh();
  return { search: h('div', { class: 'search' }, search), input: search, list, refresh };
}

function newChatView(client: DcClient, open: (id: string) => void, profile: (fp: string) => void, close: () => void) {
  const action = (d: string, name: string, onclick: () => void): ListRow => {
    const badge = avatar('', 'action', icon(d));
    badge.classList.add('action');
    badge.style.background = '';
    return { name, badge, onclick };
  };
  const start = (fp: string) => {
    const existing = client.chats.get(`c-${fp}`);
    if (existing) return open(existing.id);
    dialog(client.contactName(fp), h('p', {}, t('contacts.chatWith', { name: client.contactName(fp) })), [
      { label: t('cancel') },
      { label: t('ok'), primary: true, onClick: async () => open(await client.chatWith(fp)) },
    ]);
  };
  const { search, list, refresh } = searchList({
    label: t('contacts.search'),
    lead: () => [
      action(ICONS.addContact, t('nav.addContact'), () => joinDialog(client, open)),
      action(ICONS.group, t('nav.newGroup'), () => groupDialog(client, open))],
    rows: () => client.knownContacts().map(c => ({
      name: client.contactName(c.fingerprint), sub: c.addr, attrs: { 'data-contact': c.fingerprint },
      badge: avatar(client.contactName(c.fingerprint), c.addr, undefined, c.avatar), onclick: () => start(c.fingerprint),
      extra: Object.assign(iconButton(ICONS.info, t('contact.viewProfile'), () => profile(c.fingerprint)), { className: 'icon-button' }),
    })),
    empty: () => t('contacts.empty'),
  });
  const confirmDelete = (fp: string) => dialog(client.contactName(fp), h('p', {}, t('contact.deleteAsk')), [
    { label: t('cancel') },
    { label: t('contact.delete'), primary: true, onClick: () => client.deleteContact(fp) },
  ]);
  listenForItemMenu(list, 'li[data-contact]', (li, at) => {
    const fp = li.dataset.contact!;
    showMenu(li, at,
      [t('contact.viewProfile'), ICONS.info, () => profile(fp)],
      [t('contact.delete'), ICONS.trash, () => confirmDelete(fp)]);
  });
  const el = h('div', { class: 'settings new-chat' },
    h('header', { class: 'chathead' },
      h('button', { class: 'back', onclick: close }, '‹'),
      h('h2', { class: 'who' }, t('nav.newChat')),
      Object.assign(iconButton(ICONS.close, t('close'), close), { className: 'icon-button close' })),
    search,
    list);
  return { el, refresh };
}

function linkified(text: string, onAddress?: (addr: string, ev: Event) => void): (string | Node)[] {
  return splitLinks(text).map(({ text, href, addr, suspicious }) => !href ? text : addr ? h('a', {
    class: 'link', href, onclick: onAddress && (ev => onAddress(addr, ev)),
  }, text) : h('a', {
    class: 'link', href, target: '_blank', rel: 'noopener noreferrer',
    onclick: suspicious ? ev => { ev.preventDefault(); confirmLink(href); } : undefined,
  }, text));
}

const mediaFiles = new WeakMap<Element, { blob: Blob; name: string }>();

/** Shows the image or video of `opener` large, with the other images and videos of the chat a step away. */
function lightbox(opener: HTMLElement) {
  const items = [...(opener.closest('.messages') ?? document).querySelectorAll<HTMLElement>('.attachment .image > :is(img, video)')];
  let index = Math.max(0, items.findIndex(el => opener.contains(el)));
  // An own URL, because a redrawn message revokes those of its old node.
  let url = '';
  const img = h('img', { alt: '' });
  const video = h('video', { controls: true, playsinline: true });
  const name = h('span', { class: 'name' });
  const save = h('a', { class: 'icon-button', title: t('image.download'), 'aria-label': t('image.download') }, icon(ICONS.download));
  const step = (d: number) => items.length > 1 && show(index + d);
  const prev = iconButton(ICONS.back, t('image.previous'), () => step(-1));
  const next = iconButton(ICONS.forward, t('image.next'), () => step(1));
  const close = iconButton(ICONS.close, t('close'), () => dlg.close());
  const dlg = h('dialog', { class: 'lightbox', 'aria-label': t('image.title') },
    h('div', { class: 'bar' }, name, save, close), prev, img, video, next);
  for (const b of [prev, next, close]) b.classList.add('icon-button');
  prev.classList.add('prev');
  next.classList.add('next');
  prev.hidden = next.hidden = items.length < 2;
  function show(i: number) {
    index = (i + items.length) % items.length;
    const file = mediaFiles.get(items[index]);
    if (!file) return;
    const isVideo = items[index] instanceof HTMLVideoElement;
    video.pause();
    URL.revokeObjectURL(url);
    url = URL.createObjectURL(file.blob);
    img.hidden = isVideo;
    video.hidden = !isVideo;
    if (isVideo) {
      video.src = url;
      img.removeAttribute('src');
      video.play().catch(() => undefined);
    } else {
      img.src = url;
      video.removeAttribute('src');
      video.load();
    }
    save.href = url;
    img.alt = name.textContent = save.download = file.name;
  }
  dlg.addEventListener('click', ev => { if (ev.target === dlg) dlg.close(); });
  dlg.addEventListener('keydown', ev => {
    if (ev.target === video) return;
    if (ev.key === 'ArrowLeft') step(-1);
    else if (ev.key === 'ArrowRight') step(1);
  });
  dlg.addEventListener('close', () => { video.pause(); URL.revokeObjectURL(url); dlg.remove(); opener.focus(); });
  document.body.append(dlg);
  dlg.showModal();
  close.focus();
  show(index);
}

/** Shows where a link that can imitate another address really leads, like Delta Chat Desktop. */
function confirmLink(href: string) {
  dialog(t('link.title'), h('div', {},
    h('p', {}, t('link.suspicious', { host: new URL(href).hostname })),
    h('code', { class: 'link-target' }, href)), [
    { label: t('cancel') },
    { label: t('link.open'), primary: true, onClick: () => { window.open(href, '_blank', 'noopener,noreferrer'); } },
  ]);
}

function formatFingerprint(fp: string): string {
  return (fp.match(/.{1,4}/g) ?? []).join(' ');
}

function fingerprintRows(client: DcClient, fp: string) {
  const row = (name: string, fp: string) => [h('strong', {}, name), h('code', {}, formatFingerprint(fp))];
  return h('div', { class: 'fingerprints' }, ...row(client.config.displayName || t('me'), client.config.fingerprint), ...row(client.contactName(fp), fp));
}

function deleteChatSection(client: DcClient, chat: Chat, consequence: string, deleted: () => void): Element {
  const confirm = () => dialog(t('chat.deleteTitle'), h('p', {}, t('chat.deleteUndo')), [
    { label: t('cancel') },
    { label: t('delete'), primary: true, onClick: async () => { await client.deleteChat(chat.id); deleted(); } },
  ]);
  return h('section', {}, h('h3', {}, t('chat.deleteChat')),
    h('p', {}, [t(client.config.bccSelf ? 'chat.deleteEverywhere' : 'chat.deleteHere'), consequence].filter(Boolean).join(' ')),
    h('div', { class: 'row' }, h('button', { class: 'danger', onclick: confirm }, t('chat.deleteChat'))));
}

/** Like Delta Chat's "Clear chat": deletes the messages for this profile and keeps the chat. */
function clearChatSection(client: DcClient, chat: Chat): Element {
  const confirm = () => dialog(t('chat.clearTitle'), h('p', {}, t('chat.deleteUndo')), [
    { label: t('cancel') },
    { label: t('chat.clear'), primary: true, onClick: () => client.clearChat(chat.id) },
  ]);
  return h('section', {}, h('h3', {}, t('chat.clear')),
    h('p', {}, [t(client.config.bccSelf ? 'chat.clearEverywhere' : 'chat.clearHere'), chat.type === 'self' ? '' : t('chat.clearOthersKeep')].filter(Boolean).join(' ')),
    h('div', { class: 'row' }, h('button', { onclick: confirm }, t('chat.clear'))));
}

/** Like Delta Chat's contact profile, in place of a chat. */
function contactView(client: DcClient, fp: string, open: (id: string) => void, close: () => void): Element | undefined {
  const c = client.contacts.get(fp);
  if (!c) return undefined;
  const name = client.contactName(fp);
  const chat = client.chats.get(`c-${fp}`);
  const nickname = h('input', { type: 'text', maxlength: '100', value: c.nickname ?? '', placeholder: c.name || c.addr });
  nickname.addEventListener('change', () => { void client.setNickname(fp, nickname.value).catch(errorDialog); });
  const title = h('h2', { class: 'who' }, name);
  const shownName = h('strong', {}, name);
  nickname.addEventListener('input', () => { title.textContent = shownName.textContent = nickname.value.trim() || c.name || c.addr; });
  const shared = client.sortedChats().filter(g => g.type === 'group' && !g.left && g.members.includes(fp));
  const blockText = (key: 'contact.blockAsk' | 'contact.unblockAsk') => h('div', {}, ...t(key).split('\n\n').map(p => h('p', {}, p)));
  const confirmBlock = () => dialog(name, blockText(c.blocked ? 'contact.unblockAsk' : 'contact.blockAsk'), [
    { label: t('cancel') },
    { label: t(c.blocked ? 'contact.unblock' : 'contact.block'), primary: true, onClick: () => client.setBlocked(fp, !c.blocked) },
  ]);
  const confirmDelete = () => dialog(name, h('p', {}, t('contact.deleteAsk')), [
    { label: t('cancel') },
    { label: t('contact.delete'), primary: true, onClick: async () => { await client.deleteContact(fp); close(); } },
  ]);
  const section = (title: string, ...content: (Node | null)[]) => h('section', {}, h('h3', {}, title), ...content);
  const relays = [...new Set([c.addr, ...c.relays])];
  // The nickname is saved on blur, i.e. by this click; close only once it is stored.
  const closeSaved = busyClick(async () => { await client.saved(); close(); });
  return h('div', { class: 'settings contact' },
    h('header', { class: 'chathead' },
      h('button', { class: 'back', onclick: closeSaved }, '‹'),
      title,
      Object.assign(iconButton(ICONS.close, t('close'), closeSaved), { className: 'icon-button close' })),
    h('div', { class: 'settings-body' },
      h('section', {},
        h('div', { class: 'profile-head' }, avatar(name, c.addr, undefined, c.avatar),
          h('span', { class: 'names' }, shownName,
            c.lastSeen ? h('small', {}, t('chat.lastSeen', { when: formatAgo(c.lastSeen) })) : null)),
        h('div', { class: 'row' },
          c.blocked ? null : h('button', { class: 'primary', onclick: busyClick(async () => open(await client.chatWith(fp))) }, t('contact.sendMessage')),
          c.publicKey ? h('button', { onclick: () => shareContactDialog(client, fp, open) }, t('contact.share')) : null)),
      h('section', {}, field(t('group.name'), nickname, t('contact.nicknameHint', { name: c.name || c.addr }))),
      section(t('contact.sharedChats'),
        shared.length
          ? h('ul', { class: 'member-list' }, ...shared.map(g => h('li', {}, h('button', { type: 'button', class: 'link', onclick: () => open(g.id) }, client.chatTitle(g)))))
          : h('p', {}, t('contact.noSharedChats'))),
      section(t('e2e.title'), h('p', {}, t(c.verified ? 'e2e.invite' : 'e2e.compare')), fingerprintRows(client, fp),
        h('h4', {}, t(relays.length > 1 ? 'contact.relays' : 'contact.relay')),
        h('ul', { class: 'relays' }, ...relays.map(r => h('li', {}, r)))),
      section(t(c.blocked ? 'contact.unblock' : 'contact.block'),
        h('p', {}, t(c.blocked ? 'contact.blockedText' : 'contact.blockText')),
        h('div', { class: 'row' }, h('button', { class: c.blocked ? '' : 'danger', onclick: confirmBlock }, t(c.blocked ? 'contact.unblock' : 'contact.block')))),
      chat ? clearChatSection(client, chat) : null,
      chat ? deleteChatSection(client, chat, t('chat.deleteKeepContact', { name }), close) : null,
      c.hidden ? null : section(t('contact.delete'), h('p', {}, t('contact.deleteText')),
        h('div', { class: 'row' }, h('button', { class: 'danger', onclick: confirmDelete }, t('contact.delete'))))));
}

/** Sends the contact to a chat, or to a contact without one yet, like Delta Chat's "Share contact". */
function shareContactDialog(client: DcClient, fp: string, open: (id: string) => void) {
  const send = (target: () => Promise<string>) => busyClick(async () => {
    const chatId = await target();
    await client.shareContact(chatId, fp);
    dlg.close();
    open(chatId);
  });
  const { search, input, list } = searchList({
    label: t('chat.search'), class: 'pick',
    rows: () => [
      ...client.sortedChats().filter(c => !c.left && !c.isRequest && c.contact !== fp).map(chat => ({
        name: client.chatTitle(chat), sub: chat.type === 'single' ? client.contacts.get(chat.contact ?? '')?.addr : undefined,
        badge: chatAvatar(client, chat), onclick: send(async () => chat.id),
      })),
      ...client.knownContacts().filter(c => c.fingerprint !== fp && !client.chats.has(`c-${c.fingerprint}`)).map(c => ({
        name: client.contactName(c.fingerprint), sub: c.addr,
        badge: avatar(client.contactName(c.fingerprint), c.addr, undefined, c.avatar), onclick: send(() => client.chatWith(c.fingerprint)),
      })),
    ],
    empty: () => t('contact.shareEmpty'),
  });
  const dlg = dialog(t('contact.shareTitle', { name: client.contactName(fp) }), h('div', { class: 'share' }, search, list), [{ label: t('cancel') }]);
  input.focus();
}

/** Like Delta Chat's "Blocked contacts" in the chat settings. */
function blockedDialog(client: DcClient) {
  const list = h('ul', { class: 'member-list' });
  const render = () => {
    const blocked = client.blockedContacts();
    list.replaceChildren(...blocked.map(c => h('li', {},
      h('span', {}, h('strong', {}, client.contactName(c.fingerprint)), h('small', {}, c.addr)),
      h('button', {
        type: 'button', onclick: () => dialog(client.contactName(c.fingerprint), h('p', {}, t('contact.unblockAsk')), [
          { label: t('cancel') },
          { label: t('contact.unblock'), primary: true, onClick: async () => { await client.setBlocked(c.fingerprint, false); render(); } },
        ]),
      }, t('contact.unblock')))));
    if (!blocked.length) list.append(h('li', {}, t('contact.blockedEmpty')));
  };
  render();
  dialog(t('contact.blockedTitle'), list, [{ label: t('close'), primary: true }]);
}

/** Like Delta Chat's group profile, in place of the chat; Saved messages use it too. */
function groupView(client: DcClient, chat: Chat, profile: (fp: string) => void, close: () => void, deleted: () => void) {
  const active = chat.type === 'group' && !chat.left;
  const image = () => client.chats.get(chat.id)?.avatar;
  const confirmLeave = () => dialog(t('group.leaveTitle'), h('p', {}, t('group.leaveText')), [
    { label: t('cancel') },
    { label: t('group.leave'), primary: true, onClick: () => client.leaveGroup(chat.id) },
  ]);
  const heading = h('h3', {});
  const removeButton = (fp: string, name: string) => {
    const b = iconButton(ICONS.close, t('group.remove', { name }), () => dialog(t('group.removeTitle'), h('p', {}, t('group.removeText', { name })), [
      { label: t('cancel') },
      { label: t('group.removeConfirm'), primary: true, onClick: () => client.removeMember(chat.id, fp) },
    ]));
    b.classList.add('icon-button');
    return b;
  };
  const members = searchList({
    label: t('group.searchMembers'), class: 'members-pick',
    rows: () => {
      const fps = client.chats.get(chat.id)?.members ?? [];
      heading.textContent = t('chat.members', { n: fps.length + 1 });
      const me = client.config.displayName || t('me');
      return [
        { name: me, sub: client.config.addr, badge: avatar(me, client.config.addr, undefined, client.config.avatar) },
        ...fps.map(fp => {
          const c = client.contacts.get(fp);
          const name = client.contactName(fp);
          return { name, sub: c?.addr, badge: avatar(name, c?.addr ?? fp, undefined, c?.avatar), onclick: () => profile(fp), extra: removeButton(fp, name) };
        }),
      ];
    },
    empty: () => '',
  });
  const section = (title: string, ...content: (Node | null)[]) => h('section', {}, h('h3', {}, title), ...content);
  const el = h('div', { class: 'settings chat-info' },
    h('header', { class: 'chathead' },
      h('button', { class: 'back', onclick: close }, '‹'),
      h('h2', { class: 'who' }, client.chatTitle(chat)),
      Object.assign(iconButton(ICONS.close, t('close'), close), { className: 'icon-button close' })),
    h('div', { class: 'settings-body' },
      active ? section(t('group.avatar'),
        avatarPicker(() => avatar(client.chatTitle(chat), chatAvatarKey(client, chat), undefined, image()), image, v => client.setGroupAvatar(chat.id, v))) : null,
      active ? h('section', {}, heading, members.search, members.list,
        h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => addMembersDialog(client, chat) }, t('group.add')))) : null,
      section(t('e2e.title'), h('p', {}, t(chat.type === 'self' ? 'e2e.self' : 'e2e.group'))),
      active ? section(t('group.leave'),
        h('p', {}, t('group.leaveText')),
        h('div', { class: 'row' }, h('button', { class: 'danger', onclick: confirmLeave }, t('group.leave')))) : null,
      clearChatSection(client, chat),
      chat.type === 'self' ? null : deleteChatSection(client, chat, active ? t('chat.deleteKeepGroup') : '', deleted)));
  return { el, refresh: members.refresh };
}

function addMembersDialog(client: DcClient, chat: Chat) {
  const candidates = client.knownContacts().filter(c => !chat.members.includes(c.fingerprint))
    .map(c => ({ c, box: h('input', { type: 'checkbox' }) }));
  const { search, input, list } = searchList({
    label: t('contacts.search'), class: 'pick',
    rows: () => candidates.map(({ c, box }) => ({
      name: client.contactName(c.fingerprint), sub: c.addr, check: box,
      badge: avatar(client.contactName(c.fingerprint), c.addr, undefined, c.avatar),
    })),
    empty: () => t('group.noMoreContacts'),
  });
  dialog(t('group.add'), h('div', { class: 'share' }, candidates.length ? search : null, list), [
    { label: t('cancel') },
    ...candidates.length ? [{
      label: t('group.addConfirm'), primary: true, onClick: async () => {
        for (const { c } of candidates.filter(x => x.box.checked)) await client.addMember(chat.id, c.fingerprint);
      },
    }] : [],
  ]);
  input.focus();
}

function exportDialog(client: DcClient, done?: () => void) {
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
        await client.markSecured();
        done?.();
      },
    },
  ]);
}

/** Like core's recode_to_avatar_size(): a square of at most 512 px and 60 KB. */
async function avatarFromFile(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error(t('profile.avatarInvalid')); });
  const side = Math.min(bitmap.width, bitmap.height);
  for (const size of [512, 384, 256]) {
    const px = Math.min(size, side);
    const canvas = h('canvas', { width: String(px), height: String(px) });
    canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, px, px);
    for (const quality of [0.85, 0.7, 0.55]) {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= 60_000) return `data:image/jpeg;base64,${await blobToBase64(blob)}`;
    }
  }
  throw new Error(t('profile.avatarInvalid'));
}

function avatarPicker(preview: () => Element, current: () => string | undefined, set: (dataUrl: string | undefined) => Promise<unknown>): Element {
  const picture = h('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-label': t('profile.avatarChoose') });
  const row = h('div', { class: 'avatar-row' });
  const render = () => row.replaceChildren(preview(),
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: () => picture.click() }, t('profile.avatarChoose')),
      current() ? h('button', { type: 'button', onclick: busyClick(async () => { await set(undefined); render(); }) }, t('profile.avatarRemove')) : null),
    picture);
  picture.addEventListener('change', () => {
    const file = picture.files?.[0];
    picture.value = '';
    if (file) void avatarFromFile(file).then(set).then(render).catch(errorDialog);
  });
  render();
  return row;
}

/** `rebuild` redraws the main view after the language changed. */
/** The profile and the settings of this browser, saved as soon as they change. */
function settingsView(client: DcClient, rebuild: () => void, close: () => void): Element {
  const save = (f: () => unknown) => () => { void Promise.resolve().then(f).catch(errorDialog); };
  const name = h('input', { type: 'text', maxlength: '100', value: client.config.displayName });
  name.addEventListener('change', save(() => client.setDisplayName(name.value)));
  const avatarRow = avatarPicker(() => avatar(client.config.displayName || t('me'), client.config.addr, undefined, client.config.avatar),
    () => client.config.avatar, v => client.setAvatar(v));

  const lang = languageSelect(rebuild);
  const theme = h('select', {},
    ...THEMES.map(v => h('option', { value: v, selected: getTheme() === v }, t(`theme.${v}`))));
  theme.addEventListener('change', () => setTheme(theme.value as Theme));
  const example = new Date();
  const dateFormat = h('select', {},
    ...DATE_LOCALES.map(l => h('option', { value: l, selected: getDateLocale() === l },
      `${t(`date.${l}`)} – ${example.toLocaleString(dateLocale(l), { dateStyle: 'short', timeStyle: 'short' })}`)));
  dateFormat.addEventListener('change', () => { setDateLocale(dateFormat.value as DateLocale); rebuild(); });

  const receipts = h('input', { type: 'checkbox', checked: client.readReceipts });
  receipts.addEventListener('change', save(() => client.setReadReceipts(receipts.checked)));
  const notifyDetails = h('select', {},
    ...(['all', 'sender', 'none'] as const).map(v => h('option', { value: v, selected: client.notifyDetails === v },
      t(v === 'all' ? 'profile.notifyAll' : v === 'sender' ? 'profile.notifySender' : 'profile.notifyNone'))));
  notifyDetails.addEventListener('change', save(() => client.setNotifyDetails(notifyDetails.value as 'all' | 'sender' | 'none')));
  const permission = h('div', { class: 'notify-permission' });
  const renderPermission = () => {
    const state = notificationState();
    permission.replaceChildren(
      state === 'default' ? h('button', { onclick: busyClick(() => askNotifications().then(renderPermission)) }, t('notify.enable'))
        : state === 'unsupported' ? '' : h('small', { class: 'hint' }, t(state === 'denied' ? 'notify.denied' : 'notify.granted')));
  };
  renderPermission();

  const remember = rememberField();
  void client.isRemembered().then(on => { remember.box.checked = on; });
  remember.box.addEventListener('change', save(() => client.setRemembered(remember.box.checked)));

  const section = (title: string, ...content: (Node | null)[]) => h('section', {}, h('h3', {}, title), ...content);
  const check = (box: HTMLInputElement, label: string, hint: string) =>
    h('div', { class: 'remember' }, h('label', { class: 'check' }, box, label), h('small', { class: 'hint' }, hint));
  return h('div', { class: 'settings' },
    h('header', { class: 'chathead' },
      h('button', { class: 'back', onclick: close }, '‹'),
      h('h2', { class: 'who' }, t('settings.title')),
      Object.assign(iconButton(ICONS.close, t('close'), close), { className: 'icon-button close' })),
    h('div', { class: 'settings-body' },
      section(t('settings.profile'),
        h('div', { class: 'field' }, h('span', {}, t('profile.avatar')), avatarRow, h('small', { class: 'hint' }, t('profile.avatarHint'))),
        field(t('setup.displayName'), name),
        h('div', { class: 'profile-info' },
          h('small', {}, t('profile.address', { addr: client.config.addr })),
          h('small', {}, t('profile.fingerprint', { fp: formatFingerprint(client.config.fingerprint) })))),
      section(t('settings.relays'),
        h('p', {}, t('relays.hint')),
        h('ul', { class: 'relays' }, ...client.selfAddrs().map(a => h('li', {}, h('span', {}, a),
          Object.assign(iconButton(ICONS.edit, t('relays.edit'), () => editRelayDialog(client, a)), { className: 'icon-button' }),
          client.selfAddrs().length > 1 ? Object.assign(iconButton(ICONS.trash, t('relays.remove'), () => dialog(t('relays.removeAsk', { addr: a }), h('p', {}, t('relays.removeText')), [
            { label: t('cancel') },
            { label: t('relays.remove'), primary: true, onClick: () => client.removeRelay(a) },
          ])), { className: 'icon-button' }) : null))),
        client.selfAddrs().length < MAX_RELAYS ? h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => addRelayDialog(client) }, t('relays.add'))) : null),
      section(t('settings.appearance'),
        field(t('language'), lang),
        field(t('settings.theme'), theme),
        field(t('profile.dateFormat'), dateFormat)),
      section(t('settings.chats'),
        check(receipts, t('profile.readReceipts'), t('profile.readReceiptsHint')),
        field(t('profile.notify'), notifyDetails, t('profile.notifyHint')),
        permission,
        h('div', { class: 'row' }, h('button', { onclick: () => blockedDialog(client) }, t('contact.blockedTitle')))),
      section(t('settings.devices'),
        client.config.secured ? null : h('p', { class: 'warning' }, t('backup.unsecured')),
        h('div', { class: 'row' },
          canHandoff ? h('button', { onclick: () => phoneDialog(client) }, t('profile.phone')) : null,
          h('button', { onclick: () => exportDialog(client) }, t('profile.export')))),
      section(t('settings.browser'),
        remember.el,
        h('div', { class: 'row' },
          h('button', { onclick: busyClick(async () => { await client.setRemembered(false); location.reload(); }) }, t('profile.lock'))))));
}
