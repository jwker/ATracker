// 存储层。写明细、维护物化聚合、提供查询。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TZ_SQL_OFFSET } from '../../core/src/time.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 库结构版本。改过 schema.sql 里已有表的形状就往上加一位，
 * 在 Repo.migrate() 里补上对应的重建步骤。
 */
const SCHEMA_VERSION = 2;

export interface StoredEvent {
  eventId: string;
  agent: string;
  sessionId: string;
  parentSessionId: string | null;
  isChild: boolean;
  ts: number;
  localDay: string;
  localMonth: string;
  cwd: string;
  model: string;
  provider: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  thinkingLevel: string | null;
}

export interface FileCursor {
  path: string;
  source: string;
  size: number;
  mtimeMs: number;
  inode: number;
  offset: number;
  complete: number;
  lastScanAt: number;
  lastError: string | null;
}

export type LogLevel = 'ok' | 'info' | 'warn' | 'err';

export interface RepoOptions {
  /** schema.sql 的路径，默认取模块同目录。打包成单文件时可以从外部传。 */
  schemaPath?: string;
}

export class Repo {
  readonly db: DatabaseSync;
  private readonly schemaPath: string;

  constructor(path: string, opts: RepoOptions = {}) {
    this.db = new DatabaseSync(path);
    this.schemaPath = opts.schemaPath ?? join(here, 'schema.sql');
    this.migrate();
  }

  /** 建表 + 按版本补老库。只往前加，不改历史文件。 */
  private migrate(): void {
    this.db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
    const from = (this.db.prepare('PRAGMA user_version').get() as any).user_version as number;
    if (from >= SCHEMA_VERSION) return;

    // 1：模型的聚合表主键加 vendor。同名模型在不同厂商下要分开统计，旧表装不下，
    // 删了重建，聚合能从 usage_event 全量重算，不丢数据。
    if (from < 1) {
      this.db.exec('DROP TABLE IF EXISTS agg_day_model;');
      this.db.exec('DROP TABLE IF EXISTS agg_day_agent_model;');
      this.db.exec(readFileSync(this.schemaPath, 'utf8'));
      this.rebuildAggregates([]);
    }

    // 2：去掉成本。明细表删掉三个价格列，聚合表形状变过，全部重建后从明细重算。
    // token 明细一条不动，金额字段删掉就没了。
    if (from < 2) {
      for (const col of ['cost_cny', 'cost_usd', 'cost_source']) this.dropColumn('usage_event', col);
      for (const table of ['agg_day_agent', 'agg_day_dir', 'agg_day_model', 'agg_day_agent_model', 'agg_total']) {
        this.db.exec(`DROP TABLE IF EXISTS ${table};`);
      }
      this.db.exec(readFileSync(this.schemaPath, 'utf8'));
      this.rebuildAggregates([]);
    }

    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /** 删列。SQLite 没有 IF EXISTS 写法，先查列在不在（新库本来就没有这些列）。 */
  private dropColumn(table: string, column: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    if (!cols.some(c => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column};`);
  }

  close(): void {
    this.db.close();
  }

  /* ---------- 批次与日志 ---------- */

  startBatch(trigger: string, startedAt: number): number {
    const r = this.db.prepare('INSERT INTO scan_batch (started_at, trigger) VALUES (?, ?)').run(startedAt, trigger);
    return Number(r.lastInsertRowid);
  }

  finishBatch(id: number, patch: {
    finishedAt: number; filesTotal: number; filesScanned: number;
    eventsRead: number; eventsWritten: number; errors: number;
  }): void {
    this.db.prepare(
      `UPDATE scan_batch SET finished_at=?, files_total=?, files_scanned=?, events_read=?, events_written=?, errors=?
       WHERE id=?`
    ).run(patch.finishedAt, patch.filesTotal, patch.filesScanned, patch.eventsRead, patch.eventsWritten, patch.errors, id);

    // 批次表只留 30 天、最多 5000 行。日志页只用最近几十条，日详情按天聚合，
    // 更早的批次已经没人读，但每 2 秒一次的监听扫描会把它撑成几十万行。
    this.db.prepare(
      `DELETE FROM scan_batch WHERE started_at < ? OR id < (SELECT MAX(id) - 5000 FROM scan_batch)`
    ).run(Date.now() - 30 * 86400000);
  }

  log(batchId: number, at: number, level: LogLevel, source: string, message: string): void {
    this.db.prepare('INSERT INTO scan_log (batch_id, at, level, source, message) VALUES (?,?,?,?,?)')
      .run(batchId, at, level, source, message);
    // 只留最近 5000 条
    this.db.prepare(`DELETE FROM scan_log WHERE id < (SELECT MAX(id) - 5000 FROM scan_log)`).run();
  }

  recentBatches(limit: number): any[] {
    return this.db.prepare('SELECT * FROM scan_batch ORDER BY id DESC LIMIT ?').all(limit);
  }

  queryLogs(filter: { batch?: number; level?: string; source?: string; q?: string; limit?: number }): any[] {
    const where: string[] = [];
    const args: any[] = [];
    if (filter.batch != null) { where.push('batch_id = ?'); args.push(filter.batch); }
    if (filter.level && filter.level !== 'all') { where.push('level = ?'); args.push(filter.level); }
    if (filter.source && filter.source !== 'all') { where.push('source = ?'); args.push(filter.source); }
    if (filter.q) { where.push('message LIKE ?'); args.push('%' + filter.q + '%'); }
    const sql = `SELECT * FROM scan_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    args.push(filter.limit ?? 500);
    return this.db.prepare(sql).all(...args);
  }

  /* ---------- 目录配色 ---------- */

  dirColors(): Map<string, string> {
    const rows = this.db.prepare('SELECT path, color FROM dir_color').all() as any[];
    return new Map(rows.map(r => [r.path, r.color]));
  }

  setDirColors(entries: Map<string, string>): void {
    if (!entries.size) return;
    const stmt = this.db.prepare(
      'INSERT INTO dir_color (path, color, assigned_at) VALUES (?,?,?) ON CONFLICT(path) DO NOTHING'
    );
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const [path, color] of entries) stmt.run(path, color, now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /* ---------- 会话元信息 ---------- */

  upsertSessions(rows: { agent: string; sessionId: string; title: string | null; cwd: string | null; firstTs: number | null; lastTs: number | null }[]): void {
    if (!rows.length) return;
    const stmt = this.db.prepare(
      `INSERT INTO session_title (agent, session_id, title, cwd, first_ts, last_ts, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(agent, session_id) DO UPDATE SET
         title=COALESCE(excluded.title, session_title.title),
         cwd=COALESCE(excluded.cwd, session_title.cwd),
         first_ts=COALESCE(excluded.first_ts, session_title.first_ts),
         last_ts=COALESCE(excluded.last_ts, session_title.last_ts),
         updated_at=excluded.updated_at`
    );
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        stmt.run(r.agent, r.sessionId, r.title, r.cwd, r.firstTs, r.lastTs, now);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  sessionTitles(): Map<string, { title: string | null; cwd: string | null }> {
    const rows = this.db.prepare('SELECT agent, session_id, title, cwd FROM session_title').all() as any[];
    return new Map(rows.map(r => [`${r.agent}:${r.session_id}`, { title: r.title, cwd: r.cwd }]));
  }

  /* ---------- 文件游标 ---------- */

  getCursor(path: string): FileCursor | undefined {
    const r = this.db.prepare('SELECT * FROM file_cursor WHERE path = ?').get(path) as any;
    if (!r) return undefined;
    return {
      path: r.path,
      source: r.source,
      size: r.size,
      mtimeMs: r.mtime_ms,
      inode: r.inode,
      offset: r.offset,
      complete: r.complete,
      lastScanAt: r.last_scan_at,
      lastError: r.last_error ?? null
    };
  }

  setCursor(c: Omit<FileCursor, 'lastError'> & { lastError?: string | null }): void {
    this.db.prepare(
      `INSERT INTO file_cursor (path, source, size, mtime_ms, inode, offset, complete, last_scan_at, last_error)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET
         source=excluded.source, size=excluded.size, mtime_ms=excluded.mtime_ms, inode=excluded.inode,
         offset=excluded.offset, complete=excluded.complete, last_scan_at=excluded.last_scan_at,
         last_error=excluded.last_error`
    ).run(c.path, c.source, c.size, c.mtimeMs, c.inode, c.offset, c.complete, c.lastScanAt, c.lastError ?? null);
  }

  /* ---------- 明细写入 ---------- */

  upsertEvents(events: StoredEvent[]): number {
    const stmt = this.db.prepare(
      `INSERT INTO usage_event
        (event_id, agent, session_id, parent_session_id, is_child, ts, local_day, local_month, cwd, model, provider,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
         thinking_level)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(event_id) DO UPDATE SET
         session_id=excluded.session_id, parent_session_id=excluded.parent_session_id, is_child=excluded.is_child,
         ts=excluded.ts, local_day=excluded.local_day, local_month=excluded.local_month, cwd=excluded.cwd,
         model=excluded.model, provider=excluded.provider,
         input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
         cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens,
         reasoning_tokens=excluded.reasoning_tokens`
    );
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const e of events) {
        stmt.run(
          e.eventId, e.agent, e.sessionId, e.parentSessionId, e.isChild ? 1 : 0, e.ts, e.localDay, e.localMonth,
          e.cwd, e.model, e.provider,
          e.input, e.output, e.cacheRead, e.cacheWrite, e.reasoning, e.thinkingLevel
        );
        n++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return n;
  }

  /* ---------- 聚合 ---------- */

  /** 重算指定日期的聚合表。空数组表示全部。 */
  rebuildAggregates(days: string[]): void {
    const scope = days.length ? days : this.db.prepare('SELECT DISTINCT local_day d FROM usage_event').all().map((r: any) => r.d);
    const COLS = 'input, output, cache_read, cache_write, reasoning, tokens';
    const AGG = `SUM(input_tokens) AS input, SUM(output_tokens) AS output,
                 SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write,
                 SUM(reasoning_tokens) AS reasoning,
                 SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens`;
    this.db.exec('BEGIN');
    try {
      for (const day of scope) {
        this.db.prepare('DELETE FROM agg_day_agent WHERE day = ?').run(day);
        this.db.prepare('DELETE FROM agg_day_dir WHERE day = ?').run(day);
        this.db.prepare('DELETE FROM agg_day_model WHERE day = ?').run(day);
        this.db.prepare('DELETE FROM agg_day_agent_model WHERE day = ?').run(day);

        this.db.prepare(
          `INSERT INTO agg_day_agent (day, agent, ${COLS}) SELECT local_day AS day, agent, ${AGG} FROM usage_event WHERE local_day = ? GROUP BY day, agent`
        ).run(day);

        this.db.prepare(
          `INSERT INTO agg_day_dir (day, dir, ${COLS}) SELECT local_day AS day, cwd, ${AGG} FROM usage_event WHERE local_day = ? GROUP BY day, cwd`
        ).run(day);

        this.db.prepare(
          `INSERT INTO agg_day_model (day, model, vendor, ${COLS}) SELECT local_day AS day, model, COALESCE(provider, '') AS vendor, ${AGG} FROM usage_event WHERE local_day = ? GROUP BY day, model, vendor`
        ).run(day);

        this.db.prepare(
          `INSERT INTO agg_day_agent_model (day, agent, model, vendor, ${COLS}) SELECT local_day AS day, agent, model, COALESCE(provider, '') AS vendor, ${AGG} FROM usage_event WHERE local_day = ? GROUP BY day, agent, model, vendor`
        ).run(day);
      }
      this.refreshTotal();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 重算累计。聚合表很小，直接全量重算比增量更不容易出错。 */
  refreshTotal(): void {
    const t = this.db.prepare(
      `SELECT COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output,
              COALESCE(SUM(cache_read),0) cache_read, COALESCE(SUM(cache_write),0) cache_write,
              COALESCE(SUM(tokens),0) tokens
       FROM agg_day_agent`
    ).get() as any;

    const reasoning = this.db.prepare('SELECT COALESCE(SUM(reasoning_tokens),0) r FROM usage_event').get() as any;

    this.db.prepare(
      `INSERT INTO agg_total (id, input, output, cache_read, cache_write, reasoning, tokens, updated_at)
       VALUES (1, ?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         input=excluded.input, output=excluded.output, cache_read=excluded.cache_read,
         cache_write=excluded.cache_write, reasoning=excluded.reasoning, tokens=excluded.tokens,
         updated_at=excluded.updated_at`
    ).run(
      t.input, t.output, t.cache_read, t.cache_write, reasoning.r,
      t.tokens, Date.now()
    );
  }

  total(): any {
    return this.db.prepare('SELECT * FROM agg_total WHERE id = 1').get() ?? null;
  }

  /** 某个月每天的用量和按目录的拆分。 */
  calendar(month: string): { days: any[]; legend: any[] } {
    const days = this.db.prepare(
      `SELECT day, SUM(tokens) tokens
       FROM agg_day_agent WHERE day LIKE ? GROUP BY day ORDER BY day`
    ).all(month + '%') as any[];

    const dirs = this.db.prepare(
      `SELECT dir, SUM(tokens) tokens FROM agg_day_dir WHERE day LIKE ? GROUP BY dir ORDER BY tokens DESC`
    ).all(month + '%') as any[];

    const byDayDir = this.db.prepare(
      `SELECT day, dir, tokens FROM agg_day_dir WHERE day LIKE ?`
    ).all(month + '%') as any[];

    const map = new Map<string, Map<string, number>>();
    for (const r of byDayDir) {
      if (!map.has(r.day)) map.set(r.day, new Map());
      map.get(r.day)!.set(r.dir, r.tokens);
    }
    for (const d of days) d.byDir = Object.fromEntries(map.get(d.day) ?? new Map());
    return { days, legend: dirs };
  }

  /** 区间内的来源 × 模型交叉表。 */
  matrix(from: string, to: string): any {
    const rows = this.db.prepare(
      `SELECT agent, model, vendor, SUM(tokens) tokens
       FROM agg_day_agent_model WHERE day >= ? AND day <= ?
       GROUP BY agent, model, vendor`
    ).all(from, to) as any[];
    return { cells: rows };
  }

  /** 区间内的按模型和按目录汇总。模型带厂商，同名不同厂商分成两行。 */
  breakdown(from: string, to: string): { byModel: any[]; byDir: any[]; totals: any } {
    const byModel = this.db.prepare(
      `SELECT model, vendor, SUM(tokens) tokens,
              SUM(input) input, SUM(output) output, SUM(cache_read) cache_read, SUM(cache_write) cache_write
       FROM agg_day_model WHERE day >= ? AND day <= ? GROUP BY model, vendor ORDER BY tokens DESC`
    ).all(from, to);
    const byDir = this.db.prepare(
      `SELECT dir, SUM(tokens) tokens,
              SUM(input) input, SUM(output) output, SUM(cache_read) cache_read, SUM(cache_write) cache_write
       FROM agg_day_dir WHERE day >= ? AND day <= ? GROUP BY dir ORDER BY tokens DESC`
    ).all(from, to);
    const totals = this.db.prepare(
      `SELECT COALESCE(SUM(tokens),0) tokens,
              COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output,
              COALESCE(SUM(cache_read),0) cache_read, COALESCE(SUM(cache_write),0) cache_write,
              COUNT(*) days
       FROM agg_day_agent WHERE day >= ? AND day <= ?`
    ).get(from, to) as any;
    return { byModel, byDir, totals };
  }

  /** 区间内的按来源汇总。 */
  byAgent(from: string, to: string): any[] {
    return this.db.prepare(
      `SELECT agent, SUM(tokens) tokens
       FROM agg_day_agent WHERE day >= ? AND day <= ? GROUP BY agent ORDER BY tokens DESC`
    ).all(from, to);
  }

  /** 会话列表。 */
  conversations(filter: { dir?: string; agent?: string; model?: string; vendor?: string; q?: string; limit?: number }): any[] {
    const where: string[] = [];
    const args: any[] = [];
    if (filter.dir) { where.push('cwd = ?'); args.push(filter.dir); }
    if (filter.agent) { where.push('agent = ?'); args.push(filter.agent); }
    if (filter.model) { where.push('model = ?'); args.push(filter.model); }
    if (filter.vendor) { where.push('provider = ?'); args.push(filter.vendor); }
    if (filter.q) { where.push('(session_id LIKE ? OR cwd LIKE ?)'); args.push('%' + filter.q + '%', '%' + filter.q + '%'); }
    const sql = `SELECT agent, session_id, cwd, model, provider, COUNT(*) events,
                        SUM(input_tokens) input, SUM(output_tokens) output,
                        SUM(cache_read_tokens) cache_read, SUM(cache_write_tokens) cache_write,
                        MIN(ts) first_ts, MAX(ts) last_ts
                 FROM usage_event ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 GROUP BY agent, session_id ORDER BY last_ts DESC LIMIT ?`;
    args.push(filter.limit ?? 200);
    return this.db.prepare(sql).all(...args);
  }

  /** 单个会话的逐条明细。limit 给 0 表示不限。 */
  sessionEvents(sessionId: string, limit = 0): { events: any[]; total: number } {
    const total = (this.db.prepare(
      'SELECT COUNT(*) n FROM usage_event WHERE session_id = ?'
    ).get(sessionId) as any).n;
    const sql = `SELECT * FROM usage_event WHERE session_id = ? ORDER BY ts DESC` +
      (limit > 0 ? ' LIMIT ?' : '');
    const rows = (limit > 0
      ? this.db.prepare(sql).all(sessionId, limit)
      : this.db.prepare(sql).all(sessionId)) as any[];
    return { events: rows.reverse(), total };
  }

  /* ---------- 单日查询。当日详情页用 ---------- */

  /**
   * 某一天的总量和四个桶。cutoff 给了就只算到该时刻为止，
   * 用来和前一天同一时刻做同口径比较。
   */
  dayTotals(day: string, cutoff?: number): any {
    const rows = this.db.prepare(
      `SELECT COUNT(*) events,
              COALESCE(SUM(input_tokens),0) input,
              COALESCE(SUM(output_tokens),0) output,
              COALESCE(SUM(cache_read_tokens),0) cache_read,
              COALESCE(SUM(cache_write_tokens),0) cache_write,
              COALESCE(SUM(reasoning_tokens),0) reasoning,
              COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens),0) tokens
       FROM usage_event WHERE local_day = ?${cutoff === undefined ? '' : ' AND ts <= ?'}`
    ).get(...(cutoff === undefined ? [day] : [day, cutoff])) as any;
    return {
      events: rows.events ?? 0,
      input: rows.input,
      output: rows.output,
      cacheRead: rows.cache_read,
      cacheWrite: rows.cache_write,
      reasoning: rows.reasoning,
      tokens: rows.tokens
    };
  }

  /** 某一天按小时的用量。小时按本机时区折算。 */
  hourly(day: string): any[] {
    return this.db.prepare(
      `SELECT CAST(strftime('%H', ts / 1000, 'unixepoch', ${TZ_SQL_OFFSET}) AS INTEGER) hour,
              COUNT(*) events,
              COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens),0) tokens
       FROM usage_event WHERE local_day = ?
       GROUP BY hour ORDER BY hour`
    ).all(day);
  }

  /** 某一天的来源 × 模型交叉表。 */
  dayMatrix(day: string): any[] {
    return this.db.prepare(
      `SELECT agent, model, vendor, SUM(tokens) tokens
       FROM agg_day_agent_model WHERE day = ?
       GROUP BY agent, model, vendor`
    ).all(day);
  }

  /** 某一天的会话列表，按 token 降序。 */
  daySessions(day: string): any[] {
    return this.db.prepare(
      `SELECT agent, session_id, MIN(cwd) cwd, COUNT(*) events,
              SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) tokens,
              MIN(ts) first_ts, MAX(ts) last_ts
       FROM usage_event WHERE local_day = ?
       GROUP BY agent, session_id ORDER BY tokens DESC`
    ).all(day);
  }

  /** 某一天最大的几次调用，按 token 降序。 */
  dayTopCalls(day: string, limit = 8): any[] {
    return this.db.prepare(
      `SELECT ts, agent, model, provider, cwd,
              input_tokens + output_tokens + cache_read_tokens + cache_write_tokens tokens
       FROM usage_event WHERE local_day = ?
       ORDER BY tokens DESC LIMIT ?`
    ).all(day, limit);
  }

  /** 某一天的扫描批次统计。 */
  dayBatches(day: string): any {
    return this.db.prepare(
      `SELECT COUNT(*) count, COALESCE(SUM(errors),0) errors,
              COALESCE(SUM(events_written),0) events_written
       FROM scan_batch WHERE date(started_at / 1000, 'unixepoch', ${TZ_SQL_OFFSET}) = ?`
    ).get(day) as any;
  }
}
