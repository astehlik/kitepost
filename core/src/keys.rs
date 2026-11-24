//! Key handling, ported from chatmail/core `src/key.rs` and `src/pgp.rs`.

use std::cmp::Ordering;
use std::io::Cursor;

use anyhow::{Context as _, Result, ensure};
use base64::Engine as _;
use pgp::composed::{
    Deserializable, EncryptionCaps, KeyType as PgpKeyType, SecretKeyParamsBuilder,
    SignedKeyDetails, SignedPublicKey, SignedPublicSubKey, SignedSecretKey, SubkeyParamsBuilder,
};
use pgp::crypto::aead::AeadAlgorithm;
use pgp::crypto::ecc_curve::ECCCurve;
use pgp::crypto::hash::HashAlgorithm;
use pgp::crypto::sym::SymmetricKeyAlgorithm;
use pgp::packet::{
    Features, KeyFlags, Notation, PacketTrait as _, Signature, SignatureConfig, SignatureType,
    Subpacket, SubpacketData,
};
use pgp::ser::Serialize;
use pgp::types::{CompressionAlgorithm, Imprint as _, KeyDetails, KeyVersion, SignedUser};
use rand_old::thread_rng;
use smallvec::smallvec;

pub const MAX_RELAYS: usize = 5;

pub fn fingerprint_hex(fp: &pgp::types::Fingerprint) -> String {
    hex::encode_upper(fp.as_bytes())
}

pub fn public_fingerprint(key: &SignedPublicKey) -> String {
    fingerprint_hex(&key.fingerprint())
}

pub fn to_base64<T: Serialize>(key: &T) -> String {
    let mut buf = Vec::new();
    key.to_writer(&mut buf).expect("writing to Vec cannot fail");
    base64::engine::general_purpose::STANDARD.encode(buf)
}

pub fn public_from_base64(data: &str) -> Result<SignedPublicKey> {
    let cleaned: String = data.split_whitespace().collect();
    let bytes = base64::engine::general_purpose::STANDARD.decode(cleaned.as_bytes())?;
    Ok(SignedPublicKey::from_bytes(Cursor::new(bytes))?)
}

pub fn secret_from_base64(data: &str) -> Result<SignedSecretKey> {
    let cleaned: String = data.split_whitespace().collect();
    let bytes = base64::engine::general_purpose::STANDARD.decode(cleaned.as_bytes())?;
    Ok(SignedSecretKey::from_bytes(Cursor::new(bytes))?)
}

pub fn normalize_fingerprint(input: &str) -> Result<String> {
    let hex_repr: String = input
        .to_uppercase()
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .collect();
    ensure!(
        hex_repr.len() == 40 || hex_repr.len() == 64,
        "wrong fingerprint length"
    );
    Ok(hex_repr)
}

pub fn create_keypair(addr: &str) -> Result<SignedSecretKey> {
    let key_params = SecretKeyParamsBuilder::default()
        .key_type(PgpKeyType::Ed25519Legacy)
        .can_certify(true)
        .can_sign(true)
        .feature_seipd_v2(true)
        .primary_user_id(format!("<{addr}>"))
        .passphrase(None)
        .preferred_symmetric_algorithms(smallvec![
            SymmetricKeyAlgorithm::AES256,
            SymmetricKeyAlgorithm::AES192,
            SymmetricKeyAlgorithm::AES128,
        ])
        .preferred_hash_algorithms(smallvec![
            HashAlgorithm::Sha256,
            HashAlgorithm::Sha384,
            HashAlgorithm::Sha512,
            HashAlgorithm::Sha224,
        ])
        .preferred_compression_algorithms(smallvec![
            CompressionAlgorithm::ZLIB,
            CompressionAlgorithm::ZIP,
        ])
        .subkey(
            SubkeyParamsBuilder::default()
                .key_type(PgpKeyType::ECDH(ECCCurve::Curve25519Legacy))
                .can_encrypt(EncryptionCaps::All)
                .passphrase(None)
                .build()
                .context("failed to build subkey parameters")?,
        )
        .build()
        .context("failed to build key parameters")?;

    let secret_key = key_params
        .generate(thread_rng())
        .context("failed to generate the key")?;
    secret_key
        .verify_bindings()
        .context("invalid secret key generated")?;
    Ok(secret_key)
}

/// Builds the public key exactly like core does: a User ID for V4 compatibility and
/// a direct key signature carrying the `relays@chatmail.at` notation.
pub fn secret_key_to_public_key(
    mut signed_secret_key: SignedSecretKey,
    timestamp: u32,
    addr: &str,
    relay_addrs: &str,
) -> Result<SignedPublicKey> {
    let timestamp = std::cmp::max(
        signed_secret_key.primary_key.created_at(),
        pgp::types::Timestamp::from_secs(timestamp),
    );

    let common_subpackets = || -> Result<Vec<Subpacket>> {
        let mut keyflags = KeyFlags::default();
        keyflags.set_certify(true);
        keyflags.set_sign(true);
        let mut features = Features::default();
        features.set_seipd_v1(true);
        features.set_seipd_v2(true);

        Ok(vec![
            Subpacket::regular(SubpacketData::SignatureCreationTime(timestamp))?,
            Subpacket::regular(SubpacketData::IssuerFingerprint(
                signed_secret_key.fingerprint(),
            ))?,
            Subpacket::regular(SubpacketData::KeyFlags(keyflags))?,
            Subpacket::regular(SubpacketData::Features(features))?,
            Subpacket::regular(SubpacketData::PreferredSymmetricAlgorithms(smallvec![
                SymmetricKeyAlgorithm::AES256,
                SymmetricKeyAlgorithm::AES192,
                SymmetricKeyAlgorithm::AES128
            ]))?,
            Subpacket::regular(SubpacketData::PreferredHashAlgorithms(smallvec![
                HashAlgorithm::Sha256,
                HashAlgorithm::Sha384,
                HashAlgorithm::Sha512,
                HashAlgorithm::Sha224,
            ]))?,
            Subpacket::regular(SubpacketData::PreferredCompressionAlgorithms(smallvec![
                CompressionAlgorithm::ZLIB,
                CompressionAlgorithm::ZIP,
            ]))?,
            Subpacket::regular(SubpacketData::PreferredAeadAlgorithms(smallvec![(
                SymmetricKeyAlgorithm::AES256,
                AeadAlgorithm::Ocb
            )]))?,
            Subpacket::regular(SubpacketData::IsPrimary(true))?,
        ])
    };

    let users = if signed_secret_key.version() == KeyVersion::V4 {
        let mut config = SignatureConfig::from_key(
            thread_rng(),
            &signed_secret_key.primary_key,
            SignatureType::CertPositive,
        )?;
        config.hashed_subpackets = common_subpackets()?;
        config.unhashed_subpackets = vec![Subpacket::regular(SubpacketData::IssuerKeyId(
            signed_secret_key.legacy_key_id(),
        ))?];
        let user_id_packet = pgp::packet::UserId::from_str(
            pgp::types::PacketHeaderVersion::New,
            &format!("<{addr}>"),
        )?;
        let signature = config.sign_certification(
            &signed_secret_key.primary_key,
            &signed_secret_key.primary_key.public_key(),
            &pgp::types::Password::empty(),
            user_id_packet.tag(),
            &user_id_packet,
        )?;
        vec![user_id_packet.into_signed(signature)]
    } else {
        vec![]
    };

    let mut dks_config = SignatureConfig::from_key(
        thread_rng(),
        &signed_secret_key.primary_key,
        SignatureType::Key,
    )?;
    dks_config.hashed_subpackets = common_subpackets()?;
    dks_config
        .hashed_subpackets
        .push(Subpacket::regular(SubpacketData::Notation(Notation {
            readable: true,
            name: "relays@chatmail.at".into(),
            value: relay_addrs.to_string().into(),
        }))?);
    let direct_key_signature = dks_config.sign_key(
        &signed_secret_key.primary_key,
        &pgp::types::Password::empty(),
        signed_secret_key.primary_key.public_key(),
    )?;

    signed_secret_key.details = SignedKeyDetails {
        revocation_signatures: vec![],
        direct_signatures: vec![direct_key_signature],
        users,
        user_attributes: vec![],
    };
    Ok(signed_secret_key.to_public_key())
}

pub fn addresses_from_public_key(public_key: &SignedPublicKey) -> Option<Vec<String>> {
    for signature in &public_key.details.direct_signatures {
        if signature.verify_key(&public_key.primary_key).is_err() {
            continue;
        }
        for notation in signature.notations() {
            if notation.name == "relays@chatmail.at"
                && let Ok(value) = std::str::from_utf8(&notation.value)
            {
                return Some(
                    value
                        .split(',')
                        .map(|s| s.trim().to_lowercase())
                        .filter(|s| crate::addr::may_be_valid_addr(s))
                        .take(MAX_RELAYS)
                        .collect(),
                );
            }
        }
    }
    None
}

/// Selects the encryption subkey following draft-autocrypt-openpgp-v2-cert section 4.3.
pub fn select_pk_for_encryption(now: u32, key: &SignedPublicKey) -> Option<&SignedPublicSubKey> {
    let expiry = |sig: &pgp::packet::Signature| {
        sig.key_expiration_time().filter(|d| d.as_secs() != 0)
    };
    key.public_subkeys
        .iter()
        .filter(|subkey| subkey.algorithm().can_encrypt())
        .filter_map(|subkey| {
            let signature = subkey.signatures.first()?;
            if !signature.key_flags().encrypt_comms() {
                return None;
            }
            if let Some(exp) = expiry(signature)
                && now > subkey.created_at().as_secs().saturating_add(exp.as_secs())
            {
                return None;
            }
            Some((subkey, signature))
        })
        .min_by(|(k1, s1), (k2, s2)| match (expiry(s1), expiry(s2)) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(e1), Some(e2)) => (k1.created_at().as_secs().saturating_add(e1.as_secs()))
                .cmp(&(k2.created_at().as_secs().saturating_add(e2.as_secs()))),
        })
        .map(|(subkey, _)| subkey)
}

pub fn pubkey_can_encrypt(key: &SignedPublicKey) -> bool {
    select_pk_for_encryption(pgp::types::Timestamp::now().as_secs(), key).is_some()
}

pub fn pubkey_supports_seipdv2(key: &SignedPublicKey) -> bool {
    key.details
        .direct_signatures
        .iter()
        .chain(key.details.users.iter().flat_map(|u| u.signatures.iter()))
        .any(|sig| sig.features().is_some_and(|f| f.seipd_v2()))
}

/// Like core's merge_openpgp_certificates(): keeps the newest direct key signature, which carries
/// the relay list, and the newest User ID; the subkeys stay the old ones. A key may come from
/// gossip or an old message, so it is not necessarily newer. Ties go to `new`.
pub fn merge_public_keys(old: SignedPublicKey, new: SignedPublicKey) -> Result<SignedPublicKey> {
    old.verify_bindings().context("First key cannot be verified")?;
    new.verify_bindings().context("Second key cannot be verified")?;
    let SignedPublicKey { primary_key, details: old_details, public_subkeys } = old;
    let SignedPublicKey { primary_key: new_primary_key, details: new_details, .. } = new;
    ensure!(
        primary_key.imprint::<sha2::Sha256>()? == new_primary_key.imprint::<sha2::Sha256>()?,
        "Cannot merge keys with different primary keys"
    );
    let direct_signatures: Vec<Signature> = old_details
        .direct_signatures
        .into_iter()
        .chain(new_details.direct_signatures)
        .filter(|s| s.verify_key(&primary_key).is_ok())
        .max_by_key(|s| s.created())
        .into_iter()
        .collect();
    let users: Vec<SignedUser> = old_details
        .users
        .into_iter()
        .chain(new_details.users)
        .filter_map(|SignedUser { id, signatures }| {
            signatures
                .into_iter()
                .filter(|s| s.verify_certification(&primary_key, pgp::types::Tag::UserId, &id).is_ok())
                .max_by_key(|s| s.created())
                .map(|s| (id, s))
        })
        .max_by_key(|(_, s)| s.created())
        .map(|(id, s)| SignedUser { id, signatures: vec![s] })
        .into_iter()
        .collect();
    Ok(SignedPublicKey {
        primary_key,
        details: SignedKeyDetails {
            revocation_signatures: vec![],
            direct_signatures,
            users,
            user_attributes: vec![],
        },
        public_subkeys,
    })
}
