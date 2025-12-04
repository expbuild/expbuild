use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReConfiguration {
    pub engine_address: Option<String>,
    pub action_cache_address: Option<String>,
    pub cas_address: Option<String>,
    
    pub tls: bool,
    pub tls_ca_certs: Option<String>,
    pub tls_client_cert: Option<String>,
    
    pub http_headers: Vec<HttpHeader>,
    
    pub grpc_keepalive_time_secs: Option<u64>,
    pub grpc_keepalive_timeout_secs: Option<u64>,
    pub grpc_keepalive_while_idle: Option<bool>,
    
    pub instance_name: String,
    pub max_decoding_message_size: Option<usize>,
    pub max_total_batch_size: Option<usize>,
    pub capabilities: Option<bool>,
    pub use_fbcode_metadata: bool,
    pub max_concurrent_uploads_per_action: Option<usize>,
    pub cas_ttl_secs: Option<u64>,
}

impl Default for ReConfiguration {
    fn default() -> Self {
        Self {
            engine_address: None,
            action_cache_address: None,
            cas_address: None,
            tls: false,
            tls_ca_certs: None,
            tls_client_cert: None,
            http_headers: Vec::new(),
            grpc_keepalive_time_secs: None,
            grpc_keepalive_timeout_secs: None,
            grpc_keepalive_while_idle: None,
            instance_name: String::new(),
            max_decoding_message_size: None,
            max_total_batch_size: None,
            capabilities: Some(true),
            use_fbcode_metadata: false,
            max_concurrent_uploads_per_action: None,
            cas_ttl_secs: Some(60),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpHeader {
    pub key: String,
    pub value: String,
}

impl HttpHeader {
    pub fn new(key: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            value: value.into(),
        }
    }
}
