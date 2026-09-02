# External Play 本地鉴权简化与 Prime CLI 解耦方案

> 日期：2026-08-31
>
> 状态：待确认、待实施
>
> 适用范围：MazeBenchEngine 本地网站、External Play、本地 stdio MCP、可选 Agent/Prime 集成
>
> 前置方案：`docs/plan/2026-08-25-local-mcp-live-service.md`

## 1. 结论

本次改造分为两个互相独立、按顺序交付的部分：

1. **P0：修复 External Play 的本地使用体验。** 删除本地网页对 Admin cookie 和一次性 bootstrap nonce 的依赖，继续依赖项目已有的 loopback、same-origin 和 JSON Content-Type 防护；保留 MCP controller token 和 Viewer token。修复网页时间参数失效以及默认 `armed` run 与“新建场次”冲突的问题。
2. **P1：把 Prime CLI 从默认运行路径解耦。** MazeBench Core 默认只包含游戏引擎、本地网站、External Play、本地 MCP、回放和总结；Prime 模型目录、runner、resume、eval sync 与环境发布改成显式启用的可选集成，默认启动和默认打包不得探测或调用 Prime CLI。

不建议第一步直接删除所有 Prime 代码。当前 Prime 逻辑与 Agent service、历史结果解析、CLI、打包镜像、测试和 CI 交织较深，先建立可选集成边界更容易验证，也能在不影响本地 MCP 的前提下决定是否最终删除。

## 2. 当前问题与根因

### 2.1 `Admin cookie required to create runs`

该错误不是 Prime CLI 导致的，而是 External Play 自己的浏览器管理鉴权未在所有本地启动路径中完成。

当前调用链：

```text
External Play 创建表单
  -> POST /api/external-play/runs
  -> server/router.js 检查 mb_admin_token
  -> 未找到内存中的 admin session
  -> 401 Admin cookie required to create runs
```

Admin cookie 只能通过以下链路取得：

```text
带 #bootstrap_nonce 的页面
  -> public/external-play.js 读取 nonce
  -> POST /api/external-play/admin/session
  -> Set-Cookie: mb_admin_token=...
```

但当前启动入口不一致：

- 前台首次 `mazebench launch` 会等待 `server.json`，然后尝试打开带 nonce 的 spectator 地址；
- `mazebench launch bg` 只打开普通 URL；
- 检测到服务已经运行时只打开普通 URL；
- 用户手动输入 `/external-play` 时没有 nonce；
- nonce 是单次使用，admin session 只存在于服务进程内，服务重启后旧 cookie 失效。

因此该机制在本地使用中必然表现为“有时能用、有时 401”。

### 2.2 Admin cookie 与现有本地安全边界重复

`server/router.js` 已经在所有页面和 API 之前强制执行：

- HTTP `Host` 必须是 loopback；
- TCP peer 必须是 loopback；
- API 的 `Origin`/`Sec-Fetch-Site` 必须是 same-origin 或允许的直接访问；
- `POST`、`PUT`、`PATCH`、`DELETE` 必须使用 `application/json`。

External Play P0 明确不支持远程 MCP 或公网访问，因此 Admin cookie 没有形成新的远程安全边界，反而让本地浏览器启动依赖一次性 URL。

### 2.3 时间参数契约不一致

当前页面提交：

```json
{
  "duration_min": 30
}
```

服务端读取：

```text
duration_ms
```

所以网页选择的时间没有传入 `ExternalPlayService.createRun()`，最终继续使用默认时长。

### 2.4 默认场次与创建场次冲突

服务初始化时会自动创建一个默认 `armed` run，保证 CLI 不打开网页也能直接调用 MCP。与此同时，落地页又提供“Create Armed Session”。

`createRun()` 遇到任何 `armed`、`active` 或 `finalizing` run 都返回 `409 Conflict`。因此即使解决 cookie，首次打开页面时仍可能无法按表单参数创建新场次。

### 2.5 Prime CLI 的真实耦合位置

External Play 和 `maze-external-mcp.js` 的游戏控制链路本身不调用 Prime CLI，但默认项目仍存在以下结构耦合：

- `server/app.js` 始终创建包含 Prime 行为的 AgentRunService，并启用 `syncPrimeEvaluations`；
- `server/agent-runs.js` 顶层直接加载 Prime resume、harness catalog、模型目录、runner、sync 和清理逻辑；
- `scripts/maze-agent-local.js` 内含 Prime Inference provider 配置和 credential mount；
- `mazebench_cli/__init__.py` 默认帮助和命令分发暴露 `mazebench prime`；
- root package、Prime environment、runtime mirror、测试和 CI 仍共同维护 Prime 路径；
- Prime 结果解析与通用 token/usage 展示混在同一模块中。

核心 Python CLI 当前没有 Prime 硬依赖，但“默认运行代码会加载 Prime 相关模块”和“项目维护必须携带 Prime 路径”仍然属于不必要耦合。

## 3. 目标架构

```text
MazeBench Core（默认启用）
├── MazeBenchEngine / world bundle
├── 本地网站 Build / Play
├── ExternalPlayService
├── stdio MCP adapter
├── Spectator / SSE / Replay / Summary
└── 通用 Agent artifact 展示（如继续保留）

Optional Integrations（默认不加载）
└── PrimeIntegration
    ├── Prime model catalog
    ├── Prime runner / sandbox
    ├── Prime resume
    ├── Prime eval create / sync / stop
    ├── Prime artifact parser
    └── Prime environment packaging
```

默认本地链路必须是：

```text
Gemini / Codex / Claude Desktop
  -> mazebench mcp（stdio）
  -> loopback controller API + controller token
  -> ExternalPlayService
  -> MazeBench JS engine
  -> SSE / snapshot / replay
  -> 本地浏览器 spectator
```

该链路中不得检查 `prime` 是否安装，不得读取 `.prime`，不得读取 `PRIME_*` 环境变量，也不得启动 Prime 子进程。

## 4. 安全边界决策

### 4.1 删除的机制

从 External Play 本地浏览器管理面删除：

- `adminSessions`；
- `bootstrapNonce`；
- `handleAdminSession()`；
- `validateAdminCookie()`；
- `/api/external-play/admin/session`；
- `mb_admin_token` cookie；
- `server.json` 中的 `bootstrap_nonce`；
- URL hash 中的 `bootstrap_nonce`；
- 浏览器端 `bootstrapSessionIfNeeded()`。

### 4.2 必须保留的机制

以下边界不能因为删除 Admin cookie 而放宽：

1. 全局 loopback Host 和 loopback TCP peer 校验；
2. same-origin / `Sec-Fetch-Site` 校验；
3. mutation 请求的 `application/json` 限制；
4. MCP controller bootstrap nonce、controller token、instance ID 与 TTL；
5. 每个 run 的 controller lease、epoch、heartbeat 和单控制器规则；
6. Viewer token 对 snapshot、actions、SSE、blob、world bundle 和 summary 的 run 级绑定；
7. benchmark agent 的宿主文件、仓库、shell 和网络隔离。

删除 Admin cookie 只影响本机浏览器对 run 的创建、取消和 Viewer token 申请，不影响 MCP 控制权限。

### 4.3 不扩大为远程服务

本阶段不支持 LAN/公网访问。即使进程绑定 `0.0.0.0`，router 仍只接受 loopback Host 和 loopback peer。未来若实现远程观看，应单独设计持久身份认证、TLS 和跨设备 token，不恢复当前这种一次性本地 nonce 方案。

## 5. P0：External Play 修复方案

### 5.1 浏览器管理 API

以下操作通过现有本地 API 安全守卫后即可执行，不再检查 Admin cookie：

- `GET /api/external-play/runs`；
- `POST /api/external-play/runs`；
- `POST /api/external-play/runs/:runId/cancel`；
- `POST /api/external-play/runs/:runId/viewer-token`。

snapshot、actions、events、blobs、world bundle 和 summary 继续要求 Viewer token。Viewer token 申请接口本身只接受通过 loopback + same-origin + JSON 校验的本机页面请求。

### 5.2 启动器行为统一

`mazebench launch` 的所有分支统一只打开普通本地 URL：

- 首次前台启动；
- 首次后台启动；
- 服务已经运行；
- restart 后重新打开。

建议默认打开 `/external-play`。如果产品仍希望直接进入 spectator，可打开当前 `active_run_id` 对应页面，但不得再拼接秘密 hash。

`server.json` 仅保存进程发现和 MCP controller bootstrap 所需数据：

```json
{
  "pid": 1234,
  "instance_id": "srv-...",
  "host": "127.0.0.1",
  "port": 3000,
  "url": "http://127.0.0.1:3000",
  "active_run_id": "ext-...",
  "mcp_bootstrap_nonce": "...",
  "started_at": "..."
}
```

### 5.3 时间参数统一

HTTP API 只接受毫秒字段：

```json
{
  "duration_ms": 1800000,
  "win_threshold": 10
}
```

页面负责把分钟转换为毫秒：

```text
duration_ms = durationMin * 60_000
```

服务端继续做最终范围验证，不能用 truthy 判断吞掉 `0`、`NaN` 或非法字符串。建议显式验证：

- `duration_ms` 为安全整数；
- 最小值 60 秒；
- 最大值 6 小时；
- `win_threshold` 为 1～100 的整数。

manifest、journal、deadline 和 summary 全部使用同一个规范化后的 `duration_ms`。

### 5.4 默认 `armed` run 与新建场次

保留服务启动时自动创建默认 `armed` run，因为 MCP 客户端可能在用户打开网页前连接。

落地页按状态显示不同操作：

| 当前状态 | 页面行为 |
| --- | --- |
| 无非终态 run | 显示“创建场次” |
| `armed` 且未被 claim | 显示“使用当前场次”和“按当前表单替换场次” |
| `active` | 显示“观看当前场次”和显式“取消” |
| `finalizing` | 禁止创建，显示结算中 |
| 终态 | 允许创建下一场 |

“替换场次”必须在 admission mutex 内原子执行：

1. 再次确认目标 run 仍为 `armed`；
2. 确认没有 controller、lease、action 或已启动计时；
3. 将旧 run 以明确原因 `reconfigured_before_start` 终态化；
4. 创建带新参数的 run；
5. 更新 `activeRunId` 和 `server.json`；
6. 返回新 `run_id`。

如果 MCP 在替换前已经 claim，服务端返回 `409 RUN_ALREADY_CLAIMED`，页面转为“观看当前场次”，不得覆盖正在运行的游戏。

### 5.5 页面错误展示

浏览器端按状态码和稳定错误码展示：

- `400 INVALID_ARGUMENT`：表单参数错误；
- `404 NOT_FOUND`：目标 run 不存在；
- `409 RUN_ALREADY_CLAIMED`：MCP 已接管；
- `409 RUN_ACTIVE`：已有进行中的场次；
- `503 INITIALIZING`：服务尚未就绪。

不再出现 `Admin cookie required ...` 类错误。

## 6. P1：Prime CLI 解耦方案

### 6.1 建立可选集成接口

新增一个中性接口，由 `server/app.js` 根据显式配置注入：

```js
const primeIntegration = enablePrime
  ? createPrimeIntegration(options)
  : null;

const agentRuns = createAgentRunService({
  ...coreOptions,
  primeIntegration
});
```

建议的 integration 能力边界：

```text
enabled
listModels(options)
validateLaunch(request)
buildLaunchCommand(request, runDir)
readLiveUsage(runDir)
readResultArtifacts(runDir)
createResumeCheckpoint(runDir, state)
syncEvaluation(run)
stopEvaluation(run)
dispose()
```

AgentRunService 只处理通用的 run 状态、日志、回放和 UI DTO，不再直接知道 Prime CLI 的命令行、配置文件或 API。

### 6.2 默认关闭与懒加载

默认：

```text
MAZEBENCH_ENABLE_PRIME=0
syncPrimeEvaluations=false
```

只有显式启用时才允许 `require()` Prime integration。默认启动必须满足：

- 不执行 `prime --version`；
- 不执行 `prime inference models`；
- 不读取 `~/.prime/config.json`；
- 不读取 `PRIME_API_KEY` 等凭证；
- 不创建 Prime sync worker；
- 不加载 Prime harness catalog；
- 不注册 Prime mutation endpoint。

### 6.3 服务端拆分

从 `server/agent-runs.js` 抽离：

- Prime model/harness compatibility；
- Prime model catalog；
- Prime evaluation metadata；
- Prime sync/create/stop；
- Prime sandbox cleanup；
- Prime resume；
- Prime live usage/results 读取；
- Prime-specific launch command 构造。

通用的 Codex、Claude、Kimi artifact 解析和 Agent run 展示留在核心。Prime parser 移到 integration；如果历史 Prime run 仍需只读展示，可以提供一个不调用 Prime CLI 的 `legacyPrimeArtifactReader`，与主动执行能力分开。

### 6.4 UI 与 API capability 化

服务端向页面提供 capability：

```json
{
  "capabilities": {
    "external_play": true,
    "local_mcp": true,
    "prime_integration": false
  }
}
```

当 `prime_integration=false`：

- 不显示 Prime provider；
- 不请求 Prime 模型目录；
- 不显示 Prime login 提示；
- 不显示 Prime sync、hosted eval、sandbox cleanup 操作；
- Prime 专用 API 返回 `404` 或稳定的 `INTEGRATION_DISABLED`，不得尝试执行 CLI。

### 6.5 Python CLI 拆分

默认 `mazebench --help` 聚焦：

- `launch/status/stop/restart`；
- `mcp`；
- `ascii/json/play`；
- `replay`。

`mazebench prime` 有两种可选落地方式：

1. 推荐：由独立可选包/entry point 注册，例如 `mazebench-prime`；
2. 过渡方案：核心保留命令壳，但仅在 `MAZEBENCH_ENABLE_PRIME=1` 时懒加载 integration，否则返回“可选集成未启用”，且默认帮助不展示。

不再用“本地 agent 已退役，只能走 Prime”作为核心 CLI 的产品描述；External Play + 本地 MCP 是默认受支持路径。

### 6.6 `maze-agent-local.js` provider 拆分

将 Prime Inference 特有逻辑从通用 local agent runtime 移出：

- `prime_intellect` model provider 配置；
- `prime-auth.js`；
- Prime credential file mount；
- Prime inactivity/retry 行为；
- Prime config validation。

通用 runner 只接收中性的 provider adapter。External Play 不使用该 runner，因此此拆分不得改变 MCP 游戏工具协议。

### 6.7 打包拆分

Core wheel/runtime 默认不包含：

- `maze-prime-run.js`；
- `maze-prime-live-eval.py`；
- `prime-create-evaluation.js`；
- Prime harness catalog；
- Prime eval configs；
- Prime environment lockfile；
- Prime credential helper。

`environments/mazebench` 作为 Prime Environment 保留独立发布生命周期，不再是 Core 本地运行的必要目录。Core Python runtime 由 `build-python-runtime.js` 从核心文件清单生成。

`pyproject.toml` 的项目描述、注释和默认文档不再把 Prime 作为核心运行方式。Prime extra 可在独立集成包稳定前暂时保留，但核心安装和运行不得依赖它。

### 6.8 CI 拆分

Core CI 必须在未安装 Prime CLI、没有 `.prime` 和 `PRIME_*` 环境变量的环境中运行：

- engine tests；
- External Play service tests；
- MCP stdio tests；
- browser spectator tests；
- Python CLI tests；
- wheel smoke；
- runtime drift；
- remote security。

Prime integration 使用独立 job/workflow：

- 仅 Prime 相关路径变化时运行；
- 单独安装依赖；
- 测试 adapter、runner、resume、sync 和 environment packaging；
- 不阻塞纯 External Play/Core 修改，除非修改了 integration contract。

## 7. 预计文件范围

### 7.1 P0 直接修改

- `server/external-play.js`
- `server/router.js`
- `server/pages.js`
- `public/external-play.js`
- `mazebench_cli/__init__.py`
- `tests/external-play-service.test.js`
- `tests/external-play-browser.test.js`
- `tests/remote-security.test.js`
- `tests/test_mazebench_cli.py`
- 对应 packaged runtime mirror

### 7.2 P1 主要修改/新增

- `server/app.js`
- `server/agent-runs.js`
- `server/token-usage.js`
- `server/prime-resume.js`
- `scripts/maze-agent-local.js`
- `scripts/maze-prime-run.js`
- `scripts/maze-prime-live-eval.py`
- `scripts/prime-create-evaluation.js`
- `mazebench_cli/__init__.py`
- `scripts/build-python-runtime.js`
- `scripts/sync-runtime.js`
- `pyproject.toml`
- `package.json`
- `.github/workflows/ci.yml`
- 新增 `server/integrations/prime/` 或等价独立模块目录
- Prime 专用测试和文档

实际实施前应再次用 `rg` 生成 Prime 引用清单，避免遗漏配置、文案、图片和 runtime mirror。

## 8. 测试计划

### 8.1 本地鉴权与 run 生命周期

必须新增或修改以下测试：

1. 无 cookie、无 nonce 的同源 loopback 页面可创建 run；
2. 无 cookie 可取消 run；
3. 无 cookie 可申请绑定 run 的 Viewer token；
4. snapshot/SSE/summary 没有 Viewer token 仍然失败；
5. 未授权 MCP controller 仍然失败；
6. cross-site Origin 请求失败；
7. 非 loopback peer 请求失败；
8. 非 JSON mutation 失败；
9. `duration_min=1` 的 UI 操作最终写入 `duration_ms=60000`；
10. 未 claim 的 `armed` run 可以原子替换；
11. 已 claim/active run 不可替换；
12. MCP claim 与网页替换竞态只有一个胜者；
13. 服务重启后不依赖旧 cookie，也能直接打开页面；
14. launcher 的 foreground/background/already-running 分支打开一致 URL。

### 8.2 Prime 零依赖验证

在测试进程中显式清除：

```text
PATH 中的 prime
PRIME_API_KEY
PRIME_CONFIG_PATH
PRIME_CONTEXT
MAZEBENCH_ENABLE_PRIME
```

验证：

- `mazebench launch` 成功；
- `mazebench mcp` 完成 initialize、tools/list 和 tools/call；
- External Play 创建、游玩、结算、replay 成功；
- 默认 Agent 页面不会执行 Prime catalog probe；
- 默认服务器进程不存在 Prime child process；
- Core wheel smoke 不需要 Prime package；
- Prime 专用模块未被载入 `require.cache`/Python import graph。

### 8.3 回归命令

```powershell
npm run test:pr
npm test
npm run test:browser
node tests/external-play-service.test.js
node tests/maze-external-mcp.test.js
node tests/remote-security.test.js
node tests/runtime-drift.test.js
python -m unittest tests/test_mazebench_cli.py
git diff --check
```

如 Windows native sandbox 仍因缺少提权后端而跳过，必须继续标记为平台限制，不能把 skip 声称为真实 sandbox 通过。

## 9. 交付顺序

### Change Set A：本地 External Play 可用性

1. 删除 Admin cookie/nonce 链路；
2. 修正 duration API；
3. 实现默认 `armed` run 的安全替换；
4. 统一 launcher URL；
5. 完成安全、服务和 browser 回归。

该变更集不改 Prime 代码，便于快速解决当前阻塞。

### Change Set B：Prime 逻辑解耦

1. 定义 integration contract；
2. 抽离 Prime server/runner/parser；
3. 默认关闭并懒加载；
4. capability 化 UI/API；
5. CLI、打包和 CI 拆分；
6. 完成无 Prime 环境验收。

### Change Set C：可选的彻底删除

在 Change Set B 稳定后，由项目所有者决定：

- 保留可选 Prime integration；或
- 删除 Prime runner、environment、configs、文档、测试和 lockfile 依赖。

未经确认不执行 Change Set C，因为这会移除现有官方评测与环境发布能力。

## 10. 最终验收标准

全部满足才视为本计划完成：

1. 新浏览器直接打开 `/external-play`，不需要 cookie、nonce 或特殊 URL；
2. 创建、观看、取消、总结和 replay 正常；
3. 页面时间限制与最终 manifest/deadline 一致；
4. 默认 `armed` run 不再导致用户无法配置新场次；
5. 远程、跨站、非 JSON 请求仍 fail-closed；
6. MCP controller token、lease 和 benchmark isolation 没有放宽；
7. 未安装 Prime CLI 的机器可以运行完整本地 MCP/网页观战链路；
8. 默认启动不探测、不读取、不执行任何 Prime 资源；
9. Core 打包和 CI 不依赖 Prime；
10. 若保留 Prime integration，其测试和发布生命周期与 Core 明确分离；
11. source runtime、packaged runtime 和测试镜像通过 drift 检查；
12. 不修改、不提交或删除工作区中与本计划无关的现有改动。

## 11. 非目标

- 不实现远程 MCP、HTTP MCP 或公网 spectator；
- 不增加模型网关、模型 API 管理或 token 账本；
- 不托管 Gemini、Codex、Claude Code 等外部 CLI；
- 不采集模型思考过程；
- 不恢复 shell、宿主文件或仓库访问；
- 不把 External Play run 纳入正式 benchmark、排行榜或 Prime Eval；
- 本计划不自动执行 git commit、push、PR、release 或部署。
