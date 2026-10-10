import assert from "node:assert/strict";
import test, { after, before } from "node:test";

const realResponse = globalThis.Response;
const realWebSocket = globalThis.WebSocket;
const realWebSocketPair = globalThis.WebSocketPair;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realBlob = globalThis.Blob;

class FakeResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.webSocket = init.webSocket;
    this.headers = new Headers(init.headers);
  }
  async text() { return this.body === null || this.body === undefined ? "" : String(this.body); }
}

class MockSocket {
  constructor(name) {
    this.name = name;
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
    this.accepted = false;
    this.binaryType = "blob";
  }
  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once: options.once === true });
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((item) => item.listener !== listener));
  }
  dispatch(type, data) {
    const listeners = [...(this.listeners.get(type) ?? [])];
    for (const item of listeners) {
      if (item.once) this.removeEventListener(type, item.listener);
      item.listener({ type, data });
    }
  }
  send(data) {
    if (this.closed) throw new Error(`${this.name} is closed`);
    this.sent.push(data);
    if (this.peer && !this.peer.closed) this.peer.sent.push(data);
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.closeInfo = { code, reason };
    this.dispatch("close");
    if (this.peer && !this.peer.closed) {
      this.peer.closed = true;
      this.peer.dispatch("close");
    }
  }
  accept(options) { this.accepted = true; this.acceptOptions = options; }
}

const pairs = [];
const outbound = [];
class MockPair {
  constructor() {
    this[0] = new MockSocket("client");
    this[1] = new MockSocket("worker");
    this[0].peer = this[1];
    this[1].peer = this[0];
    pairs.push(this);
  }
}
function MockWebSocket(url) {
  const socket = new MockSocket("origin");
  socket.url = url;
  outbound.push(socket);
  return socket;
}

before(() => {
  globalThis.Response = FakeResponse;
  globalThis.WebSocketPair = MockPair;
  globalThis.WebSocket = MockWebSocket;
});
after(() => {
  globalThis.Response = realResponse;
  globalThis.WebSocket = realWebSocket;
  globalThis.WebSocketPair = realWebSocketPair;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

const { default: worker } = await import("../src/index.js?behavior-tests");
const TOKEN_JP = "japan-token-123456";
const TOKEN_HK = "hongkong-token-1234";

function envMap(overrides = {}) {
  return {
    ORIGIN_MAP: JSON.stringify({
      "japan.example": { host: "2001:db8::10", port: 39001, scheme: "wss", path: "/vless", token: TOKEN_JP, max_connections: 2 },
      "hongkong.example": { host: "hk-origin.example", port: 39002, scheme: "ws", path: "/vless", token: TOKEN_HK, max_connections: 2 },
    }),
    ...overrides,
  };
}
function request(host, path, options = {}) {
  return new Request(`https://${host}${path}`, {
    method: options.method ?? "GET",
    headers: options.upgrade ? { Upgrade: "websocket" } : options.headers,
  });
}
async function openHandshake(promise, socket = outbound.at(-1)) {
  await Promise.resolve();
  socket.dispatch("open");
  return promise;
}
function resetMocks() { pairs.length = 0; outbound.length = 0; }

test("selects mapped source and formats IPv6 origin URL", { concurrency: false }, async () => {
  resetMocks();
  const response = await openHandshake(worker.fetch(request("japan.example", `/vless/${TOKEN_JP}`, { upgrade: true }), envMap()));
  assert.equal(response.status, 101);
  assert.equal(outbound[0].url, `wss://[2001:db8::10]:39001/vless/${TOKEN_JP}`);
  assert.equal(pairs[0][1].accepted, true);
  assert.equal(pairs[0][1].binaryType, "arraybuffer");
  assert.equal(outbound[0].binaryType, "arraybuffer");
  pairs[0][0].close();
});

test("rejects unknown route and cross-region path token without dialing origin", { concurrency: false }, async () => {
  resetMocks();
  let response = await worker.fetch(request("unknown.example", `/vless/${TOKEN_JP}`, { upgrade: true }), envMap());
  assert.equal(response.status, 404);
  response = await worker.fetch(request("japan.example", `/vless/${TOKEN_HK}`, { upgrade: true }), envMap());
  assert.equal(response.status, 404);
  assert.equal(outbound.length, 0);
});

test("rejects invalid map and invalid token configuration", { concurrency: false }, async () => {
  let response = await worker.fetch(request("japan.example", "/vless/a", { upgrade: true }), { ORIGIN_MAP: "{" });
  assert.equal(response.status, 500);
  response = await worker.fetch(request("japan.example", "/vless/short", { upgrade: true }), {
    ORIGIN_MAP: JSON.stringify({ "japan.example": { host: "origin.example", token: "short" } }),
  });
  assert.equal(response.status, 500);
  response = await worker.fetch(request("japan.example", "/vless/token-1234567890", { upgrade: true }), {
    ORIGIN_MAP: JSON.stringify({ "japan.example": { host: "origin.example", port: "not-a-port", token: "token-1234567890" } }),
  });
  assert.equal(response.status, 500);
  response = await worker.fetch(request("japan.example", "/vless/token-1234567890", { upgrade: true }), {
    ORIGIN_MAP: JSON.stringify({ "japan.example": { host: "origin.example", scheme: "tcp", token: "token-1234567890" } }),
  });
  assert.equal(response.status, 500);
});

test("preserves single-origin compatibility and does not fall back from a map", { concurrency: false }, async () => {
  resetMocks();
  const singleEnv = { ORIGIN_HOST: "origin.example", ORIGIN_PORT: "39004", ORIGIN_SCHEME: "ws", WS_PATH: "/cf-vless", PATH_TOKEN: "single-token-123456" };
  const pending = worker.fetch(request("worker.example", "/cf-vless/single-token-123456", { upgrade: true }), singleEnv);
  await openHandshake(pending);
  assert.equal(outbound[0].url, "ws://origin.example:39004/cf-vless/single-token-123456");
  pairs[0][0].close();
  resetMocks();
  const response = await worker.fetch(request("missing.example", "/cf-vless/single-token-123456", { upgrade: true }), envMap());
  assert.equal(response.status, 404);
  assert.equal(outbound.length, 0);
});

test("reserves connection quota before handshake and releases it on close", { concurrency: false }, async () => {
  resetMocks();
  const env = { ORIGIN_MAP: JSON.stringify({ "japan.example": { host: "origin.example", port: 39001, scheme: "ws", path: "/vless", token: TOKEN_JP, max_connections: 1 } }) };
  const first = worker.fetch(request("japan.example", `/vless/${TOKEN_JP}`, { upgrade: true }), env);
  await Promise.resolve();
  const blocked = await worker.fetch(request("japan.example", `/vless/${TOKEN_JP}`, { upgrade: true }), env);
  assert.equal(blocked.status, 503);
  const firstResponse = await openHandshake(first, outbound[0]);
  assert.equal(firstResponse.status, 101);
  pairs[0][0].close();
  const thirdResponse = await openHandshake(worker.fetch(request("japan.example", `/vless/${TOKEN_JP}`, { upgrade: true }), env), outbound[1]);
  assert.equal(thirdResponse.status, 101);
  pairs[1][0].close();
});

test("releases quota after upstream error and timeout without waiting ten seconds", { concurrency: false }, async () => {
  resetMocks();
  const env = { ORIGIN_MAP: JSON.stringify({ "japan.example": { host: "origin.example", port: 39001, scheme: "ws", path: "/vless", token: TOKEN_JP, max_connections: 1 } }) };
  const failed = worker.fetch(request("japan.example", `/vless/${TOKEN_JP}`, { upgrade: true }), env);
  await Promise.resolve();
  outbound[0].dispatch("error");
  assert.equal((await failed).status, 502);
  globalThis.setTimeout = (callback) => { callback(); return 1; };
  globalThis.clearTimeout = () => {};
  const timedOut = await worker.fetch(request("japan.example", `/vless/${TOKEN_JP}`, { upgrade: true }), env);
  assert.equal(timedOut.status, 502);
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  const recovered = worker.fetch(request("japan.example", `/vless/${TOKEN_JP}`, { upgrade: true }), env);
  const response = await openHandshake(recovered, outbound[2]);
  assert.equal(response.status, 101);
  pairs.at(-1)?.[0].close();
});

test("releases quota if bridge response creation fails", { concurrency: false }, async () => {
  resetMocks();
  const env = { ORIGIN_MAP: JSON.stringify({ "japan.example": {
    host: "origin.example", port: 39001, scheme: "ws", path: "/vless", token: TOKEN_JP, max_connections: 1,
  } }) };
  class ThrowingResponse extends FakeResponse {
    constructor(body, init = {}) {
      if (init.status === 101) throw new Error("101 response unavailable");
      super(body, init);
    }
  }
  globalThis.Response = ThrowingResponse;
  const failed = worker.fetch(request("japan.example", `/vless/${TOKEN_JP}`, { upgrade: true }), env);
  await Promise.resolve();
  outbound[0].dispatch("open");
  try {
    const failedResponse = await failed;
    assert.equal(failedResponse.status, 500);
  } finally {
    globalThis.Response = FakeResponse;
  }
  assert.equal(outbound[0].closed, true);

  const recovered = worker.fetch(request("japan.example", `/vless/${TOKEN_JP}`, { upgrade: true }), env);
  const response = await openHandshake(recovered, outbound[1]);
  assert.equal(response.status, 101);
  pairs.at(-1)?.[0].close();
});

test("forwards binary messages in each direction without reordering", { concurrency: false }, async () => {
  resetMocks();
  await openHandshake(worker.fetch(request("japan.example", `/vless/${TOKEN_JP}`, { upgrade: true }), envMap()));
  const client = pairs[0][0];
  const workerSide = pairs[0][1];
  const origin = outbound[0];
  let releaseFirst;
  class ControlledBlob extends realBlob {
    constructor(parts, hold = false) {
      super(parts);
      this.hold = hold;
    }
    arrayBuffer() {
      if (!this.hold) return super.arrayBuffer();
      return new Promise((resolve) => {
        releaseFirst = () => super.arrayBuffer().then(resolve);
      });
    }
  }
  workerSide.dispatch("message", new ControlledBlob(["first"], true));
  workerSide.dispatch("message", new ControlledBlob(["second"]));
  await Promise.resolve();
  assert.equal(origin.sent.length, 0, "a later Blob must wait for the earlier conversion");
  releaseFirst();
  await new Promise((resolve) => realSetTimeout(resolve, 0));
  assert.equal(origin.sent.length, 2);
  const sent = await Promise.all(origin.sent.map(async (value) => new TextDecoder().decode(await new realResponse(value).arrayBuffer())));
  assert.deepEqual(sent, ["first", "second"]);
  origin.dispatch("message", new Uint8Array([1, 2, 3]).buffer);
  origin.dispatch("message", "text");
  await new Promise((resolve) => realSetTimeout(resolve, 0));
  assert.deepEqual(new Uint8Array(client.sent[0]), new Uint8Array([1, 2, 3]));
  assert.equal(client.sent[1], "text");
  client.close();
});
