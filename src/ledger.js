// XBoard lacks report-ID deduplication. Persist before sending and quarantine
// ambiguous reports instead of replaying them and double-charging a user.
export class Ledger {
  constructor(storage) {
    this.storage = storage; this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS traffic (uid INTEGER PRIMARY KEY, up INTEGER NOT NULL, down INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created INTEGER NOT NULL)');
  }
  add(uid, up, down) {
    this.sql.exec('INSERT INTO traffic(uid,up,down) VALUES(?,?,?) ON CONFLICT(uid) DO UPDATE SET up=up+excluded.up,down=down+excluded.down', uid, up, down);
  }
  pendingBytes() { return this.sql.exec('SELECT COALESCE(SUM(up+down),0) AS bytes FROM traffic').one().bytes; }
  uncertain() { return this.sql.exec('SELECT id,created,payload FROM batches ORDER BY created').toArray(); }
  stage() {
    let batch;
    this.storage.transactionSync(() => {
      if (this.uncertain().length) return;
      const rows = this.sql.exec('SELECT uid,up,down FROM traffic WHERE up+down>0').toArray(); if (!rows.length) return;
      batch = { id: crypto.randomUUID(), traffic: Object.fromEntries(rows.map(r => [r.uid, [r.up, r.down]])), created: Date.now() };
      this.sql.exec('INSERT INTO batches(id,payload,created) VALUES(?,?,?)', batch.id, JSON.stringify(batch.traffic), batch.created);
      this.sql.exec('DELETE FROM traffic');
    }); return batch;
  }
  accept(id) { this.sql.exec('DELETE FROM batches WHERE id=?', id); }
  reconcile(id, outcome) {
    const batch = this.uncertain().find(b => b.id === id);
    if (!batch || !['accepted', 'not-accepted'].includes(outcome)) throw new Error('invalid reconciliation');
    this.storage.transactionSync(() => {
      if (outcome === 'not-accepted') for (const [uid, [up, down]] of Object.entries(JSON.parse(batch.payload))) this.add(Number(uid), up, down);
      this.accept(id);
    });
  }
}
