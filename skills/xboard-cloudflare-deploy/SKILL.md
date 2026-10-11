---
name: xboard-cloudflare-deploy
description: Deploy, configure, and verify this repository as an independent Cloudflare Worker with XBoard VLESS WebSocket TCP nodes. Use when a user wants an AI to guide or perform the deployment, create machine-less XBoard nodes, bind domains, or troubleshoot a failed rollout.
metadata:
  short-description: Deploy the XBoard Cloudflare Worker for beginners
---

# XBoard Cloudflare Worker deployment

Use this skill for this repository only. It turns the repository into an independent Cloudflare Worker and, when the user authorizes it and access is available, connects one or more real XBoard VLESS nodes to that Worker. It never installs a daemon on an existing server and never changes existing server nodes unless the user explicitly asks for that separate work.

The normal beginner path is one machine-less XBoard node first, one custom domain, and one Worker. Add more domains only after that path passes verification. In stateless mode, every hostname uses Cloudflare's visitor ingress routing. Region names are display labels only; neither a label nor `location_hint` selects a region or fixes the exit IP. Recommend a global name or a custom line label.

The production Worker name is `xboard-cloudflare-node`. When this repository is
imported from GitHub, the default deployment updates that Worker and preserves its
configured custom domains and runtime secrets.

Recommend **Codex** as the first client for this skill: it can inspect the repository and, when the user has connected them, use the GitHub and Cloudflare integrations. Other AI clients may still use the instructions as a guided manual deployment, but they must not claim that an external deployment succeeded without a tool result.

## Before making changes

1. At the start of deployment, check that both the **GitHub integration/plugin** and the **Cloudflare integration/plugin or MCP** are connected to the intended accounts and expose the operations needed for this task. Verify identity, account, repository, zone, Worker, and permission scope before any external write. If either integration is unavailable or identity cannot be verified, stop before uploading code, changing DNS, setting secrets, or creating XBoard resources; explain that the user must connect the missing integration or use the manual dashboard path.
2. Inspect the repository revision, `README.md`, `wrangler.jsonc`, `package.json`, `src/config.js`, and the relevant tests. Run `npm install` or `npm ci` only when needed, then run `npm run check`.
3. Ask for the smallest missing set of facts:
   - Cloudflare account and the zone that owns the planned custom domain;
   - the GitHub repository/ref to deploy, if this is not the current checkout;
   - XBoard panel URL and whether the user has permission to create/edit nodes and read its global `server_token`;
   - one or more new hostnames and the desired display names;
   - whether the user wants the default no-storage mode; this repository's deployment path is stateless and machine-less unless dedicated machine mode is explicitly requested.
4. Treat credentials as secrets. Do not ask the user to paste a `server_token`, API token, private key, user UUID, or path token into a public issue, commit, README, or final report. Prefer the connected Cloudflare/GitHub/XBoard tools, a secure secret prompt, or local environment variables. Do not print secret values back to the user.
5. Present a short plan listing every resource that will be created or changed and wait for explicit authorization immediately before an external mutation. If the user has only supplied read access, stop at a dry-run and give manual next steps.
6. Check that the proposed hostnames do not replace existing server-node hostnames. Keep the Worker independent: no server IP, SSH access, or VPS installation is required.

## Configuration invariants

- The Worker uses VLESS over WebSocket over TLS and `cloudflare:sockets` for TCP egress.
- It supports TCP streams only. Do not advertise UDP, QUIC, Reality, XTLS Vision, native TCP inbound, or a general UDP VPN.
- In the recommended global machine-less mode, leave `MACHINE_ID` empty and use the XBoard global `server_token` as the `PANEL_TOKEN` Secret. In dedicated mode, use only the explicitly selected dedicated machine ID/token.
- `REGION_MAP` must map each exact lowercase custom hostname to a unique, real XBoard node ID. Never invent, reuse, or expose a fake node ID. XBoard assigns the ID.
- The XBoard node path is the configured base path plus `/<PATH_TOKEN>`. `REGION_MAP.path` and `WS_PATH` contain the base path only.
- Required runtime values are `PANEL_URL`, `PANEL_TOKEN`, `REGION_MAP`, and `PATH_TOKEN`. `ADMIN_TOKEN` is strongly recommended for status. Keep them as runtime Variables/Secrets, not Workers Builds variables.
- The default path uses `wrangler.jsonc` and `src/index.js`; it has no Durable Object, SQLite, alarm, or persistent reconciliation state. Explain that accounting is best-effort before deployment.
- `wrangler.durable.jsonc`, `src/durable-index.js`, and `src/ledger.js` are historical archives only. Do not deploy them; the production Worker is the stateless `xboard-cloudflare-node`.
- `location_hint` may be omitted or retain one of the accepted legacy values `wnam`, `enam`, `weur`, `eeur`, `apac`, `apac-ne`, `apac-se`, or `oc`. It is compatibility metadata only in stateless mode and does not control execution location. Do not advertise region selection or a country/continent exit.

## Deployment procedure

### 1. Build a dry-run plan

Start with one hostname. For each planned entry, record the hostname, human display name, real XBoard node ID (once assigned), base WebSocket path, optional compatibility metadata, and whether it is a new machine-less node. Reject a plan that uses an existing server node or has duplicate IDs/hosts.

If the user wants nodes created automatically and an authorized XBoard shell/API is available, use `scripts/xboard-worker-plan.php` and its plan format. Run its preview first, save the output privately, and only then use `--apply`. If that access is unavailable, give the user the exact XBoard fields to enter instead of claiming that nodes were created.

For each new XBoard node, use VLESS, port 443, TLS, WebSocket (`ws`), the Worker hostname as address/SNI/Host, the base path plus the path token, empty Flow, Machine empty in global mode, the intended access group, and the intended traffic multiplier. Ask the user to confirm the real IDs after XBoard saves them.

### 2. Validate and deploy the Worker

Run the repository checks before deployment. Use either the Cloudflare dashboard's GitHub import or local Wrangler:

```sh
npm install
npm run check
npx wrangler login             # only when no approved Wrangler/API auth exists
npm run deploy
```

For dashboard import, use the repository root, leave Build command empty, and use `npm run deploy` as the deploy command. Configure runtime Variables and Secrets in the Worker settings, then redeploy. Do not put runtime secrets in GitHub Actions, Workers Builds variables, `.dev.vars` committed to the repository, or chat messages.

When using a Cloudflare API connector, request only the scopes needed for the selected account/zone/Worker and custom-domain routes. Confirm the target account and zone before upload. Preserve existing variables when the configuration allows it; do not rotate or delete unrelated secrets.

If the target is an existing Durable Objects deployment, follow the repository's
[migration procedure](../../README.md#migrate-existing-durable-worker) before
uploading the stateless code. Verify the actual published tag and class, settle
and back up all pending accounting, preserve Variables/Secrets/domains, and use the
deletion migration only for the confirmed old `RegionalNode` deployment. The API
expects a `migrations` object; Wrangler uses a migration array with the published
history retained in a temporary migration configuration. Never run a deletion
migration on a new or already-stateless Worker. After a successful transition,
verify settings and namespace removal, then remove the old Cron Triggers.

For the default no-storage variant, run the checks and deploy with:

```sh
npm run deploy
```

Before deploying the default variant, explain that authorization is fetched per new
connection and traffic is reported once when the connection closes. A failed or
ambiguous report is counted as a failure and is not retried, because XBoard's
report endpoint has no idempotency key. Do not present the stateless status page
as a global connection or quota counter.

Do not deploy the archived Durable Objects configuration. If a user asks for a
precise persistent ledger, explain that it is outside this repository's supported
stateless path and recommend an independent server node or another storage-backed
deployment.

Add each hostname as a custom domain on the same Worker. Let Cloudflare manage DNS and certificates. Do not point the hostname at a VPS or replace DNS for an existing server node.

### 3. Configure the first route

Use a single-line JSON value like this, replacing the ID and hostname with the values from the user's XBoard panel:

```json
{"cf-global.example.com":{"node_id":123,"path":"/cf-vless"}}
```

Generate independent random values for `PATH_TOKEN` and `ADMIN_TOKEN` (at least 32 random hexadecimal characters is suitable). `PANEL_TOKEN` is the XBoard token and must not be reused as either value. Never include any of the three values in the final report.

After the first route works, extend `REGION_MAP` one entry at a time. The repository accepts at most 32 routes and validates hostnames, paths, IDs, compatibility metadata, and size. Keep the user's display names in XBoard; do not rename existing independent server nodes as part of this skill. Explain that additional logical nodes can have separate permission groups and traffic multipliers, but they do not create regional exits.

## Verification

Run checks in this order and record the actual result:

1. `GET https://<host>/healthz` returns JSON with `ok: true`. This tests route/config availability only.
2. Check the Worker `admin/status` endpoint with `Authorization: Bearer <ADMIN_TOKEN>` when configured. Confirm the expected `node_id`, `mode: stateless`, and isolate-local counters. Do not log the header.
3. Refresh an XBoard subscription for a test account that is entitled to the node. Confirm the generated VLESS server, SNI, TLS, WebSocket path, and port 443 match the Worker.
4. Perform a real TCP HTTPS request through a client. For latency tests use `https://www.gstatic.com/generate_204` or another reachable target, not `https://cp.cloudflare.com/generate_204`; Cloudflare Workers cannot connect to Cloudflare's own service IPs.
5. Confirm XBoard online and traffic counters after a short transfer. Report propagation delays honestly.
6. Test each additional route only after the first route passes.

A successful `healthz` response is not proof that a VLESS user is authorized or that accounting works. A client marked `udp: true` may still only use the TCP transport implemented here; explain this instead of promising UDP compatibility.

## Troubleshooting and stopping rules

- `404` on `healthz` or the WebSocket path: check that the exact lowercase hostname is in `REGION_MAP`, the custom domain is attached to this Worker, and the base path/token match. Do not change XBoard node IDs to guess.
- `426`: the request was not a WebSocket upgrade.
- `403` on admin endpoints: the bearer token is missing or incorrect; set it through a secret input.
- `503`: inspect Worker logs and `admin/status` for invalid runtime config, failed XBoard user sync, or connection/handshake caps. Stateless mode has no persistent report queue to reconcile.
- Client `Timeout` while `gstatic` works: change the client's default latency URL away from `cp.cloudflare.com/generate_204`. The CF self-target restriction is expected.
- Subscription works for HTTP but a UDP/QUIC app fails: this is an unsupported transport, not evidence that the TCP route is broken.
- If XBoard rejects the panel token, stop and ask the user to verify whether it is the global `server_token` (global mode) or the selected machine token (dedicated mode). Never request or expose an administrator password as a substitute.
- Stop before deployment if the target account, zone, Worker, XBoard panel, or node scope is ambiguous; if an API reports a partial mutation, preserve the response and reconcile before retrying.

## Final report

State exactly what was verified and what remains manual. Include Worker name, hostnames, XBoard node IDs only when the user considers them non-sensitive, test URLs, and timestamps. Never include `PANEL_TOKEN`, `PATH_TOKEN`, `ADMIN_TOKEN`, private keys, user UUIDs, raw Authorization headers, or full subscription URLs. If a connector was unavailable, say that deployment was not verified and provide the smallest manual action needed.
