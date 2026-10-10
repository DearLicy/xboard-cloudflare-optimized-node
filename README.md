# XBoard Cloudflare 优化节点 Worker

这是一个可从 GitHub 导入 Cloudflare Workers 的 VLESS + WebSocket 中继。**一个 Worker 可以绑定多个自定义域名**：每个域名对应一个地区和一个明确的 V2bX/XBoard 源站，用户只需按地区添加域名和映射条目，不必创建多个 Worker。

Worker 只连接 `ORIGIN_MAP`（或单源站变量）中明确允许的源站，不接受客户端提交的目标地址，因此不会成为开放代理。XBoard/V2bX 仍负责用户 UUID、订阅和流量统计；Worker 不保存用户 UUID，也不替代节点 daemon。

Cloudflare 域名是全球 Anycast **入口**。它不会把出口自动变成某个国家，出口地区取决于映射条目中的真实源站。要提供日本、香港、美国等固定出口，仍需在相应地区准备源站；一个 Worker 不能保证覆盖所有国家。

## 工作方式

```text
VLESS 客户端 (WS + TLS)
       │ 443
       ├── japan.example.com ──┐
       └── hongkong.example.com┤
                               ▼
                         一个 Worker
                         │       │
                         ▼       ▼
                      日本源站  香港源站
```

每个域名必须在 Worker 的 `ORIGIN_MAP` 中精确列出。未知域名和错误路径返回 404；缺少或格式错误的强制令牌会被当作配置错误拒绝。Worker 不会根据 URL 参数选择任意服务器。

## 从 GitHub 导入并独立部署

此 Worker 是独立项目，不绑定佛罗里达、日本、香港或任何其他现成服务器。部署只发布 Worker 代码；源站和 XBoard 由你自行管理。

1. Fork 或复制本仓库到自己的 GitHub 账号。
2. Cloudflare Dashboard → **Workers & Pages** → **Create application** → **Import an existing Git repository**，选择该仓库。
3. 构建设置：Framework preset 选 `None`，Build command 留空，Root directory 设为 `/`。
4. Deploy command 可填 `npm run deploy`。本地部署也可运行 `npm install` 后执行 `npm run deploy`，或直接执行 `npx wrangler deploy --keep-vars`。
5. 在 Worker 的 **Settings → Variables and Secrets** 配置运行时变量，然后部署。

仓库中的 [`wrangler.toml`](wrangler.toml) 已设置 `keep_vars = true`。这样从 GitHub 或 Wrangler 部署时不会清除 Dashboard 中配置的运行时变量；Cloudflare Secret 也不会因普通部署被删除。不要把源站地址、路径令牌、API Token、机器令牌、私钥或用户 UUID 提交到 GitHub。

Cloudflare Workers Builds 里的 **Build variables and secrets** 只提供给构建步骤，不能作为 Worker 运行时配置。请在 **Settings → Variables and Secrets** 添加运行时变量；`ORIGIN_MAP` 建议选择 **Secret**。也可以用 `npx wrangler secret put ORIGIN_MAP` 上传。

## 运行时变量

多地区部署使用 `ORIGIN_MAP`，设置后它优先于单源站变量。完整模板见 [`examples/origin-map.example.json`](examples/origin-map.example.json)。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ORIGIN_MAP` | 空 | JSON 对象；键是绑定到同一 Worker 的自定义域名，值是该地区的源站配置。建议设为 Secret。 |
| `ORIGIN_HOST` | 无 | 单源站兼容模式的源站域名、IPv4 或 IPv6；不要包含协议、端口或路径。 |
| `ORIGIN_PORT` | `39004` | 单源站模式的源站 WebSocket 端口。 |
| `ORIGIN_SCHEME` | `ws` | `ws` 或 `wss`。生产环境优先使用 `wss`，以加密 Worker 到源站的链路。 |
| `WS_PATH` | `/cf-vless` | 单源站模式的基础路径。多地区模式在每个条目的 `path` 中设置。 |
| `PATH_TOKEN` | 无 | 单源站模式的随机 16–128 字符令牌，允许字母、数字和 `._~-`。 |
| `REQUIRE_PATH_TOKEN` | `true` | 默认强制令牌。仅本地调试可设为 `false`；生产不要关闭。 |
| `HEALTH_PATH` | `/healthz` | GET 健康检查路径。健康检查不建立 WebSocket。 |
| `MAX_CONNECTIONS` | `64` | 单源站模式的保护性并发上限；`0` 表示不限制，不建议生产使用。多地区可在条目中覆盖。 |

`ORIGIN_MAP` 受 Cloudflare 变量/Secret 大小限制，Worker 会拒绝超过约 4.8 KiB 的内容，最多 32 个条目。将只使用的地区放入映射；达到限制时再按业务拆分 Worker。

### 多地区映射

```json
{
  "japan.example.com": {
    "host": "203.0.113.10",
    "port": 39004,
    "scheme": "wss",
    "path": "/cf-vless",
    "token": "REPLACE_WITH_A_RANDOM_JAPAN_TOKEN",
    "max_connections": 64
  },
  "hongkong.example.com": {
    "host": "2001:db8::20",
    "port": 39004,
    "scheme": "wss",
    "path": "/cf-vless",
    "token": "REPLACE_WITH_A_RANDOM_HONGKONG_TOKEN",
    "max_connections": 64
  }
}
```

每个条目支持：

- `host`：真实地区源站的域名、IPv4 或 IPv6。IPv6 可填写 `2001:db8::20`，不要填写 URL。
- `port`：源站 WebSocket 端口。
- `scheme`：`ws` 或 `wss`；推荐 `wss`。
- `path`：基础 WebSocket 路径，不要把令牌重复写进此字段。
- `token`：该地区独立的随机令牌。
- `max_connections`：该域名在**每个 Worker isolate**中的保护性并发上限。
- `require_path_token`：可覆盖全局设置，生产环境保持默认 `true`。

实际客户端路径是 `path/token`。例如上面的日本条目应在 XBoard 填 `/cf-vless/REPLACE_WITH_A_RANDOM_JAPAN_TOKEN`。如果基础 `path` 是 `/`，令牌路径就是 `/<token>`；只有将 `require_path_token` 明确设为 `false` 且没有令牌时，根路径才是 `/`。路径不能带查询字符串。

连接数计数按域名/源站键维护，且只在当前 Worker isolate 有效；Cloudflare 不同边缘实例之间不会共享这个计数。因此它是防止单个实例被占满的保护措施，不是账号级、全球级配额。应同时在源站防火墙、XBoard 和 Cloudflare 侧设置合理限制。

## 绑定域名与健康检查

在同一个 Worker 的 **Settings → Domains & Routes → Add Custom Domain** 中逐个添加 `japan.example.com`、`hongkong.example.com` 等域名。Cloudflare 会处理证书和 Worker 路由，不要把这些域名手动指向源站 A/AAAA 记录。

多地区模式下，默认的 `*.workers.dev` 地址没有映射条目，所以访问它（包括 `/healthz`）会返回 404。这是预期行为，也可以避免把未配置入口暴露给扫描器。健康检查请使用已经加入 `ORIGIN_MAP` 的自定义域名：

```sh
curl -i https://japan.example.com/healthz
```

预期返回：

```json
{"ok":true,"service":"xboard-cloudflare-node"}
```

如果你确实需要从 `workers.dev` 检查，必须把该完整主机名作为一个键加入 `ORIGIN_MAP`，并为它配置单独的源站条目；不要假设 `workers.dev` 会自动匹配第一个地区。单源站模式（不设置 `ORIGIN_MAP`）则可直接用 `workers.dev` 地址检查。

## 在 XBoard/V2bX 接入每个地区

先在每个地区运行 V2bX/XBoard 的 VLESS + WebSocket 入站，端口和基础路径与对应映射条目一致。推荐：

- Protocol：`VLESS`
- Network：`WebSocket`
- TLS：源站使用 `wss` 时开启源站 TLS；使用 `ws` 时 Worker 到源站是明文，客户端到 Cloudflare 仍可使用 HTTPS/WSS。
- Path：源站必须接受 `path/token` 的完整路径。
- Listen port：映射条目的 `port`。

然后在 XBoard 为每个域名单独新建节点：

- 名称：例如 `Cloudflare优化节点-日本`、`Cloudflare优化节点-香港`。
- Host：该地区的 Worker 自定义域名。
- Port：`443`。
- Protocol/Network：`VLESS` / `WebSocket`。
- TLS：开启，SNI 使用该自定义域名。
- Path：该条目的 `path/token` 完整值。
- Machine：选择实际运行该地区节点 daemon 的 XBoard machine。请填写有效的 `machine_id`，不要留空；没有 daemon 时面板可能无法取得 users 数据。
- 流量倍率：按你的计费策略填写；示例使用 `1`，需要双倍计费时可改为 `2`。

[`examples/xboard-node.example.json`](examples/xboard-node.example.json) 是不含真实地址、令牌和用户 UUID 的字段示例。`machine_id` 使用占位符，部署时替换为实际 machine；Worker 不内置机器凭据或用户 UUID。XBoard 继续为用户生成 UUID，并负责订阅、在线状态和流量统计。

## 正常的安全和平台边界

- 使用每个地区独立的随机路径令牌，定期轮换并在 XBoard 与 Worker 同时更新。
- 只在 `ORIGIN_MAP` 中列出需要的域名和源站，未知 Host/Path 返回匿名 404；错误响应不打印令牌、UUID 或源站地址。
- 源站只开放所需 WebSocket 端口，并使用防火墙限制来源。生产优先使用 `wss`。
- Worker 使用标准 WebSocket、精确 Host 映射和平台 API，不伪造 Host/SNI、不做域名前置、不承诺绕过 Cloudflare 的限制或封禁。请遵守 Cloudflare、源站提供商和当地法律的服务条款。
- 当前 Worker 转发 WebSocket/TCP，不提供任意 UDP 隧道。长连接、CPU、带宽、消息大小和并发仍受 Cloudflare Workers 方案限制；高并发或 UDP 请使用适合的专用产品。

## 本地检查

```sh
cp .dev.vars.example .dev.vars
npm install
npm run check
npx wrangler dev
```

本地开发可在 `.dev.vars` 设置 `REQUIRE_PATH_TOKEN=false`，生产环境必须恢复为 `true` 并使用随机令牌。`wrangler dev` 只能验证路由和健康检查；完整链路需要可用的 VLESS + WebSocket 源站。

## 文件

- `src/index.js`：Worker 入口和双向 WebSocket 中继。
- `wrangler.toml`：不含源站凭据的部署配置，已启用 `keep_vars`。
- `.dev.vars.example`：本地变量模板。
- `examples/origin-map.example.json`：多地区域名到源站映射模板。
- `examples/xboard-node.example.json`：XBoard 节点字段示例。
- `test/worker.test.mjs`：不连接生产源站的检查。
