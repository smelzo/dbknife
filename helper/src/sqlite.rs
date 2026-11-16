//! The operations on the database, with the results node:sqlite gives the local driver.
use std::borrow::Cow;
use std::cell::RefCell;
use std::time::{Duration, Instant};

use regex::Regex;
use rusqlite::fallible_iterator::FallibleIterator;
use rusqlite::functions::{Context, FunctionFlags};
use rusqlite::types::ValueRef;
use rusqlite::{Batch, Connection, Error, OpenFlags, Statement, ffi};

use crate::cell::Cell;
use crate::protocol::{Column, Failure, Reply};

impl From<Error> for Failure {
    /// SQLite's own message and extended code: the Display of rusqlite's errors adds text.
    fn from(err: Error) -> Self {
        let (error, message) = match err {
            Error::SqliteFailure(error, message) => (error, message),
            Error::SqlInputError { error, msg, .. } => (error, Some(msg)),
            other => return Failure::new(other),
        };
        Failure {
            message: message.unwrap_or_else(|| ffi::code_to_str(error.extended_code).to_owned()),
            code: Some("ERR_SQLITE_ERROR"),
            errno: Some(error.extended_code),
        }
    }
}

/// Opens an existing file: a mistyped path must not leave an empty database on the server.
pub fn open(file: &str, busy_timeout_ms: u64) -> Result<Connection, Failure> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let db = Connection::open_with_flags(file, flags).map_err(|err| match err {
        // rusqlite appends the path to the message: without it, the text is SQLite's
        Error::SqliteFailure(error, _) => Error::SqliteFailure(error, None),
        other => other,
    })?;
    db.busy_timeout(Duration::from_millis(busy_timeout_ms))?;
    register_regexp(&db)?;
    Ok(db)
}

/// `x REGEXP y` calls regexp(y, x), which SQLite does not define itself.
fn register_regexp(db: &Connection) -> rusqlite::Result<()> {
    let cached: RefCell<Option<Regex>> = RefCell::new(None);
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    db.create_scalar_function("regexp", 2, flags, move |ctx| {
        let (Some(pattern), Some(value)) = (text_argument(ctx, 0), text_argument(ctx, 1)) else {
            return Ok(None);
        };
        let mut cached = cached.borrow_mut();
        if cached
            .as_ref()
            .is_none_or(|regex| regex.as_str() != pattern)
        {
            *cached =
                Some(Regex::new(&pattern).map_err(|err| Error::UserFunctionError(err.into()))?);
        }
        Ok(cached.as_ref().map(|regex| regex.is_match(&value)))
    })
}

/// An argument as text, whatever its type; None for NULL.
fn text_argument<'a>(ctx: &'a Context<'_>, index: usize) -> Option<Cow<'a, str>> {
    match ctx.get_raw(index) {
        ValueRef::Null => None,
        ValueRef::Integer(i) => Some(i.to_string().into()),
        ValueRef::Real(f) => Some(f.to_string().into()),
        ValueRef::Text(bytes) | ValueRef::Blob(bytes) => Some(String::from_utf8_lossy(bytes)),
    }
}

/// The first statement of `sql`. What follows it is ignored, as node:sqlite's prepare() does;
/// Connection::prepare would fail on it.
fn prepare_first<'a>(db: &'a Connection, sql: &str) -> rusqlite::Result<Statement<'a>> {
    Batch::new(db, sql).next()?.ok_or(Error::Empty)
}

pub fn execute(db: &Connection, sql: &str, begin: bool) -> Result<Reply, Failure> {
    let start = Instant::now();
    if begin && db.is_autocommit() {
        db.execute_batch("BEGIN")?;
    }
    let mut stmt = prepare_first(db, sql)?;
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut first_row = None;
    if stmt.column_count() == 0 {
        // raw_*: placeholders left unbound are NULL, not an error
        stmt.raw_execute()?;
    } else {
        columns = stmt
            .columns_with_metadata()
            .zip(stmt.columns())
            .map(|(origin, column)| Column {
                name: origin.name().to_owned(),
                column: origin.origin_name().map(str::to_owned),
                table: origin.table_name().map(str::to_owned),
                database: origin.database_name().map(str::to_owned),
                decl_type: column.decl_type().map(str::to_owned),
            })
            .collect();
        (rows, first_row) = read_rows(&mut stmt)?;
    }
    Ok(Reply::Execute {
        columns,
        rows,
        changes: db.changes(),
        last_insert_rowid: db.last_insert_rowid(),
        duration_ms: first_row
            .unwrap_or_else(Instant::now)
            .duration_since(start)
            .as_secs_f64()
            * 1000.0,
    })
}

pub fn query(db: &Connection, sql: &str, params: Vec<Cell>) -> Result<Reply, Failure> {
    let mut stmt = prepare_first(db, sql)?;
    for (index, param) in params.into_iter().enumerate() {
        stmt.raw_bind_parameter(index + 1, param.into_sql()?)?;
    }
    let columns = stmt.column_names().map(str::to_owned).collect();
    let (rows, _) = read_rows(&mut stmt)?;
    Ok(Reply::Query { columns, rows })
}

/// All the rows, and when the first one arrived.
fn read_rows(stmt: &mut Statement<'_>) -> rusqlite::Result<(Vec<Vec<Cell>>, Option<Instant>)> {
    let width = stmt.column_count();
    let mut result = Vec::new();
    let mut first_row = None;
    let mut rows = stmt.raw_query();
    while let Some(row) = rows.next()? {
        first_row.get_or_insert_with(Instant::now);
        result.push(
            (0..width)
                .map(|i| row.get_ref(i).map(Cell::from_sql))
                .collect::<rusqlite::Result<_>>()?,
        );
    }
    Ok((result, first_row))
}

pub fn commit(db: &Connection) -> Result<Reply, Failure> {
    let committed = !db.is_autocommit();
    if committed {
        db.execute_batch("COMMIT")?;
    }
    Ok(Reply::Commit { committed })
}
