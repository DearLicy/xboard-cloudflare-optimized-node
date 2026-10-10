import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import { readConfig, routeObjectName, secretEqual } from './config.js';
import { panelRequest, userMap } from './panel.js';
import { Ledger } from './ledger.js';
import { createVlessSession, decodeEarlyData } from './protocol.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const empty = status => new Response(null, { status, headers: { 'cache-control': 'no-store' } });

export default {
  async fetch(request, env) {
    try {
      const config = readConfig(env), url = new URL(request.url), route = config.routes.get(url.hostname);
      if (!route) return empty(404);
      if (url.pathname === '/healthz' && request.method === 'GET') return json({ ok: true, transport: 'vless-ws-tcp', placement: 'best-effort' });
      const isAdmin = url.pathname === '/admin/status' || url.pathname === '/admin/reconcile';
      if (isAdmin && (!env.ADMIN_TOKEN || !await secretEqual(request.headers.get('authorization'), `Bearer ${env.ADMIN_TOKEN}`))) return empty(403);
      if (!isAdmin && (url.pathname !== route.path || url.search || request.method !== 'GET')) return empty(404);
      if (!isAdmin && request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return empty(426);
      const colo = isAdmin ? url.searchParams.get('colo') : null;
      if (colo && (route.locationHint || !/^[A-Z]{3}$/.test(colo))) return empty(400);
      const objectRequest = colo ? { cf: { colo } } : request;
      const id = env.NODES.idFromName(routeObjectName(route, objectRequest));
      return await env.NODES.get(id, route.locationHint ? { locationHint: route.locationHint } : undefined).fetch(request);
    } catch { return empty(503); }
  },
  async scheduled(event, env, ctx) {
    const config = readConfig(env);
    ctx.waitUntil(Promise.allSettled([...config.routes].filter(([, route]) => route.locationHint).map(([host, route]) => {
      const request = new Request(`https://${host}/internal/maintenance`);
      const id = env.NODES.idFromName(routeObjectName(route, request));
      return env.NODES.get(id, route.locationHint ? { locationHint: route.locationHint } : undefined).fetch(request);
    })));
  },
};

export class RegionalNode extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ledger = new Ledger(ctx.storage);
    this.sessions = new Set(); this.users = new Map(); this.usersAt = 0;
    this.rateClocks = new Map(); this.lastReport = 0; this.lastError = null;
    this.config = null; this.route = null; this.syncing = null; this.reporting = null;
    this.ctx.blockConcurrencyWhile(async () => { this.host = await this.ctx.storage.get('host'); });
  }
  loadConfig(host = this.host) {
    this.config = readConfig(this.env); this.route = this.config.routes.get(host);
    if (!this.route) throw new Error('missing node configuration');
  }
  async schedule() {
    if (!await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + Math.min(this.config.userSyncSeconds, this.config.reportSeconds) * 1000);
  }
  async syncUsers(force = false) {
    if (this.syncing) return this.syncing;
    if (!force && Date.now() - this.usersAt < this.config.userSyncSeconds * 1000) return;
    this.syncing = (async () => {
      try {
        this.users = userMap(await panelRequest(this.config, this.route.nodeId, 'user'));
        this.usersAt = Date.now(); this.lastError = null;
        for (const session of this.sessions) if (session.user && !this.users.has(session.user.uuid)) session.bridge.shutdown(1008, 'Authorization revoked');
      } catch {
        this.lastError = 'user_sync_failed'; this.usersAt = 0; this.users.clear();
        for (const session of this.sessions) session.bridge.shutdown(1011, 'Authorization unavailable');
        throw new Error('user synchronization failed');
      }
    })();
    try { await this.syncing; } finally { this.syncing = null; }
  }
  async report(force = false) {
    if (this.reporting) return this.reporting;
    if (!force && Date.now() - this.lastReport < this.config.reportSeconds * 1000) return;
    if (this.ledger.uncertain().length) { this.lastError = 'report_requires_reconciliation'; return; }
    this.reporting = (async () => {
      const batch = this.ledger.stage(), alive = {}, online = {};
      for (const session of this.sessions) {
        if (!session.user) continue;
        (alive[session.user.id] ||= new Set()).add(session.ip);
        online[session.user.id] = (online[session.user.id] || 0) + 1;
      }
      const payload = { traffic: batch?.traffic || {}, alive: Object.fromEntries(Object.entries(alive).map(([uid, ips]) => [uid, [...ips]])), online };
      try {
        const result = await panelRequest(this.config, this.route.nodeId, 'report', payload);
        if (result.data !== true) throw new Error('invalid report acknowledgment');
        if (batch) this.ledger.accept(batch.id);
        this.lastReport = Date.now(); this.lastError = null;
      } catch {
        this.lastError = batch ? 'report_requires_reconciliation' : 'report_failed';
        for (const session of this.sessions) session.bridge.shutdown(1011, 'Accounting unavailable');
      }
    })();
    try { await this.reporting; } finally { this.reporting = null; }
  }
  async alarm() {
    try { this.loadConfig(); await this.syncUsers(true).catch(() => {}); await this.report(true); }
    catch { this.lastError = 'configuration_unavailable'; }
    // Expected panel errors must not trigger automatic alarm replay of reports.
    if (this.config) await this.ctx.storage.setAlarm(Date.now() + Math.min(this.config.userSyncSeconds, this.config.reportSeconds) * 1000);
  }
  async throttle({ bytes, direction, user }) {
    const current = this.users.get(user.uuid); if (!current) throw new Error('revoked user');
    const rate = current.speedLimitMbps; if (!rate) return;
    const key = `${user.id}:${direction}`, now = Date.now(), start = Math.max(now, this.rateClocks.get(key) || now);
    const end = start + bytes * 8000 / (rate * 1000000);
    if (end - now > 10000) throw new Error('bandwidth queue full');
    this.rateClocks.set(key, end);
    await new Promise(resolve => setTimeout(resolve, end - now));
  }
  async fetch(request) {
    try {
      const url = new URL(request.url); this.loadConfig(url.hostname);
      if (this.host && this.host !== url.hostname) return empty(409);
      if (!this.host) { await this.ctx.storage.put('host', url.hostname); this.host = url.hostname; }
      await this.schedule();
      if (url.pathname === '/internal/maintenance') { await this.syncUsers().catch(() => {}); await this.report(); return empty(204); }
      if (url.pathname.startsWith('/admin/')) {
        if (!this.env.ADMIN_TOKEN || !await secretEqual(request.headers.get('authorization'), `Bearer ${this.env.ADMIN_TOKEN}`)) return empty(403);
        if (url.pathname === '/admin/reconcile' && request.method === 'POST') {
          if (this.reporting) return empty(409);
          if (Number(request.headers.get('content-length') || 0) > 4096) return empty(413);
          const raw = await request.text(); if (raw.length > 4096) return empty(413);
          const { batch_id, outcome } = JSON.parse(raw); this.ledger.reconcile(batch_id, outcome); await this.report(true);
        } else if (url.pathname !== '/admin/status' || request.method !== 'GET') return empty(405);
        return json({ node_id: this.route.nodeId, hint: this.route.locationHint || 'local', sessions: this.sessions.size, authorized_users: this.users.size, users_synced_at: this.usersAt, reported_at: this.lastReport, pending_bytes: this.ledger.pendingBytes(), uncertain_batches: this.ledger.uncertain().map(({id,created}) => ({id,created})), error: this.lastError });
      }
      if (url.pathname !== this.route.path || url.search || request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return empty(404);
      await this.syncUsers();
      if ((this.ledger.uncertain().length && !this.reporting) || this.ledger.pendingBytes() >= this.config.maxPendingBytes || this.sessions.size >= this.config.maxConnections) return empty(503);
      let earlyData;
      try { earlyData = decodeEarlyData(request.headers.get('sec-websocket-protocol') || ''); } catch { return empty(400); }
      const pair = new WebSocketPair(), client = pair[0], server = pair[1]; server.accept();
      const session = { ip: request.headers.get('CF-Connecting-IP') || 'unknown', user: null, bridge: null };
      this.sessions.add(session);
      try {
        session.bridge = createVlessSession(server, {
          connect, earlyData,
          authorize: async header => {
            if (Date.now() - this.usersAt >= this.config.userSyncSeconds * 1000) await this.syncUsers();
            const user = this.users.get(header.uuid);
            if (!user || this.config.routes.has(header.hostname.toLowerCase()) || new URL(this.config.panelUrl).hostname === header.hostname.toLowerCase()) return false;
            if (this.config.allowedPorts.size && !this.config.allowedPorts.has(header.port)) return false;
            const own = [...this.sessions].filter(s => s.user?.id === user.id);
            if (own.length >= this.config.maxUserConnections) return false;
            const devices = new Set(own.map(s => s.ip));
            if (user.deviceLimit && !devices.has(session.ip) && devices.size >= user.deviceLimit) return false;
            session.user = user; return user;
          },
          beforeTransfer: data => this.throttle(data),
          onTraffic: ({upload,download,user}) => {
            if (!this.users.has(user.uuid) || (this.ledger.uncertain().length && !this.reporting) || this.ledger.pendingBytes() + upload + download > this.config.maxPendingBytes) return false;
            this.ledger.add(user.id, upload, download); return true;
          },
          onClose: () => {
            this.sessions.delete(session);
            if (session.user && ![...this.sessions].some(s => s.user?.id === session.user.id)) {
              this.rateClocks.delete(`${session.user.id}:upload`); this.rateClocks.delete(`${session.user.id}:download`);
            }
          },
        });
      } catch (error) {
        this.sessions.delete(session);
        throw error;
      }
      this.ctx.waitUntil(session.bridge.done);
      try { return new Response(null, { status: 101, webSocket: client }); }
      catch (error) { session.bridge.shutdown(1011, 'Upgrade failed'); throw error; }
    } catch { return empty(503); }
  }
}
