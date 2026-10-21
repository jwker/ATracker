// ATracker 前端。视图代码移植自 design/v3/02-receipt.html，数据层换成真接口。
// 主题与明暗是两个维度：data-theme 决定风格，data-mode 决定明暗。

const S = {
  view: 'home',
  theme: 'light',
  month: new Date().toISOString().slice(0, 7),
  sel: null,            // {a:'YYYY-MM-DD', b:'YYYY-MM-DD'}
  offDirs: [],          // 图例里被静音的目录
  convId: null,
  convFilter: { dir: null, agent: null, model: null },
  convQ: '',
  log: { batch: null, lvl: 'all', src: 'all', q: '' }
};

let unit = 'zh';
const D = { total: null, cal: null, agg: null, matrix: null, conv: null, convDetail: null, log: null, doctor: null };

/* ---------- 取数 ---------- */

async function api(path, params) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

function range() {
  if (S.sel) return { from: S.sel.a, to: S.sel.b };
  const [y, m] = S.month.split('-').map(Number);
  const dim = new Date(y, m, 0).getDate();
  const pad = n => String(n).padStart(2, '0');
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(dim)}` };
}

async function load() {
  if (S.view === 'home') {
    const rg = range();
    const [total, cal, agg, matrix] = await Promise.all([
      api('/api/total'),
      api('/api/calendar', { month: S.month }),
      api('/api/aggregate', rg),
      api('/api/matrix', rg)
    ]);
    Object.assign(D, { total, cal, agg, matrix });
  } else if (S.view === 'conv') {
    const conv = await api('/api/conversations', {
      dir: S.convFilter.dir, agent: S.convFilter.agent,
      model: S.convFilter.model, q: S.convQ
    });
    D.conv = conv;
    const groups = conv.groups;
    const flat = groups.flatMap(g => g.list);
    const cur = flat.find(c => c.id === S.convId) ?? flat[0] ?? null;
    S.convId = cur ? cur.id : null;
    D.convDetail = cur ? await api('/api/conversation', { id: cur.id }) : null;
  } else {
    const [log, doctor] = await Promise.all([
      api('/api/logs', { batch: S.log.batch, level: S.log.lvl, source: S.log.src, q: S.log.q }),
      api('/api/doctor')
    ]);
    D.log = log;
    D.doctor = doctor;
  }
}

/* ---------- 格式化（从 core 移植，单位与货币口径以接口为准） ---------- */

const zh = n => { const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (a >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return Math.round(n).toLocaleString('en-US'); };
const abbr = n => { const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n)); };
const full = n => Math.round(n).toLocaleString('en-US');
const fmtTok = n => unit === 'zh' ? zh(n) : unit === 'abbr' ? abbr(n) : full(n);
const fmtPct = r => (r * 100).toFixed(1) + '%';
const RATE = 6.5;
const money = cny => '¥' + (cny ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyUsd = cny => '$' + ((cny ?? 0) / RATE).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pad = n => String(n).padStart(2, '0');
function monthMeta(mk) {
  const [y, m] = mk.split('-').map(Number);
  return { y, m, dim: new Date(y, m, 0).getDate(), lead: (new Date(y, m - 1, 1).getDay() + 6) % 7 };
}
function dayOf(ts) {
  const d = new Date(ts);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function hhmm(ts) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
}
function fmtTime(ts) {
  if (!ts) return '';
  return dayOf(ts) + ' ' + hhmm(ts);
}
function scopeText() {
  if (!S.sel) {
    const meta = monthMeta(S.month);
    return `${meta.y} 年 ${meta.m} 月 / ${meta.dim} 天`;
  }
  if (S.sel.a === S.sel.b) return S.sel.a;
  const n = Math.round((new Date(S.sel.b) - new Date(S.sel.a)) / 86400000) + 1;
  return `${S.sel.a} → ${S.sel.b} / ${n} 天`;
}

/* ---------- 适配层：把接口载荷转成视图代码期望的形状 ---------- */

const TK = {
  UNITS: [{ id: 'zh', label: '中文' }, { id: 'abbr', label: '缩写' }, { id: 'full', label: '千分位' }],
  unit: () => unit,
  fmtTok, fmtPct, money, moneyUsd, monthMeta, scopeText, dayOf,

  aggregate() {
    const t = D.total;
    return {
      total: t.total,
      usd: t.costUsd,
      buckets: t.buckets,
      days: D.agg ? D.agg.days : 0
    };
  },

  detailData() {
    const a = D.agg;
    const comp = [
      { key: 'input', label: '输入', v: a.buckets.input },
      { key: 'output', label: '输出', v: a.buckets.output },
      { key: 'cacheRead', label: '缓存命中', v: a.buckets.cacheRead },
      { key: 'cacheWrite', label: '缓存写入', v: a.buckets.cacheWrite }
    ];
    const models = a.byModel.map(m => ({ id: m.model, v: m.tokens }));
    const dirs = a.byDir
      .filter(d => !S.offDirs.includes(d.path))
      .map((d, i) => ({ name: d.name, path: d.path, slot: i, v: d.tokens }));
    return {
      agg: { total: a.total, buckets: a.buckets },
      comp, models, dirs,
      modelMax: models.length ? models[0].v : 1,
      dirMax: dirs.length ? dirs[0].v : 1
    };
  },

  matrixData() {
    const m = D.matrix;
    const keep = m.models.slice(0, 6);
    const rest = m.models.slice(6);
    const cell = {};
    m.agents.forEach(a => { cell[a.id] = {}; });
    for (const [agent, mm] of Object.entries(m.cells)) {
      for (const [model, v] of Object.entries(mm)) cell[agent][model] = v;
    }
    return {
      agents: m.agents, keep, rest, cell,
      colTotal: m.colTotal, maxCell: m.maxCell,
      rowTotal: a => m.rowTotal[a.id ?? a] ?? 0,
      restColTotal: a => rest.reduce((s, x) => s + (cell[a.id][x.id] ?? 0), 0)
    };
  },

  legend() {
    return { ranked: (D.cal?.dirs ?? []).map((d, i) => ({ path: d.path, name: d.name, v: d.tokens, slot: i })) };
  },

  dayItems(k) {
    const day = (D.cal?.days ?? []).find(d => d.day === k);
    if (!day) return [];
    const ranked = TK.legend().ranked.filter(r => !S.offDirs.includes(r.path) && (day.byDir[r.path] ?? 0) > 0);
    const sum = ranked.reduce((s, r) => s + day.byDir[r.path], 0) || 1;
    return ranked.map(r => ({ slot: r.slot, v: day.byDir[r.path], pct: (day.byDir[r.path] / sum) * 100 }));
  },

  convGroups() {
    const convs = [];
    const groups = (D.conv?.groups ?? []).map(grp => {
      const list = grp.list.map(it => {
        const c = {
          id: it.id, title: it.title || it.sessionId.slice(0, 8),
          date: it.firstTs ? dayOf(it.firstTs) : '—',
          source: it.agent, model: it.model, dir: it.dir, dirName: it.dirName,
          tokens: it.tokens, turns: it.events, costCny: it.costCny
        };
        convs.push(c);
        return c;
      });
      return { dir: grp.dir, list, total: grp.total };
    });
    const cur = convs.find(c => c.id === S.convId) ?? convs[0] ?? null;
    S.convId = cur ? cur.id : null;
    return { convs, groups, cur };
  },

  convStats() {
    const st = D.convDetail?.stats;
    if (!st) return { tb: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usd: 0, cny: 0, unpriced: 0, tsum: 0, byDay: {}, dayRows: [], maxDay: 1 };
    return {
      tb: st.buckets,
      cny: st.costCny, usd: st.costUsd, unpriced: st.unpriced,
      tsum: st.total, byDay: st.byDay, dayRows: st.dayRows,
      maxDay: Math.max(0.0001, ...Object.values(st.byDay))
    };
  },

  turnList() {
    return (D.convDetail?.events ?? []).map(e => ({
      time: e.localDay + ' ' + hhmm(e.ts),
      model: e.model, input: e.input, output: e.output, cache: e.cacheRead,
      cny: e.costCny, priced: e.costCny !== null, isChild: e.isChild, state: '成功'
    }));
  },

  turnCost(t) { return { priced: t.priced, cny: t.cny ?? 0 }; },

  logData() {
    const batches = (D.log?.batches ?? []).map(b => {
      const logs = (D.log?.logs ?? []).filter(l => l.batch_id === b.id);
      const started = b.started_at ?? 0;
      return {
        id: b.id, at: fmtTime(started), trigger: b.trigger,
        ms: b.finished_at ? b.finished_at - started : 0,
        files: b.files_scanned ?? 0,
        events: b.events_written ?? 0,
        dup: Math.max(0, (b.events_read ?? 0) - (b.events_written ?? 0)),
        skipped: Math.max(0, (b.files_total ?? 0) - (b.files_scanned ?? 0)),
        warn: logs.filter(l => l.level === 'warn').length,
        err: logs.filter(l => l.level === 'err').length
      };
    });
    const logs = (D.log?.logs ?? []).map(l => ({
      at: fmtTime(l.at), lvl: l.level, src: l.source, msg: l.message, batch: l.batch_id
    }));
    const srcs = ['all'];
    for (const l of logs) if (!srcs.includes(l.src)) srcs.push(l.src);
    const diag = (D.doctor?.sources ?? []).map(s => ({
      name: s.id, ok: s.ok, text: s.ok ? '可读 / ' + s.roots.length + ' 个路径' : '路径不存在'
    }));
    return { last: batches[0] ?? { at: '—', ms: 0, trigger: '—', events: 0, dup: 0, skipped: 0, warn: 0, err: 0 },
             batches, logs, src: srcs, diag };
  },

  go(view, opts) {
    S.view = view;
    if (opts?.clearConv) { S.convFilter = { dir: null, agent: null, model: null }; S.convQ = ''; S.convId = null; }
    if (opts?.dir) { S.convFilter = { dir: opts.dir, agent: null, model: null }; S.convQ = ''; S.convId = null; }
    if (opts?.agent) { S.convFilter = { dir: null, agent: opts.agent, model: opts.model ?? null }; S.convQ = ''; S.convId = null; }
    if (opts?.day) {
      S.sel = { a: opts.day, b: opts.day };
      const d = new Date(opts.day + 'T00:00:00');
      S.month = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }
    const url = new URL(location.href);
    url.searchParams.set('view', view);
    if (S.convFilter.dir) url.searchParams.set('dir', S.convFilter.dir);
    if (S.convFilter.agent) url.searchParams.set('agent', S.convFilter.agent);
    if (S.convFilter.model) url.searchParams.set('model', S.convFilter.model);
    if (S.sel) url.searchParams.set('from', S.sel.a);
    history.replaceState({}, '', url);
  },

  setUnit(u) { unit = u; void draw(); },
  toggleTheme() {
    S.theme = S.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.mode = S.theme;
    void draw();
  },
  shiftMonth(n) {
    const [y, m] = S.month.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    S.month = d.getFullYear() + '-' + pad(d.getMonth() + 1);
    S.sel = null;
  },
  selectDay(k) {
    if (!S.sel) S.sel = { a: k, b: k };
    else if (S.sel.a === S.sel.b) {
      if (k === S.sel.a) S.sel = null;
      else S.sel = { a: k < S.sel.a ? k : S.sel.a, b: k > S.sel.b ? k : S.sel.b };
    } else S.sel = { a: k, b: k };
  },
  resetToday() { S.sel = null; S.month = new Date().toISOString().slice(0, 7); },
  setLog(patch) { Object.assign(S.log, patch); void draw(); }
};

/* ---------- 视图：移植自 design/v3/02-receipt.html ---------- */

const TONES = ['var(--t0)', 'var(--t1)', 'var(--t2)', 'var(--t3)', 'var(--t4)', 'var(--t5)'];
const esc = v => String(v).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const tone = slot => TONES[slot % TONES.length];
function lead(label, value, cls) {
  return '<div class="leadrow"><span class="nm">' + label + '</span><span class="dots"></span>' +
    '<span class="v ' + (cls || '') + '">' + value + '</span></div>';
}

function header() {
  const views = [['home', '总账'], ['conv', '会话'], ['log', '日志']];
  return '<div class="rhead"><div class="name">ATRACKER</div><div class="sub">LOCAL TOKEN RECEIPT</div>' +
    '<div class="barcode"></div></div>' +
    '<div class="rno"><span>NO. ' + dayOf(Date.now()).replace(/-/g, '') + '</span><span>' + fmtTime(Date.now()) + '</span><span>TERMINAL 01</span></div>' +
    '<div class="navrow">' + views.map(v =>
      '<button class="tab" data-nav="' + v[0] + '" aria-current="' + (S.view === v[0]) + '">' + v[1] + '</button>').join('') +
    '<span class="sp"></span>' +
    '<div class="unit">' + TK.UNITS.map(u =>
      '<button data-unit="' + u.id + '" aria-pressed="' + (unit === u.id) + '">' + u.label + '</button>').join('') + '</div>' +
    '<button class="ghost" id="themeBtn">' + (S.theme === 'light' ? '夜间小票' : '日间小票') + '</button></div>' +
    '<div class="tear">TEAR ALONG DOTTED LINE</div>';
}

function homeView() {
  const all = TK.aggregate();
  const d = TK.detailData();
  const miss = D.total.unpricedTokens > 0 ? 1 : 0;
  return '<div class="sec" style="margin-top:4px"><div class="total-line">' +
      '<div><div class="lab">TOTAL TOKENS / 全部记录</div><div class="val">' + TK.fmtTok(all.total) + '</div>' +
        '<div class="tiny">' + abbr(all.total) + ' / 覆盖 ' + (D.total.days ?? 0) + ' 天 / 四桶合计</div></div>' +
      '<div class="side"><div class="lab">ESTIMATED COST</div><div class="money">' + money(D.total.costCny) + '</div>' +
        '<div class="tiny">' + moneyUsd(D.total.costCny) + ' / 汇率 6.5' +
        (miss ? ' / ' + miss + ' 个模型无价格' : '') + '</div></div>' +
    '</div></div>' +
    '<div class="sec"><div class="sec-h"><b>TOKEN 四桶</b><span>当前范围 ' + TK.scopeText() + '</span><span class="r">' + TK.fmtTok(d.agg.total) + '</span></div>' +
      lead('输入 / 未命中缓存', TK.fmtTok(d.comp[0].v)) +
      lead('输出 / 含推理', TK.fmtTok(d.comp[1].v)) +
      lead('缓存命中 / ' + fmtPct(d.agg.total ? d.comp[2].v / d.agg.total : 0), TK.fmtTok(d.comp[2].v)) +
      lead('缓存写入 / 首次写入', TK.fmtTok(d.comp[3].v)) +
    '</div>' +
    calendar() +
    '<div class="sec"><div class="sec-h"><b>来源 × 模型</b><span>格内深浅表示量级</span><span class="r">点格下钻</span></div>' + matrix() + '</div>' +
    '<div class="sec"><div class="sec-h"><b>模型用量</b><span>按 token 降序</span></div><div class="bars">' +
      d.models.map(x =>
        '<div class="row"><div class="top"><span>' + esc(x.id) + '</span><span class="dots"></span>' +
        '<span class="v">' + fmtPct(x.v / (d.agg.total || 1)) + ' / ' + TK.fmtTok(x.v) + '</span></div>' +
        '<div class="track"><i style="width:' + (x.v / (d.agg.total || 1) * 100).toFixed(1) + '%"></i></div></div>').join('') +
    '</div></div>' +
    '<div class="sec"><div class="sec-h"><b>目录用量</b><span>点一行查看该目录的会话</span></div><div class="bars">' +
      d.dirs.map(x =>
        '<div class="row" data-dir="' + esc(x.path) + '" style="cursor:pointer"><div class="top">' +
        '<span>' + esc(x.name) + '</span><span class="dots"></span>' +
        '<span class="v">' + fmtPct(x.v / (d.agg.total || 1)) + ' / ' + TK.fmtTok(x.v) + '</span></div>' +
        '<div class="track"><i style="width:' + (x.v / (d.agg.total || 1) * 100).toFixed(1) + '%;background:' + tone(x.slot) + '"></i></div></div>').join('') +
    '</div></div>' +
    '<div class="sec"><div class="sec-h"><b>NOTE</b><span>口径</span></div>' +
      '<div style="font-size:9.5px;color:var(--muted)">四桶合计等于该范围的 token 总量。子 agent 用量归入发起轮次，不重复计数。日期按 Asia/Shanghai 折算自然日。价格来自 config/pricing.json，人民币按 6.5 折算。</div></div>';
}

function calendar() {
  const meta = TK.monthMeta(S.month);
  const lg = TK.legend();
  const days = D.cal?.days ?? [];
  let cells = '';
  for (let i = 0; i < meta.lead; i++) cells += '<div class="cell out"></div>';
  for (let day = 1; day <= meta.dim; day++) {
    const k = `${meta.y}-${pad(meta.m)}-${pad(day)}`;
    const rec = days.find(d => d.day === k);
    const inRange = S.sel && k >= S.sel.a && k <= S.sel.b;
    const isSel = S.sel && k === S.sel.a && k === S.sel.b;
    const items = TK.dayItems(k);
    cells += '<button class="cell' + (isSel ? ' sel' : (inRange ? ' inrange' : '')) + '" data-day="' + k + '" title="' + k + (rec ? ' / ' + TK.fmtTok(rec.total) : ' / 无记录') + '">' +
      '<span class="d">' + day + '</span><span class="v">' + (rec ? TK.fmtTok(rec.total) : '--') + '</span>' +
      '<span class="stack">' + items.map(x => '<i style="width:' + x.pct.toFixed(2) + '%;--c:' + tone(x.slot) + '"></i>').join('') + '</span></button>';
  }
  return '<div class="sec"><div class="sec-h"><b>月历</b><span>' + meta.y + ' 年 ' + meta.m + ' 月 / ' + meta.dim + ' 天</span><span class="r">' + TK.scopeText() + '</span></div>' +
    '<div class="cal-tools"><button class="ghost" id="prev">PREV</button><button class="ghost" id="next">NEXT</button>' +
    '<button class="ghost" id="today">TODAY</button><span class="scope">点击一天选中，再点另一天成区间</span></div>' +
    '<div class="legend">' + lg.ranked.map(x => {
      const off = S.offDirs.indexOf(x.path) >= 0;
      return '<button class="lg" data-legend="' + esc(x.path) + '" aria-pressed="' + (!off) + '">' +
        '<span class="sw" style="--c:' + tone(x.slot) + '"></span>' + esc(x.name) + '<span class="n">' + TK.fmtTok(x.v) + '</span></button>';
    }).join('') + '</div>' +
    '<div class="wk">' + ['一', '二', '三', '四', '五', '六', '日'].map(w => '<div>' + w + '</div>').join('') + '</div>' +
    '<div class="cal">' + cells + '</div></div>';
}

function heat(v, max) {
  if (!v) return 'background:transparent';
  const t = Math.min(1, v / (max || 1));
  const pct = Math.round(8 + t * 84);
  return 'background:color-mix(in srgb, var(--ink) ' + pct + '%, transparent);color:' + (t > 0.55 ? 'var(--paper)' : 'var(--ink)');
}

function matrix() {
  const d = TK.matrixData();
  let head = '<th class="l">模型</th>';
  d.agents.forEach(a => { head += '<th>' + esc(a.id) + '</th>'; });
  head += '<th>合计</th>';
  let body = '';
  d.keep.concat(d.rest).forEach(m => {
    let row = '<tr><td class="l">' + esc(m.id) + '</td>';
    d.agents.forEach(a => {
      const v = d.cell[a.id][m.id] ?? 0;
      row += '<td class="c" data-agent="' + esc(a.id) + '" data-model="' + esc(m.id) + '" style="' + heat(v, d.maxCell) + '">' +
        (v ? TK.fmtTok(v) : '-') + '</td>';
    });
    const total = d.agents.reduce((s, a) => s + (d.cell[a.id][m.id] ?? 0), 0);
    body += row + '<td>' + TK.fmtTok(total) + '</td></tr>';
  });
  let foot = '<tr><td class="l">合计</td>';
  d.agents.forEach(a => { foot += '<td>' + TK.fmtTok(d.rowTotal(a)) + '</td>'; });
  foot += '<td>' + TK.fmtTok(d.agents.reduce((s, a) => s + d.rowTotal(a), 0)) + '</td></tr>';
  return '<table class="matrix"><thead><tr>' + head + '</tr></thead><tbody>' + body + foot + '</tbody></table>';
}

function convView() {
  const g = TK.convGroups();
  const f = S.convFilter;
  let strip = '<div class="filterline"><span>会话 ' + g.convs.length + ' 条</span>';
  if (f.dir) strip += '<span class="pill">' + esc(f.dir) + '</span>';
  if (f.agent) strip += '<span class="pill">' + esc(f.agent) + '</span>';
  if (f.model) strip += '<span class="pill">' + esc(f.model) + '</span>';
  if (f.dir || f.agent || f.model) strip += '<button class="clear" id="clearF">清除筛选</button>';
  strip += '</div><input class="search" id="convq" placeholder="搜索会话标题、目录或来源" value="' + esc(S.convQ) + '">' +
    '<div class="pick">' + g.groups.map(grp => grp.list.map(cv =>
      '<button class="stub" data-cv="' + cv.id + '" aria-current="' + (cv.id === S.convId) + '">' +
      '<span class="t">' + esc(cv.title) + '</span>' +
      '<span class="m">' + cv.date + ' / ' + esc(cv.source) + ' / ' + TK.fmtTok(cv.tokens) + '</span></button>').join('')).join('') +
    '</div>';

  let detail = '';
  if (!g.cur) {
    detail = '<div class="placeholder">没有符合筛选条件的会话。换个来源或模型，或者清除筛选。</div>';
  } else {
    const cur = g.cur;
    const st = TK.convStats();
    const turns = TK.turnList();
    detail = '<div class="sec-h" style="margin-top:12px"><b>SESSION RECEIPT</b><span>' + cur.date + '</span><span class="r">' + TK.fmtTok(st.tsum) + '</span></div>' +
      '<div class="detail-title">' + esc(cur.title) + '</div>' +
      '<div class="detail-meta">' + esc(cur.dirName) + ' / ' + esc(cur.source) + ' / ' + esc(cur.model) + '</div>' +
      '<div style="margin-top:8px"><button class="ghost" id="toCal">在日历中查看这天</button></div>' +
      '<div class="kv"><span class="k">日期</span><span>' + cur.date + '</span><span class="k">轮次</span><span>' + cur.turns + ' 轮</span>' +
        '<span class="k">子 agent</span><span>' + turns.filter(t => t.isChild).length + ' 轮</span></div>' +
      '<div class="sec"><div class="sec-h"><b>TOKEN 构成</b><span>合计 ' + TK.fmtTok(st.tsum) + '</span></div>' +
        lead('输入', TK.fmtTok(st.tb.input)) + lead('输出', TK.fmtTok(st.tb.output)) +
        lead('缓存命中', TK.fmtTok(st.tb.cacheRead)) + lead('缓存写入', TK.fmtTok(st.tb.cacheWrite)) + '</div>' +
      '<div class="sec bars"><div class="sec-h"><b>成本</b><span>' + moneyUsd(st.cny) + ' / 汇率 6.5</span><span class="r">' + money(st.cny) + '</span></div>' +
        (st.unpriced ? '<div style="font-size:9px;color:var(--accent)">' + st.unpriced + ' 条用了未配置价格的模型，未计入</div>' : '') +
        st.dayRows.map(k =>
          '<div class="row"><div class="top"><span>' + k + '</span><span class="dots"></span><span class="v">' + money(st.byDay[k]) + '</span></div>' +
          '<div class="track"><i class="acc" style="width:' + (st.byDay[k] / st.maxDay * 100).toFixed(1) + '%"></i></div></div>').join('') +
        '</div>' +
      '<div class="sec"><div class="sec-h"><b>逐轮明细</b><span>子 agent 行缩进显示</span>' +
        (D.convDetail?.truncated ? '<span class="r">只显示最近 ' + turns.length + ' / ' + D.convDetail.eventTotal + ' 条</span>' : '') + '</div>' +
        '<table class="turn"><thead><tr><th class="l">时间</th><th class="l">模型</th><th>输入</th><th>输出</th><th>缓存</th><th>成本</th><th class="l">状态</th></tr></thead><tbody>' +
        turns.map(t =>
          '<tr' + (t.isChild ? ' class="sub"' : '') + '><td class="l t">' + (t.isChild ? '↳ 子 agent' : t.time) + '</td>' +
          '<td class="l">' + esc(t.model) + '</td><td>' + TK.fmtTok(t.input) + '</td><td>' + TK.fmtTok(t.output) + '</td>' +
          '<td>' + TK.fmtTok(t.cache) + '</td><td>' + (t.priced ? money(t.cny) : '--') + '</td>' +
          '<td class="l">成功</td></tr>').join('') +
        '</tbody></table></div>' +
      '<div class="sec"><div class="sec-h"><b>口径</b><span>NOTES</span></div>' +
        '<div style="font-size:9px;color:var(--muted)">token 分四桶：未缓存输入、输出（含推理）、缓存命中、缓存写入。日期按本机时区折算自然日。子 agent 的用量计入总量并归属到发起它的那一轮。价格来自 config/pricing.json。</div></div>';
  }
  return strip + detail;
}

function logView() {
  const d = TK.logData();
  const last = d.last;
  const levels = [['all', '全部'], ['warn', '警告'], ['err', '错误']];
  return '<div class="sec"><div class="sec-h"><b>扫描状态</b><span>' + last.at + '</span><span class="r">trigger ' + last.trigger + '</span></div>' +
      '<div class="logstat">' +
        '<div class="box"><div class="k">最近扫描</div><div class="v">' + last.at.slice(5, 16) + '</div><div class="s">' + (last.ms / 1000).toFixed(1) + ' s / ' + last.trigger + '</div></div>' +
        '<div class="box"><div class="k">写入事件</div><div class="v">' + full(last.events) + '</div><div class="s">去重 ' + last.dup + ' 条</div></div>' +
        '<div class="box"><div class="k">跳过文件</div><div class="v">' + last.skipped + '</div><div class="s">指纹未变</div></div>' +
        '<div class="box"><div class="k">警告 / 错误</div><div class="v">' + last.warn + ' / ' + last.err + '</div><div class="s">队列 0 / 2000</div></div>' +
      '</div></div>' +
    '<div class="sec"><div class="sec-h"><b>过滤</b><span>FILTER</span><span class="r">' + d.logs.length + ' 行</span></div>' +
      '<div class="f-label">级别</div><div class="chips">' + levels.map(l =>
        '<button class="chip" data-lvl="' + l[0] + '" aria-pressed="' + (S.log.lvl === l[0]) + '">' + l[1] + '</button>').join('') + '</div>' +
      '<div class="f-label">来源</div><div class="chips">' + d.src.map(x =>
        '<button class="chip" data-src="' + esc(x) + '" aria-pressed="' + (S.log.src === x) + '">' + (x === 'all' ? '全部' : esc(x)) + '</button>').join('') + '</div>' +
      '<input class="search" id="logq" placeholder="关键字，例如 database is locked" value="' + esc(S.log.q) + '">' +
      '<div style="margin-top:8px"><button class="ghost" id="clearf">清除筛选</button> <button class="ghost" id="rescan">重新扫描</button></div>' +
      '<div class="diag" style="margin-top:9px">' + d.diag.map(x =>
        '<span><b>' + esc(x.name) + '</b> ' + esc(x.text) + '</span>').join('') + '</div></div>' +
    '<div class="sec"><div class="sec-h"><b>扫描批次</b><span>点一行只看该批日志</span></div>' +
      '<table class="batch"><thead><tr><th class="l">时间</th><th class="l">触发</th><th>耗时</th><th>文件</th><th>事件</th><th>警</th><th>错</th><th class="l">结果</th></tr></thead><tbody>' +
      d.batches.map(b =>
        '<tr data-batch="' + b.id + '"' + (S.log.batch === b.id ? ' class="cur"' : '') + '>' +
        '<td class="l">' + b.at.slice(5) + '</td><td class="l">' + ({ watch: '文件变更', poll: '兜底轮询', manual: '手动' }[b.trigger] ?? b.trigger) + '</td>' +
        '<td>' + b.ms + '</td><td>' + b.files + '</td><td>' + b.events + '</td><td>' + b.warn + '</td><td>' + b.err + '</td>' +
        '<td class="l">' + (b.err ? '<span class="stamp">有错误</span>' : '<span class="stamp ok">成功</span>') + '</td></tr>').join('') +
      '</tbody></table></div>' +
    '<div class="sec"><div class="sec-h"><b>日志流</b><span>EVENT TAPE</span><span class="r">' + (S.log.batch ? '批次 ' + S.log.batch : '全部批次') + '</span></div>' +
      '<div class="tape">' + d.logs.map(l =>
        '<div class="ll ' + l.lvl + '"><span class="t">' + l.at.slice(5) + '</span>' +
        '<span class="lv">' + ({ ok: 'OK', info: '..', warn: '!', err: 'X' }[l.lvl]) + '</span>' +
        '<span class="s">' + esc(l.src) + '</span><span>' + esc(l.msg) + '</span></div>').join('') +
      (d.logs.length ? '' : '<div class="placeholder">没有符合条件的日志行。</div>') + '</div></div>';
}

/* ---------- 渲染与事件 ---------- */

function draw() {
  const body = S.view === 'home' ? homeView() : S.view === 'conv' ? convView() : logView();
  document.getElementById('app').innerHTML = '<div class="receipt">' + header() + body + '</div>';
  wire();
}

function wire() {
  document.querySelectorAll('[data-nav]').forEach(b => {
    b.onclick = () => {
      if (b.dataset.nav === 'conv') TK.go('conv', { clearConv: true });
      else TK.go(b.dataset.nav);
      void refresh();
    };
  });
  document.querySelectorAll('[data-unit]').forEach(b => { b.onclick = () => { unit = b.dataset.unit; void draw(); }; });
  const tb = document.getElementById('themeBtn');
  if (tb) tb.onclick = () => {
    S.theme = S.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.mode = S.theme;
    void draw();
  };

  if (S.view === 'home') {
    document.getElementById('prev').onclick = () => { TK.shiftMonth(-1); void refresh(); };
    document.getElementById('next').onclick = () => { TK.shiftMonth(1); void refresh(); };
    document.getElementById('today').onclick = () => { TK.resetToday(); void refresh(); };
    document.querySelectorAll('[data-day]').forEach(el => { el.onclick = () => { TK.selectDay(el.dataset.day); void refresh(); }; });
    document.querySelectorAll('[data-legend]').forEach(el => {
      el.onclick = () => {
        const p = el.dataset.legend;
        const i = S.offDirs.indexOf(p);
        if (i >= 0) S.offDirs.splice(i, 1); else S.offDirs.push(p);
        void draw();
      };
    });
    document.querySelectorAll('[data-dir]').forEach(el => { el.onclick = () => { TK.go('conv', { dir: el.dataset.dir }); void refresh(); }; });
    document.querySelectorAll('.matrix td.c').forEach(el => {
      el.onclick = () => { TK.go('conv', { agent: el.dataset.agent, model: el.dataset.model }); void refresh(); };
    });
  }

  if (S.view === 'conv') {
    const q = document.getElementById('convq');
    if (q) q.oninput = e => {
      S.convQ = e.target.value;
      void refresh().then(() => {
        const n = document.getElementById('convq');
        if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
      });
    };
    const cf = document.getElementById('clearF');
    if (cf) cf.onclick = () => { TK.go('conv', { clearConv: true }); void refresh(); };
    document.querySelectorAll('[data-cv]').forEach(el => { el.onclick = () => { S.convId = el.dataset.cv; void refresh(); }; });
    const toCal = document.getElementById('toCal');
    if (toCal) {
      const g = TK.convGroups();
      if (g.cur) toCal.onclick = () => { TK.go('home', { day: g.cur.date }); void refresh(); };
    }
  }

  if (S.view === 'log') {
    document.querySelectorAll('[data-lvl]').forEach(b => { b.onclick = () => { S.log.lvl = b.dataset.lvl; void refresh(); }; });
    document.querySelectorAll('[data-src]').forEach(b => { b.onclick = () => { S.log.src = b.dataset.src; void refresh(); }; });
    document.querySelectorAll('[data-batch]').forEach(tr => {
      tr.onclick = () => {
        const id = Number(tr.dataset.batch);
        S.log.batch = S.log.batch === id ? null : id;
        void refresh();
      };
    });
    const q = document.getElementById('logq');
    if (q) q.oninput = e => {
      S.log.q = e.target.value;
      void refresh().then(() => {
        const n = document.getElementById('logq');
        if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
      });
    };
    const cf = document.getElementById('clearf');
    if (cf) cf.onclick = () => { Object.assign(S.log, { batch: null, lvl: 'all', src: 'all', q: '' }); void refresh(); };
    const rs = document.getElementById('rescan');
    if (rs) rs.onclick = async () => {
      rs.textContent = '已触发 / 排队中';
      await fetch('/api/scan', { method: 'POST' });
    };
  }
}

const FIRST_RUN = `<div class="receipt">
  <div class="rhead"><div class="name">ATRACKER</div><div class="sub">LOCAL TOKEN RECEIPT</div></div>
  <div class="rno"><span>NO. 00000000</span><span>还没有数据</span><span>TERMINAL 01</span></div>
  <div class="placeholder" style="margin:18px 0;line-height:2">
    本机还没有采集到用量。先在项目目录跑一次：<br>
    <b>npm run scan</b><br>
    扫完刷新这一页。扫描器只读各 agent 的本地日志，不加钩子、不改 agent 行为。
  </div>
  <div class="placeholder">检查各来源是否可读：<b>node packages/cli/src/index.ts doctor</b></div>
</div>`;

async function refresh() {
  try {
    await load();
    if (D.total && D.total.total === 0) {
      document.getElementById('app').innerHTML = FIRST_RUN;
      return;
    }
  } catch (err) {
    document.getElementById('app').innerHTML =
      '<div class="receipt"><div class="rhead"><div class="name">ATRACKER</div></div>' +
      '<div class="placeholder" style="margin:20px">读取失败：' + esc(err.message) + '</div></div>';
    return;
  }
  draw();
}

/* 启动 */
const params = new URLSearchParams(location.search);
if (params.get('view')) S.view = params.get('view');
if (params.get('dir')) S.convFilter.dir = params.get('dir');
if (params.get('agent')) S.convFilter.agent = params.get('agent');
if (params.get('model')) S.convFilter.model = params.get('model');
if (params.get('from')) S.sel = { a: params.get('from'), b: params.get('from') };
if (params.get('theme') === 'dark') S.theme = 'dark';
if (params.get('unit')) unit = params.get('unit');
document.documentElement.dataset.mode = S.theme;

await refresh();

// 扫描完成后自动刷新
const es = new EventSource('/api/events');
es.onmessage = () => { void refresh(); };
