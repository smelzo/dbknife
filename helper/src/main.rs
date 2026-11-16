//! dbknife-sqlite: runs next to a SQLite file on a remote machine and serves
//! it to DBKnife over stdin/stdout (see protocol.rs).
mod cell;
mod list;
mod path;
mod protocol;
mod sqlite;

use std::io::{self, BufRead, BufWriter, Write};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};
use std::{process, thread};

use rusqlite::{Connection, InterruptHandle};
use serde::Serialize;
use serde_json::Value;

use protocol::{Failure, Reply, Request};

/// How long the requests already received may still take once stdin is closed.
const EXIT_GRACE: Duration = Duration::from_secs(2);
const INTERRUPT_INTERVAL: Duration = Duration::from_millis(50);

type Interrupt = Mutex<Option<InterruptHandle>>;

#[derive(Serialize)]
struct Response<'a> {
    id: &'a Value,
    #[serde(flatten)]
    reply: Reply,
}

fn main() {
    let interrupt: Arc<Interrupt> = Arc::default();
    let (lines, requests) = mpsc::channel::<Vec<u8>>();
    let stdin_interrupt = Arc::clone(&interrupt);
    thread::spawn(move || {
        for line in io::stdin().lock().split(b'\n') {
            let Ok(line) = line else { break };
            if lines.send(line).is_err() {
                return;
            }
        }
        drop(lines);
        // The app is gone: nothing may keep this process alive on the server. The
        // interrupt is repeated because it only stops a statement that is running,
        // and one may be about to start; the deadline covers what an interrupt does
        // not stop, such as a write to a stdout nobody reads.
        let deadline = Instant::now() + EXIT_GRACE;
        while Instant::now() < deadline {
            if let Some(handle) = stdin_interrupt.lock().unwrap().as_ref() {
                handle.interrupt();
            }
            thread::sleep(INTERRUPT_INTERVAL);
        }
        process::exit(1);
    });

    let mut db: Option<Connection> = None;
    let mut out = BufWriter::new(io::stdout().lock());
    // Ends when stdin is closed and its requests are answered, or when stdout fails;
    // closing the connection on the way out rolls back an open transaction.
    for line in requests {
        let (id, result) = handle(&line, &mut db, &interrupt);
        let response = Response {
            id: &id,
            reply: result.unwrap_or_else(|error| Reply::Error { error }),
        };
        if write_line(&mut out, &response).is_err() {
            break;
        }
    }
}

fn write_line(out: &mut impl Write, response: &Response) -> io::Result<()> {
    serde_json::to_writer(&mut *out, response)?;
    out.write_all(b"\n")?;
    out.flush()
}

fn handle(
    line: &[u8],
    db: &mut Option<Connection>,
    interrupt: &Interrupt,
) -> (Value, Result<Reply, Failure>) {
    let mut request: Value = match serde_json::from_slice(line) {
        Ok(request) => request,
        Err(err) => return (Value::Null, Err(Failure::new(err))),
    };
    let id = request.get_mut("id").map(Value::take).unwrap_or_default();
    let result = serde_json::from_value(request)
        .map_err(Failure::new)
        .and_then(|request| run(request, db, interrupt));
    (id, result)
}

fn run(
    request: Request,
    db: &mut Option<Connection>,
    interrupt: &Interrupt,
) -> Result<Reply, Failure> {
    match request {
        Request::Open {
            file,
            busy_timeout_ms,
        } => {
            let connection = sqlite::open(&path::resolve(&file)?, busy_timeout_ms)?;
            *interrupt.lock().unwrap() = Some(connection.get_interrupt_handle());
            *db = Some(connection);
            Ok(Reply::Opened {})
        }
        Request::Execute { sql, begin } => sqlite::execute(opened(db)?, &sql, begin),
        Request::Query { sql, params } => sqlite::query(opened(db)?, &sql, params),
        Request::Commit => sqlite::commit(opened(db)?),
        Request::Status => Ok(Reply::Status {
            transaction: !opened(db)?.is_autocommit(),
        }),
        Request::List { path } => list::list(&path),
    }
}

fn opened(db: &Option<Connection>) -> Result<&Connection, Failure> {
    db.as_ref()
        .ok_or_else(|| Failure::new("The database is not open"))
}
