// This module deliberately has no platform imports. The caller injects the
// Workers TCP API and its XBoard authorization/accounting implementation.
const HEADER_LIMIT = 533;
const DEFAULT_LIMITS = Object.freeze({
  maxMessageBytes: 1024 * 1024,
  maxQueuedBytes: 2 * 1024 * 1024,
  maxQueuedMessages: 64,
  handshakeTimeoutMs: 10_000,
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 120_000,
  maxSessionMs: 0,
  maxTrafficBytes: 0,
  speedLimitMbps: 0,
});

export class ProtocolError extends Error {
  constructor(message, closeCode = 1008) {
    super(message);
    this.name = "ProtocolError";
    this.closeCode = closeCode;
  }
}

function bytesView(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new ProtocolError("binary frames required", 1003);
}

function publicIPv4(parts) {
  const [a, b, c] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

function domainName(bytes) {
  if (bytes.some((byte) => byte > 127)) throw new ProtocolError("invalid destination");
  const host = new TextDecoder().decode(bytes).toLowerCase().replace(/\.$/, "");
  if (host.length > 253 || !host.includes(".") || /^[\d.]+$/.test(host) ||
      host.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      /(?:^|\.)(?:localhost|local|lan|internal|invalid|test)$/.test(host) ||
      host.endsWith(".home.arpa")) {
    throw new ProtocolError("invalid destination");
  }
  return host;
}

/** Returns null for an incomplete header; payload is a view of the input. */
export function parseVlessHeader(value) {
  const bytes = bytesView(value);
  if (bytes.length === 0) return null;
  if (bytes[0] !== 0) throw new ProtocolError("unsupported VLESS version");
  if (bytes.length < 18) return null;
  const optionLength = bytes[17];
  let offset = 18 + optionLength;
  if (bytes.length < offset + 4) return null;
  const command = bytes[offset++];
  if (command !== 1) throw new ProtocolError(command === 2 ? "UDP is unsupported" : "unsupported VLESS command");
  const port = (bytes[offset++] << 8) | bytes[offset++];
  if (!port || port === 25) throw new ProtocolError("destination port forbidden");
  const addressType = bytes[offset++];
  let hostname;
  if (addressType === 1) {
    if (bytes.length < offset + 4) return null;
    const parts = Array.from(bytes.subarray(offset, offset + 4));
    if (!publicIPv4(parts)) throw new ProtocolError("destination address forbidden");
    hostname = parts.join(".");
    offset += 4;
  } else if (addressType === 2) {
    if (bytes.length < offset + 1) return null;
    const length = bytes[offset++];
    if (!length) throw new ProtocolError("invalid destination");
    if (bytes.length < offset + length) return null;
    hostname = domainName(bytes.subarray(offset, offset + length));
    offset += length;
  } else if (addressType === 3) {
    if (bytes.length < offset + 16) return null;
    const words = [];
    for (let i = 0; i < 16; i += 2) {
      words.push((bytes[offset + i] << 8) | bytes[offset + i + 1]);
    }
    // Accept ordinary globally routed IPv6 unicast only. This also excludes
    // mapped/local/NAT64 forms that could encode an otherwise forbidden IPv4.
    if ((words[0] & 0xe000) !== 0x2000 || (words[0] === 0x2001 && words[1] === 0x0db8)) {
      throw new ProtocolError("destination address forbidden");
    }
    hostname = words.map((word) => word.toString(16)).join(":");
    offset += 16;
  } else {
    throw new ProtocolError("unsupported destination address type");
  }
  const uuidHex = Array.from(bytes.subarray(1, 17), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const uuid = `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(12, 16)}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20)}`;
  return { version: 0, uuid, command, hostname, port, headerLength: offset, payload: bytes.subarray(offset) };
}

/** Decode Xray's URL-safe base64 Sec-WebSocket-Protocol early data. */
export function decodeEarlyData(value, maxBytes = DEFAULT_LIMITS.maxMessageBytes) {
  if (!value) return new Uint8Array();
  const input = String(value);
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(input) || input.length > Math.ceil(maxBytes / 3) * 4 || input.replace(/=+$/, "").length % 4 === 1) {
    throw new ProtocolError("invalid early data", 1003);
  }
  try {
    const unpadded = input.replace(/=+$/, "");
    const decoded = atob(unpadded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - unpadded.length % 4) % 4));
    if (decoded.length > maxBytes) throw new Error("too large");
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    // Reject non-canonical encodings rather than silently discarding pad bits.
    const canonical = btoa(decoded).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    if (canonical !== unpadded) throw new Error("invalid padding");
    return bytes;
  } catch {
    throw new ProtocolError("invalid early data", 1003);
  }
}

function finiteLimit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function payloadSize(value) {
  if (value instanceof Blob) return value.size;
  return bytesView(value).byteLength;
}

class SessionStopped extends Error {}

/**
 * The caller accepts the WebSocket and retains `done` with waitUntil().
 * authorize(header) returns a user object, or false/null to refuse access.
 * beforeTransfer({bytes,direction,user}) may enforce a shared speed limiter.
 * onTraffic({upload,download,user}) reserves durable traffic before I/O; false
 * refuses that chunk. Counts include attempted bytes if subsequent I/O fails.
 * onClose receives totals and the same user object, exactly once.
 */
export function createVlessSession(webSocket, options) {
  const limits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, fallback]) =>
    [key, finiteLimit(options.limits?.[key], fallback)]));
  let stopped = false;
  let closeCode = 1000;
  let closeReason = "closed";
  let user = null;
  let socket;
  let writer;
  let reader;
  let headerBuffer = new Uint8Array();
  let authorized = false;
  let responseSent = false;
  let upload = 0;
  let download = 0;
  let reservedTraffic = 0;
  let queuedBytes = 0;
  let queuedMessages = 0;
  let messageChain = Promise.resolve();
  const pendingHooks = new Set();
  const timers = new Set();
  let idleTimer;
  let handshakeTimer;
  let resolveStopped;
  let resolveDone;
  const stoppedPromise = new Promise((resolve) => { resolveStopped = resolve; });
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const nextTransfer = { upload: 0, download: 0 };

  function setTimer(callback, duration) {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, duration);
    timers.add(timer);
    return timer;
  }

  function clearTimer(timer) {
    if (timer !== undefined) { clearTimeout(timer); timers.delete(timer); }
  }

  function trackHook(promise) {
    const tracked = Promise.resolve(promise);
    pendingHooks.add(tracked);
    // Both handlers return normally, so the cleanup promise cannot reject.
    void tracked.then(() => pendingHooks.delete(tracked), () => pendingHooks.delete(tracked));
    return tracked;
  }

  async function interruptible(promise) {
    if (stopped) throw new SessionStopped();
    return Promise.race([promise, stoppedPromise.then(() => { throw new SessionStopped(); })]);
  }

  function resetIdle() {
    clearTimer(idleTimer);
    if (limits.idleTimeoutMs > 0 && !stopped) {
      idleTimer = setTimer(() => { void shutdown(1000, "idle timeout"); }, limits.idleTimeoutMs);
    }
  }

  function fail(error) {
    if (stopped || error instanceof SessionStopped) return;
    if (options.onError) {
      try { void Promise.resolve(options.onError(error)).catch(() => {}); } catch { /* logging cannot break cleanup */ }
    }
    void shutdown(error instanceof ProtocolError ? error.closeCode : 1011,
      error instanceof ProtocolError ? error.message : "connection failed");
  }

  function shutdown(code = 1000, reason = "closed") {
    if (stopped) return done;
    stopped = true;
    closeCode = code;
    closeReason = String(reason).slice(0, 100);
    resolveStopped();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    webSocket.removeEventListener?.("message", onMessage);
    webSocket.removeEventListener?.("close", onPeerClose);
    webSocket.removeEventListener?.("error", onPeerError);
    try { webSocket.close(code, closeReason); } catch { /* already closed */ }
    for (const cleanup of [() => reader?.cancel(), () => writer?.abort(), () => socket?.close()]) {
      try { void Promise.resolve(cleanup()).catch(() => {}); } catch { /* already closed */ }
    }
    void (async () => {
      // In-flight authorization can allocate a user slot after the timeout.
      // Wait for its result so onClose can release that same slot reliably.
      await Promise.allSettled([...pendingHooks]);
      const result = { user, upload, download, code: closeCode, reason: closeReason };
      try { await options.onClose?.(result); } catch (error) {
        try { await options.onError?.(error); } catch { /* logging only */ }
      }
      resolveDone(result);
    })();
    return done;
  }

  async function pace(bytes, direction) {
    if (options.beforeTransfer) {
      const accepted = await interruptible(trackHook(options.beforeTransfer({ bytes, direction, user })));
      if (accepted === false) throw new ProtocolError("transfer limit reached");
      return;
    }
    const mbps = finiteLimit(user?.speedLimitMbps, limits.speedLimitMbps);
    if (!mbps) return;
    const bytesPerMs = mbps * 125;
    const now = Date.now();
    // A small initial burst avoids delaying every TLS handshake.
    const burstMs = 64 * 1024 / bytesPerMs;
    const end = Math.max(now - burstMs, nextTransfer[direction]) + bytes / bytesPerMs;
    nextTransfer[direction] = end;
    const delay = Math.max(0, end - now);
    if (delay) await interruptible(new Promise((resolve) => { setTimer(resolve, delay); }));
  }

  async function account(bytes, direction) {
    if (stopped) throw new SessionStopped();
    if (limits.maxTrafficBytes > 0 && upload + download + reservedTraffic + bytes > limits.maxTrafficBytes) {
      throw new ProtocolError("traffic limit reached");
    }
    const delta = { upload: direction === "upload" ? bytes : 0, download: direction === "download" ? bytes : 0, user };
    if (options.onTraffic) {
      reservedTraffic += bytes;
      const accounting = trackHook(Promise.resolve().then(() => options.onTraffic(delta)).then((accepted) => {
        if (accepted !== false) {
          if (direction === "upload") upload += bytes;
          else download += bytes;
        }
        return accepted;
      }).finally(() => { reservedTraffic -= bytes; }));
      const accepted = await interruptible(accounting);
      if (accepted === false) throw new ProtocolError("traffic limit reached");
      return;
    }
    if (direction === "upload") upload += bytes;
    else download += bytes;
  }

  async function transfer(bytes, direction) {
    if (!bytes.byteLength) return;
    await pace(bytes.byteLength, direction);
    await account(bytes.byteLength, direction);
    if (stopped) throw new SessionStopped();
    if (direction === "upload") {
      await interruptible(writer.write(bytes));
    } else {
      // Some WebSocket implementations expose bufferedAmount. Workers do not
      // promise it, so accounting/speed controls are also awaited per chunk.
      if (Number(webSocket.bufferedAmount) > limits.maxQueuedBytes) {
        throw new ProtocolError("downstream queue full", 1013);
      }
      if (!responseSent) {
        const first = new Uint8Array(bytes.length + 2);
        first.set(bytes, 2);
        webSocket.send(first);
        responseSent = true;
      } else {
        webSocket.send(bytes);
      }
    }
    resetIdle();
  }

  async function readDownstream() {
    try {
      while (!stopped) {
        const result = await interruptible(reader.read());
        if (result.done) { void shutdown(1000, "upstream closed"); return; }
        const bytes = bytesView(result.value);
        const chunkSize = Math.max(1, limits.maxMessageBytes - 2);
        for (let offset = 0; offset < bytes.length && !stopped; offset += chunkSize) {
          await transfer(bytes.subarray(offset, offset + chunkSize), "download");
        }
      }
    } catch (error) { fail(error); }
    finally { try { reader?.releaseLock(); } catch { /* read may still be pending during cancellation */ } }
  }

  async function establish(header) {
    const authorization = trackHook(Promise.resolve().then(() => options.authorize(header)).then((result) => {
      if (result && typeof result === "object") user = result;
      return result;
    }));
    const result = await interruptible(authorization);
    if (!result || typeof result !== "object") throw new ProtocolError("authentication failed");
    socket = options.connect({ hostname: header.hostname, port: header.port }, { secureTransport: "off", allowHalfOpen: false });
    if (!socket?.readable || !socket?.writable) throw new Error("invalid TCP socket");
    if (socket.closed) void Promise.resolve(socket.closed).catch(fail);
    const connectTimer = limits.connectTimeoutMs > 0
      ? setTimer(() => { void shutdown(1011, "connect timeout"); }, limits.connectTimeoutMs)
      : undefined;
    try { if (socket.opened) await interruptible(socket.opened); }
    finally { clearTimer(connectTimer); }
    if (stopped) throw new SessionStopped();
    writer = socket.writable.getWriter();
    reader = socket.readable.getReader();
    authorized = true;
    clearTimer(handshakeTimer);
    resetIdle();
    void readDownstream();
  }

  async function process(data) {
    if (stopped) return;
    const bytes = data instanceof Blob ? new Uint8Array(await interruptible(data.arrayBuffer())) : bytesView(data);
    if (stopped) return;
    if (authorized) { await transfer(bytes, "upload"); return; }
    const combined = new Uint8Array(headerBuffer.length + bytes.length);
    combined.set(headerBuffer);
    combined.set(bytes, headerBuffer.length);
    const header = parseVlessHeader(combined);
    if (!header) {
      if (combined.length >= HEADER_LIMIT) throw new ProtocolError("invalid VLESS header");
      headerBuffer = combined;
      return;
    }
    headerBuffer = new Uint8Array();
    await establish(header);
    await transfer(header.payload, "upload");
  }

  function receive(data) {
    if (stopped) return Promise.resolve();
    let size;
    try { size = payloadSize(data); } catch (error) { fail(error); return Promise.resolve(); }
    if (size > limits.maxMessageBytes || queuedBytes + size > limits.maxQueuedBytes || queuedMessages >= limits.maxQueuedMessages) {
      fail(new ProtocolError("incoming queue full", size > limits.maxMessageBytes ? 1009 : 1013));
      return Promise.resolve();
    }
    queuedBytes += size;
    queuedMessages++;
    messageChain = messageChain.then(() => process(data)).catch(fail).finally(() => {
      queuedBytes -= size;
      queuedMessages--;
    });
    return messageChain;
  }

  function onMessage(event) { void receive(event.data); }
  function onPeerClose() { void shutdown(1000, "client closed"); }
  function onPeerError() { fail(new Error("WebSocket failure")); }
  webSocket.binaryType = "arraybuffer";
  webSocket.addEventListener("message", onMessage);
  webSocket.addEventListener("close", onPeerClose);
  webSocket.addEventListener("error", onPeerError);
  if (limits.handshakeTimeoutMs > 0) {
    handshakeTimer = setTimer(() => { void shutdown(1008, "handshake timeout"); }, limits.handshakeTimeoutMs);
  }
  if (limits.maxSessionMs > 0) setTimer(() => { void shutdown(1000, "session duration limit"); }, limits.maxSessionMs);
  if (options.earlyData) {
    try { void receive(typeof options.earlyData === "string" ? decodeEarlyData(options.earlyData, limits.maxMessageBytes) : options.earlyData); }
    catch (error) { fail(error); }
  }
  return { done, shutdown, receive };
}
