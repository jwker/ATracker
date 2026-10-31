// 目录用量条形列表。颜色来自 dir_color 表，点一行下钻到该目录的会话。

import type { DirAggregate } from '../types.ts';
import type { Unit } from '../state.ts';
import { fmtPct, fmtTok } from '../format.ts';

/** 最多列几行，剩下的合并成「其他」。全部目录在会话页按 group 列全。 */
const TOP_N = 6;

interface DirBarsProps {
  dirs: DirAggregate[];
  total: number;
  unit: Unit;
  onOpenDir: (path: string) => void;
}

export function DirBars({ dirs, total, unit, onOpenDir }: DirBarsProps) {
  const tok = (n: number) => fmtTok(n, unit);
  const keep = dirs.slice(0, TOP_N);
  const rest = dirs.slice(TOP_N);
  const restTokens = rest.reduce((s, d) => s + d.tokens, 0);

  return (
    <div className="bars">
      {keep.map(d => (
        <div
          className="row"
          key={d.path}
          data-dir={d.path}
          onClick={() => onOpenDir(d.path)}
          style={{ cursor: 'pointer' }}
        >
          <div className="top">
            <span>
              <span className="dot" style={{ background: d.color || 'var(--ink)' }} />
              {d.name}
            </span>
            <span className="dots" />
            <span className="v">
              {fmtPct(d.tokens / (total || 1))} / {tok(d.tokens)}
            </span>
          </div>
          <div className="track">
            <i
              style={{
                width: (d.tokens / (total || 1) * 100).toFixed(1) + '%',
                background: d.color || 'var(--ink)'
              }}
            />
          </div>
        </div>
      ))}
      {rest.length > 0 && (
        <div className="row">
          <div className="top">
            <span>
              <span className="dot" style={{ background: 'var(--t4)' }} />
              其他 {rest.length} 个目录
            </span>
            <span className="dots" />
            <span className="v">
              {fmtPct(restTokens / (total || 1))} / {tok(restTokens)}
            </span>
          </div>
          <div className="track">
            <i style={{ width: (restTokens / (total || 1) * 100).toFixed(1) + '%', background: 'var(--t4)' }} />
          </div>
        </div>
      )}
    </div>
  );
}
