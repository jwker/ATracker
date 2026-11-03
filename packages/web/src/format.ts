// 显示层格式化。数字换算直接用 core 的 units.ts，不在这里再写一份——
// 两份实现迟早会漂移，漂移的表现是同一个数字在两个页面显示得不一样。

import type { Unit } from './state.ts';

export { UNITS, zh, abbr, full, fmtTok, fmtPct } from '../../core/src/units.ts';

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
