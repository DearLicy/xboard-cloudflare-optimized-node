# XBoard Cloudflare 优化节点 Worker

这是一个可以直接从 GitHub 导入 Cloudflare Workers 的固定源站 WebSocket 中继。它给 XBoard 的 VLESS+WebSocket 节点提供 Cloudflare Anycast 入口，客户端连接到 Cloudflare 分配的边缘地址，Worker 再把 WebSocket 字节流转发到你配置的固定源站。

Worker 只接受一个固定的 `ORIGIN_HOST:ORIGIN_PORT`，没有任意目标地址参数，因此不会变成开放代理。用户认证仍然由源站上的 XBoard 节点完成，每个用户继续使用自己的 UUID。

## 工作方式

```text
XBoard 客户端 (VLESS + WS + TLS)
              │ 443
              ▼
Cloudflare Custom Domain / Anycast
              │ Worker WebSocket relay
              ▼
固定源站 VLESS + WS（纯 HTTP，例：39004）
```

Cloudflare 自定义域名默认提供 IPv4 和 IPv6 入口。入口是 Cloudflare Anycast，不能把它当作固定的美国、日本或香港出口；最终出口位置由你配置的源站决定。

## 从 GitHub 导入部署

1. Fork 或复制本仓库到自己的 GitHub 账号。
2. 打开 Cloudflare Dashboard → **Workers & Pages** → **Create application** → **Import an existing Git repository**。
3. 授权 GitHub 后选择本仓库。
4. 构建设置使用：
   - Framework preset：`None`
   - Build command：留空
   - Deploy command：`npx wrangler deploy`
   - Root directory：`/`
5. 在 Worker 的 **Settings → Variables and Secrets** 中配置下表变量，然后部署。

如果使用 Cloudflare 的 Git 集成，后续推送到仓库即可触发新的部署。也可以在本地安装 Wrangler 后运行 `npm install` 和 `npm run deploy`。

## 必填变量

| 变量 | 示例 | 说明 |
| --- | --- | --- |
| `ORIGIN_HOST` | `203.0.113.10` 或源站域名 | 固定的 VLESS+WS 源站地址，只填写主机名或 IP，不带协议和路径 |
| `ORIGIN_PORT` | `39004` | 源站纯 HTTP WebSocket 端口 |

可选变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WS_PATH` | `/cf-vless` | 客户端和源站必须一致的 WebSocket 路径 |
| `HEALTH_PATH` | `/healthz` | 健康检查路径 |

不要把 Cloudflare API Token、XBoard 机器令牌、用户 UUID 或私钥写入 GitHub 仓库。源站变量不需要使用 Secret，但建议在 Cloudflare Dashboard 中配置，而不是写进 `wrangler.toml`。

## 绑定自定义域名

部署成功后，在 Worker 的 **Settings → Domains & Routes → Add Custom Domain** 中绑定，例如 `cloudflare.example.com`。Cloudflare 会自动处理证书和 DNS。不要把 Worker 域名再套一层普通 DNS 代理，也不要在 Worker 中接受用户提交的目标地址。

部署后可访问 `https://cloudflare.example.com/healthz`，预期返回：

```json
{"ok":true,"service":"xboard-cloudflare-node"}
```

## 源站和 XBoard 配置

源站必须先监听一个纯 WebSocket 的 VLESS 入站。以 `xboard-node` 为例：

- Protocol：`VLESS`
- Network：`WebSocket`
- TLS：由 Cloudflare 在客户端侧终止，源站监听纯 HTTP
- Path：`/cf-vless`
- Listen port：`39004`（或你自己的 `ORIGIN_PORT`）

然后在 XBoard 新建一个与该入站对应的节点：

- 节点名称：`Cloudflare优化节点`
- Host：你的 Worker 自定义域名
- Port：`443`
- Protocol：`VLESS`
- Network：`WebSocket`
- TLS：开启
- Path：与 `WS_PATH` 相同
- Machine：选择实际监听 `ORIGIN_PORT` 的机器
- 流量倍率：按你的计费策略设置，通常为 `1`

XBoard 仍然为每个用户生成独立 UUID，Worker 只转发连接，不保存用户凭据，也不参与面板的在线状态和流量统计。流量统计由源站上的 XBoard 节点完成。

## 源站防护和限制

- 仅允许源站端口接收 VLESS+WS，并在源站防火墙中关闭不需要的端口。
- 使用随机的 WebSocket 路径，并在 XBoard 与 Worker 中保持一致。
- Cloudflare Worker 适合长连接中继，但受 Workers 的连接、CPU、带宽和平台策略限制。高并发或完整 UDP 业务应使用专用 TCP/UDP 转发产品或原生节点。
- 当前 Worker 只转发 WebSocket/TCP 流量，不提供任意 UDP 隧道。

## 本地检查

```sh
cp .dev.vars.example .dev.vars
npm install
npm run check
npx wrangler dev
```

本地 `wrangler dev` 只验证 Worker 路由和健康检查；要验证完整链路，必须让 `ORIGIN_HOST:ORIGIN_PORT` 上有可用的 WebSocket VLESS 入站。

## 文件说明

- `src/index.js`：Worker 入口和双向 WebSocket 中继。
- `wrangler.toml`：Cloudflare Workers 项目配置，不包含源站凭据。
- `.dev.vars.example`：本地变量模板。
- `test/worker.test.mjs`：不连接生产源站的源代码检查。
