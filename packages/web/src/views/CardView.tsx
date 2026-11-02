// 分享卡片页。左右两张卡：范围卡（按天）和今天卡（按小时）。
// 画布直接按 1080×1920 画，屏幕上用 CSS 缩到 360 宽预览；「保存图片」导出的
// 就是同一张画布的 PNG。

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AggregatePayload, CalendarPayload, DayPayload } from '../types.ts';
import { api } from '../api.ts';
import { drawCard, cardTok, type CardBar, type CardData } from '../card/render.ts';
import { fmtPct, modelLabel } from '../format.ts';

interface CardViewProps {
  /** 时间范围（范围卡用） */
  from: string;
  to: string;
  /** 日期（今天卡用） */
  date: string;
  /** 设备过滤；'all' 表示全部设备，空表示本机 */
  device: string | null;
  localDeviceId: string | null;
  version: string;
  onBack: () => void;
}

/** 金额/数量按 亿 / 万 拆成数值和单位，方便大数字排版。 */
function splitValue(n: number): { value: string; unit: string } {
  if (n >= 1e8) return { value: (n / 1e8).toFixed(2), unit: '亿' };
  if (n >= 1e4) return { value: (n / 1e4).toFixed(1), unit: '万' };
  return { value: String(Math.round(n)), unit: '' };
}

function hitRate(input: number, cacheRead: number): string {
  const d = input + cacheRead;
  return fmtPct(d > 0 ? cacheRead / d : 0);
}

/** 月份区间，例如 2026-09 … 2026-11 */
function monthsBetween(from: string, to: string): string[] {
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

function dayList(from: string, to: string): string[] {
  const out: string[] = [];
  const t0 = Date.parse(from + 'T00:00:00+08:00');
  const t1 = Date.parse(to + 'T00:00:00+08:00');
  for (let t = t0; t <= t1; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export function CardView(props: CardViewProps) {
  const [agg, setAgg] = useState<AggregatePayload | null>(null);
  const [cal, setCal] = useState<CalendarPayload[]>([]);
  const [day, setDay] = useState<DayPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rangeRef = useRef<HTMLCanvasElement | null>(null);
  const todayRef = useRef<HTMLCanvasElement | null>(null);
  const [saving, setSaving] = useState(false);

  // 调用次数只有本机有：跨设备时整段去掉
  const isLocal = props.localDeviceId !== null &&
    (props.device === null || props.device === props.localDeviceId);

  useEffect(() => {
    let alive = true;
    setError(null);
    Promise.all([
      api.aggregate(props.from, props.to, props.device),
      ...monthsBetween(props.from, props.to).map(m => api.calendar(m, props.device)),
      api.day(props.date, props.device)
    ])
      .then(([a, ...rest]) => {
        if (!alive) return;
        setAgg(a);
        setCal(rest.slice(0, rest.length - 1) as CalendarPayload[]);
        setDay(rest[rest.length - 1] as DayPayload);
      })
      .catch(err => { if (alive) setError((err as Error).message); });
    return () => { alive = false; };
  }, [props.from, props.to, props.date, props.device]);

  /* ---------- 范围卡 ---------- */
  const rangeCard: CardData | null = useMemo(() => {
    if (!agg) return null;
    const days = dayList(props.from, props.to);
    const totals = new Map<string, number>();
    for (const c of cal) for (const d of c.days) totals.set(d.day, d.total);
    const max = Math.max(1, ...[...totals.values()]);
    const bars: CardBar[] = days.map(d => {
      const v = totals.get(d) ?? 0;
      return { v: v / max, empty: v === 0, hot: false };
    });
    const peakDay = days.reduce((best, d) => ((totals.get(d) ?? 0) > (totals.get(best) ?? 0) ? d : best), days[0]!);
    const peakIdx = days.indexOf(peakDay);
    if (peakIdx >= 0 && (totals.get(peakDay) ?? 0) > 0) bars[peakIdx]!.hot = true;

    const v = splitValue(agg.total);
    const b = agg.buckets;
    const counted = agg.events ?? null; // 远端设备没有次数
    const bucketBits = [
      `输入 ${cardTok(b.input)}`,
      `输出 ${cardTok(b.output)}`,
      `命中 ${cardTok(b.cacheRead)}`
    ];
    return {
      metaLeft: `${props.from} → ${props.to.slice(5)}`,
      metaRight: `${days.length} 天`,
      bigLabel: 'TOKEN 总量',
      bigValue: v.value,
      bigUnit: v.unit,
      buckets: (counted !== null ? `${counted} 次调用 · ` : '') + bucketBits.join(' · '),
      hitRate: hitRate(b.input, b.cacheRead),
      chartTitle: '按天',
      bars,
      axisLabels: [props.from.slice(5), days[Math.floor(days.length / 2)]!.slice(5), props.to.slice(5)],
      chartNoteLeft: `高峰 ${peakDay.slice(5)} · ${cardTok(totals.get(peakDay) ?? 0)}`,
      chartNoteRight: `有记录 ${[...totals.values()].filter(x => x > 0).length} 天`,
      models: agg.byModel
        .map(m => ({ label: modelLabel(m.model, m.vendor), pct: (m.tokens / (agg.total || 1)) * 100 }))
        .filter(m => m.pct >= 0.05)
        .slice(0, 6),
      version: props.version
    };
  }, [agg, cal, isLocal, props.from, props.to, props.version]);

  /* ---------- 今天卡 ---------- */
  const todayCard: CardData | null = useMemo(() => {
    if (!day) return null;
    const t = day.today;
    const hourly = Array.from({ length: 24 }, (_, h) => day.hourly.find(x => x.hour === h)?.tokens ?? 0);
    const max = Math.max(1, ...hourly);
    const peakH = hourly.indexOf(Math.max(...hourly));
    const active = hourly.filter(x => x > 0).length;
    const v = splitValue(t.tokens);
    const b = t.buckets;
    const bits = [
      `输入 ${cardTok(b.input)}`,
      `输出 ${cardTok(b.output)}`,
      `命中 ${cardTok(b.cacheRead)}`
    ];
    return {
      metaLeft: `${day.date} ${day.weekday}`,
      metaRight: `截至 ${day.cutoff}`,
      bigLabel: '今日 TOKEN',
      bigValue: v.value,
      bigUnit: v.unit,
      buckets: (t.events !== null ? `${t.events} 次调用 · ` : '') + bits.join(' · '),
      hitRate: hitRate(b.input, b.cacheRead),
      chartTitle: '按小时',
      bars: hourly.map((x, i) => ({ v: x / max, empty: x === 0, hot: i === peakH && x > 0 })),
      axisLabels: ['00', '06', '12', '18', '23'],
      chartNoteLeft: `高峰 ${String(peakH).padStart(2, '0')}:00 · ${cardTok(hourly[peakH] ?? 0)}`,
      chartNoteRight: `活跃 ${active} 小时`,
      models: day.byModel
        .map(m => ({ label: modelLabel(m.model, m.vendor), pct: (m.tokens / (t.tokens || 1)) * 100 }))
        .filter(m => m.pct >= 0.05)
        .slice(0, 6),
      version: props.version
    };
  }, [day, isLocal, props.version]);

  useEffect(() => {
    if (rangeCard && rangeRef.current) drawCard(rangeRef.current, rangeCard, 1);
  }, [rangeCard]);
  useEffect(() => {
    if (todayCard && todayRef.current) drawCard(todayRef.current, todayCard, 1);
  }, [todayCard]);

  function save(ref: React.RefObject<HTMLCanvasElement | null>, name: string): void {
    const c = ref.current;
    if (!c) return;
    setSaving(true);
    c.toBlob(blob => {
      setSaving(false);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  if (error) return <div className="placeholder">生成卡片失败：{error}</div>;
  if (!rangeCard || !todayCard) return <div className="placeholder">正在准备卡片…</div>;

  return (
    <>
      <div className="sec-h" style={{ marginTop: 6 }}>
        <b>分享卡片</b>
        <span>1080 × 1920 · 两张</span>
        <span className="r">
          <button className="ghost" onClick={props.onBack}>返回</button>
        </span>
      </div>
      <div className="cardrow">
        <div className="cardcell">
          <div className="cardhead">
            <span>范围 · 按天</span>
            <button className="ghost" onClick={() => save(rangeRef, `atracker-${props.from}-${props.to}.png`)}>
              {saving ? '导出中…' : '保存这张'}
            </button>
          </div>
          <canvas ref={rangeRef} className="sharecanvas" />
        </div>
        <div className="cardcell">
          <div className="cardhead">
            <span>今天 · 按小时</span>
            <button className="ghost" onClick={() => save(todayRef, `atracker-${props.date}.png`)}>
              {saving ? '导出中…' : '保存这张'}
            </button>
          </div>
          <canvas ref={todayRef} className="sharecanvas" />
        </div>
      </div>
      <p className="note-box" style={{ marginTop: 12 }}>
        保存的是 1080×1920 的 PNG。调用次数只有本机有，切到别的设备或全部设备时这一段会自动去掉。
      </p>
    </>
  );
}
