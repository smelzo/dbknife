use std::fs;

use crate::path;
use crate::protocol::{Entry, Failure, Reply};

/// The content of a directory, folders first; an empty path is the user's home.
pub fn list(path: &str) -> Result<Reply, Failure> {
    let dir = fs::canonicalize(path::resolve(if path.is_empty() { "~" } else { path })?)?;
    let mut entries: Vec<Entry> = fs::read_dir(&dir)?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            // metadata() follows symbolic links; an entry it cannot read is left out
            let meta = fs::metadata(entry.path()).ok()?;
            Some(Entry {
                name: entry.file_name().to_string_lossy().into_owned(),
                dir: meta.is_dir(),
                size: meta.len(),
            })
        })
        .collect();
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.cmp(&b.name)));
    Ok(Reply::List {
        path: dir.to_string_lossy().into_owned(),
        entries,
    })
}
