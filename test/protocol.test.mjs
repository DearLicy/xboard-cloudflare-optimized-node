import assert from "node:assert/strict";
import { test } from "node:test";
import { createVlessSession, decodeEarlyData, parseVlessHeader, ProtocolError } from "../src/protocol.js";

const UUID = "00112233-4455-6677-8899-aabbccddeeff";
const encoder = new TextEncoder();
const user = { id: 1, uuid: UUID, speedLimitMbps: 0 };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function header({ command = 1, port = 443, address = "example.com", type = 2, addons = [], payload = [] } = {}) {
  const uuidBytes = UUID.replace(/-/g, "").match(/../g).map((value) => parseInt(value, 16));
  let addressBytes;
  if (type === 1) addressBytes = address.split(".").map(Number);
  else if (type === 2) {
    const encoded = encoder.encode(address);
    addressBytes = [encoded.length, ...encoded];
  } else if (type === 3) addressBytes = address.flatMap((word) => [word >> 8, word & 255]);
  else addressBytes = [];
  return Uint8Array.from([0, ...uuidBytes, addons.length, ...addons, command, port >> 8, port & 255, type, ...addressBytes, ...payload]);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeWebSocket extends EventTarget {
  readyState = 1;
  sent = [];
  closes = [];
  send(bytes) {
    if (this.readyState !== 1) throw new Error("closed socket");
    this.sent.push(Uint8Array.from(bytes));
  }
  close(code, reason) { this.readyState = 3; this.closes.push({ code, reason }); }
  message(data) {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }
}

function fixture(extra = {}) {
  const ws = new FakeWebSocket();
  let incoming;
  const writes = [];
  const calls = [];
  const traffic = [];
  const closures = [];
  let tcpCloses = 0;
  const socket = {
    readable: new ReadableStream({ start(controller) { incoming = controller; } }),
    writable: new WritableStream({ write(bytes) { writes.push(Uint8Array.from(bytes)); } }),
    opened: Promise.resolve({}),
    closed: new Promise(() => {}),
    close() { tcpCloses++; try { incoming.close(); } catch {} return Promise.resolve(); },
  };
  const options = {
    connect(address, settings) { calls.push({ address, settings }); return socket; },
    authorize: async () => user,
    onTraffic: async (delta) => { traffic.push(delta); },
    onClose: async (result) => { closures.push(result); },
    limits: { handshakeTimeoutMs: 1_000, idleTimeoutMs: 0 },
    ...extra,
  };
  const session = createVlessSession(ws, options);
  return { ws, session, writes, calls, traffic, closures, socket, incoming, get tcpCloses() { return tcpCloses; } };
}

test("parses every fragmented prefix without prematurely completing a domain header", () => {
  const data = header({ addons: [1, 2, 3], payload: [9, 8, 7] });
  const full = parseVlessHeader(data);
  assert.equal(full.uuid, UUID);
  assert.equal(full.hostname, "example.com");
  assert.equal(full.port, 443);
  assert.deepEqual([...full.payload], [9, 8, 7]);
  for (let length = 0; length < full.headerLength; length++) assert.equal(parseVlessHeader(data.subarray(0, length)), null);
  assert.deepEqual([...parseVlessHeader(data.subarray(0, full.headerLength)).payload], []);
});

test("parses IPv4 and uncompressed globally routed IPv6 addresses", () => {
  assert.equal(parseVlessHeader(header({ type: 1, address: "8.8.4.4" })).hostname, "8.8.4.4");
  assert.equal(parseVlessHeader(header({ type: 3, address: [0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111] })).hostname, "2606:4700:4700:0:0:0:0:1111");
  const bytes = header({ type: 3, address: [0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111] });
  assert.equal(parseVlessHeader(bytes.subarray(0, -1)), null);
});

test("normalizes DNS case and trailing dot but rejects local or malformed destinations", () => {
  assert.equal(parseVlessHeader(header({ address: "WWW.Example.COM." })).hostname, "www.example.com");
  for (const address of ["localhost", "foo.local", "foo.localhost", "router.lan", "foo.internal", "foo.home.arpa", "foo..com", "-bad.example", "127.0.0.1", "2130706433", "bad/host.com", "foo.测试"]) {
    assert.throws(() => parseVlessHeader(header({ address })), ProtocolError, address);
  }
});

test("rejects private, local, multicast and reserved IP literals", () => {
  for (const address of ["0.0.0.0", "10.0.0.1", "127.1.2.3", "100.64.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "255.255.255.255"]) {
    assert.throws(() => parseVlessHeader(header({ type: 1, address })), /forbidden/, address);
  }
  for (const address of [[0, 0, 0, 0, 0, 0, 0, 1], [0xfc00, 0, 0, 0, 0, 0, 0, 1], [0xfe80, 0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1], [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]]) {
    assert.throws(() => parseVlessHeader(header({ type: 3, address })), /forbidden/);
  }
});

test("rejects UDP, multiplexing, bad version/address type and blocked ports", () => {
  assert.throws(() => parseVlessHeader(header({ command: 2 })), /UDP is unsupported/);
  assert.throws(() => parseVlessHeader(header({ command: 3 })), /command/);
  assert.throws(() => parseVlessHeader(header({ type: 99 })), /address type/);
  assert.throws(() => parseVlessHeader(header({ port: 0 })), /port forbidden/);
  assert.throws(() => parseVlessHeader(header({ port: 25 })), /port forbidden/);
  assert.throws(() => parseVlessHeader(Uint8Array.of(1)), /version/);
});

test("decodes canonical base64url early data and rejects malformed/oversized input", () => {
  const data = header({ payload: [255, 254, 253] });
  const encoded = Buffer.from(data).toString("base64url");
  assert.deepEqual(decodeEarlyData(encoded), data);
  assert.deepEqual(decodeEarlyData(""), new Uint8Array());
  for (const invalid of ["x", "%%%", "AA,AA", "_x", "a+b/"]) assert.throws(() => decodeEarlyData(invalid), /invalid early data/);
  assert.throws(() => decodeEarlyData(encoded, 2), /invalid early data/);
});

test("authenticates fragmented input before TCP connect, forwards payload and adds one VLESS response", async () => {
  let authHeader;
  const f = fixture({ authorize: async (value) => { authHeader = value; return user; } });
  const data = header({ payload: [1, 2, 3] });
  await f.session.receive(data.subarray(0, 11));
  assert.equal(f.calls.length, 0);
  await f.session.receive(data.subarray(11));
  assert.equal(authHeader.uuid, UUID);
  assert.deepEqual(f.calls[0].address, { hostname: "example.com", port: 443 });
  assert.deepEqual([...f.writes[0]], [1, 2, 3]);
  f.incoming.enqueue(Uint8Array.of(4, 5));
  await tick();
  f.incoming.enqueue(Uint8Array.of(6));
  await tick();
  assert.deepEqual(f.ws.sent.map((chunk) => [...chunk]), [[0, 0, 4, 5], [6]]);
  f.incoming.close();
  const result = await f.session.done;
  assert.equal(result.upload, 3);
  assert.equal(result.download, 3);
  assert.equal(result.user, user);
  assert.equal(f.traffic.reduce((total, delta) => total + delta.upload + delta.download, 0), 6);
  assert.equal(f.tcpCloses, 1);
  assert.equal(f.closures.length, 1);
});

test("serializes slow Blob conversion so later binary frames cannot overtake it", async () => {
  const release = deferred();
  class SlowBlob extends Blob { async arrayBuffer() { await release.promise; return super.arrayBuffer(); } }
  const f = fixture();
  const first = f.session.receive(new SlowBlob([header({ payload: [1] })]));
  const second = f.session.receive(Uint8Array.of(2, 3));
  await tick();
  assert.equal(f.calls.length, 0);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(f.writes.map((chunk) => [...chunk]), [[1], [2, 3]]);
  await f.session.shutdown();
});

test("consumes early data before ordinary WebSocket messages", async () => {
  const f = fixture({ earlyData: Buffer.from(header({ payload: [1] })).toString("base64url") });
  await f.session.receive(Uint8Array.of(2));
  assert.deepEqual(f.writes.map((chunk) => [...chunk]), [[1], [2]]);
  await f.session.shutdown();
});

test("denied authorization and UDP commands never create outbound sockets", async () => {
  const denied = fixture({ authorize: async () => false });
  await denied.session.receive(header());
  assert.equal((await denied.session.done).code, 1008);
  assert.equal(denied.calls.length, 0);
  const udp = fixture();
  await udp.session.receive(header({ command: 2 }));
  assert.match((await udp.session.done).reason, /UDP/);
  assert.equal(udp.calls.length, 0);
});

test("durable quota refusal prevents forwarding the rejected chunk", async () => {
  const f = fixture({ onTraffic: async () => false });
  await f.session.receive(header({ payload: [1, 2] }));
  const result = await f.session.done;
  assert.equal(result.code, 1008);
  assert.equal(result.upload, 0);
  assert.equal(f.writes.length, 0);
});

test("shared limiter and durable accounting execute before each transfer", async () => {
  const events = [];
  const f = fixture({
    beforeTransfer: async ({ bytes, direction, user: current }) => { assert.equal(current, user); events.push(`pace:${direction}:${bytes}`); },
    onTraffic: async ({ upload, download }) => { events.push(`account:${upload}:${download}`); },
  });
  await f.session.receive(header({ payload: [7] }));
  f.incoming.enqueue(Uint8Array.of(8, 9));
  await tick();
  assert.deepEqual(events, ["pace:upload:1", "account:1:0", "pace:download:2", "account:0:2"]);
  await f.session.shutdown();
});

test("queue cap closes a stalled authorization instead of buffering unlimited frames", async () => {
  const auth = deferred();
  const f = fixture({ authorize: () => auth.promise, limits: { handshakeTimeoutMs: 1_000, idleTimeoutMs: 0, maxQueuedBytes: 64 } });
  const first = f.session.receive(header());
  await tick();
  await f.session.receive(new Uint8Array(40));
  assert.equal(f.ws.closes[0].code, 1013);
  auth.resolve(user);
  await first;
  const result = await f.session.done;
  assert.equal(result.user, user, "late authorization must be released by onClose");
  assert.equal(f.calls.length, 0);
  assert.equal(f.closures.length, 1);
});

test("message size and queued-message limits reject oversize and empty-frame floods", async () => {
  const big = fixture({ limits: { handshakeTimeoutMs: 1_000, idleTimeoutMs: 0, maxMessageBytes: 32 } });
  await big.session.receive(new Uint8Array(33));
  assert.equal((await big.session.done).code, 1009);
  const auth = deferred();
  const empty = fixture({ authorize: () => auth.promise, limits: { handshakeTimeoutMs: 1_000, idleTimeoutMs: 0, maxQueuedMessages: 2 } });
  const pending = empty.session.receive(header());
  await tick();
  void empty.session.receive(new Uint8Array());
  await empty.session.receive(new Uint8Array());
  auth.resolve(user);
  await pending;
  assert.equal((await empty.session.done).code, 1013);
});

test("handshake timeout releases a late allocated user and creates no socket", async () => {
  const auth = deferred();
  const f = fixture({ authorize: () => auth.promise, limits: { handshakeTimeoutMs: 10, idleTimeoutMs: 0 } });
  const pending = f.session.receive(header());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.ws.closes[0].reason, "handshake timeout");
  auth.resolve(user);
  await pending;
  assert.equal((await f.session.done).user, user);
  assert.equal(f.calls.length, 0);
});

test("TCP connection timeout closes its socket and completes the session", async () => {
  const opened = deferred();
  const f = fixture({ limits: { handshakeTimeoutMs: 1_000, connectTimeoutMs: 10, idleTimeoutMs: 0 } });
  f.socket.opened = opened.promise;
  await f.session.receive(header());
  const result = await f.session.done;
  assert.equal(result.reason, "connect timeout");
  assert.equal(f.tcpCloses, 1);
});

test("accounting already in flight finishes before onClose totals are returned", async () => {
  const reservation = deferred();
  const f = fixture({ onTraffic: () => reservation.promise });
  const pending = f.session.receive(header({ payload: [1, 2, 3] }));
  await tick();
  const stopped = f.session.shutdown();
  reservation.resolve();
  await pending;
  assert.equal((await stopped).upload, 3);
  assert.equal(f.writes.length, 0, "closed session cannot forward after accounting resolves");
});

test("client close and repeated shutdown release TCP and call onClose only once", async () => {
  const f = fixture();
  await f.session.receive(header());
  f.ws.dispatchEvent(new Event("close"));
  await f.session.shutdown();
  await f.session.shutdown();
  assert.equal(f.tcpCloses, 1);
  assert.equal(f.closures.length, 1);
  assert.equal(f.ws.closes.length, 1);
});

test("text frames are rejected and per-session traffic limit stops excess payload", async () => {
  const text = fixture();
  await text.session.receive("not binary");
  assert.equal((await text.session.done).code, 1003);
  const capped = fixture({ limits: { handshakeTimeoutMs: 1_000, idleTimeoutMs: 0, maxTrafficBytes: 2 } });
  await capped.session.receive(header({ payload: [1, 2] }));
  await capped.session.receive(Uint8Array.of(3));
  assert.equal((await capped.session.done).upload, 2);
  assert.deepEqual(capped.writes.map((chunk) => [...chunk]), [[1, 2]]);
});

test("a connect exception terminates cleanly without leaking protocol errors", async () => {
  const f = fixture({ connect() { throw new Error("sensitive internal target detail"); } });
  await f.session.receive(header());
  assert.equal((await f.session.done).reason, "connection failed");
  assert.equal(f.closures.length, 1);
});

test("large valid addon/domain headers can arrive one byte at a time", async () => {
  const address = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
  const data = header({ address, addons: new Array(255).fill(0), payload: [42] });
  const f = fixture();
  for (const byte of data) await f.session.receive(Uint8Array.of(byte));
  assert.equal(f.calls[0].address.hostname, address);
  assert.deepEqual([...f.writes[0]], [42]);
  await f.session.shutdown();
});

test("TCP read and closed-promise failures shut down without unhandled rejection", async () => {
  const read = fixture();
  await read.session.receive(header());
  read.incoming.error(new Error("TCP read failed"));
  assert.equal((await read.session.done).code, 1011);
  assert.equal(read.tcpCloses, 1);
  const closed = deferred();
  const f = fixture();
  f.socket.closed = closed.promise;
  await f.session.receive(header());
  closed.reject(new Error("TCP closed rejected"));
  assert.equal((await f.session.done).code, 1011);
  assert.equal(f.tcpCloses, 1);
});

test("large downstream reads split into bounded WebSocket frames with a single response header", async () => {
  const f = fixture({ limits: { handshakeTimeoutMs: 1_000, idleTimeoutMs: 0, maxMessageBytes: 40 } });
  await f.session.receive(header());
  f.incoming.enqueue(new Uint8Array(100).fill(9));
  await tick();
  assert.deepEqual(f.ws.sent.map((chunk) => chunk.length), [40, 38, 24]);
  assert.deepEqual([...f.ws.sent[0].subarray(0, 2)], [0, 0]);
  assert.equal(f.ws.sent[1][0], 9);
  assert.equal((await f.session.shutdown()).download, 100);
});

test("failed downstream send retains durable attempted-byte accounting and closes TCP", async () => {
  const f = fixture();
  await f.session.receive(header());
  f.ws.send = () => { throw new Error("send failed"); };
  f.incoming.enqueue(Uint8Array.of(1, 2));
  const result = await f.session.done;
  assert.equal(result.code, 1011);
  assert.equal(result.download, 2);
  assert.equal(f.tcpCloses, 1);
});

test("simultaneous directions reserve session quota before an asynchronous accounting hook", async () => {
  const release = deferred();
  const f = fixture({ onTraffic: () => release.promise, limits: { handshakeTimeoutMs: 1_000, idleTimeoutMs: 0, maxTrafficBytes: 3 } });
  const upload = f.session.receive(header({ payload: [1, 2] }));
  await tick();
  f.incoming.enqueue(Uint8Array.of(3, 4));
  await tick();
  assert.equal(f.ws.closes[0].reason, "traffic limit reached");
  release.resolve();
  await upload;
  const result = await f.session.done;
  assert.equal(result.upload, 2);
  assert.equal(result.download, 0);
});

test("idle and maximum-duration timers close established connections", async () => {
  const idle = fixture({ limits: { handshakeTimeoutMs: 1_000, idleTimeoutMs: 10 } });
  await idle.session.receive(header());
  assert.equal((await idle.session.done).reason, "idle timeout");
  assert.equal(idle.tcpCloses, 1);
  const duration = fixture({ limits: { handshakeTimeoutMs: 1_000, idleTimeoutMs: 0, maxSessionMs: 10 } });
  await duration.session.receive(header());
  assert.equal((await duration.session.done).reason, "session duration limit");
  assert.equal(duration.tcpCloses, 1);
});
