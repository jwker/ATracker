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
  /** 分母，四桶合计 */
  total: number;
  unit: Unit;
}

export function BucketStrip({ buckets, total, unit }: BucketStripProps) {
  return (
    <div className="brow">
      {LABELS.map(b => (
        <div className="c" key={b.key}>
          <div className="k">{b.label}</div>
          <div className="v">
            {fmtTok(buckets[b.key], unit)}
            <span className="s">{fmtPct(total ? buckets[b.key] / total : 0)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
