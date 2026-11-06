// 接口载荷类型。字段形状对齐 packages/service/src/queries.ts。
// 只包含 token 与归属信息，不含金额。

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
  /**
   * 覆盖天数。库里还没有 agg_total 行时这几个字段整个缺失（undefined），
   * 消费方要用 `!= null` 判断，不能用 `!== null`。
   */
  days?: number;
  /** 库里最早的一天，总账页的「覆盖 N 天」用它 */
  firstDay?: string | null;
  lastDay?: string | null;
  updatedAt: number;
}

export interface CalendarDay {
  day: string;
  total: number;
  /**
   * 目录 → 当天用量。键是目录的绝对路径。
   *
   * 取值要用 Object.hasOwn：键要是恰好等于 constructor / toString 这类
   * 原型属性名，直接下标会取到继承来的函数。
   */
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
  color: string;
}

export interface ModelAggregate {
  model: string;
  vendor: string | null;
  tokens: number;
}

export interface AgentAggregate {
  agent: string;
  tokens: number;
}

export interface AggregatePayload {
  from: string;
  to: string;
  days: number;
  total: number;
  buckets: TokenBuckets;
  byDir: DirAggregate[];
  byModel: ModelAggregate[];
  byAgent: AgentAggregate[];
  /**
   * 聚合键：厂商/模型。cells 里也用它做键。
   *
   * 复合键的格式是「厂商/模型」，厂商名或模型名自己带 / 时会拼出同一个键
   * 互相覆盖（vendor=a + model=b/c 和 vendor=a/b + model=c 都得到 a/b/c）。
   * 服务端另外返回了原始的 vendor / model 字段可以校验。
   */
  byAgentModel: Record<string, Record<string, number>>;
  /** 调用次数；远端设备没有明细，为 null */
  events: number | null;
}

export interface MatrixAgent {
  id: string;
  label: string;
  color: string;
}

export interface MatrixModel {
  /** 聚合键：厂商/模型。cells 里也用它做键。 */
  id: string;
  model: string;
  vendor: string | null;
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
  /** 哪台设备产生的会话 */
  device: string;
  deviceName: string;
  /** 本机有逐轮明细 */
  detail: boolean;
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
  isChild: boolean;
}

export interface ConversationStats {
  /**
   * 四个桶 + 推理。
   *
   * 远端会话（detail=false）的 reasoning 没有来源：session_usage 表里
   * 没有这一列，服务端补 0。读的时候按 0 处理。
   */
  buckets: TokenBuckets;
  total: number;
  byDay: Record<string, number>;
  dayRows: string[];
}

export interface ConversationDetail {
  id: string;
  agent: string;
  /** 本机有没有这个会话的逐轮明细 */
  detail: boolean;
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
  /** 这批里 warn / err 级别的日志条数（接口按 scan_log 聚合） */
  warn?: number;
  err?: number;
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

/* ---------- 设备 ---------- */

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
}

export interface DeviceRow extends DeviceInfo {
  created_at: number;
  last_seen: number | null;
  ignored: number;
  /** 是否本机（/api/sync 会填） */
  local?: boolean;
  /** 这台设备在本机库里占用的 token（/api/sync 会填） */
  tokens?: number;
}

export interface SyncPayload {
  dir: string | null;
  enabled: boolean;
  pollMs: number;
  lastExportAt: number | null;
  lastExportFiles: string[];
  lastImportAt: number | null;
  lastImport: {
    files: number;
    skippedOwn: number;
    skippedIgnored: number;
    aggRows: number;
    sessionRows: number;
    errors: string[];
    devices: { id: string; name: string; months: string[] }[];
  } | null;
  devices: DeviceRow[];
}

/**
 * 和 packages/core/src/api.ts 里的 BuildInfo 一一对应。
 *
 * 直接复用 core 的类型：web 包为浏览器构建不引 core 的运行时，
 * 但类型是编译期的东西，import type 不会打进产物。
 * 手抄一份的话 core 那边加字段这边不会有任何编译错误，两边会悄悄漂移。
 */
export type { BuildInfo } from '../../core/src/api.ts';

export interface DevicesPayload {
  /** 本机身份 */
  local: DeviceInfo;
  /** 身份文件位置，界面上提示用 */
  file: string;
  /** 库里出现过的设备，含本机和同步进来的远端设备 */
  devices: DeviceRow[];
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

/* ---------- 单日详情 ---------- */

export interface DayTotals {
  /** 调用次数。远端设备只有聚合，没有次数，这里是 null */
  events: number | null;
  tokens: number;
  buckets: TokenBuckets;
}

export interface DayHour {
  hour: number;
  events: number;
  tokens: number;
}

export interface DaySession {
  id: string;
  agent: string;
  sessionId: string;
  title: string | null;
  dir: string;
  dirName: string;
  color: string;
  events: number;
  tokens: number;
  firstTs: number;
  lastTs: number;
}

export interface DayTopCall {
  ts: number;
  time: string;
  agent: string;
  model: string;
  vendor: string | null;
  dir: string;
  dirName: string;
  tokens: number;
}

export interface DayPayload {
  date: string;
  weekday: string;
  isToday: boolean;
  /** local=本机，remote=别的设备，all=全部设备 */
  scope: 'local' | 'remote' | 'all';
  /**
   * 能不能给出小时图和逐轮明细。
   *
   * 意思是「本机有明细可展示」，不代表明细覆盖了范围里的所有设备。
   * scope='all' 时 canDetail 为 true，但 hourly / topCalls 只来自本机，
   * 而 today / prev 汇总的是全部设备。
   */
  canDetail: boolean;
  cutoff: string;
  today: DayTotals;
  prev: DayTotals;
  prevFull: DayTotals;
  hourly: DayHour[];
  byAgent: AgentAggregate[];
  byModel: ModelAggregate[];
  byDir: (DirAggregate & { sessions: number })[];
  matrix: MatrixPayload;
  sessions: DaySession[];
  topCalls: DayTopCall[];
  batches: { count: number; errors: number; events_written: number };
}
