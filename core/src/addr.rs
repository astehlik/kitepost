pub fn addr_normalize(addr: &str) -> String {
    let norm = addr.trim().to_lowercase();
    norm.strip_prefix("mailto:").map(str::to_string).unwrap_or(norm)
}

pub fn addr_cmp(a: &str, b: &str) -> bool {
    addr_normalize(a) == addr_normalize(b)
}

pub fn may_be_valid_addr(addr: &str) -> bool {
    let Some((local, domain)) = addr.rsplit_once('@') else {
        return false;
    };
    !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !addr.chars().any(|c| c.is_whitespace() || c.is_control() || "<>,;\"".contains(c))
}
