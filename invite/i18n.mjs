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
  readyInstallHeading: 'Install Delta Chat on your phone',
  readyInstallText: "Scan this code with your phone's camera to open the download page.",
  readyInstallQrAlt: 'QR code for the download page',
  readyInstallButton: 'Download page',
  readyAppHeading: 'Log in on your phone',
  readyAppText: 'Open Delta Chat, tap <em>I already have a profile</em> → <em>Add as second device</em> and scan this code. If you are reading this on your phone, tap the button instead.',
  readyQrAlt: 'Login QR code',
  readyAppButton: 'Open in Delta Chat',
  readyWebHeading: 'Also use it in the browser',
  readyWebText: 'Once Delta Chat runs on your phone, export a backup there under <em>Settings</em> → <em>Chats and media</em> → <em>Export backup</em> and import it in the web client. Phone and browser then share the same keys and chats.',
  readyWebButton: 'Open the web client',
  readyWebOnlyHeading: 'No smartphone?',
  readyWebOnlyText: 'You can use the account in the browser only. If you add the Delta Chat app later, move it there with a backup from the web client instead of scanning the login code, otherwise the two devices end up with different keys.',
  readyWebOnlyButton: 'Use only the web client',
  installTitle: 'Install Delta Chat',
  installText: 'Delta Chat is a free, open-source messenger. Install it from your app store:',
  installApk: 'Without an app store, get the APK from <a href="{url}" rel="noopener noreferrer">get.delta.chat</a>.',
  installOtherHeading: 'iPhone, Windows, macOS, Linux',
  installOther: 'All other versions are on <a href="{url}" rel="noopener noreferrer">get.delta.chat</a>.',
  installNext: 'After installing, scan the login QR code shown on your computer.',
  readyWarn: "Save this now: the page cannot be shown again. The login code contains your password, so don't share it.",
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
  readyInstallHeading: 'Delta Chat auf dem Handy installieren',
  readyInstallText: 'Scanne diesen Code mit der Kamera deines Handys, um die Download-Seite zu öffnen.',
  readyInstallQrAlt: 'QR-Code für die Download-Seite',
  readyInstallButton: 'Download-Seite',
  readyAppHeading: 'Auf dem Handy anmelden',
  readyAppText: 'Öffne Delta Chat, tippe auf <em>Ich habe bereits ein Profil</em> → <em>Als Zweitgerät hinzufügen</em> und scanne diesen Code. Liest du das gerade auf dem Handy, tippe stattdessen auf den Knopf.',
  readyQrAlt: 'QR-Code zum Anmelden',
  readyAppButton: 'In Delta Chat öffnen',
  readyWebHeading: 'Auch im Browser nutzen',
  readyWebText: 'Sobald Delta Chat auf dem Handy läuft, exportiere dort ein Backup unter <em>Einstellungen</em> → <em>Chats und Medien</em> → <em>Backup exportieren</em> und importiere es im Web-Client. Handy und Browser haben dann dieselben Schlüssel und Chats.',
  readyWebButton: 'Web-Client öffnen',
  readyWebOnlyHeading: 'Kein Smartphone?',
  readyWebOnlyText: 'Du kannst das Konto auch nur im Browser nutzen. Kommt die Delta-Chat-App später dazu, übertrage es mit einem Backup aus dem Web-Client statt den Anmelde-Code zu scannen, sonst haben die beiden Geräte unterschiedliche Schlüssel.',
  readyWebOnlyButton: 'Nur den Web-Client nutzen',
  installTitle: 'Delta Chat installieren',
  installText: 'Delta Chat ist ein freier Open-Source-Messenger. Installiere ihn aus deinem App-Store:',
  installApk: 'Ohne App-Store gibt es die APK auf <a href="{url}" rel="noopener noreferrer">get.delta.chat</a>.',
  installOtherHeading: 'iPhone, Windows, macOS, Linux',
  installOther: 'Alle anderen Versionen findest du auf <a href="{url}" rel="noopener noreferrer">get.delta.chat</a>.',
  installNext: 'Scanne nach der Installation den Anmelde-QR-Code auf deinem Computer.',
  readyWarn: 'Speichere das jetzt: Die Seite lässt sich nicht noch einmal anzeigen. Der Anmelde-Code enthält dein Passwort, teile ihn also nicht.',
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
