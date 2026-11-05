use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;

pub fn hash(plain: &str) -> anyhow::Result<String> {
    // 16 字节随机盐，省掉 rand_core/getrandom 依赖
    let salt = SaltString::encode_b64(uuid::Uuid::new_v4().as_bytes())
        .map_err(|e| anyhow::anyhow!("salt: {e}"))?;
    Ok(Argon2::default()
        .hash_password(plain.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("hash password: {e}"))?
        .to_string())
}

pub fn verify(plain: &str, hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(plain.as_bytes(), &parsed)
        .is_ok()
}

/// 32 字节十六进制，够长且无需额外依赖。
pub fn random_password() -> String {
    let mut out = String::with_capacity(32);
    for _ in 0..2 {
        out.push_str(&uuid::Uuid::new_v4().simple().to_string());
    }
    out.truncate(24);
    out
}

pub fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(input.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_and_verify() {
        let h = hash("s3cret").unwrap();
        assert!(verify("s3cret", &h));
        assert!(!verify("wrong", &h));
        assert!(!verify("s3cret", "not-a-hash"));
    }

    #[test]
    fn token_hash_is_stable() {
        assert_eq!(sha256_hex("abc").len(), 64);
        assert_eq!(sha256_hex("abc"), sha256_hex("abc"));
    }
}
