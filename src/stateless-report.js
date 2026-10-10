/**
 * Build the report sent when one stateless session closes.
 *
 * `activeSessions` only covers the current Worker isolate. The payload is
 * therefore useful to XBoard for traffic and a best-effort online hint, but
 * it is not a global connection snapshot and is never retried after an
 * ambiguous response.
 */
export function statelessReportPayload(result, activeSessions = []) {
  if (!result?.user || (!result.upload && !result.download)) return null;
  const uid = String(result.user.id);
  const peers = activeSessions.filter(session => session.user?.id === result.user.id);
  const alive = [...new Set(peers.map(session => session.ip).filter(Boolean))];
  return {
    traffic: { [uid]: [result.upload, result.download] },
    alive: alive.length ? { [uid]: alive } : {},
    online: { [uid]: peers.length },
  };
}
