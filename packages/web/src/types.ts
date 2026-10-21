// 接口载荷类型。字段形状对齐 packages/server/src/queries.ts。
// 前端只读接口，不自己算成本，金额口径以接口为准。

export interface TokenBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface TotalPayload {
  total: number;
  buckets: TokenBuckets;
  costCny: number;
  costUsd: number;
  unpricedTokens: number;
  days: number;
  updatedAt: number;
}

export interface CalendarDay {
  day: string;
  total: number;
  costCny: number;
  byDir: Record<string, number>;
}

export interface CalendarDir {
  path: string;
  name: string;
  tokens: number;
  color: string;
}

export interface CalendarPayload {
  month: string;
  days: CalendarDay[];
  dirs: CalendarDir[];
}

export interface DirAggregate {
  path: string;
  name: string;
  tokens: number;
  costCny: number;
  color: string;
}

export interface ModelAggregate {
  model: string;
  vendor: string | null;
  tokens: number;
  costCny: number;
}

export interface AgentAggregate {
  agent: string;
  tokens: number;
  costCny: number;
}

export interface AggregatePayload {
  from: string;
  to: string;
  days: number;
  total: number;
  buckets: Omit<TokenBuckets, 'reasoning'>;
  byDir: DirAggregate[];
  byModel: ModelAggregate[];
  byAgent: AgentAggregate[];
  byAgentModel: Record<string, Record<string, number>>;
  costCny: number;
  costUsd: number;
}

export interface MatrixAgent {
  id: string;
  label: string;
  color: string;
}

export interface MatrixModel {
  id: string;
  tokens: number;
}

export interface MatrixPayload {
  from: string;
  to: string;
  agents: MatrixAgent[];
  models: MatrixModel[];
  cells: Record<string, Record<string, number>>;
  colTotal: Record<string, number>;
  rowTotal: Record<string, number>;
  maxCell: number;
}

export interface ConversationSummary {
  id: string;
  agent: string;
  sessionId: string;
  dir: string;
  dirName: string;
  color: string;
  model: string;
  vendor: string | null;
  title: string | null;
  events: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costCny: number;
  firstTs: number;
  lastTs: number;
}

export interface ConversationGroup {
  dir: { path: string; name: string; color: string };
  total: number;
  list: ConversationSummary[];
}

export interface ConversationsPayload {
  groups: ConversationGroup[];
  total: number;
}

export interface ConversationEvent {
  ts: number;
  localDay: string;
  model: string;
  vendor: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  costCny: number | null;
  costUsd: number | null;
  costSource: string;
  isChild: boolean;
}

export interface ConversationStats {
  buckets: TokenBuckets;
  total: number;
  costCny: number;
  costUsd: number;
  unpriced: number;
  byDay: Record<string, number>;
  dayRows: string[];
}

export interface ConversationDetail {
  id: string;
  agent: string;
  sessionId: string;
  title: string | null;
  dir: string | null;
  eventTotal: number;
  truncated: boolean;
  events: ConversationEvent[];
  stats: ConversationStats;
}

export interface ScanBatch {
  id: number;
  started_at: number;
  finished_at: number | null;
  files_total: number;
  files_scanned: number;
  events_read: number;
  events_written: number;
  errors: number;
  trigger: string;
}

export interface ScanLog {
  id: number;
  batch_id: number;
  at: number;
  level: 'ok' | 'info' | 'warn' | 'err';
  source: string;
  message: string;
}

export interface LogsPayload {
  batches: ScanBatch[];
  logs: ScanLog[];
}

export interface DoctorSource {
  id: string;
  label: string;
  roots: string[];
  ok: boolean;
}

export interface DoctorPayload {
  sources: DoctorSource[];
}
