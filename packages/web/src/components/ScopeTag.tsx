// 当前范围。首页有两处显示：四桶的小节标题，和月历小节标题的右侧。
// 范围决定下面所有数字的算法，所以做成一块能认出来的标签。

import type { Selection } from '../state.ts';
import { monthMeta } from '../format.ts';

interface ScopeTagProps {
  sel: Selection | null;
  month: string;
  /** 有选中时给的清除入口 */
  onClear?: () => void;
}

export function ScopeTag(props: ScopeTagProps) {
  const { sel, month } = props;
  const meta = monthMeta(month);

  const days = !sel
    ? meta.dim
    : sel.a === sel.b
      ? 1
      : Math.round((new Date(sel.b).getTime() - new Date(sel.a).getTime()) / 86400000) + 1;

  const parts = !sel
    ? [`${meta.y} 年 ${meta.m} 月`]
    : sel.a === sel.b
      ? [sel.a]
      : [sel.a, sel.b];

  return (
    <span className="scope">
      <span className="scope-pill">
        {parts.map((p, i) => (
          <span key={p}>
            {i > 0 && <span className="arrow">→</span>}
            {p}
          </span>
        ))}
      </span>
      <span className="scope-badge">{days} 天</span>
      {sel && props.onClear && (
        <button className="scope-x" onClick={props.onClear}>清除</button>
      )}
    </span>
  );
}
