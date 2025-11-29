use anyhow::Context;

#[cfg(feature = "tls")]
use tonic::transport::{Certificate, Identity};
#[cfg(feature = "tls")]
use tonic::transport::channel::ClientTlsConfig;

use crate::config::*;
use super::uri::substitute_env_vars;

#[cfg(feature = "tls")]
pub(crate) async fn create_tls_config(opts: &ReConfiguration) -> anyhow::Result<ClientTlsConfig> {
    let config = ClientTlsConfig::new().with_enabled_roots();

    let config = match opts.tls_ca_certs.as_ref() {
        Some(tls_ca_certs) => {
            let tls_ca_certs =
                substitute_env_vars(tls_ca_certs).context("Invalid `tls_ca_certs`")?;
            let data = tokio::fs::read(&tls_ca_certs)
                .await
                .with_context(|| format!("Error reading `{tls_ca_certs}`"))?;
            config.ca_certificate(Certificate::from_pem(data))
        }
        None => {
            config
        }
    };

    let config = match opts.tls_client_cert.as_ref() {
        Some(tls_client_cert) => {
            let tls_client_cert =
                substitute_env_vars(tls_client_cert).context("Invalid `tls_client_cert`")?;
            let data = tokio::fs::read(&tls_client_cert)
                .await
                .with_context(|| format!("Error reading `{tls_client_cert}`"))?;
            config.identity(Identity::from_pem(&data, &data))
        }
        None => config,
    };

    Ok(config)
}
