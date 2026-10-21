// v3 设计稿共用数据层：格式化、聚合、筛选、跨页状态。
// 每个设计稿只负责自己的视觉与排版，计算都在这里。
(function (g) {
  'use strict';
  const W = g.WF;
  const RATE = 6.5;
  const SPLIT = { input: 0.45, output: 0.05, cacheRead: 0.48, cacheWrite: 0.02 };

  // 单位：美元 / 百万 token。null 表示价格表里没有这个模型。
  const PRICE = {
    'gpt-5.6-sol': { input: 1.25, output: 10, cache_read: 0.125, cache_write: 1.25 },
    'deepseek-v4-pro': { input: 1.32, output: 3.96, cache_read: 0.044, cache_write: 1.32 },
    'MiniMax-M3': { input: 0.3137, output: 1.2549, cache_read: 0.0627, cache_write: 0 },
    'claude-opus-4-8': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    'glm-5.3-flash': { input: 0.15, output: 0.5, cache_read: 0.03, cache_write: 0 },
    'MiniMax-M3.1-Flash': null
  };

  const UNITS = [
    { id: 'zh', label: '中文' },
    { id: 'abbr', label: '缩写' },
    { id: 'full', label: '千分位' }
  ];

  const state = {
    view: 'home',
    theme: 'light',
    month: '2026-10',
    sel: null,
    offDirs: [],
    convId: null,
    convFilter: { dir: null, agent: null, model: null },
    convQ: '',
    log: { batch: null, lvl: 'all', src: 'all', q: '' }
  };

  let unit = 'zh';
  let rerender = function () {};

  /* ---------- 数字与钱 ---------- */
  function zh(n) {
    const a = Math.abs(n);
    if (a >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
    if (a >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
    return Math.round(n).toLocaleString('en-US');
  }
  function abbr(n) {
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }
  function full(n) { return Math.round(n).toLocaleString('en-US'); }
  function fmtTok(n) { return unit === 'zh' ? zh(n) : unit === 'abbr' ? abbr(n) : full(n); }
  function fmtPct(n) { return (n * 100).toFixed(1) + '%'; }
  function money(usd) {
    return '¥' + (usd * RATE).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function moneyUsd(usd) {
    return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function modelCost(model, total) {
    const p = PRICE[model];
    if (!p) return { usd: 0, priced: false, buckets: null };
    const b = {
      input: total * SPLIT.input,
      output: total * SPLIT.output,
      cacheRead: total * SPLIT.cacheRead,
      cacheWrite: total * SPLIT.cacheWrite
    };
    const usd = (b.input * p.input + b.output * p.output + b.cacheRead * p.cache_read + b.cacheWrite * p.cache_write) / 1e6;
    return { usd, priced: true, buckets: b };
  }
  function turnCost(t) { return modelCost(t.model, t.input + t.output + t.cache); }

  /* ---------- 日期范围 ---------- */
  function allKeys() { return Object.keys(W.days); }
  function monthMeta(mk) {
    const parts = mk.split('-').map(Number);
    const y = parts[0], m = parts[1];
    const first = new Date(y, m - 1, 1);
    return { y: y, m: m, lead: (first.getDay() + 6) % 7, dim: new Date(y, m, 0).getDate() };
  }
  function monthKeys(mk) { return W.months[mk] ? W.months[mk].days : []; }
  function rangeKeys() {
    if (!state.sel) return monthKeys(state.month);
    const out = [];
    let d = new Date(state.sel.start);
    const end = new Date(state.sel.end);
    while (d <= end) {
      const k = W.key(d);
      if (W.days[k]) out.push(k);
      d.setDate(d.getDate() + 1);
    }
    return out;
  }
  function scopeText() {
    if (!state.sel) {
      const parts = state.month.split('-');
      return parts[0] + ' 年 ' + Number(parts[1]) + ' 月 / ' + monthKeys(state.month).length + ' 天';
    }
    if (state.sel.start === state.sel.end) return state.sel.start;
    return state.sel.start + ' 至 ' + state.sel.end + ' / ' + rangeKeys().length + ' 天';
  }
  function shiftMonth(n) {
    const parts = state.month.split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1 + n, 1);
    const mk = d.getFullYear() + '-' + W.d2(d.getMonth() + 1);
    if (W.months[mk]) { state.month = mk; state.sel = null; }
  }
  function selectDay(k) {
    const s = state.sel;
    if (!s) state.sel = { start: k, end: k };
    else if (s.start === s.end) {
      if (k === s.start) state.sel = null;
      else state.sel = { start: k < s.start ? k : s.start, end: k > s.end ? k : s.end };
    } else state.sel = { start: k, end: k };
  }
  function resetToday() { state.month = '2026-10'; state.sel = null; }

  /* ---------- 聚合 ---------- */
  function aggregate(dateKeys) {
    const out = {
      total: 0, byDir: {}, byModel: {}, usd: 0, priced: 0, unpriced: 0,
      buckets: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, days: dateKeys.length
    };
    W.DIRS.forEach(function (d) { out.byDir[d.path] = 0; });
    W.MODELS.forEach(function (m) { out.byModel[m.id] = 0; });
    dateKeys.forEach(function (k) {
      const d = W.days[k];
      if (!d) return;
      out.total += d.total;
      W.DIRS.forEach(function (dir) { out.byDir[dir.path] += d.byDir[dir.path] || 0; });
      W.MODELS.forEach(function (m) {
        const t = d.byModel[m.id] || 0;
        out.byModel[m.id] += t;
        const c = modelCost(m.id, t);
        if (c.priced) { out.usd += c.usd; out.priced += t; } else { out.unpriced += t; }
        out.buckets.input += t * SPLIT.input;
        out.buckets.output += t * SPLIT.output;
        out.buckets.cacheRead += t * SPLIT.cacheRead;
        out.buckets.cacheWrite += t * SPLIT.cacheWrite;
      });
    });
    return out;
  }

  function legend(keys) {
    const a = aggregate(keys);
    const ranked = W.DIRS.map(function (d, i) {
      return { path: d.path, name: d.name, slot: i, v: a.byDir[d.path] || 0 };
    }).sort(function (x, y) { return y.v - x.v; });
    return { agg: a, ranked: ranked };
  }

  function dayItems(k, ranked) {
    const d = W.days[k];
    if (!d) return [];
    const items = ranked.filter(function (x) {
      return x.v > 0 && state.offDirs.indexOf(x.path) < 0;
    }).map(function (x) {
      return { path: x.path, slot: x.slot, v: d.byDir[x.path] || 0 };
    }).filter(function (x) { return x.v > 0; });
    const sum = items.reduce(function (s, x) { return s + x.v; }, 0) || 1;
    return items.map(function (x) {
      return { path: x.path, slot: x.slot, v: x.v, pct: x.v / sum * 100 };
    });
  }

  function matrixData(keys) {
    const A = W.AGENTS, M = W.MODELS;
    const cell = {};
    A.forEach(function (a) {
      cell[a.id] = {};
      M.forEach(function (m) { cell[a.id][m.id] = 0; });
    });
    keys.forEach(function (k) {
      const d = W.days[k];
      if (!d || !d.byAgentModel) return;
      A.forEach(function (a) {
        M.forEach(function (m) {
          cell[a.id][m.id] += (d.byAgentModel[a.id] || {})[m.id] || 0;
        });
      });
    });
    const colTotal = {};
    M.forEach(function (m) {
      colTotal[m.id] = A.reduce(function (s, a) { return s + cell[a.id][m.id]; }, 0);
    });
    const cols = M.filter(function (m) { return colTotal[m.id] > 0; })
      .sort(function (x, y) { return colTotal[y.id] - colTotal[x.id]; });
    const keep = cols.slice(0, 6);
    const rest = cols.slice(6);
    let maxCell = 1;
    A.forEach(function (a) {
      const v = keep.concat(rest).reduce(function (s, m) { return s + cell[a.id][m.id]; }, 0);
      if (v > maxCell) maxCell = v;
    });
    function rowTotal(a) {
      return keep.concat(rest).reduce(function (s, m) { return s + cell[a.id][m.id]; }, 0);
    }
    function restColTotal(a) {
      return rest.reduce(function (s, m) { return s + cell[a.id][m.id]; }, 0);
    }
    return {
      agents: A, keep: keep, rest: rest, cell: cell, colTotal: colTotal,
      maxCell: maxCell, rowTotal: rowTotal, restColTotal: restColTotal
    };
  }

  function detailData(keys) {
    const a = aggregate(keys);
    const comp = [
      { key: 'input', label: '输入', v: a.buckets.input },
      { key: 'output', label: '输出', v: a.buckets.output },
      { key: 'cacheRead', label: '缓存命中', v: a.buckets.cacheRead },
      { key: 'cacheWrite', label: '缓存写入', v: a.buckets.cacheWrite }
    ];
    const models = W.MODELS.map(function (m) {
      return { id: m.id, v: a.byModel[m.id] || 0 };
    }).filter(function (x) { return x.v > 0; }).sort(function (x, y) { return y.v - x.v; });
    const dirs = W.DIRS.map(function (d, i) {
      return { name: d.name, path: d.path, slot: i, v: a.byDir[d.path] || 0 };
    }).filter(function (x) { return x.v > 0; }).sort(function (x, y) { return y.v - x.v; });
    return {
      agg: a, comp: comp, models: models, dirs: dirs,
      modelMax: models.length ? models[0].v : 1,
      dirMax: dirs.length ? dirs[0].v : 1
    };
  }

  /* ---------- 对话页 ---------- */
  function convGroups() {
    const f = state.convFilter;
    const q = (state.convQ || '').trim().toLowerCase();
    const convs = W.convs.filter(function (c) {
      if (f.dir && c.dir !== f.dir) return false;
      if (f.agent && c.source !== f.agent) return false;
      if (f.model && c.model !== f.model) return false;
      if (q && (c.title + ' ' + c.dirName + ' ' + c.source).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    const dirs = W.DIRS.filter(function (d) { return convs.some(function (c) { return c.dir === d.path; }); });
    let cur = convs.find(function (c) { return c.id === state.convId; }) || convs[0] || null;
    state.convId = cur ? cur.id : null;
    const groups = dirs.map(function (d) {
      const list = convs.filter(function (c) { return c.dir === d.path; })
        .sort(function (a, b) { return b.date.localeCompare(a.date); });
      return {
        dir: d,
        list: list,
        total: list.reduce(function (s, c) { return s + c.tokens; }, 0)
      };
    });
    return { convs: convs, groups: groups, cur: cur };
  }

  function convStats(cur) {
    const tb = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let usd = 0, unpriced = 0;
    cur.turnList.forEach(function (t) {
      tb.input += t.input;
      tb.output += t.output;
      tb.cacheRead += t.cache;
      const c = turnCost(t);
      if (c.priced) usd += c.usd; else unpriced++;
    });
    tb.cacheWrite = Math.round(tb.input * 0.02);
    const tsum = tb.input + tb.output + tb.cacheRead + tb.cacheWrite || 1;
    const byDay = {};
    cur.turnList.forEach(function (t) {
      const k = t.time.slice(0, 10);
      const c = turnCost(t);
      byDay[k] = (byDay[k] || 0) + (c.priced ? c.usd : 0);
    });
    const dayRows = Object.keys(byDay).sort();
    const maxDay = Math.max.apply(null, dayRows.map(function (k) { return byDay[k]; }).concat([0.0001]));
    return { tb: tb, usd: usd, unpriced: unpriced, tsum: tsum, byDay: byDay, dayRows: dayRows, maxDay: maxDay };
  }

  /* ---------- 日志页 ---------- */
  const DIAG = [
    { name: 'codex', text: '可读 / 3 个文件', ok: true },
    { name: 'claude-code', text: '可读 / 13 个文件', ok: true },
    { name: 'pi', text: '可读 / 18 个文件', ok: true },
    { name: 'opencode', text: '可读 / 数据库', ok: true },
    { name: 'dsh', text: '可读 / 52 个文件', ok: true }
  ];
  const SRC = ['all', '系统', 'codex', 'claude-code', 'pi', 'opencode', 'dsh', '价格'];

  function logData() {
    const l = state.log;
    const logs = W.LOGS.filter(function (x) {
      if (l.batch !== null && x.batch !== l.batch) return false;
      if (l.lvl !== 'all' && x.lvl !== l.lvl) return false;
      if (l.src !== 'all' && x.src !== l.src) return false;
      if (l.q && x.msg.indexOf(l.q) < 0) return false;
      return true;
    });
    return { last: W.BATCHES[0], batches: W.BATCHES, logs: logs, diag: DIAG, src: SRC };
  }

  /* ---------- 页面状态 ---------- */
  function go(view, opts) {
    state.view = view;
    if (opts) {
      if (opts.clearConv) {
        state.convFilter = { dir: null, agent: null, model: null };
        state.convQ = '';
        state.convId = null;
      }
      if (opts.dir !== undefined || opts.agent !== undefined || opts.model !== undefined) {
        state.convFilter = { dir: null, agent: null, model: null };
        state.convFilter.dir = opts.dir || null;
        state.convFilter.agent = opts.agent || null;
        state.convFilter.model = opts.model || null;
        state.convId = null;
      }
      if (opts.convId) state.convId = opts.convId;
      if (opts.day) {
        state.month = opts.day.slice(0, 7);
        state.sel = { start: opts.day, end: opts.day };
      }
    }
    rerender();
  }
  function setLog(patch) {
    Object.keys(patch).forEach(function (k) { state.log[k] = patch[k]; });
    rerender();
  }
  function setUnit(u) { unit = u; rerender(); }
  function toggleTheme() {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', state.theme);
    rerender();
  }
  function mount(fn) { rerender = fn; }
  function refresh() { rerender(); }

  state.theme = document.documentElement.getAttribute('data-theme') || 'light';
  try {
    const q = new URLSearchParams(location.search);
    const v = q.get('view');
    if (v === 'home' || v === 'conv' || v === 'log') state.view = v;
    const u = q.get('unit');
    if (UNITS.some(function (x) { return x.id === u; })) unit = u;
    const t = q.get('theme');
    if (t === 'light' || t === 'dark') {
      state.theme = t;
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (e) {}

  g.TK = {
    W: W, state: state, UNITS: UNITS, PRICE: PRICE, RATE: RATE,
    zh: zh, abbr: abbr, full: full, fmtTok: fmtTok, fmtPct: fmtPct,
    money: money, moneyUsd: moneyUsd, modelCost: modelCost, turnCost: turnCost,
    allKeys: allKeys, monthMeta: monthMeta, monthKeys: monthKeys, rangeKeys: rangeKeys,
    scopeText: scopeText, shiftMonth: shiftMonth, selectDay: selectDay, resetToday: resetToday,
    aggregate: aggregate, legend: legend, dayItems: dayItems, matrixData: matrixData, detailData: detailData,
    convGroups: convGroups, convStats: convStats, logData: logData,
    go: go, setLog: setLog, setUnit: setUnit, toggleTheme: toggleTheme, mount: mount, refresh: refresh,
    unit: function () { return unit; }
  };
})(window);
