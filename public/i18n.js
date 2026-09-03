(function () {
  "use strict";

  const I18N_DICT = {
    zh: {
      brand: "迷宫基准 (Maze Bench)",
      nav_build: "构建与游玩",
      nav_external: "外部 MCP 游玩",
      nav_agent: "历史记录",
      home_build_title: "构建与游玩",
      home_build_copy: "创建、编辑并游玩官方 Maze Bench 3D 环境或您的本地草稿。",
      home_external_title: "外部 MCP 游玩 (Local MCP)",
      home_external_copy: "连接 Codex、Claude Desktop 或本地 MCP 进行游玩，并在 3D 界面中实时观战（未验证模式）。",
      home_agent_title: "评测历史记录 (Run History)",
      home_agent_copy: "查看智能体在迷宫环境中的历史评测记录、探索热力图与诊断报告。",
      ext_badge_unverified: "外部游玩 / 未验证模式",
      ext_landing_title: "外部 MCP 游玩 (Local MCP)",
      ext_landing_subtitle: "通过标准输入输出 MCP（Codex、Claude Desktop 等）在本地控制权威的 MazeBench 游戏会话，并在三维场景中实时观战。",
      ext_active_session: "当前活跃会话：",
      ext_created_at: "创建时间：",
      ext_spectate_btn: "进入 3D 实时观战 →",
      ext_no_active_session: "当前暂无活跃会话。请先在下方手动创建，再通过 MCP 开始游玩。",
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
      summary_dismiss: "查看棋盘",
      summary_download: "下载结算数据 (JSON)",

      // Agent / History 页面词条
      agent_title: "历史记录",
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
      agent_recent_runs: "评测运行历史 (RECENT RUNS)",
      runs_count_label: "条记录",
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
      no_runs_yet: "暂无运行记录。",
      leaderboard_title: "模型最佳记录荣誉榜 (Leaderboard)",
      leaderboard_desc: "统计有模型名称的运行记录，呈现各模型在探索房间与收集宝石上的巅峰战绩。",
      scope_standard: "🎯 标准 256 步 (≤256 Steps)",
      scope_all: "🌐 全部步数 (All Steps)",
      agg_best_per_model: "🤖 各模型最佳 (Best per Model)",
      agg_all_records: "📋 全部记录 (All Records)",
      rank_most_rooms: "🏛️ 探索最多房间 (Most Rooms)",
      rank_most_gems: "💎 收集最多宝石 (Most Gems)",
      leaderboard_empty: "暂无带模型名称的评测记录。创建场次时输入模型名称（如 Claude 3.7 Sonnet / Gemini 2.5 Flash），即可登上排行榜！",
      leaderboard_rank: "排名",
      leaderboard_model: "模型名称",
      leaderboard_score: "最高成绩",
      leaderboard_moves: "步数",
      leaderboard_view_run: "查看记录",
      rooms_unit: "房间",
      gems_unit: "宝石",
      moves_unit: "步",
      nav_leaderboard: "排行榜",
      master_benchmark_title: "Maze Bench 官方基准环境 v0.7",
      master_benchmark_desc: "权威基准测试世界。此处的修改将直接改变智能体评测所使用的地图。",
      master_benchmark_subtitle: "用于评测智能体的官方基准地图",
      btn_edit: "编辑",
      btn_play: "游玩",
      btn_flyover: "全景鸟瞰",
      levels_unit: "房间",
      my_worlds_title: "我的世界草稿",
      bring_world_title: "导入或复制世界",
      btn_duplicate_master: "复制官方基准环境",
      btn_import_json: "导入世界 JSON",

      // Leaderboard 页面深度汉化
      lb_rankings: "荣誉榜",
      lb_gems_title: "收集宝石数 (GEMS COLLECTED)",
      lb_rooms_title: "探索房间数 (ROOMS VISITED)",
      lb_metric_gems: "💎 宝石",
      lb_metric_rooms: "🏛️ 房间",
      lb_scope_standard: "≤256 步",
      lb_scope_all: "全部步数",
      lb_agg_best: "各模型最佳",
      lb_agg_all: "全部记录",
      lb_detail_title: "评测运行诊断大屏",
      lb_rooms_visited: "探索房间数",
      lb_gems_collected: "收集宝石数",
      lb_moves: "行动步数",
      lb_max_actions: "步数上限",
      lb_status: "运行状态",
      lb_open_run: "查看完整评测 →",
      lb_select_inspect: "在上方选择一项运行以查看详细诊断报告与探索热力图。",
      lb_empty_title: "暂无带模型名称的评测记录",
      lb_empty_desc: "创建场次或通过 MCP 运行评测时输入模型名称，即可登上荣誉榜！",
      lb_category_exploration: "探索维度",
      lb_category_collection: "收集维度",
      lb_category_novelty: "过去 100 步滑动平均",
      lb_novelty_title: "棋盘状态新颖度",
      lb_category_trajectory: "行动轨迹",
      lb_heatmap_title: "行动轨迹热力图",
      lb_unique_cells_suffix: "个独立单元格",
      lb_step_prefix: "第",
      lb_step_suffix: "步",
      lb_bar_description: "按 MazeBench 完成度比例排名的横向柱状排行榜。"
    },
    en: {
      brand: "Maze Bench",
      nav_build: "Build and Play",
      nav_external: "External Play",
      nav_agent: "History",
      nav_leaderboard: "Leaderboard",
      master_benchmark_title: "Maze Bench Environment v0.7",
      master_benchmark_desc: "The master benchmark world. Edits here change the world agents are scored on.",
      master_benchmark_subtitle: "The world agents are benchmarked on",
      btn_edit: "Edit",
      btn_play: "Play",
      btn_flyover: "Flyover",
      levels_unit: "LEVELS",
      my_worlds_title: "My Worlds",
      bring_world_title: "Bring In A World",
      btn_duplicate_master: "Duplicate Maze Bench Environment",
      btn_import_json: "Import World JSON",
      home_build_title: "Build and Play",
      home_build_copy: "Create, edit, and play the official Maze Bench environment or your local drafts.",
      home_external_title: "External Play (Local MCP)",
      home_external_copy: "Connect Codex, Claude Desktop, or local MCP to play and watch live in 3D (Unverified).",
      home_agent_title: "Run History",
      home_agent_copy: "Inspect agent run history, trajectory heatmaps, and board diagnostics.",
      ext_badge_unverified: "EXTERNAL / UNVERIFIED",
      ext_landing_title: "External Play — Local MCP",
      ext_landing_subtitle: "Control the authoritative MazeBench game session locally via stdio MCP (Codex, Claude Desktop, etc.) and spectate the full 3D game in real time.",
      ext_active_session: "Active Session:",
      ext_created_at: "Created:",
      ext_spectate_btn: "Spectate in 3D →",
      ext_no_active_session: "No active session. Create one below to connect via MCP.",
      ext_mcp_config_title: "MCP Client Configuration",
      ext_mcp_config_desc: "Add this configuration to your Codex or Claude Desktop client:",
      create_session_title: "Create External Play Session",
      duration_label: "Duration Limit (minutes)",
      win_threshold_label: "Win Threshold (gems to collect)",
      model_name_label: "Model Name",
      model_name_placeholder: "e.g., Gemini 2.5 Flash / Claude 3.7 Sonnet",
      harness_name_label: "Harness Name",
      harness_name_placeholder: "e.g., antigravity-mcp / stdio-mcp",
      create_btn: "Create & Start Session",
      actions: "Actions",
      gems: "Gems",
      room: "Room",
      rooms: "Rooms",
      waiting_mcp: "Waiting for MCP Client",
      connected: "Live Connected",
      disconnected: "Disconnected",
      cancel_run: "Cancel Run",
      pause: "Pause",
      play: "Play",
      step: "Step",
      live: "Live",
      feed_title: "Agent Actions",
      empty_feed: "Waiting for actions from the MCP controller...",
      outcome_won: "Won",
      outcome_timed_out: "Timed Out",
      outcome_cancelled: "Cancelled",
      outcome_failed: "Failed",
      summary_title: "Game Summary",
      summary_home: "Back to Home",
      summary_replay: "Replay from Beginning",
      summary_dismiss: "View Board",
      summary_download: "Download summary.json",

      // Agent / History Page
      agent_title: "History",
      agent_new_run: "New run",
      agent_step_harness: "Harness",
      agent_harness_note: "Choose a harness. Prime supplies inference by default.",
      agent_run_through: "Run through",
      agent_step_model: "Model",
      agent_step_reasoning: "Reasoning Effort",
      agent_step_target: "Target",
      agent_step_settings: "Settings",
      agent_step_run: "Run",
      agent_launch_btn: "Launch Run",
      agent_recent_runs: "Recent Runs",
      runs_count_label: "runs",
      agent_search_placeholder: "Search runs by model, harness, status...",
      filter_company: "Harness / Company",
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
      no_runs_yet: "No runs yet.",
      leaderboard_title: "Model Leaderboard & Best Records",
      leaderboard_desc: "Rankings for benchmark runs with declared model names in exploration and gem collection.",
      scope_standard: "🎯 Standard ≤256 Steps",
      scope_all: "🌐 All Steps",
      agg_best_per_model: "🤖 Best per Model",
      agg_all_records: "📋 All Records",
      rank_most_rooms: "🏛️ Most Rooms Explored",
      rank_most_gems: "💎 Most Gems Collected",
      leaderboard_empty: "No benchmark runs with a declared model name yet. Enter a model name when launching or creating a session to compete on the leaderboard!",
      leaderboard_rank: "Rank",
      leaderboard_model: "Model Name",
      leaderboard_score: "Score",
      leaderboard_moves: "Steps",
      leaderboard_view_run: "View Run",
      rooms_unit: "rooms",
      gems_unit: "gems",
      moves_unit: "moves",

      // Leaderboard page keys
      lb_rankings: "RANKINGS",
      lb_gems_title: "GEMS COLLECTED",
      lb_rooms_title: "ROOMS VISITED",
      lb_metric_gems: "Gems",
      lb_metric_rooms: "Rooms",
      lb_scope_standard: "≤256 Steps",
      lb_scope_all: "All Steps",
      lb_agg_best: "Best per Model",
      lb_agg_all: "All Records",
      lb_detail_title: "Run Detail",
      lb_select_inspect: "Select a run above to inspect its diagnostics and player visit heatmap.",
      lb_rooms_visited: "Rooms visited",
      lb_gems_collected: "Gems collected",
      lb_moves: "Moves",
      lb_max_actions: "Max actions",
      lb_status: "Status",
      lb_open_run: "Open agent run →",
      lb_empty_title: "No named agent runs yet",
      lb_empty_desc: "Specify a model name when launching runs or via MCP to appear on the leaderboard!",
      lb_category_exploration: "EXPLORATION",
      lb_category_collection: "COLLECTION",
      lb_category_novelty: "ROLLING AVERAGE OVER THE LAST 100 MOVES",
      lb_novelty_title: "Board-state novelty",
      lb_category_trajectory: "TRAJECTORY",
      lb_heatmap_title: "Player visit heatmap",
      lb_unique_cells_suffix: "unique cells",
      lb_step_prefix: "Step",
      lb_step_suffix: "",
      lb_bar_description: "A horizontal bar leaderboard ranked by the share of MazeBench completed."
    }
  };

  const STORAGE_KEY = "mazebench_locale";
  let currentLang = localStorage.getItem(STORAGE_KEY) || "zh";

  function getLang() {
    return currentLang;
  }

  function setLang(lang) {
    if (lang !== "zh" && lang !== "en") return;
    currentLang = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {}
    applyI18n();
    document.dispatchEvent(new CustomEvent("languagechange", { detail: { lang } }));
  }

  function toggleLang() {
    setLang(currentLang === "zh" ? "en" : "zh");
  }

  function t(key, fallback) {
    const dict = I18N_DICT[currentLang] || I18N_DICT.zh;
    if (dict && key in dict) {
      return dict[key];
    }
    const enDict = I18N_DICT.en;
    if (enDict && key in enDict) {
      return enDict[key];
    }
    return fallback !== undefined ? fallback : key;
  }

  function formatTemplate(key, params, fallback) {
    let str = t(key, fallback);
    if (!params) return str;
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp("{" + k + "}", "g"), String(v));
    }
    return str;
  }

  const DYNAMIC_REPLACEMENTS = [
    { selector: "body.page-build .page-head h1", zh: "构建与游玩", en: "Build and Play" },
    { selector: "body.page-build .page-head .page-sub", zh: "所有世界草稿均保存在本地仓库 games/ 目录下，除非您主动推送，否则绝不会发布到外部。", en: "Worlds live in this repo under games/ and never publish anywhere unless you push them." },
    { selector: "section[aria-label='Maze Bench Environment v0.7'] > h2", zh: "Maze Bench 官方基准环境 v0.7", en: "Maze Bench Environment v0.7" },
    { selector: "section[aria-label='Maze Bench Environment v0.7'] > p.muted", zh: "权威基准测试世界。此处的修改将直接改变智能体评测所使用的地图。", en: "The master benchmark world. Edits here change the world agents are scored on." },
    { selector: "section[aria-label='My worlds'] > h2", zh: "我的世界草稿", en: "My Worlds" },
    { selector: "section.build-import-panel > h2", zh: "导入或复制世界", en: "Bring In A World" },
    { selector: "#copy-master", zh: "复制官方基准环境", en: "Duplicate Maze Bench Environment" },
    { selector: "#import-world", zh: "导入世界 JSON", en: "Import World JSON" },
    { selector: ".world-card .card-title", zh: "Maze Bench 官方基准环境 v0.7", en: "Maze Bench Environment v0.7", matchText: "Maze Bench Environment v0.7" },
    { selector: ".world-card .card-by", zh: "用于评测智能体的官方基准地图", en: "The world agents are benchmarked on", matchText: "The world agents are benchmarked on" }
  ];

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

    // 动态页面元素双语切换
    DYNAMIC_REPLACEMENTS.forEach(({ selector, zh, en, matchText }) => {
      document.querySelectorAll(selector).forEach((el) => {
        if (!matchText || el.textContent.trim() === matchText || el.textContent.trim() === zh) {
          el.textContent = currentLang === "zh" ? zh : en;
        }
      });
    });

    // 卡片动作按钮（Edit / Play / Flyover）
    document.querySelectorAll(".world-card .card-actions a.button").forEach((btn) => {
      const txt = btn.textContent.trim();
      if (currentLang === "zh") {
        if (txt === "Edit") btn.textContent = "编辑";
        else if (txt === "Play") btn.textContent = "游玩";
        else if (txt === "Flyover") btn.textContent = "全景鸟瞰";
      } else {
        if (txt === "编辑") btn.textContent = "Edit";
        else if (txt === "游玩") btn.textContent = "Play";
        else if (txt === "全景鸟瞰") btn.textContent = "Flyover";
      }
    });

    // 卡片统计信息 (256 levels -> 256 房间)
    document.querySelectorAll(".world-card .card-stats span").forEach((stat) => {
      const raw = stat.innerHTML;
      if (currentLang === "zh") {
        stat.innerHTML = raw.replace(/\blevels?\b/gi, "房间");
      } else {
        stat.innerHTML = raw.replace(/房间/g, "levels");
      }
    });

    // 徽标 (ENVIRONMENT -> 基准环境)
    document.querySelectorAll(".screen-badges .badge").forEach((badge) => {
      if (badge.textContent.trim() === "ENVIRONMENT" && currentLang === "zh") {
        badge.textContent = "基准环境";
      } else if (badge.textContent.trim() === "基准环境" && currentLang === "en") {
        badge.textContent = "ENVIRONMENT";
      }
    });

    document.querySelectorAll(".lang-toggle-btn").forEach((btn) => {
      btn.textContent = currentLang === "zh" ? "🌐 中文" : "🌐 English";
      btn.title = currentLang === "zh" ? "当前：中文（点击切换为 English）" : "Current: English (Click to switch to Chinese)";
    });
  }

  window.i18n = {
    getLang,
    setLang,
    toggleLang,
    t,
    formatTemplate,
    applyI18n,
    isZh: () => currentLang === "zh"
  };

  document.addEventListener("DOMContentLoaded", () => {
    applyI18n();

    document.querySelectorAll(".lang-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        toggleLang();
      });
    });
  });
})();
