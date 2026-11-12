//! Autocrypt header, ported from chatmail/core `src/aheader.rs`.

use std::collections::BTreeMap;
use std::fmt;

use anyhow::{Context as _, Result, bail};
use pgp::composed::SignedPublicKey;

use crate::keys::{public_from_base64, to_base64};

pub struct Aheader {
    pub addr: String,
    pub public_key: SignedPublicKey,
    pub prefer_encrypt_mutual: bool,
}

impl fmt::Display for Aheader {
    fn fmt(&self, fmt: &mut fmt::Formatter) -> fmt::Result {
        write!(fmt, "addr={};", self.addr.to_lowercase())?;
        if self.prefer_encrypt_mutual {
            write!(fmt, " prefer-encrypt=mutual;")?;
        }
        let keydata = to_base64(&self.public_key).chars().enumerate().fold(
            String::new(),
            |mut res, (i, c)| {
                if i % 78 == 78 - "keydata=".len() {
                    res.push(' ')
                }
                res.push(c);
                res
            },
        );
        write!(fmt, " keydata={keydata}")
    }
}

impl Aheader {
    pub fn from_str(s: &str) -> Result<Self> {
        let mut attributes: BTreeMap<String, String> = s
            .split(';')
            .filter_map(|a| {
                let (k, v) = a.trim().split_once('=')?;
                Some((k.trim().to_string(), v.trim().to_string()))
            })
            .collect();
        let addr = attributes.remove("addr").context("Autocrypt header has no addr")?;
        let public_key = attributes
            .remove("keydata")
            .context("keydata attribute is not found")
            .and_then(|raw| public_from_base64(&raw).context("Autocrypt key cannot be decoded"))?;
        public_key
            .verify_bindings()
            .context("Autocrypt key cannot be verified")?;
        let prefer_encrypt_mutual = attributes.remove("prefer-encrypt").as_deref() == Some("mutual");
        if attributes.keys().any(|k| !k.starts_with('_')) {
            bail!("Unknown Autocrypt attribute found");
        }
        Ok(Aheader { addr, public_key, prefer_encrypt_mutual })
    }
}
