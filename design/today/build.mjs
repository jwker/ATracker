// 从本机数据库取当天的数据，生成 design/today/01-today-receipt.html。
//
//   node design/today/build.mjs [YYYY-MM-DD]
//
// 不带参数就是今天。生成的页面是静态快照，数据来自 data/atracker.db。

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const TZ = 'Asia/Shanghai';
const RATE = 6.5;

const db = new DatabaseSync(join(root, 'data/atracker.db'));
const q = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);

const hm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const hh = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false });
const wd = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, weekday: 'long' });

const day = process.argv[2] || new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const prevDate = (() => {
  const [y, m, d] = day.split('-').map(Number);
  const nd = new Date(Date.UTC(y, m - 1, d) - 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${nd.getUTCFullYear()}-${p(nd.getUTCMonth() + 1)}-${p(nd.getUTCDate())}`;
})();

const cutoff = one('SELECT MAX(ts) m FROM usage_event WHERE local_day = ?', day)?.m ?? Date.now();
// 固定 UTC+8，减一天就是前一天的同一时刻。
const prevCutoff = cutoff - 86400000;

function totals(d, until) {
  const rows = q(
    `SELECT input_tokens i, output_tokens o, cache_read_tokens cr, cache_write_tokens cw,
            reasoning_tokens rn, cost_cny cny
     FROM usage_event WHERE local_day = ?${until === undefined ? '' : ' AND ts <= ?'}`,
    ...(until === undefined ? [d] : [d, until])
  );
  const t = { events: rows.length, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, tokens: 0, cny: 0, usd: 0 };
  for (const r of rows) {
    t.input += r.i;
    t.output += r.o;
    t.cacheRead += r.cr;
    t.cacheWrite += r.cw;
    t.reasoning += r.rn;
    t.tokens += r.i + r.o + r.cr + r.cw;
    t.cny += r.cny || 0;
    t.usd += r.cny ? r.cny / RATE : 0;
  }
  return t;
}

const hours = {};
for (const r of q(
  `SELECT ts, input_tokens i, output_tokens o, cache_read_tokens cr, cache_write_tokens cw, cost_cny cny
   FROM usage_event WHERE local_day = ? ORDER BY ts`, day
)) {
  const h = hh.format(new Date(r.ts));
  hours[h] = hours[h] || { hour: Number(h), n: 0, tokens: 0, cny: 0 };
  hours[h].n++;
  hours[h].tokens += r.i + r.o + r.cr + r.cw;
  hours[h].cny += r.cny || 0;
}

const AGENTS = [
  { id: 'codex', color: '#4c7fd1' },
  { id: 'claude-code', color: '#4aa38a' },
  { id: 'pi', color: '#c08a3e' },
  { id: 'opencode', color: '#c76a6a' },
  { id: 'dsh', color: '#9a6fc4' }
];

const cross = { agents: AGENTS, models: [], cells: {}, rowTotal: {}, colTotal: {}, maxCell: 1 };
for (const row of q(
  `SELECT agent, model, SUM(tokens) tokens FROM agg_day_agent_model WHERE day = ? GROUP BY agent, model`, day
)) {
  cross.cells[row.agent] = cross.cells[row.agent] || {};
  cross.cells[row.agent][row.model] = row.tokens;
  cross.colTotal[row.model] = (cross.colTotal[row.model] ?? 0) + row.tokens;
  cross.rowTotal[row.agent] = (cross.rowTotal[row.agent] ?? 0) + row.tokens;
  cross.maxCell = Math.max(cross.maxCell, row.tokens);
}
cross.models = Object.entries(cross.colTotal)
  .map(([id, tokens]) => ({ id, tokens }))
  .sort((a, b) => b.tokens - a.tokens);

const titles = Object.fromEntries(
  q('SELECT agent, session_id, title FROM session_title WHERE title IS NOT NULL')
    .map(r => [r.agent + ':' + r.session_id, r.title])
);

const data = {
  day,
  cutoff: hm.format(new Date(cutoff)),
  weekday: wd.format(new Date(cutoff)),
  today: totals(day, cutoff),
  prev: totals(prevDate, prevCutoff),
  prevFull: totals(prevDate),
  hours: Object.values(hours),
  agents: q(
    `SELECT agent, COUNT(*) n, SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) tokens,
            SUM(cost_cny) cny FROM usage_event WHERE local_day = ? GROUP BY agent ORDER BY tokens DESC`, day
  ),
  models: q(
    `SELECT model, provider, SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) tokens,
            SUM(cost_cny) cny, COUNT(*) n, SUM(cost_cny IS NULL) noprice
     FROM usage_event WHERE local_day = ? GROUP BY model, provider ORDER BY tokens DESC`, day
  ),
  dirs: q(
    `SELECT cwd, COUNT(DISTINCT session_id) sess,
            SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) tokens,
            SUM(cost_cny) cny FROM usage_event WHERE local_day = ? GROUP BY cwd ORDER BY tokens DESC`, day
  ),
  colors: Object.fromEntries(q('SELECT path, color FROM dir_color').map(r => [r.path, r.color])),
  sessions: q(
    `SELECT agent, session_id, MIN(cwd) cwd, COUNT(*) n,
            SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) tokens,
            SUM(cost_cny) cny, MIN(ts) f, MAX(ts) l
     FROM usage_event WHERE local_day = ? GROUP BY agent, session_id ORDER BY tokens DESC`, day
  ).map(s => ({
    ...s,
    title: titles[s.agent + ':' + s.session_id] ?? null,
    first: hm.format(new Date(s.f)),
    last: hm.format(new Date(s.l))
  })),
  top: q(
    `SELECT ts, agent, model, cwd, input_tokens i, output_tokens o, cache_read_tokens cr, cost_cny cny
     FROM usage_event WHERE local_day = ? AND cost_cny IS NOT NULL ORDER BY cny DESC LIMIT 8`, day
  ).map(t => ({ ...t, time: hm.format(new Date(t.ts)) })),
  batches: one(
    `SELECT COUNT(*) n, COALESCE(SUM(errors),0) err, COALESCE(SUM(events_written),0) written
     FROM scan_batch WHERE date(started_at/1000,'unixepoch','+8 hours') = ?`, day
  ),
  unpriced: one('SELECT COUNT(*) n FROM usage_event WHERE local_day = ? AND cost_cny IS NULL', day).n,
  cross
};

const template = readFileSync(join(here, 'template.html'), 'utf8');
const html = template.replace('/*DATA*/', JSON.stringify(data, null, 1));
writeFileSync(join(here, '01-today-receipt.html'), html);

console.log(`已生成 design/today/01-today-receipt.html（${day} 截至 ${data.cutoff}）`);
console.log(`  当天 ${data.today.tokens} token / ${data.today.cny.toFixed(2)} 元，${data.today.events} 次调用`);
