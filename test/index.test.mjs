import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const UUID = '00112233-4455-6677-8899-aabbccddeeff';
const USERS = [{ id: 7, uuid: UUID, speed_limit: 0, device_limit: 2 }];
const ENV = {
  PANEL_URL: 'https://panel.example.com', PANEL_TOKEN: 'private-panel-secret', MACHINE_ID: '4',
  PATH_TOKEN: 'private-path-long-enough', ADMIN_TOKEN: 'private-admin-secret',
  REGION_MAP: JSON.stringify({ 'asia.example.com': { node_id: 4, location_hint: 'apac' }, 'global.example.com': { node_id: 5 } }),
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class WorkerResponse extends Response {
  constructor(body, init = {}) {
    super(body, { ...init, status: init.status === 101 ? 200 : init.status });
    this.workerStatus = init.status ?? 200; this.webSocket = init.webSocket;
  }
  get status() { return this.workerStatus ?? super.status; }
}
class FakeWebSocket extends EventTarget {
  readyState = 0; sent = []; closes = [];
  accept() { this.readyState = 1; }
  close(code, reason) { this.readyState = 3; this.closes.push({ code, reason }); }
  send(value) { if (this.readyState !== 1) throw new Error('closed'); this.sent.push(Uint8Array.from(value)); }
}

async function fixture(t, patch = {}) {
  const db = new DatabaseSync(':memory:'), values = new Map(); let alarm;
  const storage = {
    sql: { exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
    } },
    transactionSync(callback) { db.exec('BEGIN IMMEDIATE'); try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    async get(key) { return values.get(key); }, async put(key, value) { values.set(key, value); },
    async getAlarm() { return alarm; }, async setAlarm(value) { alarm = value; },
  };
  const waits = []; let initializing = Promise.resolve();
  const ctx = { storage, blockConcurrencyWhile(fn) { initializing = Promise.resolve(fn()); return initializing; }, waitUntil(promise) { waits.push(promise); } };
  const env = { ...ENV, ...patch };
  const requests = [], tcpSockets = [], pairs = [];
  const hooks = {
    user: async () => Response.json({ users: USERS }),
    report: async () => Response.json({ data: true }),
  };
  function connect(address) {
    let controller;
    const writes = [];
    const socket = {
      readable: new ReadableStream({ start(value) { controller = value; } }),
      writable: new WritableStream({ write(value) { writes.push(Uint8Array.from(value)); } }),
      opened: Promise.resolve({}), closed: new Promise(() => {}),
      close() { try { controller.close(); } catch {} return Promise.resolve(); },
      address, writes,
    };
    tcpSockets.push(socket); return socket;
  }
  const context = vm.createContext({
    crypto, URL, Request, Response: WorkerResponse, TextEncoder, TextDecoder, AbortSignal,
    Uint8Array, ArrayBuffer, Blob, ReadableStream, WritableStream, atob, btoa, setTimeout, clearTimeout,
    fetch: async (url, options) => { requests.push({ url: new URL(url), options }); return hooks[new URL(url).pathname.split('/').at(-1)](url, options); },
    WebSocketPair: class { constructor() { this[0] = new FakeWebSocket(); this[1] = new FakeWebSocket(); pairs.push(this); } },
  });
  const modules = new Map();
  async function load(identifier) {
    if (modules.has(identifier)) return modules.get(identifier);
    let module;
    if (identifier === 'cloudflare:workers') {
      module = new vm.SyntheticModule(['DurableObject'], function () { this.setExport('DurableObject', class { constructor(contextValue, envValue) { this.ctx = contextValue; this.env = envValue; } }); }, { context, identifier });
    } else if (identifier === 'cloudflare:sockets') {
      module = new vm.SyntheticModule(['connect'], function () { this.setExport('connect', connect); }, { context, identifier });
    } else {
      module = new vm.SourceTextModule(await readFile(new URL(identifier), 'utf8'), { context, identifier });
    }
    modules.set(identifier, module);
    await module.link((specifier, importer) => load(specifier.startsWith('cloudflare:') ? specifier : new URL(specifier, importer.identifier).href));
    return module;
  }
  const module = await load(new URL('../src/durable-index.js', import.meta.url).href);
  await module.evaluate();
  const node = new module.namespace.RegionalNode(ctx, env);
  await initializing;
  t.after(async () => {
    await Promise.allSettled([...node.sessions].map(session => session.bridge.shutdown()));
    if (node.reporting) await node.reporting;
    if (node.syncing) await node.syncing;
    db.close();
  });
  return { node, env, hooks, requests, tcpSockets, pairs, waits, storage, worker: module.namespace.default };
}

function websocket(host = 'asia.example.com', ip = '203.0.113.1') {
  return new Request(`https://${host}/cf-vless/${ENV.PATH_TOKEN}`, { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': ip } });
}
function header(uuid = UUID, hostname = 'example.com', payload = []) {
  const id = uuid.replace(/-/g, '').match(/../g).map(value => parseInt(value, 16));
  const host = new TextEncoder().encode(hostname);
  return Uint8Array.from([0, ...id, 0, 1, 1, 187, 2, host.length, ...host, ...payload]);
}
async function openAuthorized(f, request = websocket()) {
  const response = await f.node.fetch(request);
  assert.equal(response.status, 101);
  const session = [...f.node.sessions].at(-1);
  await session.bridge.receive(header());
  return session;
}

test('first regional fetch synchronizes panel users and unauthorized UUID creates no TCP connection', async t => {
  const f = await fixture(t);
  assert.equal((await f.node.fetch(websocket())).status, 101);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url.pathname, '/api/v2/server/user');
  assert.equal(f.requests[0].url.searchParams.get('machine_id'), '4');
  const session = [...f.node.sessions][0];
  await session.bridge.receive(header('ffffffff-ffff-ffff-ffff-ffffffffffff'));
  assert.equal((await session.bridge.done).code, 1008);
  assert.equal(f.tcpSockets.length, 0);
  assert.equal(f.node.sessions.size, 0);
});

test('failed or invalid first panel authentication refuses the WebSocket upgrade', async t => {
  const f = await fixture(t);
  f.hooks.user = async () => Response.json({ data: false });
  assert.equal((await f.node.fetch(websocket())).status, 503);
  assert.equal(f.node.sessions.size, 0);
  assert.equal(f.pairs.length, 0);
  assert.equal(f.node.users.size, 0);
});

test('active authorized transfers continue while report awaits acknowledgment and new traffic survives ack', async t => {
  const f = await fixture(t);
  const session = await openAuthorized(f);
  await session.bridge.receive(Uint8Array.of(1, 2, 3));
  const report = deferred(); f.hooks.report = () => report.promise;
  const pending = f.node.report(true);
  await tick();
  assert.equal(f.node.ledger.uncertain().length, 1);
  await session.bridge.receive(Uint8Array.of(4, 5));
  assert.equal(f.node.sessions.size, 1, 'known in-flight batch must not revoke the active session');
  assert.equal(f.node.ledger.pendingBytes(), 2);
  assert.equal(f.tcpSockets[0].writes.reduce((sum, chunk) => sum + chunk.length, 0), 5);
  report.resolve(Response.json({ data: true }));
  await pending;
  assert.equal(f.node.ledger.uncertain().length, 0);
  assert.equal(f.node.ledger.pendingBytes(), 2);
  const sent = JSON.parse(f.requests.find(request => request.url.pathname.endsWith('/report')).options.body);
  assert.deepEqual(sent.traffic, { 7: [3, 0] });
});

test('ambiguous report failure closes active sessions and no subsequent maintenance replays its traffic', async t => {
  const f = await fixture(t);
  const session = await openAuthorized(f);
  await session.bridge.receive(Uint8Array.of(1, 2, 3));
  let reports = 0; f.hooks.report = async () => { reports++; throw new Error('network timeout after panel may have accepted'); };
  await f.node.report(true);
  await session.bridge.done;
  assert.equal(f.node.lastError, 'report_requires_reconciliation');
  assert.equal(f.node.ledger.uncertain().length, 1);
  assert.equal(f.node.sessions.size, 0);
  await f.node.report(true); await f.node.report(true);
  assert.equal(reports, 1, 'ambiguous traffic is never blindly retried');
  assert.equal((await f.node.fetch(websocket())).status, 503);
});

test('user revoked by panel refresh immediately closes its active session', async t => {
  const f = await fixture(t);
  const session = await openAuthorized(f);
  f.hooks.user = async () => Response.json({ users: [] });
  await f.node.syncUsers(true);
  assert.equal((await session.bridge.done).reason, 'Authorization revoked');
  assert.equal(f.node.sessions.size, 0);
  assert.equal(f.node.users.size, 0);
});

test('configured own hostname and panel destination are denied before outbound TCP connection', async t => {
  const f = await fixture(t);
  for (const target of ['asia.example.com', 'global.example.com', 'panel.example.com']) {
    assert.equal((await f.node.fetch(websocket())).status, 101);
    const session = [...f.node.sessions].at(-1);
    await session.bridge.receive(header(UUID, target));
    assert.equal((await session.bridge.done).code, 1008);
  }
  assert.equal(f.tcpSockets.length, 0);
});

test('empty ADMIN_TOKEN and missing credentials fail closed in outer handler and object', async t => {
  const f = await fixture(t, { ADMIN_TOKEN: '' });
  const admin = new Request('https://asia.example.com/admin/status', { headers: { authorization: 'Bearer ' } });
  assert.equal((await f.worker.fetch(admin, f.env)).status, 403);
  assert.equal((await f.node.fetch(admin)).status, 403);
  f.env.ADMIN_TOKEN = ENV.ADMIN_TOKEN;
  assert.equal((await f.worker.fetch(new Request('https://asia.example.com/admin/status'), f.env)).status, 403);
});

test('authenticated admin status exposes counters but never panel secrets, user UUIDs or raw IP addresses', async t => {
  const f = await fixture(t);
  await openAuthorized(f);
  f.node.ledger.add(7, 3, 4); f.node.ledger.stage();
  const response = await f.node.fetch(new Request('https://asia.example.com/admin/status', { headers: { authorization: `Bearer ${ENV.ADMIN_TOKEN}` } }));
  assert.equal(response.status, 200);
  const raw = await response.text(); const status = JSON.parse(raw);
  assert.equal(status.node_id, 4); assert.equal(status.sessions, 1); assert.equal(status.authorized_users, 1);
  assert.equal(status.uncertain_batches.length, 1);
  for (const secret of [ENV.PANEL_TOKEN, ENV.PATH_TOKEN, ENV.ADMIN_TOKEN, UUID, '203.0.113.1']) assert.equal(raw.includes(secret), false);
  assert.equal('payload' in status.uncertain_batches[0], false);
});

test('outer health/config/default-route handling never invokes objects before validated WebSocket requests', async t => {
  const f = await fixture(t); let accesses = 0;
  f.env.NODES = { idFromName(value) { accesses++; return value; }, get() { return { fetch: async () => new Response(null, { status: 204 }) }; } };
  assert.equal((await f.worker.fetch(new Request('https://asia.example.com/healthz'), f.env)).status, 200);
  assert.equal((await f.worker.fetch(new Request('https://unknown.example.com/healthz'), f.env)).status, 404);
  assert.equal((await f.worker.fetch(new Request('https://asia.example.com/cf-vless/wrong'), f.env)).status, 404);
  assert.equal((await f.worker.fetch(new Request(`https://asia.example.com/cf-vless/${ENV.PATH_TOKEN}`), f.env)).status, 426);
  assert.equal(accesses, 0);
  assert.equal((await f.worker.fetch(websocket(), { ...f.env, PANEL_TOKEN: '' })).status, 503);
  assert.equal(accesses, 0);
});

test('regional delegation uses one hinted object while global WebSocket delegation uses ingress colo', async t => {
  const f = await fixture(t); const gets = [];
  f.env.NODES = { idFromName(value) { return value; }, get(id, options) { gets.push({ id, options }); return { fetch: async () => new Response(null, { status: 204 }) }; } };
  const regional = websocket(); Object.defineProperty(regional, 'cf', { value: { colo: 'HKG' } });
  const global = websocket('global.example.com'); Object.defineProperty(global, 'cf', { value: { colo: 'NRT' } });
  await f.worker.fetch(regional, f.env); await f.worker.fetch(global, f.env);
  assert.equal(gets[0].id, 'node-4-v1-region'); assert.equal(gets[0].options.locationHint, 'apac');
  assert.equal(gets[1].id, 'node-5-v1-NRT'); assert.equal(gets[1].options, undefined);
});

test('authorized admin global colo query selects the requested shard without exposing a public shard selector', async t => {
  const f = await fixture(t); let selected;
  f.env.NODES = { idFromName(value) { selected = value; return value; }, get() { return { fetch: async () => new Response(null, { status: 204 }) }; } };
  const admin = new Request('https://global.example.com/admin/status?colo=NRT', { headers: { authorization: `Bearer ${ENV.ADMIN_TOKEN}` } });
  await f.worker.fetch(admin, f.env);
  assert.equal(selected, 'node-5-v1-NRT');
  const publicRequest = new Request(`https://global.example.com/cf-vless/${ENV.PATH_TOKEN}?colo=NRT`, { headers: { Upgrade: 'websocket' } });
  assert.equal((await f.worker.fetch(publicRequest, f.env)).status, 404);
});
