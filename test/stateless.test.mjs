import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { statelessReportPayload } from '../src/stateless-report.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const ENV = {
  PANEL_URL: 'https://panel.example.com',
  PANEL_TOKEN: 'panel-secret',
  PATH_TOKEN: 'stateless-path-token',
  ADMIN_TOKEN: 'admin-secret',
  REGION_MAP: JSON.stringify({ 'asia.example.com': { node_id: 4, location_hint: 'apac' } }),
};

class WorkerResponse extends Response {
  constructor(body, init = {}) {
    super(body, { ...init, status: init.status === 101 ? 200 : init.status });
    this.workerStatus = init.status ?? 200;
    this.webSocket = init.webSocket;
  }
  get status() { return this.workerStatus; }
}

class FakeWebSocket extends EventTarget {
  readyState = 0;
  sent = [];
  accept() { this.readyState = 1; }
  close(code, reason) { this.readyState = 3; this.closeInfo = { code, reason }; }
  send(value) { this.sent.push(Uint8Array.from(value)); }
  emit(type, data) { const event = new Event(type); event.data = data; this.dispatchEvent(event); }
}

async function loadModule({ fetcher = async () => { throw new Error('unexpected fetch'); }, pairFactory, connector } = {}) {
  const context = vm.createContext({
    crypto, URL, Request, Response: WorkerResponse, TextEncoder, TextDecoder, AbortSignal,
    Uint8Array, ArrayBuffer, Blob, ReadableStream, WritableStream,
    atob, btoa, setTimeout, clearTimeout,
    fetch: fetcher,
    WebSocketPair: pairFactory,
  });
  const modules = new Map();
  async function load(identifier) {
    if (modules.has(identifier)) return modules.get(identifier);
    let module;
    if (identifier === 'cloudflare:sockets') {
      module = new vm.SyntheticModule(['connect'], function () {
        this.setExport('connect', connector || (() => { throw new Error('not used in this test'); }));
      }, { context, identifier });
    } else {
      module = new vm.SourceTextModule(await readFile(new URL(identifier), 'utf8'), { context, identifier });
    }
    modules.set(identifier, module);
    await module.link((specifier, importer) => load(
      specifier.startsWith('cloudflare:') ? specifier : new URL(specifier, importer.identifier).href,
    ));
    return module;
  }
  const module = await load(new URL('../src/index.js', import.meta.url).href);
  await module.evaluate();
  return { namespace: module.namespace, context };
}

test('stateless report payload contains only one connection and isolate-local online hints', async () => {
  const user = { id: 7 };
  const payload = statelessReportPayload(
    { user, upload: 12, download: 34 },
    [{ user, ip: '2001:db8::1' }, { user: { id: 8 }, ip: '203.0.113.8' }],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    traffic: { 7: [12, 34] },
    alive: { 7: ['2001:db8::1'] },
    online: { 7: 1 },
  });
  assert.equal(statelessReportPayload({ user, upload: 0, download: 0 }, []), null);
});

test('stateless health and admin endpoints work without a Durable Object binding', async () => {
  const { namespace: { default: worker } } = await loadModule();
  const ctx = { waitUntil() {} };
  const health = await worker.fetch(new Request('https://asia.example.com/healthz'), ENV, ctx);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    transport: 'vless-ws-tcp',
    mode: 'stateless',
    placement: 'ingress',
  });
  const admin = await worker.fetch(new Request('https://asia.example.com/admin/status', {
    headers: { authorization: `Bearer ${ENV.ADMIN_TOKEN}` },
  }), ENV, ctx);
  assert.equal(admin.status, 200);
  const status = await admin.json();
  assert.equal(status.mode, 'stateless');
  assert.equal(status.persistent_storage, false);
  assert.equal(status.node_id, 4);
  assert.deepEqual(status.uncertain_batches, []);
});

test('stateless VLESS session authorizes per connection and reports bytes once on close', async () => {
  const UUID = '00112233-4455-6677-8899-aabbccddeeff';
  const requests = [];
  const pairs = [];
  const sockets = [];
  const users = [{ id: 7, uuid: UUID, speed_limit: 0, device_limit: 1 }];
  const fetcher = async (url, options) => {
    const parsed = new URL(url);
    requests.push({ parsed, options });
    if (parsed.pathname.endsWith('/user')) return Response.json({ users });
    if (parsed.pathname.endsWith('/report')) return Response.json({ data: true });
    throw new Error('unexpected panel endpoint');
  };
  class Pair {
    constructor() {
      this[0] = new FakeWebSocket();
      this[1] = new FakeWebSocket();
      pairs.push(this);
    }
  }
  function connect(address) {
    let controller;
    const socket = {
      readable: new ReadableStream({ start(value) { controller = value; } }),
      writable: new WritableStream({ write() {} }),
      opened: Promise.resolve({}),
      closed: new Promise(() => {}),
      close() { try { controller.close(); } catch {} },
      address,
    };
    sockets.push(socket);
    return socket;
  }
  const { namespace: { default: worker }, context } = await loadModule({ fetcher, pairFactory: Pair, connector: connect });
  const ctx = { waitUntil(promise) { this.wait = promise; } };
  const response = await worker.fetch(new Request(`https://asia.example.com/cf-vless/${ENV.PATH_TOKEN}`, {
    headers: { Upgrade: 'websocket', 'CF-Connecting-IP': '203.0.113.8' },
  }), ENV, ctx);
  assert.equal(response.status, 101);
  assert.equal(requests.filter(item => item.parsed.pathname.endsWith('/user')).length, 1);
  const bytes = context.Uint8Array.from([
    0, ...UUID.replace(/-/g, '').match(/../g).map(value => parseInt(value, 16)),
    0, 1, 1, 187, 2, 11, ...new TextEncoder().encode('example.com'), 1, 2, 3,
  ]);
  const server = pairs[0][1];
  server.emit('message', bytes);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sockets.length, 1);
  server.emit('close');
  await ctx.wait;
  const reports = requests.filter(item => item.parsed.pathname.endsWith('/report'));
  assert.equal(reports.length, 1);
  assert.deepEqual(JSON.parse(reports[0].options.body).traffic, { 7: [3, 0] });
});

test('stateless config has no Durable Object, migration, or trigger declarations', async () => {
  const raw = await readFile(resolve(ROOT, 'wrangler.jsonc'), 'utf8');
  const config = JSON.parse(raw);
  assert.equal('durable_objects' in config, false);
  assert.equal('migrations' in config, false);
  assert.equal('triggers' in config, false);
});
