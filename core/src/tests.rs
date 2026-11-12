use std::collections::HashMap;

use crate::keys::{create_keypair, public_fingerprint, secret_key_to_public_key, to_base64};
use crate::parse::{ParseContext, SymmetricSecretSpec, parse};
use crate::render::{Encryption, Gossip, HeaderKind, HeaderSpec, NamedAddr, OutgoingMessage, render};

struct Account {
    addr: String,
    secret: String,
    public: String,
    fp: String,
}

fn account(addr: &str) -> Account {
    let secret = create_keypair(addr).unwrap();
    let public = secret_key_to_public_key(secret.clone(), 1_700_000_000, addr, addr).unwrap();
    Account {
        addr: addr.into(),
        secret: to_base64(&secret),
        public: to_base64(&public),
        fp: public_fingerprint(&public),
    }
}

fn message(from: &Account, encryption: Encryption, sign: bool) -> OutgoingMessage {
    OutgoingMessage {
        rfc724_mid: "abc@localhost".into(),
        from_addr: from.addr.clone(),
        from_name: "Alice Ä".into(),
        self_secret_key: from.secret.clone(),
        self_public_key: from.public.clone(),
        to: vec![],
        subject: "Message from Alice".into(),
        text: "Hello\nworld".into(),
        content_disposition: None,
        headers: vec![HeaderSpec {
            name: "Chat-Version".into(),
            value: "1.0".into(),
            kind: HeaderKind::Raw,
        }],
        gossip: vec![],
        encryption,
        attach_pubkey: true,
        sign,
        compress: true,
        wrap_multipart_mixed: false,
        attachment: None,
        timestamp: 1_800_000_000,
    }
}

fn ctx(acc: &Account, secrets: Vec<SymmetricSecretSpec>) -> ParseContext {
    ParseContext {
        self_addrs: vec![acc.addr.clone()],
        self_secret_key: acc.secret.clone(),
        self_public_key: acc.public.clone(),
        symmetric_secrets: secrets,
        known_keys: HashMap::new(),
    }
}

#[test]
fn key_has_relay_notation() {
    let a = account("alice@example.org");
    let key = crate::keys::public_from_base64(&a.public).unwrap();
    assert_eq!(
        crate::keys::addresses_from_public_key(&key),
        Some(vec!["alice@example.org".to_string()])
    );
    assert!(crate::keys::pubkey_supports_seipdv2(&key));
}

#[test]
fn asymmetric_roundtrip() {
    let alice = account("alice@example.org");
    let bob = account("bob@example.net");
    let mut msg = message(
        &alice,
        Encryption::Asymmetric { keys: vec![bob.public.clone()] },
        true,
    );
    msg.to = vec![NamedAddr { name: "Bob".into(), addr: bob.addr.clone() }];
    msg.gossip = vec![Gossip { addr: bob.addr.clone(), key: bob.public.clone() }];
    let rendered = render(msg).unwrap();
    assert!(!rendered.raw.contains("Hello"));
    assert!(rendered.raw.contains("Subject: [...]"));

    let parsed = parse(rendered.raw.as_bytes(), ctx(&bob, vec![])).unwrap();
    assert!(parsed.encrypted);
    assert_eq!(parsed.signature.as_deref(), Some(alice.fp.as_str()));
    assert!(parsed.intended_recipients.contains(&bob.fp));
    assert_eq!(parsed.text, "Hello\nworld");
    assert_eq!(parsed.from.addr, alice.addr);
    assert_eq!(parsed.from.name, "Alice Ä");
    assert_eq!(parsed.headers.get("chat-version").map(String::as_str), Some("1.0"));
    assert_eq!(parsed.headers.get("subject").map(String::as_str), Some("Message from Alice"));
    assert_eq!(parsed.autocrypt.unwrap().fingerprint, alice.fp);
    assert_eq!(parsed.gossip[0].fingerprint, bob.fp);
    assert_eq!(parsed.recipients[0].addr, bob.addr);
}

#[test]
fn symmetric_securejoin_roundtrip() {
    let alice = account("alice@example.org");
    let bob = account("bob@example.net");
    let secret = format!("securejoin/{}/AUTHTOKEN", alice.fp);

    // Bob -> Alice: unsigned vc-request-pubkey.
    let mut req = message(&bob, Encryption::Symmetric { secret: secret.clone() }, false);
    req.attach_pubkey = false;
    req.compress = false;
    req.headers = vec![
        HeaderSpec { name: "Secure-Join".into(), value: "vc-request-pubkey".into(), kind: HeaderKind::Raw },
        HeaderSpec { name: "Secure-Join-Auth".into(), value: "AUTHTOKEN".into(), kind: HeaderKind::Text },
    ];
    let raw = render(req).unwrap().raw;
    let parsed = parse(
        raw.as_bytes(),
        ctx(&alice, vec![SymmetricSecretSpec { id: "auth".into(), secret: secret.clone(), expected_signer: None }]),
    )
    .unwrap();
    assert_eq!(parsed.symmetric_secret_id.as_deref(), Some("auth"));
    assert_eq!(parsed.headers.get("secure-join").map(String::as_str), Some("vc-request-pubkey"));
    assert_eq!(parsed.headers.get("secure-join-auth").map(String::as_str), Some("AUTHTOKEN"));

    // Alice -> Bob: signed vc-pubkey carrying her key.
    let mut resp = message(&alice, Encryption::Symmetric { secret: secret.clone() }, true);
    resp.compress = false;
    resp.headers = vec![HeaderSpec { name: "Secure-Join".into(), value: "vc-pubkey".into(), kind: HeaderKind::Raw }];
    let raw = render(resp).unwrap().raw;
    let spec = || SymmetricSecretSpec { id: "bob".into(), secret: secret.clone(), expected_signer: Some(alice.fp.clone()) };
    let parsed = parse(raw.as_bytes(), ctx(&bob, vec![spec()])).unwrap();
    assert_eq!(parsed.signature.as_deref(), Some(alice.fp.as_str()));
    assert_eq!(parsed.headers.get("secure-join").map(String::as_str), Some("vc-pubkey"));

    // A third party knowing the secret must not be able to impersonate Alice.
    let eve = account("eve@example.com");
    let mut forged = message(&eve, Encryption::Symmetric { secret: secret.clone() }, true);
    forged.from_addr = alice.addr.clone();
    let raw = render(forged).unwrap().raw;
    assert!(parse(raw.as_bytes(), ctx(&bob, vec![spec()])).is_err());
}

#[test]
fn unencrypted_cannot_carry_protected_securejoin_headers() {
    let alice = account("alice@example.org");
    let bob = account("bob@example.net");
    let mut msg = message(&alice, Encryption::None, false);
    msg.headers.push(HeaderSpec { name: "Secure-Join".into(), value: "vc-contact-confirm".into(), kind: HeaderKind::Raw });
    let raw = render(msg).unwrap().raw;
    let parsed = parse(raw.as_bytes(), ctx(&bob, vec![])).unwrap();
    assert!(!parsed.encrypted);
    assert!(parsed.headers.get("secure-join").is_none());
}

#[test]
fn underscore_hostnames_are_valid_server_names() {
    assert!(rustls::pki_types::ServerName::try_from("_chatmail.test").is_ok());
}
