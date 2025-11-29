use re_grpc_proto::build::bazel::remote::execution::v2::compressor;

#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash)]
pub enum Compressor {
    Zstd,
    Deflate,
    Brotli,
}

impl Compressor {
    pub(crate) fn from_grpc(val: i32) -> Option<Self> {
        if val == compressor::Value::Zstd as i32 {
            Some(Self::Zstd)
        } else if val == compressor::Value::Deflate as i32 {
            Some(Self::Deflate)
        } else {
            None
        }
    }

    pub(crate) fn name(&self) -> &str {
        match self {
            Self::Zstd => "zstd",
            Self::Deflate => "deflate",
            Self::Brotli => "brotli",
        }
    }
}
