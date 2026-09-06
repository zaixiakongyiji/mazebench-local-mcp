# External Play 认领与授权恢复执行计划

> **适用标准**: superpowers:writing-plans / superpowers:executing-plans / 综合系统协议 v1.6
>
> **目标**: 彻底分离 External Play 的新局认领（`start`）与跨会话恢复（`resume`），禁止同一连接内多玩家复用，防止模型误填 `run_id` 篡位进入他人游戏；实现跨会话本地网页授权审批流与在线强制接管二次确认，强化 controller 隔离与 WAL journal 审计追踪。
>
> **核心架构**:
> 1. **协议层分离**: `start({model_name})` 仅限领取空闲席位，MCP schema 及服务端严拒 `run_id`；新增 `resume({run_id})` 仅申请恢复，首次返回 `pending_approval` 与审核 URL，不返回租约和游戏控制权。
> 2. **Controller-Run 严格绑定与幂等隔离**: 单 controller 对应单玩家，已绑定未结束 run 时拒领新席；幂等按 `controller_id + operation_id` 隔离，重试绝不误领下一席；游戏工具严格校验控制器与租约绑定。
> 3. **本地网页授权审批**: 本地管理页与详情页展示待审批恢复申请列表；原租约在线时强制要求二次确认提交 `force:true`；获批后在锁内原子撤销旧租约、递增 epoch、写入包含审计字段的 WAL 并绑定新 controller。
> 4. **Adapter 自治与轮询**: adapter 自动申请独立身份并禁止共享 token；待审批期间每 2 秒轮询状态端点，获批后启动心跳并接收当前观察，不自动执行游戏动作。

---

## 涉及文件与职责规划

### 1. Schema、验证器与构建
- `scripts/build-standalone-validators.js`: 在 `bundleSchema` 的 `lease_attached` 记录中增加可选审计字段（`request_id`, `previous_controller_id`, `forced`），保持旧历史向下兼容；
- `shared/validators.standalone.js`: 由脚本自动编译生成；
- `scripts/sync-runtime.js`: 将 live tree 镜像同步到环境包与 CLI 运行时包。

### 2. 服务端核心与路由
- `server/external-play.js`:
  - 拆分 `start` 与 `resume` 逻辑，移除原 `claimOrAttachRun` 的混用逻辑；
  - 维护内存级恢复申请状态机（`resumeRequests`，10分钟过期，重启清空）；
  - 实现 `createResumeRequest`, `getResumeRequests`, `getResumeRequestStatus`, `approveResumeRequest`, `rejectResumeRequest`；
  - 增强 `controllerRunBindings`、`operationIndex` 隔离与参数指纹校验；
  - 强化 `observe`, `executeAction`, `heartbeat`, `detach` 的归属校验。
- `server/router.js`:
  - `POST /api/external-play/mcp`: 拒绝对 `start` 传入 `run_id`（包括外层 payload 注入）；支持 `resume` 工具分发；
  - `GET /api/external-play/resume-requests`: 本地网页获取待审批申请列表；
  - `POST /api/external-play/resume-requests/:id/approve`: 审批接管接口（支持 `force: true` 二次确认）；
  - `POST /api/external-play/resume-requests/:id/reject`: 拒绝恢复申请接口；
  - `GET /api/external-play/resume-requests/:id/status`: ControllerToken 保护的恢复状态轮询接口。
- `server/pages.js`:
  - 在 External Play 管理首页与详情页 HTML 结构中挂载恢复申请列表容器。
- `server/external-run-instructions.js`:
  - 升级指令版本为 `external-mcp-v2`，更新工具使用指导规则。

### 3. 前端界面与交互
- `public/external-play.js`:
  - 增加恢复申请列表轮询与渲染逻辑；
  - 实现批准、拒绝与在线强制切换二次确认模态框；
- `public/external-play.css`:
  - 增加恢复申请表格/卡片、状态徽标及二次确认弹窗样式。

### 4. MCP Adapter 客户端
- `scripts/maze-external-mcp.js`:
  - 检测到 `MAZEBENCH_LOCAL_MCP_TOKEN` 时抛出明确错误并停止运行；
  - `TOOLS_MANIFEST`: 移除 `start` 中的 `run_id`，新增 `resume` 工具定义；
  - 实现 `resume` 申请与 2 秒间隔的状态轮询，获批后加载租约并启动心跳；
  - 请求使用 UUID 保证传输重试复用原操作 ID，`action_sequence` 子动作分配独立 ID；
  - 记录客户端认领状态，断开或重启后禁止自动领取下一席。

### 5. 测试套件
- `tests/external-play-service.test.js`: 覆盖服务端认领、恢复、审批、二次确认、幂等隔离与 WAL 审计测试；
- `tests/maze-external-mcp.test.js`: 覆盖 MCP 工具 schema、拒绝 `run_id`、`resume` 轮询与并发独立性测试；
- `tests/external-play-browser.test.js`: Playwright E2E 测试网页审批与在线强制接管；
- `tests/adversarial-mcp-external-stress.test.js` & `tests/runtime-drift.test.js`: 压力与运行时一致性验证。

---

## 详细任务分解（Bite-Sized Tasks）

### 阶段一：Schema、验证器与 WAL 审计规范

#### Task 1: 扩展 WAL Journal Schema 并重新生成独立验证器
- **涉及文件**:
  - 修改: `scripts/build-standalone-validators.js`
  - 生成: `shared/validators.standalone.js`
  - 同步: 运行 `scripts/sync-runtime.js`
- **实施步骤**:
  - [ ] **步骤 1.1**: 在 `scripts/build-standalone-validators.js` 的 `bundleSchema.$defs.journal_record` 中，为 `lease_attached` 类型添加可选属性：
    - `request_id`: `{ "type": "string", "maxLength": 128 }`
    - `previous_controller_id`: `{ "type": ["string", "null"], "maxLength": 128 }`
    - `forced`: `{ "type": "boolean" }`
    保持 `required` 字段与现有版本一致，确保旧历史记录依然可以无缝解析。
  - [ ] **步骤 1.2**: 运行 `npm run build:validators` 重新编译生成 `shared/validators.standalone.js`。
  - [ ] **步骤 1.3**: 运行 `npm run sync-runtime` 将新验证器同步至镜像目录。
  - [ ] **步骤 1.4**: 运行已有历史回放与校验测试 `node tests/external-play-service.test.js`，验证旧 journal 解析向下兼容。

---

### 阶段二：服务端核心业务逻辑重构（ExternalPlayService）

#### Task 2: 严格分离 Start 认领与恢复申请，强化 Controller-Run 绑定
- **涉及文件**:
  - 修改: `server/external-play.js`
  - 测试: `tests/external-play-service.test.js`
- **实施步骤**:
  - [ ] **步骤 2.1**: 将 `claimOrAttachRun` 重构为严格的 `claimRun(controllerInfo, args, operationId, abortSignal)`：
    - 若 `args.run_id` 存在，抛出 `{ status: 400, code: "INVALID_ARGUMENT", message: "start does not accept run_id; use resume({run_id}) to request run resumption" }`；
    - 检查当前 controller 是否已绑定未结束的 run：
      - 若已绑定且该 run 未结束（`!TERMINAL_STATUSES.has(run.status)`）：
        - 若请求中的 `model_name` 与绑定 run 不一致，抛出 `{ status: 409, code: "IDENTITY_MISMATCH" }`；
        - 否则抛出 `{ status: 409, code: "ALREADY_BOUND", message: "Controller is already bound to an active run" }`；
      - 若绑定的 run 已达终态，清除原绑定关系，允许领取下一席。
    - 幂等检查：基于 `controllerId + operationId` 缓存查询。若命中历史且参数指纹匹配，返回原认领结果；若参数指纹不匹配，抛出 `409 IDEMPOTENCY_CONFLICT`。即使该 run 之后已结束，旧操作 ID 重试也只能返回原结果，绝不可分配新席位。
    - 从 `claimableRunIds` 中认领席位并调用 `run.start(...)`，记录绑定关系到 `this.controllerRunBindings`。
  - [ ] **步骤 2.2**: 完善 `executeAction`、`observe`、`heartbeat`、`detach` 中的 controller 归属校验：
    - 确保请求的 controller 必须与 run 绑定的 controller 严格一致；
    - 验证当前有效租约（`lease_id` 与 `lease_epoch`）；
    - 无法通过向请求体传入不同的 `run_id` 绕过绑定。

#### Task 3: 实现恢复申请状态机与本地审批授权机制
- **涉及文件**:
  - 修改: `server/external-play.js`
  - 测试: `tests/external-play-service.test.js`
- **实施步骤**:
  - [ ] **步骤 3.1**: 在 `ExternalPlayService` 构造函数中初始化恢复申请管理结构：
    - `this.resumeRequests = new Map()`（`requestId -> requestRecord`）；
    - `this.controllerResumeIndex = new Map()`（`controllerId -> requestId`）。
    待审批数据仅在当前服务实例内存中维护，进程重启后自动清空。
  - [ ] **步骤 3.2**: 实现 `createResumeRequest(controllerInfo, runId)`：
    - 校验 `runId` 是否存在，若不存在返回 404；
    - 校验 run 状态：若已处于终态，返回 `409 RUN_TERMINAL`；
    - 校验 controller 是否已绑定其他未结束 run：若是，返回 `409 ALREADY_BOUND`；
    - 检查该 controller 对该 run 是否已有未过期（10 分钟）的待审批申请：若是，复用并返回原申请；
    - 每个 controller 最多一条待审批申请，若有对其他 run 的旧申请且未获批，将其失效；
    - 构造申请记录，包含：`id`, `runId`, `controllerId`, `declaredCli`, `clientInfo`, `createdAt`, `expiresAt`, `status: "pending"`；
    - 首次返回 `status: "pending_approval"`, `request_id`, `review_url`，**绝不返回**租约凭据、地图观察或游戏控制权。
  - [ ] **步骤 3.3**: 实现 `getResumeRequests()` 与 `getResumeRequestStatus(controllerInfo, requestId)`：
    - `getResumeRequests()`: 清理过期申请后，返回公开脱敏列表（原模型名、run/entry ID、申请客户端信息、连接标识、申请时间、旧租约当前在线状态）；响应中严禁包含 controller token 或 leaseId；
    - `getResumeRequestStatus()`: 必须经过 controller 认证且只允许发起该申请的 controller 查询。若获批，返回完整运行提示词、新租约凭据、当前观察和剩余预算。
  - [ ] **步骤 3.4**: 实现 `approveResumeRequest(requestId, { force = false })`：
    - 校验申请存在、处于 `pending` 且未过期（10 分钟）；
    - 校验目标 run 存在且未结束；
    - 校验申请 controller 仍然合法且未绑定其他运行；
    - 检查目标 run 的旧租约：若旧租约依然有效且持有者不是申请 controller，当 `force !== true` 时，拒绝并返回 `409 LEASE_ACTIVE`；
    - 经二次确认（`force: true`）或旧租约已失效时：
      - 在目标 run 的 `sessionMutex` 保护下：
        - 撤销旧租约（持久化 `lease_revoked`），递增 `lease_epoch`；
        - 生成新租约（新 `lease_id`, 新 `lease_epoch`, `lease_expires_at`）；
        - 持久化写入 WAL `lease_attached`（写入 `request_id`, `previous_controller_id`, `forced: Boolean(force)`）；
        - 若 WAL 写入失败安全退出，不修改内存状态；
        - 更新 `controllerRunBindings`：旧 controller 解绑，新 controller 绑定到该 run；
        - 将申请记录状态置为 `approved`，记录新租约数据供申请方查询；
        - 将该 run 的其他所有 pending 申请全部置为 `voided/rejected`。
  - [ ] **步骤 3.5**: 实现 `rejectResumeRequest(requestId)`：
    - 标记申请状态为 `rejected` 并清理 controller 索引。

---

### 阶段三：HTTP 路由与 API 契约实现

#### Task 4: 更新 External Play API 路由
- **涉及文件**:
  - 修改: `server/router.js`
  - 测试: `tests/external-play-service.test.js`
- **实施步骤**:
  - [ ] **步骤 4.1**: 更新 `POST /api/external-play/mcp`：
    - 当 `tool === "start"` 时，检查外层 `payload.run_id` 或 `payload.arguments?.run_id`，若存在直接返回 400 错误，不静默忽略；
    - 支持 `tool === "resume"`：校验 `arguments.run_id`，调用 `createResumeRequest`，返回待审批结果；
    - 工具调用严格校验 controller 与目标 run 的绑定关系。
  - [ ] **步骤 4.2**: 新增管理端 API（复用 loopback 与 same-origin 安全边界）：
    - `GET /api/external-play/resume-requests`: 返回当前所有有效恢复申请列表；
    - `POST /api/external-play/resume-requests/:id/approve`: 审批接口，接收 JSON `{ force: boolean }`；
    - `POST /api/external-play/resume-requests/:id/reject`: 拒绝接口。
  - [ ] **步骤 4.3**: 新增 Adapter 专用轮询端点（受 Bearer ControllerToken 保护）：
    - `GET /api/external-play/resume-requests/:id/status`: 发起 controller 轮询获取审批状态及获批凭据。

---

### 阶段四：网页授权管理界面实现

#### Task 5: 网页管理页与详情页恢复申请列表与二次确认交互
- **涉及文件**:
  - 修改: `server/pages.js`
  - 修改: `public/external-play.js`
  - 修改: `public/external-play.css`
  - 测试: `tests/external-play-browser.test.js`
- **实施步骤**:
  - [ ] **步骤 5.1**: 在 `server/pages.js` 的管理首页（Landing Page）与运行详情页（Run Page）中注入恢复申请容器元素 `#resume-requests-section`。
  - [ ] **步骤 5.2**: 在 `public/external-play.js` 中实现恢复申请管理模块：
    - 定期从 `GET /api/external-play/resume-requests` 拉取待审批申请；
    - 详情页只展示与当前 `runId` 匹配的申请，管理页展示全部申请；
    - 列表展示原模型、run/entry ID、申请客户端（declaredCli、clientInfo）、申请时间、原租约状态（“在线中 / Active” vs “已断开 / Expired”）；
    - 提供【批准】与【拒绝】操作；
    - 若旧租约处于“在线中”，点击【批准】弹出明确的二次确认对话框（Modal）：“检测到原模型连接仍在线，是否强制切换接管？”，点击确认后向服务端发送 `{ force: true }`；若直接点击返回 `LEASE_ACTIVE`，自动弹出该二次确认对话框；
    - 操作完成后即时刷新列表并给出反馈提示。
  - [ ] **步骤 5.3**: 在 `public/external-play.css` 中添加申请列表、状态徽章及二次确认模态弹窗样式。

---

### 阶段五：MCP Adapter、提示词与规范兼容

#### Task 6: 重构 Stdio MCP Adapter 与提示词规范
- **涉及文件**:
  - 修改: `scripts/maze-external-mcp.js`
  - 修改: `server/external-run-instructions.js`
  - 修改: `README.md`
  - 测试: `tests/maze-external-mcp.test.js`
- **实施步骤**:
  - [ ] **步骤 6.1**: 禁用 Token 复用：在 `scripts/maze-external-mcp.js` 启动时检测 `process.env.MAZEBENCH_LOCAL_MCP_TOKEN`，若存在则在 stderr 输出明确报错并退出进程，提示移除该配置以使用独立 controller。
  - [ ] **步骤 6.2**: 更新 `TOOLS_MANIFEST`：
    - 从 `start` 的 `inputSchema` 中彻底删除 `run_id` 参数；
    - 新增 `resume` 工具规范：
      - `name: "resume"`
      - `description: "Request authorization to resume an existing MazeBench run. Returns pending approval status and audit request ID. Resumption must be approved by the user in the local web interface."`
      - `inputSchema`: `{ type: "object", required: ["run_id"], properties: { run_id: { type: "string", description: "Target run ID to resume" } }, additionalProperties: false }`
  - [ ] **步骤 6.3**: 实现 `resume` 申请与轮询逻辑：
    - 调用 `POST /api/external-play/mcp` 发起 `resume`，解析返回的 `request_id`；
    - 若处于 `pending_approval`，输出提示信息并启动定时轮询（每 2 秒一次 `GET /api/external-play/resume-requests/:id/status`）；
    - 若获批（`approved`），取得新租约并启动心跳，返回完整运行提示词与当前观察，不自动执行任何动作；
    - 若被拒绝、过期或连接断开，停止轮询并返回明确错误。
  - [ ] **步骤 6.4**: 保证每个逻辑请求具有独立的 UUID 操作 ID，传输重试复用原 ID；`action_sequence` 的每个子动作生成独立的 UUID 操作 ID。
  - [ ] **步骤 6.5**: 升级运行提示词（`server/external-run-instructions.js`）至 `external-mcp-v2`，明确：新局只调用 `start`；继续同局使用游戏工具；跨会话恢复调用 `resume` 并等待用户网页批准。更新相关文档。

---

### 阶段六：运行时同步与全面回归验证

#### Task 7: 自动化测试覆盖与全套回归
- **涉及文件**:
  - 修改: `tests/external-play-service.test.js`
  - 修改: `tests/maze-external-mcp.test.js`
  - 修改: `tests/external-play-browser.test.js`
- **实施步骤**:
  - [ ] **步骤 7.1**: 更新 `tests/external-play-service.test.js`：
    - 测试 `start` 传 `run_id` 被拒绝（400 INVALID_ARGUMENT）；
    - 测试同一 controller 重复 start 返回 `409 ALREADY_BOUND`，不同名称返回 `IDENTITY_MISMATCH`；
    - 测试网络重试幂等性：同 controller + 同 operationId 返回原认领结果，修改参数报 `IDEMPOTENCY_CONFLICT`，原 run 结束后旧重试不误领下一席；
    - 测试 `createResumeRequest`、10分钟自动过期、重复申请复用；
    - 测试网页审批流程：旧租约在线时普通审批返回 `409 LEASE_ACTIVE`，`force: true` 成功强制切换；
    - 测试获批后旧 controller 动作与心跳均失效（409 CONFLICT），新 controller 获得有效租约并记录 WAL。
  - [ ] **步骤 7.2**: 更新 `tests/maze-external-mcp.test.js`：
    - 将原有 Test 12（显式传 run_id）修改为验证拒绝 `start({run_id})`；
    - 新增 Test：环境变量 `MAZEBENCH_LOCAL_MCP_TOKEN` 报错退出；
    - 新增 Test：调用 `resume({run_id})` 并在后台模拟网页审批，验证 adapter 轮询获批后成功恢复；
    - 测试 2–8 个独立 adapter 并发认领同名/不同名模型，验证分配到不同 run 且配置一致。
  - [ ] **步骤 7.3**: 更新 `tests/external-play-browser.test.js`（Playwright E2E）：
    - 验证管理页与详情页恢复申请列表展示；
    - 验证在线玩家强制接管二次确认弹窗流程；
    - 验证接管后 adapter 继续走棋、观察连续。
  - [ ] **步骤 7.4**: 执行编译与全量测试：
    - `npm run build:validators`
    - `npm run sync-runtime`
    - `node tests/runtime-drift.test.js`
    - `npm test`
    - `npm run test:browser`
