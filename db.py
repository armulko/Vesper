import os
import sqlite3
import threading

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
DB_FILE = os.path.join(DATA_DIR, 'vesper.db')

# SQLite connections are cheap but not thread-safe by default across threads
# unless check_same_thread=False + we serialize writes ourselves. Flask's
# dev server and most WSGI workers are multi-threaded, so: one connection
# per request via get_db(), not one global shared connection (that's what
# file_lock was papering over in the old JSON code — here the DB engine's
# own locking does that job, we just need a connection per thread/request).
_local = threading.local()


def get_db():
    """Returns a per-thread sqlite3 connection with foreign keys enabled
    and Row factory so results behave like dicts. Call close_db() when
    the request ends (wire this into Flask's teardown_appcontext in
    app.py — not included here since this file has no Flask app object)."""
    if not hasattr(_local, 'conn'):
        _local.conn = sqlite3.connect(DB_FILE)
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute('PRAGMA foreign_keys = ON')
    return _local.conn


def close_db():
    if hasattr(_local, 'conn'):
        _local.conn.close()
        del _local.conn