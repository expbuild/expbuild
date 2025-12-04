pub mod action;
mod client;
mod config;
mod digest;
mod error;
mod grpc;
mod metadata;
mod request;
mod response;
mod stats;

use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;

pub use client::*;
pub use config::*;
pub use error::*;
pub use grpc::*;
pub use metadata::*;
pub use request::*;
pub use response::*;

/// The global version of the network stats full of atomics
#[derive(Default, Debug)]
struct NetworkStatisticsGlobal {
    uploaded: AtomicI64,
    downloaded: AtomicI64,
}

static NETWORK_STATS: OnceLock<Arc<NetworkStatisticsGlobal>> = OnceLock::new();

fn get_network_stats_global() -> Arc<NetworkStatisticsGlobal> {
    Arc::clone(NETWORK_STATS.get_or_init(|| Arc::new(NetworkStatisticsGlobal::default())))
}

pub fn get_network_stats() -> anyhow::Result<NetworkStatisticsResponse> {
    let g = get_network_stats_global();
    Ok(NetworkStatisticsResponse {
        uploaded: g.uploaded.load(Ordering::Relaxed),
        downloaded: g.downloaded.load(Ordering::Relaxed),
        ..Default::default()
    })
}
