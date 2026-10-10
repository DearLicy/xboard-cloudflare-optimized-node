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

本仓库不绑定任何现成服务器，也不会自动修改 XBoard。每次部署都由你自己填写源站地址、路径令牌和连接上限；因此同一个仓库可以分别部署给不同的 v2bx/XBoard 节点。每个 Worker 都是独立部署实例，部署一个地区不会创建或修改佛罗里达、日本、香港等其他服务器上的服务。

## 必填变量

| 变量 | 示例 | 说明 |
| --- | --- | --- |
| `ORIGIN_HOST` | `203.0.113.10` 或源站域名 | 固定的 VLESS+WS 源站地址，只填写主机名或 IP，不带协议和路径 |
| `ORIGIN_PORT` | `39004` | 源站纯 HTTP WebSocket 端口 |
| `ORIGIN_SCHEME` | `ws` | 源站协议，支持 `ws` 或 `wss`；Cloudflare 客户端入口仍然使用 HTTPS/WSS |
| `PATH_TOKEN` | 随机 32 字符 | 生产环境必填，允许 16–128 个字母、数字及 `._~-` 字符；它会成为实际 WebSocket 路径的一部分 |

可选变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WS_PATH` | `/cf-vless` | 客户端和源站必须一致的 WebSocket 路径 |
| `REQUIRE_PATH_TOKEN` | `true` | 默认强制要求 `PATH_TOKEN`；仅本地调试时可设为 `false` |
| `HEALTH_PATH` | `/healthz` | 健康检查路径 |
| `MAX_CONNECTIONS` | `64` | 单个 Worker 隔离实例的并发连接上限；设为 `0` 表示不限制。它是保护性上限，不是全局精确配额 |

不要把 Cloudflare API Token、XBoard 机器令牌、用户 UUID 或私钥写入 GitHub 仓库。建议使用长度至少 32 位的随机 `PATH_TOKEN`，并在 Cloudflare Dashboard 的变量中配置；路径令牌会成为 XBoard 节点的 Path。缺少令牌或令牌格式错误时 Worker 会返回配置错误，不会暴露未保护的默认路径。错误路径会直接返回 404，Worker 也不会读取用户提交的目标地址。

## 多地区和多节点部署

要增加一个地区，部署一个新的 Worker 实例，并把它指向该地区已经运行的 V2bX/XBoard VLESS+WebSocket 入站：

1. 从本仓库创建一个独立的 GitHub 仓库，或在 Cloudflare Git 集成中重复导入本仓库。
2. 修改 `wrangler.toml` 的 `name`，确保同一 Cloudflare 账号中的每个 Worker 名称唯一，例如 `xboard-cf-japan`、`xboard-cf-hongkong`、`xboard-cf-florida`。
3. 在每个 Worker 自己的 Variables and Secrets 中填写该地区的 `ORIGIN_HOST`、`ORIGIN_PORT`、`PATH_TOKEN` 和连接上限。
4. 为每个 Worker 绑定独立的自定义域名，并在 XBoard 中创建对应的节点，例如 `cf-japan.example.com`、`cf-hongkong.example.com`。

这样每个 XBoard 节点仍然有明确的源站地区和独立的流量统计。Cloudflare 自定义域名提供全球 Anycast 的 IPv4/IPv6 接入，用户通常会连接到较近的 Cloudflare 边缘；但 Cloudflare 边缘是入口，不是 VPN 出口，Worker 的出口位置仍由 `ORIGIN_HOST` 所在服务器决定。要让用户获得日本、香港、美国等固定出口，必须在这些地区分别运行源站节点。单个 Worker 不能保证覆盖全球所有国家，也不应通过客户端提交任意目标地址来伪造多地区出口。

## 绑定自定义域名

`wrangler.toml` 默认保留 `workers.dev` 入口，便于首次部署后验证。生产使用时，在 Worker 的 **Settings → Domains & Routes → Add Custom Domain** 中绑定，例如 `cf-japan.example.com`。Cloudflare 会自动处理证书和 DNS。不要把 Worker 域名再套一层普通 DNS 代理，也不要在 Worker 中接受用户提交的目标地址。

部署后可访问 `https://cloudflare.example.com/healthz`，预期返回：

```json
{"ok":true,"service":"xboard-cloudflare-node"}
```

## 源站和 XBoard 配置

源站必须先监听一个纯 WebSocket 的 VLESS 入站。以 `xboard-node` 为例：

- Protocol：`VLESS`
- Network：`WebSocket`
- TLS：由 Cloudflare 在客户端侧终止，源站监听纯 HTTP
- Path：`/cf-vless`，如果设置了 `PATH_TOKEN`，则填写 `/cf-vless/<PATH_TOKEN>` 的完整值
- Listen port：`39004`（或你自己的 `ORIGIN_PORT`）

然后在 XBoard 新建一个与该入站对应的节点：

- 节点名称：`Cloudflare优化节点`
- Host：你的 Worker 自定义域名
- Port：`443`
- Protocol：`VLESS`
- Network：`WebSocket`
- TLS：开启
- Path：填写 Worker 的实际路径；未设置 `PATH_TOKEN` 时为 `WS_PATH`，设置后为 `WS_PATH/PATH_TOKEN`
- Machine：选择实际监听 `ORIGIN_PORT` 的机器
- 流量倍率：按你的计费策略设置，通常为 `1`

`examples/xboard-node.example.json` 提供了一份不含真实地址和密钥的协议字段示例，字段结构接近 v2bx/XBoard 的 VLESS 节点配置。

XBoard 仍然为每个用户生成独立 UUID，Worker 只转发连接，不保存用户凭据，也不参与面板的在线状态和流量统计。流量统计由源站上的 XBoard 节点完成。

## 源站防护和限制

- 仅允许源站端口接收 VLESS+WS，并在源站防火墙中关闭不需要的端口。
- 使用随机的 WebSocket 路径，并在 XBoard 与 Worker 中保持一致。
- Cloudflare Worker 适合长连接中继，但受 Workers 的连接、CPU、带宽、单条消息大小和平台策略限制；当前 WebSocket 单条消息不能按任意大流量隧道理解。高并发或完整 UDP 业务应使用专用 TCP/UDP 转发产品或原生节点。
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
