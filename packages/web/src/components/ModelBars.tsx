// 模型用量条形列表。总账和月度共用，喂进去的是各自区间的汇总。

import type { ModelAggregate } from '../types.ts';
import type { Unit } from '../state.ts';
import { fmtPct, fmtTok, modelLabel } from '../format.ts';

/** 最多列几行，剩下的合并成「其他」。全期模型可能有十几二十个，不截断会拉成一屏。 */
const TOP_N = 6;

interface ModelBarsProps {
  models: ModelAggregate[];
  /** 分母，用于算占比和条长 */
  total: number;
  unit: Unit;
}

export function ModelBars({ models, total, unit }: ModelBarsProps) {
  const tok = (n: number) => fmtTok(n, unit);
  const keep = models.slice(0, TOP_N);
  const rest = models.slice(TOP_N);
  const restTokens = rest.reduce((s, m) => s + m.tokens, 0);

  return (
    <div className="bars">
      {keep.map(m => (
        <div className="row" key={m.model + '|' + (m.vendor ?? '')}>
          <div className="top">
            <span>{modelLabel(m.model, m.vendor)}</span>
            <span className="dots" />
            <span className="v">
              {fmtPct(m.tokens / (total || 1))} / {tok(m.tokens)}
            </span>
          </div>
          <div className="track">
            <i style={{ width: (m.tokens / (total || 1) * 100).toFixed(1) + '%' }} />
          </div>
        </div>
      ))}
      {rest.length > 0 && (
        <div className="row">
          <div className="top">
            <span>其他 {rest.length} 个模型</span>
            <span className="dots" />
            <span className="v">
              {fmtPct(restTokens / (total || 1))} / {tok(restTokens)}
            </span>
          </div>
          <div className="track">
            <i style={{ width: (restTokens / (total || 1) * 100).toFixed(1) + '%' }} />
          </div>
        </div>
      )}
    </div>
  );
}
