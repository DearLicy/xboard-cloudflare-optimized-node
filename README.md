# XBoard Cloudflare 优选节点

一个可从 GitHub 导入部署的 Cloudflare Worker，使用 **VLESS + WebSocket + TLS** 提供独立的 TCP 代理节点。默认入口不创建 Durable Objects 或 SQLite 存储，每条新连接直接向 XBoard 校验用户 UUID，并通过 `cloudflare:sockets` 连接目标网站。Worker 独立运行，无需在其他服务器安装 V2bX，也无需配置代理源站。

同一个 Worker 可以绑定多个域名，每个域名对应 XBoard 中一个新增节点，分别设置权限组与流量倍率。无存储模式下，所有域名都由 Cloudflare 按访问者的网络路由选择入口；`location_hint` 仅为兼容旧配置保留的说明字段，不控制执行位置。节点名称中的国家或大区不会改变出口，推荐使用 `全球｜Cloudflare优选` 或自定义线路标签。

```text
VLESS 客户端 ── WSS / 443 ── 一个 Cloudflare Worker
                              ├─ cf-global.example.com → 各入口附近的 Cloudflare colo
                              ├─ cf-asia-ne.example.com → 各入口附近的 Cloudflare colo
                              ├─ cf-europe.example.com → 各入口附近的 Cloudflare colo
                              └─ ……                    → TCP 目标网站
                                      │
                                      └─ XBoard：用户授权、在线记录、流量上报
```

已有独立服务器节点可以继续使用。本项目只在 XBoard 中创建单独的新节点，不要求迁移已有节点；默认节点不绑定 machine。

## 默认无持久化部署

本仓库默认部署的是无 Durable Objects 的 Stateless Worker，目标 Worker 名称为
`xboard-cloudflare-node`，配置文件是 `wrangler.jsonc`，入口是 `src/index.js`。
它不会创建 SQLite、migration、alarm 或其他持久化绑定，适合账号已经达到
Durable Objects 存储/空间限制的情况：

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
的请求，避免重复扣费。它适合测试和能接受尽力计费的场景；如果业务必须使用持久
账本，请改用独立服务器节点或其他具备持久存储的部署方案。

`location_hint` 在无持久化模式中仅作为节点说明，实际执行位置由普通 Worker 的入口
colo 决定，不能承诺大区出口。已有独立服务器节点可以继续使用；本项目只在 XBoard
中创建单独的新节点，不要求迁移已有节点，默认节点不绑定 machine。

## 旧 Durable Objects 代码仅存档

仓库保留 `src/durable-index.js`、`src/ledger.js` 和 `wrangler.durable.jsonc` 供历史
审计与测试使用，但它们不再是部署路径，也不会被 `npm run deploy` 使用。
`wrangler.durable.jsonc` 指向独立的 `xboard-cloudflare-node-legacy-archive` 名称；
请不要部署它，否则会重新创建 Durable Objects 并再次占用存储。

切换仓库代码不会自动删除账号中已有的 namespace。迁移旧部署时，应先核对所有对象的
待上报流量和待核对批次，结清并备份必要数据，然后才删除旧 namespace。用于删除类的
migration 会永久清除该类的对象及数据。新安装按下文直接部署；迁移已有 Durable Objects Worker
请让 AI 检查远端 migration 状态，保留全部运行时变量、Secret 和域名，不能只覆盖代码。

<a id="migrate-existing-durable-worker"></a>

### 迁移已有 Durable Objects Worker（仅旧部署）

**新安装不需要执行删除 migration。** 本节仅用于把本仓库旧版、已经绑定
`RegionalNode` 类的 Worker 原地替换为无存储版本。旧版配置的末尾 migration tag 为
`v2-regional-node`，但应先读取目标 Worker 的实际已发布状态，不能直接假定它相同。
删除类会永久删除该类的所有对象和存储数据，详见
[Cloudflare 类迁移文档](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/)。

1. 确认目标账号、Worker 名称、已发布的 migration tag 和 `RegionalNode` namespace。
   如果 Worker 已是无存储版本、没有该类，不执行删除。如果远端状态与旧配置不符，
   先查清迁移历史，不猜 tag 或 namespace。
2. 暂停旧节点新流量，核对所有对象的待上报流量与待核对批次；与 XBoard 记录核对、
   结清并备份需要保留的账本。记录当前普通变量、Secret 名称、域名和定时任务；
   Secret 值应在安全位置保留，不写入仓库或报告。未完成核账与备份时不删除数据。
3. 使用 Cloudflare API 上传默认入口的 Worker 模块，同时移除 Durable Object 绑定。
   multipart 上传的 `metadata` 中，类迁移字段使用以下格式，`old_tag` 必须替换成
   第 1 步确认的实际值：

   ```json
   {
     "migrations": {
       "old_tag": "<实际旧tag>",
       "new_tag": "v3-delete-regional-node",
       "deleted_classes": ["RegionalNode"]
     }
   }
   ```

   这是 **API metadata 中的对象格式**，不是 Wrangler 配置中的 migration 数组。
   上传时保留普通变量与 Secret（API 可使用
   `keep_bindings: ["plain_text", "secret_text"]`），保留自定义域名。以上片段只展示
   迁移字段，仍需上传完整 Worker 模块与其余必要 metadata。不要重新部署存档入口。
   如果改用 Wrangler，只有在确认实际旧 tag 后，才在本地临时迁移配置中保留完整已发布
   migration 历史，再追加删除 `RegionalNode` 的新项；不要修改默认配置或仅写删除项。
4. 上传成功后核验运行时变量与 Secret 名称、域名和 `mode: stateless` 健康响应，
   确认旧 namespace 已移除。随后清空该 Worker 遗留的 Cron Triggers；默认代码不再
   需要定时任务。不要仅因上传成功就假定配置保留完整。
5. 刷新订阅，验证真实 TCP 代理、错误 UUID 拒绝和 XBoard 流量增加后，再恢复新连接。
   已有节点 ID、域名与路径保持一致时，无需重建 XBoard 节点。

## 不会部署时：把仓库交给 AI

仓库附带一个可供 AI 使用的部署 Skill：[`skills/xboard-cloudflare-deploy/SKILL.md`](skills/xboard-cloudflare-deploy/SKILL.md)。它会按“小白先做一个节点、验证成功后再扩展”的顺序检查配置、部署 Worker、绑定域名、接入 XBoard 并验证订阅和流量上报。Skill 优先推荐在 **Codex** 中使用；它能在 GitHub 和 Cloudflare 插件/MCP 已连接时检查仓库并执行部署。

将本仓库链接和下面这段话一起发给 Codex（或其他支持读取仓库 Skill 的 AI）：

```text
请使用 $xboard-cloudflare-deploy（文件位于 skills/xboard-cloudflare-deploy/SKILL.md），按其中的流程帮我部署。
先检查 GitHub 和 Cloudflare 插件/MCP 是否已连接到正确账号，再检查仓库和配置。
先做 dry-run 并列出将要创建或修改的资源；任何外部写入前都要向我说明并等待授权。
我希望先部署一个 machine-less XBoard VLESS 节点，成功后再增加其他域名节点。
请不要修改已有服务器节点，不要把任何密钥写入仓库或聊天记录。
```

AI 需要能够访问目标 Cloudflare 账号、GitHub 仓库以及（如需自动创建节点）XBoard。缺少任一插件/MCP 或权限时，Skill 会停止外部写入并给出手动操作步骤；这时不要把 `server_token`、API Token、私钥或用户 UUID 粘贴到公开聊天中。无插件的 AI 仍可按照 README 逐步指导，但不能声称已经完成部署。

## 小白快速部署（推荐先只做一个节点）

下面这条路径不需要 SSH 到任何服务器，也不需要在服务器上安装程序。准备好 **Cloudflare 账号（域名托管在该账号）**、**XBoard 管理员权限** 和一个可用于 Fork/导入仓库的 GitHub 账号后，按顺序完成即可。先做一个节点确认链路正常，再复制配置增加其他域名节点。

### A. 先准备一个域名和一个 XBoard 节点

1. 在 Cloudflare 中选一个没有被现有服务使用的子域名，例如 `cf-global.example.com`。不要复用已有独立节点正在使用的域名。
2. 生成一个随机路径令牌。macOS/Linux 可在终端运行 `openssl rand -hex 32`；Windows 可用密码管理器生成至少 32 个字符的随机字符串。这个值稍后作为 `PATH_TOKEN` Secret，**不要发到群组或提交到 GitHub**。
3. 在 XBoard 新增一个 **VLESS** 节点，Machine 留空（`machine_id = null`），并填写：地址/Host 为上面的域名、端口 `443`、TLS 开启、Network 选 `ws`、SNI 和 WebSocket Host 都填该域名、WebSocket Path 填 `/cf-vless/<刚生成的路径令牌>`、Flow 留空。选择允许使用它的权限组，打开“启用”和“显示”，流量倍率按你的计费策略填写（例如 `1` 或 `2`）。无持久化模式会在每条新连接查询 XBoard，但不会跨连接保存设备/并发状态。
4. 保存节点并记下 XBoard 自动生成的 **节点 ID**。节点 ID 不是自定义 ID；通常可以在节点详情、编辑地址或 XBoard API 中看到。后面的 `REGION_MAP` 必须填写这个真实 ID。

如果暂时没有 XBoard 面板权限，不能跳过这一步：Worker 会向 XBoard 查询用户和上报流量，没有真实节点 ID 就不会放行用户。需要批量创建节点时，再使用下方的 `xboard-worker-plan.php` 脚本。

### B. 在 Cloudflare 从 GitHub 部署 Worker

1. 在 GitHub 打开本仓库，点击 **Fork**（或复制到自己的账号）。
2. 在 Cloudflare Dashboard 进入 **Workers & Pages → Create application → Import a repository**，授权 GitHub 后选择刚 Fork 的仓库。
3. 项目目录选择仓库根目录；生产分支选 `main`；**Build command 留空**；**Deploy command 填 `npm run deploy`**；保存并部署。不要把变量填在 GitHub/Workers Builds 的 Build variables 区域，那些变量只在构建时可见。
4. 首次部署完成后，进入该 Worker 的 **Settings → Variables and Secrets**。按“配置运行时变量”表逐项添加：普通值用 **Variable**，令牌用 **Secret**。变量名必须完全一致，保存后点击 **Deploy** 使新变量生效。
5. 在同一 Worker 的 **Settings → Domains & Routes → Add Custom Domain** 中加入 `cf-global.example.com`。Cloudflare 会自动创建 DNS 和证书；不要把这个域名解析到某台服务器，也不要上传服务器证书。每增加一个 `REGION_MAP` 域名，都要在这里单独添加一次。

### C. 填入最小可用配置

先只配置一个域名，确认成功后再把示例文件中的其他域名逐个加入。`REGION_MAP` 在 Cloudflare 面板中应填成一行 JSON（不要带代码块标记），把 `123` 换成你刚记下的节点 ID，把域名换成你自己的域名：

```json
{"cf-global.example.com":{"node_id":123,"path":"/cf-vless"}}
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

### D. 验证、刷新订阅，再增加其他域名节点

1. 浏览器打开 `https://cf-global.example.com/healthz`，应看到 `{"ok":true,...}`。若是 404，先检查自定义域名和 `REGION_MAP` 主机名是否完全一致。
2. 在 XBoard 中让测试用户属于该节点权限组且有余额，重新生成/刷新订阅。客户端参数应为：服务器和 SNI 为该域名、端口 `443`、TLS、WebSocket、Path `/cf-vless/<PATH_TOKEN>`、Flow 留空。
3. 访问普通 HTTPS 网站验证真实 TCP 代理，再在 XBoard 面板确认在线和流量上报。`healthz` 只代表 Worker HTTP 可用，不代表代理已经通过授权。
4. 确认一个节点后，复制 `examples/region-map.example.json`，把每个域名绑定到 Worker、在 XBoard 各建一个 machine-less 节点，并将各自真实 `node_id` 填入 `REGION_MAP`。推荐显示名使用“全球｜Cloudflare优选”或自定义线路标签。模板中的亚洲、欧洲等名字只是显示标签；无存储模式不会按这些名字或 `location_hint` 选择大区，也不会固定出口。

如果不想使用 GitHub 导入，也可以按下方“本地部署”命令完成同样的部署；两种方式使用同一个 `wrangler.jsonc`，不要同时维护两套配置。

## 功能与兼容范围

- 一个 Worker、多个自定义域名、各域名独立的 XBoard `node_id`。
- 从 XBoard v2 server API 获取当前有权限、未过期、未封禁、仍有配额的用户；没有静态 UUID 后门。
- 同时要求正确的域名、WebSocket 路径令牌和用户 UUID；未知域名或路径不能用于代理。
- 无持久化默认模式每条新连接独立查询 XBoard，并在连接关闭时尽力上报一次流量。
- 无持久化模式只提供 Worker isolate 内的临时并发保护；不提供跨请求的用户/设备配额或流量账本。
- 上报用户上传/下载原始字节，流量倍率由 XBoard 应用。
- 持久账本、失败批次 reconcile 和跨请求全局限制不属于本仓库的无存储模式。
- 接入域名可以接受 IPv4/IPv6 客户端；可用的目标 IPv6 TCP 连接仍取决于 Cloudflare 网络和目标服务。

当前支持 **VLESS TCP 命令经 WebSocket 传输**。不支持 VLESS UDP、QUIC、Reality、XTLS Vision、原生 TCP 入站或通用 UDP VPN。客户端 DNS 应使用 TCP、DoH 等可用方式，避免强制经此节点发送 UDP。Cloudflare 限制的目标地址仍无法访问，详细说明见下文。

## 1. 准备 XBoard 节点与全局 server_token

需要支持以下 API 的 XBoard 版本：

| API | 用途 |
| --- | --- |
| `GET /api/v2/server/user` | 获取节点可用用户 |
| `POST /api/v2/server/report` | 上报流量和在线来源 |

默认使用 **machine-less 全局模式**：Worker 通过 XBoard 的全局 `server_token` 调用上述节点 API，不需要创建 machine，也不需要在其他服务器上执行安装命令。请在 XBoard 管理设置中取得当前 `server_token`，作为 Worker 的 `PANEL_TOKEN` Secret。这个 token 不是 XBoard 管理员登录密码，也不要与 `ADMIN_TOKEN` 或用户 UUID 混用。

在 XBoard 中为每个域名新增一个节点，**Machine 留空**（`machine_id` 为 `null`），并填写：

| XBoard 字段 | 填写内容 |
| --- | --- |
| 名称 | `全球｜Cloudflare优选` 或自定义线路标签；名称不会选择地区出口 |
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

计划文件只需要填写节点名称、域名和权限组；兼容字段 `location_hint` 可以省略，不控制执行位置。节点 ID 由 XBoard/脚本生成，global 模式下不需要 `machine_id` 或 token 文件。不要把包含 `server_token` 的 `.dev.vars` 提交到 GitHub。

如果确实需要单独监控身份，脚本也支持 `machine_mode: "dedicated"`：这时才创建或复用专用 machine，Worker 的 `MACHINE_ID` 填该 machine ID、`PANEL_TOKEN` 改为 machine token。已有服务器 machine 不应复用。Worker 使用 XBoard 发放给用户的 UUID；订阅仍由 XBoard 生成，不要把任何 token 或用户 UUID 写进仓库。

## 2. 从 GitHub 导入 Cloudflare Workers

1. Fork 或复制本仓库到自己的 GitHub 账号。
2. 在 Cloudflare Dashboard 打开 **Workers & Pages → Create application → Import a repository**，选择仓库。
3. 项目目录选择仓库根目录，Build command 留空，Deploy command 填 `npm run deploy`，生产分支选择 `main`。
4. Worker 名称应与 [`wrangler.jsonc`](wrangler.jsonc) 的 `name` 一致；如果自定义名称，先修改仓库配置。
5. 选择 **Save and Deploy**。默认配置不会创建 Durable Object、SQLite 或 migration；只会更新名为 `xboard-cloudflare-node` 的无持久化 Worker。
6. 进入 Worker 的 **Settings → Variables and Secrets**，按下一节添加运行时配置，再部署配置变更。

首次发布可以没有运行时凭据。此时代理功能拒绝访问，添加完整配置后才会开始接受连接。**Workers Builds 的 Build variables and secrets 只供构建使用，不会自动成为运行时变量。**

仓库配置启用了 `keep_vars`，普通 GitHub/Wrangler 部署会保留 Dashboard 中的变量和 Secret。默认无持久化配置没有绑定、迁移和定时任务；`wrangler.durable.jsonc` 仅为历史存档，不能用于生产部署。

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
| `REGION_MAP` | Variable 或 Secret | 下节 JSON；域名映射到真实节点 ID，`location_hint` 只是可选兼容元数据 |
| `PATH_TOKEN` | **Secret** | 16–128 个字符，仅使用字母、数字和 `._~-`；建议使用 32 字节随机数的十六进制值 |

强烈建议同时配置以下管理 Secret。未设置时健康检查和代理仍可工作，但管理接口关闭：

| 名称 | 类型 | 内容 |
| --- | --- | --- |
| `ADMIN_TOKEN` | **Secret** | 独立的随机管理令牌，用于查看当前 Worker isolate 状态 |

生成两个独立令牌，例如分别运行：

```sh
openssl rand -hex 32
```

不要复用 `PANEL_TOKEN` 作为路径或管理令牌。路径令牌能降低扫描和误用，但合法用户可以从订阅中看到路径；真正的用户授权依赖 UUID 和 XBoard 权限。global 模式的 `server_token` 权限较高，只放在 Cloudflare Secret 中，并按面板安全策略轮换。

### 可选限制

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `WS_PATH` | `/cf-vless` | 基础 WebSocket 路径，实际路径追加 `/<PATH_TOKEN>` |
| `USER_SYNC_SECONDS` | `60` | 为兼容旧配置保留；无持久化模式每条新连接查询，忽略此值 |
| `REPORT_SECONDS` | `60` | 为兼容旧配置保留；无持久化模式在连接关闭时上报，忽略此值 |
| `MAX_CONNECTIONS` | `128` | 当前 Worker isolate 的临时连接保护，范围 1–1000；不提供全局限制 |
| `MAX_USER_CONNECTIONS` | `16` | 为兼容旧配置保留；无持久化模式不提供跨请求用户连接限制 |
| `MAX_PENDING_BYTES` | `104857600` | 为兼容旧配置保留；无持久化模式没有待上报持久队列 |
| `ALLOWED_PORTS` | 未设置 | 目标 TCP 端口白名单，例如 `80,443`；未设置时允许合法端口，但始终拒绝 `25` |

`MAX_USER_CONNECTIONS` 与 XBoard `device_limit` 在无存储模式中不提供全局强制限制；单个用户可以同时建立多条 TCP 连接。需要严格设备数或用户并发配额时，应使用支持共享状态的节点程序。

无持久化模式只能在当前 isolate 内临时限制连接。多个入口、不同 Worker 实例以及已有独立服务器节点之间，都不提供严格的全局并发、速度或设备配额。XBoard 的流量余额最终汇总所有节点，但上报处理有延迟。

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

`REGION_MAP` 最多包含 32 个入口，总长度不超过 4800 字节。域名使用完整小写主机名，不能带协议、端口、通配符或路径；国际化域名先转换成 Punycode。每个域名的 `node_id` 必须唯一，并填写脚本输出的 XBoard 节点 ID；这是部署生成的内部引用，不是用户需要自定义的编号。`path` 是基础路径，只使用 `/`、字母、数字、下划线和连字符，最长 128 字符，不包含令牌；没有设置时使用 `WS_PATH`。

`location_hint` 可以省略。它仅为兼容旧配置保留，填入或省略都不会改变执行位置；所有域名仍由 Cloudflare 的访客入口路由处理。下表列出旧模板接受的元数据及显示标签，便于保留已有配置，**不是可选择的大区出口列表**。新节点可统一使用全球名称或自己的线路标签。

| 兼容元数据 | 旧模板显示标签（仅名称） | 模板子域名 |
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

无持久化模式没有 Durable Object 位置选择。新增域名或修改显示名称只能增加逻辑节点，不能创建指定国家、大洲或大区的出口；实际出口需通过 TCP 流量测试确认，IP 地理数据库也可能有不同结果。

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
4. 通过节点访问 IP 查询服务，记录实际出口 IP 和地区；逐个测试域名入口，不根据节点名称推断地区。
5. 等待上报和面板队列处理，确认用户流量增加；如节点倍率为 `2`，面板扣费应使用两倍原始流量。
6. 用错误 UUID 或错误路径测试，连接应拒绝。撤销用户权限后，重新建立连接应被拒绝；已有连接不会主动断开。

WebSocket 返回 `101` 只证明升级成功。完成 VLESS 用户授权、目标 TCP 连接并收到目标响应，才能证明代理链路可用。出口地区需要通过真实流量实测，不能根据入口 DNS IP 或 `/cdn-cgi/trace` 的入口 colo 判断。

## 授权、配额与流量上报

无持久化默认模式在每次 WebSocket 握手前调用 XBoard user API，因此新连接会读取
当时的授权、套餐和余额状态；已经建立的连接不会被跨请求主动撤销。每条连接的真实
TCP 载荷在关闭时通过 v2 report API 上报一次。TLS、WebSocket 和 VLESS 封装开销不
计入载荷，**不要在 Worker 中再乘以节点流量倍率**：XBoard 会应用自己的倍率。

关闭时的上报是 best-effort。请求失败或响应不明确时，Worker 没有持久队列可以重试；
也不会自动重放，因为 report API 没有批次幂等键，重放可能重复扣费。`/admin/status`
只显示当前 isolate 的临时计数，不代表全局在线人数或待上报总量。

无持久化 Worker 的管理接口只读取当前 isolate 的临时状态：

```sh
curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
  https://cf-asia-ne.example.com/admin/status
```
上报失败不会进入持久队列，也没有 `/admin/reconcile` 接口；需要人工核对时请以
XBoard 面板记录和客户端日志为准。仓库中的 legacy 文件只供历史审计，不应部署。

## 平台限制与运行成本

Cloudflare 的 TCP API 禁止连接 Cloudflare IP 段、localhost、私网地址，以及 TCP `25` 端口。很多网站也使用 Cloudflare，因此 **这个纯 Worker 节点不保证访问所有网站**。遇到这些目标不能通过伪造 Host/SNI、域名前置或其他隐藏手段解决。本项目没有加入规避平台限制或封禁的逻辑。

解析到 Cloudflare IP 的站点（包括部分常见测速地址）可能在 `connect()` 阶段失败；本 Worker 也不支持 UDP、QUIC 或 WebRTC。不要用 `/cdn-cgi/trace`、`cp.cloudflare.com/generate_204` 或 Cloudflare 自测速 URL 判断节点出口，改用解析到非 Cloudflare IP 的 HTTPS/TCP 测试目标，例如 `https://www.gstatic.com/generate_204`，并以真实网页访问结果为准。

TCP API 是直接连接目标的原始字节流。目标 HTTPS 由客户端自行握手；Worker 不解密客户端到目标的 TLS。客户端到 Cloudflare 的 WebSocket 则使用入口 HTTPS 证书。

无持久化模式不创建 Durable Objects SQLite 存储，因此不会产生该项存储空间占用；仍会消耗普通 Worker 请求、CPU、子请求和长连接运行时间配额。转发中的 TCP 与 WebSocket 长连接会持续占用运行时资源，需关注账号用量。

## 常见问题

| 现象 | 检查方向 |
| --- | --- |
| 域名或 Path 返回 404 | 完整域名是否加入 `REGION_MAP`，Path 是否含正确令牌，域名是否绑定 Worker |
| HTTP 可用但代理失败 | XBoard `server_token`/node ID、用户权限组、UUID、TLS/WS 参数以及目标 TCP 限制 |
| XBoard user API 返回 403 | global 模式检查全局 `server_token`；dedicated 模式再检查 machine token、启用状态和节点归属；同时检查面板 WAF |
| 节点没有可用用户 | 权限组、用户封禁/到期/余额，面板是否兼容 v2 server API |
| 订阅仍显示旧参数 | 保存新的节点参数并刷新客户端订阅，确认 Flow 留空、普通 TLS 开启 |
| Clash 测速 timeout、Shadowrocket 只有延迟 | 先用 DoH 查询域名是否解析到 Cloudflare；某些网络的系统 DNS 会返回错误地址。确认服务器地址、SNI、Host 和 Path 完全来自最新订阅，并让客户端使用可直连的 TCP/DoH DNS，避免把 DNS 请求强制送入仅支持 TCP 的此节点。若 Clash Verge 的默认测速地址是 `https://cp.cloudflare.com/generate_204`，请改为 `https://www.gstatic.com/generate_204`：Cloudflare Worker 不能连接 Cloudflare 自身 IP，前一个地址会造成误报 Timeout；改测速地址后再测，并以真实网页访问为准。 |
| 有余额却暂停连接 | 检查 XBoard user API、权限组、余额和 Worker `/admin/status`；无持久化模式不会保存待上报队列 |
| IP 查询显示其他地区 | 无存储模式不按 `location_hint` 选择地区；名称只是标签。验证真实 TCP 出口，使用全球名称或自定义线路标签 |
| UDP 或 QUIC 应用不可用 | 本项目只实现 TCP；使用 TCP/DoH，或选择支持 UDP 的独立服务器节点 |

## 本地开发

```sh
cp .dev.vars.example .dev.vars
npm install
npm run check
npx wrangler dev
```

填写自己的测试 panel、全局 `server_token` 和 node 信息；`MACHINE_ID` 留空即可测试 machine-less 模式。`.dev.vars` 已被 Git 忽略；示例中的 token 只作占位，不能用于生产。默认 `npx wrangler dev` 使用无持久化入口。单元测试覆盖配置、协议处理和授权/上报行为；本地模拟不会证明 Cloudflare 的真实入口或 TCP 出口能力。

## 配置文件与参考

- [`wrangler.jsonc`](wrangler.jsonc)：默认无持久化 Worker 配置。
- [`src/index.js`](src/index.js)：默认入口的 VLESS、授权和尽力上报实现。
- [`wrangler.durable.jsonc`](wrangler.durable.jsonc)：历史 Durable Objects 配置存档，请勿部署。
- [`src/durable-index.js`](src/durable-index.js)：历史 Durable Objects 入口存档。
- [`src/stateless-report.js`](src/stateless-report.js)：无持久化关闭上报数据构造。
- [`.dev.vars.example`](.dev.vars.example)：本地变量模板。
- [`examples/region-map.example.json`](examples/region-map.example.json)：九个域名映射模板；大区名只是兼容旧配置的显示标签。
- [`examples/xboard-node.example.json`](examples/xboard-node.example.json)：新增 XBoard 节点模板。
- [Cloudflare TCP API 及禁止目标](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。
- [Cloudflare GitHub 部署配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。
- [Workers 用量与限制](https://developers.cloudflare.com/workers/platform/limits/)。
