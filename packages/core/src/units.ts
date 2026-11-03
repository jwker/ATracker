// 三种数字单位。全站只在这里换算，别处不许自己拼后缀。

export type UnitId = 'zh' | 'abbr' | 'full';

export const UNITS: { id: UnitId; label: string }[] = [
  { id: 'zh', label: '中文' },
  { id: 'abbr', label: '缩写' },
  { id: 'full', label: '千分位' }
];

/** 拿不到数的时候显示什么。 */
const NONE = '—';

/** 保留 n 位小数，并把 -0 归成 0。 */
function fixed(n: number, digits: number): string {
  const v = Number(n.toFixed(digits));
  return (v === 0 ? 0 : v).toFixed(digits);
}

/** 千分位整数。 */
function integer(n: number): string {
  const v = Math.round(n);
  return (v === 0 ? 0 : v).toLocaleString('en-US');
}

/**
 * 类型 A：中文单位。亿 = 10^8，万 = 10^4，小于一万用千分位整数。
 *
 * 单位的切换看的是「显示出来的数」而不是原始值：99999999 在万位上是
 * 9999.9999，四舍五入到一位小数就是 10000.0 万——这个读起来比 1 亿还大，
 * 越界了就提升一档，显示成 1.00 亿。
 */
export function zh(n: number): string {
  if (!Number.isFinite(n)) return NONE;
  const a = Math.abs(n);
  if (a >= 1e8) return fixed(n / 1e8, 2) + ' 亿';
  if (a >= 1e4) {
    if (Math.abs(Number((n / 1e4).toFixed(1))) >= 1e4) return fixed(n / 1e8, 2) + ' 亿';
    return fixed(n / 1e4, 1) + ' 万';
  }
  return integer(n);
}

/**
 * 类型 B：缩写单位。B = 10^9，M = 10^6，K = 10^3。
 * 注意和类型 A 不可互换：1 亿 = 10^8，而 1B = 10^9。
 */
export function abbr(n: number): string {
  if (!Number.isFinite(n)) return NONE;
  const a = Math.abs(n);
  if (a >= 1e9) return fixed(n / 1e9, 2) + 'B';
  if (a >= 1e6) {
    if (Math.abs(Number((n / 1e6).toFixed(1))) >= 1e3) return fixed(n / 1e9, 2) + 'B';
    return fixed(n / 1e6, 1) + 'M';
  }
  if (a >= 1e3) {
    if (Math.abs(Number((n / 1e3).toFixed(1))) >= 1e3) return fixed(n / 1e6, 1) + 'M';
    return fixed(n / 1e3, 1) + 'K';
  }
  return integer(n).replace(/,/g, '');
}

/** 类型 C：千分位纯数字。 */
export function full(n: number): string {
  if (!Number.isFinite(n)) return NONE;
  return integer(n);
}

export function fmtTok(n: number, unit: UnitId): string {
  if (unit === 'zh') return zh(n);
  if (unit === 'abbr') return abbr(n);
  return full(n);
}

/** 百分比。参数是 0 到 1 的比率，不是百分数。 */
export function fmtPct(ratio: number): string {
  if (!Number.isFinite(ratio)) return NONE;
  return (ratio * 100).toFixed(1) + '%';
}
