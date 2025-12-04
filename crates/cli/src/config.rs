use anyhow::{Context, Result};
use std::fs;
use std::path::Path;

use crate::cli::Config;

pub fn load_config(path: &Path) -> Result<Config> {
    let contents = fs::read_to_string(path)
        .with_context(|| format!("Failed to read config file: {}", path.display()))?;

    let config: Config = toml::from_str(&contents)
        .with_context(|| format!("Failed to parse config file: {}", path.display()))?;

    Ok(config)
}

pub fn find_default_config() -> Option<std::path::PathBuf> {
    let locations = vec![
        std::env::current_dir().ok()?.join("configs/client/expbuild.toml"),
        std::env::current_dir().ok()?.join("expbuild.toml"),
        std::env::current_dir().ok()?.join(".expbuild.toml"),
        dirs::home_dir()?.join(".config/expbuild/config.toml"),
        dirs::home_dir()?.join(".expbuild.toml"),
    ];

    locations.into_iter().find(|p| p.exists())
}

fn dirs_home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .and_then(|h| if h.is_empty() { None } else { Some(h) })
        .map(std::path::PathBuf::from)
}

mod dirs {
    pub fn home_dir() -> Option<std::path::PathBuf> {
        super::dirs_home_dir()
    }
}
