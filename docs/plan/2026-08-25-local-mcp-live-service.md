# 本地 MCP 实时观战与总结功能改造方案

> 日期：2026-08-25
>
> 状态：待实施
>
> 产品名称：External Play — Local MCP（外部试玩，本地 MCP，未验证）

## 1. 结论

本功能直接增量修改 MazeBenchEngine，不新建模型网关、CLI Runner 或独立观测平台。

用户手动启动现有 MazeBench 本地服务后，本地 CLI 或桌面端通过 `stdio` MCP 调用游戏工具；MazeBench 服务持有权威游戏会话，把每次 MCP 动作实时推送到浏览器，并复用项目现有 `/play` 3D runtime 展示游戏过程。会话只在以下两种正常条件下结束：

1. 达成引擎现有通关条件；
2. 达到创建会话时设定的 wall-clock 时间上限。

结束后，同一页面切换为总结视图，显示路线、gems、rooms、actions、耗时、结束原因和回放入口。

该模式不托管外部 CLI，不采集 CLI stdout、模型思考、token 或费用，也不要求 Docker。

## 2. 目标与非目标

### 2.1 目标

- 继续使用现有 `mazebench launch`/Node 服务，由用户手动启动和停止。
- 新增 `mazebench mcp` 本地 `stdio` MCP 入口，供 Codex、Claude Code、桌面端及其他支持本地 MCP 的客户端调用。
- MCP 和网页观看端连接到同一个服务端游戏会话，不产生两份互相独立的游戏状态。
- 复用当前项目已经具备的 3D 画面、材质、动画、镜头和房间切换能力。
- 每个已接受动作在持久化后立即推送到观看页；不再使用 1.5 秒轮询作为实时主通道。
- 支持浏览器刷新、SSE 断线重连和服务重启后的动作重放恢复。
- 通关或超时后只结算一次，并保存可重复打开的总结。
- 保留当前正式 Agent/Evaluation 路径的隔离边界，不因本功能放宽任何正式 benchmark 规则。

### 2.2 P0 非目标

- 不实现远程 MCP、Streamable HTTP MCP 或公网访问。
- 不实现模型 API 网关、模型目录、模型请求日志、token/费用统计。
- 不启动、停止或监控外部 CLI 进程。
- 不采集外部 CLI 的 stdout、stderr、会话文件或模型推理内容。
- 不提供 `python_exec`、shell、文件或网络工具。
- 不支持多个 CLI 同时控制同一会话。
- 不把 External Play 结果加入正式 Agent 列表、Prime Eval、MazeJam 排行或模型 benchmark 聚合。
- P0 的模型观测先支持现有 ASCII/Text 与 JSON；Vision MCP 作为后续扩展。

## 3. 当前项目可直接复用的基础

| 现有能力 | 当前文件 | 本方案用法 |
| --- | --- | --- |
| 本地网站进程与 `launch/status/stop/restart` | `server.js`、`mazebench_cli/__init__.py` | 继续作为唯一需要手动启动的服务 |
| 权威 JavaScript 游戏规则 | `public/maze-engine.js` | 不重写游戏规则 |
| 图二所示 3D runtime | `public/play-core.js`、`public/play-render-three.js`、`public/play-gameplay.js`、`public/play.js` | 新增只读 spectator 宿主模式 |
| 持久游戏桥 | `scripts/maze-bridge.js` | 每个 External Play run 建立一个常驻内存 session |
| 本地 stdio MCP 基础 | `scripts/maze-mcp-server.js` | 复用协议处理、sanitization 和工具语义，抽出 External Play adapter |
| 会话与动作格式 | `scripts/codex-play.js` 的 `session.json`、`actions.jsonl` | 保持兼容的动作记录，并补充 External Play 元数据 |
| 计分结构 | `scripts/maze-terminal.js`、`scripts/maze-bridge.js` | 结算时复用 gems、rooms、tiles、actions、elevation 统计 |
| 回放动作分派 | `scripts/maze-export-replay.js` | 复用 move、camera、undo、reset、goto 的浏览器动作语义 |
| 世界路线、探索曲线组件 | `public/agent-run.js` | 提取最小共享逻辑用于总结页，不复用 Agent 页整体 |

现有 Agent Run 实时区域主要展示图片、ASCII 或 bitmap，并通过轮询刷新，不是图二所示的原生 3D runtime。因此 External Play 应新建 spectator 页面并复用 `/play`，不应直接把现有 Agent Run 页面改成新的观看页。

## 4. 目标使用流程

### 4.1 启动服务

```powershell
mazebench launch
```

现有服务启动后，首页增加 `External Play` 入口。用户进入页面后创建一局，填写：

- 起始关卡；
- 模型观测模式：`text` 或 `json`；
- 时间上限，默认 30 分钟，后端允许 60～21600 秒；
- 可选的 CLI 名称；
- 可选的模型名称。

CLI 和模型名称只是用户声明值，分别保存为 `declared_cli` 和 `declared_model`，不表示服务验证过真实执行身份。

创建后会话进入 `armed`，页面显示等待 MCP 控制器连接。计时此时尚未开始。

### 4.2 配置本地 MCP

Codex TOML 示例：

```toml
[mcp_servers.mazebench]
command = "mazebench"
args = ["mcp"]
```

Claude Desktop/通用 JSON 示例：

```json
{
  "mcpServers": {
    "mazebench": {
      "command": "mazebench",
      "args": ["mcp"]
    }
  }
}
```

`mazebench mcp` 执行以下工作：

1. 优先读取开发时显式提供的 `MAZEBENCH_SERVER_URL` 和 `MAZEBENCH_LOCAL_MCP_TOKEN`，其次读取现有 `~/.mazebench/server.json`，定位当前手动启动的 MazeBench 服务；
2. 读取服务启动时生成的本地 controller token；
3. 在 stdout 上提供纯 `stdio` MCP JSON-RPC；
4. 通过 loopback-only 内部 API 把 MCP 请求转发给 MazeBench 服务；
5. 把诊断信息只写到 stderr，绝不污染 MCP stdout。

如果 MazeBench 服务尚未启动，`mazebench mcp` 应快速失败并提示先执行 `mazebench launch`，不得静默启动另一套游戏引擎。

### 4.3 开始与观看

- CLI 首次调用 `start` 时认领当前 `armed` 会话。
- 服务把会话切换为 `active`，记录 `started_at` 和 `deadline_at`，此时才开始计时。
- 每个动作由服务端串行执行、落盘，然后通过 SSE 推送到观看页。
- 观看页使用现有 3D runtime 播放完全相同的动作和镜头变化。
- CLI 退出或 MCP stdio 断开不会提前结算；会话继续等待重连，直到通关或时间到。

### 4.4 结束与总结

- 收到引擎的 `game_won=true` 后结算为 `won`。
- 到达 `deadline_at` 后结算为 `timed_out`。
- 用户可以在网页中丢弃异常会话，但 `cancelled` 属于管理状态，不算正常成绩。
- 结束后所有 mutation tool 被拒绝；`start` 和 `observe` 仍可返回最终只读状态。
- 观看页自动切换为总结视图，刷新页面后总结仍然存在。
- 服务结束的是 MazeBench game run，不会也无法强制关闭外部 Codex、Claude Code 或桌面端任务。

## 5. 总体架构

```text
Codex / Claude Code / 桌面端 / 其他本地 CLI
                    │
                    │ stdio MCP
                    ▼
            mazebench mcp adapter
                    │
                    │ loopback internal API + controller token
                    ▼
┌─────────────────────────────────────────────────────────┐
│ 现有 MazeBench Node 服务（mazebench launch）             │
│                                                         │
│ ExternalPlayService                                    │
│   ├─ 单个非终态 run / 单 controller                      │
│   ├─ per-run 串行队列与请求去重                          │
│   ├─ 常驻 maze-bridge session                           │
│   ├─ wall-clock deadline                                │
│   ├─ actions.jsonl / session.json / summary.json        │
│   └─ SSE event stream                                   │
│                          │                              │
│                          ▼                              │
│              现有 /play 3D runtime 的 spectator 模式     │
└─────────────────────────────────────────────────────────┘
```

### 5.1 权威状态边界

- 服务端 `ExternalPlayService` 中的 `maze-bridge` session 是运行时权威状态。
- `actions.jsonl` 是崩溃恢复和回放的权威持久记录。
- 浏览器只重放动作并展示，不向服务端提交移动、镜头、undo、reset 或 goto。
- 浏览器状态是视觉镜像，不作为 MCP 返回值或结算依据。
- 服务端先持久化动作，再发布 SSE，再返回成功结果，避免页面展示尚未落盘的动作。

“游戏状态只经 MCP 修改”在 External Play 中是应用支持的正常调用约定，而不是可证明的安全隔离：外部 CLI 与服务处于同一用户主机权限下，因此该结果永久为 unverified。

## 6. External Play 与正式 Agent 的边界

该功能固定命名为：

```text
External Play — Local MCP (Unverified)
外部试玩（本地 MCP，未验证）
```

每个 run 必须由服务端写入且不允许客户端覆盖：

```json
{
  "run_kind": "external_play",
  "execution_class": "external-unverified",
  "verification_status": "unverified",
  "benchmark_eligible": false,
  "isolation_profile": "user-managed-host",
  "result_scope": "local-debug",
  "controller_origin": "external-mcp"
}
```

约束如下：

- run ID 使用 `ext-` 前缀。
- 产物使用独立目录 `outputs/maze-external/<run-id>/`。
- External Play 不进入 `outputs/maze-local/site`，避免被现有 Agent 扫描、收藏或同步。
- UI 与导出内容显示 `External / Unverified / Not a benchmark result` 标识。
- 不允许把 External Play run 在结束后“升级”为正式结果。
- 正式结果必须在现有隔离 Agent 模式中重新运行。
- 不修改现有 Agent launcher、Docker、fresh workspace、工具隔离或 fail-closed preflight。

本模式可以与正式 Agent 共享游戏 runtime、公开 observation、工具 schema、动作格式和展示组件，但不能共享 run 资格、排行榜、Prime sync、continue/branch transcript 或 credential/env。

## 7. 本地 MCP 设计

### 7.1 P0 传输

P0 只对客户端提供 `stdio` MCP：

- 客户端启动 `mazebench mcp`；
- adapter 自身不持有游戏状态；
- adapter 不直接读写 run 文件；
- adapter 只连接由 `mazebench launch` 启动的 loopback 服务；
- 暂不把内部 loopback endpoint 宣传为远程 MCP；
- 暂不实现 Streamable HTTP MCP。

这样可以覆盖大多数本地 CLI/桌面端，同时保证网页和 CLI 操作的是同一局。

### 7.2 P0 工具集

工具名称对齐当前 `mazebench-tools` named controls：

| 工具 | 参数 | 是否消耗 action | 说明 |
| --- | --- | --- | --- |
| `start` | `{}` | 否 | 认领并开始当前 armed 会话；重复调用幂等 |
| `observe` | `{}` | 否 | 返回当前 sanitized observation |
| `up` / `down` / `left` / `right` | `{}` | 是 | 屏幕相对移动 |
| `rotate_camera_up/down/left/right` | `{}` | 是 | 调整 pitch/yaw |
| `undo` | `{}` | 是 | 沿用当前游戏撤销语义 |
| `reset` | `{}` | 是 | 恢复当前房间进入时状态 |
| `go_to_level` | `{ "x": "H", "y": "I" }` | 是 | 只能前往已访问房间 |

P0 不暴露：

- `quit`：正常结束条件固定为通关或超时；
- `action_sequence`：先保证单动作实时观战、顺序和动画一致；
- `python_exec`：与当前需求无关；
- 任意 shell、文件、网络或 scorecard 工具。

内部统一把 named tool 转成当前 `maze-bridge` 命令：

```text
up                    -> { command: "move", direction: "up" }
rotate_camera_left    -> { command: "rotate_camera", direction: "left" }
reset                 -> { command: "reset_level" }
go_to_level(H, I)     -> { command: "goto_level", x: "H", y: "I" }
```

### 7.3 工具响应

继续采用当前工具集的统一响应形状，并增加 External Play 的时间信息：

```json
{
  "observation": {},
  "actions_used": 12,
  "actions_remaining": null,
  "time_limit_seconds": 1800,
  "time_remaining_seconds": 1427,
  "ended": false,
  "end_reason": "",
  "verification_status": "unverified",
  "error": ""
}
```

要求：

- MCP 只返回 sanitized observation。
- `_render_state`、精确 viewer checkpoint、scorecard、controller token、run 文件路径和源码路径不得出现在 MCP 返回值中。
- 模型观测模式在创建 run 时固定，运行中不能通过参数切换。
- 终态后的 mutating tool 返回明确错误和最终 `ended/end_reason`，不能再次改变状态。

### 7.4 串行与幂等

- 每个 run 只有一个 mutation queue。
- P0 同一服务同时只允许一个 `armed` 或 `active` run；历史终态 run 可以继续只读查看。
- `start`、`observe` 和所有动作都在同一会话锁内读取状态。
- 每个 controller 连接生成 `controller_session_id`。
- 使用 `(controller_session_id, JSON-RPC request.id)` 做请求去重。
- 同一请求重试返回已持久化的原响应，不得再次移动。
- 第二个 controller 尝试认领活动 run 时返回冲突，不进行抢占。

## 8. 会话状态机与结束条件

### 8.1 状态机

```text
created -> armed -> active -> finalizing -> won
                                  └──────-> timed_out

created/armed/active -> cancelled   # 用户丢弃，不算正常成绩
任意非终态          -> failed       # 服务或游戏不可恢复错误
```

`won`、`timed_out`、`cancelled` 和 `failed` 都是终态。P0 不使用 CLI 进程退出作为结束条件。

### 8.2 通关

- 通关判断只读取 `maze-bridge` 的 canonical `game_won`。
- 当前全局胜利阈值继续沿用 100 个唯一 gems，不在 External Play 中另造规则。
- 赢下本局的动作完整落盘后，进入 `finalizing`。
- trusted 服务生成一次最终统计和 `summary.json`，随后进入 `won`。

### 8.3 超时

- 默认 `time_limit_seconds=1800`。
- `deadline_at` 在第一次成功 `start` 时固定为 `started_at + time_limit_seconds`。
- 使用 monotonic clock 驱动当前进程定时，同时持久化 wall-clock `deadline_at` 供重启恢复。
- 每个 mutation 开始前检查 deadline；已超时则不执行动作并排队结算。
- deadline 到来时，如果一个动作已经取得锁并开始执行，允许该动作在原子边界完成；该动作若通关则结果为 `won`，否则随后结算为 `timed_out`。
- timeout finalization 与动作使用同一队列，保证只执行一次。
- 服务重启后若发现 `deadline_at` 已经过期，应在接受新动作前恢复并结算为 `timed_out`。

### 8.4 断开与异常

- CLI/MCP 断开只更新 controller 在线状态，计时继续。
- 浏览器断开不影响游戏。
- controller 重连后可继续认领同一活动 run，但不得重放未确认的 action；请求去重记录负责判断。
- `player_dead` 不作为本方案新增的自动结束条件；沿用当前游戏语义，CLI 仍可通过允许的 `undo`、`reset` 或 `go_to_level` 恢复。
- 游戏 session 无法从 `actions.jsonl` 恢复时进入 `failed`，不得伪造成 timeout 或 completed。

## 9. 持久化与恢复

每个 run 使用独立目录：

```text
outputs/maze-external/ext-<timestamp>-<random>/
  manifest.json
  session.json
  actions.jsonl
  events.jsonl
  viewer-state.json
  summary.json            # 终态后生成
```

### 9.1 `manifest.json`

创建后不可修改，至少包含：

- schema version；
- run ID 与 `external_play` 固定标签；
- game/level/observation mode；
- time limit；
- `declared_cli`、`declared_model`；
- runtime version；
- world digest；
- tool manifest version；
- `benchmark_eligible=false`。

### 9.2 `session.json`

使用临时文件加原子 rename 更新，至少包含：

- lifecycle status；
- started/deadline/ended 时间；
- controller 在线状态；
- last committed sequence；
- actions count；
- last sanitized status；
- end reason；
- summary 是否已写入。

### 9.3 `actions.jsonl`

作为权威 WAL，每条至少包含：

```json
{
  "schema_version": 1,
  "seq": 12,
  "turn": 12,
  "request_id": "37",
  "timestamp": "2026-08-25T12:00:00.000Z",
  "tool": "up",
  "command_text": "up",
  "message": { "command": "move", "direction": "up" },
  "valid": true,
  "error": null,
  "accepted": true,
  "status": {},
  "viewer": {
    "current_room": "level_HxI",
    "player": { "x": 4, "y": 7, "elevation": 0 },
    "pitch": 1,
    "yaw": 0,
    "state_hash": "..."
  }
}
```

该结构是现有 `turn/timestamp/command_text/message/status` action schema 的兼容超集，以便继续使用当前 replay/exporter。模型只能得到 `status` 的 sanitized 结果，不能通过 MCP 读取整个 action record 或 `viewer` 字段。

提交顺序：

1. 在内存 session 执行动作；
2. 构造 action record；
3. append `actions.jsonl`；
4. 原子更新 `session.json`；
5. 更新最新 `viewer-state.json`；
6. 发布 SSE；
7. 返回 MCP 成功响应。

服务重启时从 `manifest.json` 创建新 `maze-bridge` session，按 `actions.jsonl` 顺序 fast replay，并校验最后的 room、gem count 和 state hash。恢复成功后才允许 MCP 重新控制。

### 9.4 `summary.json`

终态后只生成一次，至少包含：

- 固定 unverified 标签；
- `won` 或 `timed_out`；
- 开始、结束和 wall-clock elapsed；
- gems collected/total；
- rooms visited/total；
- tiles visited；
- actions total 及分类；
- 起点、终点、访问房间顺序；
- 每个 action 的累计 gems/rooms 进度点；
- declared CLI/model；
- runtime/world/tool manifest 版本信息。

External Play 不生成 `results.jsonl`，避免被误认为正式 eval 结果。

## 10. Web 实时观看页

### 10.1 页面路由

```text
GET /external-play
GET /external-play/:runId
```

- `/external-play`：创建表单、当前 active run、历史 External runs。
- `/external-play/:runId`：同一地址承载等待、实时观看和结束总结。

首页增加一个独立的 `External Play` mode card，不把它放进现有 Agent launch 表单。

### 10.2 复用现有 3D runtime

`server/pages.js` 抽出 `/play` 与 spectator 共用的 play-stage/runtime markup，并新增 spectator 参数：

```json
{
  "externalSpectator": true,
  "ignoreSavedGemProgress": true,
  "hostOwnsWorldMapNavigation": true
}
```

spectator 模式要求：

- 继续加载 `play-core.js`、`play-render-three.js`、`play-gameplay.js`、`play.js` 等现有文件；
- 隐藏 Edit、Undo、Reset、d-pad、camera pad 和 solver 等人工控制；
- 设置 `window.__MAZEBENCH_INPUT_LOCKED__=true`；
- `play.js` 在 spectator 模式不绑定键盘、鼠标、触摸、手柄或 solver；
- 新增受支持的 browser host controller，统一应用 move、camera、undo、reset 和 goto；
- 页面只更新自己的浏览器镜像，不向服务端发送游戏动作。

当前 `window.__MAZEBENCH_APP__` 可帮助实现该 adapter，但正式代码应提供最小稳定接口，不让 spectator 长期依赖调试字段。

### 10.3 动作同步

新增：

```text
GET /api/external-play/runs/:runId/snapshot?after_seq=N
GET /api/external-play/runs/:runId/events
```

`events` 使用 SSE：

- `snapshot`：连接后的当前状态与 latest sequence；
- `action`：一个已持久化动作；
- `controller`：MCP controller 在线状态；
- `deadline`：剩余时间更新；
- `ended`：终局与 summary URL；
- 每 15 秒发送 heartbeat comment；
- 支持 `Last-Event-ID`/`after_seq` 断点续传。

浏览器动作队列必须 FIFO：前一个动画 settle 后才播放下一个动作。初次进入或刷新时先无动画 fast-forward 到最新 sequence，再开始播放新动作。若 sequence 缺口或 state hash 不一致，立即停止继续猜测，重新获取 snapshot/backlog。

实时验收目标：MCP 动作返回后，观看页在 1 秒内开始对应动画。

### 10.4 观看布局

主区域以当前图二的 3D canvas 为核心，不重新设计游戏画面。附加 UI 保持克制：

- 状态：Waiting / Live / Won / Timed out；
- 剩余时间；
- 当前 actions、gems、rooms；
- controller 在线状态；
- 最近一个 tool action；
- External / Unverified 标识。

## 11. 结束总结页

结束后保留同一路由，将 3D 区域切换为图一风格的总结卡与 replay 控制。

### 11.1 总结卡字段

- 路线/已访问世界地图缩略图；
- `declared_model` 与 `declared_cli`，UI 明确加“声明”标识；
- 结果：通关或超时；
- 通关进度：`min(100, collected_gems / 100 * 100%)`；
- gems collected/total；
- rooms visited/total；
- actions；
- elapsed time；
- 累计 gems/rooms sparkline；
- `External / Unverified / Not a benchmark result`。

不显示 token、费用或模型思考。以后若客户端主动上报 usage，也必须标记来源和 `usage_exact`，不能冒充服务端测量值。

### 11.2 回放

- P0 使用同一个 spectator runtime 按 `actions.jsonl` 回放；
- 支持播放、暂停、单步和进度拖动；
- 不要求 P0 自动生成 MP4；
- 后续可以复用 `maze-export-replay.js` 导出视频，但 External 标签必须进入导出元数据和画面水印。

## 12. 服务端 API

浏览器管理 API：

```text
GET    /api/external-play/runs
POST   /api/external-play/runs
GET    /api/external-play/runs/:runId
POST   /api/external-play/runs/:runId/cancel
GET    /api/external-play/runs/:runId/snapshot
GET    /api/external-play/runs/:runId/events
GET    /api/external-play/runs/:runId/summary
```

adapter 内部接口：

```text
POST /api/external-play/mcp
```

内部接口接收 MCP JSON-RPC 请求并返回 JSON-RPC 响应，但 P0 只由 `mazebench mcp` adapter 使用，不作为公开远程 MCP endpoint。

安全默认值：

- 继续复用当前 router 的 loopback Host、TCP peer、same-origin 和 JSON Content-Type 校验；
- controller API 额外要求 256-bit 随机 token；
- token 每次 MazeBench 服务启动时轮换；
- token 保存于 `~/.mazebench/server.json`，尽力设置为仅当前用户可读；
- token 不出现在页面 HTML、SSE、MCP tool result、run artifact 或日志；
- 每个 run 另生成只读 viewer capability，只交给同源观看页并保存在 `sessionStorage`；snapshot/SSE 不接受 controller token，也不允许 viewer capability 调用 mutation；
- viewer capability 和 controller token 都不进入模型可见 observation，日志必须做脱敏；
- 每次只允许一个 controller session；
- 不启用 CORS；
- P0 不支持 `0.0.0.0`、LAN 或远程 controller。

## 13. 文件级改造清单

### 13.1 新增文件

| 文件 | 职责 |
| --- | --- |
| `server/external-play.js` | run 创建、状态机、常驻 game session、动作 WAL、deadline、结算、SSE subscriber |
| `scripts/maze-external-mcp.js` | 本地 stdio MCP adapter；读取 server state 并转发 JSON-RPC |
| `public/external-play.js` | 创建/列表/观看/总结页面控制逻辑和 SSE 客户端 |
| `public/external-play-host.js` | 把 External action FIFO 映射到现有 3D runtime，负责 fast-forward、动画 settle 和一致性检查 |
| `public/external-play.css` | 观看状态条、总结卡、路线图和响应式布局 |
| `tests/external-play-service.test.js` | 状态机、超时、持久化、恢复、串行和幂等测试 |
| `tests/maze-external-mcp.test.js` | stdio initialize/list/call、服务缺失、stdout 纯净和 token 测试 |
| `tests/external-play-page.test.js` | 路由、静态来源、spectator input lock、SSE 与总结源测试 |

### 13.2 修改文件

| 文件 | 修改内容 |
| --- | --- |
| `mazebench_cli/__init__.py` | 增加 `mazebench mcp`；读取服务状态并启动 Node adapter |
| `server.js` | 生成/保存当前服务的 local MCP controller token，并在退出时清理 |
| `server/app.js` | 实例化 `ExternalPlayService`、注册新静态资源并注入 router/pages |
| `server/router.js` | 增加 `/external-play`、管理 API、SSE 和内部 MCP endpoint |
| `server/pages.js` | 增加 External 页面；抽取 play-stage/runtime 共用 markup；首页增加入口 |
| `public/play.js` | spectator 模式不绑定人工输入；暴露最小 host control API |
| `public/play-gameplay.js` | 如 host API 需要，补充明确的 action settle promise，不改变普通 Play 行为 |
| `scripts/maze-mcp-server.js` | 抽取并共享 tool schema/sanitization；保持现有 Agent MCP 行为不变 |
| `scripts/maze-bridge.js` | 仅补充 External service 所需的稳定 snapshot/hash 接口；不修改游戏规则 |
| `scripts/sync-runtime.js` | 把新增 server/scripts/public 文件加入 PyPI runtime |
| `package.json` | 将新增测试加入 `npm test`/`test:pr`；可增加开发用 MCP script |
| `README.md` | 增加 External Play 的启动、MCP 配置和 unverified 边界说明 |

如果实现中可以完全通过 `window.__MAZEBENCH_APP__` 和现有 `maze-bridge` exports 完成，优先减少对 `play-gameplay.js` 与 `maze-bridge.js` 的修改；但必须为 spectator 添加正式测试覆盖，不能只依赖偶然可用的调试字段。

## 14. 实施顺序

### Phase 0：本地 MCP 与单会话闭环

1. 新增 `ExternalPlayService` 和独立 run 目录。
2. 实现 create/arm/start/action/observe/timeout/finalize 状态机。
3. 实现 `mazebench mcp` stdio adapter。
4. 对齐 named tool contract 和 sanitized result。
5. 实现动作串行、request ID 去重和崩溃恢复。
6. 提供最小 External 页面，能创建 run、显示 controller 和文本状态。

完成条件：本地 Codex/Claude Desktop 可以通过 `mazebench mcp` 操作同一个服务端会话；通关或短时限测试均能产生 `summary.json`。

### Phase 1：现有 3D runtime 实时观战

1. 抽取 `/play` 共用 stage/runtime markup。
2. 增加 spectator input lock 与 host action adapter。
3. 实现 snapshot/backlog/SSE。
4. 实现浏览器 fast-forward、FIFO 动画和断线恢复。
5. 验证 move、blocked move、camera、gem、undo、reset、房间切换和 goto。

完成条件：每个 MCP 动作在 1 秒内开始对应 3D 动画，浏览器最终状态与服务端 action record 一致。

### Phase 2：总结、回放与打包

1. 实现图一风格的总结卡、世界路线和进度曲线。
2. 实现浏览器 replay 控件和 summary JSON 下载。
3. 增加 Codex/Claude Desktop 配置片段。
4. 更新 bundled runtime、wheel smoke 和 Windows 路径测试。
5. 补充文档与 External/Unverified 防混入测试。

完成条件：安装后的 `mazebench launch` + `mazebench mcp` 可以完成创建、游玩、实时观看、超时/通关结算和刷新后回放全流程。

## 15. 测试计划

### 15.1 单元测试

- `armed -> active -> won`。
- `armed -> active -> timed_out`，使用 fake clock，避免真实等待。
- deadline 与正在执行动作竞争时只 finalize 一次。
- timeout 前已取得锁的最后动作完整落盘。
- `start` 幂等且不会重置 deadline。
- `observe` 不消耗 action。
- 终态后所有 mutation 被拒绝。
- 单 controller、第二 controller 冲突。
- 相同 JSON-RPC request ID 不重复移动。
- sanitization 删除 `_render_state`、scorecard、token、路径和私有状态。
- External 固定标签无法被 create payload 覆盖。
- run ID/path traversal 校验。
- action WAL 重放后的 room、gems 和 state hash 一致。

### 15.2 MCP 集成测试

- `initialize`、`tools/list`、`tools/call` 完整握手。
- 工具名称与 canonical manifest 一致。
- 服务未启动时快速失败并输出可操作提示。
- stdout 只包含 MCP JSON-RPC，日志只进 stderr。
- `start` 认领 armed run；没有 armed run 时返回明确提示。
- CLI 断开后 run 仍保持 active，计时继续。
- 重连后继续当前 run，不创建第二套引擎。

### 15.3 Web/SSE 测试

- 观看页没有可改变游戏的键盘、鼠标、触摸、手柄入口。
- 每个已持久化动作只发布一次。
- SSE reconnect 不重复或漏掉动作。
- 批量快速调用仍按 sequence FIFO 播放。
- 3D 状态覆盖 move、blocked move、camera、gem、undo、reset、跨房间和 goto。
- 浏览器刷新后 fast-forward 到最新 turn。
- state hash 不一致时触发重新同步而不是继续播放错误状态。
- timeout 无新动作时仍自动显示总结。
- 第 100 个 gem 后显示 won，总结只生成一次。

### 15.4 边界与回归测试

- External run 不出现在 `/agent` 列表。
- External run 不能 favorite、Prime sync、branch/continue 成正式 Agent run。
- External 目录不生成正式 `results.jsonl`。
- 现有 `maze-mcp-server.test.js`、Agent isolation、Prime harness、replay 与 engine tests 保持通过。
- PyPI bundled runtime 包含所有新增文件。
- Windows 下 `mazebench launch`、`mazebench mcp`、state/token 文件和进程退出清理正常。

## 16. 首个可交付版本验收标准

以下条件全部满足，才算本功能闭环：

1. 用户只需手动启动一次 `mazebench launch`。
2. Codex 或任意支持 stdio MCP 的桌面端可通过固定配置 `mazebench mcp` 连接。
3. CLI 和网页操作的是同一个服务端权威 session。
4. 网页复用现有 3D runtime，而不是逐步生成截图。
5. MCP 动作在 1 秒内开始在页面播放。
6. 浏览器刷新、SSE 重连和服务重启都能恢复到同一 action sequence。
7. 正常会话只因通关或 wall-clock timeout 自动结算。
8. CLI 断开不被误判为完成。
9. 结算后 summary 与权威动作记录中的 gems、rooms、actions 一致。
10. 页面和导出永久标记 External/Unverified，结果不会进入正式 benchmark 流程。
11. 不采集模型思考、CLI 日志、token 或费用。
12. 现有正式 Agent 隔离和测试没有被放宽或绕过。

## 17. 后续扩展顺序

只有 P0～P2 稳定后再考虑：

1. Vision MCP observation；
2. `action_sequence` 的逐动作实时发布；
3. 多个独立 External run 并发；
4. 标准 Streamable HTTP MCP；
5. LAN/远程观看的独立认证与 TLS；
6. MP4/GIF 导出；
7. 客户端主动上报且明确标注来源的 token usage。

这些扩展不得改变 External Play 的 unverified 属性；需要正式可比较结果时，仍应使用现有隔离 Agent/Evaluation 路径。
