// Same choice as the landing page and the web app: ?lang=, then the shared cookie, then Accept-Language.

const COOKIE = 'kitepost_lang';

const en = {
  langName: 'English',
  invalidTitle: 'Invite not valid',
  invalidHeading: 'This invite is no longer valid',
  invalidText: 'It may have been used already or expired. Ask the person who sent it for a new one.',
  inviteTitle: 'Invitation to {site}',
  inviteHeading: "You're invited to {site}",
  inviteText: 'Accept to get a new chat address on <strong>{domain}</strong>. Use it with the Delta Chat app on your phone or computer, or right here in the browser.',
  inviteButton: 'Create my account',
  inviteOnce: 'The link works only once. Nothing is created until you press the button.',
  readyTitle: 'Your account is ready',
  readyAddress: 'Your address: <strong>{addr}</strong>',
  readyAppHeading: 'Delta Chat app',
  readyAppText: 'Install <a href="https://delta.chat/download" rel="noopener noreferrer">Delta Chat</a>. Then scan this code under <em>Add as second device</em> → <em>Scan QR code</em> (or "Log into your server" on the welcome screen), or tap the button on this device.',
  readyQrAlt: 'Login QR code',
  readyAppButton: 'Open in Delta Chat',
  readyWebHeading: 'In the browser',
  readyWebText: 'Use the web client without installing anything.',
  readyWebButton: 'Open the web client',
  readyWarn: "Save this now: the page cannot be shown again. The QR code contains your password, so don't share it.",
  errorTitle: 'Error',
  errorHeading: 'Something went wrong',
  errorText: 'Please try again later.',
  notFound: 'Not found',
  adminTitle: 'Invites',
};

const de = {
  langName: 'Deutsch',
  invalidTitle: 'Einladung ungültig',
  invalidHeading: 'Diese Einladung ist nicht mehr gültig',
  invalidText: 'Vielleicht wurde sie schon benutzt oder ist abgelaufen. Bitte die Person, die sie dir geschickt hat, um eine neue.',
  inviteTitle: 'Einladung zu {site}',
  inviteHeading: 'Du bist zu {site} eingeladen',
  inviteText: 'Nimm die Einladung an, um eine neue Chat-Adresse auf <strong>{domain}</strong> zu bekommen. Du kannst sie mit der Delta-Chat-App auf Handy oder Computer nutzen oder direkt hier im Browser.',
  inviteButton: 'Mein Konto erstellen',
  inviteOnce: 'Der Link funktioniert nur einmal. Es wird erst etwas angelegt, wenn du auf den Knopf drückst.',
  readyTitle: 'Dein Konto ist fertig',
  readyAddress: 'Deine Adresse: <strong>{addr}</strong>',
  readyAppHeading: 'Delta-Chat-App',
  readyAppText: 'Installiere <a href="https://delta.chat/download" rel="noopener noreferrer">Delta Chat</a>. Scanne dann diesen Code unter <em>Als Zweitgerät hinzufügen</em> → <em>QR-Code scannen</em> (oder „Auf deinem Server anmelden“ auf dem Startbildschirm), oder tippe auf diesem Gerät auf den Knopf.',
  readyQrAlt: 'QR-Code zum Anmelden',
  readyAppButton: 'In Delta Chat öffnen',
  readyWebHeading: 'Im Browser',
  readyWebText: 'Nutze den Web-Client, ohne etwas zu installieren.',
  readyWebButton: 'Web-Client öffnen',
  readyWarn: 'Speichere das jetzt: Die Seite lässt sich nicht noch einmal anzeigen. Der QR-Code enthält dein Passwort, teile ihn also nicht.',
  errorTitle: 'Fehler',
  errorHeading: 'Da ist etwas schiefgegangen',
  errorText: 'Bitte versuche es später noch einmal.',
  notFound: 'Nicht gefunden',
  adminTitle: 'Einladungen',
};

export const LANGUAGES = { en, de };

/** Returns the language for a request and, if it was chosen via ?lang=, the cookie to store it. */
export function requestLanguage(req, url) {
  const arg = url.searchParams.get('lang');
  if (Object.hasOwn(LANGUAGES, arg ?? '')) {
    return { lang: arg, setCookie: `${COOKIE}=${arg}; Path=/; Max-Age=31536000; SameSite=Lax` };
  }
  const cookie = new RegExp(`(?:^|;\\s*)${COOKIE}=(\\w+)`).exec(req.headers.cookie ?? '')?.[1];
  if (Object.hasOwn(LANGUAGES, cookie ?? '')) return { lang: cookie };
  for (const part of (req.headers['accept-language'] ?? '').split(',')) {
    const base = part.trim().split(/[-;]/)[0].toLowerCase();
    if (Object.hasOwn(LANGUAGES, base)) return { lang: base };
  }
  return { lang: 'en' };
}

/** Translator for `lang`; values in `params` must already be HTML-escaped. */
export function translator(lang) {
  const messages = LANGUAGES[lang] ?? en;
  return (key, params = {}) => messages[key].replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}
