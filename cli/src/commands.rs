use anyhow::{Context, Result};
use futures::StreamExt;
use remote_execution::*;

use crate::cli::{Commands, Config};

pub async fn execute_command(cmd: Commands, config: Config) -> Result<()> {
    let re_config = build_re_config(&config)?;
    let client = REClientBuilder::build_and_connect(&re_config).await?;

    match cmd {
        Commands::Execute {
            action_digest,
            skip_cache,
            instance_name: _,
        } => {
            println!("Executing action: {}", action_digest);
            let digest = parse_digest(&action_digest)?;

            let request = ExecuteRequest {
                action_digest: digest,
                skip_cache_lookup: skip_cache,
                ..Default::default()
            };

            let metadata = RemoteExecutionMetadata::default();
            let mut stream = client.execute_with_progress(metadata, request).await?;

            while let Some(response) = stream.next().await {
                match response {
                    Ok(exec_response) => {
                        println!("Stage: {:?}", exec_response.stage);
                        if let Some(execute_response) = exec_response.execute_response {
                            println!("Exit code: {}", execute_response.action_result.exit_code);
                            println!("Execution completed successfully");
                        }
                    }
                    Err(e) => {
                        eprintln!("Execution error: {}", e);
                        return Err(e.into());
                    }
                }
            }
        }

        Commands::Upload {
            files,
            instance_name: _,
            progress,
        } => {
            println!("Uploading {} file(s)...", files.len());

            let mut files_with_digest = Vec::new();

            for file in &files {
                if progress {
                    println!("  Reading: {}", file.display());
                }

                let content = tokio::fs::read(file)
                    .await
                    .with_context(|| format!("Failed to read file: {}", file.display()))?;

                let digest = compute_digest(&content);

                files_with_digest.push(NamedDigest {
                    name: file.to_string_lossy().to_string(),
                    digest: digest.clone(),
                    ..Default::default()
                });

                if progress {
                    println!("  ✓ {} -> {}", file.display(), digest);
                }
            }

            let request = UploadRequest {
                files_with_digest: Some(files_with_digest),
                ..Default::default()
            };

            let metadata = RemoteExecutionMetadata::default();
            client.upload(metadata, request).await?;

            println!("Upload complete!");
        }

        Commands::Download {
            digest: digest_str,
            output,
            instance_name: _,
        } => {
            println!("Downloading: {} -> {}", digest_str, output.display());

            let digest = parse_digest(&digest_str)?;

            let request = DownloadRequest {
                file_digests: Some(vec![NamedDigestWithPermissions {
                    named_digest: NamedDigest {
                        name: output.to_string_lossy().to_string(),
                        digest,
                        ..Default::default()
                    },
                    ..Default::default()
                }]),
                ..Default::default()
            };

            let metadata = RemoteExecutionMetadata::default();
            client.download(metadata, request).await?;
            println!("Download complete!");
        }

        Commands::FindMissing {
            digests,
            instance_name: _,
        } => {
            println!("Checking {} digest(s)...", digests.len());

            let parsed_digests: Result<Vec<_>> = digests
                .iter()
                .map(|d| parse_digest(d))
                .collect();

            let request = GetDigestsTtlRequest {
                digests: parsed_digests?,
                ..Default::default()
            };

            let metadata = RemoteExecutionMetadata::default();
            let response = client.get_digests_ttl(metadata, request).await?;

            let missing_digests: Vec<_> = response
                .digests_with_ttl
                .iter()
                .filter(|d| d.ttl == 0)
                .map(|d| d.digest.clone())
                .collect();

            if missing_digests.is_empty() {
                println!("All blobs exist in CAS");
            } else {
                println!("Missing {} blob(s):", missing_digests.len());
                for digest in missing_digests {
                    println!("  {}", digest);
                }
            }
        }

        Commands::GetActionResult {
            action_digest,
            instance_name: _,
        } => {
            println!("Getting action result for: {}", action_digest);

            let digest = parse_digest(&action_digest)?;

            let request = ActionResultRequest {
                digest,
                ..Default::default()
            };

            let metadata = RemoteExecutionMetadata::default();

            match client.get_action_result(metadata, request).await {
                Ok(result) => {
                    let action_result = result.action_result;
                    println!("Exit code: {}", action_result.exit_code);
                    println!("Output files: {}", action_result.output_files.len());
                    println!("Output directories: {}", action_result.output_directories.len());
                }
                Err(e) => {
                    eprintln!("Action result not found: {}", e);
                    return Err(e.into());
                }
            }
        }

        Commands::Capabilities {
            instance_name,
            format,
        } => {
            println!("Fetching server capabilities...");

            let instance = instance_name.or(config.remote.instance_name);

            match format {
                crate::cli::OutputFormat::Json => {
                    println!("{{\"instance_name\": {:?}}}", instance);
                }
                crate::cli::OutputFormat::Text => {
                    println!("Instance: {:?}", instance);
                    println!("Connected successfully!");
                }
            }
        }

        Commands::Ping { timeout } => {
            println!("Pinging remote execution service (timeout: {}s)...", timeout);

            let start = std::time::Instant::now();
            let _client = tokio::time::timeout(
                std::time::Duration::from_secs(timeout),
                REClientBuilder::build_and_connect(&re_config),
            )
            .await
            .context("Connection timeout")??;

            let elapsed = start.elapsed();
            println!("✓ Connection successful! ({:.2}ms)", elapsed.as_secs_f64() * 1000.0);
        }
    }

    Ok(())
}

fn build_re_config(config: &Config) -> Result<ReConfiguration> {
    Ok(ReConfiguration {
        engine_address: config.remote.engine_address.clone(),
        cas_address: config.remote.cas_address.clone(),
        action_cache_address: config.remote.action_cache_address.clone(),
        instance_name: config.remote.instance_name.clone().unwrap_or_default(),
        tls: config.tls.enabled,
        tls_ca_certs: config.tls.ca_certs.clone(),
        tls_client_cert: config.tls.client_cert.clone(),
        grpc_keepalive_time_secs: config.grpc.keepalive_time_secs,
        grpc_keepalive_timeout_secs: config.grpc.keepalive_timeout_secs,
        grpc_keepalive_while_idle: config.grpc.keepalive_while_idle,
        max_decoding_message_size: config.grpc.max_decoding_message_size,
        ..Default::default()
    })
}

fn parse_digest(s: &str) -> Result<TDigest> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 2 {
        anyhow::bail!("Invalid digest format. Expected hash:size");
    }

    let hash = parts[0].to_string();
    let size_in_bytes = parts[1]
        .parse::<i64>()
        .context("Invalid size in digest")?;

    Ok(TDigest {
        hash,
        size_in_bytes,
        ..Default::default()
    })
}

fn compute_digest(data: &[u8]) -> TDigest {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();

    TDigest {
        hash: hex::encode(result),
        size_in_bytes: data.len() as i64,
        ..Default::default()
    }
}
