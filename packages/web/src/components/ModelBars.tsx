// 模型用量条形列表。总账和月度共用，喂进去的是各自区间的汇总。

import type { ModelAggregate } from '../types.ts';
import type { Unit } from '../state.ts';
import { fmtPct, fmtTok, modelLabel } from '../format.ts';

/** 最多列几行，剩下的合并成「其他」。全期模型可能有十几二十个，不截断会拉成一屏。 */
const TOP_N = 6;

interface ModelBarsProps {
  /**
   * 模型列表。必须已经按 token 降序——截断成「前 N 个 + 其他」，
   * 顺序不对的话「其他」里装的就是最大的那几个。
   * 组件内会自己再排一次，不依赖调用方的顺序。
   */
  models: ModelAggregate[];
  /** 分母，用于算占比和条长 */
  total: number;
  unit: Unit;
}

export function ModelBars({ models, total, unit }: ModelBarsProps) {
  const tok = (n: number) => fmtTok(n, unit);
  const sorted = [...models].sort((a, b) => b.tokens - a.tokens);
  const keep = sorted.slice(0, TOP_N);
  const rest = sorted.slice(TOP_N);
  const restTokens = rest.reduce((s, m) => s + m.tokens, 0);
  // 分母用模型合计兜底。total 和 models 对不上时（两张聚合表走了不同查询），
  // 占比会超过 100%，条会画到容器外面。
  const denom = total > 0 ? total : sorted.reduce((s, m) => s + m.tokens, 0);
  const ratio = (n: number) => (denom > 0 ? Math.min(1, n / denom) : 0);

  return (
    <div className="bars">
      {keep.map(m => (
        <div className="row" key={m.model + '|' + (m.vendor ?? '')}>
          <div className="top">
            <span>{modelLabel(m.model, m.vendor)}</span>
            <span className="dots" />
            <span className="v">
              {fmtPct(ratio(m.tokens))} / {tok(m.tokens)}
            </span>
          </div>
          <div className="track">
            <i style={{ width: (ratio(m.tokens) * 100).toFixed(1) + '%' }} />
          </div>
        </div>
      ))}
      {rest.length > 0 && (
        <div className="row">
          <div className="top">
            {/* rest 是 (model, vendor) 行数。同一个模型挂在不同厂商下会被算成两个 */}
            <span>其他 {rest.length} 个</span>
            <span className="dots" />
            <span className="v">
              {fmtPct(ratio(restTokens))} / {tok(restTokens)}
            </span>
          </div>
          <div className="track">
            <i style={{ width: (ratio(restTokens) * 100).toFixed(1) + '%' }} />
          </div>
        </div>
      )}
    </div>
  );
}
