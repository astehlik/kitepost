//! Delta Chat's "Add second device" over the chatmail relay's iroh relay (core src/imex/transfer.rs).

use anyhow::{Context as _, Result, anyhow, bail, ensure};
use futures_lite::FutureExt as _;
use iroh::{Endpoint, NodeAddr, RelayMode, RelayUrl};
use js_sys::{Function, Promise, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

const BACKUP_ALPN: &[u8] = b"/deltachat/backup";
const MAX_BACKUP_VERSION: u32 = 5;
const BLOCK: usize = 512;
const SEND_CHUNK: f64 = 256.0 * 1024.0;

pub struct BackupQr {
    pub auth_token: String,
    pub node_addr: NodeAddr,
}

/// Parses `DCBACKUP<version>:<auth token>&<node address JSON>`, see core `qr::decode_backup2`.
pub fn parse_qr(qr: &str) -> Result<BackupQr> {
    let qr = qr.trim();
    let rest = qr
        .get(..8)
        .filter(|p| p.eq_ignore_ascii_case("DCBACKUP"))
        .map(|_| &qr[8..])
        .context("not a Delta Chat backup QR code")?;
    let (version, payload) = rest.split_once(':').context("invalid backup QR code")?;
    let version: u32 = version.parse().context("invalid backup QR code version")?;
    ensure!(
        (2..=MAX_BACKUP_VERSION).contains(&version),
        "this Delta Chat version is newer than Kitepost supports"
    );
    let (auth_token, node_addr) = payload.split_once('&').context("invalid backup QR code")?;
    let node_addr: NodeAddr =
        serde_json::from_str(node_addr).context("invalid node address in backup QR code")?;
    Ok(BackupQr {
        auth_token: auth_token.to_string(),
        node_addr,
    })
}

/// Tracks tar framing, because the provider does not close the stream after the archive.
#[derive(Default)]
pub struct TarEnd {
    header: Vec<u8>,
    skip: usize,
    pub done: bool,
}

impl TarEnd {
    /// Feeds bytes and returns how many of them belong to the archive.
    pub fn feed(&mut self, mut data: &[u8]) -> usize {
        let total = data.len();
        while !data.is_empty() && !self.done {
            if self.skip > 0 {
                let n = self.skip.min(data.len());
                self.skip -= n;
                data = &data[n..];
                continue;
            }
            let n = (BLOCK - self.header.len()).min(data.len());
            self.header.extend_from_slice(&data[..n]);
            data = &data[n..];
            if self.header.len() == BLOCK {
                if self.header.iter().all(|&b| b == 0) {
                    self.done = true;
                } else {
                    self.skip = entry_size(&self.header).div_ceil(BLOCK) * BLOCK;
                }
                self.header.clear();
            }
        }
        total - data.len()
    }
}

fn entry_size(header: &[u8]) -> usize {
    let field = &header[124..136];
    if field[0] & 0x80 != 0 {
        return field[1..].iter().fold(0usize, |n, &b| n.saturating_mul(256).saturating_add(b.into()));
    }
    let s: String = field.iter().take_while(|&&b| b != 0).map(|&b| b as char).collect();
    usize::from_str_radix(s.trim(), 8).unwrap_or(0)
}

async fn receive(qr: &str, on_data: &Function, confirm: &Function) -> Result<()> {
    let BackupQr {
        auth_token,
        node_addr,
    } = parse_qr(qr)?;
    let Some(relay_url) = node_addr.relay_url.clone() else {
        bail!("the other device offers no relay, which a browser needs to connect");
    };
    let endpoint = Endpoint::builder()
        .tls_x509()
        .relay_mode(RelayMode::Custom(relay_url.clone().into()))
        .bind()
        .await?;
    let conn = endpoint
        .connect(NodeAddr::new(node_addr.node_id).with_relay_url(relay_url), BACKUP_ALPN)
        .await
        .context("could not connect to the other device")?;
    let (mut send, mut recv) = conn.open_bi().await?;
    send.write_all(auth_token.as_bytes()).await?;

    let mut size = [0u8; 8];
    recv.read_exact(&mut size)
        .await
        .context("the other device rejected the connection")?;
    let size = u64::from_be_bytes(size) as f64;

    let mut tar = TarEnd::default();
    let mut received = 0f64;
    let mut buf = vec![0u8; 64 * 1024];
    while !tar.done {
        let n = recv
            .read(&mut buf)
            .await?
            .context("connection closed before the backup was complete")?;
        let used = tar.feed(&buf[..n]);
        received += used as f64;
        on_data
            .call3(
                &JsValue::NULL,
                &Uint8Array::from(&buf[..used]),
                &received.into(),
                &size.into(),
            )
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    }

    let ok = JsFuture::from(Promise::from(
        confirm.call0(&JsValue::NULL).map_err(|e| anyhow::anyhow!("{e:?}"))?,
    ))
    .await
    .map_err(|e| anyhow::anyhow!("{}", e.as_string().unwrap_or_else(|| format!("{e:?}"))))?;
    if ok.as_bool() == Some(true) {
        send.write_all(b".").await?;
        send.finish()?;
        let _ = send.stopped().await;
    }
    endpoint.close().await;
    Ok(())
}

/// Receives the tar stream, passing chunks to `on_data(chunk, received, total)`. Once complete,
/// awaits `confirm()` and only acknowledges to the other device if it resolves to `true`.
#[wasm_bindgen]
pub async fn receive_backup(qr: String, on_data: Function, confirm: Function) -> Result<(), JsError> {
    receive(&qr, &on_data, &confirm)
        .await
        .map_err(|e| JsError::new(&format!("{e:#}")))
}

fn js_err(e: JsValue) -> anyhow::Error {
    anyhow!("{}", e.as_string().unwrap_or_else(|| format!("{e:?}")))
}

async fn call_async(f: &Function, a: &JsValue, b: &JsValue) -> Result<JsValue> {
    JsFuture::from(Promise::from(f.call2(&JsValue::NULL, a, b).map_err(js_err)?))
        .await
        .map_err(js_err)
}

fn auth_token() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom03::fill(&mut bytes).map_err(|e| anyhow!("{e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Serves one connection; `Ok(false)` if the peer did not know the token.
async fn serve(
    connecting: iroh::endpoint::Connecting,
    auth_token: &str,
    size: f64,
    read: &Function,
    progress: &Function,
) -> Result<bool> {
    let authenticated = async {
        let conn = connecting.await?;
        let (send, mut recv) = conn.accept_bi().await?;
        let mut token = vec![0u8; auth_token.len()];
        recv.read_exact(&mut token).await?;
        anyhow::Ok((conn, send, recv, token == auth_token.as_bytes()))
    };
    let Ok((_conn, mut send, mut recv, true)) = authenticated.await else {
        return Ok(false);
    };
    send.write_all(&(size as u64).to_be_bytes()).await?;
    let mut sent = 0f64;
    while sent < size {
        let chunk = call_async(read, &sent.into(), &SEND_CHUNK.min(size - sent).into()).await?;
        let chunk = Uint8Array::from(chunk).to_vec();
        ensure!(!chunk.is_empty(), "the backup ended early");
        send.write_all(&chunk).await?;
        sent += chunk.len() as f64;
        progress
            .call2(&JsValue::NULL, &sent.into(), &size.into())
            .map_err(js_err)?;
    }
    let mut ack = [0u8; 1];
    recv.read_exact(&mut ack)
        .await
        .context("the other device did not confirm the transfer")?;
    Ok(true)
}

async fn provide(
    relay_url: &str,
    version: u32,
    size: f64,
    on_qr: &Function,
    read: &Function,
    progress: &Function,
    cancel: Promise,
) -> Result<()> {
    let relay_url: RelayUrl = relay_url.parse().context("invalid iroh relay URL")?;
    let endpoint = Endpoint::builder()
        .tls_x509()
        .alpns(vec![BACKUP_ALPN.to_vec()])
        .relay_mode(RelayMode::Custom(relay_url.into()))
        .bind()
        .await?;
    let cancelled = async {
        JsFuture::from(cancel).await.map_err(js_err)?;
        bail!("cancelled")
    };
    let result = async {
        // In browsers this waits for the home relay, the only way to reach this endpoint.
        let node_addr = endpoint.node_addr().await?;
        let auth_token = auth_token()?;
        let qr = format!("DCBACKUP{version}:{auth_token}&{}", serde_json::to_string(&node_addr)?);
        on_qr.call1(&JsValue::NULL, &qr.into()).map_err(js_err)?;
        loop {
            let incoming = endpoint.accept().await.context("iroh endpoint closed")?;
            let Ok(connecting) = incoming.accept() else { continue };
            if serve(connecting, &auth_token, size, read, progress).await? {
                return Ok(());
            }
        }
    }
    .or(cancelled)
    .await;
    endpoint.close().await;
    result
}

/// Offers a backup of `size` bytes to Delta Chat's "Add as second device" through `relay_url`.
/// Calls `on_qr(qr)` once reachable and `read(offset, length)` for the archive's bytes, which
/// returns a promise of a `Uint8Array`, and `progress(sent, total)`. Resolves after the other
/// device confirmed the transfer, rejects once `cancel` resolves.
#[wasm_bindgen]
pub async fn provide_backup(
    relay_url: String,
    version: u32,
    size: f64,
    on_qr: Function,
    read: Function,
    progress: Function,
    cancel: Promise,
) -> Result<(), JsError> {
    provide(&relay_url, version, size, &on_qr, &read, &progress, cancel)
        .await
        .map_err(|e| JsError::new(&format!("{e:#}")))
}

#[wasm_bindgen]
pub fn is_backup_qr(qr: &str) -> bool {
    parse_qr(qr).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_core_qr() {
        let node_id = iroh::SecretKey::from_bytes(&[7; 32]).public();
        let addr = NodeAddr::new(node_id).with_relay_url("https://chat.example.org".parse().unwrap());
        let qr = format!("DCBACKUP5:Ab12&{}", serde_json::to_string(&addr).unwrap());
        let parsed = parse_qr(&qr).unwrap();
        assert_eq!(parsed.auth_token, "Ab12");
        assert_eq!(parsed.node_addr, addr);
        assert!(parse_qr(&qr.replace("DCBACKUP5", "DCBACKUP9")).is_err());
        assert!(parse_qr("OPENPGP4FPR:abc").is_err());
    }

    #[test]
    fn finds_end_of_archive() {
        let mut header = [0u8; BLOCK];
        header[124..135].copy_from_slice(b"00000001000");
        let mut tar = header.to_vec();
        tar.extend(vec![7u8; BLOCK]);
        tar.extend(vec![0u8; BLOCK * 2]);
        let mut end = TarEnd::default();
        let (a, b) = tar.split_at(700);
        assert_eq!(end.feed(a), 700);
        assert!(!end.done);
        assert_eq!(end.feed(b), BLOCK * 3 - 700);
        assert!(end.done);
    }
}
