// 月历。只在月度页用：选一天、再选一天成区间，再点同一天取消。
// 格子里画当天按目录拆分的色条；选中区间时，区间外的日子不画色条，
// 因为图例的排名是「当前范围前 6 名」，画在区间外会误导。

import type { CalendarPayload, DirAggregate } from '../types.ts';
import type { Selection, Unit } from '../state.ts';
import { fmtTok, monthMeta, pad } from '../format.ts';

/** 图例和色条里画的目录个数。剩下的合并成「其他」。 */
const TOP_DIRS = 6;

/** 「其他」那一段用的灰。 */
const OTHER_COLOR = 'var(--t4)';
const OTHER_KEY = '__other__';

interface CalendarMonthProps {
  cal: CalendarPayload;
  month: string;
  sel: Selection | null;
  unit: Unit;
  /** 当前范围的目录汇总，用来给色条配色和生成图例 */
  dirs: DirAggregate[];
  total: number;
  /** 数据还在路上：图例先收起，格子里的数值按空处理 */
  stale?: boolean;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onThisMonth: () => void;
  onSelectDay: (day: string) => void;
}

export function CalendarMonth(props: CalendarMonthProps) {
  const { cal, month, sel, unit, dirs, total, stale } = props;
  const tok = (n: number) => fmtTok(n, unit);
  const meta = monthMeta(month);

  const topDirs = dirs.slice(0, TOP_DIRS);
  const otherCount = Math.max(0, dirs.length - topDirs.length);
  const otherTokens = total - topDirs.reduce((s, d) => s + d.tokens, 0);
  const range = sel ?? { a: '', b: '' };

  const daysByKey = new Map(cal.days.map(d => [d.day, d]));

  const dayItems = (day: string) => {
    const rec = daysByKey.get(day);
    if (!rec) return [];
    // 范围外的日子不画色条：那个范围的目录排名和那天没关系。
    if (day < range.a || day > range.b) return [];
    const dayTotal = rec.total || 1;
    const items = topDirs
      .map(d => ({ path: d.path, color: d.color, v: rec.byDir[d.path] ?? 0 }))
      .filter(x => x.v > 0);
    const rest = dayTotal - items.reduce((s, x) => s + x.v, 0);
    if (rest > 0) items.push({ path: OTHER_KEY, color: OTHER_COLOR, v: rest });
    return items.map(x => ({ path: x.path, color: x.color, pct: (x.v / dayTotal) * 100 }));
  };

  return (
    <>
      <div className="sec-h">
        <b>月历</b>
        <span>
          {meta.y} 年 {meta.m} 月 / {meta.dim} 天
        </span>
        <span className="r">{stale ? '正在更新…' : `${cal.days.length} 天有用量`}</span>
      </div>
      <div className="cal-tools">
        <button className="ghost" onClick={props.onPrevMonth}>PREV</button>
        <button className="ghost" onClick={props.onNextMonth}>NEXT</button>
        <button className="ghost" onClick={props.onThisMonth}>本月</button>
        <span className="scope">点击一天选中，再点另一天成区间</span>
        <span className="tip">色块 = 目录；区间外的日子不画色条</span>
      </div>
      <div className="legend">
        <span className="legend-cap">
          {stale ? '正在更新…' : `当前范围前 ${TOP_DIRS} 名`}
        </span>
        {topDirs.map(d => (
          <span className="lg" key={d.path}>
            <span className="sw" style={{ background: d.color }} />
            {d.name}
            <span className="n">{tok(d.tokens)}</span>
          </span>
        ))}
        {otherCount > 0 && (
          <span className="lg">
            <span className="sw" style={{ background: OTHER_COLOR }} />
            其他 {otherCount} 个目录
            <span className="n">{tok(otherTokens)}</span>
          </span>
        )}
      </div>
      <div className="wk">
        {['一', '二', '三', '四', '五', '六', '日'].map(w => (
          <div key={w}>{w}</div>
        ))}
      </div>
      <div className="cal">
        {Array.from({ length: meta.lead }, (_, i) => (
          <div key={'out' + i} className="cell out" />
        ))}
        {Array.from({ length: meta.dim }, (_, i) => {
          const day = i + 1;
          const k = `${meta.y}-${pad(meta.m)}-${pad(day)}`;
          const rec = daysByKey.get(k);
          const inRange = !!sel && k >= sel.a && k <= sel.b;
          const isSel = !!sel && k === sel.a && k === sel.b;
          const items = dayItems(k);
          return (
            <button
              key={k}
              data-day={k}
              className={'cell' + (isSel ? ' sel' : inRange ? ' inrange' : '')}
              onClick={() => props.onSelectDay(k)}
              title={k + (rec ? ' / ' + tok(rec.total) : ' / 无记录')}
            >
              <span className="d">{day}</span>
              <span className="v">{rec ? tok(rec.total) : '--'}</span>
              <span className="stack">
                {items.map(x => (
                  <i
                    key={x.path}
                    style={{ width: x.pct.toFixed(2) + '%', background: x.color }}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
