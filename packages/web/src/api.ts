// 取数层。所有请求都走相对路径，服务端和 Vite 代理都会转发。

import type {
  AggregatePayload,
  CalendarPayload,
  ConversationDetail,
  ConversationsPayload,
  DayPayload,
  DevicesPayload,
  DoctorPayload,
  LogsPayload,
  MatrixPayload,
  TotalPayload
} from './types.ts';

async function request<T>(
  path: string,
  params?: Record<string, string | number | null | undefined>
): Promise<T> {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  total: () => request<TotalPayload>('/api/total'),
  calendar: (month: string) => request<CalendarPayload>('/api/calendar', { month }),
  aggregate: (from: string, to: string) => request<AggregatePayload>('/api/aggregate', { from, to }),
  /** 全期汇总。总账页用，服务端按库里的最早/最晚一天取区间。 */
  aggregateAll: () => request<AggregatePayload>('/api/aggregate', { all: 1 }),
  matrix: (from: string, to: string) => request<MatrixPayload>('/api/matrix', { from, to }),
  matrixAll: () => request<MatrixPayload>('/api/matrix', { all: 1 }),
  day: (date: string) => request<DayPayload>('/api/day', { date }),
  conversations: (filter: {
    dir?: string | null;
    agent?: string | null;
    model?: string | null;
    vendor?: string | null;
    q?: string | null;
  }) => request<ConversationsPayload>('/api/conversations', filter),
  conversation: (id: string) => request<ConversationDetail>('/api/conversation', { id }),
  logs: (filter: {
    batch?: number | null;
    level?: string | null;
    source?: string | null;
    q?: string | null;
  }) => request<LogsPayload>('/api/logs', filter),
  doctor: () => request<DoctorPayload>('/api/doctor'),
  devices: () => request<DevicesPayload>('/api/devices'),
  scan: async (): Promise<void> => {
    const res = await fetch('/api/scan', { method: 'POST' });
    if (!res.ok) throw new Error(`/api/scan ${res.status}`);
  }
};
