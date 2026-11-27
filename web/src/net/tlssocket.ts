import { TlsClient } from '../wasm';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FRAME_SIZE = 64 * 1024;

/** A TLS stream to `host:port`, tunnelled through the WebSocket bridge. */
export class TlsSocket {
  private buf = new Uint8Array(64 * 1024);
  private start = 0;
  private end = 0;
  private waiter: (() => void) | undefined;
  private error: Error | undefined;
  private closed = false;

  private constructor(private ws: WebSocket, private tls: TlsClient) {}

  static connect(bridgeUrl: string, host: string, port: number, timeoutMs = 30_000): Promise<TlsSocket> {
    const url = new URL(bridgeUrl, location.href);
    url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
    url.searchParams.set('host', host);
    url.searchParams.set('port', String(port));
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const sock = new TlsSocket(ws, new TlsClient(host));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.fail(new Error(`connection to ${host}:${port} timed out`));
      }, timeoutMs);
      ws.onopen = () => sock.flush();
      ws.onmessage = ev => {
        try {
          sock.tls.feed(new Uint8Array(ev.data as ArrayBuffer));
          sock.flush();
          const plain = sock.tls.take_plaintext();
          if (plain.length) sock.append(plain);
          if (!sock.tls.is_handshaking()) {
            clearTimeout(timer);
            resolve(sock);
          }
        } catch (e) {
          sock.fail(e instanceof Error ? e : new Error(String(e)));
        }
      };
      ws.onerror = () => sock.fail(new Error(`bridge connection to ${host}:${port} failed`));
      ws.onclose = ev => sock.fail(new Error(`connection closed${ev.reason ? `: ${ev.reason}` : ''}`));
      sock.onFail = e => {
        clearTimeout(timer);
        reject(e);
      };
    });
  }

  private onFail: ((e: Error) => void) | undefined;

  private fail(e: Error) {
    if (this.closed) return;
    this.closed = true;
    this.error = e;
    this.onFail?.(e);
    this.ws.close();
    this.tls.free();
    this.wake();
  }

  private flush() {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    const out = this.tls.take_outgoing();
    // The bridge closes the connection on WebSocket messages above 1 MiB (maxPayload).
    for (let i = 0; i < out.length; i += FRAME_SIZE) this.ws.send(out.subarray(i, i + FRAME_SIZE) as Uint8Array<ArrayBuffer>);
  }

  private append(data: Uint8Array) {
    const len = this.end - this.start;
    if (this.end + data.length > this.buf.length) {
      const grown = len + data.length > this.buf.length ? new Uint8Array(Math.max(this.buf.length * 2, len + data.length)) : this.buf;
      grown.set(this.buf.subarray(this.start, this.end), 0);
      this.buf = grown;
      this.start = 0;
      this.end = len;
    }
    this.buf.set(data, this.end);
    this.end += data.length;
    this.wake();
  }

  private take(n: number, skip = 0): Uint8Array {
    const out = this.buf.slice(this.start, this.start + n);
    this.start += n + skip;
    if (this.start === this.end) this.start = this.end = 0;
    return out;
  }

  private wake() {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }

  private async waitData(signal?: AbortSignal) {
    if (this.error) throw this.error;
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      this.waiter = resolve;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    if (this.error) throw this.error;
  }

  write(data: string | Uint8Array) {
    if (this.error) throw this.error;
    this.tls.write_plaintext(typeof data === 'string' ? encoder.encode(data) : data);
    this.flush();
  }

  /** Reads a CRLF-terminated line without the line ending. */
  async readLine(signal?: AbortSignal): Promise<string> {
    for (;;) {
      const idx = this.buf.subarray(this.start, this.end).indexOf(10);
      if (idx >= 0) {
        const cr = idx > 0 && this.buf[this.start + idx - 1] === 13 ? 1 : 0;
        return decoder.decode(this.take(idx - cr, cr + 1));
      }
      await this.waitData(signal);
    }
  }

  async readBytes(n: number): Promise<Uint8Array> {
    while (this.end - this.start < n) await this.waitData();
    return this.take(n);
  }

  close() {
    if (this.closed) return;
    try {
      this.tls.close();
      this.flush();
    } catch {
      // Connection may already be gone.
    }
    this.fail(new Error('socket closed'));
  }
}
