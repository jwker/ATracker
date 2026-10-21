import type { CSSProperties } from 'react';
import type {
  AggregatePayload,
  CalendarPayload,
  MatrixPayload,
  TotalPayload
} from '../types.ts';
import type { Selection, Unit } from '../state.ts';
import { LeadRow } from '../components/LeadRow.tsx';
import {
  abbr,
  fmtPct,
  fmtTok,
  money,
  moneyUsd,
  monthMeta,
  pad,
  scopeText
} from '../format.ts';

interface HomeViewProps {
  total: TotalPayload;
  cal: CalendarPayload;
  agg: AggregatePayload;
  matrix: MatrixPayload;
  month: string;
  sel: Selection | null;
  offDirs: string[];
  unit: Unit;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
  onSelectDay: (day: string) => void;
  onToggleDir: (path: string) => void;
  onOpenDir: (path: string) => void;
  onOpenCell: (agent: string, model: string) => void;
}

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
  const { total, cal, agg, matrix, month, sel, offDirs, unit } = props;
  const tok = (n: number) => fmtTok(n, unit);
  const meta = monthMeta(month);
  const comp = [
    { key: 'input', label: '输入 / 未命中缓存', v: agg.buckets.input },
    { key: 'output', label: '输出 / 含推理', v: agg.buckets.output },
    { key: 'cacheRead', label: '缓存命中', v: agg.buckets.cacheRead },
    { key: 'cacheWrite', label: '缓存写入 / 首次写入', v: agg.buckets.cacheWrite }
  ];
  const dirs = agg.byDir
    .filter(d => !offDirs.includes(d.path))
    .map((d, i) => ({ ...d, slot: i }));
  const models = agg.byModel;
  const miss = total.unpricedTokens > 0 ? 1 : 0;

  const dayItems = (day: string) => {
    const rec = cal.days.find(d => d.day === day);
    if (!rec) return [];
    const ranked = cal.dirs.filter(
      d => !offDirs.includes(d.path) && (rec.byDir[d.path] ?? 0) > 0
    );
    const sum = ranked.reduce((s, d) => s + (rec.byDir[d.path] ?? 0), 0) || 1;
    return ranked.map(d => ({
      path: d.path,
      color: d.color,
      v: rec.byDir[d.path] ?? 0,
      pct: ((rec.byDir[d.path] ?? 0) / sum) * 100
    }));
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
            <div className="lab">TOTAL TOKENS / 全部记录</div>
            <div className="val">{tok(total.total)}</div>
            <div className="tiny">
              {abbr(total.total)} / 覆盖 {total.days ?? 0} 天 / 四桶合计
            </div>
          </div>
          <div className="side">
            <div className="lab">ESTIMATED COST</div>
            <div className="money">{money(total.costCny)}</div>
            <div className="tiny">
              {moneyUsd(total.costCny)} / 汇率 6.5
              {miss ? ` / ${miss} 个模型无价格` : ''}
            </div>
          </div>
        </div>
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>TOKEN 四桶</b>
          <span>当前范围 {scopeText(sel, month)}</span>
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
          <span className="r">{scopeText(sel, month)}</span>
        </div>
        <div className="cal-tools">
          <button className="ghost" onClick={props.onPrevMonth}>PREV</button>
          <button className="ghost" onClick={props.onNextMonth}>NEXT</button>
          <button className="ghost" onClick={props.onToday}>TODAY</button>
          <span className="scope">点击一天选中，再点另一天成区间</span>
        </div>
        <div className="legend">
          {cal.dirs.map(d => {
            const off = offDirs.includes(d.path);
            return (
              <button
                key={d.path}
                className="lg"
                data-legend={d.path}
                onClick={() => props.onToggleDir(d.path)}
                aria-pressed={!off}
              >
                <span className="sw" style={{ background: d.color }} />
                {d.name}
                <span className="n">{tok(d.tokens)}</span>
              </button>
            );
          })}
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
                  <td className="l">{m.id}</td>
                  {matrix.agents.map(a => {
                    const v = matrix.cells[a.id]?.[m.id] ?? 0;
                    return (
                      <td
                        key={a.id}
                        className="c"
                        onClick={() => props.onOpenCell(a.id, m.id)}
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
            <div className="row" key={x.model}>
              <div className="top">
                <span>{x.model}</span>
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
          {dirs.map(x => (
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
          Asia/Shanghai 折算自然日。价格来自 config/pricing.json，人民币按 6.5 折算。
        </div>
      </div>
    </>
  );
}
