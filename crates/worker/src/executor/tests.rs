#[cfg(test)]
mod tests {
    use crate::executor::*;
    use std::time::Duration;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_host_executor_basic() {
        let config = HostExecutorConfig::default();
        let executor = HostExecutor::new(config);

        let temp_dir = TempDir::new().unwrap();
        let work_dir = temp_dir.path().to_path_buf();

        let command = re_grpc_proto::build::bazel::remote::execution::v2::Command {
            arguments: vec!["echo".to_string(), "Hello, World!".to_string()],
            environment_variables: vec![],
            output_paths: vec![],
            working_directory: String::new(),
            output_directory_format: 0,
            output_node_properties: vec![],
            ..Default::default()
        };

        let request = ExecutionRequest {
            command,
            work_dir,
            timeout: Duration::from_secs(10),
            resource_limits: ResourceLimits::default(),
        };

        let result = executor.execute(request).await;
        assert!(result.is_ok());

        let result = result.unwrap();
        assert_eq!(result.exit_code, 0);
        assert!(String::from_utf8_lossy(&result.stdout).contains("Hello, World!"));
    }

    #[tokio::test]
    async fn test_host_executor_capabilities() {
        let config = HostExecutorConfig::default();
        let executor = HostExecutor::new(config);

        let caps = executor.capabilities();
        assert_eq!(caps.isolation_level, IsolationLevel::None);
        assert!(!caps.supports_cpu_limit);
        assert!(!caps.supports_memory_limit);
    }

    #[tokio::test]
    async fn test_host_executor_health_check() {
        let config = HostExecutorConfig::default();
        let executor = HostExecutor::new(config);

        let result = executor.health_check().await;
        assert!(result.is_ok());
    }

    #[test]
    fn test_isolation_level_ordering() {
        assert!(IsolationLevel::None < IsolationLevel::Container);
        assert!(IsolationLevel::Container < IsolationLevel::VM);
    }

    #[test]
    fn test_resource_limits_default() {
        let limits = ResourceLimits::default();
        assert!(limits.cpu_cores.is_none());
        assert!(limits.memory_bytes.is_none());
        assert!(matches!(limits.network, NetworkPolicy::None));
    }
}
