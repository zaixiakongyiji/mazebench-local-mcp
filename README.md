# MazeBench Local MCP

MazeBench Local MCP 是基于 MazeBenchEngine 改造的本地游戏控制与实时观战版本。

本地 CLI 或桌面端（Gemini、Antigravity、Codex、Claude Code、Claude Desktop 等）通过 `stdio` MCP 控制同一套 MazeBench JavaScript 游戏引擎；浏览器实时显示 3D 游戏画面、动作时间线和当前状态，并在达到动作上限或场次结束后展示总结与回放。

该模式的核心特点：

- 模型由本地 CLI 或桌面端自行选择，不绑定 Prime Inference 模型目录；
- 不需要模型网关、Docker 或 Prime CLI；
- 不托管外部 CLI，也不采集模型思考过程、token 或费用；
- 游戏状态只能通过 MCP 工具修改；
- 网页只在本机 loopback 地址提供服务；
- External Play 结果作为普通 `EXTERNAL` 历史记录保存，可回放并参与本地全局排行榜；内部仍标记为不具备正式 benchmark eligibility。

当前维护仓库：[zaixiakongyiji/mazebench-local-mcp](https://github.com/zaixiakongyiji/mazebench-local-mcp.git)

## 环境要求

- Python 3.9+
- Node.js
- 支持本地 `stdio` MCP 的 CLI 或桌面端

可选：如果需要导出视频回放，还需要 Chromium 系浏览器和 `ffmpeg`。

## 安装

本仓库包含尚未进入上游 PyPI 版本的 Local MCP 功能，请从当前仓库安装，不要只执行 `pip install mazebench`。

```bash
git clone https://github.com/zaixiakongyiji/mazebench-local-mcp.git
cd mazebench-local-mcp
npm ci
python -m pip install -e .
```

安装后确认 CLI 来自当前源码：

```bash
mazebench help
```

帮助中应当包含：

```text
mazebench mcp
```

Windows 用户可以使用以下命令确认实际可执行文件路径：

```powershell
where.exe mazebench
```

如果 MCP 客户端无法从 `PATH` 找到 `mazebench`，请在 MCP 配置中填写 `where.exe mazebench` 返回的绝对路径。

## 启动本地服务

在当前源码仓库中前台启动：

```bash
npm run start
```

该命令直接运行当前仓库的 `server.js`，适合开发和本地调试。服务启动后需要手动打开终端输出的地址。

通过已安装的 `mazebench` CLI 前台启动：

```bash
mazebench launch
```

CLI 会运行其已安装 runtime 中的 `server.js`，并默认打开浏览器。需要后台运行时使用：

```bash
mazebench launch bg
```

默认会打开 External Play 页面：

```text
http://127.0.0.1:3000/external-play
```

如果端口被占用，MazeBench 会从指定端口开始自动寻找可用端口。实际地址以终端输出为准。

服务管理命令：

```bash
mazebench status
mazebench restart
mazebench stop
```

后台服务日志保存在：

```text
~/.mazebench/server.log
```

## 配置本地 MCP

MazeBench 服务和 MCP adapter 是两个独立进程：先在源码仓库运行 `npm run start`，或使用已安装的 CLI 运行 `mazebench launch`；再让 CLI 或桌面端启动 `mazebench mcp`。

### Gemini / Antigravity / Claude Desktop 等 JSON 配置

在对应客户端的 MCP 配置中加入：

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

Windows 上如果客户端继承不到终端的 `PATH`，建议使用绝对路径，例如：

```json
{
  "mcpServers": {
    "mazebench": {
      "command": "C:\\Users\\your-name\\miniconda3\\Scripts\\mazebench.exe",
      "args": ["mcp"]
    }
  }
}
```

修改配置后需要完全退出并重新启动 MCP 客户端，使其重新创建 MCP 进程。

### Codex 配置

在 `config.toml` 中加入：

```toml
[mcp_servers.mazebench]
command = "mazebench"
args = ["mcp"]
```

Windows 上同样可以把 `command` 替换为 `mazebench.exe` 的绝对路径。

## 开始一局

1. 在源码仓库执行 `npm run start`，或执行 `mazebench launch`。
2. 在浏览器打开 External Play 页面。
3. 创建单局、并发组或比赛组，并设置统一的游戏 actions 上限；运行组支持 2–8 个席位。
4. 启动或重启已经配置 MCP 的 CLI/桌面端。
5. 给每个模型指定名称，并发送统一初始提示词：`调用 MazeBench 的 start 工具，填写指定的 model_name，然后严格按照返回的 run_instructions 继续游戏。`（若需跨会话恢复先前未结束的对局，请让模型调用 `resume` 工具传入 `run_id` 并在网页控制台完成审批）。
6. 在浏览器中实时观看 3D 画面、动作记录、房间和 gems 状态。
7. 达到 actions 上限后，在同一页面查看总结和回放。

单局和运行组都必须先在 External Play 页面创建。单局保持独立历史；运行组为每个席位创建独立 run，并冻结相同地图、起点、预算和结束规则。`concurrent` 组只聚合结果，`competition` 组会在所有席位结束后额外保存本场排名快照；两种模式的子 run 都进入历史、回放和全局排行榜。

同一时间只允许一个运行组等待认领。全部席位被模型调用 `start` 认领后，即可创建下一组，即使上一组仍在游玩。模型名称由 `start` 的 `model_name` 参数登记，harness 自动取自 MCP initialize 的 `clientInfo.name`，无需在网页表单中填写。

## MCP 工具

当前提供 15 个工具：

- `start`
- `resume`
- `observe`
- `up`、`down`、`left`、`right`
- `rotate_camera_up`、`rotate_camera_down`
- `rotate_camera_left`、`rotate_camera_right`
- `undo`
- `reset`
- `go_to_level`
- `action_sequence`

### 认领与恢复规则

每个独立 MCP 客户端实例会自动与 External Play 服务协商独立的 controller 会话（`MAZEBENCH_LOCAL_MCP_TOKEN` 环境变量已废弃并被禁止使用）。

首次认领 armed 席位时调用 `start`：

```json
{
  "model_name": "gpt-5.6"
}
```

> **注意**：`start` 仅用于认领全新空闲席位，**严格拒绝**传入 `run_id` 参数。同一 controller 已绑定未结束的运行将拒绝认领新席位。
`start` 会返回 `run_id`、可选的 `group_id`/`entry_id`、模型与 harness 身份、`run_instructions`、初始观察和本局预算。

跨会话恢复已有运行：
若因客户端重启或断开需要接管先前未结束的运行，调用 `resume`：

```json
{
  "run_id": "run-2026-09-06-abc"
}
```

`resume` 会创建授权恢复申请，立即返回 `pending_approval` 与 `review_url`，adapter 每 2 秒后台查询审批状态。用户可在 External Play 网页控制台（首页待审批申请面板或对局详情页）进行审核批准。若原 controller 仍在线，审批时会弹出二次确认对话框，确认后强制接管（`force: true`），原子撤销旧租约并绑定新 controller。获批后 adapter 自动附着租约并启动心跳，不执行游戏动作；调用 `observe` 获取当前观察，或再次调用 `resume` 获取最新提示词与环境元数据。拒绝、过期或断连会停止轮询；租约已过期或被接管时，重新调用 `resume` 必须再次审批。

已认领运行的 adapter 若丢失认证，后续 `start` 重试不会创建新 controller 或领取下一席位；只能通过 `resume` 重新申请并获批后继续游戏。审批和新认领共用 controller 绑定锁，同一 controller 不会同时持有两个运行的租约。

`start` 与 `resume` 获批后建立控制 lease。之后的游戏操作必须使用同一个 MCP 会话，不能直接调用或修改游戏引擎状态。

`action_sequence` 接受 1 到 1,000 个有序 action 字符串。它逐步执行并保留实时观战与动作记录；默认返回紧凑步骤摘要和 `final_observation`。遇到 `ended: true`、玩家死亡或动作错误时会提前停止，以便模型恢复或重新规划。

### 推荐的自主游玩提示词

```text
Use the configured `mazebench` MCP server to play the hidden 3D grid game. All game interaction must go through the tools supplied by that MCP server.

Call the `mazebench` MCP tool `start` exactly once first and inspect its sanitized ASCII observation. Then use its named action tools `up`, `down`, `left`, `right`, `rotate_camera_up`, `rotate_camera_down`, `rotate_camera_left`, `rotate_camera_right`, `undo`, `reset`, and `go_to_level`. A saved solver may instead call its `action_sequence` tool with an ordered `actions` array of at most 1,000 items. By default the sequence result contains compact step summaries plus `final_observation`. Use the `observe` tool only when you need to inspect the current state without consuming an action. `go_to_level` accepts the two world-coordinate letters for a previously visited room.

The controls do not report whether a movement was blocked; infer its effect only from the returned observation.

Explore as many rooms as possible and collect as many gems as possible. You may use at most 256 game actions. Quit is disabled; recover with undo or reset after a death and keep playing.

Finish with a short route summary only after a game result says `ended: true`. A belief that no useful move remains is not a stop condition: while `ended: false`, never provide a final response and continue using the game controls.

The game implementation, session, checkpoints, and scoring are evaluator-only. Do not try to locate or access them. Do not claim moves or scores that were not returned by the game controls.
```

如果创建场次时把 actions 上限改成其他数值，请同步替换提示词中的 `256`。

若因客户端重启或断开需要恢复未完成的对局，可让模型使用以下恢复提示词：

```text
Use the configured `mazebench` MCP server to resume the existing 3D grid game.
Call the `mazebench` MCP tool `resume` with `{"run_id": "<your-run-id>"}` and wait until approval is granted in the local web interface. Do not call `start`.
After approval is granted, inspect the observation and continue using the game action tools (`up`, `down`, `left`, `right`, `observe`, `action_sequence`, etc.) until ended=true.
```

## 结束条件与运行产物

场次在以下条件之一满足时结束：

- 达到创建场次时设定的 game actions 上限（默认 256）；
- 用户在本地网页明确取消；
- 服务或运行发生不可恢复错误。

运行数据默认保存在：

```text
~/.mazebench/external-runs/<run-id>/
```

主要产物包括：

- `manifest.json`
- `journal.jsonl`
- `actions.jsonl`
- `base-viewer-state.json`
- `world-bundle.json`
- `summary.json`
- replay 使用的不可变 blobs

## 其他本地命令

交互式 ASCII 游戏：

```bash
mazebench ascii
mazebench ascii --level CxD
```

模型视角 JSON 观测：

```bash
mazebench json --level CxD
mazebench json --level CxD --omniscient
```

交互式命令 REPL：

```bash
mazebench play level=HxI view=top-diagonal
```

重新生成已有运行的回放：

```bash
mazebench replay <session-dir | session.json | results.jsonl>
```

## Prime 集成

Local MCP、实时观战、总结和回放默认不依赖 Prime CLI。

仓库仍保留可选的 Prime 兼容集成，但默认关闭。只有确实需要维护旧的 Prime evaluation 路径时，才应显式设置：

```text
MAZEBENCH_ENABLE_PRIME=1
```

Prime 集成不是本仓库 Local MCP 主流程的前置条件。

## 开发与测试

安装开发依赖：

```bash
npm ci
```

常用验证命令：

```bash
npm run test:pr
npm run test:browser
python -m unittest tests/test_mazebench_cli.py
```

相关文档：

- [本地 MCP 实时观战与总结功能改造方案](docs/plan/2026-08-25-local-mcp-live-service.md)
- [External Play 本地鉴权简化与 Prime CLI 解耦方案](docs/plan/2026-08-31-external-play-local-auth-and-prime-decoupling.md)
- [External Play 认领与授权恢复执行计划](docs/plan/2026-09-06-external-play-claim-and-auth-resume.md)
- [Maze level 格式](docs/maze-level-format.md)
- [Python 打包说明](docs/packaging.md)

## 致谢

本项目基于原始 [MazeBenchEngine](https://github.com/mazebench/MazeBenchEngine) 项目开发。感谢原作者 Jonathan Pappas、David Pappas 及所有上游贡献者提供 MazeBench 游戏引擎、关卡、网站与评测基础。

Local MCP 改造版本的维护仓库为 [zaixiakongyiji/mazebench-local-mcp](https://github.com/zaixiakongyiji/mazebench-local-mcp.git)。

## License

本项目及其上游代码依据 [MIT License](LICENSE) 提供。

```text
Copyright (c) 2026 Jonathan Pappas and David Pappas
```

原作者的上述版权声明与 MIT 许可全文均原样保留在仓库的 [LICENSE](LICENSE) 文件中。使用、修改或再分发本项目时，必须按照 MIT License 的要求保留该版权声明和许可文本。
