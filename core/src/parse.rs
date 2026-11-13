//! Incoming message parsing, a condensed port of chatmail/core `src/mimeparser.rs`.

use std::collections::{BTreeMap, HashMap};

use anyhow::{Context as _, Result, bail, ensure};
use base64::Engine as _;
use mailparse::{MailHeaderMap as _, ParsedMail};
use pgp::composed::{SignedPublicKey, SignedSecretKey};
use serde::{Deserialize, Serialize};

use crate::addr::{addr_cmp, addr_normalize};
use crate::aheader::Aheader;
use crate::crypto::{self, SymmetricSecret};
use crate::keys::{public_fingerprint, public_from_base64, secret_from_base64, to_base64};

const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

#[derive(Deserialize)]
pub struct SymmetricSecretSpec {
    pub id: String,
    pub secret: String,
    pub expected_signer: Option<String>,
}

#[derive(Deserialize)]
pub struct ParseContext {
    pub self_addrs: Vec<String>,
    pub self_secret_key: String,
    pub self_public_key: String,
    #[serde(default)]
    pub symmetric_secrets: Vec<SymmetricSecretSpec>,
    /// Known contact keys by fingerprint, used to verify signatures.
    #[serde(default)]
    pub known_keys: HashMap<String, String>,
}

#[derive(Serialize, Clone)]
pub struct KeyInfo {
    pub addr: String,
    pub key: String,
    pub fingerprint: String,
    pub relays: Option<Vec<String>>,
    pub can_encrypt: bool,
}

#[derive(Serialize)]
pub struct Addr {
    pub name: String,
    pub addr: String,
}

#[derive(Serialize)]
pub struct AttachmentOut {
    pub filename: String,
    pub mime: String,
    pub data_b64: String,
    pub size: usize,
}

#[derive(Serialize)]
pub struct ParsedMessage {
    pub encrypted: bool,
    pub decryption_error: Option<String>,
    pub signature: Option<String>,
    pub intended_recipients: Vec<String>,
    /// Id of the symmetric secret that decrypted the message, if any.
    pub symmetric_secret_id: Option<String>,
    pub from: Addr,
    pub recipients: Vec<Addr>,
    pub past_members: Vec<Addr>,
    pub headers: BTreeMap<String, String>,
    pub autocrypt: Option<KeyInfo>,
    pub gossip: Vec<KeyInfo>,
    pub text: String,
    pub is_reaction: bool,
    pub attachments: Vec<AttachmentOut>,
    pub mdn_for: Vec<String>,
    /// Multi-device sync message from another device of the same profile.
    pub is_sync: bool,
    /// Its `multi-device-sync.json`, see core src/sync.rs.
    pub sync_json: Option<String>,
}

fn key_info(addr: &str, key: &SignedPublicKey) -> KeyInfo {
    KeyInfo {
        addr: addr_normalize(addr),
        key: to_base64(key),
        fingerprint: public_fingerprint(key),
        relays: crate::keys::addresses_from_public_key(key),
        can_encrypt: crate::keys::pubkey_can_encrypt(key),
    }
}

fn is_protected(key: &str) -> bool {
    key.starts_with("chat-")
        || matches!(
            key,
            "return-path"
                | "auto-submitted"
                | "autocrypt-setup-message"
                | "date"
                | "from"
                | "sender"
                | "reply-to"
                | "to"
                | "cc"
                | "bcc"
                | "message-id"
                | "in-reply-to"
                | "references"
                | "secure-join"
        )
}

fn remove_secured_headers(headers: &mut BTreeMap<String, String>, encrypted: bool) {
    headers.remove("secure-join-fingerprint");
    headers.remove("chat-verified");
    headers.remove("autocrypt-gossip");
    // vc-request-pubkey is encrypted but deliberately unsigned and carries the auth code.
    if encrypted && headers.get("secure-join").map(String::as_str) == Some("vc-request-pubkey") {
        return;
    }
    headers.remove("secure-join-auth");
    if let Some(step) = headers.remove("secure-join")
        && (step == "vc-request" || step == "vg-request")
    {
        headers.insert("secure-join".into(), step);
    }
}

fn single_addrs(value: &str) -> Vec<Addr> {
    let mut out = Vec::new();
    if let Ok(list) = mailparse::addrparse(value) {
        for item in list.iter() {
            match item {
                mailparse::MailAddr::Single(s) => out.push(Addr {
                    name: s.display_name.clone().unwrap_or_default(),
                    addr: addr_normalize(&s.addr),
                }),
                mailparse::MailAddr::Group(g) => {
                    for s in &g.addrs {
                        out.push(Addr {
                            name: s.display_name.clone().unwrap_or_default(),
                            addr: addr_normalize(&s.addr),
                        });
                    }
                }
            }
        }
    }
    out
}

/// Merges `part`'s headers into `headers`, honouring RFC 9788 header protection.
fn merge_headers(headers: &mut BTreeMap<String, String>, part: &ParsedMail, protected: bool) {
    let has_hp = part.ctype.params.contains_key("hp");
    if has_hp {
        headers.clear();
    } else if protected {
        headers.retain(|k, _| !is_protected(k));
    }
    for field in &part.headers {
        let key = field.get_key().to_lowercase();
        if key == "autocrypt-gossip" || key == "autocrypt" || key.starts_with("hp-outer") {
            continue;
        }
        headers.insert(key, field.get_value());
    }
}

fn get_encrypted_part<'a, 'b>(mail: &'a ParsedMail<'b>) -> Option<&'a ParsedMail<'b>> {
    match (mail.ctype.mimetype.as_str(), &mail.subparts[..]) {
        ("multipart/encrypted", [first, second])
            if first.ctype.mimetype == "application/pgp-encrypted"
                && second.ctype.mimetype == "application/octet-stream" =>
        {
            Some(second)
        }
        ("multipart/mixed", [first, second, third])
            if first.ctype.mimetype == "text/plain"
                && second.ctype.mimetype == "application/pgp-encrypted"
                && third.ctype.mimetype == "application/octet-stream" =>
        {
            Some(third)
        }
        ("multipart/mixed", [first, second])
            if first.ctype.mimetype == "text/plain"
                && second.ctype.mimetype == "multipart/encrypted" =>
        {
            get_encrypted_part(second)
        }
        _ => None,
    }
}

struct Content {
    text: Option<String>,
    is_reaction: bool,
    attachments: Vec<AttachmentOut>,
    mdn_for: Vec<String>,
    is_sync: bool,
    sync_json: Option<String>,
}

fn collect_content(part: &ParsedMail, out: &mut Content, budget: &mut usize) -> Result<()> {
    let mimetype = part.ctype.mimetype.to_lowercase();
    if mimetype == "multipart/report" {
        if part.ctype.params.get("report-type").map(String::as_str) == Some("multi-device-sync") {
            out.is_sync = true;
            out.sync_json = part
                .subparts
                .iter()
                .find(|p| p.ctype.mimetype.eq_ignore_ascii_case("application/json"))
                .map(|p| p.get_body())
                .transpose()?;
            return Ok(());
        }
        if part.ctype.params.get("report-type").map(String::as_str)
            == Some("disposition-notification")
            && let Some(report) = part.subparts.get(1)
        {
            let body = report.get_body_raw()?;
            let (fields, _) = mailparse::parse_headers(&body)?;
            if let Some(mid) = fields.get_first_value("Original-Message-ID") {
                out.mdn_for.push(mid.trim().trim_matches(['<', '>']).to_string());
            }
            if let Some(more) = fields.get_first_value("Additional-Message-IDs") {
                out.mdn_for.extend(
                    more.split_whitespace()
                        .map(|m| m.trim_matches(['<', '>']).to_string()),
                );
            }
        }
        return Ok(());
    }
    if mimetype.starts_with("multipart/") {
        for sub in &part.subparts {
            collect_content(sub, out, budget)?;
        }
        return Ok(());
    }

    let disposition = part.get_content_disposition();
    let filename = disposition
        .params
        .get("filename")
        .or_else(|| part.ctype.params.get("name"))
        .cloned();
    let is_attachment =
        disposition.disposition == mailparse::DispositionType::Attachment || filename.is_some();

    if mimetype == "text/plain" && !is_attachment && out.text.is_none() {
        let body = part.get_body()?;
        let text = if part.ctype.params.get("format").map(String::as_str) == Some("flowed") {
            let delsp = part.ctype.params.get("delsp").map(String::as_str) == Some("yes");
            crate::format_flowed::unformat_flowed(&body, delsp)
        } else {
            body
        };
        if let mailparse::DispositionType::Extension(ext) = &disposition.disposition
            && ext.eq_ignore_ascii_case("reaction")
        {
            out.is_reaction = true;
        }
        out.text = Some(text.replace("\r\n", "\n"));
        return Ok(());
    }

    if is_attachment || !mimetype.starts_with("text/") {
        let data = part.get_body_raw()?;
        if data.len() > *budget {
            bail!("attachment too large");
        }
        *budget -= data.len();
        out.attachments.push(AttachmentOut {
            filename: filename.unwrap_or_else(|| "attachment".into()),
            mime: mimetype,
            size: data.len(),
            data_b64: base64::engine::general_purpose::STANDARD.encode(&data),
        });
    }
    Ok(())
}

/// Delta Chat inserts a "-- " footer with the sender's status; strip it like core does.
fn strip_footer(text: &str) -> String {
    if text.starts_with("-- \n") {
        return String::new();
    }
    match text.find("\n-- \n") {
        Some(idx) => text[..idx].to_string(),
        None => text.to_string(),
    }
}

pub fn parse(raw: &[u8], ctx: ParseContext) -> Result<ParsedMessage> {
    let mail = mailparse::parse_mail(raw)?;
    let self_secret: SignedSecretKey = secret_from_base64(&ctx.self_secret_key)?;
    let self_public: SignedPublicKey = public_from_base64(&ctx.self_public_key)?;
    let is_self = |a: &str| ctx.self_addrs.iter().any(|s| addr_cmp(s, a));

    let mut headers = BTreeMap::new();
    merge_headers(&mut headers, &mail, false);
    let mut from = mail
        .headers
        .get_first_value("From")
        .map(|v| single_addrs(&v))
        .and_then(|mut v| (!v.is_empty()).then(|| v.remove(0)))
        .context("no From in message")?;
    let from_is_self = is_self(&from.addr);

    let mut aheader_values = mail.headers.get_all_values("Autocrypt");

    let secrets: Vec<SymmetricSecret> = ctx
        .symmetric_secrets
        .into_iter()
        .map(|s| SymmetricSecret {
            id: s.id,
            secret: s.secret,
            expected_signer: s.expected_signer,
        })
        .collect();

    let mut decryption_error = None;
    let mut decrypted = None;
    if let Some(enc) = get_encrypted_part(&mail) {
        match crypto::decrypt(&enc.get_body_raw()?, &[self_secret], &secrets) {
            Ok(d) => decrypted = Some(d),
            Err(err) => decryption_error = Some(format!("{err:#}")),
        }
    }

    let inner_mail = match &decrypted {
        Some(d) => Some(mailparse::parse_mail(&d.plain)?),
        None => None,
    };
    if let Some(inner) = &inner_mail {
        let protected = inner.headers.get_all_values("Autocrypt");
        if !protected.is_empty() {
            aheader_values = protected;
        }
    }

    let mut autocrypt = None;
    if !from_is_self {
        for val in aheader_values.iter().rev() {
            if let Ok(h) = Aheader::from_str(val)
                && addr_cmp(&h.addr, &from.addr)
            {
                autocrypt = Some(h);
                break;
            }
        }
    }

    let mut keyring: Vec<SignedPublicKey> = if from_is_self {
        vec![self_public.clone()]
    } else {
        autocrypt.iter().map(|h| h.public_key.clone()).collect()
    };
    if let Some(d) = &decrypted {
        for fp in crypto::issuer_fingerprints(&d.message) {
            if let Some(k) = ctx.known_keys.get(&fp) {
                keyring.push(public_from_base64(k)?);
            }
        }
    }
    let signatures = decrypted
        .as_ref()
        .map(|d| crypto::valid_signature_fingerprints(&d.message, &keyring))
        .unwrap_or_default();

    let mut symmetric_secret_id = None;
    if let Some(Some((id, expected))) = decrypted.as_ref().map(|d| d.symmetric.clone()) {
        if let Some(expected) = expected {
            ensure!(
                signatures.len() == 1 && signatures.contains_key(&expected),
                "sender is not allowed to encrypt with this shared secret"
            );
        }
        symmetric_secret_id = Some(id);
    }

    let mut gossip = Vec::new();
    if let Some(inner) = &inner_mail {
        if !signatures.is_empty() {
            headers.remove("subject");
            headers.remove("list-id");
        }
        merge_headers(&mut headers, inner, true);
        if !signatures.is_empty() {
            for val in inner.headers.get_all_values("Autocrypt-Gossip") {
                if let Ok(h) = Aheader::from_str(&val) {
                    gossip.push(key_info(&h.addr, &h.public_key));
                }
            }
        }
        if let Some(inner_from) = inner
            .headers
            .get_first_value("From")
            .map(|v| single_addrs(&v))
            .and_then(|mut v| (!v.is_empty()).then(|| v.remove(0)))
        {
            if !addr_cmp(&inner_from.addr, &from.addr) && signatures.is_empty() {
                bail!("From header is forged");
            }
            from = inner_from;
        }
    }
    let encrypted = decrypted.is_some();
    if signatures.is_empty() {
        remove_secured_headers(&mut headers, encrypted);
    }

    let (signature, intended_recipients) = match signatures.into_iter().last() {
        Some((fp, rcpts)) => (Some(fp), rcpts),
        None => (None, vec![]),
    };

    let recipients = headers.get("to").map(|v| single_addrs(v)).unwrap_or_default();
    let past_members = headers
        .get("chat-group-past-members")
        .map(|v| single_addrs(v))
        .unwrap_or_default();

    let mut content = Content {
        text: None,
        is_reaction: false,
        attachments: vec![],
        mdn_for: vec![],
        is_sync: false,
        sync_json: None,
    };
    let mut budget = MAX_ATTACHMENT_BYTES;
    if let Some(inner) = &inner_mail {
        collect_content(inner, &mut content, &mut budget)?;
    } else if decryption_error.is_none() {
        collect_content(&mail, &mut content, &mut budget)?;
    }

    Ok(ParsedMessage {
        encrypted,
        decryption_error,
        signature,
        intended_recipients,
        symmetric_secret_id,
        from,
        recipients,
        past_members,
        headers,
        autocrypt: autocrypt.map(|h| key_info(&h.addr, &h.public_key)),
        gossip,
        text: strip_footer(&content.text.unwrap_or_default()),
        is_reaction: content.is_reaction,
        attachments: content.attachments,
        mdn_for: content.mdn_for,
        is_sync: content.is_sync,
        sync_json: content.sync_json,
    })
}
