// 显示层格式化。口径与 packages/core/src/units.ts、time.ts 保持一致。
// 数字换算只在这里做，组件不自己拼单位。

import type { Unit } from './state.ts';

export const UNITS: { id: Unit; label: string }[] = [
  { id: 'zh', label: '中文' },
  { id: 'abbr', label: '缩写' },
  { id: 'full', label: '千分位' }
];

export function zh(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (a >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return Math.round(n).toLocaleString('en-US');
}

export function abbr(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

export function full(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function fmtTok(n: number, unit: Unit): string {
  if (unit === 'abbr') return abbr(n);
  if (unit === 'full') return full(n);
  return zh(n);
}

export function fmtPct(ratio: number): string {
  return (ratio * 100).toFixed(1) + '%';
}

/**
 * 模型的显示名：厂商/模型。
 * 同名模型可能挂在不同厂商下（minimax 和 minimax-cn 都有 MiniMax-M3），
 * 只写模型名会看不出区别。没有厂商时只显示模型名。
 */
export function modelLabel(model: string, vendor: string | null | undefined): string {
  return vendor ? `${vendor}/${model}` : model;
}

export const pad = (n: number): string => String(n).padStart(2, '0');

export interface MonthMeta {
  y: number;
  m: number;
  dim: number;
  lead: number;
}

export function monthMeta(mk: string): MonthMeta {
  const [y, m] = mk.split('-').map(Number);
  return {
    y,
    m,
    dim: new Date(y, m, 0).getDate(),
    lead: (new Date(y, m - 1, 1).getDay() + 6) % 7
  };
}

export function shiftMonth(mk: string, delta: number): string {
  const [y, m] = mk.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function dayOf(ts: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(ts));
}

export function hhmm(ts: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(ts));
}

export function fmtTime(ts: number): string {
  if (!ts) return '';
  return dayOf(ts) + ' ' + hhmm(ts);
}

export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const dim = new Date(y, m, 0).getDate();
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(dim)}` };
}
