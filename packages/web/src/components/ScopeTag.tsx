// 月度页的范围标签。这是页面上唯一说明「现在看的是哪段」的地方：
// 整月显示月份，选中后显示区间并给出清除入口；选中单天时，右侧出现
// 跳到今日页的入口（今日页是唯一看单天明细的页面）。

import type { Selection } from '../state.ts';
import { monthMeta } from '../format.ts';

interface ScopeTagProps {
  sel: Selection | null;
  month: string;
  onClear: () => void;
  onOpenDay: (day: string) => void;
}

export function ScopeTag({ sel, month, onClear, onOpenDay }: ScopeTagProps) {
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
    <div className="scope-row">
      <span className="lead">范围</span>
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
        {sel && <button className="scope-x" onClick={onClear}>清除</button>}
      </span>
      {sel && sel.a === sel.b && (
        <button className="go" onClick={() => onOpenDay(sel.a)}>查看这天的明细 →</button>
      )}
    </div>
  );
}
