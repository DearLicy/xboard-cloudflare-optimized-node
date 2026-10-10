# XBoard Cloudflare 优选节点

一个可从 GitHub 导入部署的 Cloudflare Worker，使用 **VLESS + WebSocket + TLS** 提供独立的 TCP 代理节点。默认入口不创建 Durable Objects 或 SQLite 存储，每条新连接直接向 XBoard 校验用户 UUID，并通过 `cloudflare:sockets` 连接目标网站。Worker 独立运行，无需在其他服务器安装 V2bX，也无需配置代理源站。

同一个 Worker 可以绑定多个域名，每个域名对应 XBoard 中一个新增节点。推荐使用大区名称，例如 `东北亚｜Cloudflare优选`、`西欧｜Cloudflare优选`。Cloudflare 提供的是尽力而为的 **大区位置提示**，不能保证某个国家的出口 IP；域名和显示名称也不会把出口变成指定国家。

```text
VLESS 客户端 ── WSS / 443 ── 一个 Cloudflare Worker
                              ├─ cf-global.example.com → 各入口附近的 Cloudflare colo
                              ├─ cf-asia-ne.example.com → 东北亚提示的入口
                              ├─ cf-europe.example.com → 西欧提示的入口
                              └─ ……                    → TCP 目标网站
                                      │
                                      └─ XBoard：用户授权、在线记录、流量上报
```

已有独立服务器节点可以继续使用。本项目只在 XBoard 中创建单独的新节点，不要求迁移已有节点；默认节点不绑定 machine。

## 默认无持久化部署

本仓库默认部署的是无 Durable Objects 的 Stateless Worker，配置文件是
`wrangler.jsonc`，入口是 `src/index.js`。它不会创建 SQLite、migration、alarm
或其他持久化绑定，适合账号已经达到 Durable Objects 存储/空间限制的情况：

```sh
npm install
npm run check
npm run deploy
```

Cloudflare Dashboard 从 GitHub 导入时，项目根目录和运行时 Variables/Secrets
的填写方式与下文相同，Deploy command 填 `npm run deploy`。每次新连接直接向
XBoard 查询授权用户，连接关闭时把本连接的上传/下载字节通过
`/api/v2/server/report` 尽力上报一次。`/healthz` 和带 `ADMIN_TOKEN` 的
`/admin/status` 可检查当前 Worker isolate 的临时状态。

无持久化模式不能提供跨 Worker isolate 的全局连接数、设备数、速度队列或即时撤销；
运行时重启、连接异常或 XBoard 报告请求失败时，未上报的字节不会进入重试队列。
XBoard 的 report API 没有批次幂等键，因此 Worker 不会盲目重试可能已经被面板接受
的请求，避免重复扣费。它适合测试和能接受尽力计费的场景；若需要精确计费和人工
reconcile，请使用下方保留的 Durable Objects legacy 配置。

`location_hint` 在无持久化模式中仅作为节点说明，实际执行位置由普通 Worker 的入口
colo 决定，不能承诺大区出口。已有独立服务器节点可以继续使用；本项目只在 XBoard
中创建单独的新节点，不要求迁移已有节点，默认节点不绑定 machine。

## Durable Objects legacy 模式

仓库仍保留原来的精确统计实现，源文件为 `src/durable-index.js`，配置为
`wrangler.durable.jsonc`。它会使用已有的 `xboard-cloudflare-node` Worker、
Durable Object SQLite namespace、定时任务和持久流量账本。只有在确认账号允许这些
资源、并且需要失败重试与人工 reconcile 时才使用：

```sh
npm run deploy:durable
```

不要用 legacy 配置覆盖或删除已经发布的 migration/namespace；删除会丢失待核对账本。
无持久化默认 Worker 与 legacy Worker 使用不同的名称，便于先绑定新域名和新 XBoard
节点进行测试。

切换仓库默认入口不会自动删除旧 namespace；旧 namespace 中已有的 SQLite 数据仍可能
显示在 Durable Objects 用量里。确认 legacy `/admin/status` 没有待核对批次、旧域名
已经迁移并且不再需要旧 Worker 后，再在 Cloudflare 控制台单独删除旧 Worker/namespace
以释放旧空间。删除前请先导出或核对账本，避免丢失未结算流量。

## 不会部署时：把仓库交给 AI

仓库附带一个可供 AI 使用的部署 Skill：[`skills/xboard-cloudflare-deploy/SKILL.md`](skills/xboard-cloudflare-deploy/SKILL.md)。它会按“小白先做一个节点、验证成功后再扩展”的顺序检查配置、部署 Worker、绑定域名、接入 XBoard 并验证订阅和流量上报。Skill 优先推荐在 **Codex** 中使用；它能在 GitHub 和 Cloudflare 插件/MCP 已连接时检查仓库并执行部署。

将本仓库链接和下面这段话一起发给 Codex（或其他支持读取仓库 Skill 的 AI）：

```text
请使用 $xboard-cloudflare-deploy（文件位于 skills/xboard-cloudflare-deploy/SKILL.md），按其中的流程帮我部署。
先检查 GitHub 和 Cloudflare 插件/MCP 是否已连接到正确账号，再检查仓库和配置。
先做 dry-run 并列出将要创建或修改的资源；任何外部写入前都要向我说明并等待授权。
我希望先部署一个 machine-less XBoard VLESS 节点，成功后再扩展其他大区。
请不要修改已有服务器节点，不要把任何密钥写入仓库或聊天记录。
```

AI 需要能够访问目标 Cloudflare 账号、GitHub 仓库以及（如需自动创建节点）XBoard。缺少任一插件/MCP 或权限时，Skill 会停止外部写入并给出手动操作步骤；这时不要把 `server_token`、API Token、私钥或用户 UUID 粘贴到公开聊天中。无插件的 AI 仍可按照 README 逐步指导，但不能声称已经完成部署。

## 小白快速部署（推荐先只做一个节点）

下面这条路径不需要 SSH 到任何服务器，也不需要在服务器上安装程序。准备好 **Cloudflare 账号（域名托管在该账号）**、**XBoard 管理员权限** 和一个可用于 Fork/导入仓库的 GitHub 账号后，按顺序完成即可。先做一个节点确认链路正常，再复制配置增加其他大区。

### A. 先准备一个域名和一个 XBoard 节点

1. 在 Cloudflare 中选一个没有被现有服务使用的子域名，例如 `cf-asia.example.com`。不要复用已有独立节点正在使用的域名。
2. 生成一个随机路径令牌。macOS/Linux 可在终端运行 `openssl rand -hex 32`；Windows 可用密码管理器生成至少 32 个字符的随机字符串。这个值稍后作为 `PATH_TOKEN` Secret，**不要发到群组或提交到 GitHub**。
3. 在 XBoard 新增一个 **VLESS** 节点，Machine 留空（`machine_id = null`），并填写：地址/Host 为上面的域名、端口 `443`、TLS 开启、Network 选 `ws`、SNI 和 WebSocket Host 都填该域名、WebSocket Path 填 `/cf-vless/<刚生成的路径令牌>`、Flow 留空。选择允许使用它的权限组，打开“启用”和“显示”，流量倍率按你的计费策略填写（例如 `1` 或 `2`）。无持久化模式会在每条新连接查询 XBoard，但不会跨连接保存设备/并发状态。
4. 保存节点并记下 XBoard 自动生成的 **节点 ID**。节点 ID 不是自定义 ID；通常可以在节点详情、编辑地址或 XBoard API 中看到。后面的 `REGION_MAP` 必须填写这个真实 ID。

如果暂时没有 XBoard 面板权限，不能跳过这一步：Worker 会向 XBoard 查询用户和上报流量，没有真实节点 ID 就不会放行用户。需要批量创建节点时，再使用下方的 `xboard-worker-plan.php` 脚本。

### B. 在 Cloudflare 从 GitHub 部署 Worker

1. 在 GitHub 打开本仓库，点击 **Fork**（或复制到自己的账号）。
2. 在 Cloudflare Dashboard 进入 **Workers & Pages → Create application → Import a repository**，授权 GitHub 后选择刚 Fork 的仓库。
3. 项目目录选择仓库根目录；生产分支选 `main`；**Build command 留空**；**Deploy command 填 `npm run deploy`**；保存并部署。不要把变量填在 GitHub/Workers Builds 的 Build variables 区域，那些变量只在构建时可见。
4. 首次部署完成后，进入该 Worker 的 **Settings → Variables and Secrets**。按“配置运行时变量”表逐项添加：普通值用 **Variable**，令牌用 **Secret**。变量名必须完全一致，保存后点击 **Deploy** 使新变量生效。
5. 在同一 Worker 的 **Settings → Domains & Routes → Add Custom Domain** 中加入 `cf-asia.example.com`。Cloudflare 会自动创建 DNS 和证书；不要把这个域名解析到某台服务器，也不要上传服务器证书。每增加一个 `REGION_MAP` 域名，都要在这里单独添加一次。

### C. 填入最小可用配置

先只配置一个域名，确认成功后再把示例文件中的其他域名逐个加入。`REGION_MAP` 在 Cloudflare 面板中应填成一行 JSON（不要带代码块标记），把 `123` 换成你刚记下的节点 ID，把域名换成你自己的域名：

```json
{"cf-asia.example.com":{"node_id":123,"location_hint":"apac","path":"/cf-vless"}}
```

对应变量如下：

| 名称 | 类型 | 示例 |
| --- | --- | --- |
| `PANEL_URL` | Variable | `https://xboard.example.com`（只填面板根地址） |
| `MACHINE_ID` | Variable | 留空；machine-less 模式不要填写 |
| `REGION_MAP` | Variable | 上面的单行 JSON |
| `WS_PATH` | Variable | `/cf-vless` |
| `PANEL_TOKEN` | Secret | XBoard 全局 `server_token` |
| `PATH_TOKEN` | Secret | 步骤 A 生成的随机令牌 |
| `ADMIN_TOKEN` | Secret | 另一个独立随机令牌（建议配置） |

`PANEL_TOKEN` 是 XBoard 的全局 `server_token`，不是管理员登录密码；`PATH_TOKEN` 和 `ADMIN_TOKEN` 也不能复用它。Worker 会把 `WS_PATH` 与 `PATH_TOKEN` 拼成真正的 WebSocket 路径，所以 XBoard 节点和客户端使用 `/cf-vless/<PATH_TOKEN>`，而 `REGION_MAP` 只写 `/cf-vless`。

### D. 验证、刷新订阅，再增加其他大区

1. 浏览器打开 `https://cf-asia.example.com/healthz`，应看到 `{"ok":true,...}`。若是 404，先检查自定义域名和 `REGION_MAP` 主机名是否完全一致。
2. 在 XBoard 中让测试用户属于该节点权限组且有余额，重新生成/刷新订阅。客户端参数应为：服务器和 SNI 为该域名、端口 `443`、TLS、WebSocket、Path `/cf-vless/<PATH_TOKEN>`、Flow 留空。
3. 访问普通 HTTPS 网站验证真实 TCP 代理，再在 XBoard 面板确认在线和流量上报。`healthz` 只代表 Worker HTTP 可用，不代表代理已经通过授权。
4. 确认一个节点后，复制 `examples/region-map.example.json`，把每个域名绑定到 Worker、在 XBoard 各建一个 machine-less 节点，并将各自真实 `node_id` 填入 `REGION_MAP`。节点显示名可以使用“全球｜Cloudflare优选”“亚洲｜Cloudflare优选”等大区名称；大区只是 Cloudflare 的位置提示，不保证出口国家。

如果不想使用 GitHub 导入，也可以按下方“本地部署”命令完成同样的部署；两种方式使用同一个 `wrangler.jsonc`，不要同时维护两套配置。

## 功能与兼容范围

- 一个 Worker、多个自定义域名、各域名独立的 XBoard `node_id`。
- 从 XBoard v2 server API 获取当前有权限、未过期、未封禁、仍有配额的用户；没有静态 UUID 后门。
- 同时要求正确的域名、WebSocket 路径令牌和用户 UUID；未知域名或路径不能用于代理。
- 无持久化默认模式每条新连接独立查询 XBoard，并在连接关闭时尽力上报一次流量。
- 无持久化模式只提供 Worker isolate 内的临时并发保护；不提供跨请求的用户/设备配额或流量账本。
- 上报用户上传/下载原始字节，流量倍率由 XBoard 应用。
- Durable Objects legacy 模式才提供持久账本、失败批次 reconcile 和跨请求限制。
- 接入域名可以接受 IPv4/IPv6 客户端；可用的目标 IPv6 TCP 连接仍取决于 Cloudflare 网络和目标服务。

当前支持 **VLESS TCP 命令经 WebSocket 传输**。不支持 VLESS UDP、QUIC、Reality、XTLS Vision、原生 TCP 入站或通用 UDP VPN。客户端 DNS 应使用 TCP、DoH 等可用方式，避免强制经此节点发送 UDP。Cloudflare 限制的目标地址仍无法访问，详细说明见下文。

## 1. 准备 XBoard 节点与全局 server_token

需要支持以下 API 的 XBoard 版本：

| API | 用途 |
| --- | --- |
| `GET /api/v2/server/user` | 获取节点可用用户 |
| `POST /api/v2/server/report` | 上报流量和在线来源 |

默认使用 **machine-less 全局模式**：Worker 通过 XBoard 的全局 `server_token` 调用上述节点 API，不需要创建 machine，也不需要在其他服务器上执行安装命令。请在 XBoard 管理设置中取得当前 `server_token`，作为 Worker 的 `PANEL_TOKEN` Secret。这个 token 不是 XBoard 管理员登录密码，也不要与 `ADMIN_TOKEN` 或用户 UUID 混用。

在 XBoard 中为每个地区新增一个节点，**Machine 留空**（`machine_id` 为 `null`），并填写：

| XBoard 字段 | 填写内容 |
| --- | --- |
| 名称 | `东北亚｜Cloudflare优选` 等大区名称 |
| 协议 | `VLESS` |
| 地址 / Host | 对应 Worker 域名，例如 `cf-asia-ne.example.com` |
| 用户连接端口 | `443` |
| 服务端端口 | `443`；项目不在服务器上监听此端口 |
| 传输协议 / Network | `WebSocket` / `ws` |
| TLS | 普通 TLS 开启；不要选择 Reality |
| SNI | 对应 Worker 域名 |
| WebSocket Path | `/cf-vless/<PATH_TOKEN>`，与 Worker 配置一致 |
| WebSocket Host | 对应 Worker 域名，或留空使客户端使用该域名 |
| Flow | 留空 |
| Machine | 留空；默认使用全局 `server_token` |
| 权限组 | 选择允许使用此节点的套餐权限组 |
| 流量倍率 | 按计费策略填写，例如 `1` 或 `2` |
| 启用 / 显示 | 开启 |

XBoard 会自动分配节点 ID；不要手动编造或修改 ID。仓库提供的 [`scripts/xboard-worker-plan.php`](scripts/xboard-worker-plan.php) 默认 `machine_mode` 为 `global`，只预览或创建 machine-less 节点；使用 `--apply` 时不会创建 machine，也不会导出 machine token。计划中的每个节点请显式设置 `"show": true`，否则脚本对新节点默认隐藏。脚本输出的节点 ID 用于写入 `REGION_MAP`。权限组为空时 XBoard 返回空用户列表，节点会拒绝连接。字段示例见 [`examples/xboard-node.example.json`](examples/xboard-node.example.json)。

将脚本和计划文件复制到 XBoard 容器可读取的路径后，在该容器中执行：

```sh
XBOARD_ROOT=/www php /tmp/xboard-worker-plan.php /tmp/plan.json
XBOARD_ROOT=/www php /tmp/xboard-worker-plan.php /tmp/plan.json --apply
```

计划文件只需要填写节点名称、域名、大区提示和权限组；节点 ID 由 XBoard/脚本生成，global 模式下不需要 `machine_id` 或 token 文件。不要把包含 `server_token` 的 `.dev.vars` 提交到 GitHub。

如果确实需要单独监控身份，脚本也支持 `machine_mode: "dedicated"`：这时才创建或复用专用 machine，Worker 的 `MACHINE_ID` 填该 machine ID、`PANEL_TOKEN` 改为 machine token。已有服务器 machine 不应复用。Worker 使用 XBoard 发放给用户的 UUID；订阅仍由 XBoard 生成，不要把任何 token 或用户 UUID 写进仓库。

## 2. 从 GitHub 导入 Cloudflare Workers

1. Fork 或复制本仓库到自己的 GitHub 账号。
2. 在 Cloudflare Dashboard 打开 **Workers & Pages → Create application → Import a repository**，选择仓库。
3. 项目目录选择仓库根目录，Build command 留空，Deploy command 填 `npm run deploy`，生产分支选择 `main`。
4. Worker 名称应与 [`wrangler.jsonc`](wrangler.jsonc) 的 `name` 一致；如果自定义名称，先修改仓库配置。
5. 选择 **Save and Deploy**。默认配置不会创建 Durable Object、SQLite 或 migration；只会上传一个无持久化 Worker。需要旧版精确统计时，改用 `wrangler.durable.jsonc` 和 `npm run deploy:durable`。
6. 进入 Worker 的 **Settings → Variables and Secrets**，按下一节添加运行时配置，再部署配置变更。

首次发布可以没有运行时凭据。此时代理功能拒绝访问，添加完整配置后才会开始接受连接。**Workers Builds 的 Build variables and secrets 只供构建使用，不会自动成为运行时变量。**

仓库配置启用了 `keep_vars`，普通 GitHub/Wrangler 部署会保留 Dashboard 中的变量和 Secret。默认无持久化配置没有绑定、迁移和定时任务；legacy 配置的迁移历史和 SQLite namespace 由 `wrangler.durable.jsonc` 管理，不要删除已发布的 legacy namespace。

也可以在安装 Node.js 后本地部署：

```sh
npm install
npm run check
npx wrangler login
npm run deploy
```

已经通过 API token 或其他方式认证时无需重复登录。

## 3. 配置运行时变量与 Secret

### 必填配置

| 名称 | 类型 | 内容 |
| --- | --- | --- |
| `PANEL_URL` | Variable | XBoard 的 HTTPS 地址，例如 `https://panel.example.com` |
| `MACHINE_ID` | Variable，可选 | 仅 dedicated machine 兼容模式需要；global machine-less 模式留空 |
| `PANEL_TOKEN` | **Secret** | global 模式填写 XBoard 全局 `server_token`；dedicated 模式填写专用 machine token |
| `REGION_MAP` | Variable 或 Secret | 下节 JSON；域名映射到真实节点 ID 和大区提示 |
| `PATH_TOKEN` | **Secret** | 16–128 个字符，仅使用字母、数字和 `._~-`；建议使用 32 字节随机数的十六进制值 |

强烈建议同时配置以下管理 Secret。未设置时健康检查和代理仍可工作，但管理接口关闭，无法处理待核对上报批次：

| 名称 | 类型 | 内容 |
| --- | --- | --- |
| `ADMIN_TOKEN` | **Secret** | 独立的随机管理令牌，用于查看状态；legacy 模式还用于人工核对 |

生成两个独立令牌，例如分别运行：

```sh
openssl rand -hex 32
```

不要复用 `PANEL_TOKEN` 作为路径或管理令牌。路径令牌能降低扫描和误用，但合法用户可以从订阅中看到路径；真正的用户授权依赖 UUID 和 XBoard 权限。global 模式的 `server_token` 权限较高，只放在 Cloudflare Secret 中，并按面板安全策略轮换。

### 可选限制

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `WS_PATH` | `/cf-vless` | 基础 WebSocket 路径，实际路径追加 `/<PATH_TOKEN>` |
| `USER_SYNC_SECONDS` | `60` | legacy 模式的用户同步间隔，范围 10–600 秒；无持久化模式每条新连接查询，忽略此值 |
| `REPORT_SECONDS` | `60` | legacy 模式的上报间隔，范围 10–600 秒；无持久化模式在连接关闭时上报，忽略此值 |
| `MAX_CONNECTIONS` | `128` | legacy 模式按对象限制；无持久化模式仅作当前 isolate 的临时保护，范围 1–1000 |
| `MAX_USER_CONNECTIONS` | `16` | 仅 legacy 模式生效；无持久化模式不提供跨请求用户连接限制 |
| `MAX_PENDING_BYTES` | `104857600` | 仅 legacy 模式生效；无持久化模式没有待上报持久队列 |
| `ALLOWED_PORTS` | 未设置 | 两种模式都支持的目标 TCP 端口白名单，例如 `80,443`；未设置时允许合法端口，但始终拒绝 `25` |

`MAX_USER_CONNECTIONS` 是 TCP 连接数上限，不等于设备数；一个浏览器也可能同时建立多条连接。XBoard `device_limit` 使用活跃来源 IP 近似设备数。处于同一 NAT 下的设备可能共用一个 IP，IPv6 地址变化可能增加计数。

legacy 模式的这些限制在每个 Durable Object 内生效；无持久化模式只能在当前 isolate 内临时限制连接。多个入口、不同 Worker 实例以及已有独立服务器节点之间，都不提供严格的全局并发、速度或设备配额。XBoard 的流量余额最终汇总所有节点，但同步和队列处理有延迟。

协议层还固定设置了单条 WebSocket 消息 1 MiB、输入队列 2 MiB / 64 条消息、握手及目标连接超时 10 秒、空闲超时 120 秒等保护。长时间没有载荷的连接会关闭，客户端应正常重连；这些保护不是 XBoard 套餐配额。

### REGION_MAP：一个域名对应一个节点

完整九个入口模板见 [`examples/region-map.example.json`](examples/region-map.example.json)。所有域名都绑定到同一个 Worker。

```json
{
  "cf-global.example.com": {
    "node_id": 4,
    "path": "/cf-vless"
  },
  "cf-asia-ne.example.com": {
    "node_id": 6,
    "location_hint": "apac-ne",
    "path": "/cf-vless"
  },
  "cf-europe.example.com": {
    "node_id": 8,
    "location_hint": "weur",
    "path": "/cf-vless"
  }
}
```

`REGION_MAP` 最多包含 32 个入口，总长度不超过 4800 字节。域名使用完整小写主机名，不能带协议、端口、通配符或路径；国际化域名先转换成 Punycode。每个域名的 `node_id` 必须唯一，并填写脚本输出的 XBoard 节点 ID；这是部署生成的内部引用，不是用户需要自定义的编号。`path` 是基础路径，只使用 `/`、字母、数字、下划线和连字符，最长 128 字符，不包含令牌；没有设置时使用 `WS_PATH`。`location_hint` 可以省略，表示全球入口附近模式；配置提示时使用以下大区。

| 提示 | 推荐节点名 | 推荐子域名 |
| --- | --- | --- |
| 省略 | `全球｜Cloudflare优选` | `cf-global` |
| `apac` | `亚太｜Cloudflare优选` | `cf-asia` |
| `apac-ne` | `东北亚｜Cloudflare优选` | `cf-asia-ne` |
| `apac-se` | `东南亚｜Cloudflare优选` | `cf-asia-se` |
| `weur` | `西欧｜Cloudflare优选` | `cf-europe` |
| `eeur` | `东欧｜Cloudflare优选` | `cf-europe-east` |
| `enam` | `北美东部｜Cloudflare优选` | `cf-north-america-east` |
| `wnam` | `北美西部｜Cloudflare优选` | `cf-north-america-west` |
| `oc` | `大洋洲｜Cloudflare优选` | `cf-oceania` |

legacy 模式的 Cloudflare `locationHint` 只在对象首次创建时生效，是选择附近数据中心的提示。无持久化模式没有对象位置选择，`location_hint` 只保留为 XBoard 节点说明。**两种模式都不能保证始终从该大洲或大区出站。** 出口 IP 的地理数据库也可能有不同结果。

Cloudflare 文档还列出 `sam`、`afr`、`me`，但目前明确说明这些位置尚不直接创建对象，会使用附近支持的地区，因此本项目没有将它们作为南美、非洲或中东的独立出口宣传。不能据此创建“遍布全球国家”的保证。

## 4. 绑定域名

在同一个 Worker 的 **Settings → Domains & Routes → Add Custom Domain** 中逐个加入 `REGION_MAP` 使用的域名。Cloudflare 会处理路由、DNS 和证书。使用新的 `cf-*` 域名，避免覆盖已有独立服务器节点的域名。

不用把域名指向服务器 A/AAAA 地址，也不用上传服务器证书。Cloudflare zone 默认的 IPv6 compatibility 可为入口提供 IPv6；确认没有在账号中关闭该功能。

仓库默认关闭 `*.workers.dev` 路由。若需使用，先启用 `workers_dev`，再把该完整主机名加入 `REGION_MAP`。绑定一个自定义域名并不会让其他域名或子域名自动匹配。

## 5. 验证与真机测试

先通过已绑定域名检查 HTTP 服务：

```sh
curl -i https://cf-asia-ne.example.com/healthz
```

健康响应仅表示 Worker HTTP 处理可用，不证明用户同步、TCP 出口或订阅可以使用。接着在 XBoard 更新订阅，在支持 VLESS WS TLS 的客户端导入新节点并测试：

1. 确认服务器地址、SNI、WebSocket Host 使用同一个新域名，端口为 `443`。
2. 确认 Path 为 `/cf-vless/<PATH_TOKEN>`，UUID 是当前 XBoard 用户 UUID，Flow 留空。
3. 使用有权限且有余额的账号，访问不在 Cloudflare 网络上的 TCP 测试网站。
4. 通过节点访问 IP 查询服务，记录实际出口 IP 和地区；分别测试全球和各大区入口。
5. 等待上报和面板队列处理，确认用户流量增加；如节点倍率为 `2`，面板扣费应使用两倍原始流量。
6. 用错误 UUID 或错误路径测试，连接应拒绝。撤销用户权限后，等待授权同步并确认已不能继续使用。

WebSocket 返回 `101` 只证明升级成功。完成 VLESS 用户授权、目标 TCP 连接并收到目标响应，才能证明代理链路可用。出口地区需要通过真实流量实测，不能根据入口 DNS IP 或 `/cdn-cgi/trace` 的入口 colo 判断。

## 授权、配额与流量上报

无持久化默认模式在每次 WebSocket 握手前调用 XBoard user API，因此新连接会读取
当时的授权、套餐和余额状态；已经建立的连接不会被跨请求主动撤销。每条连接的真实
TCP 载荷在关闭时通过 v2 report API 上报一次。TLS、WebSocket 和 VLESS 封装开销不
计入载荷，**不要在 Worker 中再乘以节点流量倍率**：XBoard 会应用自己的倍率。

关闭时的上报是 best-effort。请求失败或响应不明确时，Worker 没有持久队列可以重试；
也不会自动重放，因为 report API 没有批次幂等键，重放可能重复扣费。`/admin/status`
只显示当前 isolate 的临时计数，不代表全局在线人数或待上报总量。

如果需要持久账本、定时上报、失败批次隔离和人工 reconcile，使用 legacy 配置
`npm run deploy:durable`。legacy Worker 的管理接口如下：

```sh
curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
  https://cf-asia-ne.example.com/admin/status

curl -X POST https://cf-asia-ne.example.com/admin/reconcile \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  --data '{"batch_id":"<待核对批次ID>","outcome":"accepted"}'
```

- `accepted`：确认面板已接受，不再发送这一批。
- `not-accepted`：确认面板没有接受，恢复到待发送状态。

不要根据一次客户端超时就选择 `not-accepted`，也不要直接删除 legacy 对象存储或反复
发送相同批次。这个流程避免已知的重复扣费风险，但不提供跨 Cloudflare 与 XBoard
的严格 exactly-once 事务。legacy 全球节点按入口 colo 分片，管理请求可用
`?colo=FRA` 选择已知对象；无持久化模式不支持这个对象选择器。

## 平台限制与运行成本

Cloudflare 的 TCP API 禁止连接 Cloudflare IP 段、localhost、私网地址，以及 TCP `25` 端口。很多网站也使用 Cloudflare，因此 **这个纯 Worker 节点不保证访问所有网站**。遇到这些目标不能通过伪造 Host/SNI、域名前置或其他隐藏手段解决。本项目没有加入规避平台限制或封禁的逻辑。

解析到 Cloudflare IP 的站点（包括部分常见测速地址）可能在 `connect()` 阶段失败；本 Worker 也不支持 UDP、QUIC 或 WebRTC。不要用 `/cdn-cgi/trace`、`cp.cloudflare.com/generate_204` 或 Cloudflare 自测速 URL 判断节点出口，改用解析到非 Cloudflare IP 的 HTTPS/TCP 测试目标，例如 `https://www.gstatic.com/generate_204`，并以真实网页访问结果为准。

TCP API 是直接连接目标的原始字节流。目标 HTTPS 由客户端自行握手；Worker 不解密客户端到目标的 TLS。客户端到 Cloudflare 的 WebSocket 则使用入口 HTTPS 证书。

无持久化默认模式不创建 Durable Objects SQLite 存储，因此不会产生该项存储空间占用；仍会消耗普通 Worker 请求、CPU、子请求和长连接运行时间配额。转发中的 TCP 与 WebSocket 长连接会持续占用运行时资源，需关注账号用量。legacy 模式还会产生 Durable Objects 请求、SQLite 存储和活跃时长用量；免费方案达到任一限额后相关操作会失败。

## 常见问题

| 现象 | 检查方向 |
| --- | --- |
| 域名或 Path 返回 404 | 完整域名是否加入 `REGION_MAP`，Path 是否含正确令牌，域名是否绑定 Worker |
| HTTP 可用但代理失败 | XBoard `server_token`/node ID、用户权限组、UUID、TLS/WS 参数以及目标 TCP 限制 |
| XBoard user API 返回 403 | global 模式检查全局 `server_token`；dedicated 模式再检查 machine token、启用状态和节点归属；同时检查面板 WAF |
| 节点没有可用用户 | 权限组、用户封禁/到期/余额，面板是否兼容 v2 server API |
| 订阅仍显示旧参数 | 保存新的节点参数并刷新客户端订阅，确认 Flow 留空、普通 TLS 开启 |
| Clash 测速 timeout、Shadowrocket 只有延迟 | 先用 DoH 查询域名是否解析到 Cloudflare；某些网络的系统 DNS 会返回错误地址。确认服务器地址、SNI、Host 和 Path 完全来自最新订阅，并让客户端使用可直连的 TCP/DoH DNS，避免把 DNS 请求强制送入仅支持 TCP 的此节点。若 Clash Verge 的默认测速地址是 `https://cp.cloudflare.com/generate_204`，请改为 `https://www.gstatic.com/generate_204`：Cloudflare Worker 不能连接 Cloudflare 自身 IP，前一个地址会造成误报 Timeout；改测速地址后再测，并以真实网页访问为准。 |
| 有余额却暂停连接 | 无持久化模式先检查 XBoard user API；legacy 模式再查看 `/admin/status` 是否存在待核对批次或达到未上报流量保护上限 |
| IP 查询显示其他地区 | 位置提示与出口地理数据库均不保证国家；验证真实 TCP 出口，使用大区显示名称 |
| UDP 或 QUIC 应用不可用 | 本项目只实现 TCP；使用 TCP/DoH，或选择支持 UDP 的独立服务器节点 |

## 本地开发

```sh
cp .dev.vars.example .dev.vars
npm install
npm run check
npx wrangler dev
```

填写自己的测试 panel、全局 `server_token` 和 node 信息；`MACHINE_ID` 留空即可测试 machine-less 模式。`.dev.vars` 已被 Git 忽略；示例中的 token 只作占位，不能用于生产。默认 `npx wrangler dev` 使用无持久化入口；需要测试 legacy 对象时运行 `npx wrangler dev --config wrangler.durable.jsonc`。单元测试覆盖配置、协议处理和授权/上报行为；本地模拟不会证明 Cloudflare 的真实对象位置或 TCP 出口能力。

## 配置文件与参考

- [`wrangler.jsonc`](wrangler.jsonc)：默认无持久化 Worker 配置。
- [`src/index.js`](src/index.js)：默认入口的 VLESS、授权和尽力上报实现。
- [`wrangler.durable.jsonc`](wrangler.durable.jsonc)：legacy Durable Objects 配置，保留已有精确统计 namespace 的部署方式。
- [`src/durable-index.js`](src/durable-index.js)：legacy Durable Objects 入口。
- [`src/stateless-report.js`](src/stateless-report.js)：无持久化关闭上报数据构造。
- [`.dev.vars.example`](.dev.vars.example)：本地变量模板。
- [`examples/region-map.example.json`](examples/region-map.example.json)：九个全球/大区入口模板。
- [`examples/xboard-node.example.json`](examples/xboard-node.example.json)：新增 XBoard 节点模板。
- [Cloudflare TCP API 及禁止目标](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。
- [Cloudflare GitHub 部署配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。
- [Durable Objects 用量与价格](https://developers.cloudflare.com/durable-objects/platform/pricing/)（仅 legacy 模式）。
