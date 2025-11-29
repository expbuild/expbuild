use anyhow::Context;
use async_compression::tokio::bufread::BrotliEncoder;
use async_compression::tokio::bufread::DeflateEncoder;
use async_compression::tokio::bufread::ZstdEncoder;
use futures::future::BoxFuture;
use futures::future::Future;
use futures::stream::TryStreamExt;
use futures::StreamExt;
use re_grpc_proto::build::bazel::remote::execution::v2::BatchUpdateBlobsRequest;
use re_grpc_proto::build::bazel::remote::execution::v2::BatchUpdateBlobsResponse;
use re_grpc_proto::build::bazel::remote::execution::v2::batch_update_blobs_request::Request;
use re_grpc_proto::build::bazel::remote::execution::v2::compressor;
use re_grpc_proto::google::bytestream::WriteRequest;
use re_grpc_proto::google::bytestream::WriteResponse;
use re_grpc_proto::google::rpc::Code;
use std::io::Cursor;
use std::pin::Pin;
use tokio::io::AsyncBufRead;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::io::BufReader;

use crate::request::*;
use crate::response::*;

use super::compression::Compressor;
use super::types::InstanceName;

enum BatchUploadRequest {
    Blob(InlinedBlobWithDigest),
    File(NamedDigest),
}

#[derive(Default)]
struct BatchUploadReqAggregator {
    max_msg_size: i64,
    curr_req: Vec<BatchUploadRequest>,
    requests: Vec<Vec<BatchUploadRequest>>,
    curr_request_size: i64,
}

impl BatchUploadReqAggregator {
    pub fn new(max_msg_size: usize) -> Self {
        BatchUploadReqAggregator {
            max_msg_size: max_msg_size as i64,
            ..Default::default()
        }
    }

    pub fn push(&mut self, req: BatchUploadRequest) {
        let size_in_bytes = match &req {
            BatchUploadRequest::Blob(blob) => blob.digest.size_in_bytes,
            BatchUploadRequest::File(file) => file.digest.size_in_bytes,
        };

        if size_in_bytes == 0 {
            return;
        }

        self.curr_request_size += size_in_bytes;

        if self.curr_request_size >= self.max_msg_size {
            self.requests.push(std::mem::take(&mut self.curr_req));
            self.curr_request_size = size_in_bytes;
        }
        self.curr_req.push(req);
    }

    pub fn done(mut self) -> Vec<Vec<BatchUploadRequest>> {
        if !self.curr_req.is_empty() {
            self.requests.push(std::mem::take(&mut self.curr_req));
        }
        self.requests
    }
}

pub(crate) async fn upload_impl<Byt, Cas>(
    instance_name: &InstanceName,
    request: UploadRequest,
    bystream_compressor: Option<Compressor>,
    max_total_batch_size: usize,
    max_concurrent_uploads: Option<usize>,
    cas_f: impl Fn(BatchUpdateBlobsRequest) -> Cas + Sync + Send + Copy,
    bystream_fut: impl Fn(Vec<WriteRequest>) -> Byt + Sync + Send + Copy,
) -> anyhow::Result<UploadResponse>
where
    Cas: Future<Output = anyhow::Result<BatchUpdateBlobsResponse>> + Send,
    Byt: Future<Output = anyhow::Result<WriteResponse>> + Send,
{
    fn resource_name(
        instance_name: &InstanceName,
        client_uuid: &str,
        compressor: Option<Compressor>,
        digest: &TDigest,
    ) -> String {
        if let Some(compressor) = compressor {
            format!(
                "{}uploads/{}/compressed-blobs/{}/{}/{}",
                instance_name.as_resource_prefix(),
                client_uuid,
                compressor.name(),
                digest.hash,
                digest.size_in_bytes,
            )
        } else {
            format!(
                "{}uploads/{}/blobs/{}/{}",
                instance_name.as_resource_prefix(),
                client_uuid,
                digest.hash,
                digest.size_in_bytes,
            )
        }
    }

    let mut upload_futures: Vec<BoxFuture<anyhow::Result<Vec<String>>>> = vec![];

    let mut batched_blob_updates = BatchUploadReqAggregator::new(max_total_batch_size);

    let bystream_fut = |resource_name: String, reader: Box<dyn AsyncBufRead + Unpin + Send>| async move {
        let mut reader: Pin<Box<dyn AsyncRead + Unpin + Send>> = match bystream_compressor {
            None => Pin::new(Box::new(reader)),
            Some(Compressor::Zstd) => Pin::new(Box::new(ZstdEncoder::new(reader))),
            Some(Compressor::Deflate) => Pin::new(Box::new(DeflateEncoder::new(reader))),
            Some(Compressor::Brotli) => Pin::new(Box::new(BrotliEncoder::new(reader))),
        };

        let mut current_offset = 0;
        let mut upload_segments = Vec::new();
        let mut buf = vec![0; max_total_batch_size];
        loop {
            let n_read = reader.read(&mut buf).await.unwrap();
            if n_read == 0 {
                break;
            }
            upload_segments.push(WriteRequest {
                resource_name: resource_name.clone(),
                write_offset: current_offset,
                finish_write: false,
                data: buf[0..n_read].to_vec(),
            });
            current_offset += n_read as i64;
        }
        if let Some(last_segment) = upload_segments.last_mut() {
            last_segment.finish_write = true;
        }

        if upload_segments.is_empty() {
            return Ok(());
        }

        let response = bystream_fut(upload_segments).await?;
        if response.committed_size != current_offset && response.committed_size != -1 {
            return Err(anyhow::anyhow!(
                "Failed to upload `{resource_name}`: invalid committed_size from WriteResponse"
            ));
        }

        Ok(())
    };

    for blob in request.inlined_blobs_with_digest.unwrap_or_default() {
        let hash = blob.digest.hash.clone();
        let size = blob.digest.size_in_bytes;

        if size < max_total_batch_size as i64 {
            batched_blob_updates.push(BatchUploadRequest::Blob(blob));
            continue;
        }

        let data = blob.blob;
        let client_uuid = uuid::Uuid::new_v4().to_string();
        let resource_name = resource_name(
            &instance_name,
            &client_uuid,
            bystream_compressor,
            &blob.digest,
        );
        let fut = async move {
            bystream_fut(resource_name, Box::new(Cursor::new(data))).await?;

            Ok(vec![hash])
        };
        upload_futures.push(Box::pin(fut));
    }

    for file in request.files_with_digest.unwrap_or_default() {
        let hash = file.digest.hash.clone();
        let size = file.digest.size_in_bytes;
        let name = file.name.clone();
        if size < max_total_batch_size as i64 {
            batched_blob_updates.push(BatchUploadRequest::File(file));
            continue;
        }
        let client_uuid = uuid::Uuid::new_v4().to_string();
        let resource_name = resource_name(
            &instance_name,
            &client_uuid,
            bystream_compressor,
            &file.digest,
        );

        let fut = async move {
            let file = tokio::fs::File::open(&name)
                .await
                .with_context(|| format!("Opening `{name}` for reading failed"))?;

            bystream_fut(resource_name, Box::new(BufReader::new(file))).await?;
            Ok(vec![hash])
        };
        upload_futures.push(Box::pin(fut));
    }

    let batched_blob_updates = batched_blob_updates.done();
    for batch in batched_blob_updates {
        let fut = async move {
            let mut re_request = BatchUpdateBlobsRequest {
                instance_name: instance_name.as_str().to_owned(),
                requests: vec![],
                ..Default::default()
            };
            for blob in batch {
                match blob {
                    BatchUploadRequest::Blob(blob) => {
                        re_request.requests.push(Request {
                            digest: Some(blob.digest.to_grpc()),
                            data: blob.blob.clone(),
                            compressor: compressor::Value::Identity as i32,
                        });
                    }
                    BatchUploadRequest::File(file) => {
                        let mut fin = tokio::fs::File::open(&file.name)
                            .await
                            .with_context(|| format!("Opening {} for writing failed", file.name))?;
                        let mut data = vec![];
                        fin.read_to_end(&mut data).await?;

                        re_request.requests.push(Request {
                            digest: Some(file.digest.to_grpc()),
                            data,
                            compressor: compressor::Value::Identity as i32,
                        });
                    }
                }
            }
            let blob_hashes = re_request
                .requests
                .iter()
                .map(|x| x.digest.as_ref().unwrap().hash.clone())
                .collect::<Vec<String>>();

            let response = cas_f(re_request).await?;
            let failures: Vec<String> = response
                .responses
                .iter()
                .filter_map(|r| {
                    r.status.as_ref().and_then(|s| {
                        if s.code == (Code::Ok as i32) {
                            None
                        } else {
                            Some(format!(
                                "Unable to upload blob '{}', rpc status code: {}, message: \"{}\"",
                                r.digest.as_ref().map_or("N/A", |d| &d.hash),
                                s.code,
                                s.message
                            ))
                        }
                    })
                })
                .collect();

            if !failures.is_empty() {
                return Err(anyhow::anyhow!("Batch upload failed: {:?}", failures));
            }
            Ok(blob_hashes)
        };
        upload_futures.push(Box::pin(fut));
    }

    let blob_hashes = if let Some(concurrency_limit) = max_concurrent_uploads {
        futures::stream::iter(upload_futures)
            .buffer_unordered(concurrency_limit)
            .try_collect::<Vec<Vec<String>>>()
            .await?
    } else {
        futures::future::try_join_all(upload_futures).await?
    };

    tracing::debug!("uploaded: {:?}", blob_hashes);
    Ok(UploadResponse {})
}
