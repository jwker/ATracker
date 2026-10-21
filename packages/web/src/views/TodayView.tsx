import type { CSSProperties } from 'react';

import type { DayPayload } from '../types.ts';
import type { Unit } from '../state.ts';
import { LeadRow } from '../components/LeadRow.tsx';
import { fmtPct, fmtTok, money, moneyUsd, hhmm } from '../format.ts';

interface TodayViewProps {
  day: DayPayload;
  unit: Unit;
  onPrevDay: () => void;
  onNextDay: () => void;
  onToday: () => void;
  onOpenCell: (agent: string, model: string) => void;
  onOpenDir: (dir: string) => void;
}

/** 小时图里柱子区的高度。标签占 15px，柱子按百分比填满剩下的部分。 */
const CHART_H = 96;

const BUCKETS: { key: 'input' | 'output' | 'cacheRead' | 'cacheWrite'; label: string }[] = [
  { key: 'input', label: '输入 / 未命中缓存' },
  { key: 'output', label: '输出 / 含推理' },
  { key: 'cacheRead', label: '缓存命中' },
  { key: 'cacheWrite', label: '缓存写入 / 首次写入' }
];

function heatStyle(v: number, max: number): CSSProperties {
  if (!v) return { background: 'transparent' };
  const t = Math.min(1, v / (max || 1));
  const pct = Math.round(8 + t * 84);
  return {
    background: `color-mix(in srgb, var(--ink) ${pct}%, transparent)`,
    color: t > 0.55 ? 'var(--paper)' : 'var(--ink)'
  };
}

function deltaText(now: number, before: number): string {
  if (!before) return now ? '+100%' : '0%';
  const r = (now - before) / before;
  return (r >= 0 ? '+' : '') + (r * 100).toFixed(0) + '%';
}

export function TodayView(props: TodayViewProps) {
  const { day, unit } = props;
  const tok = (n: number) => fmtTok(n, unit);
  const t = day.today;
  const prev = day.prev;

  // 昨天同一时刻占今天总量的比例，用来给那一条对比条当尺子。
  const prevShare = t.tokens ? prev.tokens / t.tokens : 0;

  const hours = Array.from({ length: 24 }, (_, h) =>
    day.hourly.find(x => x.hour === h) ?? { hour: h, events: 0, tokens: 0, costCny: 0 }
  );
  const maxHour = Math.max(...hours.map(h => h.tokens)) || 1;
  const peak = hours.reduce((a, b) => (b.tokens > a.tokens ? b : a), hours[0]);

  const rowTotal = (agent: string) => day.matrix.rowTotal[agent] ?? 0;

  return (
    <>
      <div className="sec" style={{ marginTop: 4 }}>
        <div className="daybar">
          <button className="ghost" onClick={props.onPrevDay}>前一天</button>
          <button className="ghost" onClick={props.onNextDay}>后一天</button>
          <button className="ghost" onClick={props.onToday}>今天</button>
          <span className="scope">
            {day.date} {day.weekday} / 截至 {day.cutoff}
          </span>
        </div>
        <div className="total-line">
          <div>
            <div className="lab">当日 TOKENS / {day.isToday ? '今天' : day.date}</div>
            <div className="val">{tok(t.tokens)}</div>
            <div className="tiny">
              {t.events} 次调用 / 四桶合计
            </div>
          </div>
          <div className="side">
            <div className="lab">ESTIMATED COST</div>
            <div className="money">{money(t.costCny)}</div>
            <div className="tiny">
              {moneyUsd(t.costCny)} / 汇率 6.5
              {t.unpriced ? ` / ${t.unpriced} 条未定价` : ''}
            </div>
          </div>
        </div>
        <div className="cmp">
          <div className="row">
            <div className="lab">
              <span>昨天同一时刻（截至 {day.cutoff}）</span>
              <span>
                {tok(prev.tokens)}
                <span className="sep">/</span>
                <span className="acc">{deltaText(t.tokens, prev.tokens)}</span>
              </span>
            </div>
            <div className="track">
              <i style={{ width: ((prevShare || 0) * 100).toFixed(1) + '%' }} />
            </div>
            <div className="cmpnote">满格是今天的总量</div>
          </div>
        </div>
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>TOKEN 四桶</b>
          <span>
            当天 / 截至 {day.cutoff} / 思考 {tok(t.buckets.reasoning)}
          </span>
          <span className="r">{tok(t.tokens)}</span>
        </div>
        {BUCKETS.map((b, i) => (
          <LeadRow
            key={b.key}
            label={
              b.key === 'cacheRead'
                ? b.label + ' / ' + fmtPct(t.tokens ? t.buckets.cacheRead / t.tokens : 0)
                : b.label
            }
            value={tok(t.buckets[b.key])}
          />
        ))}
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
              {day.matrix.agents.map(a => (
                <th key={a.id}>{a.id}</th>
              ))}
              <th>合计</th>
            </tr>
          </thead>
          <tbody>
            {day.matrix.models.map(m => {
              const totalOfModel = day.matrix.agents.reduce(
                (s, a) => s + (day.matrix.cells[a.id]?.[m.id] ?? 0),
                0
              );
              return (
                <tr key={m.id}>
                  <td className="l">{m.id}</td>
                  {day.matrix.agents.map(a => {
                    const v = day.matrix.cells[a.id]?.[m.id] ?? 0;
                    return (
                      <td
                        key={a.id}
                        className="c"
                        onClick={() => props.onOpenCell(a.id, m.id)}
                        style={heatStyle(v, day.matrix.maxCell)}
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
              {day.matrix.agents.map(a => (
                <td key={a.id}>{tok(rowTotal(a.id))}</td>
              ))}
              <td>{tok(day.matrix.agents.reduce((s, a) => s + rowTotal(a.id), 0))}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>一天之内</b>
          <span>按小时 / Asia/Shanghai</span>
          <span className="r">活跃 {hours.filter(h => h.events > 0).length} 小时</span>
        </div>
        <div className="hours">
          {hours.map(h => (
            <div
              key={h.hour}
              className={'h' + (h.tokens === peak.tokens && h.tokens > 0 ? ' peak' : '') + (h.events ? '' : ' empty')}
              title={h.hour + ':00 · ' + tok(h.tokens) + ' · ' + money(h.costCny)}
            >
              <div className="plot" style={{ height: CHART_H }}>
                <div
                  className="bar"
                  style={{ height: (h.tokens ? Math.max(2, h.tokens / maxHour * 100) : 1.5) + '%' }}
                />
              </div>
              <div className="lb">{h.hour}</div>
            </div>
          ))}
        </div>
        <div className="hourpeak">
          <span>高峰 {peak.hour}:00 · {tok(peak.tokens)}</span>
          <span>{peak.events} 次调用</span>
        </div>
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>按来源</b>
          <span>BY AGENT</span>
        </div>
        <div className="bars">
          {day.byAgent.map(x => (
            <div className="row" key={x.agent}>
              <div className="top">
                <span>{x.agent}</span>
                <span className="dots" />
                <span className="v">{fmtPct(x.tokens / (t.tokens || 1))} / {tok(x.tokens)}</span>
              </div>
              <div className="track">
                <i style={{ width: (x.tokens / (t.tokens || 1) * 100).toFixed(1) + '%' }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>按模型</b>
          <span>按 token 降序</span>
        </div>
        <div className="bars">
          {day.byModel.map(x => (
            <div className="row" key={x.model}>
              <div className="top">
                <span>{x.model}</span>
                <span className="dots" />
                <span className="v">{fmtPct(x.tokens / (t.tokens || 1))} / {tok(x.tokens)}</span>
              </div>
              <div className="track">
                <i style={{ width: (x.tokens / (t.tokens || 1) * 100).toFixed(1) + '%' }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>按目录</b>
          <span>点一行看该目录的会话</span>
        </div>
        <div className="bars">
          {day.byDir.map(x => (
            <div
              className="row"
              key={x.path}
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
                  {fmtPct(x.tokens / (t.tokens || 1))} / {tok(x.tokens)}
                </span>
              </div>
              <div className="track">
                <i
                  style={{
                    width: (x.tokens / (t.tokens || 1) * 100).toFixed(1) + '%',
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
          <b>当天的会话</b>
          <span>SESSIONS</span>
          <span className="r">{day.sessions.length} 个</span>
        </div>
        {day.sessions.length === 0 ? (
          <div className="placeholder">这一天没有用量记录</div>
        ) : (
          day.sessions.map(s => (
            <div className="daysess" key={s.id}>
              <div className="t">
                {s.title ?? '(无标题)'}
                <span className="muted"> · {s.agent} · {s.events} 次</span>
                <div className="m">
                  <span className="dot" style={{ background: s.color || 'var(--ink)' }} />
                  {s.dirName} · {hhmm(s.firstTs)} → {hhmm(s.lastTs)}
                </div>
              </div>
              <div className="v">
                {tok(s.tokens)}
                <br />
                {money(s.costCny)}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>最贵的几次调用</b>
          <span>TOP CALLS</span>
        </div>
        <table className="daytable">
          <thead>
            <tr>
              <th className="l">时间</th>
              <th className="l">模型</th>
              <th>token</th>
              <th>成本</th>
            </tr>
          </thead>
          <tbody>
            {day.topCalls.map((c, i) => (
              <tr key={c.ts + '-' + i}>
                <td className="l">{c.time}</td>
                <td className="l">
                  {c.model}
                  <div className="muted">{c.agent} · {c.dirName}</div>
                </td>
                <td>{tok(c.tokens)}</td>
                <td>{c.costCny === null ? '未定价' : money(c.costCny)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>采集状态</b>
          <span>当天批次</span>
        </div>
        <table className="daytable">
          <tbody>
            <tr>
              <td className="l">扫描批次</td>
              <td>{day.batches.count} 次</td>
            </tr>
            <tr>
              <td className="l">写入事件</td>
              <td>{day.batches.events_written}</td>
            </tr>
            <tr>
              <td className="l">采集错误</td>
              <td>{day.batches.errors ? day.batches.errors + ' 条' : '无'}</td>
            </tr>
            <tr>
              <td className="l">缺价事件</td>
              <td>{t.unpriced ? t.unpriced + ' 条' : '无'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
