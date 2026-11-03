// 四桶：一行四格。总账、月度、今日三个页面共用，保证口径和排版一致。
// 每格是「标签 / 数值 + 占比」，比原来四行引导线省一半高度。

import type { TokenBuckets } from '../types.ts';
import type { Unit } from '../state.ts';
import { fmtPct, fmtTok } from '../format.ts';

const LABELS: { key: keyof TokenBuckets; label: string }[] = [
  { key: 'input', label: '输入 / 未命中' },
  { key: 'output', label: '输出 / 含推理' },
  { key: 'cacheRead', label: '缓存命中' },
  { key: 'cacheWrite', label: '缓存写入' }
];

interface BucketStripProps {
  buckets: TokenBuckets;
  /**
   * 分母。传了就用它，不传就算四桶之和。
   *
   * 分母必须是四桶之和：调用方单独传一个数，两边一旦不同步
   * （聚合接口的 total 和 buckets 走了不同查询或不同设备过滤），
   * 四个占比就不会加总到 100%，页面上看不出来但数字是错的。
   */
  total?: number;
  unit: Unit;
}

export function BucketStrip({ buckets, total, unit }: BucketStripProps) {
  const sum = LABELS.reduce((a, b) => a + (buckets[b.key] ?? 0), 0);
  // 分母优先用四桶之和，保证四个占比加起来是 100%。
  const denom = sum > 0 ? sum : (total ?? 0);
  return (
    <div className="brow">
      {LABELS.map(b => (
        <div className="c" key={b.key}>
          <div className="k">{b.label}</div>
          <div className="v">
            {fmtTok(buckets[b.key], unit)}
            <span className="s">{fmtPct(denom > 0 ? buckets[b.key] / denom : 0)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
