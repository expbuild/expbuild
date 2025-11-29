use anyhow::Context;
use re_grpc_proto::build::bazel::remote::execution::v2::GetCapabilitiesRequest;

use super::compression::Compressor;
use super::types::{GrpcService, InstanceName};
use re_grpc_proto::build::bazel::remote::execution::v2::capabilities_client::CapabilitiesClient;

const DEFAULT_MAX_TOTAL_BATCH_SIZE: usize = 4 * 1000 * 1000;

pub(crate) struct RECapabilities {
    pub(crate) max_total_batch_size: usize,
    pub(crate) exec_enabled: bool,
    pub(crate) supported_compressors: Vec<Compressor>,
}

pub(crate) async fn fetch_rbe_capabilities(
    client: &mut CapabilitiesClient<GrpcService>,
    instance_name: &InstanceName,
    max_total_batch_size: Option<usize>,
) -> anyhow::Result<RECapabilities> {
    let resp = client
        .get_capabilities(GetCapabilitiesRequest {
            instance_name: instance_name.as_str().to_owned(),
        })
        .await
        .context("Failed to query capabilities of remote")?
        .into_inner();

    let mut exec_enabled = true;

    let supported_compressors = if let Some(cache_cap) = &resp.cache_capabilities {
        cache_cap
            .supported_compressors
            .iter()
            .cloned()
            .filter_map(Compressor::from_grpc)
            .collect()
    } else {
        Vec::new()
    };

    let max_total_batch_size_from_capabilities: Option<usize> =
        if let Some(cache_cap) = resp.cache_capabilities {
            let size = cache_cap.max_batch_total_size_bytes as usize;
            if size != 0 { Some(size) } else { None }
        } else {
            None
        };

    let max_total_batch_size =
        match (max_total_batch_size_from_capabilities, max_total_batch_size) {
            (Some(cap), Some(config)) => std::cmp::min(cap, config),
            (Some(cap), None) => cap,
            (None, Some(config)) => config,
            (None, None) => DEFAULT_MAX_TOTAL_BATCH_SIZE,
        };

    if let Some(exec_cap) = resp.execution_capabilities {
        exec_enabled = exec_cap.exec_enabled;
    }

    Ok(RECapabilities {
        max_total_batch_size,
        exec_enabled,
        supported_compressors,
    })
}
