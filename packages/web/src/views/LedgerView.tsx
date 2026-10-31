// 总账：全部记录。页面上只有一个作用域，没有日历、没有范围切换。
// 想看某个月或某个区间去「月度」页，顶部那行说明会指路。

import type { AggregatePayload, MatrixPayload, TotalPayload } from '../types.ts';
import type { Unit } from '../state.ts';
import { BucketStrip } from '../components/BucketStrip.tsx';
import { DirBars } from '../components/DirBars.tsx';
import { ModelBars } from '../components/ModelBars.tsx';
import { ModelMatrix } from '../components/ModelMatrix.tsx';
import { fmtPct, fmtTok } from '../format.ts';

interface LedgerViewProps {
  total: TotalPayload;
  agg: AggregatePayload;
  matrix: MatrixPayload;
  unit: Unit;
  onOpenDir: (path: string) => void;
  onOpenCell: (agent: string, model: string, vendor: string | null) => void;
}

export function LedgerView(props: LedgerViewProps) {
  const { total, agg, matrix, unit } = props;
  const tok = (n: number) => fmtTok(n, unit);

  const b = total.buckets;
  const hitRate = b.input + b.cacheRead > 0 ? b.cacheRead / (b.input + b.cacheRead) : 0;

  return (
    <>
      <div className="fixed-scope">
        <span className="chip">全期</span>
        <span className="v">
          {total.firstDay ? `覆盖 ${total.days} 天 · ${total.firstDay} → ${total.lastDay}` : '还没有记录'}
        </span>
        <span className="hint">看某个月或某个区间，去「月度」</span>
      </div>

      <div className="total-line">
        <div>
          <div className="lab">TOKEN 总量</div>
          <div className="val">{tok(total.total)}</div>
          <div className="tiny">全期累计 / 四桶合计</div>
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
          <span className="r">{tok(total.total)}</span>
        </div>
        <BucketStrip buckets={b} total={total.total} unit={unit} />
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
          四桶合计等于全期 token 总量。子 agent 用量归入发起轮次，不重复计数。日期按
          Asia/Shanghai 折算自然日。看板只统计 token，不折算金额。
        </div>
      </div>
    </>
  );
}
