# Codex Repository Instructions

These instructions apply to the entire MazeBenchEngine repository.

## Absolute isolation for benchmark agent runs

Benchmark agents must never be able to inspect MazeBenchEngine or any other repository. Treat repository or host-file access by the evaluated agent as cheating and as a run-launch failure, not as a supported tools mode.

- This rule applies to every agent run and every launch variant, including local, subscription, container, host, vision, text, tools-on, tools-off, offline, omniscient, hidden-name, swarm, worker, clone, continuation, and branch runs. Do not add mode-specific exceptions.
- Keep the trusted runner and game-control server separate from the evaluated agent. The runner may load the environment, but the evaluated model and every process or tool it can invoke must receive only the intended game observations and game-control interfaces.
- Never give the evaluated agent a repository working directory, repository mount, `--add-dir`, readable or writable repository root, host shell, unrestricted command execution, host filesystem search/read tool, repository-aware coding tool, repository MCP resource, or repository path in its prompt or environment.
- A tools-enabled benchmark may expose explicitly approved game-control tools and an explicitly approved, fail-closed computation tool whose only writable or persistent storage is the fresh run-scoped workspace below. The existing `python_exec` contract is the reference boundary: no host or repository files, no subprocesses, no network, bounded resources, and a launch-time isolation preflight. `offline`, `mode=vision`, `omniscient=false`, or a workspace-write sandbox alone do not provide repository isolation and must never be treated as if they do.
- Block access to source code, level definitions, world maps, solver code, tests, fixtures, hidden-state assets, scorecards, session files, run outputs, logs, prior-run artifacts, and sibling repositories. Do not allow indirect access through child processes, workers, clones, inherited file descriptors, symlinks, environment variables, or helper services.
- Give each evaluated agent a fresh, empty, run-scoped workspace containing no copied or linked repository content. Keep any agent-created notes or artifacts there only when the benchmark explicitly permits them.
- Launchers must fail closed before starting a run if the requested configuration, sandbox, tool set, working directory, mount set, or environment would expose repository or host files. Never silently launch with broader access.
- When changing agent launch code, preserve this boundary with automated tests that assert the evaluated agent cannot read repository or host files, launch subprocesses, use the network, or invoke host shell/file tools. A run that crosses this boundary is invalid even if it never changes game state.

## External Play and MCP agent isolation and authorization

External Play allows evaluated models and autonomous agents (e.g. Claude Desktop, Cursor, and custom CLI agents) to interact with MazeBench through the local MCP adapter or HTTP API. These runs must respect strict isolation, fairness, and safety boundaries:

- External Play MCP agents are strictly confined to the 15 approved tools: `start`, `resume`, `observe`, `up`, `down`, `left`, `right`, `rotate_camera_up`, `rotate_camera_down`, `rotate_camera_left`, `rotate_camera_right`, `undo`, `reset`, `go_to_level`, and `action_sequence`.
- Protocol separation for claim and resume:
  - `start({ model_name })` 仅用于认领全新 armed 席位，必须拒绝 `run_id` 且不分配席位、不改变其他运行。HTTP 接口返回 `400 INVALID_ARGUMENT`；stdio MCP adapter 的参数校验返回 JSON-RPC `-32602`，不要混用两层错误码。
  - Resuming an existing run across connections or restarts must exclusively use `resume({ run_id })`.
  - 新的 `resume` 授权申请立即返回 `pending_approval` 和 `review_url`，获批前不得暴露租约凭据、观察或控制权。用户在本地网页 `/external-play` 审批；接管其他 controller 的有效租约必须经过二次确认（`force: true`）。
  - adapter 每 2 秒非阻塞轮询审批状态；获批后自动附着租约并启动心跳，不自动执行游戏动作。拒绝、过期、断连或取消轮询后，迟到响应不得重新附着。已获批申请仅能在 controller、lease ID、epoch 和有效期均匹配当前租约时复用，并返回最新观察与预算；失效后必须重新审批。
- Controller session isolation:
  - 禁止共享 `MAZEBENCH_LOCAL_MCP_TOKEN`；每个独立 stdio MCP adapter 进程协商独立 controller。多模型并发必须使用独立 adapter 连接，不得假设同一客户端的不同对话或窗口天然隔离，也不要求使用不同品牌客户端。
  - 同一 controller 最多绑定一个未结束 run。运行结束或授权接管成功后，服务端解除原绑定；接管必须按 run ID 清理旧绑定，包括租约已经断开或超时的情况。仅断开或超时不自动释放绑定。
  - 审批和新认领必须共用 controller 绑定锁，锁顺序保持 `admissionMutex -> sessionMutex`，在同一事务范围内检查和更新绑定，防止同一 controller 同时取得两个 run 的租约。
  - adapter 已认领 run 后丢失认证，必须持续保留重新授权状态；未经权威终态确认，后续 `start` 重试不得创建新 controller 或领取下一席位。活动或状态未知的旧局只有通过 `resume` 获批才能恢复控制，服务端解绑不能用来绕过 adapter 的授权限制。唯一例外：本次显式 `start` 经内部认证接口确认 adapter 保存的旧 run 已处于合法终态，且确认结果的 run ID、状态、服务实例与凭据均有效时，可以更新 controller 并直接认领新席位；未知、缺失、非终态或无效响应必须拒绝。
  - Idempotent operations must be scoped to `controller_id + operation_id` to guarantee safe retries without unintended seat allocations.
- Durable audit logging:
  - 认领、租约附着、撤销及强制接管必须持久化到 WAL（`journal.jsonl`）。首次认领记录为 `run_started`；恢复附着的 `lease_attached` 写入 `request_id`、`previous_controller_id`（可为 `null`）和 `forced`。
  - `lease_revoked` 记录被撤销的 controller、lease ID、epoch 和 `reason`，不要求上述恢复附着专用字段。schema 中的新增审计字段保持可选以兼容旧历史，不重写旧 journal。

## 文档与计划维护

- README.md 只维护当前可用行为、配置方式和验证入口，不列出已完成的实施计划。
- 新的实施计划如确有必要可临时放在 docs/plan/；完成后删除，不作为当前待办，历史追溯使用 Git 历史。
- 关卡格式、打包和其他长期有效说明放在 docs/ 下，并随代码行为变化同步更新。

## 生成文件与回归验证

- schema 生成源为 `scripts/build-standalone-validators.js`。修改后运行 `npm run build:validators`，不要手工编辑 `shared/validators.standalone.js` 或 `public/validators.standalone.js`。
- 修改源文件后通过 `npm run sync-runtime` 同步 `environments/mazebench/mazebench/runtime/`，不要直接修改镜像副本；新增运行时模块必须确认已被 `scripts/sync-runtime.js` 的目录或文件清单覆盖。
- External Play / MCP 改动至少运行 `node tests/external-play-service.test.js`、`node tests/external-run-groups.test.js`、`node tests/maze-external-mcp.test.js`、`node tests/adversarial-mcp-external-stress.test.js`、`npm run test:browser` 和 `node tests/runtime-drift.test.js`，最后执行 `npm test`。
- 测试必须覆盖审批与认领竞争、连续认证失败重试、后台审批接管和心跳、过期租约缓存、旧绑定清理，以及历史与回放兼容。验证结果分别报告通过、失败和跳过；仅修改 README 或 AGENTS.md 无需生成或同步 runtime，也无需全量业务回归。

## Branch-first development

- Do not commit or push ordinary work directly to `main` unless the user explicitly overrides this rule.
- Start work from the current `origin/main` on a focused `codex/<task>` branch.
- Commit and push the branch, run the relevant tests, and open a pull request for the user to review.
- Do not merge the pull request until the user says the branch is approved. After approval, enable auto-merge against the exact reviewed head SHA once the required PR smoke check is queued. For ordinary changes, hand off as soon as GitHub accepts auto-merge; report the PR as queued rather than merged until GitHub confirms it, and do not synchronously poll the duplicate full `main` CI. Releases, deployments, migrations, failing checks, and explicit user requests to monitor through completion still require synchronous verification.
- GitHub automatically deletes merged remote branches. At the start of the next repository task, confirm any queued merge completed, then remove its clean local topic branch and dedicated worktree and prune stale tracking references. Never delete `main`, a branch with an open pull request, a dirty worktree, or a branch containing unmerged work.
- Treat a branch as empty when it has no commits ahead of current `origin/main`. If an empty branch has no open pull request, delete it from `origin` and locally immediately; do not open or merge an empty pull request just to remove it.
- A branch push, pull request, or merge does not by itself authorize a package release.

## Explicit release gate

After an approved change is merged to `main` and CI is green, explicitly ask whether the user wants a new PyPI release. Include the proposed next version in the question and briefly state why the change warrants that version bump.

For an ordinary auto-merged handoff, defer this release question until the next repository task confirms that `main` CI is green; do not keep the prior task open solely to wait for the release gate. Never defer it during an explicitly requested release or deployment workflow.

Do not create a release tag, publish a GitHub Release, manually dispatch the PyPI workflow, or upload to PyPI until the user answers yes.

When the user approves the proposed release, that approval authorizes Codex to complete the release workflow without asking at every intermediate step:

1. Create a focused `codex/release-<version>` branch from current `origin/main`.
2. Update every root-package version source, including `[project].version` in `pyproject.toml` and `mazebench_cli.__version__`, and check for any other synchronized version references.
3. Build the packaged runtime, wheel, and source distribution; run the Node tests and supported Python wheel smoke tests.
4. Push the release branch, merge it after its checks pass, and verify `main` is green.
5. Create the repository's customary GitHub tag/release for that version. Unless the user requests a stable release, follow the existing alpha prerelease convention.
6. Monitor the `Publish to PyPI` workflow through completion and verify that the exact version is available from PyPI.

PyPI versions are immutable. If publishing partially succeeds, inspect PyPI before retrying and never attempt to upload different artifacts under the same version.

## Prime Environment Hub releases

The Prime environment under `environments/mazebench` has its own version and release lifecycle; it is not tied automatically to the root PyPI package version.

- Propose a Prime environment version bump only when the environment package, bundled runtime, behavior, packaging, or dependencies changed. Dependency-only changes count.
- Documentation-only or root-CLI-only changes do not require a Prime environment bump.
- When a Prime bump is warranted, include it in the post-merge release question alongside the PyPI proposal.
- After approval, update the environment package version and the version pin in `configs/rl/mazebench.toml`, push the environment, monitor the Hub action, and verify it reaches `SUCCESS`.

## MazeJam promotion

MazeJam consumes MazeBenchEngine assets but deploys independently through Cloudflare Pages. If an approved engine change alters assets consumed by MazeJam, mention that in the post-merge handoff and ask whether to synchronize and deploy MazeJam. Do not assume that a PyPI or Prime release also authorizes a site deployment.
