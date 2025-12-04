use anyhow::{Context, Result};
use remote_execution::*;

use crate::cli::{Commands, Config};

pub async fn execute_command(cmd: Commands, config: Config) -> Result<()> {
    let re_config = build_re_config(&config)?;
    let client = REClientBuilder::build_and_connect(&re_config).await?;

    match cmd {
        Commands::Execute {
            action_digest,
            skip_cache: _,
            instance_name: _,
            output,
        } => {
            println!("Executing action: {}", action_digest);
            let digest = parse_digest(&action_digest)?;

            let metadata = RemoteExecutionMetadata::default();
            let executor = remote_execution::action::ActionExecutor::new(client);

            let result = executor
                .execute_action_digest(digest, output, metadata, |progress| {
                    println!("Stage: {:?}", progress.stage);
                })
                .await?;

            println!("Exit code: {}", result.exit_code);
            
            if !result.stdout.is_empty() {
                println!("\n--- STDOUT ---");
                println!("{}", String::from_utf8_lossy(&result.stdout));
            }
            
            if !result.stderr.is_empty() {
                println!("\n--- STDERR ---");
                eprintln!("{}", String::from_utf8_lossy(&result.stderr));
            }

            if result.cached_result {
                println!("\n✓ Result was cached");
            }

            println!("\nOutput files: {}", result.output_files.len());
            for file in &result.output_files {
                println!("  - {} ({})", file.path, file.digest);
            }

            println!("Output directories: {}", result.output_directories.len());
            for dir in &result.output_directories {
                println!("  - {} ({})", dir.path, dir.tree_digest);
            }

            println!("\nExecution completed successfully");
        }

        Commands::Run {
            command,
            args,
            input,
            output,
            output_paths,
            env,
            working_dir,
            skip_cache,
            timeout,
            instance_name: _,
        } => {
            println!("Running command: {} {:?}", command, args);

            let mut command_spec = remote_execution::action::CommandSpec::new(command, args);

            for env_var in env {
                if let Some((key, value)) = env_var.split_once('=') {
                    command_spec = command_spec.with_env(key.to_string(), value.to_string());
                } else {
                    anyhow::bail!("Invalid environment variable format: {}. Expected KEY=VALUE", env_var);
                }
            }

            for output_path in output_paths {
                command_spec = command_spec.with_output_path(output_path);
            }

            if let Some(wd) = working_dir {
                command_spec = command_spec.with_working_directory(wd);
            }

            let execution_request = remote_execution::action::ExecutionRequest {
                command_spec,
                input_directory: input,
                output_directory: output.clone(),
                skip_cache_lookup: skip_cache,
                timeout: timeout.map(std::time::Duration::from_secs),
            };

            let metadata = RemoteExecutionMetadata::default();
            let executor = remote_execution::action::ActionExecutor::new(client);

            let result = executor
                .execute(execution_request, metadata, |progress| {
                    println!("Stage: {:?}", progress.stage);
                })
                .await?;

            println!("\n=== Execution Result ===");
            println!("Exit code: {}", result.exit_code);
            
            if !result.stdout.is_empty() {
                println!("\n--- STDOUT ---");
                println!("{}", String::from_utf8_lossy(&result.stdout));
            }
            
            if !result.stderr.is_empty() {
                println!("\n--- STDERR ---");
                eprintln!("{}", String::from_utf8_lossy(&result.stderr));
            }

            if result.cached_result {
                println!("\n✓ Result was cached");
            }

            println!("\nOutput files: {}", result.output_files.len());
            for file in &result.output_files {
                println!("  - {} ({} bytes)", file.path, file.size_bytes);
            }

            println!("Output directories: {}", result.output_directories.len());
            for dir in &result.output_directories {
                println!("  - {}", dir.path);
            }

            println!("\nOutputs saved to: {}", output.display());
            println!("Execution completed successfully");
        }

        Commands::PrepareAction {
            command,
            args,
            input,
            output_paths,
            env,
            working_dir,
            dry_run,
            timeout,
        } => {
            println!("Preparing action for command: {} {:?}", command, args);

            let mut command_spec = remote_execution::action::CommandSpec::new(command, args);

            for env_var in env {
                if let Some((key, value)) = env_var.split_once('=') {
                    command_spec = command_spec.with_env(key.to_string(), value.to_string());
                } else {
                    anyhow::bail!("Invalid environment variable format: {}. Expected KEY=VALUE", env_var);
                }
            }

            for output_path in output_paths {
                command_spec = command_spec.with_output_path(output_path);
            }

            if let Some(wd) = working_dir {
                command_spec = command_spec.with_working_directory(wd);
            }

            let input_root_digest = if let Some(ref input_dir) = input {
                println!("Scanning input directory: {}", input_dir.display());
                let mut dir_builder = remote_execution::action::DirectoryBuilder::from_directory(input_dir).await?;
                dir_builder.build()?
            } else {
                let empty_dir = remote_execution::action::DirectoryBuilder::new();
                empty_dir.root_digest().unwrap_or_default()
            };

            let action_builder = remote_execution::action::ActionBuilder::new(command_spec)
                .with_input_root(input_root_digest)
                .with_timeout(timeout.map(std::time::Duration::from_secs).unwrap_or(std::time::Duration::from_secs(600)));

            let (command, command_digest) = action_builder.build_command()?;
            println!("Command digest: {}", command_digest);

            let (action, action_digest) = action_builder.build_action(command_digest.clone())?;
            println!("Action digest: {}", action_digest);

            if !dry_run {
                println!("\nUploading to remote execution service...");
                let metadata = RemoteExecutionMetadata::default();
                
                client.upload_command(command, metadata.clone()).await?;
                println!("✓ Command uploaded");
                
                if let Some(ref input_dir) = input {
                    let mut dir_builder = remote_execution::action::DirectoryBuilder::from_directory(input_dir).await?;
                    dir_builder.build()?;
                    
                    client.upload_directory_tree(
                        dir_builder.directories_to_upload(),
                        dir_builder.files_to_upload().to_vec(),
                        metadata.clone(),
                    ).await?;
                    println!("✓ Input files uploaded");
                }
                
                client.upload_action(action, metadata).await?;
                println!("✓ Action uploaded");
                
                println!("\nAction is ready for execution!");
            }

            println!("\nTo execute this action, run:");
            println!("  expbuild execute --action-digest {}", action_digest);
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
