use anyhow::{Context, Result};
use remote_execution::{REClient, REClientBuilder, ReConfiguration};

pub struct TestClientFactory;

impl TestClientFactory {
    pub async fn create_re_client(server_url: &str) -> Result<REClient> {
        // REClient doesn't want http:// prefix  
        let url_no_scheme = server_url
            .strip_prefix("http://")
            .or_else(|| server_url.strip_prefix("https://"))
            .unwrap_or(server_url);
        
        let config = ReConfiguration {
            engine_address: Some(url_no_scheme.to_string()),
            cas_address: Some(url_no_scheme.to_string()),
            action_cache_address: Some(url_no_scheme.to_string()),
            instance_name: "test".to_string(),
            tls: false,
            tls_ca_certs: None,
            tls_client_cert: None,
            http_headers: vec![],
            grpc_keepalive_time_secs: None,
            grpc_keepalive_timeout_secs: None,
            grpc_keepalive_while_idle: None,
            max_decoding_message_size: None,
            max_total_batch_size: Some(4 * 1024 * 1024),
            capabilities: Some(true),
            use_fbcode_metadata: false,
            max_concurrent_uploads_per_action: None,
            cas_ttl_secs: Some(3600),
        };

        REClientBuilder::build_and_connect(&config)
            .await
            .context("Failed to create RE client")
    }
}
