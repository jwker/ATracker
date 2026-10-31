// 来源 × 模型交叉表。行是模型（厂商/模型名），列是来源，点格下钻到会话。

import type { CSSProperties } from 'react';
import type { MatrixPayload } from '../types.ts';
import type { Unit } from '../state.ts';
import { fmtTok, modelLabel } from '../format.ts';

function heatStyle(v: number, max: number): CSSProperties {
  if (!v) return { background: 'transparent' };
  const t = Math.min(1, v / (max || 1));
  const pct = Math.round(8 + t * 84);
  return {
    background: `color-mix(in srgb, var(--ink) ${pct}%, transparent)`,
    color: t > 0.55 ? 'var(--paper)' : 'var(--ink)'
  };
}

interface ModelMatrixProps {
  matrix: MatrixPayload;
  unit: Unit;
  onOpenCell: (agent: string, model: string, vendor: string | null) => void;
}

export function ModelMatrix({ matrix, unit, onOpenCell }: ModelMatrixProps) {
  const tok = (n: number) => fmtTok(n, unit);
  const rowTotal = (agent: string) => matrix.rowTotal[agent] ?? 0;
  const grand = matrix.agents.reduce((s, a) => s + rowTotal(a.id), 0);

  return (
    <table className="matrix">
      <thead>
        <tr>
          <th className="l">模型</th>
          {matrix.agents.map(a => (
            <th key={a.id}>{a.id}</th>
          ))}
          <th>合计</th>
        </tr>
      </thead>
      <tbody>
        {matrix.models.map(m => {
          const totalOfModel = matrix.agents.reduce(
            (s, a) => s + (matrix.cells[a.id]?.[m.id] ?? 0),
            0
          );
          return (
            <tr key={m.id}>
              <td className="l">{modelLabel(m.model, m.vendor)}</td>
              {matrix.agents.map(a => {
                const v = matrix.cells[a.id]?.[m.id] ?? 0;
                return (
                  <td
                    key={a.id}
                    className="c"
                    onClick={() => onOpenCell(a.id, m.model, m.vendor)}
                    style={heatStyle(v, matrix.maxCell)}
                  >
                    {v ? tok(v) : '-'}
                  </td>
                );
              })}
              <td>{tok(totalOfModel)}</td>
            </tr>
          );
        })}
        <tr>
          <td className="l">合计</td>
          {matrix.agents.map(a => (
            <td key={a.id}>{tok(rowTotal(a.id))}</td>
          ))}
          <td>{tok(grand)}</td>
        </tr>
      </tbody>
    </table>
  );
}
