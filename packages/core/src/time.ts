// 时间。库里存 UTC 毫秒，按日聚合时折算成本机时区。

const TZ = 'Asia/Shanghai';

/** 导出的时区名。SQL 里按固定偏移折算时用它对齐。 */
export const TIME_ZONE = TZ;

/**
 * SQL 里用的固定偏移。Asia/Shanghai 全年 UTC+8，没有夏令时，
 * 所以可以用固定偏移折算小时和自然日，不用逐行走 Intl。
 */
export const TZ_SQL_OFFSET = "'+8 hours'";

/**
 * 格式化器只建一次。
 *
 * Intl.DateTimeFormat 的构造比格式化本身还贵，localDay 每条事件都要调一次，
 * 每次新建一个格式化器在事件量大的时候是明显的开销。
 */
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
});
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
});
const monthFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit'
});

/** 本机时区下的 YYYY-MM-DD。 */
export function localDay(ts: number): string {
  const parts = dayFmt.formatToParts(new Date(ts));
  const get = (t: string) => parts.find(p => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 本机时区下的 HH:MM。 */
export function localTime(ts: number): string {
  const parts = timeFmt.formatToParts(new Date(ts));
  const get = (t: string) => parts.find(p => p.type === t)!.value;
  return `${get('hour')}:${get('minute')}`;
}

/** 本机时区下的 YYYY 年 M 月。 */
export function localMonth(ts: number): string {
  const parts = monthFmt.formatToParts(new Date(ts));
  const get = (t: string) => parts.find(p => p.type === t)!.value;
  return `${get('year')} 年 ${Number(get('month'))} 月`;
}

/** 一个月的第一天和天数。 */
export function monthMeta(mk: string): { y: number; m: number; dim: number; first: string } {
  const [y, m] = mk.split('-').map(Number);
  const dim = new Date(y, m, 0).getDate();
  // 2026-10-01 是星期四，前面补 3 格（周一为第一列）。
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const pad = (n: number) => String(n).padStart(2, '0');
  return { y, m, dim, first: `${y}-${pad(m)}` };
}

/** 月份加减。 */
export function shiftMonth(mk: string, delta: number): string {
  const [y, m] = mk.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 月份里的所有日期。 */
export function monthDays(mk: string): string[] {
  const { y, m, dim } = monthMeta(mk);
  const pad = (n: number) => String(n).padStart(2, '0');
  return Array.from({ length: dim }, (_, i) => `${y}-${pad(m)}-${pad(i + 1)}`);
}
