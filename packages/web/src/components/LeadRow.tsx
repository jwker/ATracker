// 小票上的一行：左边标签，中间点线，右边数字。
// 总账页、月度页、今日页、会话页都用它，样式一致。

/** 样式表里定义过的类名。传别的名字不会报错，只会静默失效。 */
export type LeadRowCls = 'muted' | 'acc';

export function LeadRow({ label, value, cls }: { label: string; value: string; cls?: LeadRowCls }) {
  return (
    <div className="leadrow">
      <span className="nm">{label}</span>
      {/* 点线是纯装饰（CSS 里用 border-bottom 画），标一下免得被朗读出来 */}
      <span className="dots" aria-hidden="true" />
      <span className={['v', cls].filter(Boolean).join(' ')}>{value}</span>
    </div>
  );
}
