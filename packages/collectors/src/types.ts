// 采集器契约。采集器只做一件事：读文件、产出标准事件。
import type { UsageEvent } from '../../core/src/types.ts';
import type { CostResult } from '../../core/src/pricing.ts';

export type LogLevel = 'ok' | 'info' | 'warn' | 'err';

export interface ScanContext {
  /** 列出根目录下的文件（递归）。 */
  files(root: string, filter?: (path: string) => boolean): Promise<string[]>;
  /** 读纯文本文件，从 offset 开始逐行。offset 是字节位置。 */
  lines(path: string, fromOffset: number): AsyncGenerator<{ line: string; endOffset: number }>;
  /** 读 zstd 文件，逐帧逐行。压缩文件不支持断点续读，整读一遍。 */
  zstdLines(path: string): AsyncGenerator<{ line: string }>;
  /** 记一条日志。 */
  log(level: LogLevel, source: string, message: string): void;
  /** 算这条事件的成本。 */
  price(ev: UsageEvent): CostResult;
  /** 厂商推断：来源自报优先，否则查表。 */
  vendor(model: string, provider: string | null): string | null;
  /** 上一次扫描的同一个会话的累计值，用来算增量。 */
  sessionState(sessionId: string): Map<string, number> | undefined;
  /** 保存会话累计值。 */
  setSessionState(sessionId: string, state: Map<string, number>): void;

  /**
   * 这个文件要不要解析。
   * 指纹没变就跳过；纯文本文件变大了给上次的字节偏移，从那儿接着读；
   * 压缩文件没法续读，但指纹没变时整个跳过。
   */
  shouldParse(path: string): { parse: boolean; offset: number; reason: string };
  /** 解析完记录新的偏移和指纹。 */
  commitFile(path: string, offset: number, complete: boolean): void;
}

/** 一个会话的元信息。标题各来源都有，但字段位置不同。 */
export interface SessionMeta {
  agent: string;
  sessionId: string;
  title: string | null;
  cwd: string | null;
  firstTs: number | null;
  lastTs: number | null;
}

export interface Collector {
  /** 来源 id */
  id: string;
  /** 显示名 */
  label: string;
  /**
   * 解析规则版本。改了采集器的解析逻辑就往上加一位，
   * 游标里存的版本对不上时这个来源的文件会全部重扫。
   */
  version?: string;
  /** 这个来源的数据在哪 */
  roots(): string[];
  /** 产出用量事件 */
  scan(ctx: ScanContext): AsyncGenerator<UsageEvent>;
  /** 产出会话元信息，可选 */
  sessions?(ctx: ScanContext): AsyncGenerator<SessionMeta>;
}
