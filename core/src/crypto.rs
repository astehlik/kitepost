//! OpenPGP message operations, ported from chatmail/core `src/pgp.rs` and `src/decrypt.rs`.

use std::collections::HashMap;
use std::io::Cursor;

use anyhow::{Context as _, Result, bail};
use pgp::composed::{
    DecryptionOptions, Esk, Message, MessageBuilder, PlainSessionKey, SignedPublicKey,
    SignedSecretKey, SubpacketConfig, TheRing, decrypt_session_key_with_password,
};
use pgp::crypto::aead::{AeadAlgorithm, ChunkSize};
use pgp::crypto::hash::HashAlgorithm;
use pgp::crypto::sym::SymmetricKeyAlgorithm;
use pgp::packet::{Subpacket, SubpacketData};
use pgp::types::{
    CompressionAlgorithm, KeyDetails, KeyVersion, Password, Seipdv1ReadMode, SigningKey as _,
    StringToKey,
};
use rand_old::{Rng as _, thread_rng};

use crate::keys::{fingerprint_hex, pubkey_supports_seipdv2, select_pk_for_encryption};

const SYMMETRIC_KEY_ALGORITHM: SymmetricKeyAlgorithm = SymmetricKeyAlgorithm::AES128;

fn signature_subpackets(
    now: pgp::types::Timestamp,
    signer: &SignedSecretKey,
    recipients: &[SignedPublicKey],
) -> Result<SubpacketConfig> {
    let mut hashed = vec![Subpacket::critical(SubpacketData::SignatureCreationTime(now))?];
    for key in recipients {
        let data = SubpacketData::IntendedRecipientFingerprint(key.fingerprint());
        hashed.push(if signer.version() < KeyVersion::V6 {
            Subpacket::regular(data)?
        } else {
            Subpacket::critical(data)?
        });
    }
    hashed.push(Subpacket::regular(SubpacketData::IssuerFingerprint(
        signer.fingerprint(),
    ))?);
    let mut unhashed = vec![];
    if signer.version() <= KeyVersion::V4 {
        unhashed.push(Subpacket::regular(SubpacketData::IssuerKeyId(
            signer.legacy_key_id(),
        ))?);
    }
    Ok(SubpacketConfig::UserDefined { hashed, unhashed })
}

/// Encrypts to `recipients` (which must include our own key) and signs with `signer`.
pub fn pk_encrypt(
    plain: Vec<u8>,
    recipients: Vec<SignedPublicKey>,
    signer: Option<&SignedSecretKey>,
    compress: bool,
) -> Result<String> {
    let mut rng = thread_rng();
    let now = pgp::types::Timestamp::now();
    let use_v2 = recipients.iter().all(pubkey_supports_seipdv2);
    let pkeys: Vec<_> = recipients
        .iter()
        .filter_map(|key| select_pk_for_encryption(now.as_secs(), key))
        .collect();
    if pkeys.len() != recipients.len() {
        bail!("a recipient key cannot be used for encryption");
    }

    let msg = MessageBuilder::from_bytes("", plain);
    let armored = if use_v2 {
        let mut msg = msg.seipd_v2(
            &mut rng,
            SYMMETRIC_KEY_ALGORITHM,
            AeadAlgorithm::Ocb,
            ChunkSize::C8KiB,
        );
        for pkey in &pkeys {
            msg.encrypt_to_key_anonymous(&mut rng, pkey)?;
        }
        if let Some(sk) = signer {
            let subpkts = signature_subpackets(now, sk, &recipients)?;
            msg.sign_with_subpackets(&**sk, Password::empty(), sk.hash_alg(), subpkts);
        }
        if compress {
            msg.compression(CompressionAlgorithm::ZLIB);
        }
        msg.to_armored_string(&mut rng, Default::default())?
    } else {
        let mut msg = msg.seipd_v1(&mut rng, SYMMETRIC_KEY_ALGORITHM);
        for pkey in &pkeys {
            msg.encrypt_to_key_anonymous(&mut rng, pkey)?;
        }
        if let Some(sk) = signer {
            let subpkts = signature_subpackets(now, sk, &recipients)?;
            msg.sign_with_subpackets(&**sk, Password::empty(), sk.hash_alg(), subpkts);
        }
        if compress {
            msg.compression(CompressionAlgorithm::ZLIB);
        }
        msg.to_armored_string(&mut rng, Default::default())?
    };
    Ok(armored)
}

pub fn symm_encrypt(
    plain: Vec<u8>,
    signer: Option<&SignedSecretKey>,
    shared_secret: &str,
    compress: bool,
) -> Result<String> {
    let mut rng = thread_rng();
    let mut salt = [0u8; 8];
    rng.fill(&mut salt[..]);
    let s2k = StringToKey::Salted {
        hash_alg: HashAlgorithm::default(),
        salt,
    };
    let mut msg = MessageBuilder::from_bytes("", plain).seipd_v2(
        &mut rng,
        SYMMETRIC_KEY_ALGORITHM,
        AeadAlgorithm::Ocb,
        ChunkSize::C8KiB,
    );
    msg.encrypt_with_password(&mut rng, s2k, &Password::from(shared_secret.to_string()))?;
    if let Some(sk) = signer {
        msg.sign(&**sk, Password::empty(), sk.hash_alg());
    }
    if compress {
        msg.compression(CompressionAlgorithm::ZLIB);
    }
    Ok(msg.to_armored_string(&mut rng, Default::default())?)
}

pub struct SymmetricSecret {
    pub id: String,
    pub secret: String,
    /// The only fingerprint allowed to sign messages encrypted with this secret.
    pub expected_signer: Option<String>,
}

pub struct Decrypted {
    pub message: Message<'static>,
    pub plain: Vec<u8>,
    pub symmetric: Option<(String, Option<String>)>,
}

pub fn decrypt(
    armored: &[u8],
    secret_keys: &[SignedSecretKey],
    secrets: &[SymmetricSecret],
) -> Result<Decrypted> {
    let (msg, _headers) = Message::from_armor(Cursor::new(armored.to_vec()))?;
    let decrypt_options =
        DecryptionOptions::new().set_seipdv1_read_mode(Seipdv1ReadMode::Streaming);

    let mut symmetric = None;
    let ring = if let Message::Encrypted { esk, .. } = &msg
        && let [Esk::SymKeyEncryptedSessionKey(esk)] = &esk[..]
    {
        // Only cheap S2K is accepted; anything else could be used to DoS us.
        if !matches!(esk.s2k(), Some(StringToKey::Salted { .. })) {
            bail!("unsupported string2key algorithm");
        }
        let mut found: Option<PlainSessionKey> = None;
        for s in secrets {
            if let Ok(psk) =
                decrypt_session_key_with_password(esk, &Password::from(s.secret.clone()))
            {
                symmetric = Some((s.id.clone(), s.expected_signer.clone()));
                found = Some(psk);
                break;
            }
        }
        let psk = found.context("could not find symmetric secret for session key")?;
        TheRing {
            session_keys: vec![psk],
            decrypt_options,
            ..Default::default()
        }
    } else {
        TheRing {
            secret_keys: secret_keys.iter().collect(),
            decrypt_options,
            ..Default::default()
        }
    };

    let (plain, _) = msg.decrypt_the_ring(ring, true).context("decrypt_the_ring")?;
    let mut plain: Message<'static> = plain.decompress()?;
    let data = plain.as_data_vec()?;
    Ok(Decrypted {
        message: plain,
        plain: data,
        symmetric,
    })
}

pub fn issuer_fingerprints(msg: &Message) -> Vec<String> {
    match msg {
        Message::Signed { reader, .. } => reader
            .signature(0)
            .map(|sig| sig.issuer_fingerprint().into_iter().map(fingerprint_hex).collect())
            .unwrap_or_default(),
        _ => vec![],
    }
}

/// Returns signer fingerprint -> intended recipient fingerprints for every valid signature.
pub fn valid_signature_fingerprints(
    msg: &Message,
    keyring: &[SignedPublicKey],
) -> HashMap<String, Vec<String>> {
    let mut ret = HashMap::new();
    if msg.is_signed() {
        for pkey in keyring {
            if let Ok(signature) = msg.verify(&pkey.primary_key) {
                let mut recipient_fps = Vec::new();
                if let Some(cfg) = signature.config() {
                    for subpkt in &cfg.hashed_subpackets {
                        if let SubpacketData::IntendedRecipientFingerprint(fp) = &subpkt.data {
                            recipient_fps.push(fingerprint_hex(fp));
                        }
                    }
                }
                ret.insert(fingerprint_hex(&pkey.fingerprint()), recipient_fps);
            }
        }
    }
    ret
}
