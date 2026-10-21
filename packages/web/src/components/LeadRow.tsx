// 小票上的一行：左边标签，中间点线，右边数字。
// 首页的四桶和今日页的四桶都用它，样式一致。

export function LeadRow({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="leadrow">
      <span className="nm">{label}</span>
      <span className="dots" />
      <span className={'v ' + (cls ?? '')}>{value}</span>
    </div>
  );
}
