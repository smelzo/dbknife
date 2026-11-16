//! The operations on the database, with the results node:sqlite gives the local driver.
use std::borrow::Cow;
use std::cell::RefCell;
use std::ffi::{CStr, c_char, c_int};
use std::path::Path;
use std::ptr;
use std::time::{Duration, Instant};

use regex::Regex;
use rusqlite::config::DbConfig;
use rusqlite::functions::{Context, FunctionFlags};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, Error, OpenFlags, Statement, ffi};

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
pub fn open(file: &Path, busy_timeout_ms: u64) -> Result<Connection, Failure> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let db = Connection::open_with_flags(file, flags).map_err(|err| match err {
        // rusqlite appends the path to the message: without it, the text is SQLite's
        Error::SqliteFailure(error, _) => Error::SqliteFailure(error, None),
        other => other,
    })?;
    // The settings of node:sqlite, which the local driver runs with. "x" is only an identifier
    // (read as a string when no column has that name, a mistyped name would match every row),
    // foreign keys are enforced, the schema tables cannot be written.
    db.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false)?;
    db.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false)?;
    db.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_FKEY, true)?;
    db.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
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

/// The first statement of `sql` and its result columns. What follows the statement is
/// ignored, as node:sqlite's prepare() does; Connection::prepare would refuse it.
fn prepare_first<'a>(
    db: &'a Connection,
    sql: &str,
) -> rusqlite::Result<(Statement<'a>, Vec<Column>)> {
    let (end, columns) = describe_first(db, sql)?;
    Ok((db.prepare(sql.get(..end).unwrap_or(sql))?, columns))
}

/// Where the first statement of `sql` ends, and its result columns.
///
/// The statement is compiled here only to be described. rusqlite does not tell where a
/// statement ends, and it reads the names of columns, tables and types as UTF-8, with a panic
/// when they are not: a database file may hold any bytes, which node:sqlite replaces.
fn describe_first(db: &Connection, sql: &str) -> rusqlite::Result<(usize, Vec<Column>)> {
    let failure = |code, message| Error::SqliteFailure(ffi::Error::new(code), message);
    let start = sql.as_ptr().cast::<c_char>();
    let length = c_int::try_from(sql.len()).map_err(|_| failure(ffi::SQLITE_TOOBIG, None))?;
    // SAFETY: `handle` is the open connection of `db`, borrowed for the whole call. The
    // statement compiled here is used and finalized before returning. SQLite reads `length`
    // bytes from `start` and leaves `tail` inside them; every string it returns is checked
    // for NULL and copied before the next call on the statement.
    unsafe {
        let handle = db.handle();
        let (mut stmt, mut tail) = (ptr::null_mut(), ptr::null());
        let code = ffi::sqlite3_prepare_v3(handle, start, length, 0, &mut stmt, &mut tail);
        if code != ffi::SQLITE_OK {
            return Err(failure(code, Some(lossy(ffi::sqlite3_errmsg(handle)))));
        }
        if stmt.is_null() {
            return Err(Error::Empty);
        }
        let text = |value: *const c_char| (!value.is_null()).then(|| lossy(value));
        let columns = (0..ffi::sqlite3_column_count(stmt))
            .map(|i| Column {
                name: text(ffi::sqlite3_column_name(stmt, i)).unwrap_or_default(),
                column: text(ffi::sqlite3_column_origin_name(stmt, i)),
                table: text(ffi::sqlite3_column_table_name(stmt, i)),
                database: text(ffi::sqlite3_column_database_name(stmt, i)),
                decl_type: text(ffi::sqlite3_column_decltype(stmt, i)),
            })
            .collect();
        ffi::sqlite3_finalize(stmt);
        Ok((tail.offset_from(start) as usize, columns))
    }
}

/// SAFETY: `text` must point to a NUL-terminated string.
unsafe fn lossy(text: *const c_char) -> String {
    unsafe { CStr::from_ptr(text) }
        .to_string_lossy()
        .into_owned()
}

pub fn execute(db: &Connection, sql: &str, begin: bool) -> Result<Reply, Failure> {
    let start = Instant::now();
    if begin && db.is_autocommit() {
        db.execute_batch("BEGIN")?;
    }
    let (mut stmt, columns) = prepare_first(db, sql)?;
    let mut rows = Vec::new();
    let mut first_row = None;
    if columns.is_empty() {
        // raw_*: placeholders left unbound are NULL, not an error
        stmt.raw_execute()?;
    } else {
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
    let (mut stmt, columns) = prepare_first(db, sql)?;
    for (index, param) in params.into_iter().enumerate() {
        stmt.raw_bind_parameter(index + 1, param.into_sql()?)?;
    }
    let columns = columns.into_iter().map(|column| column.name).collect();
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
