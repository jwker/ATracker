// 取数层。所有请求都走相对路径，服务端和 Vite 代理都会转发。

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

/** 请求超时。服务端卡住时页面不能一直转圈。 */
const TIMEOUT_MS = 15_000;

async function request<T>(
  path: string,
  params?: Record<string, string | number | null | undefined>
): Promise<T> {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error(`${path} 请求超时`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // 服务端有时会用 200 返回 { error }，那种要单独挑出来。
    let msg = `${path} ${res.status}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') msg = body.error;
    } catch {
      // 响应不是 JSON，用状态码
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  status: () => request<{ ok: boolean; build?: BuildInfo; total: TotalPayload }>('/api/status'),
  total: (device?: string | null) => request<TotalPayload>('/api/total', { device }),
  calendar: (month: string, device?: string | null) => request<CalendarPayload>('/api/calendar', { month, device }),
  aggregate: (from: string, to: string, device?: string | null) =>
    request<AggregatePayload>('/api/aggregate', { from, to, device }),
  /** 全期汇总。总账页用，服务端按库里的最早/最晚一天取区间。 */
  aggregateAll: (device?: string | null) => request<AggregatePayload>('/api/aggregate', { all: 1, device }),
  matrix: (from: string, to: string, device?: string | null) =>
    request<MatrixPayload>('/api/matrix', { from, to, device }),
  matrixAll: (device?: string | null) => request<MatrixPayload>('/api/matrix', { all: 1, device }),
  day: (date: string, device?: string | null) => request<DayPayload>('/api/day', { date, device }),
  conversations: (filter: {
    dir?: string | null;
    agent?: string | null;
    model?: string | null;
    vendor?: string | null;
    q?: string | null;
  }) => request<ConversationsPayload>('/api/conversations', filter),
  conversation: (id: string, device?: string | null) =>
    request<ConversationDetail>('/api/conversation', { id, device }),
  logs: (filter: {
    batch?: number | null;
    level?: string | null;
    source?: string | null;
    q?: string | null;
  }) => request<LogsPayload>('/api/logs', filter),
  doctor: () => request<DoctorPayload>('/api/doctor'),
  devices: () => request<DevicesPayload>('/api/devices'),
  sync: () => request<SyncPayload>('/api/sync'),
  ignoreDevice: async (id: string): Promise<void> => {
    const res = await fetch('/api/sync/ignore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (!res.ok) throw new Error(`/api/sync/ignore ${res.status}`);
  },
  restoreDevice: async (id: string): Promise<void> => {
    const res = await fetch('/api/sync/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (!res.ok) throw new Error(`/api/sync/restore ${res.status}`);
  },
  renameLocal: async (name: string): Promise<void> => {
    const res = await fetch('/api/device/name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!res.ok) throw new Error(`/api/device/name ${res.status}`);
  },
  scan: async (): Promise<void> => {
    const res = await fetch('/api/scan', { method: 'POST' });
    if (!res.ok) throw new Error(`/api/scan ${res.status}`);
  }
};
