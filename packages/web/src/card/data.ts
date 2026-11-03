// 卡片的取数结果 → 绘制用的数据。范围卡（全期/区间）和今天卡各一个构造函数。

import type { AggregatePayload, CalendarPayload, DayPayload } from '../types.ts';
import { fmtPct, modelLabel } from '../format.ts';
import { cardTok, type CardBar, type CardData } from './render.ts';

/** 数值按 亿 / 万 拆成数值和单位，方便大数字排版。 */
export function splitValue(n: number): { value: string; unit: string } {
  if (!Number.isFinite(n)) return { value: '0', unit: '' };
  if (n >= 1e8) return { value: (n / 1e8).toFixed(2), unit: '亿' };
  if (n >= 1e4) {
    // 9999.9999 万 舍入后是 10000.0 万，读起来比 1 亿还大。越界就提升一档。
    if (Math.abs(Number((n / 1e4).toFixed(1))) >= 1e4) return { value: (n / 1e8).toFixed(2), unit: '亿' };
    return { value: (n / 1e4).toFixed(1), unit: '万' };
  }
  return { value: String(Math.round(n)), unit: '' };
}

/** 日期串是不是 YYYY-MM-DD。 */
function isDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = Date.UTC(y!, m! - 1, d!);
  const dt = new Date(t);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

function rate(input: number, cacheRead: number): string {
  const d = input + cacheRead;
  return fmtPct(d > 0 ? cacheRead / d : 0);
}

/**
 * 月份区间，例如 ['2026-09', '2026-10', '2026-11']。
 *
 * 非法输入返回空数组，不产生垃圾结果：from 或 to 解析不出年月时，
 * Number() 是 NaN，循环条件恒假或者恒真，会静默算出一堆 'NaN-NaN'。
 */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const fm = /^\d{4}-(\d{2})/.exec(from);
  const tm = /^\d{4}-(\d{2})/.exec(to);
  if (!fm || !tm) return out;
  let y = Number(from.slice(0, 4));
  let m = Number(fm[1]);
  const ty = Number(to.slice(0, 4));
  const tmm = Number(tm[1]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(ty) || !Number.isFinite(tmm)) return out;
  if (m < 1 || m > 12 || tmm < 1 || tmm > 12) return out;
  // 上限一年半，防止 from 和 to 差太远时算出成千上万个格子
  let guard = 0;
  while ((y < ty || (y === ty && m <= tmm)) && guard++ < 240) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** 日期区间。非法输入返回空数组。 */
export function dayList(from: string, to: string): string[] {
  const out: string[] = [];
  if (!isDay(from) || !isDay(to)) return out;
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  // 用 UTC 构造再取 UTC 日期，避开本地时区：按 +08:00 解析再用 toISOString 会整体退一天
  const start = Date.UTC(fy!, fm! - 1, fd!);
  const end = Date.UTC(ty!, tm! - 1, td!);
  if (end < start) return out;
  // 上限三年，防止 from 和 to 差太远时算出上千个格子
  let guard = 0;
  for (let t = start; t <= end && guard++ < 1200; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
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
  for (const c of calendars) {
    for (const d of c.days) {
      // 同一天出现在多份日历里要累加，不能覆盖。
      // 覆盖的话那个月的总量会比总量那一行少。
      totals.set(d.day, (totals.get(d.day) ?? 0) + d.total);
    }
  }

  const byMonth = kind === 'all';
  const buckets = byMonth
    ? monthsBetween(from, to).map(m => ({
        key: m,
        label: m.slice(5),
        total: [...totals.entries()].filter(([d]) => d.startsWith(m)).reduce((a, [, v]) => a + v, 0)
      }))
    : dayList(from, to).map(d => ({ key: d, label: d.slice(5), total: totals.get(d) ?? 0 }));

  // 区间非法（from 比 to 大、格式不对）时 buckets 会是空的。
  // 原来 reduce 没有初值，空数组直接抛 TypeError。
  const max = Math.max(1, ...buckets.map(b => b.total));
  const peak = buckets.length
    ? buckets.reduce((a, b) => (b.total > a.total ? b : a), buckets[0]!)
    : { key: '', label: '', total: 0 };
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
    axisLabels: buckets.length
      ? [
          buckets[0]!.label,
          // 中间那个标签要落在轴的正中间。轴上三个标签是按 0 / 0.5 / 1
          // 等距铺的，对应的是第 (n-1)/2 根，不是第 n/2 根。
          buckets[Math.floor((buckets.length - 1) / 2)]!.label,
          buckets[buckets.length - 1]!.label
        ]
      : [],
    chartNoteLeft: peak.key
      ? `高峰 ${peak.label}${byMonth ? ' 月' : ''} · ${cardTok(peak.total)}`
      : '没有数据',
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
  // 远端设备没有逐轮明细，服务端不返回 hourly。没有明细时不能画小时图，
  // 也不能报「高峰 00:00 · 0」——那读起来像凌晨有用量。
  const hasDetail = day.canDetail !== false && Array.isArray(day.hourly) && day.hourly.length > 0;
  const hourly = hasDetail
    ? Array.from({ length: 24 }, (_, h) => day.hourly.find(x => x.hour === h)?.tokens ?? 0)
    : [];
  const max = Math.max(1, ...hourly);
  const peakH = hourly.length ? hourly.indexOf(Math.max(...hourly)) : -1;
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
    chartTitle: hasDetail ? '按小时' : '按小时（无明细）',
    bars: hourly.map((x, i) => ({ v: x / max, empty: x === 0, hot: i === peakH && x > 0 })),
    axisLabels: hasDetail ? ['00', '06', '12', '18', '23'] : [],
    chartNoteLeft: peakH >= 0
      ? `高峰 ${String(peakH).padStart(2, '0')}:00 · ${cardTok(hourly[peakH] ?? 0)}`
      : '这一天没有逐轮明细',
    chartNoteRight: hasDetail ? `活跃 ${active} 小时` : '明细只在产生它的设备上',
    models: day.byModel
      .map(m => ({ label: modelLabel(m.model, m.vendor), pct: (m.tokens / (t.tokens || 1)) * 100 }))
      .filter(m => m.pct >= 0.05)
      .slice(0, 6),
    modelsTitle: '占今天',
    version
  };
}
