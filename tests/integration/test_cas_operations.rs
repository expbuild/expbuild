use expbuild_integration_tests::{ServerHarness, TestClientFactory};
use anyhow::{Context, Result};
use sha2::{Digest as Sha2Digest, Sha256};

#[tokio::test]
async fn test_upload_and_download_small_blob() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .try_init()
        .ok();

    let server = ServerHarness::start().await?;
    let client = TestClientFactory::create_re_client(&server.url()).await?;

    let test_data = b"Hello, ExpBuild CAS!";
    
    let uploaded_digest = client.upload_blob(test_data.to_vec()).await
        .context("Failed to upload blob")?;
    
    tracing::info!("Uploaded blob with digest: {}/{}", uploaded_digest.hash, uploaded_digest.size_bytes);
    
    let mut hasher = Sha256::new();
    hasher.update(test_data);
    let expected_hash = format!("{:x}", hasher.finalize());
    assert_eq!(uploaded_digest.hash, expected_hash);
    assert_eq!(uploaded_digest.size_bytes, test_data.len() as i64);

    let downloaded_data = client.download_blob(&uploaded_digest).await
        .context("Failed to download blob")?;
    
    assert_eq!(downloaded_data, test_data);
    tracing::info!("Successfully verified blob content");

    server.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn test_upload_and_download_large_blob() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .try_init()
        .ok();

    let server = ServerHarness::start().await?;
    let client = TestClientFactory::create_re_client(&server.url()).await?;

    let test_data: Vec<u8> = (0..2_000_000)
        .map(|i| (i % 256) as u8)
        .collect();
    
    tracing::info!("Uploading large blob ({} bytes)", test_data.len());
    let uploaded_digest = client.upload_blob(test_data.clone()).await
        .context("Failed to upload large blob")?;
    
    tracing::info!("Uploaded large blob with digest: {}/{}", 
        uploaded_digest.hash, uploaded_digest.size_bytes);

    let downloaded_data = client.download_blob(&uploaded_digest).await
        .context("Failed to download large blob")?;
    
    assert_eq!(downloaded_data.len(), test_data.len());
    assert_eq!(downloaded_data, test_data);
    tracing::info!("Successfully verified large blob content");

    server.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn test_upload_and_download_directory_tree() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .try_init()
        .ok();

    let server = ServerHarness::start().await?;
    let client = TestClientFactory::create_re_client(&server.url()).await?;

    let source_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/test_projects/hello_world");
    
    tracing::info!("Uploading directory tree from {:?}", source_dir);
    let tree_digest = client.upload_directory_tree_from_path(&source_dir).await
        .context("Failed to upload directory tree")?;
    
    tracing::info!("Uploaded directory tree with digest: {}/{}", 
        tree_digest.hash, tree_digest.size_bytes);

    let temp_dir = tempfile::TempDir::new()?;
    let download_path = temp_dir.path().join("downloaded");
    
    tracing::info!("Downloading directory tree to {:?}", download_path);
    client.download_directory_tree(&tree_digest, &download_path).await
        .context("Failed to download directory tree")?;

    let hello_c = tokio::fs::read_to_string(download_path.join("hello.c")).await?;
    assert!(hello_c.contains("printf"));
    
    let build_sh = tokio::fs::read_to_string(download_path.join("build.sh")).await?;
    assert!(build_sh.contains("gcc"));
    
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = tokio::fs::metadata(download_path.join("build.sh")).await?;
        assert!(metadata.permissions().mode() & 0o111 != 0, "build.sh should be executable");
    }

    tracing::info!("Successfully verified directory tree content");
    server.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn test_find_missing_blobs() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .try_init()
        .ok();

    let server = ServerHarness::start().await?;
    let client = TestClientFactory::create_re_client(&server.url()).await?;

    let blob1 = b"blob 1";
    let blob2 = b"blob 2";
    
    let digest1 = client.upload_blob(blob1.to_vec()).await?;
    tracing::info!("Uploaded blob1");

    let mut hasher = Sha256::new();
    hasher.update(blob2);
    let missing_digest = re_grpc_proto::build::bazel::remote::execution::v2::Digest {
        hash: format!("{:x}", hasher.finalize()),
        size_bytes: blob2.len() as i64,
    };

    let result = client.download_blob(&digest1).await;
    assert!(result.is_ok(), "Existing blob should be downloadable");

    let result = client.download_blob(&missing_digest).await;
    assert!(result.is_err(), "Missing blob should fail to download");

    tracing::info!("Successfully verified missing blob detection");
    server.shutdown().await?;
    Ok(())
}
