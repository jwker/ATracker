// 采集器契约。采集器只做一件事：读文件、产出标准事件。
import type { UsageEvent } from '../../core/src/types.ts';

export type LogLevel = 'ok' | 'info' | 'warn' | 'err';

/** 会话元信息的读取进度。和用量游标（file_cursor）是两套，不能混用。 */
export interface MetaState {
  /** 这个文件的元信息已经读到哪个字节 */
  offset: number;
  sessionId: string | null;
  cwd: string | null;
  title: string | null;
  firstTs: number | null;
  lastTs: number | null;
}

export interface ScanContext {
  /** 本轮扫描的中止信号。长循环里要周期性检查，超时后才能真的停下来。 */
  readonly signal: AbortSignal;
  /** 列出根目录下的文件（递归）。同一批次内同一个 root 只走一遍树。 */
  files(root: string, filter?: (path: string) => boolean): Promise<string[]>;
  /** 读纯文本文件，从 offset 开始逐行。offset 是字节位置。 */
  lines(path: string, fromOffset: number): AsyncGenerator<{ line: string; endOffset: number; partial: boolean }>;
  /** 读 zstd 文件，逐帧逐行。压缩文件不支持断点续读，整读一遍。 */
  zstdLines(path: string): AsyncGenerator<{ line: string }>;
  /** 记一条日志。 */
  log(level: LogLevel, source: string, message: string): void;
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

  /**
   * 上一次读这个文件时累积的会话元信息。没有记录（第一次读、文件被重写）给 null。
   * 有了它就不必每次都从文件头重读一遍整份 jsonl。
   */
  meta(path: string): MetaState | null;
  /** 记下这次读到的元信息。游标和 file_cursor 是分开的两套。 */
  commitMeta(path: string, patch: MetaState): void;
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
