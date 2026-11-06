// 主进程与渲染进程之间的调用形状。
//
// 三处共用：主进程注册 IPC、preload 暴露桥接、渲染进程取数。只有类型和常量，
// 没有运行时依赖，也不 import electron——渲染进程的构建里不能出现 Node 的东西。

export type ApiMethod = 'GET' | 'POST';

/** 一次接口调用。路径和参数沿用原来的接口形状，分发逻辑见 service/handlers.ts。 */
export interface ApiCall {
  method: ApiMethod;
  path: string;
  params?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
}

/** 分发结果。status 沿用 HTTP 语义：200 成功，400 参数不对，404 没有这个接口，500 内部错误。 */
export interface ApiResult {
  status: number;
  body: unknown;
}

/** 主进程推给窗口的事件。原来走 SSE，现在走 IPC。 */
export type PushEvent =
  | { type: 'scan_done'; batch: number; eventsWritten: number; days: string[]; durationMs: number }
  | { type: 'scan_error'; message: string }
  | { type: 'sync_done'; devices: string[]; rows: number };

/**
 * 构建信息。形状必须和 build/buildinfo.json 一致。
 *
 * 定义放在这里而不是 build.ts：渲染进程要引用它，而 build.ts 依赖 node:fs，
 * 渲染进程的类型检查不应该被拖进 Node 的类型环境。
 */
export interface BuildInfo {
  version: string;
  /** git 短哈希 */
  commit: string;
  /** 打包时工作区是否有未提交改动 */
  dirty: boolean;
  branch: string;
  /** ISO 时间 */
  builtAt: string;
}

/** 窗口启动时拿一次的环境信息。 */
export interface AppInfo {
  version: string;
  platform: string;
  /** 是否打包后的版本 */
  packaged: boolean;
  build: BuildInfo;
}

/** IPC 通道名。集中在这里，避免主进程和 preload 各写一份字符串常量。 */
export const IPC_CHANNEL = {
  request: 'atracker:request',
  event: 'atracker:event',
  info: 'atracker:info',
  openDataDir: 'atracker:open-data-dir'
} as const;

/**
 * preload 暴露到 `window.atracker` 上的形状。
 *
 * 渲染进程自己声明 window 上的类型（见 packages/web/src/env.d.ts），
 * preload 实现这个接口，两边靠类型检查对齐。
 */
export interface AtrackerBridge {
  info(): Promise<AppInfo>;
  request(call: ApiCall): Promise<ApiResult>;
  openDataDir(): Promise<void>;
  onEvent(listener: (event: PushEvent) => void): () => void;
}
