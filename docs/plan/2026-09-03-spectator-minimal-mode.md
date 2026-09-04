# 观战界面「极简模式」实施计划 (Spectator Minimal Mode Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 MazeBench 实时观战界面（`/external-play/:runId`）新增「极简模式」开关，开启后关闭 Softness、Bloom、Bleed、Scanlines、Mask、Ghosting、Vignette、Noise 等 8 项 CRT/Fuzzy 着色器滤镜，保留 3D 几何轮廓描边，并通过 localStorage 持久化用户设置。

**Architecture:** 前端在底部回放控制栏注入切换按钮；运行时通过 `external-play.js` 管理模式状态，联动底层渲染核心 `app.state.effects.fuzzyEnabled` 与 `app.syncNoiseTicker()`，触发即时重绘，并将状态写入 `localStorage`。

**Tech Stack:** Vanilla JavaScript (ES2022+), CSS3, Node.js HTTP Server (`server/pages.js`), Node test runner (`node:test`).

---

### Task 1: 服务端页面模板与国际化字典更新

**Files:**
- Modify: `server/pages.js:1633-1637`
- Modify: `public/i18n.js:21-23, 180-182`
- Modify: `environments/mazebench/mazebench/runtime/public/i18n.js:21-23, 180-182`
- Test: `tests/spectator-minimal-mode-template.test.js`

- [ ] **Step 1: 编写模板渲染测试**

创建 `tests/spectator-minimal-mode-template.test.js`，验证观战页面 HTML 中包含 `#playback-minimal-btn` 以及 i18n 属性：

```javascript
const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../server/router");

test("external play run page renders minimal mode button", () => {
  const router = createServer();
  const html = router.renderExternalPlayRunPage({
    runId: "ext-test-123",
    status: "active",
    startedAt: new Date().toISOString(),
    maxActions: 256
  });

  assert.match(html, /id="playback-minimal-btn"/);
  assert.match(html, /data-i18n="minimal_mode_btn"/);
  assert.match(html, /playback-btn--toggle/);
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --test tests/spectator-minimal-mode-template.test.js`  
预期结果：FAIL（由于模板中尚未添加该按钮）

- [ ] **Step 3: 更新模板与国际化字典**

1. 修改 `server/pages.js`，在 `.playback-controls-right` 中添加按钮：
```html
<div class="playback-controls-right">
  <button id="playback-summary-btn" class="playback-btn" type="button" title="View Summary" data-i18n="summary_btn" hidden>📊 Summary</button>
  <button id="playback-minimal-btn" class="playback-btn playback-btn--toggle" type="button" title="Toggle Minimal Mode" aria-pressed="false" data-i18n="minimal_mode_btn">✨ 极简模式</button>
  <button id="playback-live-btn" class="playback-btn playback-btn--live is-active" type="button" title="Jump to Live">🔴 Live</button>
</div>
```

2. 在 `public/i18n.js` 和 `environments/mazebench/mazebench/runtime/public/i18n.js` 的中英文字典中添加：
- 中文（`zh`）：`minimal_mode_btn: "极简模式",`
- 英文（`en`）：`minimal_mode_btn: "Minimal Mode",`

- [ ] **Step 4: 运行测试验证通过**

运行：`node --test tests/spectator-minimal-mode-template.test.js`  
预期结果：PASS

---

### Task 2: 样式表适配（`.playback-btn--toggle`）

**Files:**
- Modify: `public/external-play.css:350-400`
- Modify: `environments/mazebench/mazebench/runtime/public/external-play.css:350-400`

- [ ] **Step 1: 添加按钮激活态与悬停样式**

在 `public/external-play.css`（及 runtime 对应副本）中，为 `.playback-btn--toggle` 添加高亮过渡和激活状态样式：

```css
.playback-btn--toggle {
  transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, box-shadow 150ms ease;
}

.playback-btn--toggle.is-active,
.playback-btn--toggle[aria-pressed="true"] {
  background: rgba(56, 189, 248, 0.18);
  border-color: rgba(56, 189, 248, 0.55);
  color: #38bdf8;
  box-shadow: 0 0 10px rgba(56, 189, 248, 0.25);
  font-weight: 600;
}

.playback-btn--toggle.is-active:hover,
.playback-btn--toggle[aria-pressed="true"]:hover {
  background: rgba(56, 189, 248, 0.28);
  border-color: rgba(56, 189, 248, 0.75);
}
```

- [ ] **Step 2: 验证样式文件语法与一致性**

确保在深色半透明背景与移动端响应式下，按钮能保持良好对齐与触控高度。

---

### Task 3: 前端交互与滤镜状态联动逻辑

**Files:**
- Modify: `public/external-play.js`
- Modify: `environments/mazebench/mazebench/runtime/public/external-play.js`
- Test: `tests/spectator-minimal-mode-runtime.test.js`

- [ ] **Step 1: 编写前端逻辑单元测试**

创建 `tests/spectator-minimal-mode-runtime.test.js`，测试状态管理函数与存储键约定：

```javascript
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("external-play.js implements minimal mode state management and storage persistence", () => {
  const content = fs.readFileSync("public/external-play.js", "utf8");
  assert.match(content, /STORAGE_KEY_MINIMAL_MODE|mazebench_spectator_minimal_mode/);
  assert.match(content, /playback-minimal-btn/);
  assert.match(content, /fuzzyEnabled/);
  assert.match(content, /syncNoiseTicker/);
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --test tests/spectator-minimal-mode-runtime.test.js`  
预期结果：FAIL

- [ ] **Step 3: 实现极简模式逻辑**

在 `public/external-play.js`（及 runtime 对应副本）中：
1. 定义持久化存储键：
   ```javascript
   const STORAGE_KEY_MINIMAL_MODE = "mazebench_spectator_minimal_mode";
   ```
2. 封装 `initMinimalMode(app)` 与 `syncMinimalModeButton(isMinimal)` 方法：
   - 读取 `localStorage.getItem(STORAGE_KEY_MINIMAL_MODE) === "true"`；
   - 若为 `true`，立即将 `app.state.effects.fuzzyEnabled = false`，更新按钮 `.is-active` 与 `aria-pressed="true"`；
   - 同步调用 `app.syncNoiseTicker()` 停止无谓噪点空转；
   - 触发 `app.render()` 重绘。
3. 绑定按钮点击事件：
   - 翻转状态；
   - 切换 `app.state.effects.fuzzyEnabled = !isMinimal`；
   - 更新 UI 样式与状态属性；
   - 写入 `localStorage`；
   - 触发 `app.syncNoiseTicker()` 与 `app.render()`。

- [ ] **Step 4: 运行测试验证通过**

运行：`node --test tests/spectator-minimal-mode-runtime.test.js`  
预期结果：PASS

---

### Task 4: 端到端功能与全量测试验证

- [ ] **Step 1: 运行所有新建与相关的单元测试**

运行：`node --test tests/spectator-minimal-mode-*.test.js`  
预期结果：全部 PASS

- [ ] **Step 2: 运行全量项目测试套件**

运行：`npm test`  
预期结果：所有核心用例通过，无回归。

- [ ] **Step 3: 汇总修改清单并汇报 Master**

提供完整的文件变更清单与 Git 提交建议，等待 Master 指示。
