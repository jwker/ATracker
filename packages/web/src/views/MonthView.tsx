// 月度：一个月或一个选区。日历只在这里。
// 范围标签在总量之上，是页面上唯一的时间入口；其余区块跟总账完全同构。

import type { AggregatePayload, CalendarPayload, MatrixPayload } from '../types.ts';
import type { Selection, Unit } from '../state.ts';
import { BucketStrip } from '../components/BucketStrip.tsx';
import { CalendarMonth } from '../components/CalendarMonth.tsx';
import { DirBars } from '../components/DirBars.tsx';
import { ModelBars } from '../components/ModelBars.tsx';
import { ModelMatrix } from '../components/ModelMatrix.tsx';
import { ScopeTag } from '../components/ScopeTag.tsx';
import { fmtPct, fmtTok } from '../format.ts';

interface MonthViewProps {
  cal: CalendarPayload;
  agg: AggregatePayload;
  matrix: MatrixPayload;
  month: string;
  sel: Selection | null;
  unit: Unit;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onThisMonth: () => void;
  onSelectDay: (day: string) => void;
  onClearSelection: () => void;
  onOpenDay: (day: string) => void;
  onOpenDir: (path: string) => void;
  onOpenCell: (agent: string, model: string, vendor: string | null) => void;
}

export function MonthView(props: MonthViewProps) {
  const { cal, agg, matrix, month, sel, unit } = props;
  const tok = (n: number) => fmtTok(n, unit);

  const b = agg.buckets;
  const hitRate = b.input + b.cacheRead > 0 ? b.cacheRead / (b.input + b.cacheRead) : 0;

  return (
    <>
      <ScopeTag
        sel={sel}
        month={month}
        onClear={props.onClearSelection}
        onOpenDay={props.onOpenDay}
      />

      <div className="total-line">
        <div>
          <div className="lab">TOKEN 总量</div>
          <div className="val">{tok(agg.total)}</div>
          <div className="tiny">
            {sel ? '选中区间' : '当月'} / 覆盖 {agg.days} 天
          </div>
        </div>
        <div className="side">
          <div className="lab">缓存命中率</div>
          <div className="hero">{fmtPct(hitRate)}</div>
          <div className="tiny">
            命中 {tok(b.cacheRead)} / 未命中 {tok(b.input)}
          </div>
        </div>
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>TOKEN 四桶</b>
          <span className="r">{tok(agg.total)}</span>
        </div>
        <BucketStrip buckets={{ ...b, reasoning: 0 }} total={agg.total} unit={unit} />
      </div>

      <div className="sec">
        <CalendarMonth
          cal={cal}
          month={month}
          sel={sel}
          unit={unit}
          dirs={agg.byDir}
          total={agg.total}
          onPrevMonth={props.onPrevMonth}
          onNextMonth={props.onNextMonth}
          onThisMonth={props.onThisMonth}
          onSelectDay={props.onSelectDay}
        />
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>来源 × 模型</b>
          <span>格内深浅表示量级</span>
          <span className="r">点格下钻</span>
        </div>
        <ModelMatrix matrix={matrix} unit={unit} onOpenCell={props.onOpenCell} />
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>模型用量</b>
          <span>按 token 降序</span>
        </div>
        <ModelBars models={agg.byModel} total={agg.total} unit={unit} />
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>目录用量</b>
          <span>点一行查看该目录的会话</span>
        </div>
        <DirBars dirs={agg.byDir} total={agg.total} unit={unit} onOpenDir={props.onOpenDir} />
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>NOTE</b>
          <span>口径</span>
        </div>
        <div style={{ fontSize: 9.5, color: 'var(--muted)' }}>
          四桶合计等于选中区间的 token 总量。子 agent 用量归入发起轮次，不重复计数。日期按
          Asia/Shanghai 折算自然日。看板只统计 token，不折算金额。
        </div>
      </div>
    </>
  );
}
