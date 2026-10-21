// 取数层。所有请求都走相对路径，服务端和 Vite 代理都会转发。

import type {
  AggregatePayload,
  CalendarPayload,
  ConversationDetail,
  ConversationsPayload,
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
  matrix: (from: string, to: string) => request<MatrixPayload>('/api/matrix', { from, to }),
  conversations: (filter: {
    dir?: string | null;
    agent?: string | null;
    model?: string | null;
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
  scan: async (): Promise<void> => {
    const res = await fetch('/api/scan', { method: 'POST' });
    if (!res.ok) throw new Error(`/api/scan ${res.status}`);
  }
};
