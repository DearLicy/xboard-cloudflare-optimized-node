const DEFAULT_PATH = "/cf-vless";
const DEFAULT_HEALTH_PATH = "/healthz";
const DEFAULT_REQUIRE_PATH_TOKEN = true;
let activeConnections = 0;

function normalizePath(value, fallback) {
  const path = String(value || fallback).trim();
  if (!path.startsWith("/") || path.includes("?")) return fallback;
  return path.length > 1 ? path.replace(/\/+$/, "") : "/";
}

function requiresPathToken(env) {
  const value = String(env.REQUIRE_PATH_TOKEN ?? DEFAULT_REQUIRE_PATH_TOKEN)
    .trim()
    .toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

function configuredWebSocketPath(env) {
  const base = normalizePath(env.WS_PATH, DEFAULT_PATH);
  const token = String(env.PATH_TOKEN || "").trim();
  if (!token) return requiresPathToken(env) ? null : base;
  if (!/^[A-Za-z0-9._~-]{16,128}$/.test(token)) return null;
  return base === "/" ? `/${token}` : `${base}/${token}`;
}

function maxConnections(env) {
  const value = Number.parseInt(String(env.MAX_CONNECTIONS || "64"), 10);
  return Number.isFinite(value) && value >= 0 ? value : 64;
}

function textResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function jsonResponse(body, status = 200) {
  return textResponse(JSON.stringify(body), status, {
    "content-type": "application/json; charset=utf-8",
  });
}

function isWebSocketUpgrade(request) {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

function isValidIPv4(value) {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    return Number(part) <= 255;
  });
}

function isValidIPv6(value) {
  if (!value || value.includes("%") || !/^[0-9A-Fa-f:.]+$/.test(value)) {
    return false;
  }

  // An IPv4 tail occupies the final two IPv6 groups.
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    if (separator < 0 || !isValidIPv4(value.slice(separator + 1))) return false;
    value = `${value.slice(0, separator)}:0:0`;
  }

  const sections = value.split("::");
  if (sections.length > 2) return false;
  const groups = (section) => section ? section.split(":") : [];
  const left = groups(sections[0]);
  const right = sections.length === 2 ? groups(sections[1]) : [];
  if ([...left, ...right].some((group) => !/^[0-9A-Fa-f]{1,4}$/.test(group))) {
    return false;
  }
  const groupCount = left.length + right.length;
  return sections.length === 2 ? groupCount < 8 : groupCount === 8;
}

function normalizeOriginHost(value) {
  const host = String(value || "").trim();
  if (!host || host.length > 253 || /[\s/?#]/.test(host)) return null;

  if (host.startsWith("[") || host.endsWith("]")) {
    if (!host.startsWith("[") || !host.endsWith("]")) return null;
    const address = host.slice(1, -1);
    return isValidIPv6(address) ? `[${address}]` : null;
  }

  if (host.includes(":")) {
    return isValidIPv6(host) ? `[${host}]` : null;
  }

  if (/^[\d.]+$/.test(host)) return isValidIPv4(host) ? host : null;
  const labels = host.split(".");
  if (labels.some((label) =>
    label.length < 1 || label.length > 63 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) {
    return null;
  }
  return host;
}

function closeQuietly(socket, code = 1000, reason = "closed") {
  try {
    socket.close(code, reason);
  } catch {
    // The peer may already be closed.
  }
}

function relay(source, destination, onFailure) {
  source.addEventListener("message", (event) => {
    const send = (data) => {
      try {
        destination.send(data);
      } catch (error) {
        onFailure(error);
      }
    };
    if (typeof Blob !== "undefined" && event.data instanceof Blob) {
      event.data.arrayBuffer().then(send).catch(onFailure);
    } else {
      send(event.data);
    }
  });
  source.addEventListener("close", () => closeQuietly(destination));
  source.addEventListener("error", onFailure);
}

function bridge(clientSocket, originSocket, onClose) {
  // `originSocket` is created with `new WebSocket(url)` and is already an
  // outbound client socket. `accept()` is only valid for WebSocketPair's
  // server side and must not be called on the upstream socket.
  clientSocket.binaryType = "arraybuffer";
  originSocket.binaryType = "arraybuffer";
  clientSocket.accept({ allowHalfOpen: true });

  let finished = false;
  const fail = () => {
    if (finished) return;
    finished = true;
    onClose();
    closeQuietly(clientSocket, 1011, "upstream failure");
    closeQuietly(originSocket, 1011, "upstream failure");
  };
  const closeBoth = () => {
    if (finished) return;
    finished = true;
    onClose();
    closeQuietly(clientSocket);
    closeQuietly(originSocket);
  };

  relay(clientSocket, originSocket, fail);
  relay(originSocket, clientSocket, fail);
  clientSocket.addEventListener("close", closeBoth);
  originSocket.addEventListener("close", closeBoth);
  clientSocket.addEventListener("error", fail);
  originSocket.addEventListener("error", fail);
}

async function proxyWebSocket(request, env) {
  const url = new URL(request.url);
  const originHost = normalizeOriginHost(env.ORIGIN_HOST);
  const originPort = String(env.ORIGIN_PORT || "39004").trim();
  const originScheme = String(env.ORIGIN_SCHEME || "ws").trim().toLowerCase();
  if (!originHost) {
    return textResponse("origin is not configured", 500);
  }
  const portNumber = Number.parseInt(originPort, 10);
  if (!/^\d{1,5}$/.test(originPort) || portNumber < 1 || portNumber > 65535) {
    return textResponse("origin port is not configured", 500);
  }
  if (originScheme !== "ws" && originScheme !== "wss") {
    return textResponse("origin scheme is not configured", 500);
  }
  const limit = maxConnections(env);
  if (limit > 0 && activeConnections >= limit) {
    return textResponse("connection limit reached", 503, {
      "retry-after": "10",
    });
  }

  // Reserve a slot before awaiting the upstream handshake. Otherwise several
  // simultaneous handshakes can all observe the same counter and exceed the
  // configured limit.
  activeConnections += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeConnections = Math.max(0, activeConnections - 1);
  };

  const upstreamURL = `${originScheme}://${originHost}:${originPort}${url.pathname}${url.search}`;
  let upstreamSocket;
  try {
    upstreamSocket = new WebSocket(upstreamURL);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        closeQuietly(upstreamSocket, 1013, "upstream timeout");
        reject(new Error("upstream timeout"));
      }, 10000);
      upstreamSocket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      upstreamSocket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("upstream websocket error"));
      }, { once: true });
      upstreamSocket.addEventListener("close", () => {
        clearTimeout(timeout);
        reject(new Error("upstream websocket closed"));
      }, { once: true });
    });
  } catch {
    release();
    closeQuietly(upstreamSocket, 1011, "upstream unavailable");
    return textResponse("origin unavailable", 502);
  }

  const pair = new WebSocketPair();
  const clientSocket = pair[0];
  const workerSocket = pair[1];
  bridge(workerSocket, upstreamSocket, release);
  return new Response(null, { status: 101, webSocket: clientSocket });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const wsPath = configuredWebSocketPath(env);
    const healthPath = normalizePath(env.HEALTH_PATH, DEFAULT_HEALTH_PATH);

    if (!wsPath) {
      return textResponse("invalid path token", 500);
    }

    if (url.pathname === healthPath && request.method === "GET") {
      return jsonResponse({ ok: true, service: "xboard-cloudflare-node" });
    }

    if (url.pathname !== wsPath) {
      return textResponse("not found", 404);
    }

    if (!isWebSocketUpgrade(request)) {
      return textResponse("websocket upgrade required", 426, {
        upgrade: "websocket",
      });
    }

    return proxyWebSocket(request, env);
  },
};
