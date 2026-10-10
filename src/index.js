const DEFAULT_PATH = "/cf-vless";
const DEFAULT_HEALTH_PATH = "/healthz";
const DEFAULT_REQUIRE_PATH_TOKEN = true;
const DEFAULT_MAX_CONNECTIONS = 64;
// Workers environment values and Secrets are limited to roughly 5 KiB.
const MAX_ORIGIN_MAP_BYTES = 4800;
const MAX_ORIGIN_ENTRIES = 32;
const activeConnections = new Map();

function normalizePath(value, fallback) {
  const path = String(value || fallback).trim();
  if (!path.startsWith("/") || path.includes("?")) return fallback;
  return path.length > 1 ? path.replace(/\/+$/, "") : "/";
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function requiresPathToken(config) {
  return parseBoolean(config.requirePathToken, DEFAULT_REQUIRE_PATH_TOKEN);
}

function configuredWebSocketPath(config) {
  const base = normalizePath(config.wsPath, DEFAULT_PATH);
  const token = String(config.pathToken || "").trim();
  if (!token) return requiresPathToken(config) ? null : base;
  if (!/^[A-Za-z0-9._~-]{16,128}$/.test(token)) return null;
  return base === "/" ? `/${token}` : `${base}/${token}`;
}

function maxConnections(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_MAX_CONNECTIONS), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_CONNECTIONS;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function entryValue(entry, key, fallback) {
  return entry && hasOwn(entry, key) ? entry[key] : fallback;
}

function legacyOriginConfig(env) {
  return {
    host: env.ORIGIN_HOST,
    port: env.ORIGIN_PORT,
    scheme: env.ORIGIN_SCHEME,
    wsPath: env.WS_PATH,
    pathToken: env.PATH_TOKEN,
    requirePathToken: env.REQUIRE_PATH_TOKEN,
    maxConnections: env.MAX_CONNECTIONS,
  };
}

function mapOriginConfig(entry, env) {
  return {
    host: entryValue(entry, "host", ""),
    port: entryValue(entry, "port", "39004"),
    scheme: entryValue(entry, "scheme", "ws"),
    wsPath: entryValue(entry, "path", DEFAULT_PATH),
    pathToken: entryValue(entry, "token", ""),
    requirePathToken: entryValue(entry, "require_path_token", env.REQUIRE_PATH_TOKEN),
    maxConnections: entryValue(entry, "max_connections", env.MAX_CONNECTIONS),
  };
}

function normalizeRouteHost(value) {
  const host = String(value || "").trim().toLowerCase();
  if (!host || host.length > 253 || /[\s/?#:]/.test(host)) return null;
  if (/^[\d.]+$/.test(host)) return isValidIPv4(host) ? host : null;
  const labels = host.split(".");
  if (labels.some((label) =>
    label.length < 1 || label.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return null;
  }
  return host;
}

function parseOriginMap(env) {
  const raw = String(env.ORIGIN_MAP || "").trim();
  if (!raw) return { mode: "single" };
  if (new TextEncoder().encode(raw).byteLength > MAX_ORIGIN_MAP_BYTES) {
    return { error: "origin map is too large" };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "invalid origin map" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "invalid origin map" };
  }

  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > MAX_ORIGIN_ENTRIES) {
    return { error: "invalid origin map" };
  }

  const map = new Map();
  for (const [host, entry] of entries) {
    const routeHost = normalizeRouteHost(host);
    if (!routeHost || !entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: "invalid origin map" };
    }
    if (map.has(routeHost)) return { error: "invalid origin map" };
    map.set(routeHost, entry);
  }
  return { mode: "map", entries: map };
}

function normalizeOriginConfig(config) {
  const originHost = normalizeOriginHost(config.host);
  if (!originHost) return { error: "origin is not configured" };

  const originPort = String(config.port ?? "39004").trim();
  const portNumber = Number.parseInt(originPort, 10);
  if (!/^\d{1,5}$/.test(originPort) || portNumber < 1 || portNumber > 65535) {
    return { error: "origin port is not configured" };
  }

  const originScheme = String(config.scheme ?? "ws").trim().toLowerCase();
  if (originScheme !== "ws" && originScheme !== "wss") {
    return { error: "origin scheme is not configured" };
  }

  const normalized = {
    ...config,
    originHost,
    originPort,
    originScheme,
    maxConnections: maxConnections(config.maxConnections),
  };
  const webSocketPath = configuredWebSocketPath(normalized);
  if (!webSocketPath) return { error: "invalid path token" };
  normalized.webSocketPath = webSocketPath;
  return { config: normalized };
}

function isSelfOrigin(url, config) {
  const requestHost = normalizeOriginHost(url.hostname);
  return requestHost && requestHost.toLowerCase() === config.originHost.toLowerCase();
}

function resolveOrigin(url, env) {
  const originMap = parseOriginMap(env);
  if (originMap.error) return originMap;
  if (originMap.mode === "single") {
    const normalized = normalizeOriginConfig(legacyOriginConfig(env));
    if (normalized.error) return normalized;
    return isSelfOrigin(url, normalized.config)
      ? { error: "origin cannot match worker host" }
      : { key: "__single__", ...normalized };
  }

  const routeHost = normalizeRouteHost(url.hostname);
  const entry = routeHost ? originMap.entries.get(routeHost) : undefined;
  if (!entry) return { notFound: true };
  const normalized = normalizeOriginConfig(mapOriginConfig(entry, env));
  if (normalized.error) return normalized;
  return isSelfOrigin(url, normalized.config)
    ? { error: "origin cannot match worker host" }
    : { key: routeHost, ...normalized };
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
  let queue = Promise.resolve();
  let stopped = false;
  source.addEventListener("message", (event) => {
    queue = queue.then(async () => {
      if (stopped) return;
      try {
        const data = typeof Blob !== "undefined" && event.data instanceof Blob
          ? await event.data.arrayBuffer()
          : event.data;
        if (stopped) return;
        destination.send(data);
      } catch (error) {
        stopped = true;
        onFailure(error);
      }
    });
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

function reserveConnection(key, limit) {
  const current = activeConnections.get(key) || 0;
  if (limit > 0 && current >= limit) return false;
  activeConnections.set(key, current + 1);
  return true;
}

function releaseConnection(key) {
  const current = activeConnections.get(key) || 0;
  if (current <= 1) {
    activeConnections.delete(key);
  } else {
    activeConnections.set(key, current - 1);
  }
}

async function proxyWebSocket(request, url, originKey, config) {
  if (!reserveConnection(originKey, config.maxConnections)) {
    return textResponse("connection limit reached", 503, {
      "retry-after": "10",
    });
  }

  // Reserve a slot before awaiting the upstream handshake. Otherwise several
  // simultaneous handshakes can all observe the same counter and exceed the
  // configured limit.
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseConnection(originKey);
  };

  const upstreamURL = `${config.originScheme}://${config.originHost}:${config.originPort}${url.pathname}${url.search}`;
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
  try {
    bridge(workerSocket, upstreamSocket, release);
    return new Response(null, { status: 101, webSocket: clientSocket });
  } catch {
    // A runtime can reject the 101 response or the WebSocketPair setup. Do
    // not leave the upstream socket or the per-route quota slot behind.
    release();
    closeQuietly(workerSocket, 1011, "worker websocket setup failed");
    closeQuietly(clientSocket, 1011, "worker websocket setup failed");
    closeQuietly(upstreamSocket, 1011, "worker websocket setup failed");
    return textResponse("websocket setup failed", 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const healthPath = normalizePath(env.HEALTH_PATH, DEFAULT_HEALTH_PATH);
    const selection = resolveOrigin(url, env);

    if (selection.error) {
      return textResponse(selection.error, 500);
    }
    if (selection.notFound) {
      return textResponse("not found", 404);
    }

    if (url.pathname === healthPath && request.method === "GET") {
      return jsonResponse({ ok: true, service: "xboard-cloudflare-node" });
    }

    if (url.pathname !== selection.config.webSocketPath) {
      return textResponse("not found", 404);
    }

    if (!isWebSocketUpgrade(request)) {
      return textResponse("websocket upgrade required", 426, {
        upgrade: "websocket",
      });
    }

    return proxyWebSocket(request, url, selection.key, selection.config);
  },
};
