//! JSON lines exchanged with the app: one request per line on stdin, one
//! response per line on stdout, in the same order.
use serde::{Deserialize, Serialize};

use crate::cell::Cell;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    Open {
        file: String,
        busy_timeout_ms: u64,
    },
    Execute {
        sql: String,
        begin: bool,
    },
    Query {
        sql: String,
        #[serde(default)]
        params: Vec<Cell>,
    },
    Commit,
    Status,
    List {
        path: String,
    },
}

/// The fields of a response next to its `id`.
#[derive(Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum Reply {
    Opened {},
    Execute {
        columns: Vec<Column>,
        rows: Vec<Vec<Cell>>,
        changes: u64,
        last_insert_rowid: i64,
        duration_ms: f64,
    },
    Query {
        columns: Vec<String>,
        rows: Vec<Vec<Cell>>,
    },
    Commit {
        committed: bool,
    },
    Status {
        transaction: bool,
    },
    List {
        path: String,
        entries: Vec<Entry>,
    },
    Error {
        error: Failure,
    },
}

/// A result column with its origin, as node:sqlite's StatementSync.columns() reports it.
#[derive(Serialize)]
pub struct Column {
    pub name: String,
    pub column: Option<String>,
    pub table: Option<String>,
    pub database: Option<String>,
    #[serde(rename = "type")]
    pub decl_type: Option<String>,
}

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub dir: bool,
    pub size: u64,
}

/// `code` and `errno` are set for SQLite errors only.
#[derive(Serialize)]
pub struct Failure {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errno: Option<i32>,
}

impl Failure {
    pub fn new(message: impl ToString) -> Self {
        Failure {
            message: message.to_string(),
            code: None,
            errno: None,
        }
    }
}

impl From<std::io::Error> for Failure {
    fn from(err: std::io::Error) -> Self {
        Failure::new(err)
    }
}
