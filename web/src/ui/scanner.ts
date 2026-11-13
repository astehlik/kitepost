import { t } from '../i18n';
import { h } from './dom';

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
declare const BarcodeDetector: { new (opts: { formats: string[] }): Detector } | undefined;

async function decoder(): Promise<(canvas: HTMLCanvasElement) => Promise<string | undefined>> {
  if (typeof BarcodeDetector !== 'undefined') {
    const d = new BarcodeDetector({ formats: ['qr_code'] });
    return async canvas => (await d.detect(canvas))[0]?.rawValue;
  }
  const { default: jsQR } = await import('jsqr');
  return async canvas => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data;
  };
}

/** Scans a QR code with the camera; the text field accepts a pasted code instead. */
export function scanQr(title: string, hint: string, accept: (text: string) => boolean): Promise<string | undefined> {
  return new Promise(resolve => {
    const video = h('video', { muted: true, playsinline: true });
    const canvas = h('canvas', { hidden: true });
    const status = h('p', { class: 'hint' }, t('scanner.starting'));
    const paste = h('input', { type: 'text', placeholder: t('scanner.paste'), spellcheck: 'false', 'aria-label': t('scanner.pasteLabel') });
    const dlg = h('dialog', { class: 'dialog scanner' },
      h('h2', {}, title), h('p', {}, hint), h('div', { class: 'viewfinder' }, video), canvas, status, paste,
      h('div', { class: 'actions' }, h('button', { onclick: () => finish(undefined) }, t('cancel'))));
    let stream: MediaStream | undefined;
    let done = false;
    const finish = (text: string | undefined) => {
      if (done) return;
      done = true;
      stream?.getTracks().forEach(t => t.stop());
      dlg.close();
      dlg.remove();
      resolve(text);
    };
    const check = (text: string | undefined) => {
      if (!text) return;
      if (accept(text)) finish(text.trim());
      else status.textContent = t('scanner.wrong');
    };
    paste.addEventListener('input', () => check(paste.value));
    dlg.addEventListener('cancel', () => finish(undefined));
    document.body.append(dlg);
    dlg.showModal();
    paste.focus();

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      } catch {
        status.textContent = t('scanner.noCamera');
        return;
      }
      if (done) return finish(undefined);
      video.srcObject = stream;
      await video.play();
      status.textContent = t('scanner.point');
      const decode = await decoder();
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      while (!done) {
        if (video.videoWidth) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          check(await decode(canvas).catch(() => undefined));
        }
        await new Promise(r => setTimeout(r, 200));
      }
    })();
  });
}
