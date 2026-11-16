export type SendErrorKind = 'offline' | 'login' | 'tooLarge' | 'later' | 'rejected';

/** Sorts the raw errors of the bridge, TLS and SMTP layers; other errors stay as they are. */
export function sendErrorKind(raw: string): SendErrorKind | undefined {
  const smtp = /^SMTP (\d{3})/.exec(raw);
  if (smtp) {
    const code = Number(smtp[1]);
    if (code === 530 || code === 534 || code === 535) return 'login';
    if (/\b5\.3\.4\b|message size/i.test(raw)) return 'tooLarge';
    if (code >= 400 && code < 500) return 'later';
    if (code >= 500) return 'rejected';
  }
  if (/^(connection|bridge connection|socket closed)\b|timed out/.test(raw)) return 'offline';
  return undefined;
}
