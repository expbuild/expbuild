use std::collections::HashMap;
use std::io;
use std::io::Cursor;
use std::pin::Pin;

use anyhow::Context;
use async_compression::tokio::bufread::BrotliDecoder;
use async_compression::tokio::bufread::DeflateDecoder;
use async_compression::tokio::bufread::ZstdDecoder;
use futures::Stream;
use futures::StreamExt;
use futures::future::Future;
use re_grpc_proto::build::bazel::remote::execution::v2::BatchReadBlobsRequest;
use re_grpc_proto::build::bazel::remote::execution::v2::BatchReadBlobsResponse;
use re_grpc_proto::build::bazel::remote::execution::v2::compressor;
use re_grpc_proto::google::bytestream::ReadRequest;
use re_grpc_proto::google::bytestream::ReadResponse;
use tokio::fs::OpenOptions;
use tokio::io::AsyncRead;
use tokio::io::AsyncWriteExt;
use tokio_util::io::StreamReader;

use crate::request::*;
use crate::response::*;

use super::compression::Compressor;
use super::types::InstanceName;

pub(crate) async fn download_impl<Byt, BytRet, Cas>(
    instance_name: &InstanceName,
    request: DownloadRequest,
    bystream_compressor: Option<Compressor>,
    max_total_batch_size: usize,
    cas_f: impl Fn(BatchReadBlobsRequest) -> Cas,
    bystream_fut: impl Fn(ReadRequest) -> Byt + Sync + Send + Copy,
) -> anyhow::Result<DownloadResponse>
where
    Byt: Future<Output = anyhow::Result<Pin<Box<BytRet>>>>,
    BytRet: Stream<Item = Result<ReadResponse, tonic::Status>> + Send,
    Cas: Future<Output = anyhow::Result<BatchReadBlobsResponse>>,
{
    fn resource_name(
        instance_name: &InstanceName,
        compressor: Option<Compressor>,
        digest: &TDigest,
    ) -> String {
        if let Some(compressor) = compressor {
            format!(
                "{}compressed-blobs/{}/{}/{}",
                instance_name.as_resource_prefix(),
                compressor.name(),
                digest.hash,
                digest.size_in_bytes,
            )
        } else {
            format!(
                "{}blobs/{}/{}",
                instance_name.as_resource_prefix(),
                digest.hash,
                digest.size_in_bytes,
            )
        }
    }

    let bystream_fut = |digest: TDigest| async move {
        let resource_name = resource_name(&instance_name, bystream_compressor, &digest);

        bystream_fut(ReadRequest {
            resource_name: resource_name.clone(),
            read_offset: 0,
            read_limit: 0,
        })
        .await
        .and_then(|p| {
            let blob_reader = StreamReader::new(
                p.map(|r| r.map(|rr| Cursor::new(rr.data)).map_err(io::Error::other)),
            );
            let reader: Pin<Box<dyn AsyncRead + Unpin + Send>> = match bystream_compressor {
                None => Pin::new(Box::new(blob_reader)),
                Some(Compressor::Zstd) => Pin::new(Box::new(ZstdDecoder::new(blob_reader))),
                Some(Compressor::Deflate) => Pin::new(Box::new(DeflateDecoder::new(blob_reader))),
                Some(Compressor::Brotli) => Pin::new(Box::new(BrotliDecoder::new(blob_reader))),
            };

            anyhow::Ok(reader)
        })
        .with_context(|| format!("Failed to read {resource_name} from Bytestream service"))
    };

    let inlined_digests = request.inlined_digests.unwrap_or_default();
    let file_digests = request.file_digests.unwrap_or_default();

    let mut curr_size = 0;
    let mut requests = vec![];
    let mut curr_digests = vec![];
    for digest in file_digests
        .iter()
        .map(|req| &req.named_digest.digest)
        .chain(inlined_digests.iter())
        .map(|d| d.to_grpc())
        .filter(|d| d.size_bytes > 0)
    {
        if digest.size_bytes as usize >= max_total_batch_size {
            continue;
        }
        curr_size += digest.size_bytes;
        if curr_size >= max_total_batch_size as i64 {
            let read_blob_req = BatchReadBlobsRequest {
                instance_name: instance_name.as_str().to_owned(),
                digests: std::mem::take(&mut curr_digests),
                acceptable_compressors: vec![compressor::Value::Identity as i32],
                ..Default::default()
            };
            requests.push(read_blob_req);
            curr_size = digest.size_bytes;
        }
        curr_digests.push(digest.clone());
    }

    if !curr_digests.is_empty() {
        let read_blob_req = BatchReadBlobsRequest {
            instance_name: instance_name.as_str().to_owned(),
            digests: std::mem::take(&mut curr_digests),
            acceptable_compressors: vec![compressor::Value::Identity as i32],
            ..Default::default()
        };
        requests.push(read_blob_req);
    }

    let mut batched_blobs_response = HashMap::new();
    for read_blob_req in requests {
        let resp = cas_f(read_blob_req)
            .await
            .context("Failed to make BatchReadBlobs request")?;
        for r in resp.responses.into_iter() {
            let digest = TDigest::from_grpc(r.digest.context("Response digest not found.")?);
            TStatus::from_grpc_result(r.status.unwrap_or_default())?;
            batched_blobs_response.insert(digest, r.data);
        }
    }

    let get = |digest: &TDigest| -> anyhow::Result<Vec<u8>> {
        if digest.size_in_bytes == 0 {
            return Ok(Vec::new());
        }

        Ok(batched_blobs_response
            .get(digest)
            .with_context(|| format!("Did not receive digest data for `{digest}`"))?
            .clone())
    };

    let mut inlined_blobs = vec![];
    for digest in inlined_digests {
        let data = if digest.size_in_bytes as usize >= max_total_batch_size {
            let mut accum = vec![];
            let mut reader = bystream_fut(digest.clone()).await?;
            tokio::io::copy(&mut reader, &mut accum).await?;
            accum
        } else {
            get(&digest)?
        };
        inlined_blobs.push(InlinedDigestWithStatus {
            digest,
            status: TStatus::ok(),
            blob: data,
        })
    }

    let writes = file_digests.iter().map(|req| async {
        let mut opts = OpenOptions::new();
        opts.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            if req.is_executable {
                opts.mode(0o755);
            } else {
                opts.mode(0o644);
            }
        }

        let fut = async {
            let mut file = opts
                .open(&req.named_digest.name)
                .await
                .context("Error opening")?;

            if req.named_digest.digest.size_in_bytes < max_total_batch_size as i64 {
                let data = get(&req.named_digest.digest)?;
                file.write_all(&data)
                    .await
                    .with_context(|| format!("Error writing: {}", req.named_digest.digest))?;
            } else {
                let mut reader = bystream_fut(req.named_digest.digest.clone()).await?;
                tokio::io::copy(&mut reader, &mut file)
                    .await
                    .with_context(|| {
                        format!("Error writing chunk of: {}", req.named_digest.digest)
                    })?;
            }
            file.flush().await.context("Error flushing")?;
            anyhow::Ok(())
        };
        fut.await.with_context(|| {
            format!(
                "Error downloading digest `{}` to `{}`",
                req.named_digest.digest, req.named_digest.name,
            )
        })
    });

    futures::future::try_join_all(writes).await?;

    Ok(DownloadResponse {
        inlined_blobs: Some(inlined_blobs),
        directories: None,
        local_cache_stats: Default::default(),
    })
}
