// 公共类型。采集器只产出 UsageEvent，其余类型各层自己定义。

/** 一次调用的四个 token 桶。推理是输出的子集，只做拆分展示。 */
export interface TokenBuckets {
  /** 未命中缓存的输入 */
  input: number;
  /** 输出，含推理 */
  output: number;
  /** 缓存命中（读取缓存） */
  cacheRead: number;
  /** 首次写入缓存 */
  cacheWrite: number;
  /** 推理 token，是 output 的子集 */
  reasoning: number;
}

/** 成本来源。missing 表示没有可用价格，成本留空，不按 0 计。 */
export type CostSource = 'reported' | 'priced' | 'estimated' | 'missing';

/** 一条用量事件。 */
export interface UsageEvent {
  /** 稳定唯一键，去重靠它 */
  eventId: string;
  /** 来源 id：codex / claude-code / pi / opencode / dsh */
  agent: string;
  sessionId: string;
  /** 父会话 id；子 agent 和派生线程填这里 */
  parentSessionId: string | null;
  /** 是否是子 agent 或派生线程产生的用量 */
  isChild: boolean;
  /** UTC 毫秒 */
  ts: number;
  /** 工作目录绝对路径 */
  cwd: string;
  /** 模型标识，保留原始写法 */
  model: string;
  /** 厂商键；来源自报不了就填 null，交给 catalog 推断 */
  provider: string | null;
  buckets: TokenBuckets;
  /** 来源自带的成本（美元）；没有就 null */
  reportedCostUsd: number | null;
  /** 思考档位，仅 pi 提供 */
  thinkingLevel: string | null;
}
