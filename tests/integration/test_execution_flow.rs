use expbuild_integration_tests::{ServerHarness, WorkerHarness, TestClientFactory};
use anyhow::{Context, Result};
use prost::Message;
use re_grpc_proto::build::bazel::remote::execution::v2::{Action, Command, ExecuteRequest};
use futures::StreamExt;

#[tokio::test]
async fn test_simple_echo_command_execution() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info,expbuild=debug,re_server=debug,expbuild_worker=debug")
        .try_init()
        .ok();

    let server = ServerHarness::start().await?;
    let _worker = WorkerHarness::start(&server.url(), &server.url()).await?;
    let client = TestClientFactory::create_re_client(&server.url()).await?;

    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

    let command = Command {
        arguments: vec!["sh".to_string(), "-c".to_string(), "echo 'Hello from worker!'".to_string()],
        output_paths: vec![],
        output_files: vec![],
        output_directories: vec![],
        environment_variables: vec![],
        platform: None,
        working_directory: String::new(),
        output_node_properties: vec![],
        output_directory_format: 0,
    };

    let mut command_buf = Vec::new();
    command.encode(&mut command_buf)?;
    let command_digest = client.upload_blob(command_buf).await?;
    
    tracing::info!("Command digest: {}/{}", command_digest.hash, command_digest.size_bytes);

    let empty_dir_digest = {
        let empty_dir = re_grpc_proto::build::bazel::remote::execution::v2::Directory {
            files: vec![],
            directories: vec![],
            symlinks: vec![],
            node_properties: None,
        };
        let mut buf = Vec::new();
        empty_dir.encode(&mut buf)?;
        client.upload_blob(buf).await?
    };

    let action = Action {
        command_digest: Some(command_digest.clone()),
        input_root_digest: Some(empty_dir_digest),
        timeout: None,
        do_not_cache: true,
        salt: vec![],
        platform: None,
    };

    let mut action_buf = Vec::new();
    action.encode(&mut action_buf)?;
    let action_digest = client.upload_blob(action_buf).await?;
    
    tracing::info!("Action digest: {}/{}", action_digest.hash, action_digest.size_bytes);

    let execute_request = ExecuteRequest {
        instance_name: "test".to_string(),
        skip_cache_lookup: true,
        action_digest: Some(action_digest),
        execution_policy: None,
        results_cache_policy: None,
        digest_function: 0,
        inline_output_files: vec![],
        inline_stderr: false,
        inline_stdout: false,
    };

    tracing::info!("Submitting execution request");
    
    let metadata = remote_execution::RemoteExecutionMetadata::default();
    let mut response_stream = client.execute_with_progress(
        metadata,
        remote_execution::ExecuteRequest {
            action_digest: remote_execution::TDigest {
                hash: execute_request.action_digest.as_ref().unwrap().hash.clone(),
                size_in_bytes: execute_request.action_digest.as_ref().unwrap().size_bytes,
                _dot_dot: (),
            },
            skip_cache_lookup: execute_request.skip_cache_lookup,
            ..Default::default()
        },
    ).await?;

    let mut final_result = None;
    while let Some(progress) = response_stream.next().await {
        let progress = progress?;
        tracing::info!("Execution progress: stage={:?}, cached={}", 
            progress.stage, progress.execute_response.as_ref().map(|r| r.cached_result).unwrap_or(false));
        
        if let Some(exec_response) = progress.execute_response {
            final_result = Some(exec_response.action_result);
        }
    }

    let result = final_result.expect("Should have received execution result");
    
    tracing::info!("Execution completed with exit code: {}", result.exit_code);
    assert_eq!(result.exit_code, 0, "Command should succeed");
    
    let stdout = result.stdout_raw.as_ref().map(|v| String::from_utf8_lossy(v).to_string()).unwrap_or_default();
    tracing::info!("stdout: {}", stdout);
    assert!(stdout.contains("Hello from worker!"), "stdout should contain expected message");

    server.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn test_command_with_file_output() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info,expbuild=debug,re_server=debug,expbuild_worker=debug")
        .try_init()
        .ok();

    let server = ServerHarness::start().await?;
    let _worker = WorkerHarness::start(&server.url(), &server.url()).await?;
    let client = TestClientFactory::create_re_client(&server.url()).await?;

    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

    let command = Command {
        arguments: vec![
            "sh".to_string(), 
            "-c".to_string(), 
            "echo 'test output' > output.txt".to_string()
        ],
        output_paths: vec!["output.txt".to_string()],
        output_files: vec!["output.txt".to_string()],
        output_directories: vec![],
        environment_variables: vec![],
        platform: None,
        working_directory: String::new(),
        output_node_properties: vec![],
        output_directory_format: 0,
    };

    let mut command_buf = Vec::new();
    command.encode(&mut command_buf)?;
    let command_digest = client.upload_blob(command_buf).await?;

    let empty_dir_digest = {
        let empty_dir = re_grpc_proto::build::bazel::remote::execution::v2::Directory {
            files: vec![],
            directories: vec![],
            symlinks: vec![],
            node_properties: None,
        };
        let mut buf = Vec::new();
        empty_dir.encode(&mut buf)?;
        client.upload_blob(buf).await?
    };

    let action = Action {
        command_digest: Some(command_digest),
        input_root_digest: Some(empty_dir_digest),
        timeout: None,
        do_not_cache: false,
        salt: vec![],
        platform: None,
    };

    let mut action_buf = Vec::new();
    action.encode(&mut action_buf)?;
    let action_digest = client.upload_blob(action_buf).await?;

    tracing::info!("Executing command with file output");
    
    let metadata = remote_execution::RemoteExecutionMetadata::default();
    let mut response_stream = client.execute_with_progress(
        metadata,
        remote_execution::ExecuteRequest {
            action_digest: remote_execution::TDigest {
                hash: action_digest.hash.clone(),
                size_in_bytes: action_digest.size_bytes,
                _dot_dot: (),
            },
            skip_cache_lookup: false,
            ..Default::default()
        },
    ).await?;

    let mut final_result = None;
    while let Some(progress) = response_stream.next().await {
        let progress = progress?;
        if let Some(exec_response) = progress.execute_response {
            final_result = Some(exec_response.action_result);
        }
    }

    let result = final_result.expect("Should have received execution result");
    
    assert_eq!(result.exit_code, 0, "Command should succeed");
    assert_eq!(result.output_files.len(), 1, "Should have 1 output file");
    
    let output_file = &result.output_files[0];
    assert_eq!(output_file.name, "output.txt");
    
    let output_digest = &output_file.digest.digest;
    let grpc_digest = re_grpc_proto::build::bazel::remote::execution::v2::Digest {
        hash: output_digest.hash.clone(),
        size_bytes: output_digest.size_in_bytes,
    };
    let output_content = client.download_blob(&grpc_digest).await?;
    let output_text = String::from_utf8_lossy(&output_content);
    
    tracing::info!("Output file content: {}", output_text);
    assert!(output_text.contains("test output"));

    server.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn test_command_failure_handling() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info,expbuild=debug,re_server=debug,expbuild_worker=debug")
        .try_init()
        .ok();

    let server = ServerHarness::start().await?;
    let _worker = WorkerHarness::start(&server.url(), &server.url()).await?;
    let client = TestClientFactory::create_re_client(&server.url()).await?;

    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

    let command = Command {
        arguments: vec!["sh".to_string(), "-c".to_string(), "exit 42".to_string()],
        output_paths: vec![],
        output_files: vec![],
        output_directories: vec![],
        environment_variables: vec![],
        platform: None,
        working_directory: String::new(),
        output_node_properties: vec![],
        output_directory_format: 0,
    };

    let mut command_buf = Vec::new();
    command.encode(&mut command_buf)?;
    let command_digest = client.upload_blob(command_buf).await?;

    let empty_dir_digest = {
        let empty_dir = re_grpc_proto::build::bazel::remote::execution::v2::Directory {
            files: vec![],
            directories: vec![],
            symlinks: vec![],
            node_properties: None,
        };
        let mut buf = Vec::new();
        empty_dir.encode(&mut buf)?;
        client.upload_blob(buf).await?
    };

    let action = Action {
        command_digest: Some(command_digest),
        input_root_digest: Some(empty_dir_digest),
        timeout: None,
        do_not_cache: true,
        salt: vec![],
        platform: None,
    };

    let mut action_buf = Vec::new();
    action.encode(&mut action_buf)?;
    let action_digest = client.upload_blob(action_buf).await?;

    tracing::info!("Executing failing command");
    
    let metadata = remote_execution::RemoteExecutionMetadata::default();
    let mut response_stream = client.execute_with_progress(
        metadata,
        remote_execution::ExecuteRequest {
            action_digest: remote_execution::TDigest {
                hash: action_digest.hash,
                size_in_bytes: action_digest.size_bytes,
                _dot_dot: (),
            },
            skip_cache_lookup: true,
            ..Default::default()
        },
    ).await?;

    let mut final_result = None;
    while let Some(progress) = response_stream.next().await {
        let progress = progress?;
        if let Some(exec_response) = progress.execute_response {
            final_result = Some(exec_response.action_result);
        }
    }

    let result = final_result.expect("Should have received execution result");
    
    tracing::info!("Command failed with exit code: {}", result.exit_code);
    assert_eq!(result.exit_code, 42, "Should capture non-zero exit code");

    server.shutdown().await?;
    Ok(())
}
