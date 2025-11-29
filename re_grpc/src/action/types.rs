use std::collections::HashMap;
use std::time::Duration;

use crate::digest::TDigest;

#[derive(Debug, Clone)]
pub struct CommandSpec {
    pub arguments: Vec<String>,
    pub environment_variables: Vec<(String, String)>,
    pub output_paths: Vec<String>,
    pub working_directory: Option<String>,
}

impl CommandSpec {
    pub fn new(command: String, args: Vec<String>) -> Self {
        let mut arguments = vec![command];
        arguments.extend(args);

        Self {
            arguments,
            environment_variables: Vec::new(),
            output_paths: Vec::new(),
            working_directory: None,
        }
    }

    pub fn with_env(mut self, key: String, value: String) -> Self {
        self.environment_variables.push((key, value));
        self
    }

    pub fn with_output_path(mut self, path: String) -> Self {
        self.output_paths.push(path);
        self
    }

    pub fn with_working_directory(mut self, dir: String) -> Self {
        self.working_directory = Some(dir);
        self
    }
}

#[derive(Debug, Clone)]
pub struct OutputFileInfo {
    pub path: String,
    pub digest: TDigest,
    pub size_bytes: i64,
    pub is_executable: bool,
}

#[derive(Debug, Clone)]
pub struct OutputDirectoryInfo {
    pub path: String,
    pub tree_digest: TDigest,
}

#[derive(Debug, Clone, Default)]
pub struct ExecutionMetadata {
    pub worker: String,
    pub queued_duration: Duration,
    pub input_fetch_duration: Duration,
    pub execution_duration: Duration,
    pub output_upload_duration: Duration,
}

#[derive(Debug, Clone)]
pub struct PlatformSpec {
    pub properties: HashMap<String, String>,
}
