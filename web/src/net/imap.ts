import { TlsSocket } from './tlssocket';

export interface ImapResponse {
  line: string;
  literals: Uint8Array[];
}

export interface FetchedMessage {
  uid: number;
  body: Uint8Array;
}

function quote(s: string): string {
  if (/[\r\n\0]/.test(s) || /[^\x20-\x7e]/.test(s)) throw new Error('unsupported character in IMAP string');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export class ImapClient {
  private tagCounter = 0;
  /** Dovecot announces mail once, possibly in the response to an unrelated command, and not again in IDLE. */
  private newMail = false;
  capabilities = new Set<string>();

  private constructor(private sock: TlsSocket) {}

  static async connect(bridgeUrl: string, host: string, port = 993): Promise<ImapClient> {
    const client = new ImapClient(await TlsSocket.connect(bridgeUrl, host, port));
    const greeting = await client.readResponse();
    if (!/^\* (OK|PREAUTH)/i.test(greeting.line)) {
      client.close();
      throw new Error(`unexpected IMAP greeting: ${greeting.line}`);
    }
    return client;
  }

  /** Reads one response line including any `{n}` literals it announces. */
  private async readResponse(signal?: AbortSignal): Promise<ImapResponse> {
    let line = await this.sock.readLine(signal);
    const literals: Uint8Array[] = [];
    for (;;) {
      const m = /\{(\d+)\+?\}$/.exec(line);
      if (!m) break;
      const size = Number(m[1]);
      if (size > 64 * 1024 * 1024) throw new Error('IMAP literal too large');
      literals.push(await this.sock.readBytes(size));
      line = `${line.slice(0, m.index)}{LITERAL${literals.length - 1}}${await this.sock.readLine()}`;
    }
    return { line, literals };
  }

  private async command(cmd: string, onUntagged?: (r: ImapResponse) => void): Promise<ImapResponse[]> {
    const tag = `A${++this.tagCounter}`;
    this.sock.write(`${tag} ${cmd}\r\n`);
    const untagged: ImapResponse[] = [];
    for (;;) {
      const resp = await this.readResponse();
      if (resp.line.startsWith(`${tag} `)) {
        const status = resp.line.slice(tag.length + 1);
        if (!/^OK/i.test(status)) throw new Error(`IMAP ${cmd.split(' ')[0]} failed: ${status}`);
        return untagged;
      }
      if (/^\* \d+ (EXISTS|RECENT)/i.test(resp.line)) this.newMail = true;
      onUntagged?.(resp);
      untagged.push(resp);
    }
  }

  async login(user: string, password: string) {
    await this.command(`LOGIN ${quote(user)} ${quote(password)}`);
    await this.refreshCapabilities();
  }

  private async refreshCapabilities() {
    const resp = await this.command('CAPABILITY');
    for (const r of resp) {
      const m = /^\* CAPABILITY (.*)$/i.exec(r.line);
      if (m) this.capabilities = new Set(m[1].toUpperCase().split(' '));
    }
  }

  async select(mailbox = 'INBOX'): Promise<{ uidValidity: number; uidNext: number; exists: number }> {
    const resp = await this.command(`SELECT ${quote(mailbox)}`);
    let uidValidity = 0;
    let uidNext = 0;
    let exists = 0;
    for (const r of resp) {
      const v = /UIDVALIDITY (\d+)/i.exec(r.line);
      if (v) uidValidity = Number(v[1]);
      const n = /UIDNEXT (\d+)/i.exec(r.line);
      if (n) uidNext = Number(n[1]);
      const e = /^\* (\d+) EXISTS/i.exec(r.line);
      if (e) exists = Number(e[1]);
    }
    return { uidValidity, uidNext, exists };
  }

  /** Fetches full messages with UID greater than `afterUid`, in batches. */
  async fetchNewer(afterUid: number, onMessage: (m: FetchedMessage) => Promise<void>) {
    // Cleared before the search: mail announced in its response is not in its result.
    this.newMail = false;
    const search = await this.command(`UID SEARCH UID ${afterUid + 1}:*`);
    const uids: number[] = [];
    for (const r of search) {
      const m = /^\* SEARCH(.*)$/i.exec(r.line);
      if (m) uids.push(...m[1].trim().split(/\s+/).filter(Boolean).map(Number));
    }
    const pending = uids.filter(u => u > afterUid).sort((a, b) => a - b);
    for (let i = 0; i < pending.length; i += 20) {
      const batch = pending.slice(i, i + 20);
      const resp = await this.command(`UID FETCH ${batch.join(',')} (UID BODY.PEEK[])`);
      const fetched: FetchedMessage[] = [];
      for (const r of resp) {
        const uid = /\bUID (\d+)/i.exec(r.line);
        if (/^\* \d+ FETCH/i.test(r.line) && uid && r.literals.length) {
          fetched.push({ uid: Number(uid[1]), body: r.literals[0] });
        }
      }
      fetched.sort((a, b) => a.uid - b.uid);
      for (const m of fetched) await onMessage(m);
    }
  }

  async markSeen(uids: number[]) {
    if (uids.length) await this.command(`UID STORE ${uids.join(',')} +FLAGS.SILENT (\\Seen)`);
  }

    async deleteUids(uids: number[]) {
    if (!uids.length) return;
    await this.command(`UID STORE ${uids.join(',')} +FLAGS.SILENT (\\Deleted)`);
    await this.command(this.capabilities.has('UIDPLUS') ? `UID EXPUNGE ${uids.join(',')}` : 'EXPUNGE');
  }

  /** Waits in IDLE until the mailbox changes, `signal` aborts, or the timeout elapses. */
  async idle(signal: AbortSignal, timeoutMs = 20 * 60 * 1000): Promise<void> {
    if (this.newMail) return;
    const tag = `A${++this.tagCounter}`;
    this.sock.write(`${tag} IDLE\r\n`);
    const cont = await this.readResponse();
    if (!cont.line.startsWith('+')) throw new Error(`IDLE rejected: ${cont.line}`);

    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), timeoutMs);
    const onAbort = () => stop.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        const r = await this.readResponse(stop.signal);
        if (/^\* \d+ (EXISTS|RECENT)/i.test(r.line)) break;
      }
    } catch (e) {
      if (!stop.signal.aborted) throw e;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
    this.sock.write('DONE\r\n');
    for (;;) {
      const r = await this.readResponse();
      if (r.line.startsWith(`${tag} `)) break;
    }
  }

  async logout() {
    try {
      await this.command('LOGOUT');
    } catch {
      // Server may close before answering.
    }
    this.close();
  }

  close() {
    this.sock.close();
  }
}
