use std::time::Duration;

use anyhow::Context;
use hyper_util::client::legacy::connect::HttpConnector;
use re_grpc_proto::build::bazel::remote::execution::v2::action_cache_client::ActionCacheClient;
use re_grpc_proto::build::bazel::remote::execution::v2::capabilities_client::CapabilitiesClient;
use re_grpc_proto::build::bazel::remote::execution::v2::content_addressable_storage_client::ContentAddressableStorageClient;
use re_grpc_proto::build::bazel::remote::execution::v2::execution_client::ExecutionClient;
use re_grpc_proto::google::bytestream::byte_stream_client::ByteStreamClient;
use tonic::transport::Channel;

use crate::config::*;
use crate::stats::CountingConnector;

use super::capabilities::{fetch_rbe_capabilities, RECapabilities};
use super::compression::Compressor;
use super::interceptor::InjectHeadersInterceptor;
use super::types::{GRPCClients, InstanceName, RERuntimeOpts};
use super::uri::{prepare_uri, substitute_env_vars};

#[cfg(feature = "tls")]
use super::tls::create_tls_config;

use super::REClient;

const DEFAULT_MAX_TOTAL_BATCH_SIZE: usize = 4 * 1000 * 1000;

pub struct REClientBuilder;

impl REClientBuilder {
    pub async fn build_and_connect(opts: &ReConfiguration) -> anyhow::Result<REClient> {
        #[cfg(feature = "tls")]
        let tls_config = create_tls_config(opts)
            .await
            .context("Invalid TLS config")?;

        #[cfg(feature = "tls")]
        let tls_config = &tls_config;

        let create_channel = |address: Option<String>| async move {
            let address = address.as_ref().context("No address")?;
            let address = substitute_env_vars(address).context("Invalid address")?;
            let uri = address.parse().context("Invalid address")?;
            let uri = prepare_uri(uri, opts.tls).context("Invalid URI")?;

            let mut endpoint = Channel::builder(uri);
            #[cfg(feature = "tls")]
            if opts.tls {
                endpoint = endpoint.tls_config(tls_config.clone())?;
            }

            if let Some(keepalive_time_secs) = opts.grpc_keepalive_time_secs {
                endpoint =
                    endpoint.http2_keep_alive_interval(Duration::from_secs(keepalive_time_secs));
            }
            if let Some(keepalive_timeout_secs) = opts.grpc_keepalive_timeout_secs {
                endpoint = endpoint.keep_alive_timeout(Duration::from_secs(keepalive_timeout_secs));
            }
            if let Some(keepalive_while_idle) = opts.grpc_keepalive_while_idle {
                endpoint = endpoint.keep_alive_while_idle(keepalive_while_idle);
            }

            let mut http = HttpConnector::new();
            http.enforce_http(false);
            let connector = CountingConnector::new(http);

            anyhow::Ok(
                endpoint
                    .connect_with_connector(connector)
                    .await
                    .with_context(|| format!("Error connecting to `{address}`"))?,
            )
        };

        let (cas, execution, action_cache, bytestream, capabilities) = futures::future::join5(
            create_channel(opts.cas_address.clone()),
            create_channel(opts.engine_address.clone()),
            create_channel(opts.action_cache_address.clone()),
            create_channel(opts.cas_address.clone()),
            create_channel(opts.engine_address.clone()),
        )
        .await;

        let interceptor = InjectHeadersInterceptor::new(&opts.http_headers)?;

        let mut capabilities_client = CapabilitiesClient::with_interceptor(
            capabilities.context("Error creating Capabilities client")?,
            interceptor.clone(),
        );

        if let Some(max_decoding_message_size) = opts.max_decoding_message_size {
            capabilities_client =
                capabilities_client.max_decoding_message_size(max_decoding_message_size);
        }

        let instance_name = InstanceName(Some(opts.instance_name.clone()));

        let capabilities = if opts.capabilities.unwrap_or(true) {
            fetch_rbe_capabilities(
                &mut capabilities_client,
                &instance_name,
                opts.max_total_batch_size,
            )
            .await?
        } else {
            RECapabilities {
                exec_enabled: true,
                max_total_batch_size: DEFAULT_MAX_TOTAL_BATCH_SIZE,
                supported_compressors: Vec::new(),
            }
        };

        if !capabilities.exec_enabled {
            return Err(anyhow::anyhow!("Server has remote execution disabled."));
        }

        let max_decoding_msg_size = opts
            .max_decoding_message_size
            .unwrap_or(capabilities.max_total_batch_size * 2);

        if max_decoding_msg_size < capabilities.max_total_batch_size {
            return Err(anyhow::anyhow!(
                "Attribute `max_decoding_message_size` must always be equal or higher to `max_total_batch_size`"
            ));
        }

        let bystream_compressor = if capabilities
            .supported_compressors
            .contains(&Compressor::Zstd)
        {
            Some(Compressor::Zstd)
        } else if capabilities
            .supported_compressors
            .contains(&Compressor::Deflate)
        {
            Some(Compressor::Deflate)
        } else {
            None
        };

        let grpc_clients = GRPCClients {
            cas_client: ContentAddressableStorageClient::with_interceptor(
                cas.context("Error creating CAS client")?,
                interceptor.clone(),
            )
            .max_decoding_message_size(max_decoding_msg_size),
            execution_client: ExecutionClient::with_interceptor(
                execution.context("Error creating Execution client")?,
                interceptor.clone(),
            ),
            action_cache_client: ActionCacheClient::with_interceptor(
                action_cache.context("Error creating ActionCache client")?,
                interceptor.clone(),
            ),
            bytestream_client: ByteStreamClient::with_interceptor(
                bytestream.context("Error creating Bytestream client")?,
                interceptor.clone(),
            )
            .max_decoding_message_size(max_decoding_msg_size),
        };

        Ok(REClient::new(
            RERuntimeOpts {
                use_fbcode_metadata: opts.use_fbcode_metadata,
                max_concurrent_uploads_per_action: opts.max_concurrent_uploads_per_action,
                cas_ttl_secs: opts.cas_ttl_secs.unwrap_or(60) as i64,
            },
            grpc_clients,
            capabilities,
            instance_name,
            bystream_compressor,
        ))
    }
}
