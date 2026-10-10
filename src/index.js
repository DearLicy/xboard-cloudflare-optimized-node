import { connect } from 'cloudflare:sockets';
import { readConfig, secretEqual } from './config.js';
import { panelRequest, userMap } from './panel.js';
import { createVlessSession, decodeEarlyData } from './protocol.js';
import { statelessReportPayload } from './stateless-report.js';

// This entry point deliberately has no Durable Object binding and never calls
// a storage API.  The state below is only an in-memory view of this Worker
// isolate.  It is useful for a best-effort status page and per-isolate safety
// caps; it must not be treated as a global quota or an accounting ledger.
const runtime = {
  sessions: new Set(),
  handshakes: 0,
  accepted: 0,
  authorized: 0,
  reportAttempts: 0,
  reportFailures: 0,
  lastError: null,
};

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const empty = status => new Response(null, { status, headers: { 'cache-control': 'no-store' } });

function status(route) {
  const active = [...runtime.sessions].filter(session => session.route.nodeId === route.nodeId).length;
  return {
    mode: 'stateless',
    persistent_storage: false,
    node_id: route.nodeId,
    hint: route.locationHint || 'ingress',
    active_sessions: active,
    pending_handshakes: runtime.handshakes,
    accepted_sessions: runtime.accepted,
    authorized_sessions: runtime.authorized,
    report_attempts: runtime.reportAttempts,
    report_failures: runtime.reportFailures,
    error: runtime.lastError,
    accounting: 'connection-close-best-effort',
    pending_bytes: 0,
    uncertain_batches: [],
  };
}

async function adminAllowed(request, env) {
  return Boolean(env.ADMIN_TOKEN && await secretEqual(
    request.headers.get('authorization'), `Bearer ${env.ADMIN_TOKEN}`,
  ));
}

export default {
  async fetch(request, env, ctx) {
    try {
      const config = readConfig(env);
      const url = new URL(request.url);
      const route = config.routes.get(url.hostname);
      if (!route) return empty(404);

      if (url.pathname === '/healthz' && request.method === 'GET') {
        return json({ ok: true, transport: 'vless-ws-tcp', mode: 'stateless', placement: 'ingress' });
      }

      if (url.pathname === '/admin/status') {
        if (request.method !== 'GET') return empty(405);
        if (!await adminAllowed(request, env)) return empty(403);
        return json(status(route));
      }

      if (url.pathname !== route.path || url.search || request.method !== 'GET') return empty(404);
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return empty(426);
      if (runtime.sessions.size + runtime.handshakes >= config.maxConnections) return empty(503);

      // Fetch the authorization list for every new connection.  There is no
      // cross-request cache in this mode, so revocations affect new handshakes
      // without pretending that existing sessions can be globally revoked.
      runtime.handshakes += 1;
      let users;
      try {
        users = userMap(await panelRequest(config, route.nodeId, 'user'));
      } finally {
        runtime.handshakes -= 1;
      }
      let earlyData;
      try { earlyData = decodeEarlyData(request.headers.get('sec-websocket-protocol') || ''); }
      catch { return empty(400); }

      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      server.accept();
      const session = {
        ip: request.headers.get('CF-Connecting-IP') || 'unknown',
        user: null,
        route,
        bridge: null,
      };
      runtime.sessions.add(session);
      try {
        session.bridge = createVlessSession(server, {
          connect,
          earlyData,
          authorize: async header => {
            const user = users.get(header.uuid);
            const destination = header.hostname.toLowerCase();
            if (!user || config.routes.has(destination) || new URL(config.panelUrl).hostname === destination) return false;
            if (config.allowedPorts.size && !config.allowedPorts.has(header.port)) return false;
            // MAX_USER_CONNECTIONS and device_limit are intentionally not
            // enforced globally here: this mode has no shared state.
            session.user = user;
            runtime.authorized += 1;
            return user;
          },
          onError: error => { runtime.lastError = error?.message || 'session_failed'; },
          onClose: async result => {
            runtime.sessions.delete(session);
            const payload = statelessReportPayload(result, [...runtime.sessions]);
            if (!payload) return;
            runtime.reportAttempts += 1;
            try {
              const response = await panelRequest(config, route.nodeId, 'report', payload);
              if (response.data !== true) throw new Error('invalid report acknowledgment');
            } catch {
              // A stateless Worker has nowhere to persist an ambiguous batch.
              // Do not retry: XBoard report has no idempotency key and replaying
              // after an unknown response could double-charge the user.
              runtime.reportFailures += 1;
            }
          },
        });
      } catch (error) {
        runtime.sessions.delete(session);
        throw error;
      }
      runtime.accepted += 1;
      ctx.waitUntil(session.bridge.done);
      try { return new Response(null, { status: 101, webSocket: client }); }
      catch (error) { session.bridge.shutdown(1011, 'Upgrade failed'); throw error; }
    } catch { return empty(503); }
  },
};
