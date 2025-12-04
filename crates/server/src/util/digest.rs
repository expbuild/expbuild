use anyhow::Result;
use re_grpc_proto::build::bazel::remote::execution::v2::Digest;
use sha2::{Digest as _, Sha256};

pub fn compute_digest(data: &[u8]) -> Digest {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let hash = hex::encode(hasher.finalize());
    
    Digest {
        hash,
        size_bytes: data.len() as i64,
    }
}

pub fn verify_digest(data: &[u8], digest: &Digest) -> Result<()> {
    let computed = compute_digest(data);
    
    if computed.hash != digest.hash {
        anyhow::bail!(
            "Digest hash mismatch: expected {}, got {}",
            digest.hash,
            computed.hash
        );
    }
    
    if computed.size_bytes != digest.size_bytes {
        anyhow::bail!(
            "Digest size mismatch: expected {}, got {}",
            digest.size_bytes,
            computed.size_bytes
        );
    }
    
    Ok(())
}

pub fn format_digest(digest: &Digest) -> String {
    format!("{}:{}", digest.hash, digest.size_bytes)
}

pub fn parse_digest(s: &str) -> Result<Digest> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 2 {
        anyhow::bail!("Invalid digest format. Expected hash:size");
    }
    
    let hash = parts[0].to_string();
    let size_bytes = parts[1].parse::<i64>()?;
    
    Ok(Digest { hash, size_bytes })
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_compute_digest() {
        let data = b"hello world";
        let digest = compute_digest(data);
        
        assert_eq!(digest.size_bytes, 11);
        assert_eq!(
            digest.hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }
    
    #[test]
    fn test_verify_digest() {
        let data = b"hello world";
        let digest = compute_digest(data);
        
        assert!(verify_digest(data, &digest).is_ok());
        
        let wrong_data = b"wrong data";
        assert!(verify_digest(wrong_data, &digest).is_err());
    }
    
    #[test]
    fn test_parse_digest() {
        let digest_str = "abc123:42";
        let digest = parse_digest(digest_str).unwrap();
        
        assert_eq!(digest.hash, "abc123");
        assert_eq!(digest.size_bytes, 42);
    }
}
