// 时间。库里存 UTC 毫秒，按日聚合时折算成本机时区。

const TZ = 'Asia/Shanghai';

/** 本机时区下的 YYYY-MM-DD。 */
export function localDay(ts: number): string {
  const d = new Date(ts);
  // 取本机时区（这里用固定的 Asia/Shanghai，和配置一致）。
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find(p => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 本机时区下的 HH:MM。 */
export function localTime(ts: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find(p => p.type === t)!.value;
  return `${get('hour')}:${get('minute')}`;
}

/** 本机时区下的 YYYY 年 M 月。 */
export function localMonth(ts: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit'
  }).formatToParts(new Date(ts));
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
