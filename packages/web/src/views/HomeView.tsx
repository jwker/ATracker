import type { CSSProperties } from 'react';
import type {
  AggregatePayload,
  CalendarPayload,
  MatrixPayload,
  TotalPayload
} from '../types.ts';
import type { Selection, Unit } from '../state.ts';
import { LeadRow } from '../components/LeadRow.tsx';
import { ScopeTag } from '../components/ScopeTag.tsx';
import {
  fmtPct,
  fmtTok,
  modelLabel,
  monthMeta,
  monthRange,
  pad
} from '../format.ts';

interface HomeViewProps {
  total: TotalPayload;
  cal: CalendarPayload;
  agg: AggregatePayload;
  matrix: MatrixPayload;
  month: string;
  sel: Selection | null;
  unit: Unit;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
  onSelectDay: (day: string) => void;
  onOpenDir: (path: string) => void;
  onOpenCell: (agent: string, model: string, vendor: string | null) => void;
  onClearSelection: () => void;
  /** 顶部大字看当前范围还是全部记录 */
  topScope: 'range' | 'total';
  onTopScope: (scope: 'range' | 'total') => void;
}

/** 图例和日历色条里画的目录个数。剩下的合并成“其他”。 */
const TOP_DIRS = 6;

/** “其他”那一段用的灰。 */
const OTHER_COLOR = 'var(--t4)';
const OTHER_KEY = '__other__';

function heatStyle(v: number, max: number): CSSProperties {
  if (!v) return { background: 'transparent' };
  const t = Math.min(1, v / (max || 1));
  const pct = Math.round(8 + t * 84);
  return {
    background: `color-mix(in srgb, var(--ink) ${pct}%, transparent)`,
    color: t > 0.55 ? 'var(--paper)' : 'var(--ink)'
  };
}

export function HomeView(props: HomeViewProps) {
  const { total, cal, agg, matrix, month, sel, unit } = props;
  const tok = (n: number) => fmtTok(n, unit);
  const meta = monthMeta(month);
  const comp = [
    { key: 'input', label: '输入 / 未命中缓存', v: agg.buckets.input },
    { key: 'output', label: '输出 / 含推理', v: agg.buckets.output },
    { key: 'cacheRead', label: '缓存命中', v: agg.buckets.cacheRead },
    { key: 'cacheWrite', label: '缓存写入 / 首次写入', v: agg.buckets.cacheWrite }
  ];
  const models = agg.byModel;

  // 顶部大字可以切：当前范围，或者全部记录。两个数都在屏幕上，只是强调哪个。
  const showTotal = props.topScope === 'total';
  const headTokens = showTotal ? total.total : agg.total;

  // 缓存命中率：命中量占「输入 + 命中」的比例。两边的数都是日志里读到的，不用推算。
  const hitOf = (t: { buckets: { input: number; cacheRead: number } }) => {
    const denom = t.buckets.input + t.buckets.cacheRead;
    return denom > 0 ? t.buckets.cacheRead / denom : 0;
  };
  const hitRate = hitOf(showTotal ? total : agg);

  // 图例和日历色条只画当前范围的前 6 名目录，其余合并成“其他”。
  // 排名跟着范围走：没选日期就是当月，选了就是选中的那几天。
  const topDirs = agg.byDir.slice(0, TOP_DIRS);
  const otherCount = Math.max(0, agg.byDir.length - topDirs.length);
  const otherTokens = agg.total - topDirs.reduce((s, d) => s + d.tokens, 0);
  const range = sel ? { from: sel.a, to: sel.b } : monthRange(month);

  const dayItems = (day: string) => {
    const rec = cal.days.find(d => d.day === day);
    if (!rec) return [];
    // 范围外的日子不画色条。那个范围的目录排名和那天没关系，画了也是误导。
    if (day < range.from || day > range.to) return [];
    const total = rec.total || 1;
    const items = topDirs
      .map(d => ({ path: d.path, color: d.color, v: rec.byDir[d.path] ?? 0 }))
      .filter(x => x.v > 0);
    const rest = total - items.reduce((s, x) => s + x.v, 0);
    if (rest > 0) items.push({ path: OTHER_KEY, color: OTHER_COLOR, v: rest });
    return items.map(x => ({ ...x, pct: (x.v / total) * 100 }));
  };

  const daysByKey = new Map(cal.days.map(d => [d.day, d]));

  const keep = matrix.models.slice(0, 6);
  const rest = matrix.models.slice(6);
  const rowTotal = (agent: string) => matrix.rowTotal[agent] ?? 0;

  return (
    <>
      <div className="sec" style={{ marginTop: 4 }}>
        <div className="total-line">
          <div>
            <div className="lab">
              TOKEN 总量
              <span className="seg">
                <button
                  className={showTotal ? '' : 'on'}
                  onClick={() => props.onTopScope('range')}
                  title="看当前范围"
                >
                  当前范围
                </button>
                <button
                  className={showTotal ? 'on' : ''}
                  onClick={() => props.onTopScope('total')}
                  title="看全部记录"
                >
                  全部记录
                </button>
              </span>
            </div>
            <div className="val">{tok(headTokens)}</div>
            <div className="tiny">
              {showTotal ? (
                <>当前范围 {tok(agg.total)}</>
              ) : (
                <>全部记录 {tok(total.total)} / 覆盖 {total.days ?? 0} 天</>
              )}
            </div>
          </div>
          <div className="side">
            <div className="lab">缓存命中率</div>
            <div className="hero">{fmtPct(hitRate)}</div>
            <div className="tiny">
              命中 {tok((showTotal ? total : agg).buckets.cacheRead)} / 未命中{' '}
              {tok((showTotal ? total : agg).buckets.input)}
            </div>
          </div>
        </div>
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>TOKEN 四桶</b>
          <ScopeTag sel={sel} month={month} onClear={props.onClearSelection} />
          <span className="r">{tok(agg.total)}</span>
        </div>
        <LeadRow label={comp[0].label} value={tok(comp[0].v)} />
        <LeadRow label={comp[1].label} value={tok(comp[1].v)} />
        <LeadRow
          label={comp[2].label + ' / ' + fmtPct(agg.total ? comp[2].v / agg.total : 0)}
          value={tok(comp[2].v)}
        />
        <LeadRow label={comp[3].label} value={tok(comp[3].v)} />
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>月历</b>
          <span>
            {meta.y} 年 {meta.m} 月 / {meta.dim} 天
          </span>
          <span className="r">
            {sel ? (
              <ScopeTag sel={sel} month={month} onClear={props.onClearSelection} />
            ) : null}
          </span>
        </div>
        <div className="cal-tools">
          <button className="ghost" onClick={props.onPrevMonth}>PREV</button>
          <button className="ghost" onClick={props.onNextMonth}>NEXT</button>
          <button className="ghost" onClick={props.onToday}>TODAY</button>
          <span className="scope">点击一天选中，再点另一天成区间</span>
        </div>
        <div className="legend">
          <span className="legend-cap">当前范围前 {TOP_DIRS} 名</span>
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
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>来源 × 模型</b>
          <span>格内深浅表示量级</span>
          <span className="r">点格下钻</span>
        </div>
        <table className="matrix">
          <thead>
            <tr>
              <th className="l">模型</th>
              {matrix.agents.map(a => (
                <th key={a.id}>{a.id}</th>
              ))}
              <th>合计</th>
            </tr>
          </thead>
          <tbody>
            {keep.concat(rest).map(m => {
              const totalOfModel = matrix.agents.reduce(
                (s, a) => s + (matrix.cells[a.id]?.[m.id] ?? 0),
                0
              );
              return (
                <tr key={m.id}>
                  <td className="l">{modelLabel(m.model, m.vendor)}</td>
                  {matrix.agents.map(a => {
                    const v = matrix.cells[a.id]?.[m.id] ?? 0;
                    return (
                      <td
                        key={a.id}
                        className="c"
                        onClick={() => props.onOpenCell(a.id, m.model, m.vendor)}
                        style={heatStyle(v, matrix.maxCell)}
                      >
                        {v ? tok(v) : '-'}
                      </td>
                    );
                  })}
                  <td>{tok(totalOfModel)}</td>
                </tr>
              );
            })}
            <tr>
              <td className="l">合计</td>
              {matrix.agents.map(a => (
                <td key={a.id}>{tok(rowTotal(a.id))}</td>
              ))}
              <td>{tok(matrix.agents.reduce((s, a) => s + rowTotal(a.id), 0))}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>模型用量</b>
          <span>按 token 降序</span>
        </div>
        <div className="bars">
          {models.map(x => (
            <div className="row" key={x.model + '|' + (x.vendor ?? '')}>
              <div className="top">
                <span>{modelLabel(x.model, x.vendor)}</span>
                <span className="dots" />
                <span className="v">
                  {fmtPct(x.tokens / (agg.total || 1))} / {tok(x.tokens)}
                </span>
              </div>
              <div className="track">
                <i style={{ width: (x.tokens / (agg.total || 1) * 100).toFixed(1) + '%' }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>目录用量</b>
          <span>点一行查看该目录的会话</span>
        </div>
        <div className="bars">
          {agg.byDir.map(x => (
            <div
              className="row"
              key={x.path}
              data-dir={x.path}
              onClick={() => props.onOpenDir(x.path)}
              style={{ cursor: 'pointer' }}
            >
              <div className="top">
                <span>
                  <span className="dot" style={{ background: x.color || 'var(--ink)' }} />
                  {x.name}
                </span>
                <span className="dots" />
                <span className="v">
                  {fmtPct(x.tokens / (agg.total || 1))} / {tok(x.tokens)}
                </span>
              </div>
              <div className="track">
                <i
                  style={{
                    width: (x.tokens / (agg.total || 1) * 100).toFixed(1) + '%',
                    background: x.color || 'var(--ink)'
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>NOTE</b>
          <span>口径</span>
        </div>
        <div style={{ fontSize: 9.5, color: 'var(--muted)' }}>
          四桶合计等于该范围的 token 总量。子 agent 用量归入发起轮次，不重复计数。日期按
          Asia/Shanghai 折算自然日。看板只统计 token，不折算金额：订阅、同名模型不同渠道、
          波峰波谷价都让单价不唯一，算出来的钱没有可比性。
        </div>
      </div>
    </>
  );
}
