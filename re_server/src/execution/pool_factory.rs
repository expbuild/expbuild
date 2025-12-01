use crate::cas::CasManager;
use crate::config::{ExecutionConfig, WorkerConfig};
use crate::execution::{
    worker_pool::WorkerPoolConfig as PoolConfig, DefaultWorkerPool, DockerWorker, DynWorkerPool,
    HostWorker,
};
use anyhow::Result;
use std::sync::Arc;
use std::time::Duration;

pub async fn create_worker_pool_from_config(
    config: &ExecutionConfig,
    cas_manager: Arc<CasManager>,
) -> Result<Option<DynWorkerPool>> {
    let pool_config = match &config.pool {
        Some(cfg) => cfg,
        None => {
            tracing::info!("No worker pool configured");
            return Ok(None);
        }
    };

    let pool_cfg = PoolConfig {
        max_queue_size: pool_config.max_queue_size,
        scheduler_interval: Duration::from_millis(pool_config.scheduler_interval_ms),
        default_task_timeout: Duration::from_secs(pool_config.default_task_timeout_seconds),
        result_ttl: Duration::from_secs(pool_config.result_ttl_seconds),
    };

    let pool = DefaultWorkerPool::new(cas_manager.clone(), pool_cfg);

    let mut worker_id_counter = 0;

    for worker_config in &pool_config.workers {
        match worker_config {
            WorkerConfig::Host {
                count,
                work_dir,
                use_chroot,
                env_whitelist,
                run_as_user,
                run_as_group,
            } => {
                tracing::info!("Creating {} host workers", count);

                for _ in 0..*count {
                    worker_id_counter += 1;
                    let worker_id = format!("host-worker-{}", worker_id_counter);

                    let host_config = crate::execution::host_worker::HostWorkerConfig {
                        work_dir: work_dir.clone(),
                        use_chroot: *use_chroot,
                        env_whitelist: env_whitelist.clone(),
                        run_as_user: run_as_user.clone(),
                        run_as_group: run_as_group.clone(),
                    };

                    let worker = Arc::new(HostWorker::new(
                        worker_id.clone(),
                        host_config,
                        cas_manager.clone(),
                    ));

                    pool.register_worker(worker).await?;
                    tracing::info!("Registered host worker: {}", worker_id);
                }
            }
            WorkerConfig::Docker {
                count,
                image,
                always_pull,
                cpu_limit,
                memory_limit,
                network_mode,
                volumes,
                user,
            } => {
                tracing::info!("Creating {} docker workers", count);

                for _ in 0..*count {
                    worker_id_counter += 1;
                    let worker_id = format!("docker-worker-{}", worker_id_counter);

                    let docker_volumes: Vec<crate::execution::docker_worker::VolumeMount> = volumes
                        .iter()
                        .map(|v| crate::execution::docker_worker::VolumeMount {
                            host_path: v.host_path.clone(),
                            container_path: v.container_path.clone(),
                            read_only: v.read_only,
                        })
                        .collect();

                    let docker_config = crate::execution::docker_worker::DockerWorkerConfig {
                        image: image.clone(),
                        always_pull: *always_pull,
                        cpu_limit: *cpu_limit,
                        memory_limit: *memory_limit,
                        network_mode: network_mode.clone(),
                        volumes: docker_volumes,
                        user: user.clone(),
                        docker_host: None,
                    };

                    let worker = Arc::new(DockerWorker::new(
                        worker_id.clone(),
                        docker_config,
                        cas_manager.clone(),
                    ));

                    pool.register_worker(worker).await?;
                    tracing::info!("Registered docker worker: {}", worker_id);
                }
            }
        }
    }

    pool.start().await;
    tracing::info!("Worker pool started with {} workers", worker_id_counter);

    Ok(Some(pool))
}
