use std::env;
use std::path::PathBuf;

use crate::protocol::Failure;

/// A path as the user types it: `~` alone or before a `/` is the home of the user the
/// helper runs as, like the app does for local files. Nothing else is expanded.
pub fn resolve(path: &str) -> Result<PathBuf, Failure> {
    let below_home = path
        .strip_prefix('~')
        .filter(|rest| rest.is_empty() || rest.starts_with('/'));
    let Some(rest) = below_home else {
        return Ok(PathBuf::from(path));
    };
    let mut resolved = env::var_os("HOME").ok_or_else(|| Failure::new("HOME is not set"))?;
    resolved.push(rest);
    Ok(PathBuf::from(resolved))
}
