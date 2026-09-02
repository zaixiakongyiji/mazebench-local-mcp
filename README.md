# MazeBench Local MCP

MazeBench Local MCP 是基于 MazeBenchEngine 改造的本地游戏控制与实时观战版本。

本地 CLI 或桌面端（Gemini、Antigravity、Codex、Claude Code、Claude Desktop 等）通过 `stdio` MCP 控制同一套 MazeBench JavaScript 游戏引擎；浏览器实时显示 3D 游戏画面、动作时间线和当前状态，并在通关或超时后展示总结与回放。

该模式的核心特点：

- 模型由本地 CLI 或桌面端自行选择，不绑定 Prime Inference 模型目录；
- 不需要模型网关、Docker 或 Prime CLI；
- 不托管外部 CLI，也不采集模型思考过程、token 或费用；
- 游戏状态只能通过 MCP 工具修改；
- 网页只在本机 loopback 地址提供服务；
- External Play 结果标记为 `EXTERNAL / UNVERIFIED`，不属于正式 benchmark 成绩。

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

前台启动：

```bash
mazebench launch
```

后台启动：

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

MazeBench 服务和 MCP adapter 是两个独立进程：先运行 `mazebench launch`，再让 CLI 或桌面端启动 `mazebench mcp`。

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

1. 执行 `mazebench launch`。
2. 在浏览器打开 External Play 页面。
3. 创建场次，设置时间上限、通关 gems 数量，并可选填写模型名称和 harness 名称。
4. 启动或重启已经配置 MCP 的 CLI/桌面端。
5. 让模型先调用 `start`，然后通过 `observe` 和动作工具游玩。
6. 在浏览器中实时观看 3D 画面、动作记录、房间和 gems 状态。
7. 达到通关条件或时间上限后，在同一页面查看总结和回放。

服务启动时会准备一个默认的 `armed` 场次。只要该场次尚未被 MCP claim，网页创建的新场次会安全替换它；已经开始的场次不会被覆盖。

## MCP 工具

当前提供 13 个工具：

- `start`
- `observe`
- `up`、`down`、`left`、`right`
- `rotate_camera_up`、`rotate_camera_down`
- `rotate_camera_left`、`rotate_camera_right`
- `undo`
- `reset`
- `go_to_level`

`start` 用于 claim 当前场次并建立控制 lease。之后的游戏操作必须使用同一个 MCP 会话，不能直接调用或修改游戏引擎状态。

## 推荐提示词

下面的提示词与当前 External Play MCP 的 13 个工具及返回字段一致，可直接交给支持 MCP 工具调用的模型。当前 External Play MCP 不提供 `action_sequence`、`python_exec` 或 `quit`，因此不要在提示词中要求模型调用这些工具。

```text
Play the hidden 3D grid game using only the supplied MazeBench game controls.

Call `start` exactly once first and inspect its sanitized observation. Continue in
the same MCP session. Use the named action tools `up`, `down`, `left`, `right`,
`rotate_camera_up`, `rotate_camera_down`, `rotate_camera_left`,
`rotate_camera_right`, `undo`, `reset`, and `go_to_level`. Use `observe` only when
you need to inspect the current state without consuming an action. `go_to_level`
accepts the two world-coordinate letters for a previously visited room.

The controls do not explicitly report whether a movement was blocked. Infer its
effect only from the returned observation. Track visited rooms, attempted exits,
failed moves, collected gems, and the current route from the observations returned
during this run.

Explore as many distinct rooms as possible and collect as many gems as possible
before the session ends. Make every route, recovery, and exploration decision
autonomously. Do not ask the user where to move, whether to continue, or whether
to undo or reset. If `player_dead` is true, recover with `undo`, `reset`, or
`go_to_level` as permitted by `allowed_commands`, then continue playing.

Every tool result is an intermediate game state. While the result status remains
`active` and `game_won` is not true, do not provide a final response, progress
report, question, or request for confirmation. Immediately choose and call the
next game tool. A belief that no useful move remains is not a stop condition.

Stop only when a result reports `game_won: true`, or when MazeBench explicitly
reports that the session has timed out, been cancelled, failed, or can no longer
accept actions. Then provide a short route summary using only rooms, gems, actions,
and the ending reason returned by the game controls.

The game implementation, level files, world map, session, run artifacts, logs,
checkpoints, and scoring are service-only. Do not try to locate or access them.
Do not claim moves, rooms, gems, or scores that were not returned by the game
controls.
```

## 结束条件与运行产物

场次在以下条件之一满足时结束：

- 收集到创建场次时设定的 gems 数量；
- 达到 wall-clock 时间上限；
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
