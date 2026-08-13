import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

test('SQLite data_version detects another connection and a reserved write lock closes the CAS window', () => {
  const directory = mkdtempSync(join(tmpdir(), 'offline-sqlite-concurrency-'));
  const path = join(directory, 'replica.sqlite');
  const first = new DatabaseSync(path);
  let second;
  try {
    first.exec('PRAGMA journal_mode = WAL; CREATE TABLE replica (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    second = new DatabaseSync(path);
    second.exec('PRAGMA busy_timeout = 0');

    const before = first.prepare('PRAGMA data_version').get().data_version;
    second.exec("INSERT INTO replica (value) VALUES ('external')");
    const after = first.prepare('PRAGMA data_version').get().data_version;
    assert.ok(after > before);

    first.exec('BEGIN; UPDATE replica SET value = value WHERE id = 1');
    const lockedRevision = first.prepare('PRAGMA data_version').get().data_version;
    assert.equal(lockedRevision, after);
    assert.throws(() => second.exec("INSERT INTO replica (value) VALUES ('racing')"), /locked/u);
    first.exec('ROLLBACK');
  } finally {
    second?.close();
    first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a SQLite read transaction keeps both reads on one snapshot while another connection commits', () => {
  const directory = mkdtempSync(join(tmpdir(), 'offline-sqlite-snapshot-'));
  const path = join(directory, 'replica.sqlite');
  const first = new DatabaseSync(path);
  let second;
  try {
    first.exec("PRAGMA journal_mode = WAL; CREATE TABLE replica (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO replica (value) VALUES ('one')");
    second = new DatabaseSync(path);

    first.exec('BEGIN');
    assert.equal(first.prepare('SELECT count(*) AS count FROM replica').get().count, 1);
    second.exec("INSERT INTO replica (value) VALUES ('two')");
    assert.equal(first.prepare('SELECT count(*) AS count FROM replica').get().count, 1);
    first.exec('COMMIT');
    assert.equal(first.prepare('SELECT count(*) AS count FROM replica').get().count, 2);
  } finally {
    second?.close();
    first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
