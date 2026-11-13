# Kitepost

End-to-end encrypted chat in the browser, for the Delta Chat network. Kitepost is a client that runs
entirely in the browser and is an independent project, not affiliated with Delta Chat.

Encryption, key handling, MIME and TLS run as Rust compiled to WebAssembly, reusing code and crates
from [chatmail/core](https://github.com/chatmail/core) (rPGP, mailparse, mail-builder, rustls).
Messages are compatible with the official Delta Chat apps, including SecureJoin v3 invite links and
groups.

```
browser ── TLS inside WebSocket ──▶ bridge ── TCP ──▶ chatmail relay (IMAPS 993 / SMTPS 465)
```

Browsers cannot open TCP sockets, so a small **bridge** relays bytes. TLS is terminated *inside
the page* and the relay certificate is checked against the WebPKI roots, so the bridge only ever
sees ciphertext.

## Getting started

- **New profile:** right after creating it, Kitepost shows a QR code. Scanning it with Delta Chat on
  a phone makes the two verified contacts.
- **Same profile as the phone:** "Scan QR from phone" receives the profile from Delta Chat's
  *Add second device* over the chatmail server's iroh relay. This needs a Delta Chat build with
  `docs/upstream/0003-backup-transfer-relay.patch`, because current releases only offer the
  transfer on the local network. Until then, "Import backup file…" reads a backup exported in
  Delta Chat (unencrypted, as the apps export it). Afterwards both devices receive all messages,
  and copies of sent messages, read state and edits are kept in sync like between two Delta
  Chat devices.
- **Moving the profile to a phone:** Profile → "Export backup" writes a backup that Delta Chat
  imports with "Restore from backup". Its database starts from `web/src/dc/backup-schema.sql`, a
  fresh profile of the pinned Delta Chat core; core migrates it on import. After updating
  `deltachat-rpc-server` in `e2e/requirements.txt`, regenerate it with
  `work/venv/bin/python -I scripts/backup-schema.py`.

## Languages

Kitepost is available in English and German. The web client, the landing page and the invite pages
pick the language from the browser and offer a switch. The choice is stored in the cookie
`kitepost_lang` for the whole host, so switching on one of them switches all three. A new
language needs `web/src/i18n/<code>.ts` (the compiler reports missing keys), an entry in
`invite/i18n.mjs`, `site/index.<code>.html` and the language code in the maps of
`docker/site/default.conf.template`.

## Layout

| Path        | What                                                                  |
|-------------|-----------------------------------------------------------------------|
| `core/`     | Rust → WASM: keys, OpenPGP, message rendering/parsing, sans-I/O TLS    |
| `core/transfer/` | Rust → WASM, loaded on demand: iroh receiver for *Add second device* |
| `web/`      | TypeScript client: IMAP/SMTP, SecureJoin, encrypted IndexedDB, UI      |
| `bridge/`   | Node WebSocket → TCP relay (SSRF-safe: public IPs and mail ports only)  |
| `site/`     | Static landing page                                                    |
| `invite/`   | One-time invite links that create accounts on a chatmail relay         |
| `docker/`   | Images, nginx templates, Caddyfile, chatmail nginx hook                |
| `e2e/`      | End-to-end tests (pytest, Playwright, Delta Chat core), test relay    |
| `docs/upstream/` | Patches proposed to chatmail/relay and chatmail/core             |

## Deploy with Docker Compose

```sh
cp .env.example .env      # set BRIDGE_ALLOWED_HOSTS to your relay!
docker compose up -d --build
```

This publishes three services on `127.0.0.1` for a reverse proxy on the host:

| Service  | Default port | Mount at  | Purpose                        |
|----------|--------------|-----------|--------------------------------|
| `site`   | 8081         | `/`       | landing page                   |
| `app`    | 8082         | `/app/`   | the web client                 |
| `bridge` | 8083         | `/bridge` | WebSocket relay to IMAP/SMTP   |

The client uses only relative URLs, so it works under any path. Change the mount points with
`APP_URL` (link on the landing page) and `BRIDGE_URL` (relative to the client URL).

Images are published to `ghcr.io/<owner>/kitepost-{site,app,bridge,invite}` once all CI jobs on
`main` passed: `edge` follows `main`, `sha-<commit>` keeps every tested commit. Pushing a tag
`v1.2.3` on such a commit gives its tested images the tags `1.2.3`, `1.2` and `latest`, without
building again.

### Caddy on the host

```caddyfile
web.example.org {
	handle /bridge* {
		reverse_proxy 127.0.0.1:8083
	}
	redir /app /app/ 308
	handle_path /app/* {
		reverse_proxy 127.0.0.1:8082
	}
	handle {
		reverse_proxy 127.0.0.1:8081
	}
}
```

Or run the bundled Caddy (ports 80/443): `DOMAIN=web.example.org docker compose --profile caddy up -d`.

### Same hostname as a chatmail relay

A chatmail relay owns port 443: its nginx routes IMAP/SMTP by ALPN and serves its website from an
HTTPS server behind that. Rather than putting a second proxy in front, add locations to that server:

- `docker/chatmail/nginx-hook.sh` is an entrypoint wrapper for the chatmail container. On every start
  it adds `include /etc/nginx/custom.d/*.conf;` to the image's own nginx template (so Watchtower
  updates keep working) and then runs the original entrypoint. If the anchor ever disappears it only
  logs a warning.
- `docker/chatmail/webapps.conf` holds the locations for `/`, `/app/`, `/bridge` and `/join/`. The
  relay container uses host networking, so it reaches the ports published on 127.0.0.1.
- Set `CMDEPLOY_STAGES=configure,activate` on the chatmail container. Without it a *recreated*
  container skips the deploy and silently runs Debian's default configs (see
  `docs/upstream/README.md`).

Chatmail's stream proxy does not pass client addresses on, so behind it every client is 127.0.0.1.
Raise `BRIDGE_MAX_CONNECTIONS_PER_IP` (e.g. to 500).

### Invite service

With open registration disabled (`/etc/chatmail-nocreate`), `invite` hands out one-time links that
create accounts. It writes accounts the same way chatmaild does (`<mailboxes>/<addr>/password` with a
`{SHA512-CRYPT}` hash), so it needs the relay's mailbox directory and has to run as its `vmail` user.
It needs no Docker socket.

```sh
docker compose --profile invite up -d   # set MAIL_DOMAIN, INVITE_ADMIN_TOKEN, CHATMAIL_MAILBOXES_DIR
```

- `/join/admin`: create, list and revoke invites (admin token, ≥ 24 characters). A link is shown only
  once; storage keeps only its SHA-256.
- `/join/<token>`: the friend presses *Create my account* (a POST, so link previews in messengers
  don't use up the invite). They then get a `dclogin:` QR code and button for the Delta Chat apps and
  a button that opens the web client already logged in. The credentials travel in the URL fragment,
  so no server sees them.

## Security model

- **End-to-end encryption** exactly as in core: Ed25519/X25519 keys, SEIPDv2 (AES-128-OCB) when all
  recipients support it, signed messages, protected headers (RFC 9788), Autocrypt and gossip.
- **SecureJoin v3** for verified contacts and groups, including the core checks: the expected
  signer for symmetric handshakes, self-key gossip against surreptitious forwarding, and
  fingerprint/auth validation.
- **TLS ends in the browser** (rustls + RustCrypto, WebPKI roots). The bridge cannot read or
  modify traffic.
- **Encrypted at rest**: IndexedDB records are AES-256-GCM sealed with a PBKDF2-SHA256 (600k)
  key derived from the passphrase. The key is non-extractable and record IDs are bound as AAD.
- **Strict CSP**: only same-origin scripts run (`wasm-unsafe-eval` is limited to WebAssembly).
  Message content is rendered as text only, and only PNG/JPEG/GIF/WebP images are displayed inline.
- **Bridge**: only ports 993/465, only public IP addresses (it resolves first and connects to the
  checked IP, so DNS rebinding can't reach internal hosts), Origin check, per-IP connection limit,
  optional host allowlist. Restrict it to your relay with `BRIDGE_ALLOWED_HOSTS`.
- **Second device**: the backup is received end-to-end encrypted over iroh (QUIC), authenticated
  by the node id and token in the QR code; the relay only forwards ciphertext. The browser
  connects to the relay itself, so its origin must be allowed by the CSP: same-origin relays are
  covered by `'self'`, others need `CONNECT_SRC` (e.g. `wss://chat.example.org
  https://chat.example.org`). The camera is only used while the scanner is open.
- **Limit of any web app**: the code is delivered by the server on each visit. Users trust the
  operator every time they load it.

Not supported yet: encrypted backups, multi-device sync items (other than read state and sent
messages), broadcast channels, webxdc, calls, read receipts to contacts, ephemeral messages.

## Development

```sh
./build-wasm.sh                          # needs the wasm32-unknown-unknown target, clang and llvm-ar
(cd bridge && pnpm install && node server.mjs) &
cd web && pnpm install && pnpm dev       # Vite proxies /bridge to the bridge on :8080
```

The end-to-end tests use pytest and Playwright: the web client runs in Chromium against Delta Chat
core (`deltachat-rpc-server`) and a local chatmail relay in Docker (`e2e/relay`, domain
`_chatmail.test`, isolated network, only the invite service and the iroh relay bound on 127.0.0.1):

```sh
python -m venv work/venv && work/venv/bin/pip install -r e2e/requirements.txt
work/venv/bin/playwright install chromium   # or set CHROMIUM_PATH
e2e/run-local.sh                            # builds everything, then runs pytest
work/venv/bin/pytest e2e -k reactions       # a single test, once the app is built
work/venv/bin/pytest e2e --browser firefox  # in Firefox (playwright install firefox)
```

Each test aborts after five minutes. Failed tests leave a Playwright trace (`playwright show-trace`)
and a screenshot in `work/test-results`; CI uploads them as the `e2e-results` artifact.

`e2e/test_transfer.py` is skipped unless `DC_RPC_SERVER` points to a `deltachat-rpc-server` built
with the core patch from `docs/upstream`. The test relay
advertises a plain-HTTP iroh relay on `127.0.0.1:3340` for it.

Against a public relay, tests that need the local one are skipped:
`RELAY=nine.testrun.org RELAY_IP= work/venv/bin/pytest e2e`.

Like core, the client skips certificate chain validation (not hostname validation) for hostnames
starting with `_`. Such names cannot get publicly trusted certificates and are used for test relays.
The bridge needs `HOST_MAP=name=ip` for hosts that are not in public DNS.

## License

MPL-2.0. Parts of `core/` are ported from chatmail/core (MPL-2.0).
