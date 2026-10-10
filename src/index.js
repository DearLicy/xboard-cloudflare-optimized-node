const DEFAULT_PATH = "/cf-vless";
const DEFAULT_HEALTH_PATH = "/healthz";
let activeConnections = 0;

function normalizePath(value, fallback) {
  const path = String(value || fallback).trim();
  if (!path.startsWith("/") || path.includes("?")) return fallback;
  return path.length > 1 ? path.replace(/\/+$/, "") : "/";
}

function configuredWebSocketPath(env) {
  const base = normalizePath(env.WS_PATH, DEFAULT_PATH);
  const token = String(env.PATH_TOKEN || "").trim();
  if (!token) return base;
  if (!/^[A-Za-z0-9._~-]{8,128}$/.test(token)) return null;
  return `${base}/${token}`;
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
  clientSocket.accept();
  // `originSocket` is created with `new WebSocket(url)` and is already an
  // outbound client socket. `accept()` is only valid for WebSocketPair's
  // server side and must not be called on the upstream socket.
  clientSocket.binaryType = "arraybuffer";
  originSocket.binaryType = "arraybuffer";

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
  const rawOriginHost = String(env.ORIGIN_HOST || "").trim();
  const originPort = String(env.ORIGIN_PORT || "39004").trim();
  const originScheme = String(env.ORIGIN_SCHEME || "ws").trim().toLowerCase();
  if (!rawOriginHost || /[\s/?#]/.test(rawOriginHost)) {
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

  const originHost = rawOriginHost.includes(":") && !rawOriginHost.startsWith("[")
    ? `[${rawOriginHost}]`
    : rawOriginHost;
  const upstreamURL = `${originScheme}://${originHost}:${originPort}${url.pathname}${url.search}`;
  let upstreamSocket;
  try {
    upstreamSocket = new WebSocket(upstreamURL);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("upstream timeout")), 10000);
      upstreamSocket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      upstreamSocket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("upstream websocket error"));
      }, { once: true });
    });
  } catch {
    return textResponse("origin unavailable", 502);
  }

  const pair = new WebSocketPair();
  const clientSocket = pair[0];
  const workerSocket = pair[1];
  activeConnections += 1;
  bridge(workerSocket, upstreamSocket, () => {
    activeConnections = Math.max(0, activeConnections - 1);
  });
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
