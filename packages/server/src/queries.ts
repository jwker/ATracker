// 接口载荷。字段形状对齐 design/v3/_core.js 要的数据，前端移植时不用改结构。
import { basename, dirname } from 'node:path';
import type { Repo } from '../../storage/src/repo.ts';
import { dirColor } from '../../core/src/palette.ts';

/** 目录配色表。表里有就用表里的，没有就临时算一个。 */
function colorMap(repo: Repo): Map<string, string> {
  return repo.dirColors();
}
import { RATE } from '../../core/src/money.ts';
import { localDay } from '../../core/src/time.ts';

const WEEKDAYS = '日一二三四五六';

/** 星期几。date 是本机时区的自然日，直接按 UTC 取星期不会跨日。 */
function weekdayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return '星期' + WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** 日期加减一天。 */
function shiftDay(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + delta * 86400000;
  const nd = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${nd.getUTCFullYear()}-${p(nd.getUTCMonth() + 1)}-${p(nd.getUTCDate())}`;
}

export const AGENTS = [
  { id: 'codex', label: 'codex', color: '#4c7fd1' },
  { id: 'claude-code', label: 'claude-code', color: '#4aa38a' },
  { id: 'pi', label: 'pi', color: '#c08a3e' },
  { id: 'opencode', label: 'opencode', color: '#c76a6a' },
  { id: 'dsh', label: 'dsh', color: '#9a6fc4' }
];

/** 目录名取路径末两段，和 v3 的展示一致。 */
export function dirName(path: string): string {
  if (!path) return '(未知目录)';
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

/**
 * 模型的显示名和聚合键：厂商/模型。
 * 同名模型可能挂在不同厂商下（比如 minimax 和 minimax-cn），只看模型名会混成一条。
 * 没有厂商时只给模型名。
 */
export function modelKey(vendor: string | null | undefined, model: string): string {
  return vendor ? `${vendor}/${model}` : model;
}

function ranges(from?: string | null, to?: string | null): { from: string; to: string } {
  const today = new Date();
  const defTo = today.toISOString().slice(0, 10);
  const defFrom = new Date(today.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  return { from: from || defFrom, to: to || defTo };
}

export function totalPayload(repo: Repo) {
  const t = repo.total();
  if (!t) {
    return {
      total: 0, buckets: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      costCny: 0, costUsd: 0, unpricedTokens: 0, updatedAt: Date.now()
    };
  }
  return {
    total: t.tokens,
    buckets: {
      input: t.input, output: t.output, cacheRead: t.cache_read,
      cacheWrite: t.cache_write, reasoning: t.reasoning
    },
    costCny: t.cost_cny, costUsd: t.cost_usd,
    unpricedTokens: t.unpriced_tokens,
    days: (repo.db.prepare('SELECT COUNT(DISTINCT local_day) n FROM usage_event').get() as any).n,
    updatedAt: t.updated_at
  };
}

export function calendarPayload(repo: Repo, month: string) {
  const { days, legend } = repo.calendar(month);
  const colors = colorMap(repo);
  return {
    month,
    days: days.map(d => ({ day: d.day, total: d.tokens, costCny: d.cost_cny, byDir: d.byDir ?? {} })),
    dirs: legend.map(d => ({
      path: d.dir,
      name: dirName(d.dir),
      tokens: d.tokens,
      color: colors.get(d.dir) ?? dirColor(d.dir)
    }))
  };
}

export function aggregatePayload(repo: Repo, fromQ?: string | null, toQ?: string | null) {
  const { from, to } = ranges(fromQ, toQ);
  const bd = repo.breakdown(from, to);
  const byAgent = repo.byAgent(from, to);

  const colors = colorMap(repo);
  const cells: Record<string, Record<string, number>> = {};
  for (const a of AGENTS) {
    cells[a.id] = {};
  }
  for (const row of repo.matrix(from, to).cells) {
    if (!cells[row.agent]) cells[row.agent] = {};
    cells[row.agent][modelKey(row.vendor, row.model)] = row.tokens;
  }

  const totals: any = bd.totals ?? { tokens: 0, cost_cny: 0, days: 0 };
  return {
    from, to,
    days: totals.days ?? 0,
    total: totals.tokens,
    buckets: {
      input: totals.input ?? 0,
      output: totals.output ?? 0,
      cacheRead: totals.cache_read ?? 0,
      cacheWrite: totals.cache_write ?? 0
    },
    byDir: bd.byDir.map((d: any) => ({
      path: d.dir, name: dirName(d.dir), tokens: d.tokens, costCny: d.cost_cny,
      color: colors.get(d.dir) ?? dirColor(d.dir)
    })),
    byModel: bd.byModel.map((m: any) => ({
      model: m.model, vendor: m.vendor, tokens: m.tokens, costCny: m.cost_cny
    })),
    byAgent: byAgent.map((a: any) => ({ agent: a.agent, tokens: a.tokens, costCny: a.cost_cny })),
    byAgentModel: cells,
    costCny: totals.cost_cny ?? 0,
    costUsd: (totals.cost_cny ?? 0) / RATE
  };
}

export function matrixPayload(repo: Repo, fromQ?: string | null, toQ?: string | null) {
  const { from, to } = ranges(fromQ, toQ);
  const cells: Record<string, Record<string, number>> = {};
  for (const a of AGENTS) cells[a.id] = {};

  const colTotal: Record<string, number> = {};
  const rowTotal: Record<string, number> = {};
  const models = new Map<string, { id: string; model: string; vendor: string | null; tokens: number }>();
  let maxCell = 1;

  for (const row of repo.matrix(from, to).cells) {
    if (!cells[row.agent]) cells[row.agent] = {};
    const key = modelKey(row.vendor, row.model);
    cells[row.agent][key] = row.tokens;
    colTotal[key] = (colTotal[key] ?? 0) + row.tokens;
    rowTotal[row.agent] = (rowTotal[row.agent] ?? 0) + row.tokens;
    const hit = models.get(key);
    models.set(key, {
      id: key,
      model: row.model,
      vendor: row.vendor || null,
      tokens: (hit?.tokens ?? 0) + row.tokens
    });
    if (row.tokens > maxCell) maxCell = row.tokens;
  }

  return {
    from, to,
    agents: AGENTS,
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens),
    cells,
    colTotal,
    rowTotal,
    maxCell
  };
}

export function conversationsPayload(repo: Repo, filter: { dir?: string | null; agent?: string | null; model?: string | null; vendor?: string | null; q?: string | null }) {
  const list = repo.conversations({
    dir: filter.dir ?? undefined,
    agent: filter.agent ?? undefined,
    model: filter.model ?? undefined,
    vendor: filter.vendor ?? undefined,
    q: filter.q ?? undefined,
    limit: 500
  }) as any[];
  const titles = repo.sessionTitles();

  const items = list.map(c => {
    const meta = titles.get(`${c.agent}:${c.session_id}`);
    return {
      id: `${c.agent}:${c.session_id}`,
      agent: c.agent,
      sessionId: c.session_id,
      dir: c.cwd,
      dirName: dirName(c.cwd),
      color: dirColor(c.cwd),
      model: c.model,
      vendor: c.provider,
      title: meta?.title ?? null,
      events: c.events,
      tokens: c.input + c.output + c.cache_read + c.cache_write,
      input: c.input, output: c.output, cacheRead: c.cache_read, cacheWrite: c.cache_write,
      costCny: c.cost_cny,
      firstTs: c.first_ts, lastTs: c.last_ts
    };
  });

  const byDir = new Map<string, any[]>();
  for (const it of items) {
    if (!byDir.has(it.dir)) byDir.set(it.dir, []);
    byDir.get(it.dir)!.push(it);
  }

  // 目录颜色跟首页一致：用 dir_color 表里已经分配好的，没有才临时算。
  const colors = colorMap(repo);
  const groups = [...byDir.entries()].map(([dir, its]) => ({
    dir: { path: dir, name: dirName(dir), color: colors.get(dir) ?? dirColor(dir) },
    total: its.reduce((s, x) => s + x.tokens, 0),
    list: its.sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))
  })).sort((a, b) => b.total - a.total);

  return { groups, total: items.length };
}

export function conversationPayload(repo: Repo, id: string, limit = 200) {
  const agent = id.includes(':') ? id.slice(0, id.indexOf(':')) : '';
  const sessionId = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  const { events, total } = repo.sessionEvents(sessionId, limit);
  const titles = repo.sessionTitles();
  const meta = titles.get(`${agent}:${sessionId}`);

  const buckets = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let costCny = 0;
  let unpriced = 0;
  const byDay: Record<string, number> = {};

  for (const e of events) {
    buckets.input += e.input_tokens;
    buckets.output += e.output_tokens;
    buckets.cacheRead += e.cache_read_tokens;
    buckets.cacheWrite += e.cache_write_tokens;
    buckets.reasoning += e.reasoning_tokens;
    if (e.cost_cny === null) unpriced++;
    else {
      costCny += e.cost_cny;
      const day = e.local_day;
      byDay[day] = (byDay[day] ?? 0) + e.cost_cny;
    }
  }

  return {
    id,
    agent,
    sessionId,
    title: meta?.title ?? null,
    dir: meta?.cwd ?? events[0]?.cwd ?? null,
    eventTotal: total,
    truncated: total > events.length,
    events: events.map(e => ({
      ts: e.ts, localDay: e.local_day, model: e.model, vendor: e.provider,
      input: e.input_tokens, output: e.output_tokens,
      cacheRead: e.cache_read_tokens, cacheWrite: e.cache_write_tokens,
      reasoning: e.reasoning_tokens,
      costCny: e.cost_cny, costUsd: e.cost_usd, costSource: e.cost_source,
      isChild: e.is_child === 1
    })),
    stats: {
      buckets,
      total: buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite,
      costCny, costUsd: costCny / RATE, unpriced,
      byDay, dayRows: Object.keys(byDay).sort()
    }
  };
}

export function logPayload(repo: Repo, filter: { batch?: number | null; level?: string | null; source?: string | null; q?: string | null }) {
  return {
    batches: repo.recentBatches(20),
    logs: repo.queryLogs({
      batch: filter.batch ?? undefined,
      level: filter.level ?? undefined,
      source: filter.source ?? undefined,
      q: filter.q ?? undefined,
      limit: 1000
    })
  };
}

/**
 * 单日详情。date 是本机时区的自然日，今天的数据截至此刻。
 * 和前一天比较时两边截到同一时刻，否则拿半天比一整天会夸大差距。
 */
export function dayPayload(repo: Repo, dateQ?: string | null) {
  const today = localDay(Date.now());
  const date = dateQ && /^\d{4}-\d{2}-\d{2}$/.test(dateQ) ? dateQ : today;
  const isToday = date === today;

  // 截止时刻。今天取现在，其他天取当天最后一条事件的时间。
  const lastTs = (repo.db.prepare(
    'SELECT MAX(ts) m FROM usage_event WHERE local_day = ?'
  ).get(date) as any)?.m ?? null;
  const cutoff = isToday ? Date.now() : (lastTs ?? Date.now());
  const prevDate = shiftDay(date, -1);
  // 固定 UTC+8，每一天等长，减一天就是前一天的同一时刻。
  const prevCutoff = cutoff - 86400000;

  const shape = (t: any) => ({
    events: t.events,
    tokens: t.tokens,
    buckets: {
      input: t.input,
      output: t.output,
      cacheRead: t.cacheRead,
      cacheWrite: t.cacheWrite,
      reasoning: t.reasoning
    },
    costCny: t.costCny,
    costUsd: t.costCny / RATE,
    unpriced: t.unpriced
  });

  const bd = repo.breakdown(date, date);
  const colors = repo.dirColors();
  const sessions = repo.daySessions(date);
  const titles = repo.sessionTitles();
  const sessionsPerDir = new Map<string, number>();
  for (const s of sessions) {
    sessionsPerDir.set(s.cwd, (sessionsPerDir.get(s.cwd) ?? 0) + 1);
  }

  // 来源 × 模型交叉表
  const cells: Record<string, Record<string, number>> = {};
  for (const a of AGENTS) cells[a.id] = {};
  const colTotal: Record<string, number> = {};
  const rowTotal: Record<string, number> = {};
  const modelRows = new Map<string, { id: string; model: string; vendor: string | null; tokens: number }>();
  let maxCell = 1;
  for (const row of repo.dayMatrix(date)) {
    if (!cells[row.agent]) cells[row.agent] = {};
    const key = modelKey(row.vendor, row.model);
    cells[row.agent][key] = row.tokens;
    colTotal[key] = (colTotal[key] ?? 0) + row.tokens;
    rowTotal[row.agent] = (rowTotal[row.agent] ?? 0) + row.tokens;
    const hit = modelRows.get(key);
    modelRows.set(key, {
      id: key,
      model: row.model,
      vendor: row.vendor || null,
      tokens: (hit?.tokens ?? 0) + row.tokens
    });
    if (row.tokens > maxCell) maxCell = row.tokens;
  }
  const models = [...modelRows.values()].sort((a, b) => b.tokens - a.tokens);

  const hourFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false
  });

  return {
    date,
    weekday: weekdayOf(date),
    isToday,
    cutoff: hourFmt.format(new Date(cutoff)),
    today: shape(repo.dayTotals(date, cutoff)),
    prev: shape(repo.dayTotals(prevDate, prevCutoff)),
    prevFull: shape(repo.dayTotals(prevDate)),
    hourly: repo.hourly(date).map((h: any) => ({
      hour: h.hour, events: h.events, tokens: h.tokens, costCny: h.cost_cny
    })),
    byAgent: repo.byAgent(date, date).map((a: any) => ({
      agent: a.agent, tokens: a.tokens, costCny: a.cost_cny
    })),
    byModel: bd.byModel.map((m: any) => ({
      model: m.model, vendor: m.vendor, tokens: m.tokens, costCny: m.cost_cny
    })),
    byDir: bd.byDir.map((d: any) => ({
      path: d.dir,
      name: dirName(d.dir),
      tokens: d.tokens,
      costCny: d.cost_cny,
      sessions: sessionsPerDir.get(d.dir) ?? 0,
      color: colors.get(d.dir) ?? dirColor(d.dir)
    })),
    matrix: { agents: AGENTS, models, cells, rowTotal, colTotal, maxCell },
    sessions: sessions.map((s: any) => ({
      id: `${s.agent}:${s.session_id}`,
      agent: s.agent,
      sessionId: s.session_id,
      title: titles.get(`${s.agent}:${s.session_id}`)?.title ?? null,
      dir: s.cwd,
      dirName: dirName(s.cwd),
      color: colors.get(s.cwd) ?? dirColor(s.cwd),
      events: s.events,
      tokens: s.tokens,
      costCny: s.cost_cny,
      firstTs: s.first_ts,
      lastTs: s.last_ts
    })),
    topCalls: repo.dayTopCalls(date, 8).map((e: any) => ({
      ts: e.ts,
      time: hourFmt.format(new Date(e.ts)),
      agent: e.agent,
      model: e.model,
      vendor: e.provider,
      dir: e.cwd,
      dirName: dirName(e.cwd),
      tokens: e.tokens,
      costCny: e.cost_cny
    })),
    batches: repo.dayBatches(date)
  };
}
