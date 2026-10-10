export const LOCATION_HINTS = new Set(['wnam', 'enam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc']);
export function integer(value, fallback, min = 1, max = 86400) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error('invalid integer configuration');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('integer configuration out of range');
  return n;
}
export function readConfig(env) {
  const panel = env.PANEL_URL ? new URL(env.PANEL_URL) : null;
  if (!panel || panel.protocol !== 'https:' || panel.username || panel.password || panel.search || panel.hash || !env.PANEL_TOKEN) throw new Error('panel credentials are required');
  if (panel && (panel.protocol !== 'https:' || panel.username || panel.password || panel.search || panel.hash)) throw new Error('invalid panel URL');
  if (!/^[A-Za-z0-9._~-]{16,128}$/.test(env.PATH_TOKEN || '')) throw new Error('missing secrets');
  const raw = String(env.REGION_MAP || '');
  if (new TextEncoder().encode(raw).length > 4800) throw new Error('region map too large');
  const map = JSON.parse(raw);
  if (!map || Array.isArray(map) || typeof map !== 'object') throw new Error('invalid region map');
  const entries = Object.entries(map);
  if (!entries.length || entries.length > 32) throw new Error('invalid region count');
  const routes = new Map(), ids = new Set();
  for (const [host, entry] of entries) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host) || host.length > 253) throw new Error('invalid route host');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid route');
    const nodeId = integer(entry.node_id, undefined, 1, 2147483647);
    if (!nodeId || ids.has(nodeId)) throw new Error('node IDs must be unique');
    ids.add(nodeId);
    if (entry.location_hint !== undefined && !LOCATION_HINTS.has(entry.location_hint)) throw new Error('unsupported location hint');
    const path = entry.path || env.WS_PATH || '/cf-vless';
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path) || path.length > 128) throw new Error('invalid WebSocket path');
    routes.set(host, { nodeId, locationHint: entry.location_hint, path: `${path.replace(/\/+$/, '')}/${env.PATH_TOKEN}` });
  }
  const ports = String(env.ALLOWED_PORTS || '').split(',').filter(Boolean).map(p => integer(p.trim(), undefined, 1, 65535));
  const machineId = env.MACHINE_ID ? integer(env.MACHINE_ID, undefined, 1, 2147483647) : undefined;
  return {
    panelUrl: panel.href.replace(/\/+$/, ''), panelToken: env.PANEL_TOKEN, machineId, routes,
    userSyncSeconds: integer(env.USER_SYNC_SECONDS, 60, 10, 600), reportSeconds: integer(env.REPORT_SECONDS, 60, 10, 600),
    maxConnections: integer(env.MAX_CONNECTIONS, 128, 1, 1000), maxUserConnections: integer(env.MAX_USER_CONNECTIONS, 16, 1, 1000),
    maxPendingBytes: integer(env.MAX_PENDING_BYTES, 104857600, 1024, 1073741824), allowedPorts: new Set(ports),
  };
}
export function routeObjectName(route, request) {
  // Region objects coordinate one node. Global nodes shard near the ingress.
  const suffix = route.locationHint ? 'region' : (request.cf?.colo || 'default');
  return `node-${route.nodeId}-v1-${suffix}`;
}
export async function secretEqual(a, b) {
  if (!a || !b) return false;
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(a)), crypto.subtle.digest('SHA-256', encoder.encode(b))]);
  const ax = new Uint8Array(x), ay = new Uint8Array(y); let diff = 0;
  for (let i = 0; i < ax.length; i++) diff |= ax[i] ^ ay[i];
  return diff === 0;
}
