// 线框原型的假数据。结构与真实采集结果一致：按天、按目录、按模型、按会话与轮次。
// 数字是生成的示意值，用来演示排布，不是真实统计。
(function (g) {
  'use strict';

  function mul(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const DIRS = [
    { path: '/Users/jiangjiang/Documents/host/ATracker', name: 'host/ATracker', color: '#4c7fd1' },
    { path: '/Users/jiangjiang/Documents/ai-host/codex-chat-box', name: 'ai-host/codex-chat-box', color: '#4aa38a' },
    { path: '/Users/jiangjiang/Documents/host/my-git', name: 'host/my-git', color: '#c08a3e' },
    { path: '/Users/jiangjiang/Documents/host/deepseek-harness', name: 'host/deepseek-harness', color: '#9a6fc4' },
    { path: '/Users/jiangjiang/Documents/host/pi-web', name: 'host/pi-web', color: '#c76a6a' },
    { path: '/Users/jiangjiang/Documents/ai-host/pi-chat-box', name: 'ai-host/pi-chat-box', color: '#5f8fa8' }
  ];

  // 每个来源有各自的常用模型，这样交叉表才有信息量
  const AGENTS = [
    { id: 'codex', color: '#4c7fd1', prefer: { 'gpt-5.6-sol': 9 } },
    { id: 'claude-code', color: '#4aa38a', prefer: { 'claude-opus-4-8': 9, 'glm-5.3-flash': 2 } },
    { id: 'pi', color: '#c08a3e', prefer: { 'deepseek-v4-pro': 6, 'MiniMax-M3': 4, 'MiniMax-M3.1-Flash': 5 } },
    { id: 'opencode', color: '#c76a6a', prefer: { 'MiniMax-M3': 7, 'MiniMax-M3.1-Flash': 6 } },
    { id: 'dsh', color: '#9a6fc4', prefer: { 'deepseek-v4-pro': 7, 'deepseek-v4-flash': 5, 'glm-5.3-flash': 3 } }
  ];

  const MODELS = [
    { id: 'gpt-5.6-sol', vendor: 'openai', price: 1.25 },
    { id: 'deepseek-v4-pro', vendor: 'deepseek', price: 1.32 },
    { id: 'MiniMax-M3', vendor: 'minimax', price: 0.31 },
    { id: 'claude-opus-4-8', vendor: 'anthropic', price: 5 },
    { id: 'glm-5.3-flash', vendor: 'zai', price: 0.15 },
    { id: 'MiniMax-M3.1-Flash', vendor: 'minimax', price: null } // 未配置价格
  ];

  const SOURCES = ['codex', 'claude-code', 'pi', 'opencode', 'dsh'];
  const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

  const d2 = n => String(n).padStart(2, '0');
  const key = d => d.getFullYear() + '-' + d2(d.getMonth() + 1) + '-' + d2(d.getDate());

  // 覆盖 2025-11 至 2026-10
  const START = new Date(2025, 10, 1);
  const END = new Date(2026, 9, 31);
  const rnd = mul(20261020);

  const days = {};
  const months = {};
  for (let d = new Date(START); d <= END; d.setDate(d.getDate() + 1)) {
    const wd = (d.getDay() + 6) % 7;          // 周一为 0
    const weekend = wd >= 5;
    const ramp = 0.6 + (d.getMonth() - 10 + 12) % 12 / 14; // 越接近当前月越忙
    let total = Math.round((1.6e6 + rnd() * 9e6) * ramp * (weekend ? 0.22 : 1));
    if (rnd() < 0.06) total = 0;               // 偶尔没有用量

    // 按目录切分
    const w = DIRS.map(() => 0.2 + rnd() * 1.6);
    const ws = w.reduce((a, b) => a + b, 0);
    const byDir = {};
    let used = 0;
    DIRS.forEach((dir, i) => {
      const v = i === DIRS.length - 1 ? total - used : Math.round(total * w[i] / ws);
      used += v;
      byDir[dir.path] = Math.max(0, v);
    });

    // 按模型切分
    const w2 = MODELS.map(() => 0.3 + rnd() * 1.4);
    const ws2 = w2.reduce((a, b) => a + b, 0);
    const byModel = {};
    let used2 = 0;
    MODELS.forEach((m, i) => {
      const v = i === MODELS.length - 1 ? total - used2 : Math.round(total * w2[i] / ws2);
      used2 += v;
      byModel[m.id] = Math.max(0, v);
    });

    // 按「来源 × 模型」拆分：先给来源分权重，再给模型分权重
    const wa = AGENTS.map(() => 0.3 + rnd() * 1.6);
    const was = wa.reduce((a, b) => a + b, 0);
    const byAgentModel = {};
    AGENTS.forEach((ag, ai) => {
      const agentTotal = Math.round(total * wa[ai] / was);
      const pref = MODELS.map(m => (ag.prefer[m.id] || 0.4) * (0.4 + rnd() * 1.2));
      const prefs = pref.reduce((a, b) => a + b, 0);
      const inner = {};
      let usedI = 0;
      MODELS.forEach((m, mi) => {
        const v = mi === MODELS.length - 1 ? agentTotal - usedI : Math.round(agentTotal * pref[mi] / prefs);
        usedI += v;
        inner[m.id] = Math.max(0, v);
      });
      byAgentModel[ag.id] = inner;
    });

    const k = key(d);
    days[k] = { date: k, total, byDir, byModel, byAgentModel, wd };
    const mk = k.slice(0, 7);
    (months[mk] = months[mk] || { month: mk, days: [] }).days.push(k);
  }

  // 会话：每个目录 2 到 4 个
  const convs = [];
  let cid = 0;
  DIRS.forEach((dir, di) => {
    const n = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const dayKeys = Object.keys(days);
      const dk = dayKeys[Math.floor(rnd() * dayKeys.length)];
      const day = days[dk];
      const dayTotal = day.byDir[dir.path] || 0;
      if (dayTotal <= 0) continue;
      const src = SOURCES[Math.floor(rnd() * SOURCES.length)];
      // 模型取该来源的常用模型，让交叉表的格子和会话对得上
      const agentDef = AGENTS.find(a => a.id === src);
      const preferred = MODELS.filter(m => (agentDef.prefer[m.id] || 0) > 1).map(m => m.id);
      const model = (preferred.length ? preferred : MODELS.map(m => m.id))[Math.floor(rnd() * (preferred.length || MODELS.length))];
      const turns = 6 + Math.floor(rnd() * 40);
      const tokens = Math.round(dayTotal * (0.25 + rnd() * 0.5));
      const base = [
        '想做一个项目，把本机所有 agent 的 token 用量汇总显示',
        '调研 GitHub REST API 的最新情况，用来开发第三方客户端',
        '把 cost 表改成手写配置文件，顺便核对缓存命中口径',
        '读 DSH 源码，确认会话文件的多帧 zstd 怎么解',
        'pi-web 面板加载慢，定位是哪一步卡住',
        '整理 zstd 帧遍历器的边界情况'
      ][Math.floor(rnd() * 6)];
      const suffix = ['（续）', '（补充）', '（复查）', ''][Math.floor(rnd() * 4)];
      const title = base + suffix;
      const turnsList = [];
      const rnd2 = mul(1000 + cid * 7);
      for (let t = 0; t < turns; t++) {
        const inp = Math.round(tokens / turns * (0.4 + rnd2() * 1.2));
        const out = Math.round(tokens / turns * (0.06 + rnd2() * 0.2));
        const cache = Math.round(inp * (0.5 + rnd2() * 2.4));
        turnsList.push({
          time: dk + ' ' + d2(9 + Math.floor(t / 8)) + ':' + d2((t * 7) % 60),
          model: t % 9 === 8 ? MODELS[Math.floor(rnd2() * MODELS.length)].id : model,
          input: inp, output: out, cache: cache,
          state: rnd2() < 0.05 ? '失败' : (t === turns - 1 ? '进行中' : '成功'),
          sub: t % 11 === 5 ? { turns: 1 + Math.floor(rnd2() * 3) } : null
        });
      }
      convs.push({
        id: 'c' + (cid++), dir: dir.path, dirName: dir.name, color: dir.color,
        source: src, model: model, date: dk, title: title,
        turns: turns, tokens: tokens, turnList: turnsList
      });
    }
  });

  /* ---------- 扫描日志 ---------- */
  const BATCHES = [
    { id: 42, at: '2026-10-20 21:41:02', trigger: 'watch', ms: 1930, files: 21, skipped: 61, events: 4182, dup: 37, warn: 1, err: 0, status: '成功' },
    { id: 41, at: '2026-10-20 21:36:02', trigger: 'poll', ms: 1840, files: 3, skipped: 79, events: 212, dup: 4, warn: 1, err: 0, status: '成功' },
    { id: 40, at: '2026-10-20 21:31:02', trigger: 'poll', ms: 1760, files: 0, skipped: 82, events: 0, dup: 0, warn: 0, err: 0, status: '成功' },
    { id: 39, at: '2026-10-20 20:58:41', trigger: 'manual', ms: 2140, files: 44, skipped: 38, events: 6104, dup: 112, warn: 1, err: 0, status: '成功' },
    { id: 38, at: '2026-10-20 20:31:02', trigger: 'poll', ms: 1610, files: 2, skipped: 80, events: 96, dup: 0, warn: 0, err: 0, status: '成功' },
    { id: 37, at: '2026-10-20 20:06:02', trigger: 'poll', ms: 1590, files: 1, skipped: 81, events: 41, dup: 0, warn: 0, err: 0, status: '成功' },
    { id: 36, at: '2026-10-20 19:26:12', trigger: 'watch', ms: 3820, files: 63, skipped: 19, events: 12804, dup: 8, warn: 2, err: 1, status: '有错误' }
  ];

  const LOGS = [
    { at: '2026-10-20 21:41:02', batch: 42, lvl: 'info', src: '系统', msg: '扫描开始 · 触发方式 watch · 5 个来源' },
    { at: '2026-10-20 21:41:02', batch: 42, lvl: 'info', src: 'codex', msg: '读取 3 个 rollout（zstd）· 解帧 3 / 3 · 解析 612 条 token_count 事件' },
    { at: '2026-10-20 21:41:02', batch: 42, lvl: 'info', src: 'claude-code', msg: '读取 13 个 jsonl · 2 个子 agent 目录 · 父子关系已归并' },
    { at: '2026-10-20 21:41:02', batch: 42, lvl: 'info', src: 'pi', msg: '读取 18 个 jsonl · 3 次模型切换按发生时刻归属' },
    { at: '2026-10-20 21:41:02', batch: 42, lvl: 'info', src: 'opencode', msg: '打开 opencode.db（只读）· 25 条消息' },
    { at: '2026-10-20 21:41:02', batch: 42, lvl: 'info', src: 'dsh', msg: '读取 52 个会话文件 · 多帧 zstd 逐帧解码 · v0 与 v4 格式各一种' },
    { at: '2026-10-20 21:41:02', batch: 42, lvl: 'ok', src: '系统', msg: '4,182 条用量事件已写入 · 去重 37 条 · 跳过 12 条不完整记录' },
    { at: '2026-10-20 21:41:02', batch: 42, lvl: 'warn', src: '价格', msg: '1 个模型未配置价格：MiniMax-M3.1-Flash · 3,412,880 token 成本留空' },
    { at: '2026-10-20 21:41:02', batch: 42, lvl: 'ok', src: '系统', msg: '对账：codex 累计 tokens_used 与 rollout 汇总一致' },
    { at: '2026-10-20 21:41:02', batch: 42, lvl: 'ok', src: '系统', msg: '对账：claude-code cost-state 的 modelUsage 与明细一致' },
    { at: '2026-10-20 21:41:02', batch: 42, lvl: 'info', src: '系统', msg: '聚合并行 4 张表 · 耗时 128 ms · 扫描总耗时 1.9 s' },
    { at: '2026-10-20 20:58:41', batch: 39, lvl: 'info', src: '系统', msg: '扫描开始 · 触发方式 manual（手动触发）· 5 个来源' },
    { at: '2026-10-20 20:58:41', batch: 39, lvl: 'info', src: 'dsh', msg: '读取 52 个会话文件 · 跳过 1 个未变化文件' },
    { at: '2026-10-20 20:58:41', batch: 39, lvl: 'warn', src: 'dsh', msg: '1 个会话文件尾部不完整 · 保留偏移待下次续读' },
    { at: '2026-10-20 20:58:41', batch: 39, lvl: 'warn', src: '价格', msg: '1 个模型未配置价格：MiniMax-M3.1-Flash · 成本留空' },
    { at: '2026-10-20 20:58:41', batch: 39, lvl: 'ok', src: '系统', msg: '6,104 条用量事件已写入 · 去重 112 条' },
    { at: '2026-10-20 19:26:12', batch: 36, lvl: 'info', src: '系统', msg: '扫描开始 · 触发方式 watch · 5 个来源' },
    { at: '2026-10-20 19:26:12', batch: 36, lvl: 'err', src: 'opencode', msg: 'opencode.db 读取失败：database is locked（另一个进程在写）· 本批跳过' },
    { at: '2026-10-20 19:26:12', batch: 36, lvl: 'warn', src: 'codex', msg: '1 个 rollout 解帧到第 41 帧失败（文件被截断）· 已保留偏移' },
    { at: '2026-10-20 19:26:12', batch: 36, lvl: 'warn', src: '价格', msg: '1 个模型未配置价格：MiniMax-M3.1-Flash · 成本留空' },
    { at: '2026-10-20 19:26:12', batch: 36, lvl: 'ok', src: '系统', msg: '12,804 条用量事件已写入 · 去重 8 条 · 跳过 1 个来源' },
    { at: '2026-10-20 21:36:02', batch: 41, lvl: 'info', src: '系统', msg: '扫描开始 · 触发方式 poll（兜底轮询）· 5 个来源' },
    { at: '2026-10-20 21:36:02', batch: 41, lvl: 'info', src: '系统', msg: '79 个文件指纹未变 · 全部跳过 · 本批无新事件' },
    { at: '2026-10-20 21:36:02', batch: 41, lvl: 'ok', src: '系统', msg: '212 条用量事件已写入' }
  ];

  g.WF = { DIRS, MODELS, AGENTS, SOURCES, WEEK, days, months, convs, BATCHES, LOGS, key, d2 };
})(window);
