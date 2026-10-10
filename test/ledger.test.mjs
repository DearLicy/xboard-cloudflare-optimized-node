import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';

// Match Durable Object SQL cursor operations while exercising real SQLite
// transactions and on-disk persistence rather than mocking SQL string results.
function storageAdapter(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  const sql = {
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings);
      return {
        toArray: () => rows,
        one() { assert.equal(rows.length, 1, 'one() requires exactly one row'); return rows[0]; },
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  };
  return {
    sql,
    transactionSync(callback) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close: () => db.close(),
  };
}

function withLedger(t) {
  const storage = storageAdapter();
  t.after(() => storage.close());
  return { ledger: new Ledger(storage), storage };
}

test('traffic accumulates raw upload/download bytes per user and empty state stages nothing', (t) => {
  const { ledger } = withLedger(t);
  assert.equal(ledger.pendingBytes(), 0);
  assert.equal(ledger.stage(), undefined);
  assert.deepEqual(ledger.uncertain(), []);
  ledger.add(1, 100, 200); ledger.add(1, 30, 40); ledger.add(2, 5, 6);
  assert.equal(ledger.pendingBytes(), 381);
  const batch = ledger.stage();
  assert.deepEqual(batch.traffic, { 1: [130, 240], 2: [5, 6] });
  assert.match(batch.id, /^[0-9a-f-]{36}$/);
  assert.equal(ledger.pendingBytes(), 0);
  assert.equal(ledger.uncertain().length, 1);
  assert.deepEqual(JSON.parse(ledger.uncertain()[0].payload), batch.traffic);
});

test('ambiguous staged reports cannot be automatically restaged or replayed', (t) => {
  const { ledger } = withLedger(t);
  ledger.add(1, 100, 200);
  const batch = ledger.stage();
  ledger.add(1, 10, 20);
  assert.equal(ledger.stage(), undefined);
  assert.equal(ledger.stage(), undefined);
  assert.equal(ledger.pendingBytes(), 30);
  assert.equal(ledger.uncertain()[0].id, batch.id);
  assert.deepEqual(JSON.parse(ledger.uncertain()[0].payload), { 1: [100, 200] });
});

test('acknowledgment removes only staged traffic while concurrent new traffic stays pending', (t) => {
  const { ledger } = withLedger(t);
  ledger.add(1, 100, 200);
  const batch = ledger.stage();
  // These calls represent transfer events arriving while the panel report is
  // awaiting its HTTP response. Their bytes must survive that acknowledgment.
  ledger.add(1, 30, 40); ledger.add(2, 50, 60);
  ledger.accept(batch.id);
  assert.deepEqual(ledger.uncertain(), []);
  assert.equal(ledger.pendingBytes(), 180);
  const next = ledger.stage();
  assert.notEqual(next.id, batch.id);
  assert.deepEqual(next.traffic, { 1: [30, 40], 2: [50, 60] });
  ledger.accept(batch.id);
  assert.equal(ledger.uncertain()[0].id, next.id, 'late duplicate ack must not remove another batch');
});

test('pending traffic and quarantined batches survive object restart on disk', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cf-node-ledger-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'ledger.sqlite');
  let storage = storageAdapter(filename);
  let ledger = new Ledger(storage);
  ledger.add(7, 123, 456);
  const batch = ledger.stage();
  ledger.add(7, 8, 9);
  storage.close();
  storage = storageAdapter(filename);
  t.after(() => storage.close());
  ledger = new Ledger(storage);
  assert.equal(ledger.pendingBytes(), 17);
  assert.equal(ledger.uncertain()[0].id, batch.id);
  assert.equal(ledger.stage(), undefined, 'restart must never replay an ambiguous HTTP report');
  ledger.reconcile(batch.id, 'accepted');
  assert.deepEqual(ledger.stage().traffic, { 7: [8, 9] });
});

test('manual accepted reconciliation drops the batch and preserves new pending traffic', (t) => {
  const { ledger } = withLedger(t);
  ledger.add(1, 100, 200);
  const batch = ledger.stage();
  ledger.add(1, 3, 4);
  ledger.reconcile(batch.id, 'accepted');
  assert.deepEqual(ledger.uncertain(), []);
  assert.equal(ledger.pendingBytes(), 7);
  assert.deepEqual(ledger.stage().traffic, { 1: [3, 4] });
});

test('manual not-accepted reconciliation merges the batch once with concurrent traffic', (t) => {
  const { ledger } = withLedger(t);
  ledger.add(1, 100, 200); ledger.add(2, 5, 6);
  const batch = ledger.stage();
  ledger.add(1, 30, 40); ledger.add(3, 7, 8);
  ledger.reconcile(batch.id, 'not-accepted');
  assert.equal(ledger.pendingBytes(), 396);
  assert.deepEqual(ledger.uncertain(), []);
  assert.throws(() => ledger.reconcile(batch.id, 'not-accepted'), /invalid reconciliation/);
  assert.equal(ledger.pendingBytes(), 396, 'double reconciliation cannot double-charge bytes');
  assert.deepEqual(ledger.stage().traffic, { 1: [130, 240], 2: [5, 6], 3: [7, 8] });
});

test('invalid batch or outcome leaves both quarantined and pending traffic intact', (t) => {
  const { ledger } = withLedger(t);
  ledger.add(1, 100, 200);
  const batch = ledger.stage();
  ledger.add(2, 3, 4);
  for (const [id, outcome] of [['unknown', 'accepted'], [batch.id, 'retry'], [batch.id, null]]) {
    assert.throws(() => ledger.reconcile(id, outcome), /invalid reconciliation/);
  }
  assert.equal(ledger.pendingBytes(), 7);
  assert.equal(ledger.uncertain()[0].id, batch.id);
});

test('stage transaction rolls back insertion if removing pending traffic fails', (t) => {
  const { ledger, storage } = withLedger(t);
  ledger.add(1, 100, 200);
  const realExec = storage.sql.exec;
  storage.sql.exec = (query, ...bindings) => {
    if (query === 'DELETE FROM traffic') throw new Error('simulated storage error');
    return realExec(query, ...bindings);
  };
  assert.throws(() => ledger.stage(), /simulated storage error/);
  storage.sql.exec = realExec;
  assert.deepEqual(ledger.uncertain(), []);
  assert.equal(ledger.pendingBytes(), 300);
  assert.deepEqual(ledger.stage().traffic, { 1: [100, 200] });
});

test('reconciliation transaction rolls back partially merged bytes on storage failure', (t) => {
  const { ledger, storage } = withLedger(t);
  ledger.add(1, 100, 200); ledger.add(2, 5, 6);
  const batch = ledger.stage();
  ledger.add(3, 7, 8);
  const realExec = storage.sql.exec;
  storage.sql.exec = (query, ...bindings) => {
    if (query.startsWith('INSERT INTO traffic') && bindings[0] === 2) throw new Error('simulated storage error');
    return realExec(query, ...bindings);
  };
  assert.throws(() => ledger.reconcile(batch.id, 'not-accepted'), /simulated storage error/);
  storage.sql.exec = realExec;
  assert.equal(ledger.pendingBytes(), 15, 'earlier merge in the transaction must be rolled back');
  assert.equal(ledger.uncertain()[0].id, batch.id);
  ledger.reconcile(batch.id, 'not-accepted');
  assert.equal(ledger.pendingBytes(), 326);
});
