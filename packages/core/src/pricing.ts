// 价格表读取与成本计算。全站只有这里算钱。
import { readFileSync } from 'node:fs';
import { RATE } from './money.ts';

export type Currency = 'USD' | 'CNY';

export interface PriceEntry {
  /** 计价货币，默认 USD */
  currency?: Currency;
  /** 每百万 token 的单价 */
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** 按单次请求的输入长度分档 */
  tiers?: Tier[];
  /** 按调用时刻变价 */
  schedule?: Schedule;
  note?: string;
}

export interface Tier {
  /** 阈值：该次请求的总输入超过它就用这一档 */
  inputTokensAbove: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface Schedule {
  /** UTC 小时区间，左闭右开。落在这个区间里是波峰价 */
  peakHoursUtc: [number, number][];
  /** 波谷价 = 波峰价 × 这个系数 */
  offPeakMultiplier: number;
  /** 从某天起，北京时间的周末整天算波谷 */
  weekendOffPeak?: { timezone: string; from: string };
}

export interface PricingFile {
  models?: Record<string, PriceEntry>;
  rules?: { match: string; price: Omit<PriceEntry, 'tiers' | 'schedule' | 'note'> }[];
  providers?: Record<string, { default: Omit<PriceEntry, 'tiers' | 'schedule' | 'note'> }>;
  byAgent?: Record<string, Record<string, Omit<PriceEntry, 'tiers' | 'schedule' | 'note'>>>;
  fallback?: Omit<PriceEntry, 'tiers' | 'schedule' | 'note'>;
}

export type CostSource = 'reported' | 'priced' | 'estimated' | 'missing';

export interface CostResult {
  /** 人民币金额；没有价格时是 null，不按 0 计 */
  cny: number | null;
  source: CostSource;
  /** 命中的价格说明，给日志用 */
  note: string;
}

interface Resolved {
  entry: PriceEntry;
  /** 命中方式，决定是精确值还是估算值 */
  kind: 'exact' | 'byAgent' | 'rule' | 'provider' | 'fallback';
  label: string;
}

/** 折成美元每百万 token。CNY 条目按固定汇率换算。 */
function toUsd(entry: PriceEntry): { input: number; output: number; cache_read: number; cache_write: number } {
  const k = entry.currency === 'CNY' ? 1 / RATE : 1;
  return {
    input: entry.input * k,
    output: entry.output * k,
    cache_read: entry.cache_read * k,
    cache_write: entry.cache_write * k
  };
}

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(value);
}

/** 该次请求的总输入：未缓存输入加缓存命中。分档阈值按这个量比。 */
function totalInput(input: number, cacheRead: number): number {
  return input + cacheRead;
}

/** 判断这个时刻是波峰还是波谷。 */
export function isOffPeak(ts: number, schedule: Schedule): boolean {
  const d = new Date(ts);
  const hour = d.getUTCHours();
  const inPeak = schedule.peakHoursUtc.some(([from, to]) => hour >= from && hour < to);
  if (inPeak) return false;

  const wk = schedule.weekendOffPeak;
  if (wk) {
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: wk.timezone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d);
    const get = (t: string) => local.find(p => p.type === t)!.value;
    const day = `${get('year')}-${get('month')}-${get('day')}`;
    if (day >= wk.from) {
      const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
      if (weekday === 0 || weekday === 6) return true;
    }
  }
  return true;
}

export class Pricing {
  private file: PricingFile;

  constructor(file: PricingFile) {
    this.file = file;
  }

  static load(path: string): Pricing {
    return new Pricing(JSON.parse(readFileSync(path, 'utf8')));
  }

  /** 按阶梯找价格。命中即停。 */
  resolve(model: string, agent?: string | null): Resolved | null {
    const byAgent = agent ? this.file.byAgent?.[agent]?.[model] : undefined;
    if (byAgent) return { entry: byAgent, kind: 'byAgent', label: `byAgent.${agent}.${model}` };

    const exact = this.file.models?.[model];
    if (exact) return { entry: exact, kind: 'exact', label: model };

    for (const rule of this.file.rules ?? []) {
      if (globMatch(rule.match, model)) return { entry: rule.price, kind: 'rule', label: `rule:${rule.match}` };
    }

    const provider = this.file.providers?.[model]?.default;
    if (provider) return { entry: provider, kind: 'provider', label: `provider:${model}` };

    if (this.file.fallback) return { entry: this.file.fallback, kind: 'fallback', label: 'fallback' };
    return null;
  }

  /**
   * 算一条事件的成本。
   * @param ts 事件时刻，波峰波谷按它判定
   * @param agent 来源 id
   * @param model 模型标识
   * @param buckets 四个桶
   * @param reportedUsd 来源自带的成本，有就优先用
   */
  cost(
    ts: number,
    agent: string,
    model: string,
    buckets: { input: number; output: number; cacheRead: number; cacheWrite: number },
    reportedUsd: number | null
  ): CostResult {
    const r = this.resolve(model, agent);

    // 价格表用人民币定价的模型，一律按表里的官方人民币价算，不用来源自报的数。
    // 来源自报的是美元（pi 的模型目录按 6.694 的汇率从人民币价折出来），
    // 再乘 6.5 会和表里的口径差 3% 左右，两套汇率混在一个报表里对不上账。
    const useTable = r !== null && r.entry.currency === 'CNY';

    if (!useTable && reportedUsd !== null) {
      return { cny: reportedUsd * RATE, source: 'reported', note: '来源自带' };
    }

    if (!r) return { cny: null, source: 'missing', note: `没有 ${model} 的价格` };

    let entry = r.entry;

    // 分档：按该次请求的总输入选档
    const total = totalInput(buckets.input, buckets.cacheRead);
    for (const tier of entry.tiers ?? []) {
      if (total > tier.inputTokensAbove) {
        entry = { ...entry, input: tier.input, output: tier.output, cache_read: tier.cache_read, cache_write: tier.cache_write };
        break;
      }
    }

    let p = toUsd(entry);

    // 波峰波谷：波谷价 = 波峰价 × 系数
    if (entry.schedule && isOffPeak(ts, entry.schedule)) {
      const m = entry.schedule.offPeakMultiplier;
      p = { input: p.input * m, output: p.output * m, cache_read: p.cache_read * m, cache_write: p.cache_write * m };
    }

    // 缓存写入价填 0 表示厂商不单独收写入费，这部分 token 按输入价计费
    // （PRD 2.3.1：统一统计到输入内）。
    const writePrice = p.cache_write > 0 ? p.cache_write : p.input;

    const usd =
      (buckets.input * p.input +
        buckets.output * p.output +
        buckets.cacheRead * p.cache_read +
        buckets.cacheWrite * writePrice) / 1e6;

    // 只有精确命中才是确定值，规则、厂商默认、兜底都是估算
    const source: CostSource = r.kind === 'exact' || r.kind === 'byAgent' ? 'priced' : 'estimated';
    return { cny: usd * RATE, source, note: r.label };
  }

  /** 没有精确价格的模型列表。 */
  modelsWithoutExactPrice(): string[] {
    return Object.entries(this.file.models ?? {})
      .filter(([, e]) => !e)
      .map(([k]) => k);
  }
}
