use std::fmt;
use std::fmt::Display;
use std::str::FromStr;

use anyhow::Context;
use once_cell::sync::Lazy;
use regex::Regex;

#[derive(Clone, Default, PartialEq, Eq, Hash, Debug)]
pub struct TDigest {
    pub hash: String,
    pub size_in_bytes: i64,
    pub _dot_dot: (),
}

impl Display for TDigest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.hash, self.size_in_bytes)
    }
}

impl FromStr for TDigest {
    type Err = anyhow::Error;

    fn from_str(digest: &str) -> anyhow::Result<TDigest> {
        static DIGEST_RE: Lazy<Regex> = Lazy::new(|| {
            Regex::new("([0-9a-f]+):([0-9]+)").expect("Failed to compile digest regex")
        });

        let matches = DIGEST_RE
            .captures(digest)
            .with_context(|| format!("Digest format not valid: {digest}"))?;
        Ok(TDigest {
            hash: matches[1].to_string(),
            size_in_bytes: matches[2].parse::<i64>().with_context(|| {
                format!("Digest size {} could not be parsed as a i64", &matches[2])
            })?,
            ..Default::default()
        })
    }
}

impl TDigest {
    /// Compute digest from bytes using SHA256
    pub fn compute(data: &[u8]) -> Self {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(data);
        let result = hasher.finalize();
        
        TDigest {
            hash: hex::encode(result),
            size_in_bytes: data.len() as i64,
            ..Default::default()
        }
    }

    /// Convert TDigest to protobuf Digest
    pub fn to_grpc(&self) -> re_grpc_proto::build::bazel::remote::execution::v2::Digest {
        re_grpc_proto::build::bazel::remote::execution::v2::Digest {
            hash: self.hash.clone(),
            size_bytes: self.size_in_bytes,
        }
    }

    /// Convert protobuf Digest to TDigest
    pub fn from_grpc(
        digest: re_grpc_proto::build::bazel::remote::execution::v2::Digest,
    ) -> Self {
        TDigest {
            hash: digest.hash,
            size_in_bytes: digest.size_bytes,
            ..Default::default()
        }
    }
}

pub fn compute_digest(data: &[u8]) -> TDigest {
    TDigest::compute(data)
}
