const DEFAULT_PATH = "/cf-vless";
const DEFAULT_HEALTH_PATH = "/healthz";

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
    try {
      destination.send(event.data);
    } catch (error) {
      onFailure(error);
    }
  });
  source.addEventListener("close", () => closeQuietly(destination));
  source.addEventListener("error", onFailure);
}

function bridge(clientSocket, originSocket) {
  clientSocket.accept();
  originSocket.accept();

  let finished = false;
  const fail = () => {
    if (finished) return;
    finished = true;
    closeQuietly(clientSocket, 1011, "upstream failure");
    closeQuietly(originSocket, 1011, "upstream failure");
  };
  const closeBoth = () => {
    if (finished) return;
    finished = true;
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
  const originHost = String(env.ORIGIN_HOST || "").trim();
  const originPort = String(env.ORIGIN_PORT || "39004").trim();
  if (!originHost || !/^[a-zA-Z0-9.:[\]-]+$/.test(originHost)) {
    return textResponse("origin is not configured", 500);
  }
  if (!/^\d{1,5}$/.test(originPort)) {
    return textResponse("origin port is not configured", 500);
  }

  const originHeaders = new Headers(request.headers);
  // Let fetch generate the upstream Host and WebSocket handshake headers.
  originHeaders.delete("Host");
  originHeaders.delete("Cf-Connecting-Ip");
  originHeaders.delete("Cf-Connecting-IPv6");
  originHeaders.delete("Cf-Ray");
  originHeaders.delete("X-Forwarded-For");
  originHeaders.delete("X-Forwarded-Proto");
  originHeaders.set("Upgrade", "websocket");

  const upstreamURL = `http://${originHost}:${originPort}${url.pathname}${url.search}`;
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamURL, {
      method: "GET",
      headers: originHeaders,
    });
  } catch {
    return textResponse("origin unavailable", 502);
  }

  if (upstreamResponse.status !== 101 || !upstreamResponse.webSocket) {
    return textResponse("origin websocket upgrade failed", 502);
  }

  const pair = new WebSocketPair();
  const clientSocket = pair[0];
  const workerSocket = pair[1];
  bridge(workerSocket, upstreamResponse.webSocket);
  return new Response(null, { status: 101, webSocket: clientSocket });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const wsPath = String(env.WS_PATH || DEFAULT_PATH);
    const healthPath = String(env.HEALTH_PATH || DEFAULT_HEALTH_PATH);

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
