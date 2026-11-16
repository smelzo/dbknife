//! A SQLite value as it travels in JSON, in results and in query parameters.
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use rusqlite::types::{Value, ValueRef};
use serde::{Deserialize, Serialize};

use crate::protocol::Failure;

/// Largest integer a JSON number carries exactly for the app (JavaScript's safe range).
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub enum Cell {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    /// Base64 of a BLOB.
    Blob {
        b: String,
    },
    /// "inf" or "-inf": JSON has no infinite numbers.
    Infinity {
        f: String,
    },
}

impl Cell {
    pub fn from_sql(value: ValueRef<'_>) -> Cell {
        match value {
            ValueRef::Null => Cell::Null,
            ValueRef::Integer(i) if i.unsigned_abs() <= MAX_SAFE_INTEGER => Cell::Integer(i),
            ValueRef::Integer(i) => Cell::Text(i.to_string()),
            ValueRef::Real(f) if f.is_finite() => Cell::Real(f),
            ValueRef::Real(f) => Cell::Infinity {
                f: if f > 0.0 { "inf" } else { "-inf" }.to_owned(),
            },
            ValueRef::Text(t) => Cell::Text(String::from_utf8_lossy(t).into_owned()),
            ValueRef::Blob(b) => Cell::Blob {
                b: STANDARD.encode(b),
            },
        }
    }

    /// The value to bind. A string stays TEXT, also when it holds digits.
    pub fn into_sql(self) -> Result<Value, Failure> {
        Ok(match self {
            Cell::Null => Value::Null,
            Cell::Integer(i) => Value::Integer(i),
            Cell::Real(f) => Value::Real(f),
            Cell::Text(t) => Value::Text(t),
            Cell::Blob { b } => Value::Blob(STANDARD.decode(b).map_err(Failure::new)?),
            Cell::Infinity { f } => match f.as_str() {
                "inf" => Value::Real(f64::INFINITY),
                "-inf" => Value::Real(f64::NEG_INFINITY),
                _ => return Err(Failure::new(format!("Invalid number: {f}"))),
            },
        })
    }
}
