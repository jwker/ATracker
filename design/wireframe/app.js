// 线框原型的交互与渲染。
(function (g) {
  'use strict';
  const W = g.WF;

  /* ---------- 数字格式：三种单位 ---------- */
  const A = n => {
    const a = Math.abs(n);
    if (a >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
    if (a >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
    return Math.round(n).toLocaleString('en-US');
  };
  const B = n => {
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + ' B';
    if (a >= 1e6) return (n / 1e6).toFixed(1) + ' M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + ' K';
    return String(Math.round(n));
  };
  const C = n => Math.round(n).toLocaleString('en-US');
  let unit = 'a';
  const fmtTok = n => unit === 'a' ? A(n) : unit === 'b' ? B(n) : C(n);
  const fmtPct = n => (n * 100).toFixed(1) + '%';

  /* ---------- 价格 ---------- */
  // 单位：美元 / 百万 token。null 表示没有配置价格。
  const PRICE = {
    'gpt-5.6-sol': { input: 1.25, output: 10, cache_read: 0.125, cache_write: 1.25 },
    'deepseek-v4-pro': { input: 1.32, output: 3.96, cache_read: 0.044, cache_write: 1.32 },
    'MiniMax-M3': { input: 0.3137, output: 1.2549, cache_read: 0.0627, cache_write: 0 },
    'claude-opus-4-8': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    'glm-5.3-flash': { input: 0.15, output: 0.5, cache_read: 0.03, cache_write: 0 },
    'MiniMax-M3.1-Flash': null
  };
  const RATE = 6.5;                       // 固定汇率
  const SPLIT = { input: 0.45, output: 0.05, cacheRead: 0.48, cacheWrite: 0.02 };

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

  /* ---------- 聚合 ---------- */
  function aggregate(dateKeys) {
    const out = {
      total: 0, byDir: {}, byModel: {}, usd: 0, priced: 0, unpriced: 0,
      buckets: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, days: dateKeys.length
    };
    W.DIRS.forEach(d => out.byDir[d.path] = 0);
    Object.keys(W.days).forEach(() => {});
    W.MODELS.forEach(m => out.byModel[m.id] = 0);
    dateKeys.forEach(k => {
      const d = W.days[k];
      if (!d) return;
      out.total += d.total;
      W.DIRS.forEach(dir => out.byDir[dir.path] += d.byDir[dir.path] || 0);
      W.MODELS.forEach(m => {
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

  const money = usd => '¥' + (usd * RATE).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const moneyUsd = usd => '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /* ---------- 公共状态 ---------- */
  const state = {
    theme: 'light',
    month: '2026-10',
    sel: null,            // {start:'YYYY-MM-DD', end:'YYYY-MM-DD'} 或 null
    offDirs: new Set(),   // 图例里被关掉的目录
    convId: null         // 对话页选中的会话
  };

  function allKeys() { return Object.keys(W.days); }
  function monthKeys(mk) { return (W.months[mk] ? W.months[mk].days : []); }
  function rangeKeys() {
    if (!state.sel) return monthKeys(state.month);
    const out = []; let d = new Date(state.sel.start); const end = new Date(state.sel.end);
    while (d <= end) { const k = W.key(d); if (W.days[k]) out.push(k); d.setDate(d.getDate() + 1); }
    return out;
  }
  function scopeText() {
    if (!state.sel) {
      const [y, m] = state.month.split('-');
      return y + ' 年 ' + Number(m) + ' 月 · ' + monthKeys(state.month).length + ' 天';
    }
    if (state.sel.start === state.sel.end) return state.sel.start;
    const n = rangeKeys().length;
    return state.sel.start + ' → ' + state.sel.end + ' · ' + n + ' 天';
  }

  /* ---------- 顶栏 ---------- */
  function topbar(current) {
    const NAV = { '日历': [{href:'conversation.html',label:'对话页'},{href:'log.html',label:'日志'}],
                  '对话': [{href:'home.html',label:'回到日历'},{href:'log.html',label:'日志'}],
                  '日志': [{href:'home.html',label:'回到日历'},{href:'conversation.html',label:'对话页'}] };
    const other = NAV[current] || [];
    return '<div class="top">' +
      '<span class="brand">ATracker<small>' + (current || '') + '</small></span>' +
      '<span class="sp"></span>' +
      other.map(o => '<a class="tbtn" href="' + o.href + '">' + o.label + '</a>').join('') +
      '<span class="hint">单位</span>' +
      '<span class="seg" id="unit">' +
        '<button data-u="a" aria-pressed="' + (unit === 'a') + '">中文</button>' +
        '<button data-u="b" aria-pressed="' + (unit === 'b') + '">缩写</button>' +
        '<button data-u="c" aria-pressed="' + (unit === 'c') + '">千分位</button>' +
      '</span>' +
      '<button class="tbtn" id="theme">切换到' + (state.theme === 'light' ? '暗色' : '亮色') + '</button>' +
      '</div>';
  }

  function bindTop() {
    document.querySelectorAll('#unit button').forEach(b => b.addEventListener('click', () => {
      unit = b.dataset.u; render();
    }));
    const t = document.getElementById('theme');
    if (t) t.addEventListener('click', () => {
      state.theme = state.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = state.theme;
      render();
    });
  }

  /* ---------- 主页面（日历） ---------- */
  function calendarBlock() {
    const [y, m] = state.month.split('-');
    const first = new Date(Number(y), Number(m) - 1, 1);
    const lead = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(Number(y), Number(m), 0).getDate();
    const monthTotal = aggregate(monthKeys(state.month));

    // 图例：按当月用量降序，最多 8 个，其余合并为「其他」
    const ranked = W.DIRS.map(d => ({ dir: d, v: monthTotal.byDir[d.path] || 0 })).sort((a, b) => b.v - a.v);
    const top = ranked.slice(0, 8);
    const restV = ranked.slice(8).reduce((a, b) => a + b.v, 0);

    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<div class="cell out"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const k = y + '-' + W.d2(Number(m)) + '-' + W.d2(d);
      const day = W.days[k];
      const inRange = state.sel && k >= state.sel.start && k <= state.sel.end;
      const isSel = state.sel && k === state.sel.start && k === state.sel.end;
      let stack = '';
      if (day && day.total > 0) {
        const items = ranked.filter(x => x.v > 0 && !state.offDirs.has(x.dir.path)).map(x => ({
          path: x.dir.path, v: day.byDir[x.dir.path] || 0, color: x.dir.color
        })).filter(x => x.v > 0);
        const sum = items.reduce((a, b) => a + b.v, 0) || 1;
        stack = items.map(x => '<i style="width:' + (x.v / sum * 100).toFixed(2) + '%;background:' + x.color + '"></i>').join('');
      }
      cells += '<div class="cell' + (isSel ? ' sel' : (inRange ? ' inrange' : '')) + '" data-k="' + k + '">' +
        '<div class="d">' + d + '</div>' +
        '<div class="n">' + (day ? fmtTok(day.total) : '—') + '</div>' +
        '<div class="stack">' + stack + '</div></div>';
    }

    return '<section class="block"><span class="mark">4.3</span>' +
      '<div class="cal-head">' +
        '<span class="ym">' + y + ' 年 ' + Number(m) + ' 月</span>' +
        '<span class="nav"><button id="prev">‹</button> <button id="next">›</button></span>' +
        '<button class="tbtn" id="today">今天</button>' +
        '<span class="sp"></span>' +
        '<span class="scope">' + scopeText() + '</span>' +
      '</div>' +
      '<div class="legend" id="legend">' +
        top.map(x => '<span class="it" data-p="' + x.dir.path + '" data-off="' + (state.offDirs.has(x.dir.path) ? 1 : 0) + '">' +
          '<span class="sw" style="background:' + x.dir.color + '"></span>' + x.dir.name +
          '<span class="mono" style="color:var(--fg-3)">' + fmtTok(x.v) + '</span></span>').join('') +
        (restV > 0 ? '<span class="it"><span class="sw" style="background:var(--fg-3)"></span>其他<span class="mono" style="color:var(--fg-3)">' + fmtTok(restV) + '</span></span>' : '') +
      '</div>' +
      '<div class="wk-head">' + W.WEEK.map(w => '<div>' + w + '</div>').join('') + '</div>' +
      '<div class="wk">' + cells + '</div></section>';
  }

  function heroBlock() {
    const all = aggregate(allKeys());
    const missing = W.MODELS.filter(m => !PRICE[m.id]).length;
    return '<section class="block"><span class="mark">4.1</span><div class="hero">' +
      '<div class="h-l"><div class="k">总 token</div>' +
        '<div class="v">' + C(all.total) + '</div>' +
        '<div class="s">输入 + 输出 + 缓存命中 + 缓存写入</div>' +
        '<div class="s2">' + A(all.total) + ' · ' + B(all.total) + '</div></div>' +
      '<div class="h-r"><div class="p">' + money(all.usd) + '</div>' +
        '<div class="p2">' + moneyUsd(all.usd) + ' · 汇率 6.5</div>' +
        '<div class="note">' + (missing ? missing + ' 个模型未配置价格，未计入' : '全部模型已配置价格') + '</div></div>' +
      '</div></section>';
  }

  function totalsBlock() {
    const all = aggregate(allKeys());
    const hit = all.total ? all.buckets.cacheRead / all.total : 0;
    const items = [
      ['输入', all.buckets.input, '未命中缓存的部分'],
      ['输出', all.buckets.output, '含推理 token'],
      ['缓存命中', all.buckets.cacheRead, '命中 ' + fmtPct(hit)],
      ['缓存写入', all.buckets.cacheWrite, '首次写入缓存的部分']
    ];
    return '<section class="block"><span class="mark">4.2</span><div class="nums">' +
      items.map(i => '<div><div class="k">' + i[0] + '</div><div class="v">' + fmtTok(i[1]) + '</div>' +
        '<div class="s">' + i[2] + '</div></div>').join('') +
      '</div></section>';
  }

  // 来源 × 模型 交叉表。格子的底色深浅表示量级。
  function matrixBlock(keys) {
    const A = W.AGENTS, M = W.MODELS;
    const cell = {};
    A.forEach(a => { cell[a.id] = {}; M.forEach(m => cell[a.id][m.id] = 0); });
    keys.forEach(k => {
      const d = W.days[k];
      if (!d || !d.byAgentModel) return;
      A.forEach(a => M.forEach(m => { cell[a.id][m.id] += (d.byAgentModel[a.id] || {})[m.id] || 0; }));
    });
    // 列按总量降序，最多 6 列，其余合并成「其他」
    const colTotal = {};
    M.forEach(m => { colTotal[m.id] = A.reduce((s, a) => s + cell[a.id][m.id], 0); });
    const cols = M.filter(m => colTotal[m.id] > 0).sort((x, y) => colTotal[y.id] - colTotal[x.id]);
    const keep = cols.slice(0, 6);
    const rest = cols.slice(6);
    const maxCell = Math.max.apply(null, A.map(a => keep.concat(rest).reduce((s, m) => s + cell[a.id][m.id], 0)).concat([1]));

    const shade = v => {
      if (!v) return 'background:var(--panel-2)';
      const t = v / maxCell;
      const alpha = (0.06 + t * 0.72).toFixed(2);
      return 'background:rgba(47,111,221,' + alpha + ');color:' + (t > 0.42 ? '#fff' : 'var(--fg)') + '';
    };

    let head = '<th class="l">来源</th>';
    keep.forEach(m => { head += '<th class="rh">' + m.id + '</th>'; });
    if (rest.length) head += '<th class="rh">其他</th>';
    head += '<th class="rh">合计</th>';

    let rows = '';
    A.forEach(a => {
      let r = '<tr><td class="l"><span class="dot" style="background:' + a.color + '"></span>' + a.id + '</td>';
      keep.forEach(m => { r += '<td class="cell" data-agent="' + a.id + '" data-model="' + m.id + '" style="' + shade(cell[a.id][m.id]) + '">' + (cell[a.id][m.id] ? fmtTok(cell[a.id][m.id]) : '·') + '</td>'; });
      if (rest.length) {
        const v = rest.reduce((s, m) => s + cell[a.id][m.id], 0);
        r += '<td style="' + shade(v) + '">' + (v ? fmtTok(v) : '·') + '</td>';
      }
      const rowTotal = keep.concat(rest).reduce((s, m) => s + cell[a.id][m.id], 0);
      r += '<td class="total">' + fmtTok(rowTotal) + '</td></tr>';
      rows += r;
    });

    let foot = '<tr><td class="l">合计</td>';
    keep.forEach(m => { foot += '<td class="total">' + fmtTok(colTotal[m.id]) + '</td>'; });
    if (rest.length) foot += '<td class="total">' + fmtTok(rest.reduce((s, m) => s + colTotal[m.id], 0)) + '</td>';
    foot += '<td class="total">' + fmtTok(A.reduce((s, a) => s + keep.concat(rest).reduce((x, m) => x + cell[a.id][m.id], 0), 0)) + '</td></tr>';

    return '<div class="mx">' +
      '<div class="mx-h"><span class="hlabel">来源 × 模型</span>' +
        '<span class="scale">量级低' + [0.1, 0.3, 0.5, 0.7, 0.9].map(t => '<i style="background:rgba(47,111,221,' + t + ')"></i>').join('') + '高</span>' +
        '<span class="spacer"></span><span class="hlabel">点格子看该来源该模型的会话</span></div>' +
      '<table class="mx-t"><thead><tr>' + head + '</tr></thead><tbody>' + rows + foot + '</tbody></table></div>';
  }

  function detailBlock() {
    const keys = rangeKeys();
    const agg = aggregate(keys);
    const b = agg.buckets;
    const comp = [
      { k: '输入', v: b.input, c: 'var(--accent)' },
      { k: '输出', v: b.output, c: 'var(--up)' },
      { k: '缓存命中', v: b.cacheRead, c: 'var(--fg-3)' },
      { k: '缓存写入', v: b.cacheWrite, c: 'var(--line-2)' }
    ];
    const csum = comp.reduce((a, x) => a + x.v, 0) || 1;

    const modelRows = W.MODELS.map(m => ({ k: m.id, v: agg.byModel[m.id] || 0, color: 'var(--accent)', sub: '' }))
      .filter(x => x.v > 0).sort((a, b) => b.v - a.v);
    const maxM = modelRows.length ? modelRows[0].v : 1;

    const dirRows = W.DIRS.map(d => ({ k: d.name, path: d.path, v: agg.byDir[d.path] || 0, color: d.color }))
      .filter(x => x.v > 0).sort((a, b) => b.v - a.v);
    const maxD = dirRows.length ? dirRows[0].v : 1;

    return '<section class="block"><span class="mark">4.4</span><div class="body">' +
      '<div class="scope">' + scopeText() + ' · ' + fmtTok(agg.total) + ' token · ' + money(agg.usd) + '</div>' +
      '<div class="compose">' + comp.map(x => '<i style="width:' + (x.v / csum * 100).toFixed(2) + '%;background:' + x.c + '"></i>').join('') + '</div>' +
      '<div class="hint" style="display:flex;gap:16px;margin-bottom:14px">' +
        comp.map(x => '<span>' + x.k + ' ' + fmtTok(x.v) + '</span>').join('') + '</div>' +
      matrixBlock(keys) +
      '<div class="cols">' +
        '<div class="block" style="margin:0"><span class="mark">4.4.3</span><div class="body"><div class="bars">' +
          modelRows.map(r => '<div class="row"><span class="nm">' + r.k + '</span>' +
            '<span class="track"><i style="width:' + (r.v / maxM * 100).toFixed(1) + '%;background:var(--accent)"></i></span>' +
            '<span class="pc">' + fmtPct(r.v / (agg.total || 1)) + '</span>' +
            '<span class="qty">' + fmtTok(r.v) + '</span></div>').join('') +
          '</div></div></div>' +
        '<div class="block" style="margin:0"><span class="mark">4.4.4</span><div class="body"><div class="bars">' +
          dirRows.map(r => '<div class="row clickable" data-dir="' + r.path + '"><span class="nm">' + r.k + '</span>' +
            '<span class="track"><i style="width:' + (r.v / maxD * 100).toFixed(1) + '%;background:' + r.color + '"></i></span>' +
            '<span class="pc">' + fmtPct(r.v / (agg.total || 1)) + '</span>' +
            '<span class="qty">' + fmtTok(r.v) + '</span></div>').join('') +
          '</div></div></div>' +
      '</div></div></section>';
  }

  function renderHome() {
    // 支持从对话页跳过来时定位到某一天：?d=YYYY-MM-DD
    const q = new URLSearchParams(location.search).get('d');
    if (q && W.days[q] && state.sel === null) {
      state.month = q.slice(0, 7);
      state.sel = { start: q, end: q };
    }
    const root = document.getElementById('root');
    root.innerHTML = topbar('日历') +
      '<div class="page">' + heroBlock() + totalsBlock() + calendarBlock() + detailBlock() + '</div>';
    bindTop();

    document.getElementById('prev').onclick = () => { shiftMonth(-1); render(); };
    document.getElementById('next').onclick = () => { shiftMonth(1); render(); };
    document.getElementById('today').onclick = () => { state.month = '2026-10'; state.sel = null; render(); };

    document.querySelectorAll('.cell[data-k]').forEach(c => c.onclick = () => {
      const k = c.dataset.k;
      if (!state.sel) state.sel = { start: k, end: k };
      else if (state.sel.start === state.sel.end) {
        if (k === state.sel.start) state.sel = null;
        else state.sel = { start: k < state.sel.start ? k : state.sel.start, end: k > state.sel.end ? k : state.sel.end };
      } else state.sel = { start: k, end: k };
      render();
    });

    document.querySelectorAll('#legend .it[data-p]').forEach(it => it.onclick = () => {
      const p = it.dataset.p;
      if (state.offDirs.has(p)) state.offDirs.delete(p); else state.offDirs.add(p);
      render();
    });

    document.querySelectorAll('[data-dir]').forEach(r => r.onclick = () => {
      location.href = 'conversation.html?dir=' + encodeURIComponent(r.dataset.dir);
    });
    document.querySelectorAll('.mx-t td.cell').forEach(td => td.onclick = () => {
      location.href = 'conversation.html?agent=' + encodeURIComponent(td.dataset.agent) +
                      '&model=' + encodeURIComponent(td.dataset.model);
    });
  }

  function shiftMonth(n) {
    const [y, m] = state.month.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    const mk = d.getFullYear() + '-' + W.d2(d.getMonth() + 1);
    if (W.months[mk]) { state.month = mk; state.sel = null; }
  }

  /* ---------- 对话页 ---------- */
  function renderDirectory() {
    const params = new URLSearchParams(location.search);
    const wantDir = params.get('dir');
    const wantAgent = params.get('agent');
    const wantModel = params.get('model');
    const root = document.getElementById('root');
    let convs = W.convs.filter(c => !wantDir || c.dir === wantDir);
    if (wantAgent) convs = convs.filter(c => c.source === wantAgent);
    if (wantModel) convs = convs.filter(c => c.model === wantModel);
    const dirs = W.DIRS.filter(d => convs.some(c => c.dir === d.path));
    let cur = convs.find(c => c.id === state.convId) || convs[0] || null;
    state.convId = cur ? cur.id : null;

    // 左栏
    let side = '<div class="search"><input placeholder="搜索目录、会话摘要"></div>';
    if (wantAgent || wantModel) {
      side += '<div class="filter"><span>筛选</span>' +
        (wantAgent ? '<span class="tag">' + wantAgent + '</span>' : '') +
        (wantModel ? '<span class="tag">' + wantModel + '</span>' : '') +
        '<a href="conversation.html">清除</a></div>';
    }
    dirs.forEach(d => {
      const list = convs.filter(c => c.dir === d.path).sort((a, b) => b.date.localeCompare(a.date));
      const tot = list.reduce((a, c) => a + c.tokens, 0);
      side += '<div class="grp"><div class="grp-h"><span class="sw" style="background:' + d.color + '"></span>' +
        '<span class="nm">' + d.name + '</span><span class="n">' + fmtTok(tot) + '</span></div>' +
        list.map(c => '<a class="cv" data-cid="' + c.id + '"><span class="s">' + c.title + '</span>' +
          '<span class="m">' + c.date + ' · <span class="tag">' + c.source + '</span> · ' + c.turns + ' 轮 · ' + fmtTok(c.tokens) + '</span></a>').join('') +
        '</div>';
    });

    // 右栏
    let right = '';
    if (!convs.length) {
      right = '<section class="block"><div class="body"><div class="placeholder">' +
        '没有符合筛选条件的会话。<br>换个来源或模型，或者点左栏的「清除」。</div></div></section>';
    } else if (cur) {
      const tb = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let usd = 0, unpriced = 0;
      cur.turnList.forEach(t => {
        tb.input += t.input; tb.output += t.output; tb.cacheRead += t.cache;
        const c = modelCost(t.model, t.input + t.output + t.cache);
        if (c.priced) usd += c.usd; else unpriced++;
      });
      tb.cacheWrite = Math.round(tb.input * 0.02);
      const tsum = tb.input + tb.output + tb.cacheRead + tb.cacheWrite || 1;
      const comp = [
        { k: '输入', v: tb.input, c: 'var(--accent)' },
        { k: '输出', v: tb.output, c: 'var(--up)' },
        { k: '缓存命中', v: tb.cacheRead, c: 'var(--fg-3)' },
        { k: '缓存写入', v: tb.cacheWrite, c: 'var(--line-2)' }
      ];

      // 逐日成本
      const byDay = {};
      cur.turnList.forEach(t => {
        const c = modelCost(t.model, t.input + t.output + t.cache);
        byDay[t.time.slice(0, 10)] = (byDay[t.time.slice(0, 10)] || 0) + (c.priced ? c.usd : 0);
      });
      const dayRows = Object.keys(byDay).sort();
      const maxDay = Math.max.apply(null, dayRows.map(k => byDay[k]).concat([0.0001]));

      right =
        /* 一、会话头 */
        '<section class="block"><span class="mark">5.3-一</span><div class="body">' +
          '<div style="display:flex;align-items:flex-start;gap:16px">' +
            '<div style="flex:1"><div style="font-size:16px;font-weight:600">' + cur.title + '</div>' +
            '<div class="hint" style="margin-top:6px;font-family:var(--mono)">' +
              cur.source + ' · ' + cur.model + ' · ' + cur.dirName + '</div></div>' +
            '<button class="tbtn" id="toCal" title="跳到主页面并选中这一天，看到的是当天的全局用量">在日历中查看这天</button>' +
          '</div>' +
          '<div class="kv" style="margin-top:12px">' +
            '<span class="k">时间</span><span class="mono">' + cur.date + ' 09:14 — ' + cur.date + ' ' + (10 + Math.floor(cur.turns / 12)) + ':02</span>' +
            '<span class="k">轮次</span><span class="mono">' + cur.turns + ' 轮 · 工具调用 ' + Math.round(cur.turns * 3.4) + ' 次</span>' +
            '<span class="k">子 agent</span><span class="mono">' + cur.turnList.filter(t => t.sub).length + ' 轮含子 agent</span>' +
          '</div></div></section>' +

        /* 二、token 构成 */
        '<section class="block"><span class="mark">5.3-二</span><div class="body">' +
          '<div class="nums" style="border:1px solid var(--line)">' +
            comp.map(x => '<div><div class="k">' + x.k + '</div><div class="v" style="font-size:22px">' + fmtTok(x.v) + '</div></div>').join('') +
          '</div>' +
          '<div class="compose">' + comp.map(x => '<i style="width:' + (x.v / tsum * 100).toFixed(2) + '%;background:' + x.c + '"></i>').join('') + '</div>' +
          '<div class="hint">合计 ' + fmtTok(tsum) + ' token</div>' +
        '</div></section>' +

        /* 三、成本 */
        '<section class="block"><span class="mark">5.3-三</span><div class="body">' +
          '<div class="price" style="padding:0 0 12px">' +
            '<span class="main" style="font-size:30px">' + money(usd) + '</span>' +
            '<span class="sub">' + moneyUsd(usd) + ' · 汇率 6.5</span>' +
            '<span class="note">' + (unpriced ? unpriced + ' 轮使用了未配置价格的模型，未计入' : '全部轮次已配置价格') + '</span>' +
          '</div>' +
          '<div class="cost-list">' + dayRows.map(k =>
            '<div class="r"><span class="mono">' + k + '</span><span class="t"><i style="width:' + (byDay[k] / maxDay * 100).toFixed(1) + '%"></i></span>' +
            '<span class="mono" style="text-align:right">' + money(byDay[k]) + '</span></div>').join('') + '</div>' +
        '</div></section>' +

        /* 四、逐轮明细 */
        '<section class="block"><span class="mark">5.3-四</span><div class="body">' +
          '<table><thead><tr><th class="l">时间</th><th class="l">模型</th><th>输入</th><th>输出</th><th>缓存命中</th><th>增量成本</th><th class="l">状态</th></tr></thead><tbody>' +
          cur.turnList.map(t => {
            const c = modelCost(t.model, t.input + t.output + t.cache);
            const costCell = c.priced ? money(c.usd) : '—';
            const main = '<tr><td class="l mono">' + t.time + '</td><td class="l">' + t.model + '</td>' +
              '<td>' + C(t.input) + '</td><td>' + C(t.output) + '</td><td>' + C(t.cache) + '</td>' +
              '<td>' + costCell + '</td><td class="l">' +
              (t.state === '失败' ? '<span class="badge err">失败</span>' : t.state === '进行中' ? '<span class="badge ok">进行中</span>' : '<span class="badge">成功</span>') +
              '</td></tr>';
            if (!t.sub) return main;
            let sub = '';
            for (let i = 0; i < t.sub.turns; i++) {
              sub += '<tr class="sub"><td class="l mono">↳ 子 agent</td><td class="l">' + t.model + '</td>' +
                '<td>' + C(Math.round(t.input * 0.4)) + '</td><td>' + C(Math.round(t.output * 0.5)) + '</td>' +
                '<td>' + C(Math.round(t.cache * 0.3)) + '</td><td>' + money(c.priced ? c.usd * 0.12 : 0) + '</td><td class="l"></td></tr>';
            }
            return main + sub;
          }).join('') + '</tbody></table>' +
        '</div></section>' +

        /* 五、口径说明 */
        '<section class="block"><span class="mark">5.3-五</span><div class="body">' +
          '<details><summary class="hint" style="cursor:pointer">口径说明</summary>' +
          '<div class="hint" style="margin-top:8px;line-height:1.9">' +
            'token 分四桶：未缓存输入、输出（含推理）、缓存命中、缓存写入，合计为四者之和。<br>' +
            '日期按本机时区 Asia/Shanghai 折算成自然日，成本按每轮发生的时刻判定波峰波谷。<br>' +
            '子 agent 的用量计入总量并归属到发起它的那一轮，不重复计数。<br>' +
            '价格来自手写成本表 config/pricing.json，单位是美元每百万 token，人民币按固定汇率 6.5 折算。' +
          '</div></details>' +
        '</div></section>';
    }

    root.innerHTML = topbar('对话') +
      '<div class="page"><div class="detail"><aside class="side">' + side + '</aside><div>' + right + '</div></div></div>';
    bindTop();
    document.querySelectorAll('.cv').forEach(el => {
      el.setAttribute('aria-current', String(el.dataset.cid === state.convId));
      el.onclick = () => { state.convId = el.dataset.cid; render(); };
    });
    const toCal = document.getElementById('toCal');
    if (toCal) toCal.onclick = () => { location.href = 'home.html?d=' + cur.date; };
  }

  let PAGE = 'home';
  function render() {
    if (PAGE === 'home') renderHome();
    else if (PAGE === 'log') renderLog();
    else renderDirectory();
  }
  /* ---------- 日志页 ---------- */
  const LOG_STATE = { batch: null, lvl: 'all', src: 'all', q: '' };

  function logBlock() {
    const B = W.BATCHES, L = W.LOGS;
    const last = B[0];
    const levels = [['all', '全部'], ['warn', '警告'], ['err', '错误']];
    const srcs = ['all', '系统', 'codex', 'claude-code', 'pi', 'opencode', 'dsh', '价格'];

    const rows = B.map(b => '<tr' + (LOG_STATE.batch === b.id ? ' class="cur"' : '') + ' data-batch="' + b.id + '">' +
      '<td class="l mono">' + b.at.slice(5) + '</td>' +
      '<td class="l">' + ({ watch: '文件变更', poll: '兜底轮询', manual: '手动' }[b.trigger]) + '</td>' +
      '<td>' + b.ms + ' ms</td><td>' + b.files + '</td><td>' + b.events + '</td>' +
      '<td>' + (b.warn ? '<span class="badge warn">' + b.warn + '</span>' : '0') + '</td>' +
      '<td>' + (b.err ? '<span class="badge err">' + b.err + '</span>' : '0') + '</td>' +
      '<td class="l">' + (b.err ? '<span class="badge err">有错误</span>' : '<span class="badge ok">成功</span>') + '</td></tr>').join('');

    const logs = L.filter(l =>
      (LOG_STATE.batch === null || l.batch === LOG_STATE.batch) &&
      (LOG_STATE.lvl === 'all' || l.lvl === LOG_STATE.lvl) &&
      (LOG_STATE.src === 'all' || l.src === LOG_STATE.src) &&
      (!LOG_STATE.q || l.msg.indexOf(LOG_STATE.q) >= 0));

    return '<div class="page">' +
      /* 状态条 */
      '<section class="block"><span class="mark">6.1</span><div class="nums">' +
        '<div><div class="k">最近扫描</div><div class="v" style="font-size:20px">' + last.at.slice(5) + '</div><div class="s">触发方式 ' + last.trigger + ' · 耗时 ' + (last.ms / 1000).toFixed(1) + ' s</div></div>' +
        '<div><div class="k">写入事件</div><div class="v" style="font-size:20px">' + C(last.events) + '</div><div class="s">去重 ' + last.dup + ' 条</div></div>' +
        '<div><div class="k">跳过文件</div><div class="v" style="font-size:20px">' + last.skipped + '</div><div class="s">指纹未变</div></div>' +
        '<div><div class="k">警告 / 错误</div><div class="v" style="font-size:20px">' + last.warn + ' / ' + last.err + '</div><div class="s">队列 0 / 2000</div></div>' +
      '</div></section>' +

      '<div class="log-wrap">' +
      /* 左：筛选 */
      '<aside class="log-filter"><div class="f-h">筛选</div>' +
        '<div class="f-g"><div class="f-k">级别</div>' +
          levels.map(l => '<button class="chip" data-lvl="' + l[0] + '" aria-pressed="' + (LOG_STATE.lvl === l[0]) + '">' + l[1] + '</button>').join('') + '</div>' +
        '<div class="f-g"><div class="f-k">来源</div>' +
          srcs.map(x => '<button class="chip" data-src="' + x + '" aria-pressed="' + (LOG_STATE.src === x) + '">' + (x === 'all' ? '全部' : x) + '</button>').join('') + '</div>' +
        '<div class="f-g"><div class="f-k">关键字</div><input id="logq" placeholder="搜索日志内容" value="' + LOG_STATE.q + '"></div>' +
        '<div class="f-g"><button class="chip" id="clearf">清除筛选</button></div>' +
        '<div class="f-h">诊断</div>' +
        '<div class="f-d"><span>codex</span><span class="ok">可读 · 3 个文件</span></div>' +
        '<div class="f-d"><span>claude-code</span><span class="ok">可读 · 13 个文件</span></div>' +
        '<div class="f-d"><span>pi</span><span class="ok">可读 · 18 个文件</span></div>' +
        '<div class="f-d"><span>opencode</span><span class="ok">可读 · 数据库</span></div>' +
        '<div class="f-d"><span>dsh</span><span class="ok">可读 · 52 个文件</span></div>' +
      '</aside>' +
      /* 右：批次 + 日志流 */
      '<div class="log-main">' +
        '<section class="block" style="margin:0 0 16px"><span class="mark">6.2</span><div class="body">' +
          '<div class="ph" style="margin-bottom:10px"><h3>扫描批次</h3><span class="hlabel">最近 ' + B.length + ' 次</span><span class="spacer"></span>' +
          '<button class="chip" id="rescan">重新扫描</button></div>' +
          '<table><thead><tr><th class="l">时间</th><th class="l">触发</th><th>耗时</th><th>文件</th><th>事件</th><th>警告</th><th>错误</th><th class="l">结果</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '</div></section>' +
        '<section class="block" style="margin:0"><span class="mark">6.3</span><div class="body">' +
          '<div class="ph" style="margin-bottom:10px"><h3>日志</h3>' +
          '<span class="hlabel">' + logs.length + ' 行' + (LOG_STATE.batch ? ' · 批次 ' + LOG_STATE.batch : '') + '</span></div>' +
          '<div class="loglines">' + logs.map(l =>
            '<div class="ll ' + l.lvl + '"><span class="t mono">' + l.at.slice(5) + '</span>' +
            '<span class="lv">' + ({ ok: '✓', info: '·', warn: '!', err: '×' }[l.lvl]) + '</span>' +
            '<span class="ls">' + l.src + '</span><span class="lm">' + l.msg + '</span></div>').join('') +
          (logs.length ? '' : '<div class="placeholder">没有符合条件的日志行。</div>') +
          '</div></div></section>' +
      '</div></div></div>';
  }

  function renderLog() {
    const root = document.getElementById('root');
    root.innerHTML = topbar('日志') + logBlock();
    bindTop();
    document.querySelectorAll('[data-lvl]').forEach(b => b.onclick = () => { LOG_STATE.lvl = b.dataset.lvl; renderLog(); });
    document.querySelectorAll('[data-src]').forEach(b => b.onclick = () => { LOG_STATE.src = b.dataset.src; renderLog(); });
    document.querySelectorAll('[data-batch]').forEach(t => t.onclick = () => {
      LOG_STATE.batch = LOG_STATE.batch === Number(t.dataset.batch) ? null : Number(t.dataset.batch);
      renderLog();
    });
    const q = document.getElementById('logq');
    if (q) q.oninput = e => { LOG_STATE.q = e.target.value; renderLog(); const i = document.getElementById('logq'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } };
    const c = document.getElementById('clearf');
    if (c) c.onclick = () => { LOG_STATE.batch = null; LOG_STATE.lvl = 'all'; LOG_STATE.src = 'all'; LOG_STATE.q = ''; renderLog(); };
    const r = document.getElementById('rescan');
    if (r) r.onclick = () => { r.textContent = '已触发 · 排队中'; r.setAttribute('aria-pressed', 'true'); };
  }

  g.WFUI = { renderHome, renderDirectory, renderLog, render, state, setPage: p => { PAGE = p; }, setUnit: u => unit = u };
})(window);
