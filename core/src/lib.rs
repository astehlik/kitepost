mod addr;
mod aheader;
mod crypto;
#[allow(dead_code)]
mod format_flowed;
mod keys;
mod parse;
mod render;
mod tls;

use serde::Serialize;
use wasm_bindgen::prelude::*;

pub use tls::TlsClient;

fn js_err(e: anyhow::Error) -> JsError {
    JsError::new(&format!("{e:#}"))
}

fn to_json<T: Serialize>(v: &T) -> Result<String, JsError> {
    serde_json::to_string(v).map_err(|e| JsError::new(&e.to_string()))
}

#[derive(Serialize)]
struct KeyPair {
    secret: String,
    public: String,
    fingerprint: String,
}

/// Generates an Ed25519/Curve25519 key pair like core does, advertising `relays_csv`.
#[wasm_bindgen]
pub fn generate_keypair(addr: &str, relays_csv: &str, now: u32) -> Result<String, JsError> {
    let secret = keys::create_keypair(addr).map_err(js_err)?;
    let public =
        keys::secret_key_to_public_key(secret.clone(), now, addr, relays_csv).map_err(js_err)?;
    to_json(&KeyPair {
        secret: keys::to_base64(&secret),
        public: keys::to_base64(&public),
        fingerprint: keys::public_fingerprint(&public),
    })
}

#[wasm_bindgen]
pub fn public_key_info(addr: &str, public_b64: &str) -> Result<String, JsError> {
    let key = keys::public_from_base64(public_b64).map_err(js_err)?;
    key.verify_bindings()
        .map_err(|e| JsError::new(&e.to_string()))?;
    to_json(&parse::KeyInfo {
        addr: addr::addr_normalize(addr),
        key: keys::to_base64(&key),
        fingerprint: keys::public_fingerprint(&key),
        relays: keys::addresses_from_public_key(&key),
        can_encrypt: keys::pubkey_can_encrypt(&key),
    })
}

#[wasm_bindgen]
pub fn normalize_fingerprint(input: &str) -> Result<String, JsError> {
    keys::normalize_fingerprint(input).map_err(js_err)
}

#[wasm_bindgen]
pub fn render_message(request_json: &str) -> Result<String, JsError> {
    let req: render::OutgoingMessage =
        serde_json::from_str(request_json).map_err(|e| JsError::new(&e.to_string()))?;
    to_json(&render::render(req).map_err(js_err)?)
}

#[wasm_bindgen]
pub fn parse_message(raw: &[u8], context_json: &str) -> Result<String, JsError> {
    let ctx: parse::ParseContext =
        serde_json::from_str(context_json).map_err(|e| JsError::new(&e.to_string()))?;
    to_json(&parse::parse(raw, ctx).map_err(js_err)?)
}

/// Renders `text` as a QR code SVG path, for invite links.
#[wasm_bindgen]
pub fn qr_svg(text: &str) -> Result<String, JsError> {
    use qrcodegen::{QrCode, QrCodeEcc};
    let qr = QrCode::encode_text(text, QrCodeEcc::Medium)
        .map_err(|e| JsError::new(&format!("{e:?}")))?;
    let border = 4;
    let size = qr.size() + border * 2;
    let mut path = String::new();
    for y in 0..qr.size() {
        for x in 0..qr.size() {
            if qr.get_module(x, y) {
                path += &format!("M{},{}h1v1h-1z", x + border, y + border);
            }
        }
    }
    Ok(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {size} {size}\" shape-rendering=\"crispEdges\"><rect width=\"100%\" height=\"100%\" fill=\"#fff\"/><path d=\"{path}\" fill=\"#000\"/></svg>"
    ))
}

#[cfg(test)]
mod tests;
