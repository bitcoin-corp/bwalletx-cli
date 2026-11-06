/**
 * `better-sqlite3` API on top of bun:sqlite, for the compiled PC miner only (better-sqlite3 is a V8 addon that
 * neither bun nor a cross-compiled .exe can load). Covers exactly what knex's better-sqlite3 client uses:
 * new Database(file, opts), prepare(sql) → { reader, all(), run(), safeIntegers() }, defaultSafeIntegers(), close().
 * BLOBs come back as Buffer (the wallet toolbox checks Buffer.isBuffer), and foreign keys are on, as in
 * better-sqlite3's own build.
 */
const { Database: BunDb } = require('bun:sqlite');

const toBuffers = (row) => {
  for (const k in row) {
    const v = row[k];
    if (v instanceof Uint8Array && !Buffer.isBuffer(v)) row[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  }
  return row;
};

/** Errors look like better-sqlite3's (name SqliteError, code SQLITE_*): the toolbox detects SQLite by them. */
const wrap = (fn) => {
  try {
    return fn();
  } catch (e) {
    if (e && typeof e === 'object') {
      try {
        Object.defineProperty(e, 'name', { value: 'SqliteError', configurable: true });
      } catch {}
      if (!e.code || !String(e.code).startsWith('SQLITE')) e.code = 'SQLITE_ERROR';
    }
    throw e;
  }
};

class Statement {
  constructor(st) {
    this.st = st;
    this.reader = st.columnNames.length > 0;
  }
  safeIntegers() {
    return this;
  }
  all(bindings = []) {
    return wrap(() => this.st.all(...bindings)).map(toBuffers);
  }
  run(bindings = []) {
    const r = wrap(() => this.st.run(...bindings));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  }
}

class Database {
  constructor(filename, opts = {}) {
    this.db = new BunDb(filename, opts.readonly ? { readonly: true } : { create: true, readwrite: true });
    this.db.exec('PRAGMA foreign_keys = ON');
  }
  defaultSafeIntegers() {
    return this;
  }
  prepare(sql) {
    return new Statement(wrap(() => this.db.prepare(sql)));
  }
  close() {
    this.db.close();
  }
}

module.exports = Database;
