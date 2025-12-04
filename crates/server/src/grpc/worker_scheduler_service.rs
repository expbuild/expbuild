use crate::execution::WorkerScheduler;
use re_grpc_proto::expbuild::worker::v1::worker_scheduler_server::WorkerScheduler as WorkerSchedulerTrait;
use re_grpc_proto::expbuild::worker::v1::{
    HeartbeatRequest, HeartbeatResponse, LeaseTaskRequest, LeaseTaskResponse,
    RegisterWorkerRequest, RegisterWorkerResponse, UnregisterWorkerRequest,
    UnregisterWorkerResponse, UpdateTaskStatusRequest, UpdateTaskStatusResponse,
};
use std::sync::Arc;
use tonic::{Request, Response, Status};

pub struct WorkerSchedulerService {
    scheduler: Arc<WorkerScheduler>,
}

impl WorkerSchedulerService {
    pub fn new(scheduler: Arc<WorkerScheduler>) -> Self {
        Self { scheduler }
    }
}

#[tonic::async_trait]
impl WorkerSchedulerTrait for WorkerSchedulerService {
    async fn register_worker(
        &self,
        request: Request<RegisterWorkerRequest>,
    ) -> Result<Response<RegisterWorkerResponse>, Status> {
        let req = request.into_inner();

        self.scheduler
            .register_worker(req)
            .await
            .map(Response::new)
            .map_err(|e| Status::internal(e.to_string()))
    }

    async fn lease_task(
        &self,
        request: Request<LeaseTaskRequest>,
    ) -> Result<Response<LeaseTaskResponse>, Status> {
        let req = request.into_inner();

        self.scheduler
            .lease_task(req)
            .await
            .map(Response::new)
            .map_err(|e| Status::internal(e.to_string()))
    }

    async fn update_task_status(
        &self,
        request: Request<UpdateTaskStatusRequest>,
    ) -> Result<Response<UpdateTaskStatusResponse>, Status> {
        let req = request.into_inner();

        self.scheduler
            .update_task_status(req)
            .await
            .map(Response::new)
            .map_err(|e| Status::internal(e.to_string()))
    }

    async fn report_heartbeat(
        &self,
        request: Request<HeartbeatRequest>,
    ) -> Result<Response<HeartbeatResponse>, Status> {
        let req = request.into_inner();

        self.scheduler
            .report_heartbeat(req)
            .await
            .map(Response::new)
            .map_err(|e| Status::internal(e.to_string()))
    }

    async fn unregister_worker(
        &self,
        request: Request<UnregisterWorkerRequest>,
    ) -> Result<Response<UnregisterWorkerResponse>, Status> {
        let req = request.into_inner();

        self.scheduler
            .unregister_worker(req)
            .await
            .map(Response::new)
            .map_err(|e| Status::internal(e.to_string()))
    }
}
