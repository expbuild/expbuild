use std::collections::BTreeMap;

pub type TPlatform = crate::grpc::Platform;
pub type TProperty = crate::grpc::Property;

#[derive(Clone, Default)]
pub struct ActionHistoryInfo {
    pub action_key: String,
    pub disable_retry_on_oom: bool,
    pub _dot_dot: (),
}

#[derive(Clone, Default)]
pub struct InvocationInfo {
    pub build_id: String,
    pub version: String,
    pub _dot_dot: (),
}

#[derive(Clone, Default)]
pub struct TClientContextMetadata {
    pub attributes: BTreeMap<String, String>,
    pub _dot_dot: (),
}

#[derive(Clone, Default)]
pub struct RemoteExecutionMetadata {
    pub action_history_info: Option<ActionHistoryInfo>,
    pub invocation_info: Option<InvocationInfo>,
    pub platform: Option<TPlatform>,
    pub use_case_id: String,
    pub do_not_cache: bool,
    pub respect_file_symlinks: Option<bool>,
    pub client_context: Option<TClientContextMetadata>,
    pub _dot_dot: (),
}
