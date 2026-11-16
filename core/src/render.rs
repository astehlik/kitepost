//! Outgoing message rendering, ported from chatmail/core `src/mimefactory.rs`.

use anyhow::{Context as _, Result, bail};
use base64::Engine as _;
use mail_builder::headers::HeaderType;
use mail_builder::headers::address::Address;
use mail_builder::headers::message_id::MessageId;
use mail_builder::headers::raw::Raw;
use mail_builder::headers::text::Text;
use mail_builder::mime::MimePart;
use pgp::composed::{SignedPublicKey, SignedSecretKey};
use serde::{Deserialize, Serialize};

use crate::aheader::Aheader;
use crate::keys::{public_from_base64, secret_from_base64};

#[derive(Deserialize)]
pub struct NamedAddr {
    #[serde(default)]
    pub name: String,
    pub addr: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HeaderKind {
    Raw,
    Text,
    MessageId,
    Address,
}

#[derive(Deserialize)]
pub struct HeaderSpec {
    pub name: String,
    pub value: String,
    pub kind: HeaderKind,
}

#[derive(Deserialize)]
pub struct Gossip {
    pub addr: String,
    pub key: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Encryption {
    None,
    Asymmetric { keys: Vec<String> },
    Symmetric { secret: String },
}

#[derive(Deserialize)]
pub struct Attachment {
    pub filename: String,
    pub mime: String,
    pub data_b64: String,
}

#[derive(Deserialize)]
pub struct OutgoingMessage {
    pub rfc724_mid: String,
    pub from_addr: String,
    #[serde(default)]
    pub from_name: String,
    pub self_secret_key: String,
    pub self_public_key: String,
    /// Empty means "hidden-recipients".
    #[serde(default)]
    pub to: Vec<NamedAddr>,
    pub subject: String,
    pub text: String,
    /// Text of the replied-to message, sent as `> ` lines before `text` like core's mimefactory.
    #[serde(default)]
    pub quote: Option<String>,
    #[serde(default)]
    pub content_disposition: Option<String>,
    #[serde(default)]
    pub headers: Vec<HeaderSpec>,
    #[serde(default)]
    pub gossip: Vec<Gossip>,
    pub encryption: Encryption,
    pub attach_pubkey: bool,
    pub sign: bool,
    pub compress: bool,
    #[serde(default)]
    pub wrap_multipart_mixed: bool,
    #[serde(default)]
    pub attachment: Option<Attachment>,
    /// Renders a read receipt for these Message-IDs instead of `text`, like core's `mdn_body`.
    #[serde(default)]
    pub mdn_for: Vec<String>,
    /// Renders a multi-device sync message with this `multi-device-sync.json`, like core's sync.rs.
    #[serde(default)]
    pub sync_json: Option<String>,
    pub timestamp: i64,
}

#[derive(Serialize)]
pub struct RenderedEmail {
    pub raw: String,
    pub rfc724_mid: String,
}

fn rfc2822(ts: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(ts, 0)
        .unwrap_or_default()
        .to_rfc2822()
}

fn new_address_with_name(name: &str, address: String) -> Address<'static> {
    Address::new_address(
        if name.is_empty() { None } else { Some(name.to_string()) },
        address,
    )
}

fn hidden_recipients() -> Address<'static> {
    Address::new_group(Some("hidden-recipients".to_string()), Vec::new())
}

fn part_to_bytes(message: MimePart<'static>) -> Vec<u8> {
    let mut raw = Vec::new();
    message.write_part(&mut raw);
    raw
}

fn wrap_encrypted_part(encrypted: String) -> MimePart<'static> {
    MimePart::new(
        "multipart/encrypted; protocol=\"application/pgp-encrypted\"",
        vec![
            MimePart::new("application/pgp-encrypted", "Version: 1\r\n"),
            MimePart::new("application/octet-stream", encrypted),
        ],
    )
}

fn header_value(spec: &HeaderSpec) -> HeaderType<'static> {
    match spec.kind {
        HeaderKind::Raw => Raw::new(spec.value.clone()).into(),
        HeaderKind::Text => Text::new(spec.value.clone()).into(),
        HeaderKind::MessageId => {
            MessageId::<'static>::new_list(spec.value.split_whitespace().map(str::to_string))
                .into()
        }
        HeaderKind::Address => Address::new_list(
            spec.value
                .split(',')
                .map(str::trim)
                .filter(|a| !a.is_empty())
                .map(|a| Address::new_address(None::<String>, a.to_string()))
                .collect(),
        )
        .into(),
    }
}

fn is_header_safe(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !matches!(
            name.to_ascii_lowercase().as_str(),
            "from" | "message-id" | "autocrypt" | "content-type" | "mime-version"
        )
}

fn mdn_body(mid: &str, additional: &[String]) -> MimePart<'static> {
    let mut fields = format!(
        "Original-Message-ID: <{mid}>\r\nDisposition: manual-action/MDN-sent-automatically; displayed\r\n"
    );
    if !additional.is_empty() {
        let ids: Vec<String> = additional.iter().map(|m| format!("<{m}>")).collect();
        fields += &format!("Additional-Message-IDs: {}\r\n", ids.join(" "));
    }
    MimePart::new(
        "multipart/report; report-type=disposition-notification",
        vec![
            MimePart::new("text/plain", "This is a receipt notification."),
            MimePart::new("message/disposition-notification", fields),
        ],
    )
}

fn body_text(req: &OutgoingMessage) -> String {
    match &req.quote {
        Some(quote) => {
            let lines: String = quote.split('\n').map(|line| format!("> {line}\n")).collect();
            format!("{lines}\n{}", req.text)
        }
        // Like core: an empty first line keeps the receiver from taking the text for a quote.
        None if req.text.starts_with('>') => format!("\n{}", req.text),
        None => req.text.clone(),
    }
}

pub fn render(req: OutgoingMessage) -> Result<RenderedEmail> {
    let public_key: SignedPublicKey = public_from_base64(&req.self_public_key)?;
    let secret_key: SignedSecretKey = secret_from_base64(&req.self_secret_key)?;
    let is_encrypted = !matches!(req.encryption, Encryption::None);

    let mut headers: Vec<(String, HeaderType<'static>)> = Vec::new();
    let to: Vec<Address<'static>> = if req.to.is_empty() {
        vec![hidden_recipients()]
    } else {
        req.to
            .iter()
            .map(|a| new_address_with_name(&a.name, a.addr.clone()))
            .collect()
    };
    headers.push(("Date".into(), Raw::new(rfc2822(req.timestamp)).into()));
    headers.push(("To".into(), Address::new_list(to).into()));
    headers.push(("Subject".into(), Text::new(req.subject.clone()).into()));
    for spec in &req.headers {
        if !is_header_safe(&spec.name) || spec.value.contains(['\r', '\n']) {
            bail!("invalid header {:?}", spec.name);
        }
        headers.push((spec.name.clone(), header_value(spec)));
    }
    for g in &req.gossip {
        let header = Aheader {
            addr: g.addr.clone(),
            public_key: public_from_base64(&g.key)?,
            prefer_encrypt_mutual: false,
        };
        headers.push(("Autocrypt-Gossip".into(), Raw::new(header.to_string()).into()));
    }

    let mut main_part = match (req.mdn_for.split_first(), &req.sync_json) {
        (Some((first, rest)), _) => mdn_body(first, rest),
        (None, Some(json)) => MimePart::new(
            "multipart/report; report-type=multi-device-sync",
            vec![
                MimePart::new("text/plain", body_text(&req)),
                MimePart::new("application/json", json.clone()).attachment("multi-device-sync.json"),
            ],
        ),
        (None, None) => MimePart::new("text/plain", body_text(&req)),
    };
    if let Some(disposition) = &req.content_disposition {
        main_part = main_part.header("Content-Disposition", Raw::new(disposition.clone()));
    }
    let mut message = match &req.attachment {
        Some(att) => {
            let data = base64::engine::general_purpose::STANDARD
                .decode(&att.data_b64)
                .context("attachment is not valid base64")?;
            let file = MimePart::new(att.mime.clone(), data).attachment(att.filename.clone());
            MimePart::new("multipart/mixed", vec![main_part, file])
        }
        None => main_part,
    };
    if req.wrap_multipart_mixed && req.attachment.is_none() {
        message = MimePart::new("multipart/mixed", vec![message]);
    }

    for (name, value) in headers {
        message = message.header(name, value);
    }
    if is_encrypted {
        for (h, v) in &mut message.headers {
            if h == "Content-Type"
                && let HeaderType::ContentType(ct) = v
            {
                *ct = ct
                    .clone()
                    .attribute("protected-headers", "v1")
                    .attribute("hp", "cipher");
                break;
            }
        }
    }
    let raw_message = part_to_bytes(message);

    render_queued_mail(
        raw_message,
        &req.rfc724_mid,
        if is_encrypted { &req.from_name } else { "" },
        &req.from_addr,
        req.encryption,
        req.attach_pubkey,
        req.sign,
        req.compress,
        &public_key,
        &secret_key,
        req.timestamp,
    )
}

#[allow(clippy::too_many_arguments)]
fn render_queued_mail(
    raw_message: Vec<u8>,
    rfc724_mid: &str,
    display_name: &str,
    from_addr: &str,
    encryption: Encryption,
    attach_pubkey: bool,
    sign: bool,
    compress: bool,
    public_key: &SignedPublicKey,
    secret_key: &SignedSecretKey,
    now: i64,
) -> Result<RenderedEmail> {

    let mut inner: Vec<u8> = Vec::new();
    let mut outer: Vec<u8> = Vec::new();
    let is_encrypted = !matches!(encryption, Encryption::None);

    fn add_header(name: &[u8], value: &impl mail_builder::headers::Header, out: &mut Vec<u8>) {
        out.extend(name);
        value.write_header(&mut *out, name.len());
    }

    let from_header = new_address_with_name(display_name, from_addr.to_string());
    add_header(b"From: ", &from_header, &mut inner);
    if is_encrypted {
        let unencrypted_from = Address::new_address(None::<&'static str>, from_addr.to_string());
        add_header(b"From: ", &unencrypted_from, &mut outer);
        add_header(b"HP-Outer: From: ", &unencrypted_from, &mut inner);

        // Randomised outer date within 6 days, as in core, to not leak the send time.
        let offset: i64 = rand_old::Rng::gen_range(&mut rand_old::thread_rng(), 0..518_400);
        let date = rfc2822(now.saturating_sub(offset));
        outer.extend(format!("Date: {date}\r\n").as_bytes());
        inner.extend(format!("HP-Outer: Date: {date}\r\n").as_bytes());
    } else {
        add_header(b"From: ", &from_header, &mut outer);
    }

    let mid = format!("Message-ID: <{rfc724_mid}>\r\n");
    inner.extend(mid.as_bytes());
    outer.extend(mid.as_bytes());
    if is_encrypted {
        inner.extend(format!("HP-Outer: {mid}").as_bytes());
    }
    outer.extend(b"MIME-Version: 1.0\r\n");

    if attach_pubkey {
        let aheader = Aheader {
            addr: from_addr.to_string(),
            public_key: public_key.clone(),
            prefer_encrypt_mutual: true,
        };
        add_header(
            b"Autocrypt: ",
            &Raw::new(aheader.to_string()),
            if is_encrypted { &mut inner } else { &mut outer },
        );
    }

    if is_encrypted {
        let (parsed, _) = mailparse::parse_headers(&raw_message)?;
        for h in parsed {
            let name = h.get_key();
            let value: &[u8] = match name.to_lowercase().as_str() {
                "subject" => b"[...]",
                "to" => b"\"hidden-recipients\": ;",
                _ => continue,
            };
            let line = [name.as_bytes(), b": ", value, b"\r\n"].concat();
            outer.extend(&line);
            inner.extend(b"HP-Outer: ");
            inner.extend(&line);
        }
    }

    let sign_key = sign.then_some(secret_key);
    let body = match encryption {
        Encryption::None => raw_message,
        Encryption::Asymmetric { keys } => {
            let mut full = inner;
            full.extend(raw_message);
            let mut keyring = vec![public_key.clone()];
            for k in keys {
                keyring.push(public_from_base64(&k)?);
            }
            let encrypted = crate::crypto::pk_encrypt(full, keyring, sign_key, compress)?;
            part_to_bytes(wrap_encrypted_part(encrypted))
        }
        Encryption::Symmetric { secret } => {
            let mut full = inner;
            full.extend(raw_message);
            let encrypted = crate::crypto::symm_encrypt(full, sign_key, &secret, compress)?;
            part_to_bytes(wrap_encrypted_part(encrypted))
        }
    };

    let mut full_message = outer;
    full_message.extend(body);
    Ok(RenderedEmail {
        raw: String::from_utf8_lossy(&full_message).to_string(),
        rfc724_mid: rfc724_mid.to_string(),
    })
}
