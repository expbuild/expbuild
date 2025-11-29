use std::env::VarError;

use anyhow::Context;
use once_cell::sync::Lazy;
use regex::Regex;
use tonic::transport::Uri;

pub(crate) fn prepare_uri(uri: Uri, tls: bool) -> anyhow::Result<Uri> {
    match uri.scheme_str() {
        Some("grpc") | Some("dns") | Some("ipv4") | Some("ipv6") | None => {}
        Some(scheme) => {
            return Err(anyhow::anyhow!(
                "Invalid URI scheme: `{}` for `{}` (you should omit it)",
                scheme,
                uri,
            ));
        }
    };

    let mut parts = uri.into_parts();
    parts.scheme = Some(if tls {
        http::uri::Scheme::HTTPS
    } else {
        http::uri::Scheme::HTTP
    });

    if parts.path_and_query.is_none() {
        parts.path_and_query = Some(http::uri::PathAndQuery::from_static(""));
    }

    Ok(Uri::from_parts(parts)?)
}

pub(crate) fn substitute_env_vars(s: &str) -> anyhow::Result<String> {
    substitute_env_vars_impl(s, |v| std::env::var(v))
}

pub(crate) fn substitute_env_vars_impl(
    s: &str,
    getter: impl Fn(&str) -> Result<String, VarError>,
) -> anyhow::Result<String> {
    static ENV_REGEX: Lazy<Regex> = Lazy::new(|| Regex::new("\\$[a-zA-Z_][a-zA-Z_0-9]*").unwrap());

    let mut out = String::with_capacity(s.len());
    let mut last_idx = 0;

    for mat in ENV_REGEX.find_iter(s) {
        out.push_str(&s[last_idx..mat.start()]);
        let var = &mat.as_str()[1..];
        let val = getter(var).with_context(|| format!("Error substituting `{}`", mat.as_str()))?;
        out.push_str(&val);
        last_idx = mat.end();
    }

    if last_idx < s.len() {
        out.push_str(&s[last_idx..s.len()]);
    }

    Ok(out)
}
