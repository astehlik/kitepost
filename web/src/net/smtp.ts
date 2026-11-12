import { TlsSocket } from './tlssocket';

export class SmtpError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

function b64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

function checkAddr(addr: string): string {
  if (!/^[^\s<>]+@[^\s<>]+$/.test(addr)) throw new Error(`invalid address ${addr}`);
  return addr;
}

export class SmtpClient {
  private constructor(private sock: TlsSocket) {}

  static async connect(bridgeUrl: string, host: string, port = 465): Promise<SmtpClient> {
    const client = new SmtpClient(await TlsSocket.connect(bridgeUrl, host, port));
    await client.expect(220);
    await client.cmd('EHLO [127.0.0.1]', 250);
    return client;
  }

  private async reply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.sock.readLine();
      lines.push(line.slice(4));
      if (line[3] !== '-') return { code: Number(line.slice(0, 3)), text: lines.join('\n') };
    }
  }

  private async expect(code: number) {
    const r = await this.reply();
    if (r.code !== code) throw new SmtpError(r.code, `SMTP ${r.code}: ${r.text}`);
    return r;
  }

  private async cmd(line: string, code: number) {
    this.sock.write(`${line}\r\n`);
    return this.expect(code);
  }

  async login(user: string, password: string) {
    await this.cmd(`AUTH PLAIN ${b64(`\0${user}\0${password}`)}`, 235);
  }

  async send(from: string, recipients: string[], raw: string) {
    await this.cmd(`MAIL FROM:<${checkAddr(from)}>`, 250);
    for (const r of recipients) await this.cmd(`RCPT TO:<${checkAddr(r)}>`, 250);
    await this.cmd('DATA', 354);
    const body = raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    this.sock.write(`${body}${body.endsWith('\r\n') ? '' : '\r\n'}.\r\n`);
    await this.expect(250);
  }

  async quit() {
    try {
      await this.cmd('QUIT', 221);
    } catch {
      // Ignore: the message has already been accepted.
    }
    this.sock.close();
  }
}
