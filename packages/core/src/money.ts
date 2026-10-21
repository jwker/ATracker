// 金额。成本表可以用美元或人民币记账，内部统一折算成人民币。

/** 固定汇率，美元兑人民币。不做配置项。 */
export const RATE = 6.5;

/** 美元金额转人民币。 */
export function usdToCny(usd: number): number {
  return usd * RATE;
}

/** 人民币金额转美元。 */
export function cnyToUsd(cny: number): number {
  return cny / RATE;
}

/** 人民币显示，主单位。 */
export function money(cny: number): string {
  return '¥' + cny.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 美元显示，副单位。 */
export function moneyUsd(cny: number): string {
  return '$' + cnyToUsd(cny).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
