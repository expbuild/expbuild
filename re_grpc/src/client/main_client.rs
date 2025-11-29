use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use anyhow::Context;
use futures::stream::BoxStream;
use futures::TryStreamExt;
use lru::LruCache;
use re_grpc_proto::build::bazel::remote::execution::v2::FindMissingBlobsRequest;
use re_grpc_proto::build::bazel::remote::execution::v2::FindMissingBlobsResponse;
use re_grpc_proto::build::bazel::remote::execution::v2::GetActionResultRequest;
use re_grpc_proto::build::bazel::remote::execution::v2::UpdateActionResultRequest;

use crate::metadata::*;
use crate::request::*;
use crate::response::*;

use super::compression::Compressor;
use super::types::{GRPCClients, InstanceName, RERuntimeOpts};
use super::capabilities::RECapabilities;
use super::{helpers, download, upload, execution};

#[derive(Debug, Copy, Clone)]
enum DigestRemoteState {
    ExistsOnRemote,
    Missing,
}

struct FindMissingCache {
    cache: LruCache<TDigest, DigestRemoteState>,
    ttl: Duration,
    last_check: Instant,
}

impl FindMissingCache {
    fn clear_if_ttl_expires(&mut self) {
        if self.last_check.elapsed() > self.ttl {
            self.cache.clear();
            self.last_check = Instant::now();
        }
    }

    pub fn get(&mut self, digest: &TDigest) -> Option<DigestRemoteState> {
        self.clear_if_ttl_expires();
        self.cache.get(digest).copied()
    }

    pub fn put(&mut self, digest: TDigest, state: DigestRemoteState) {
        self.clear_if_ttl_expires();
        self.cache.put(digest, state);
    }
}

#[derive(Clone)]
pub struct REClient {
    runtime_opts: RERuntimeOpts,
    grpc_clients: GRPCClients,
    capabilities: RECapabilities,
    instance_name: InstanceName,
    find_missing_cache: std::sync::Arc<Mutex<FindMissingCache>>,
    bystream_compressor: Option<Compressor>,
}

impl Drop for REClient {
    fn drop(&mut self) {
    }
}

impl REClient {
    pub(crate) fn new(
        runtime_opts: RERuntimeOpts,
        grpc_clients: GRPCClients,
        capabilities: RECapabilities,
        instance_name: InstanceName,
        bystream_compressor: Option<Compressor>,
    ) -> Self {
        REClient {
            runtime_opts,
            grpc_clients,
            capabilities,
            instance_name,
            find_missing_cache: std::sync::Arc::new(Mutex::new(FindMissingCache {
                cache: LruCache::new(NonZeroUsize::new(50 << 20).unwrap()),
                ttl: Duration::from_secs(12 * 60 * 60),
                last_check: Instant::now(),
            })),
            bystream_compressor,
        }
    }

    pub async fn get_action_result(
        &self,
        metadata: RemoteExecutionMetadata,
        request: ActionResultRequest,
    ) -> anyhow::Result<ActionResultResponse> {
        let mut client = self.grpc_clients.action_cache_client.clone();

        let res = client
            .get_action_result(helpers::with_re_metadata(
                GetActionResultRequest {
                    instance_name: self.instance_name.as_str().to_owned(),
                    action_digest: Some(request.digest.to_grpc()),
                    ..Default::default()
                },
                metadata,
                self.runtime_opts.use_fbcode_metadata,
            ))
            .await?;

        Ok(ActionResultResponse {
            action_result: helpers::convert_action_result(res.into_inner())?,
            ttl: 0,
        })
    }

    pub async fn write_action_result(
        &self,
        metadata: RemoteExecutionMetadata,
        request: WriteActionResultRequest,
    ) -> anyhow::Result<WriteActionResultResponse> {
        let mut client = self.grpc_clients.action_cache_client.clone();

        let res = client
            .update_action_result(helpers::with_re_metadata(
                UpdateActionResultRequest {
                    instance_name: self.instance_name.as_str().to_owned(),
                    action_digest: Some(request.action_digest.to_grpc()),
                    action_result: Some(helpers::convert_t_action_result2(request.action_result)?),
                    results_cache_policy: None,
                    ..Default::default()
                },
                metadata,
                self.runtime_opts.use_fbcode_metadata,
            ))
            .await?;

        Ok(WriteActionResultResponse {
            actual_action_result: helpers::convert_action_result(res.into_inner())?,
            ttl_seconds: 0,
        })
    }

    pub async fn execute_with_progress(
        &self,
        metadata: RemoteExecutionMetadata,
        execute_request: ExecuteRequest,
    ) -> anyhow::Result<BoxStream<'static, anyhow::Result<ExecuteWithProgressResponse>>> {
        let client = self.grpc_clients.execution_client.clone();
        execution::execute_with_progress_impl(
            client,
            &self.instance_name,
            metadata,
            execute_request,
            self.runtime_opts.use_fbcode_metadata,
        )
        .await
    }

    pub async fn upload(
        &self,
        metadata: RemoteExecutionMetadata,
        request: UploadRequest,
    ) -> anyhow::Result<UploadResponse> {
        upload::upload_impl(
            &self.instance_name,
            request,
            self.bystream_compressor,
            self.capabilities.max_total_batch_size,
            self.runtime_opts.max_concurrent_uploads_per_action,
            |re_request| async {
                let metadata = metadata.clone();
                let mut cas_client = self.grpc_clients.cas_client.clone();
                let resp = cas_client
                    .batch_update_blobs(helpers::with_re_metadata(
                        re_request,
                        metadata,
                        self.runtime_opts.use_fbcode_metadata,
                    ))
                    .await?;
                Ok(resp.into_inner())
            },
            |segments| async {
                let metadata = metadata.clone();
                let mut bytestream_client = self.grpc_clients.bytestream_client.clone();
                let requests = futures::stream::iter(segments);
                let resp = bytestream_client
                    .write(helpers::with_re_metadata(
                        requests,
                        metadata,
                        self.runtime_opts.use_fbcode_metadata,
                    ))
                    .await?;

                Ok(resp.into_inner())
            },
        )
        .await
    }

    pub async fn upload_blob_with_digest(
        &self,
        blob: Vec<u8>,
        digest: TDigest,
        metadata: RemoteExecutionMetadata,
    ) -> anyhow::Result<TDigest> {
        let blob = InlinedBlobWithDigest {
            digest: digest.clone(),
            blob,
            ..Default::default()
        };
        self.upload(
            metadata,
            UploadRequest {
                inlined_blobs_with_digest: Some(vec![blob]),
                files_with_digest: None,
                directories: None,
                upload_only_missing: false,
                ..Default::default()
            },
        )
        .await?;
        Ok(digest)
    }

    pub async fn download(
        &self,
        metadata: RemoteExecutionMetadata,
        request: DownloadRequest,
    ) -> anyhow::Result<DownloadResponse> {
        download::download_impl(
            &self.instance_name,
            request,
            self.bystream_compressor,
            self.capabilities.max_total_batch_size,
            |re_request| async {
                let metadata = metadata.clone();
                let mut client = self.grpc_clients.cas_client.clone();
                Ok(client
                    .batch_read_blobs(helpers::with_re_metadata(
                        re_request,
                        metadata,
                        self.runtime_opts.use_fbcode_metadata,
                    ))
                    .await?
                    .into_inner())
            },
            |read_request| {
                let metadata = metadata.clone();
                async move {
                    let mut client = self.grpc_clients.bytestream_client.clone();
                    let response = client
                        .read(helpers::with_re_metadata(
                            read_request,
                            metadata,
                            self.runtime_opts.use_fbcode_metadata,
                        ))
                        .await?
                        .into_inner();
                    Ok(Box::pin(response.into_stream()))
                }
            },
        )
        .await
    }

    pub async fn get_digests_ttl(
        &self,
        metadata: RemoteExecutionMetadata,
        request: GetDigestsTtlRequest,
    ) -> anyhow::Result<GetDigestsTtlResponse> {
        let mut cas_client = self.grpc_clients.cas_client.clone();
        let mut remote_results: HashMap<TDigest, DigestRemoteState> = HashMap::new();
        let mut digests_to_check: Vec<TDigest> = Vec::new();

        let mut digest_iter = request.digests.iter();
        while digest_iter.len() > 0 {
            {
                let mut find_missing_cache = self.find_missing_cache.lock().unwrap();
                for digest in digest_iter.by_ref() {
                    if let Some(rs) = find_missing_cache.get(&digest) {
                        remote_results.insert(digest.clone(), rs);
                    } else {
                        digests_to_check.push(digest.clone());
                    }
                    if digests_to_check.len() >= 100 {
                        break;
                    }
                }
            }

            if !digests_to_check.is_empty() {
                tracing::debug!(num_digests = digests_to_check.len(), "FindMissingBlobs");
                let missing_blobs = cas_client
                    .find_missing_blobs(helpers::with_re_metadata(
                        FindMissingBlobsRequest {
                            instance_name: self.instance_name.as_str().to_owned(),
                            blob_digests: digests_to_check.iter().map(|b| b.to_grpc()).collect(),
                            ..Default::default()
                        },
                        metadata.clone(),
                        self.runtime_opts.use_fbcode_metadata,
                    ))
                    .await
                    .context("Failed to request what blobs are not present on remote")?;
                let resp: FindMissingBlobsResponse = missing_blobs.into_inner();

                let mut find_missing_cache = self.find_missing_cache.lock().unwrap();
                for digest in &digests_to_check {
                    remote_results.insert(digest.clone(), DigestRemoteState::ExistsOnRemote);
                    find_missing_cache.put(digest.clone(), DigestRemoteState::ExistsOnRemote);
                }

                for digest in resp.missing_blob_digests.iter().map(|d| TDigest::from_grpc(d.clone())) {
                    remote_results.insert(digest.clone(), DigestRemoteState::Missing);
                    find_missing_cache.put(digest.clone(), DigestRemoteState::Missing);
                }
                digests_to_check.clear();
            }
        }

        Ok(GetDigestsTtlResponse {
            digests_with_ttl: remote_results
                .iter()
                .map(|(digest, rs)| match rs {
                    DigestRemoteState::Missing => DigestWithTtl {
                        digest: digest.clone(),
                        ttl: 0,
                    },
                    DigestRemoteState::ExistsOnRemote => DigestWithTtl {
                        digest: digest.clone(),
                        ttl: self.runtime_opts.cas_ttl_secs,
                    },
                })
                .collect::<Vec<DigestWithTtl>>(),
        })
    }

    pub async fn extend_digest_ttl(
        &self,
        _metadata: RemoteExecutionMetadata,
        _request: ExtendDigestsTtlRequest,
    ) -> anyhow::Result<TDigest> {
        Err(anyhow::anyhow!("Not implemented (RE extend_digest_ttl)"))
    }

    pub fn get_execution_client(&self) -> &Self {
        self
    }

    pub fn get_cas_client(&self) -> &Self {
        self
    }

    pub fn get_action_cache_client(&self) -> &Self {
        self
    }

    pub fn get_metrics_client(&self) -> &Self {
        self
    }

    pub fn get_session_id(&self) -> &str {
        "GRPC-SESSION-ID"
    }

    pub fn get_experiment_name(&self) -> anyhow::Result<Option<String>> {
        Ok(None)
    }

    pub async fn upload_action(
        &self,
        action: re_grpc_proto::build::bazel::remote::execution::v2::Action,
        metadata: RemoteExecutionMetadata,
    ) -> anyhow::Result<TDigest> {
        use prost::Message;
        
        let mut buf = Vec::new();
        action.encode(&mut buf)
            .context("Failed to encode Action")?;
        let digest = crate::digest::compute_digest(&buf);
        
        self.upload_blob_with_digest(buf, digest.clone(), metadata).await?;
        Ok(digest)
    }

    pub async fn upload_command(
        &self,
        command: re_grpc_proto::build::bazel::remote::execution::v2::Command,
        metadata: RemoteExecutionMetadata,
    ) -> anyhow::Result<TDigest> {
        use prost::Message;
        
        let mut buf = Vec::new();
        command.encode(&mut buf)
            .context("Failed to encode Command")?;
        let digest = crate::digest::compute_digest(&buf);
        
        self.upload_blob_with_digest(buf, digest.clone(), metadata).await?;
        Ok(digest)
    }

    pub async fn upload_directory_tree(
        &self,
        directories: Vec<(re_grpc_proto::build::bazel::remote::execution::v2::Directory, TDigest)>,
        files: Vec<crate::action::directory::FileToUpload>,
        metadata: RemoteExecutionMetadata,
    ) -> anyhow::Result<TDigest> {
        use prost::Message;
        
        let mut inlined_blobs = Vec::new();
        let root_digest = directories.first()
            .map(|(_, digest)| digest.clone())
            .unwrap_or_default();
        
        for (directory, digest) in directories {
            let mut buf = Vec::new();
            directory.encode(&mut buf)
                .context("Failed to encode Directory")?;
            inlined_blobs.push(InlinedBlobWithDigest {
                digest,
                blob: buf,
                ..Default::default()
            });
        }
        
        for file in &files {
            inlined_blobs.push(InlinedBlobWithDigest {
                digest: file.digest.clone(),
                blob: file.content.clone(),
                ..Default::default()
            });
        }
        
        self.upload(
            metadata,
            UploadRequest {
                inlined_blobs_with_digest: Some(inlined_blobs),
                files_with_digest: None,
                directories: None,
                upload_only_missing: true,
                ..Default::default()
            },
        )
        .await?;
        
        Ok(root_digest)
    }

    pub async fn wait_execution(
        &self,
        operation_name: String,
        metadata: RemoteExecutionMetadata,
    ) -> anyhow::Result<BoxStream<'static, anyhow::Result<ExecuteWithProgressResponse>>> {
        let client = self.grpc_clients.execution_client.clone();
        execution::wait_execution_impl(
            client,
            &self.instance_name,
            operation_name,
            metadata,
            self.runtime_opts.use_fbcode_metadata,
        )
        .await
    }
}
