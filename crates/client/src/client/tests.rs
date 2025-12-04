use core::sync::atomic::Ordering;
use std::env::VarError;
use std::io::Cursor;
use std::sync::atomic::AtomicU16;

use anyhow::Context;
use async_compression::tokio::bufread::ZstdDecoder;
use async_compression::tokio::bufread::ZstdEncoder;
use re_grpc_proto::build::bazel::remote::execution::v2::batch_read_blobs_response;
use re_grpc_proto::build::bazel::remote::execution::v2::batch_update_blobs_response;
use re_grpc_proto::google::bytestream::ReadResponse;
use re_grpc_proto::google::bytestream::WriteResponse;
use re_grpc_proto::google::rpc::Status;
use tokio::io::AsyncReadExt;

use super::compression::Compressor;
use super::download::download_impl;
use super::types::InstanceName;
use super::upload::upload_impl;
use super::uri::{substitute_env_vars_impl};
use crate::request::*;
use crate::response::*;

#[tokio::test]
async fn test_download_named() -> anyhow::Result<()> {
    let work = tempfile::tempdir()?;

    let path1 = work.path().join("path1");
    let path1 = path1.to_str().context("tempdir is not utf8")?;

    let path2 = work.path().join("path2");
    let path2 = path2.to_str().context("tempdir is not utf8")?;

    let digest1 = TDigest {
        hash: "aa".to_owned(),
        size_in_bytes: 3,
        ..Default::default()
    };

    let digest2 = TDigest {
        hash: "bb".to_owned(),
        size_in_bytes: 3,
        ..Default::default()
    };

    let req = DownloadRequest {
        file_digests: Some(vec![
            NamedDigestWithPermissions {
                named_digest: NamedDigest {
                    name: path1.to_owned(),
                    digest: digest1.clone(),
                    ..Default::default()
                },
                is_executable: true,
                ..Default::default()
            },
            NamedDigestWithPermissions {
                named_digest: NamedDigest {
                    name: path2.to_owned(),
                    digest: digest2.clone(),
                    ..Default::default()
                },
                is_executable: false,
                ..Default::default()
            },
        ]),
        ..Default::default()
    };

    let res = re_grpc_proto::build::bazel::remote::execution::v2::BatchReadBlobsResponse {
        responses: vec![
            batch_read_blobs_response::Response {
                digest: Some(digest2.to_grpc()),
                data: vec![4, 5, 6],
                ..Default::default()
            },
            batch_read_blobs_response::Response {
                digest: Some(digest1.to_grpc()),
                data: vec![1, 2, 3],
                ..Default::default()
            },
        ],
    };

    download_impl(
        &InstanceName(None),
        req,
        None,
        10000,
        |req| {
            let res = res.clone();
            let digest1 = digest1.clone();
            let digest2 = digest2.clone();
            async move {
                assert_eq!(req.digests.len(), 2);
                assert_eq!(req.digests[0], digest1.to_grpc());
                assert_eq!(req.digests[1], digest2.to_grpc());
                Ok(res.clone())
            }
        },
        |_digest| async move { anyhow::Ok(Box::pin(futures::stream::iter(vec![]))) },
    )
    .await?;

    assert_eq!(tokio::fs::read(&path1).await?, vec![1, 2, 3]);
    assert_eq!(tokio::fs::read(&path2).await?, vec![4, 5, 6]);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            tokio::fs::metadata(&path1).await?.permissions().mode() & 0o111,
            0o111
        );
        assert_eq!(
            tokio::fs::metadata(&path2).await?.permissions().mode() & 0o111,
            0o000
        );
    }

    Ok(())
}

#[test]
fn test_substitute_env_vars() {
    let getter = |s: &str| match s {
        "FOO" => Ok("foo_value".to_owned()),
        "BAR" => Ok("bar_value".to_owned()),
        "BAZ" => Err(VarError::NotPresent),
        _ => panic!("Unexpected"),
    };

    assert_eq!(
        substitute_env_vars_impl("$FOO", getter).unwrap(),
        "foo_value"
    );
    assert_eq!(
        substitute_env_vars_impl("$FOO$BAR", getter).unwrap(),
        "foo_valuebar_value"
    );
    assert_eq!(
        substitute_env_vars_impl("some$FOO.bar", getter).unwrap(),
        "somefoo_value.bar"
    );
    assert_eq!(substitute_env_vars_impl("foo", getter).unwrap(), "foo");
    assert_eq!(substitute_env_vars_impl("FOO", getter).unwrap(), "FOO");
    assert!(substitute_env_vars_impl("$FOO$BAZ", getter).is_err());
}
