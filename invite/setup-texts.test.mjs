import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { de } from '../web/src/i18n/de.ts';
import { en } from '../web/src/i18n/en.ts';
import { LANGUAGES } from './i18n.mjs';

// Markup and quotes differ by design: the invite page uses <em>, the web client and site „…“ / "…".
const plain = text => text.replace(/<\/?em>|[„“"…]/g, '');
const all = messages => Object.values(messages).map(plain).join('\n');
const path = (...steps) => steps.join(' → ');

const deltaChat = {
  en: {
    exportBackup: path('Settings', 'Chats and media', 'Export backup'),
    restoreBackup: path('I already have a profile', 'Restore from backup'),
  },
  de: {
    exportBackup: path('Einstellungen', 'Chats und Medien', 'Backup exportieren'),
    restoreBackup: path('Ich habe bereits ein Profil', 'Aus Backup wiederherstellen'),
  },
};

for (const [lang, web] of Object.entries({ en, de })) {
  const { exportBackup, restoreBackup } = deltaChat[lang];
  const label = key => plain(web[key]);
  const setUpPhone = path(label('nav.settings'), label('profile.phone'));
  const exportFromWeb = path(label('nav.settings'), label('profile.export'));
  const importFile = label('import.file');
  const deltaChatWay = path(label('way.deltaChat'), importFile);

  const sources = {
    'web client': [all(web), [exportBackup, restoreBackup]],
    'invite page': [all(LANGUAGES[lang]), [exportBackup, restoreBackup, setUpPhone, deltaChatWay]],
    site: [plain(readFileSync(new URL(`../site/index.${lang}.html`, import.meta.url), 'utf8')),
      [exportBackup, restoreBackup, setUpPhone, exportFromWeb, importFile]],
  };

  test(`setup instructions use the same wording (${lang})`, () => {
    for (const [source, [text, phrases]] of Object.entries(sources)) {
      for (const phrase of phrases) assert.ok(text.includes(phrase), `${source} (${lang}) lacks "${phrase}"`);
    }
  });
}
