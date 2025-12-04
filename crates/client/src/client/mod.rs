mod builder;
mod capabilities;
mod compression;
mod download;
mod execution;
mod helpers;
mod interceptor;
mod main_client;
mod tls;
mod types;
mod upload;
mod uri;

#[cfg(test)]
mod tests;

pub use builder::REClientBuilder;
pub use compression::Compressor;
pub use main_client::REClient;

