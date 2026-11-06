// 取数层。所有请求都走 preload 暴露的桥，主进程交给 service/handlers.ts 分发。
//
// 形状和以前一样：视图组件调用 api.total(...) 这类方法，不关心底层是 IPC 还是 HTTP。
// 分发结果里的 status 沿用 HTTP 语义，所以错误处理和以前一致。

import type { ApiCall, ApiResult, AtrackerBridge, PushEvent } from '../../core/src/api.ts';
import type {
  AggregatePayload,
  BuildInfo,
  CalendarPayload,
  ConversationDetail,
  ConversationsPayload,
  DayPayload,
  DevicesPayload,
  SyncPayload,
  DoctorPayload,
  LogsPayload,
  MatrixPayload,
  TotalPayload
} from './types.ts';

/** 请求超时。主进程卡住时页面不能一直转圈。 */
const TIMEOUT_MS = 15_000;

/** 桥接对象。页面只在桌面窗口里跑，拿不到就说明 preload 没加载成功。 */
function bridge(): AtrackerBridge {
  const b = window.atracker;
  if (!b) throw new Error('窗口桥接没有加载（preload 没跑起来）');
  return b;
}

/** 把失败的结果转成异常，文案沿用以前接口的 error 字段。 */
function failure(call: ApiCall, result: ApiResult): never {
  const body = result.body;
  const message =
    body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `${call.path} ${result.status}`;
  throw new Error(message);
}

async function invoke<T>(call: ApiCall): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${call.path} 请求超时`)), TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([bridge().request(call), timeout]);
    if (result.status !== 200) failure(call, result);
    return result.body as T;
  } finally {
    clearTimeout(timer);
  }
}

function get<T>(path: string, params?: ApiCall['params']): Promise<T> {
  return invoke<T>({ method: 'GET', path, params });
}

async function post(path: string, body?: unknown): Promise<void> {
  await invoke({ method: 'POST', path, body });
}

/** 扫描/同步事件。主进程推过来，页面收到就重新取数。 */
export const events = {
  on(listener: (event: PushEvent) => void): () => void {
    return bridge().onEvent(listener);
  }
};

/** 打开数据目录。 */
export function openDataDir(): Promise<void> {
  return bridge().openDataDir();
}

export const api = {
  status: () => get<{ ok: boolean; build?: BuildInfo; total: TotalPayload }>('/api/status'),
  total: (device?: string | null) => get<TotalPayload>('/api/total', { device }),
  calendar: (month: string, device?: string | null) => get<CalendarPayload>('/api/calendar', { month, device }),
  aggregate: (from: string, to: string, device?: string | null) =>
    get<AggregatePayload>('/api/aggregate', { from, to, device }),
  /** 全期汇总。总账页用，服务端按库里的最早/最晚一天取区间。 */
  aggregateAll: (device?: string | null) => get<AggregatePayload>('/api/aggregate', { all: 1, device }),
  matrix: (from: string, to: string, device?: string | null) =>
    get<MatrixPayload>('/api/matrix', { from, to, device }),
  matrixAll: (device?: string | null) => get<MatrixPayload>('/api/matrix', { all: 1, device }),
  day: (date: string, device?: string | null) => get<DayPayload>('/api/day', { date, device }),
  conversations: (filter: {
    dir?: string | null;
    agent?: string | null;
    model?: string | null;
    vendor?: string | null;
    q?: string | null;
  }) => get<ConversationsPayload>('/api/conversations', filter),
  conversation: (id: string, device?: string | null) =>
    get<ConversationDetail>('/api/conversation', { id, device }),
  logs: (filter: {
    batch?: number | null;
    level?: string | null;
    source?: string | null;
    q?: string | null;
  }) => get<LogsPayload>('/api/logs', filter),
  doctor: () => get<DoctorPayload>('/api/doctor'),
  devices: () => get<DevicesPayload>('/api/devices'),
  sync: () => get<SyncPayload>('/api/sync'),
  ignoreDevice: (id: string) => post('/api/sync/ignore', { id }),
  restoreDevice: (id: string) => post('/api/sync/restore', { id }),
  renameLocal: (name: string) => post('/api/device/name', { name }),
  scan: () => post('/api/scan')
};
