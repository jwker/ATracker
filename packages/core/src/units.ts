// 三种数字单位。全站只在这里换算，别处不许自己拼后缀。

export type UnitId = 'zh' | 'abbr' | 'full';

export const UNITS: { id: UnitId; label: string }[] = [
  { id: 'zh', label: '中文' },
  { id: 'abbr', label: '缩写' },
  { id: 'full', label: '千分位' }
];

/** 类型 A：中文单位。亿 = 10^8，万 = 10^4，小于一万用千分位整数。 */
export function zh(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (a >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return Math.round(n).toLocaleString('en-US');
}

/**
 * 类型 B：缩写单位。B = 10^9，M = 10^6，K = 10^3。
 * 注意和类型 A 不可互换：1 亿 = 10^8，而 1B = 10^9。
 */
export function abbr(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

/** 类型 C：千分位纯数字。 */
export function full(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function fmtTok(n: number, unit: UnitId): string {
  if (unit === 'zh') return zh(n);
  if (unit === 'abbr') return abbr(n);
  return full(n);
}

export function fmtPct(ratio: number): string {
  return (ratio * 100).toFixed(1) + '%';
}
