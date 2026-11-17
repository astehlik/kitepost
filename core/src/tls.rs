//! Sans-I/O TLS client. TLS terminates inside the browser, so the WebSocket bridge
//! only ever relays ciphertext and cannot read or alter IMAP/SMTP traffic.

use std::io::{Read, Write};
use std::sync::Arc;

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::server::ParsedCertificate;
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, RootCertStore, SignatureScheme};
use wasm_bindgen::prelude::*;

/// Same policy as core's `src/net/tls/danger.rs`: hostnames starting with `_` cannot get
/// publicly trusted certificates, so only the hostname is checked for them (local test relays).
#[derive(Debug)]
struct Verifier {
    webpki: Arc<WebPkiServerVerifier>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if let ServerName::DnsName(name) = server_name
            && name.as_ref().starts_with('_')
        {
            let cert = ParsedCertificate::try_from(end_entity)?;
            rustls::client::verify_server_name(&cert, server_name)?;
            return Ok(ServerCertVerified::assertion());
        }
        self.webpki
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

#[wasm_bindgen]
pub struct TlsClient {
    conn: ClientConnection,
    plaintext: Vec<u8>,
}

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen]
impl TlsClient {
    #[wasm_bindgen(constructor)]
    pub fn new(server_name: &str) -> Result<TlsClient, JsError> {
        let roots = RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let provider = Arc::new(rustls_rustcrypto::provider());
        let webpki = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone())
            .build()
            .map_err(js_err)?;
        let config = ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .map_err(js_err)?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Verifier { webpki, provider }))
            .with_no_client_auth();
        let name = ServerName::try_from(server_name.to_string()).map_err(js_err)?;
        let conn = ClientConnection::new(Arc::new(config), name).map_err(js_err)?;
        Ok(TlsClient { conn, plaintext: Vec::new() })
    }

    /// Feeds ciphertext received from the network.
    pub fn feed(&mut self, data: &[u8]) -> Result<(), JsError> {
        self.try_feed(data).map_err(js_err)
    }

    /// Returns ciphertext that must be sent to the network.
    pub fn take_outgoing(&mut self) -> Result<Vec<u8>, JsError> {
        self.try_take_outgoing().map_err(js_err)
    }

    /// Returns decrypted application data.
    pub fn take_plaintext(&mut self) -> Result<Vec<u8>, JsError> {
        self.try_take_plaintext().map_err(js_err)
    }

    pub fn write_plaintext(&mut self, data: &[u8]) -> Result<(), JsError> {
        self.conn.writer().write_all(data).map_err(js_err)
    }

    pub fn is_handshaking(&self) -> bool {
        self.conn.is_handshaking()
    }

    pub fn close(&mut self) {
        self.conn.send_close_notify();
    }
}

impl TlsClient {
    fn try_feed(&mut self, mut data: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
        while !data.is_empty() {
            if self.conn.read_tls(&mut data)? == 0 {
                break;
            }
            self.conn.process_new_packets()?;
            // rustls refuses more ciphertext while 16 KiB of plaintext are unread.
            self.drain_plaintext()?;
        }
        Ok(())
    }

    fn try_take_outgoing(&mut self) -> std::io::Result<Vec<u8>> {
        let mut out = Vec::new();
        while self.conn.wants_write() {
            self.conn.write_tls(&mut out)?;
        }
        Ok(out)
    }

    fn try_take_plaintext(&mut self) -> std::io::Result<Vec<u8>> {
        self.drain_plaintext()?;
        Ok(std::mem::take(&mut self.plaintext))
    }

    fn drain_plaintext(&mut self) -> std::io::Result<()> {
        let mut buf = [0u8; 16384];
        loop {
            match self.conn.reader().read(&mut buf) {
                Ok(0) => return Ok(()),
                Ok(n) => self.plaintext.extend_from_slice(&buf[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
                Err(e) => return Err(e),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::ServerConnection;
    use rustls::pki_types::PrivateKeyDer;

    const HOST: &str = "_kitepost.test";

    fn server() -> ServerConnection {
        let cert = rcgen::generate_simple_self_signed(vec![HOST.into()]).unwrap();
        let key = PrivateKeyDer::try_from(cert.key_pair.serialize_der()).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls_rustcrypto::provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![cert.cert.der().clone()], key)
            .unwrap();
        ServerConnection::new(Arc::new(config)).unwrap()
    }

    fn server_output(server: &mut ServerConnection) -> Vec<u8> {
        let mut out = Vec::new();
        while server.wants_write() {
            server.write_tls(&mut out).unwrap();
        }
        out
    }

    #[test]
    fn feeds_more_plaintext_than_rustls_buffers_at_once() {
        let mut client = TlsClient::new(HOST).unwrap();
        let mut server = server();
        while client.is_handshaking() || server.is_handshaking() {
            let out = client.try_take_outgoing().unwrap();
            server.read_tls(&mut out.as_slice()).unwrap();
            server.process_new_packets().unwrap();
            client.try_feed(&server_output(&mut server)).unwrap();
        }

        let sent: Vec<u8> = (0..200_000u32).map(|i| i as u8).collect();
        let mut frame = Vec::new();
        for chunk in sent.chunks(16_384) {
            server.writer().write_all(chunk).unwrap();
            frame.extend(server_output(&mut server));
        }
        client.try_feed(&frame).unwrap();
        assert!(client.try_take_plaintext().unwrap() == sent);
    }
}
