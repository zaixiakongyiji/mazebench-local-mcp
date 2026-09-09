# External Play 长时间运行修复记录

## 现场证据

- `ext-8d4927a5-f44c-4502-936f-597e806eeee4` 于北京时间 2026-09-09 01:24:53 因 `heartbeat_timeout` 撤销租约，距离开局约 37 分钟。不是已证实的 24 小时凭据硬过期。缺少当时客户端 stderr 和 CPU profile，不能进一步确定阻塞发生在哪一侧。
- `ext-d9a79b88-3cd0-44ca-924a-2f9a5f633858` 有 46,667 步，仅第 321 步累计宝石从 0 变成 1。动作文件 357,571,567 字节，WAL 615,923,409 字节。旧观战每页读取全动作文件，JSON 从头解析至页末；前端生成全部节点并逐步全表高亮。

## 实现

1. 复用 WAL 已保存的动作对象建立按序号索引，恢复时重建引用；分页不读取投影文件。SSE 使用事件索引，追赶窗口最多 500 条，慢观众发送缓存超过 1 MiB 时断开。没有更改已有 WAL 或运行数据。
2. 观战直接显示最新快照，仅加载附近 200 条历史，缓存上限 1000 条，DOM 上限 200 个。历史跳转按需读取，重连清理旧历史并取消旧流；积压时跳到完整状态。宝石计数比较来自相邻历史动作，不再使用播放游标计数。
3. 仅成功的有效租约心跳更新 controller 凭据续期时间；过期、撤销、接管和重启继续遵循审批边界。只读 viewer token 在收到 401/403 后重取一次。
4. HTTP 总超时 20 秒、心跳 8 秒，处理半响应和取消，禁止心跳重叠。未知 start 结果保存原幂等 ID，拒绝更换参数或已变化的 controller；stderr 仅记录路径、耗时和错误码。

## 开发边界

独立工作树 `MazeBenchEngine-long-run`，分支 `codex/fix-long-run-spectator`。从当前远端主分支建立后快进纳入已有依赖 `951c62a`（终态认领等修复），本次不重写该提交。原工作树未跟踪文件保持原状。用户已在本任务中批准实施。

## 验证

新增测试覆盖无响应、半响应、认领响应丢失的幂等重试、凭据有效续期及过期拒绝、50,000 条动作分页零文件扫描和 SSE 游标窗口；Chromium 浏览器覆盖实际页面 50,000 步、重连去重、按需跳转及第 321 步唯一宝石提示。另运行项目规定的服务、运行组、MCP、对抗、浏览器、runtime 漂移与全量测试。最终结果以交付报告为准。

未承诺解决所有客户端故障：昨晚 start 无响应的准确现场原因仍缺日志；此次修复消除了已确认的无限等待和大历史观战阻塞路径。

## 文件清单

| 路径 | 变更 |
| --- | --- |
| `server/external-play.js` | 成功心跳续期、WAL 动作及事件索引、慢观众发送积压保护 |
| `server/router.js` | 索引分页、最新快照、SSE 有界追赶 |
| `scripts/maze-external-mcp.js` | HTTP 总期限与半响应处理、单个在途心跳、未知 start 幂等重试 |
| `public/external-play.js` | 按需历史、有限列表与缓存、正确宝石增量、重连去重及旧流取消 |
| `tests/external-play-long-run.test.js` | 传输、认领重试、心跳、续期及 5 万步分页回归 |
| `tests/external-play-browser.test.js` | 5 万步实际页面与宝石提示、重连回归 |
| `package.json` | 将新增长记录测试纳入 test 与 test:pr |
| `README.md` | 长时间运行与观战行为说明 |
| `docs/plan/2026-09-09-external-play-long-run-diagnostics.md` | 现场证据、实现与验证记录 |
| `environments/mazebench/mazebench/runtime/server/external-play.js` | 自动同步服务实现 |
| `environments/mazebench/mazebench/runtime/server/router.js` | 自动同步接口实现 |
| `environments/mazebench/mazebench/runtime/scripts/maze-external-mcp.js` | 自动同步 adapter |
| `environments/mazebench/mazebench/runtime/public/external-play.js` | 自动同步观战页面 |

## 环境验证限制

专项服务、运行组、MCP、80 项对抗断言、Chromium 观战与 runtime 漂移检查通过。全量脚本自动跳过 Windows 提升权限沙箱运行验证，以及未自动识别 Windows Chrome 的两个渲染测试。显式指定本机 Chrome 后，strict-model-readiness 通过；renderer-lifecycle 在当前修复工作树和原分支均失败于同一断言：`renderer should report its Playwright browser PID`。该对照失败与本次修改无关，未扩大修复范围。
