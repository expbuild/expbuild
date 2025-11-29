use tonic::codegen::InterceptedService;
use tonic::transport::Channel;
use re_grpc_proto::build::bazel::remote::execution::v2::content_addressable_storage_client::ContentAddressableStorageClient;
use re_grpc_proto::build::bazel::remote::execution::v2::execution_client::ExecutionClient;
use re_grpc_proto::build::bazel::remote::execution::v2::action_cache_client::ActionCacheClient;
use re_grpc_proto::google::bytestream::byte_stream_client::ByteStreamClient;

use super::interceptor::InjectHeadersInterceptor;

pub(crate) type GrpcService = InterceptedService<Channel, InjectHeadersInterceptor>;

#[derive(Clone)]
pub(crate) struct GRPCClients {
    pub(crate) cas_client: ContentAddressableStorageClient<GrpcService>,
    pub(crate) execution_client: ExecutionClient<GrpcService>,
    pub(crate) action_cache_client: ActionCacheClient<GrpcService>,
    pub(crate) bytestream_client: ByteStreamClient<GrpcService>,
}

#[derive(Clone)]
pub(crate) struct InstanceName(pub(crate) Option<String>);

impl InstanceName {
    pub(crate) fn as_str(&self) -> &str {
        match &self.0 {
            Some(instance_name) => instance_name,
            None => "",
        }
    }

    pub(crate) fn as_resource_prefix(&self) -> String {
        match &self.0 {
            Some(instance_name) => format!("{instance_name}/"),
            None => "".to_owned(),
        }
    }
}

#[derive(Clone)]
pub struct RERuntimeOpts {
    pub(crate) use_fbcode_metadata: bool,
    pub(crate) max_concurrent_uploads_per_action: Option<usize>,
    pub(crate) cas_ttl_secs: i64,
}
