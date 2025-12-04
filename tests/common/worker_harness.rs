use anyhow::{Context, Result};
use expbuild_worker::{WorkerAgent, WorkerConfig};
use std::collections::HashMap;
use tokio::task::JoinHandle;

pub struct WorkerHarness {
    worker_handle: JoinHandle<Result<()>>,
    worker_id: String,
}

impl WorkerHarness {
    pub async fn start(server_url: &str, cas_url: &str) -> Result<Self> {
        let worker_id = format!("test-worker-{}", uuid::Uuid::new_v4());
        
        // Scheduler client needs http:// prefix
        let server_url_with_scheme = if !server_url.starts_with("http://") && !server_url.starts_with("https://") {
            format!("http://{}", server_url)
        } else {
            server_url.to_string()
        };
        
        // REClient doesn't want http:// prefix
        let cas_url_no_scheme = cas_url
            .strip_prefix("http://")
            .or_else(|| cas_url.strip_prefix("https://"))
            .unwrap_or(cas_url);
        
        let config = WorkerConfig {
            worker_id: Some(worker_id.clone()),
            server_url: server_url_with_scheme,
            cas_url: cas_url_no_scheme.to_string(),
            work_dir: std::env::temp_dir().join("expbuild-test-worker"),
            max_concurrent_tasks: 2,
            heartbeat_interval_seconds: 5,
            lease_poll_interval_seconds: 1,
            platform: expbuild_worker::config::PlatformConfig {
                properties: {
                    let mut props = HashMap::new();
                    props.insert("os".to_string(), std::env::consts::OS.to_string());
                    props.insert("arch".to_string(), std::env::consts::ARCH.to_string());
                    props
                },
            },
            executor: expbuild_worker::config::ExecutorBackend::Host(
                expbuild_worker::HostExecutorConfig {
                    env_whitelist: vec!["PATH".to_string(), "HOME".to_string()],
                    cleanup_workspace: true,
                }
            ),
        };

        let worker_id_clone = worker_id.clone();
        let worker_handle = tokio::spawn(async move {
            match WorkerAgent::new(config).await {
                Ok(mut agent) => {
                    tracing::info!("Test worker {} created successfully", worker_id_clone);
                    match agent.run().await {
                        Ok(()) => {
                            tracing::info!("Test worker {} completed", worker_id_clone);
                            Ok(())
                        }
                        Err(e) => {
                            tracing::error!("Test worker {} run failed: {}", worker_id_clone, e);
                            Err(e).context("Worker run failed")
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("Failed to create worker agent {}: {}", worker_id_clone, e);
                    Err(e).context("Failed to create worker agent")
                }
            }
        });

        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

        Ok(Self {
            worker_handle,
            worker_id,
        })
    }

    pub fn worker_id(&self) -> &str {
        &self.worker_id
    }

    pub async fn shutdown(self) -> Result<()> {
        self.worker_handle.abort();
        Ok(())
    }
}

impl Drop for WorkerHarness {
    fn drop(&mut self) {
        self.worker_handle.abort();
    }
}
