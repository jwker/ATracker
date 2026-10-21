import type { ConversationDetail, ConversationsPayload } from '../types.ts';
import type { ConversationFilter, Unit } from '../state.ts';
import { dayOf, fmtTok, hhmm, money, moneyUsd } from '../format.ts';

interface ConversationsViewProps {
  conv: ConversationsPayload;
  detail: ConversationDetail | null;
  convId: string | null;
  filter: ConversationFilter;
  q: string;
  unit: Unit;
  onSelect: (id: string) => void;
  onSearch: (q: string) => void;
  onClear: () => void;
  onGoDay: (day: string) => void;
}

function LeadRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="leadrow">
      <span className="nm">{label}</span>
      <span className="dots" />
      <span className="v">{value}</span>
    </div>
  );
}

export function ConversationsView(props: ConversationsViewProps) {
  const { conv, detail, filter, q, unit } = props;
  const tok = (n: number) => fmtTok(n, unit);
  const flat = conv.groups.flatMap(g => g.list);
  const cur = flat.find(c => c.id === props.convId) ?? flat[0] ?? null;

  let strip = (
    <div className="filterline">
      <span>会话 {flat.length} 条</span>
      {filter.dir && <span className="pill">{filter.dir}</span>}
      {filter.agent && <span className="pill">{filter.agent}</span>}
      {filter.model && <span className="pill">{filter.model}</span>}
      {(filter.dir || filter.agent || filter.model) && (
        <button className="clear" onClick={props.onClear}>清除筛选</button>
      )}
    </div>
  );

  const picker = (
    <>
      {strip}
      <input
        className="search"
        placeholder="搜索会话标题、目录或来源"
        value={q}
        onChange={e => props.onSearch(e.target.value)}
      />
      <div className="pick">
        {conv.groups.map(g =>
          g.list.map(cv => (
            <button
              key={cv.id}
              className="stub"
              data-cv={cv.id}
              onClick={() => props.onSelect(cv.id)}
              aria-current={cv.id === cur?.id}
            >
              <span className="t">{cv.title || cv.sessionId.slice(0, 8)}</span>
              <span className="m">
                {cv.firstTs ? dayOf(cv.firstTs) : '—'} / {cv.agent} / {tok(cv.tokens)}
              </span>
            </button>
          ))
        )}
      </div>
    </>
  );

  if (!cur) {
    return (
      <>
        {picker}
        <div className="placeholder">没有符合筛选条件的会话。换个来源或模型，或者清除筛选。</div>
      </>
    );
  }

  if (!detail || detail.id !== cur.id) {
    return (
      <>
        {picker}
        <div className="placeholder">正在读取会话…</div>
      </>
    );
  }

  const date = cur.firstTs ? dayOf(cur.firstTs) : '—';
  const title = cur.title || cur.sessionId.slice(0, 8);
  const st = detail.stats;
  const turns = detail.events;
  const maxDay = Math.max(0.0001, ...Object.values(st.byDay));

  return (
    <>
      {picker}
      <div className="sec-h" style={{ marginTop: 12 }}>
        <b>SESSION RECEIPT</b>
        <span>{date}</span>
        <span className="r">{tok(st.total)}</span>
      </div>
      <div className="detail-title">{title}</div>
      <div className="detail-meta">
        {cur.dirName} / {cur.agent} / {cur.model}
      </div>
      <div style={{ marginTop: 8 }}>
        {date !== '—' && (
          <button className="ghost" onClick={() => props.onGoDay(date)}>
            在日历中查看这天
          </button>
        )}
      </div>

      <div className="kv">
        <span className="k">日期</span>
        <span>{date}</span>
        <span className="k">轮次</span>
        <span>{cur.events} 轮</span>
        <span className="k">子 agent</span>
        <span>{turns.filter(t => t.isChild).length} 轮</span>
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>TOKEN 构成</b>
          <span>合计 {tok(st.total)}</span>
        </div>
        <LeadRow label="输入" value={tok(st.buckets.input)} />
        <LeadRow label="输出" value={tok(st.buckets.output)} />
        <LeadRow label="缓存命中" value={tok(st.buckets.cacheRead)} />
        <LeadRow label="缓存写入" value={tok(st.buckets.cacheWrite)} />
      </div>

      <div className="sec bars">
        <div className="sec-h">
          <b>成本</b>
          <span>{moneyUsd(st.costCny)} / 汇率 6.5</span>
          <span className="r">{money(st.costCny)}</span>
        </div>
        {st.unpriced > 0 && (
          <div style={{ fontSize: 9, color: 'var(--accent)' }}>
            {st.unpriced} 条用了未配置价格的模型，未计入
          </div>
        )}
        {st.dayRows.map(k => (
          <div className="row" key={k}>
            <div className="top">
              <span>{k}</span>
              <span className="dots" />
              <span className="v">{money(st.byDay[k])}</span>
            </div>
            <div className="track">
              <i
                className="acc"
                style={{ width: ((st.byDay[k] ?? 0) / maxDay * 100).toFixed(1) + '%' }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>逐轮明细</b>
          <span>子 agent 行缩进显示</span>
          {detail.truncated && (
            <span className="r">
              只显示最近 {turns.length} / {detail.eventTotal} 条
            </span>
          )}
        </div>
        <table className="turn">
          <thead>
            <tr>
              <th className="l">时间</th>
              <th className="l">模型</th>
              <th>输入</th>
              <th>输出</th>
              <th>缓存</th>
              <th>成本</th>
              <th className="l">状态</th>
            </tr>
          </thead>
          <tbody>
            {turns.map((t, i) => (
              <tr key={`${t.ts}-${i}`} className={t.isChild ? 'sub' : undefined}>
                <td className="l t">
                  {t.isChild ? '↳ 子 agent' : `${t.localDay} ${hhmm(t.ts)}`}
                </td>
                <td className="l">{t.model}</td>
                <td>{tok(t.input)}</td>
                <td>{tok(t.output)}</td>
                <td>{tok(t.cacheRead)}</td>
                <td>{t.costCny === null ? '--' : money(t.costCny)}</td>
                <td className="l">成功</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>口径</b>
          <span>NOTES</span>
        </div>
        <div style={{ fontSize: 9, color: 'var(--muted)' }}>
          token 分四桶：未缓存输入、输出（含推理）、缓存命中、缓存写入。日期按本机时区折算自然日。
          子 agent 的用量计入总量并归属到发起它的那一轮。价格来自 config/pricing.json。
        </div>
      </div>
    </>
  );
}
