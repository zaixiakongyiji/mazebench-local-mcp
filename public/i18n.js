(function () {
  "use strict";

  const I18N_DICT = {
    zh: {
      brand: "迷宫基准 (Maze Bench)",
      nav_build: "构建与游玩",
      nav_agent: "智能体评测",
      nav_train: "模型训练",
      home_build_title: "构建与游玩",
      home_build_copy: "创建、编辑并游玩官方 Maze Bench 3D 环境或您的本地草稿。",
      home_external_title: "外部 MCP 游玩 (Local MCP)",
      home_external_copy: "连接 Codex、Claude Desktop 或本地 MCP 进行游玩，并在 3D 界面中实时观战（未验证模式）。",
      home_agent_title: "智能体评测 (Agent)",
      home_agent_copy: "在隔离的专用游戏控制接口下运行模型并进行 3D 实时观战。",
      home_train_title: "模型训练 (Train)",
      home_train_copy: "使用 Prime Verifiers 在 Maze Bench 上训练强化学习模型。",
      ext_badge_unverified: "外部游玩 / 未验证模式",
      ext_landing_title: "外部 MCP 游玩 (Local MCP)",
      ext_landing_subtitle: "通过标准输入输出 MCP（Codex、Claude Desktop 等）在本地控制权威的 MazeBench 游戏会话，并在三维场景中实时观战。",
      ext_active_session: "当前活跃会话：",
      ext_created_at: "创建时间：",
      ext_spectate_btn: "进入 3D 实时观战 →",
      ext_no_active_session: "当前暂无活跃会话。请在下方创建或启动 MCP。",
      ext_mcp_config_title: "MCP 配置指南",
      ext_mcp_config_desc: "将以下配置添加到您的 Codex 或 Claude Desktop 客户端中：",
      create_session_title: "创建外部游玩会话 (External Play)",
      duration_label: "时长限制（分钟）",
      win_threshold_label: "通关目标（收集宝石数）",
      model_name_label: "模型名称 (Model Name)",
      model_name_placeholder: "例如：Gemini 2.5 Flash / Claude 3.7 Sonnet",
      harness_name_label: "评测框架 (Harness Name)",
      harness_name_placeholder: "例如：antigravity-mcp / stdio-mcp",
      create_btn: "创建并启动会话",
      actions: "行动数",
      gems: "宝石",
      room: "房间",
      rooms: "房间数",
      waiting_mcp: "等待 MCP 连接",
      connected: "实时连接已建立",
      disconnected: "连接断开",
      cancel_run: "终止会话",
      pause: "暂停",
      play: "播放",
      step: "步骤",
      live: "实时 (Live)",
      feed_title: "AI 决策与指令流",
      empty_feed: "等待 MCP 控制器下达指令...",
      outcome_won: "胜利通关",
      outcome_timed_out: "超时结束",
      outcome_cancelled: "已取消",
      outcome_failed: "失败",
      summary_title: "游戏结算概览",
      summary_home: "返回首页",
      summary_replay: "从头回放",
      summary_download: "下载结算数据 (JSON)",

      // Agent 页面词条
      agent_title: "智能体评测 (Agent)",
      agent_new_run: "新建评测运行",
      agent_step_harness: "评测框架 (Harness)",
      agent_harness_note: "选择评测框架与模型环境进行自动化运行。",
      agent_run_through: "运行模式",
      agent_step_model: "模型选择",
      agent_step_reasoning: "思考与推理等级 (Reasoning Effort)",
      agent_step_target: "目标环境",
      agent_step_settings: "运行配置",
      agent_step_run: "启动评测",
      agent_launch_btn: "启动运行",
      agent_recent_runs: "评测运行历史 (Recent Runs)",
      agent_search_placeholder: "搜索运行记录（模型、框架、状态）...",
      filter_company: "厂商 / 框架",
      filter_model: "模型",
      filter_status: "状态",
      filter_starred: "收藏",
      filter_sort: "排序方式",
      filter_show: "每页显示",
      all: "全部",
      sort_newest: "最新优先",
      sort_oldest: "最早优先",
      sort_actions: "最多行动数",
      sort_rooms: "最多探索房间",
      sort_gems: "最多收集宝石",
      pager_prev: "← 上一页",
      pager_next: "下一页 →",
      metric_moves: "行动数",
      metric_gems: "宝石数",
      metric_rooms: "探索房间",
      no_matching_runs: "没有匹配的运行记录。",
      no_runs_yet: "暂无运行记录。"
    },
    en: {
      brand: "Maze Bench",
      nav_build: "Build and Play",
      nav_agent: "Agent",
      nav_train: "Train",
      home_build_title: "Build and Play",
      home_build_copy: "Create, edit, and play the official Maze Bench environment or your local drafts.",
      home_external_title: "External Play (Local MCP)",
      home_external_copy: "Connect Codex, Claude Desktop, or local MCP to play and watch live in 3D (Unverified).",
      home_agent_title: "Agent",
      home_agent_copy: "Run a model through isolated, named game controls and watch live.",
      home_train_title: "Train",
      home_train_copy: "Train models on Maze Bench with Prime Verifiers.",
      ext_badge_unverified: "EXTERNAL / UNVERIFIED",
      ext_landing_title: "External Play — Local MCP",
      ext_landing_subtitle: "Control the authoritative MazeBench game session locally via stdio MCP (Codex, Claude Desktop, etc.) and spectate the full 3D game in real time.",
      ext_active_session: "Active Session:",
      ext_created_at: "Created:",
      ext_spectate_btn: "Watch / Spectate 3D →",
      ext_no_active_session: "No active session right now. Create one below or launch MCP.",
      ext_mcp_config_title: "MCP Configuration",
      ext_mcp_config_desc: "Add the following to your Codex or Claude Desktop configuration:",
      create_session_title: "Create External Play Session",
      duration_label: "Duration Limit (minutes)",
      win_threshold_label: "Win Threshold (gems)",
      model_name_label: "Model Name",
      model_name_placeholder: "e.g. Gemini 2.5 Flash / Claude 3.7 Sonnet",
      harness_name_label: "Harness Name",
      harness_name_placeholder: "e.g. antigravity-mcp / stdio-mcp",
      create_btn: "Create Armed Session",
      actions: "Actions",
      gems: "Gems",
      room: "Room",
      rooms: "Rooms",
      waiting_mcp: "Waiting for MCP",
      connected: "Live Stream Connected",
      disconnected: "Disconnected",
      cancel_run: "Cancel Run",
      pause: "Pause",
      play: "Play",
      step: "Step",
      live: "Live",
      feed_title: "AI Action Feed",
      empty_feed: "Waiting for MCP controller to call tools...",
      outcome_won: "WON",
      outcome_timed_out: "TIMED OUT",
      outcome_cancelled: "CANCELLED",
      outcome_failed: "FAILED",
      summary_title: "Game Summary",
      summary_home: "Back to Home",
      summary_replay: "Replay from Beginning",
      summary_download: "Download summary.json",

      // Agent Page
      agent_title: "Agent",
      agent_new_run: "New Run",
      agent_step_harness: "Harness",
      agent_harness_note: "Choose a harness. Prime supplies inference by default.",
      agent_run_through: "Run through",
      agent_step_model: "Model",
      agent_step_reasoning: "Reasoning effort",
      agent_step_target: "Target environment",
      agent_step_settings: "Run settings",
      agent_step_run: "Run",
      agent_launch_btn: "Launch",
      agent_recent_runs: "Recent runs",
      agent_search_placeholder: "Search runs…",
      filter_company: "Company",
      filter_model: "Model",
      filter_status: "Status",
      filter_starred: "Starred",
      filter_sort: "Sort",
      filter_show: "Show",
      all: "All",
      sort_newest: "Newest",
      sort_oldest: "Oldest",
      sort_actions: "Most Actions",
      sort_rooms: "Most Rooms",
      sort_gems: "Most Gems",
      pager_prev: "← Prev",
      pager_next: "Next →",
      metric_moves: "Moves",
      metric_gems: "Gems",
      metric_rooms: "Rooms",
      no_matching_runs: "No matching runs.",
      no_runs_yet: "No runs yet."
    }
  };

  const STORAGE_KEY = "mazebench_lang";
  let currentLang = "zh";

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "zh") {
      currentLang = saved;
    } else {
      currentLang = "zh";
    }
  } catch (_e) {
    currentLang = "zh";
  }

  function t(key, params) {
    const dict = I18N_DICT[currentLang] || I18N_DICT.zh;
    let str = dict[key] || (I18N_DICT.en && I18N_DICT.en[key]) || key;
    if (params && typeof params === "object") {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
      }
    }
    return str;
  }

  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (key) {
        el.textContent = t(key);
      }
    });

    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const key = el.getAttribute("data-i18n-placeholder");
      if (key) {
        el.setAttribute("placeholder", t(key));
      }
    });

    document.querySelectorAll(".lang-toggle-btn").forEach((btn) => {
      btn.textContent = currentLang === "zh" ? "🌐 中文" : "🌐 English";
      btn.title = currentLang === "zh" ? "当前：中文（点击切换为 English）" : "Current: English (Click to switch to Chinese)";
    });
  }

  function setLanguage(lang) {
    if (lang !== "zh" && lang !== "en") return;
    currentLang = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (_e) {}
    applyI18n();
    document.dispatchEvent(new CustomEvent("mazebench:langchange", { detail: { lang } }));
  }

  function toggleLanguage() {
    const nextLang = currentLang === "zh" ? "en" : "zh";
    setLanguage(nextLang);
  }

  window.MazeBenchI18n = {
    t,
    getLanguage: () => currentLang,
    setLanguage,
    toggleLanguage,
    applyI18n
  };

  // Attach click handler globally
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".lang-toggle-btn");
    if (btn) {
      e.preventDefault();
      toggleLanguage();
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyI18n);
  } else {
    applyI18n();
  }
})();
