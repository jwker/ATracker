// 公共类型。采集器只产出 UsageEvent，其余类型各层自己定义。

/**
 * 来源 id。服务端矩阵、采集器前缀、按来源分组的聚合键都用它。
 *
 * 用字面量联合而不是普通 string：来源 id 拼错一个字母不会报错，
 * 只会在统计里多出一条「未知来源」维度，把用量拆散。
 */
export type AgentId = 'codex' | 'claude-code' | 'pi' | 'opencode' | 'dsh';

/** 全部来源。顺序按界面上的矩阵排列。 */
export const AGENT_IDS: AgentId[] = ['codex', 'claude-code', 'pi', 'opencode', 'dsh'];

/**
 * 一次调用的四个 token 桶。推理是输出的子集，只做拆分展示。
 *
 * 不变量（采集端要保证，脏数据会直接污染聚合表）：
 * - 四个字段都是有限非负整数
 * - 0 <= reasoning <= output
 *
 * **总量口径 = input + output + cacheRead + cacheWrite**，不含 reasoning。
 * reasoning 是 output 的子集，算总量时再加一次就重复了。
 * 求和请走 totalBuckets()，别自己把 buckets 里的字段全加起来。
 */
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

/**
 * 总量。四个桶之和，不含 reasoning。
 *
 * 这是全站唯一的求和口径。各处自己写 input + output + cacheRead + cacheWrite
 * 迟早有一处漏项或者多加一项。
 */
export function totalBuckets(b: Pick<TokenBuckets, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): number {
  return b.input + b.output + b.cacheRead + b.cacheWrite;
}

/** 一条用量事件。 */
export interface UsageEvent {
  /**
   * 稳定唯一键，去重靠它。库里是主键，写入走 ON CONFLICT DO UPDATE。
   *
   * 三条要求，破了都不是「统计偏差」而是数据被悄悄改写：
   * 1. 带来源前缀（`codex:` / `pi:` …）。不同来源撞到同一主键时，
   *    后写入的那条会把前一条的 agent / session / ts 整体覆盖
   * 2. 从内容稳定派生，不能依赖扫描顺序或行号。同一事件第二次扫描
   *    必须得到同一个 id，否则重扫之后库里多出一份，token 直接翻倍
   * 3. 全局唯一，跨设备也要唯一
   *
   * 采集端请用 eventId() 构造，不要手拼字符串。
   */
  eventId: string;
  /** 来源 id */
  agent: AgentId;
  sessionId: string;
  /**
   * 父会话 id；子 agent 和派生线程填这里。
   *
   * 和 isChild 的关系：isChild 为 true 时这里应该有值；为 false 时应该是 null。
   * 采集端要保证这个约束，见下面 eventId 的说明。
   */
  parentSessionId: string | null;
  /** 是否是子 agent 或派生线程产生的用量 */
  isChild: boolean;
  /**
   * UTC 毫秒整数。
   *
   * 解析不出来就丢掉这条事件，不要兜底成当前时间——兜底会把历史用量
   * 记到扫描那一天，按天和按小时的聚合会跟着偏移。
   */
  ts: number;
  /**
   * 工作目录绝对路径。
   *
   * 空串表示「这个来源没给目录」。它会作为一个真实目录进入按目录聚合和
   * 配色，界面上显示成「未知目录」。同一个目录的不同写法（尾斜杠、
   * 软链接、大小写）要归一成同一个，采集端写之前先做路径归一。
   */
  cwd: string;
  /** 模型标识，保留原始写法 */
  model: string;
  /**
   * 来源自报的渠道名（比如 opencode / opencode-go），不是厂商。
   * 厂商是扫描阶段 resolveVendor(model, provider) 推断出来的结果。
   * 来源没自报就填 null，交给 catalog 按模型名推断。
   */
  provider: string | null;
  buckets: TokenBuckets;
  /** 思考档位，仅 pi 提供 */
  thinkingLevel: string | null;
}

/**
 * 构造事件 id。
 *
 * 采集端统一走这里，避免各来源手拼字符串时漏掉前缀或者用上会变的部分
 * （行号、扫描序号）。parts 里要放能从内容稳定派生的东西。
 */
export function eventId(agent: AgentId, ...parts: (string | number)[]): string {
  return `${agent}:${parts.join(':')}`;
}
