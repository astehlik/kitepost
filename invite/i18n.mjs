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
  inviteButton: 'Create my address',
  inviteOnce: 'The link works only once. Nothing is created until you press the button.',
  readyTitle: 'Your address is ready',
  readyAddress: 'Your address: <strong>{addr}</strong>',
  readyWebText: 'Continue in the browser. Kitepost creates your keys there and then shows a code that sets up Delta Chat on your phone with the same profile.',
  readyWebButton: 'Continue in the browser',
  readyWarn: "Continue now: this page cannot be shown again, and the link contains your password, so don't share it.",
  readyPhoneOnlyHeading: 'Only use Delta Chat on the phone',
  readyInstallHeading: 'Install Delta Chat on your phone',
  readyInstallText: "Scan this code with your phone's camera to open the download page.",
  readyInstallQrAlt: 'QR code for the download page',
  readyInstallButton: 'Download page',
  readyAppHeading: 'Log in on your phone',
  readyAppText: 'Open Delta Chat, tap <em>I already have a profile</em> → <em>Add as second device</em> and scan this code. If you are reading this on your phone, tap the button instead. The code contains your password, so don\'t share it.',
  readyQrAlt: 'Login QR code',
  readyAppButton: 'Open in Delta Chat',
  readyPhoneOnlyLater: 'To use Kitepost later as well, export a backup in Delta Chat under <em>Settings</em> → <em>Chats and media</em> → <em>Export backup</em> and choose <em>Import backup file</em> in Kitepost. Logging in to Kitepost with this code instead would give it a different key.',
  handoffTitle: 'Your profile for Delta Chat',
  handoffText: 'Set up Delta Chat on this phone with <strong>{addr}</strong>. It gets the same keys and chats as Kitepost in the browser.',
  handoffInstallHeading: 'Install Delta Chat',
  handoffInstallOther: 'Skip this if it is already installed. Other platforms and the APK: <a href="{url}" rel="noopener noreferrer">get.delta.chat</a>.',
  handoffSaveHeading: 'Save your profile',
  handoffLoading: 'Decrypting…',
  handoffSave: 'Save profile file',
  handoffSaveHint: 'If nothing is saved, open this page in your regular browser instead of a QR scanner app.',
  handoffRestoreHeading: 'Restore it in Delta Chat',
  handoffRestoreText: 'Open Delta Chat, tap <em>I already have a profile</em> → <em>Restore from backup</em> and choose the saved file, usually in <em>Downloads</em>.',
  handoffWarn: 'The file contains your private key. Delete it once Delta Chat has restored it.',
  handoffGoneHeading: 'This code has expired',
  handoffGone: 'It can be used only once and only for 15 minutes. Show a new code in Kitepost under <em>Edit profile</em> → <em>Set up phone</em>.',
  handoffFailed: 'The profile could not be decrypted. Scan the code again or show a new one in Kitepost.',
  installTitle: 'Install Delta Chat',
  installText: 'Delta Chat is a free, open-source messenger. Install it from your app store:',
  installApk: 'Without an app store, get the APK from <a href="{url}" rel="noopener noreferrer">get.delta.chat</a>.',
  installOtherHeading: 'iPhone, Windows, macOS, Linux',
  installOther: 'All other versions are on <a href="{url}" rel="noopener noreferrer">get.delta.chat</a>.',
  installNext: 'After installing, scan the login QR code shown on your computer.',
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
  inviteButton: 'Meine Adresse erstellen',
  inviteOnce: 'Der Link funktioniert nur einmal. Es wird erst etwas angelegt, wenn du auf den Knopf drückst.',
  readyTitle: 'Deine Adresse ist fertig',
  readyAddress: 'Deine Adresse: <strong>{addr}</strong>',
  readyWebText: 'Mach im Browser weiter. Kitepost erzeugt dort deine Schlüssel und zeigt dann einen Code, mit dem du Delta Chat auf dem Handy mit demselben Profil einrichtest.',
  readyWebButton: 'Im Browser weitermachen',
  readyWarn: 'Mach jetzt weiter: Die Seite lässt sich nicht noch einmal anzeigen, und der Link enthält dein Passwort, teile ihn also nicht.',
  readyPhoneOnlyHeading: 'Delta Chat nur auf dem Handy nutzen',
  readyInstallHeading: 'Delta Chat auf dem Handy installieren',
  readyInstallText: 'Scanne diesen Code mit der Kamera deines Handys, um die Download-Seite zu öffnen.',
  readyInstallQrAlt: 'QR-Code für die Download-Seite',
  readyInstallButton: 'Download-Seite',
  readyAppHeading: 'Auf dem Handy anmelden',
  readyAppText: 'Öffne Delta Chat, tippe auf <em>Ich habe bereits ein Profil</em> → <em>Als Zweitgerät hinzufügen</em> und scanne diesen Code. Liest du das gerade auf dem Handy, tippe stattdessen auf den Knopf. Der Code enthält dein Passwort, teile ihn also nicht.',
  readyQrAlt: 'QR-Code zum Anmelden',
  readyAppButton: 'In Delta Chat öffnen',
  readyPhoneOnlyLater: 'Um später auch Kitepost zu nutzen, exportiere in Delta Chat unter <em>Einstellungen</em> → <em>Chats und Medien</em> → <em>Backup exportieren</em> ein Backup und wähle in Kitepost <em>Backup-Datei importieren</em>. Mit diesem Code bei Kitepost anzumelden, gäbe ihm einen anderen Schlüssel.',
  handoffTitle: 'Dein Profil für Delta Chat',
  handoffText: 'Richte Delta Chat auf diesem Handy mit <strong>{addr}</strong> ein. Es bekommt dieselben Schlüssel und Chats wie Kitepost im Browser.',
  handoffInstallHeading: 'Delta Chat installieren',
  handoffInstallOther: 'Überspringe das, wenn es schon installiert ist. Andere Plattformen und die APK: <a href="{url}" rel="noopener noreferrer">get.delta.chat</a>.',
  handoffSaveHeading: 'Profil speichern',
  handoffLoading: 'Wird entschlüsselt …',
  handoffSave: 'Profildatei speichern',
  handoffSaveHint: 'Wird nichts gespeichert, öffne diese Seite in deinem normalen Browser statt in einer QR-Scanner-App.',
  handoffRestoreHeading: 'In Delta Chat wiederherstellen',
  handoffRestoreText: 'Öffne Delta Chat, tippe auf <em>Ich habe bereits ein Profil</em> → <em>Aus Backup wiederherstellen</em> und wähle die gespeicherte Datei, meist unter <em>Downloads</em>.',
  handoffWarn: 'Die Datei enthält deinen privaten Schlüssel. Lösche sie, sobald Delta Chat sie wiederhergestellt hat.',
  handoffGoneHeading: 'Dieser Code ist abgelaufen',
  handoffGone: 'Er funktioniert nur einmal und nur 15 Minuten lang. Zeige in Kitepost unter <em>Profil bearbeiten</em> → <em>Handy einrichten</em> einen neuen Code an.',
  handoffFailed: 'Das Profil ließ sich nicht entschlüsseln. Scanne den Code noch einmal oder zeige in Kitepost einen neuen an.',
  installTitle: 'Delta Chat installieren',
  installText: 'Delta Chat ist ein freier Open-Source-Messenger. Installiere ihn aus deinem App-Store:',
  installApk: 'Ohne App-Store gibt es die APK auf <a href="{url}" rel="noopener noreferrer">get.delta.chat</a>.',
  installOtherHeading: 'iPhone, Windows, macOS, Linux',
  installOther: 'Alle anderen Versionen findest du auf <a href="{url}" rel="noopener noreferrer">get.delta.chat</a>.',
  installNext: 'Scanne nach der Installation den Anmelde-QR-Code auf deinem Computer.',
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
