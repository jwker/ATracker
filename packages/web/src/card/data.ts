// 卡片的取数结果 → 绘制用的数据。范围卡（全期/区间）和今天卡各一个构造函数。

import type { AggregatePayload, CalendarPayload, DayPayload } from '../types.ts';
import { fmtPct, modelLabel } from '../format.ts';
import { cardTok, type CardBar, type CardData } from './render.ts';

/** 数值按 亿 / 万 拆成数值和单位，方便大数字排版。 */
export function splitValue(n: number): { value: string; unit: string } {
  if (n >= 1e8) return { value: (n / 1e8).toFixed(2), unit: '亿' };
  if (n >= 1e4) return { value: (n / 1e4).toFixed(1), unit: '万' };
  return { value: String(Math.round(n)), unit: '' };
}

function rate(input: number, cacheRead: number): string {
  const d = input + cacheRead;
  return fmtPct(d > 0 ? cacheRead / d : 0);
}

/** 月份区间，例如 ['2026-09', '2026-10', '2026-11'] */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

export function dayList(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  // 用 UTC 构造再取 UTC 日期，避开本地时区：按 +08:00 解析再用 toISOString 会整体退一天
  const start = Date.UTC(fy!, fm! - 1, fd!);
  const end = Date.UTC(ty!, tm! - 1, td!);
  for (let t = start; t <= end; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export interface RangeCardInput {
  kind: 'all' | 'month';
  from: string;
  to: string;
  agg: AggregatePayload;
  calendars: CalendarPayload[];
  version: string;
}

/** 范围卡：总账用全期（按月画柱子），月度用当月或选区（按天）。 */
export function buildRangeCard(input: RangeCardInput): CardData {
  const { kind, from, to, agg, calendars, version } = input;
  const totals = new Map<string, number>();
  for (const c of calendars) for (const d of c.days) totals.set(d.day, d.total);

  const byMonth = kind === 'all';
  const buckets = byMonth
    ? monthsBetween(from, to).map(m => ({
        key: m,
        label: m.slice(5),
        total: [...totals.entries()].filter(([d]) => d.startsWith(m)).reduce((a, [, v]) => a + v, 0)
      }))
    : dayList(from, to).map(d => ({ key: d, label: d.slice(5), total: totals.get(d) ?? 0 }));

  const max = Math.max(1, ...buckets.map(b => b.total));
  const peak = buckets.reduce((a, b) => (b.total > a.total ? b : a), buckets[0]!);
  const bars: CardBar[] = buckets.map(b => ({
    v: b.total / max,
    empty: b.total === 0,
    hot: b.key === peak.key && b.total > 0
  }));

  const v = splitValue(agg.total);
  const b = agg.buckets;
  const counted = agg.events ?? null;
  return {
    metaLeft: `${from} → ${to.slice(5)}`,
    metaRight: `${byMonth ? '全期' : from === to ? '某天' : '区间'} · ${byMonth ? buckets.length + ' 个月' : buckets.length + ' 天'}`,
    bigLabel: 'TOKEN 总量',
    bigValue: v.value,
    bigUnit: v.unit,
    buckets:
      (counted !== null ? `${counted} 次调用 · ` : '') +
      [`输入 ${cardTok(b.input)}`, `输出 ${cardTok(b.output)}`, `命中 ${cardTok(b.cacheRead)}`].join(' · '),
    hitRate: rate(b.input, b.cacheRead),
    chartTitle: byMonth ? '按月' : '按天',
    bars,
    axisLabels: [
      buckets[0]!.label,
      buckets[Math.floor(buckets.length / 2)]!.label,
      buckets[buckets.length - 1]!.label
    ],
    chartNoteLeft: `高峰 ${peak.label}${byMonth ? ' 月' : ''} · ${cardTok(peak.total)}`,
    chartNoteRight: `有记录 ${buckets.filter(x => x.total > 0).length} ${byMonth ? '个月' : '天'}`,
    models: agg.byModel
      .map(m => ({ label: modelLabel(m.model, m.vendor), pct: (m.tokens / (agg.total || 1)) * 100 }))
      .filter(m => m.pct >= 0.05)
      .slice(0, 6),
    modelsTitle: byMonth ? '占全期' : '占区间',
    version
  };
}

/** 今天卡：按小时画柱子。 */
export function buildTodayCard(day: DayPayload, version: string): CardData {
  const t = day.today;
  const hourly = Array.from({ length: 24 }, (_, h) => day.hourly.find(x => x.hour === h)?.tokens ?? 0);
  const max = Math.max(1, ...hourly);
  const peakH = hourly.indexOf(Math.max(...hourly));
  const active = hourly.filter(x => x > 0).length;
  const v = splitValue(t.tokens);
  const b = t.buckets;
  return {
    metaLeft: `${day.date} ${day.weekday}`,
    metaRight: `截至 ${day.cutoff}`,
    bigLabel: '今日 TOKEN',
    bigValue: v.value,
    bigUnit: v.unit,
    buckets:
      (t.events !== null ? `${t.events} 次调用 · ` : '') +
      [`输入 ${cardTok(b.input)}`, `输出 ${cardTok(b.output)}`, `命中 ${cardTok(b.cacheRead)}`].join(' · '),
    hitRate: rate(b.input, b.cacheRead),
    chartTitle: '按小时',
    bars: hourly.map((x, i) => ({ v: x / max, empty: x === 0, hot: i === peakH && x > 0 })),
    axisLabels: ['00', '06', '12', '18', '23'],
    chartNoteLeft: `高峰 ${String(peakH).padStart(2, '0')}:00 · ${cardTok(hourly[peakH] ?? 0)}`,
    chartNoteRight: `活跃 ${active} 小时`,
    models: day.byModel
      .map(m => ({ label: modelLabel(m.model, m.vendor), pct: (m.tokens / (t.tokens || 1)) * 100 }))
      .filter(m => m.pct >= 0.05)
      .slice(0, 6),
    modelsTitle: '占今天',
    version
  };
}
