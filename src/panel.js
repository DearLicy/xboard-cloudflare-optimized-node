export async function panelRequest(config, nodeId, endpoint, payload, fetcher = fetch) {
  const credentials = { node_id: nodeId, token: config.panelToken };
  if (config.machineId) credentials.machine_id = config.machineId;
  const url = new URL(`${config.panelUrl}/api/v2/server/${endpoint}`);
  const options = { headers: { 'user-agent': 'xboard-cloudflare-node/2.0', accept: 'application/json' }, signal: AbortSignal.timeout(12000) };
  if (payload === undefined) {
    for (const [key, value] of Object.entries(credentials)) url.searchParams.set(key, String(value));
  } else {
    options.method = 'POST'; options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify({ ...payload, ...credentials });
  }
  const response = await fetcher(url, options);
  if (!response.ok) { await response.body?.cancel(); throw new Error(`panel HTTP ${response.status}`); }
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('panel response too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(length); let at = 0;
  for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }
  return JSON.parse(new TextDecoder().decode(joined));
}
export function userMap(response) {
  const users = response.users || response.data?.users || response.data;
  if (!Array.isArray(users)) throw new Error('invalid panel users response');
  const map = new Map();
  for (const user of users) {
    if (!Number.isSafeInteger(Number(user.id)) || Number(user.id) < 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.uuid)) throw new Error('invalid user');
    const speedLimitMbps = Number(user.speed_limit || 0), deviceLimit = Number(user.device_limit || 0);
    if (!Number.isFinite(speedLimitMbps) || speedLimitMbps < 0 || !Number.isInteger(deviceLimit) || deviceLimit < 0) throw new Error('invalid user limit');
    map.set(user.uuid.toLowerCase(), { id: Number(user.id), uuid: user.uuid.toLowerCase(), speedLimitMbps, deviceLimit });
  }
  return map;
}
