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
const SCHEMA_VERSION = 7;

export interface StoredEvent {
  eventId: string;
  device: string;
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

    // 3：加设备维度。明细表补 device 列，聚合表主键带上 device 后重建，
    // 历史行统一归到本机（本机 id 在 open 之后由服务器/CLI 调 markLocalDevice 写入）。
    //
    // 会话汇总的 model / vendor 两列要先补上：下面这次重建聚合会调
    // rebuildSessionUsage，它的 INSERT 无条件写这两列。列还不存在的话
    // 老库（停在 v2）直接起不来。
    if (from < 3) {
      const cols = (this.db.prepare('PRAGMA table_info(session_usage)').all() as any[]).map(c => c.name);
      if (!cols.includes('model')) this.db.exec('ALTER TABLE session_usage ADD COLUMN model TEXT;');
      if (!cols.includes('vendor')) this.db.exec('ALTER TABLE session_usage ADD COLUMN vendor TEXT;');
    }

    if (from < 3) {
      this.ensureDeviceColumn('usage_event');
      this.ensureDeviceColumn('session_title');
      // 会话汇总也要补 device 列：下面重建聚合会调 rebuildSessionUsage，
      // 它的 INSERT 和 DELETE 都按 device 走。
      this.ensureDeviceColumn('session_usage');
      for (const table of ['agg_day_agent', 'agg_day_dir', 'agg_day_model', 'agg_day_agent_model']) {
        this.db.exec(`DROP TABLE IF EXISTS ${table};`);
      }
      this.db.exec(readFileSync(this.schemaPath, 'utf8'));
      this.rebuildAggregates([]);
    }

    // 4：设备加 ignored 标记（忽略某台设备后不再导入、不在设备条里出现）
    if (from < 4) {
      const cols = (this.db.prepare('PRAGMA table_info(device)').all() as any[]).map(c => c.name);
      if (!cols.includes('ignored')) {
        this.db.exec('ALTER TABLE device ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0;');
      }
    }

    // 6：清掉 device 为空串的聚合行。加设备维度那次迁移里，重建聚合发生在
    // 「认领本机」之前，会先按空 device 写一份；认领之后按设备重算只删本机那份，
    // 空 device 的行就留在库里，导致总量翻倍。
    if (from < 6) {
      for (const table of ['agg_day_agent', 'agg_day_dir', 'agg_day_model', 'agg_day_agent_model']) {
        this.db.prepare(`DELETE FROM ${table} WHERE device = ''`).run();
      }
      this.db.prepare("DELETE FROM session_usage WHERE device = ''").run();
      this.refreshTotal();
    }

    // 5：会话汇总补 model / vendor，跨设备会话列表要按模型筛
    if (from < 5) {
      const cols = (this.db.prepare('PRAGMA table_info(session_usage)').all() as any[]).map(c => c.name);
      if (!cols.includes('model')) this.db.exec('ALTER TABLE session_usage ADD COLUMN model TEXT;');
      if (!cols.includes('vendor')) this.db.exec('ALTER TABLE session_usage ADD COLUMN vendor TEXT;');
      this.rebuildAggregates([]);
    }

    // 7：会话的主键补上 device。原来是 (agent, session_id)，两台设备上出现
    // 同一个 session_id 时标题会互相覆盖、会话汇总会串台。重建这两张表，
    // 内容本身不丢。
    if (from < 7) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session_title_new (
          device     TEXT NOT NULL DEFAULT '',
          agent      TEXT NOT NULL,
          session_id TEXT NOT NULL,
          title      TEXT,
          cwd        TEXT,
          first_ts   INTEGER,
          last_ts    INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (device, agent, session_id)
        );
        INSERT OR REPLACE INTO session_title_new
          (device, agent, session_id, title, cwd, first_ts, last_ts, updated_at)
        SELECT device, agent, session_id, title, cwd, first_ts, last_ts, updated_at FROM session_title;
        DROP TABLE session_title;
        ALTER TABLE session_title_new RENAME TO session_title;
      `);

      // 会话汇总：老库还没有 device 列的话先补上，再按新主键重建
      this.ensureDeviceColumn('session_usage');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session_usage_new (
          device      TEXT NOT NULL DEFAULT '',
          agent       TEXT NOT NULL,
          session_id  TEXT NOT NULL,
          month       TEXT NOT NULL,
          title       TEXT,
          dir         TEXT,
          model       TEXT,
          vendor      TEXT,
          events      INTEGER NOT NULL DEFAULT 0,
          tokens      INTEGER NOT NULL DEFAULT 0,
          input       INTEGER NOT NULL DEFAULT 0,
          output      INTEGER NOT NULL DEFAULT 0,
          cache_read  INTEGER NOT NULL DEFAULT 0,
          cache_write INTEGER NOT NULL DEFAULT 0,
          first_ts    INTEGER,
          last_ts     INTEGER,
          PRIMARY KEY (device, agent, session_id)
        );
        INSERT OR REPLACE INTO session_usage_new
          (device, agent, session_id, month, title, dir, model, vendor,
           events, tokens, input, output, cache_read, cache_write, first_ts, last_ts)
        SELECT device, agent, session_id, month, title, dir, model, vendor,
               events, tokens, input, output, cache_read, cache_write, first_ts, last_ts
        FROM session_usage;
        DROP TABLE session_usage;
        ALTER TABLE session_usage_new RENAME TO session_usage;
      `);
    }

    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /** 给老表补 device 列。SQLite 没有 ADD COLUMN IF NOT EXISTS，先查一下。 */
  private ensureDeviceColumn(table: string): void {
    const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => c.name);
    if (cols.includes('device')) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN device TEXT NOT NULL DEFAULT '';`);
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

  /* ---------- 设备 ---------- */

  /** 记录/更新一台设备。本机每次启动、每次扫描都会调一次，用来刷新 last_seen。 */
  touchDevice(d: { id: string; name: string; platform: string }, seenAt = Date.now()): void {
    this.db.prepare(
      `INSERT INTO device (id, name, platform, created_at, last_seen)
       VALUES (?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, platform=excluded.platform, last_seen=excluded.last_seen`
    ).run(d.id, d.name, d.platform, seenAt, seenAt);
  }

  devices(): any[] {
    return this.db.prepare('SELECT * FROM device ORDER BY last_seen DESC').all() as any[];
  }

  device(id: string): any {
    return this.db.prepare('SELECT * FROM device WHERE id = ?').get(id) ?? null;
  }

  /**
   * 忽略一台设备：删掉它在本机库里的所有行（聚合、会话），并打标记，
   * 之后同步导入会跳过它。只动本机库，不碰同步目录里对方写的文件。
   */
  ignoreDevice(deviceId: string): void {
    this.db.exec('BEGIN');
    try {
      for (const table of ['agg_day_agent', 'agg_day_dir', 'agg_day_model', 'agg_day_agent_model']) {
        this.db.prepare(`DELETE FROM ${table} WHERE device = ?`).run(deviceId);
      }
      this.db.prepare('DELETE FROM session_usage WHERE device = ?').run(deviceId);
      this.db.prepare('UPDATE device SET ignored = 1 WHERE id = ?').run(deviceId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.refreshTotal();
  }

  /** 取消忽略。数据行不补，等下一次同步导入。 */
  restoreDevice(deviceId: string): void {
    this.db.prepare('UPDATE device SET ignored = 0 WHERE id = ?').run(deviceId);
  }

  /** 被忽略的设备 id 集合，导入时跳过。 */
  ignoredDevices(): Set<string> {
    const rows = this.db.prepare('SELECT id FROM device WHERE ignored = 1').all() as any[];
    return new Set(rows.map(r => r.id as string));
  }

  /**
   * 把还没有归属的历史行认领给本机：升级前写进去的行 device 是空串。
   * 只在本机第一次运行时有效，重复调用是幂等的。
   */
  claimUnassigned(deviceId: string): number {
    const events = this.db.prepare("UPDATE usage_event SET device = ? WHERE device = ''").run(deviceId);
    const sessions = this.db.prepare("UPDATE session_title SET device = ? WHERE device = ''").run(deviceId);
    const count = Number(events.changes ?? 0) + Number(sessions.changes ?? 0);

    // 认领之前可能已经按空 device 算过一次聚合。重建只删「明细里出现的设备」，
    // 空 device 不在其中，会一直留着把总量算重。这里直接清掉。
    let stale = 0;
    for (const table of ['agg_day_agent', 'agg_day_dir', 'agg_day_model', 'agg_day_agent_model']) {
      stale += Number(this.db.prepare(`DELETE FROM ${table} WHERE device = ''`).run().changes ?? 0);
    }
    stale += Number(this.db.prepare("DELETE FROM session_usage WHERE device = ''").run().changes ?? 0);

    if (events.changes || stale) this.rebuildAggregates([]);
    if (stale) this.refreshTotal();
    return count;
  }

  /* ---------- 目录配色 ---------- */

  /**
   * 用量出现过的目录。给了天数就只取那几天的，不给就取全部。
   *
   * 扫描每轮都会调这个函数，全表 SELECT DISTINCT 在事件表涨到几十万行之后
   * 就是主要的开销，而大多数轮次其实只涉及一两天。
   */
  dirsOf(days?: string[]): string[] {
    if (days?.length) {
      const ph = days.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT DISTINCT cwd FROM usage_event WHERE local_day IN (${ph})`
      ).all(...days) as any[];
      return rows.map(r => r.cwd as string);
    }
    const rows = this.db.prepare('SELECT DISTINCT cwd FROM usage_event').all() as any[];
    return rows.map(r => r.cwd as string);
  }

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

  upsertSessions(rows: { device: string; agent: string; sessionId: string; title: string | null; cwd: string | null; firstTs: number | null; lastTs: number | null }[]): void {
    if (!rows.length) return;
    const stmt = this.db.prepare(
      `INSERT INTO session_title (device, agent, session_id, title, cwd, first_ts, last_ts, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(device, agent, session_id) DO UPDATE SET
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
        stmt.run(r.device, r.agent, r.sessionId, r.title, r.cwd, r.firstTs, r.lastTs, now);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * 会话标题。键是 `设备:来源:会话`，带设备是为了两台机器上出现同一个
   * session_id 时不串台。
   */
  sessionTitles(): Map<string, { title: string | null; cwd: string | null }> {
    const rows = this.db.prepare('SELECT device, agent, session_id, title, cwd FROM session_title').all() as any[];
    return new Map(rows.map(r => [`${r.device}:${r.agent}:${r.session_id}`, { title: r.title, cwd: r.cwd }]));
  }

  /** 取一个会话的标题。device 不给就在所有设备里找，找到就用。 */
  sessionTitle(device: string | null, agent: string, sessionId: string): { title: string | null; cwd: string | null } | null {
    const titles = this.sessionTitles();
    if (device) return titles.get(`${device}:${agent}:${sessionId}`) ?? null;
    for (const [key, v] of titles) {
      if (key.endsWith(`:${agent}:${sessionId}`)) return v;
    }
    return null;
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
        (event_id, device, agent, session_id, parent_session_id, is_child, ts, local_day, local_month, cwd, model, provider,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
         thinking_level)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(event_id) DO UPDATE SET
         device=excluded.device, session_id=excluded.session_id, parent_session_id=excluded.parent_session_id, is_child=excluded.is_child,
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
          e.eventId, e.device, e.agent, e.sessionId, e.parentSessionId, e.isChild ? 1 : 0, e.ts, e.localDay, e.localMonth,
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
    // 只有本机设备有明细（usage_event）；同步进来的远端设备只有聚合行，
    // 所以重算时必须按设备限定，否则会把远端的行一起删掉。
    const localDevices = (this.db.prepare('SELECT DISTINCT device FROM usage_event').all() as any[])
      .map(r => r.device as string);

    this.db.exec('BEGIN');
    try {
      for (const day of scope) {
        for (const d of localDevices) {
          this.db.prepare('DELETE FROM agg_day_agent WHERE day = ? AND device = ?').run(day, d);
          this.db.prepare('DELETE FROM agg_day_dir WHERE day = ? AND device = ?').run(day, d);
          this.db.prepare('DELETE FROM agg_day_model WHERE day = ? AND device = ?').run(day, d);
          this.db.prepare('DELETE FROM agg_day_agent_model WHERE day = ? AND device = ?').run(day, d);
        }
      }
      for (const day of scope) {

        this.db.prepare(
          `INSERT INTO agg_day_agent (day, device, agent, ${COLS}) SELECT local_day AS day, device, agent, ${AGG} FROM usage_event WHERE local_day = ? GROUP BY day, device, agent`
        ).run(day);

        this.db.prepare(
          `INSERT INTO agg_day_dir (day, device, dir, ${COLS}) SELECT local_day AS day, device, cwd, ${AGG} FROM usage_event WHERE local_day = ? GROUP BY day, device, cwd`
        ).run(day);

        this.db.prepare(
          `INSERT INTO agg_day_model (day, device, model, vendor, ${COLS}) SELECT local_day AS day, device, model, COALESCE(provider, '') AS vendor, ${AGG} FROM usage_event WHERE local_day = ? GROUP BY day, device, model, vendor`
        ).run(day);

        this.db.prepare(
          `INSERT INTO agg_day_agent_model (day, device, agent, model, vendor, ${COLS}) SELECT local_day AS day, device, agent, model, COALESCE(provider, '') AS vendor, ${AGG} FROM usage_event WHERE local_day = ? GROUP BY day, device, agent, model, vendor`
        ).run(day);
      }

      // 本机的会话汇总也跟着重算（远端设备的行由导入维护，不动）
      const months = new Set(scope.map(d => d.slice(0, 7)));
      for (const d of localDevices) {
        for (const m of months) this.rebuildSessionUsage(d, m);
      }

      this.refreshTotal();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 重算某个设备某个月的会话汇总。远端设备的会话由 sync import 直接写入。 */
  rebuildSessionUsage(device: string, month: string): void {
    // 一个会话只落在它最后一天所属的月份里。跨月的会话在旧月份可能留有旧行，
    // 所以按「这个月结束的那些会话」删，而不是按 month 列删。
    this.db.prepare(
      `DELETE FROM session_usage WHERE device = ? AND agent || ':' || session_id IN (
         SELECT agent || ':' || session_id FROM usage_event
         WHERE device = ? AND substr(local_day, 1, 7) = ?
         GROUP BY agent, session_id
         HAVING substr(MAX(local_day), 1, 7) = ?
       )`
    ).run(device, device, month, month);
    this.db.prepare(
      `INSERT INTO session_usage
         (device, agent, session_id, month, title, dir, model, vendor, events, tokens,
          input, output, cache_read, cache_write, first_ts, last_ts)
       SELECT e.device, e.agent, e.session_id,
              substr(MAX(e.local_day), 1, 7),
              s.title,
              COALESCE(s.cwd, MIN(e.cwd)),
              (SELECT model FROM usage_event m
                WHERE m.device = e.device AND m.agent = e.agent AND m.session_id = e.session_id
                GROUP BY model ORDER BY SUM(m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_write_tokens) DESC
                LIMIT 1),
              (SELECT provider FROM usage_event m
                WHERE m.device = e.device AND m.agent = e.agent AND m.session_id = e.session_id
                ORDER BY (m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_write_tokens) DESC
                LIMIT 1),
              COUNT(*),
              SUM(e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_write_tokens),
              SUM(e.input_tokens), SUM(e.output_tokens), SUM(e.cache_read_tokens), SUM(e.cache_write_tokens),
              MIN(e.ts), MAX(e.ts)
       FROM usage_event e
       LEFT JOIN session_title s
         ON s.device = e.device AND s.agent = e.agent AND s.session_id = e.session_id
       WHERE e.device = ? AND substr(e.local_day, 1, 7) = ?
       GROUP BY e.device, e.agent, e.session_id
       HAVING substr(MAX(e.local_day), 1, 7) = ?`
    ).run(device, month, month);
  }

  /** 重算累计。聚合表很小，直接全量重算比增量更不容易出错。 */
  refreshTotal(): void {
    // 四个桶和推理 token 都从聚合表取。聚合表里有同步进来的远端设备，
    // 而 usage_event 只有本机明细，两边混着算会对不上。
    const t = this.db.prepare(
      `SELECT COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output,
              COALESCE(SUM(cache_read),0) cache_read, COALESCE(SUM(cache_write),0) cache_write,
              COALESCE(SUM(reasoning),0) reasoning, COALESCE(SUM(tokens),0) tokens
       FROM agg_day_agent`
    ).get() as any;
    const reasoning = { r: t.reasoning };

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

  /** 指定设备的累计（不含设备参数就是全部设备）。总账页切设备时用它。 */
  totalFor(device?: string): { input: number; output: number; cache_read: number; cache_write: number; reasoning: number; tokens: number; days: number; first: string | null; last: string | null } {
    const where = device ? 'WHERE device = ?' : '';
    const args = device ? [device] : [];
    const r = this.db.prepare(
      `SELECT COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output,
              COALESCE(SUM(cache_read),0) cache_read, COALESCE(SUM(cache_write),0) cache_write,
              COALESCE(SUM(reasoning),0) reasoning, COALESCE(SUM(tokens),0) tokens,
              COUNT(DISTINCT day) days, MIN(day) first, MAX(day) last
       FROM agg_day_agent ${where}`
    ).get(...args) as any;
    return r;
  }

  /**
   * 库里最早和最晚的一天。总账页的「全期」用它。
   * 读聚合表而不是明细：同步进来的远端设备只有聚合行。
   */
  dayBounds(device?: string): { first: string | null; last: string | null } {
    const dev = device ? ' WHERE device = ?' : '';
    const r = this.db.prepare(
      `SELECT MIN(day) first, MAX(day) last FROM agg_day_agent${dev}`
    ).get(...(device ? [device] : [])) as any;
    return { first: r?.first ?? null, last: r?.last ?? null };
  }

  /** 有数据的自然日数量，按聚合表算（含远端设备）。 */
  dayCount(): number {
    const r = this.db.prepare('SELECT COUNT(DISTINCT day) n FROM agg_day_agent').get() as any;
    return r?.n ?? 0;
  }

  /** 某个月每天的用量和按目录的拆分。 */
  calendar(month: string, device?: string): { days: any[]; legend: any[] } {
    const dev = device ? ' AND device = ?' : '';
    const devArgs = device ? [device] : [];
    const days = this.db.prepare(
      `SELECT day, SUM(tokens) tokens
       FROM agg_day_agent WHERE day LIKE ?${dev} GROUP BY day ORDER BY day`
    ).all(month + '%', ...devArgs) as any[];

    const dirs = this.db.prepare(
      `SELECT dir, SUM(tokens) tokens FROM agg_day_dir WHERE day LIKE ?${dev} GROUP BY dir ORDER BY tokens DESC`
    ).all(month + '%', ...devArgs) as any[];

    const byDayDir = this.db.prepare(
      `SELECT day, dir, tokens FROM agg_day_dir WHERE day LIKE ?${dev}`
    ).all(month + '%', ...devArgs) as any[];

    const map = new Map<string, Map<string, number>>();
    for (const r of byDayDir) {
      if (!map.has(r.day)) map.set(r.day, new Map());
      map.get(r.day)!.set(r.dir, r.tokens);
    }
    for (const d of days) d.byDir = Object.fromEntries(map.get(d.day) ?? new Map());
    return { days, legend: dirs };
  }

  /**
   * 区间内的调用次数。远端设备只有聚合、没有明细，所以返回 null——
   * 调用次数只有本机有资格给。
   */
  countEvents(from: string, to: string, device?: string): number | null {
    // 全部设备、或者指定了一台没有明细的设备（远端），都给不出次数：
    // 聚合里没有这个字段，硬算只会算成本机的那一份。
    if (!device) return null;
    const has = this.db.prepare('SELECT 1 FROM usage_event WHERE device = ? LIMIT 1').get(device);
    if (!has) return null;
    const r = this.db.prepare(
      'SELECT COUNT(*) n FROM usage_event WHERE device = ? AND local_day >= ? AND local_day <= ?'
    ).get(device, from, to) as any;
    return r?.n ?? 0;
  }

  /** 区间内的来源 × 模型交叉表。 */
  matrix(from: string, to: string, device?: string): any {
    const dev = device ? ' AND device = ?' : '';
    const rows = this.db.prepare(
      `SELECT agent, model, vendor, SUM(tokens) tokens
       FROM agg_day_agent_model WHERE day >= ? AND day <= ?${dev}
       GROUP BY agent, model, vendor`
    ).all(from, to, ...(device ? [device] : [])) as any[];
    return { cells: rows };
  }

  /** 区间内的按模型和按目录汇总。模型带厂商，同名不同厂商分成两行。 */
  breakdown(from: string, to: string, device?: string): { byModel: any[]; byDir: any[]; totals: any } {
    const dev = device ? ' AND device = ?' : '';
    const devArgs = device ? [device] : [];
    // 推理 token 也要取。聚合表里存了 reasoning 列，查询不取的话，
    // 「思考 token」在聚合页被静默丢掉，前端只能补 0，页面恒显示 0%，
    // 和总账页的口径不一致。
    const byModel = this.db.prepare(
      `SELECT model, vendor, SUM(tokens) tokens,
              SUM(input) input, SUM(output) output, SUM(cache_read) cache_read, SUM(cache_write) cache_write,
              SUM(reasoning) reasoning
       FROM agg_day_model WHERE day >= ? AND day <= ?${dev} GROUP BY model, vendor ORDER BY tokens DESC`
    ).all(from, to, ...devArgs);
    const byDir = this.db.prepare(
      `SELECT dir, SUM(tokens) tokens,
              SUM(input) input, SUM(output) output, SUM(cache_read) cache_read, SUM(cache_write) cache_write,
              SUM(reasoning) reasoning
       FROM agg_day_dir WHERE day >= ? AND day <= ?${dev} GROUP BY dir ORDER BY tokens DESC`
    ).all(from, to, ...devArgs);
    const totals = this.db.prepare(
      `SELECT COALESCE(SUM(tokens),0) tokens,
              COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output,
              COALESCE(SUM(cache_read),0) cache_read, COALESCE(SUM(cache_write),0) cache_write,
              COALESCE(SUM(reasoning),0) reasoning,
              COUNT(DISTINCT day) days
       FROM agg_day_agent WHERE day >= ? AND day <= ?${dev}`
    ).get(from, to, ...devArgs) as any;
    return { byModel, byDir, totals };
  }

  /** 区间内的按来源汇总。 */
  byAgent(from: string, to: string, device?: string): any[] {
    const dev = device ? ' AND device = ?' : '';
    return this.db.prepare(
      `SELECT agent, SUM(tokens) tokens
       FROM agg_day_agent WHERE day >= ? AND day <= ?${dev} GROUP BY agent ORDER BY tokens DESC`
    ).all(from, to, ...(device ? [device] : []));
  }

  /**
   * 会话列表：本机从明细汇总，远端从 session_usage 取，合在一起按最后活跃倒序。
   * 远端会话带 detail=0——逐轮明细没有同步，详情页要据此说明。
   */
  conversations(filter: {
    dir?: string; agent?: string; model?: string; vendor?: string; q?: string; limit?: number; device?: string;
  }): any[] {
    const where: string[] = [];
    const args: any[] = [];
    if (filter.dir) { where.push('cwd = ?'); args.push(filter.dir); }
    if (filter.agent) { where.push('agent = ?'); args.push(filter.agent); }
    if (filter.model) { where.push('model = ?'); args.push(filter.model); }
    if (filter.vendor) { where.push('vendor = ?'); args.push(filter.vendor); }
    if (filter.device) { where.push('device = ?'); args.push(filter.device); }
    if (filter.q) {
      where.push('(session_id LIKE ? OR cwd LIKE ? OR title LIKE ?)');
      args.push(`%${filter.q}%`, `%${filter.q}%`, `%${filter.q}%`);
    }

    const sql = `
      SELECT * FROM (
        SELECT e.device, e.agent, e.session_id, MIN(e.cwd) cwd, MIN(e.model) model, MIN(e.provider) vendor,
               s.title AS title, COUNT(*) events,
               SUM(e.input_tokens) input, SUM(e.output_tokens) output,
               SUM(e.cache_read_tokens) cache_read, SUM(e.cache_write_tokens) cache_write,
               MIN(e.ts) first_ts, MAX(e.ts) last_ts, 1 AS detail
        FROM usage_event e
        LEFT JOIN session_title s
          ON s.device = e.device AND s.agent = e.agent AND s.session_id = e.session_id
        GROUP BY e.device, e.agent, e.session_id

        UNION ALL

        SELECT su.device, su.agent, su.session_id, su.dir AS cwd, su.model, su.vendor,
               su.title, su.events, su.input, su.output, su.cache_read, su.cache_write,
               su.first_ts, su.last_ts, 0 AS detail
        FROM session_usage su
        WHERE NOT EXISTS (
          SELECT 1 FROM usage_event e2
          WHERE e2.device = su.device AND e2.agent = su.agent AND e2.session_id = su.session_id
        )
      )
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY last_ts DESC LIMIT ?`;
    args.push(filter.limit ?? 200);
    return this.db.prepare(sql).all(...args);
  }

  /** 同步过来的会话汇总（本机没有明细的那些）。 */
  /**
   * 会话汇总。device 给了就只找那台设备的——两台设备上出现同一个
   * session_id 时，不带设备参数会随机拿到其中一台。
   */
  sessionSummary(agent: string, sessionId: string, device?: string | null): any {
    if (device) {
      return this.db.prepare(
        'SELECT * FROM session_usage WHERE device = ? AND agent = ? AND session_id = ? LIMIT 1'
      ).get(device, agent, sessionId) ?? null;
    }
    return this.db.prepare(
      'SELECT * FROM session_usage WHERE agent = ? AND session_id = ? LIMIT 1'
    ).get(agent, sessionId) ?? null;
  }

  /** 单个会话的逐条明细。limit 给 0 表示不限。 */
  sessionEvents(sessionId: string, limit = 0, device?: string | null): { events: any[]; total: number } {
    const where = device ? 'session_id = ? AND device = ?' : 'session_id = ?';
    const args: any[] = device ? [sessionId, device] : [sessionId];
    const total = (this.db.prepare(`SELECT COUNT(*) n FROM usage_event WHERE ${where}`).get(...args) as any).n;
    const sql = `SELECT * FROM usage_event WHERE ${where} ORDER BY ts DESC` +
      (limit > 0 ? ' LIMIT ?' : '');
    const rows = (limit > 0
      ? this.db.prepare(sql).all(...args, limit)
      : this.db.prepare(sql).all(...args)) as any[];
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

  /**
   * 某天（或某设备）的四桶，读聚合表。远端设备只有聚合，没有调用次数，
   * 所以这里不返回 events。
   */
  dayBuckets(day: string, device?: string): {
    input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; tokens: number;
  } {
    const dev = device ? ' AND device = ?' : '';
    const r = this.db.prepare(
      `SELECT COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output,
              COALESCE(SUM(cache_read),0) cache_read, COALESCE(SUM(cache_write),0) cache_write,
              COALESCE(SUM(reasoning),0) reasoning, COALESCE(SUM(tokens),0) tokens
       FROM agg_day_agent WHERE day = ?${dev}`
    ).get(day, ...(device ? [device] : [])) as any;
    return {
      input: r.input, output: r.output, cacheRead: r.cache_read,
      cacheWrite: r.cache_write, reasoning: r.reasoning, tokens: r.tokens
    };
  }

  /**
   * 某一天的会话列表，本机和远端合在一起。
   * 本机从明细汇总，远端只有 session_usage 里的会话汇总（按首末时间判断是否落在这一天）。
   */
  sessionsOnDay(day: string, device?: string): any[] {
    const dayStart = Date.parse(`${day}T00:00:00+08:00`);
    const dayEnd = dayStart + 86400000 - 1;
    const devFilter = device ? ' AND device = ?' : '';
    const args = device ? [device] : [];

    return this.db.prepare(
      `SELECT * FROM (
         SELECT e.device, e.agent, e.session_id, MIN(e.cwd) cwd, COUNT(*) events,
                SUM(e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_write_tokens) tokens,
                MIN(e.ts) first_ts, MAX(e.ts) last_ts, NULL AS title, 'local' AS src
         FROM usage_event e
         WHERE e.local_day = ?${devFilter}
         GROUP BY e.device, e.agent, e.session_id

         UNION ALL

         SELECT s.device, s.agent, s.session_id, s.dir AS cwd, s.events, s.tokens,
                s.first_ts, s.last_ts, s.title, 'remote' AS src
         FROM session_usage s
         WHERE s.device != '' AND s.first_ts <= ? AND s.last_ts >= ?
           AND NOT EXISTS (
             SELECT 1 FROM usage_event e2
             WHERE e2.device = s.device AND e2.agent = s.agent AND e2.session_id = s.session_id
           )${device ? ' AND s.device = ?' : ''}
       ) ORDER BY tokens DESC`
    ).all(day, ...args, dayEnd, dayStart, ...args);
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
  dayMatrix(day: string, device?: string): any[] {
    const dev = device ? ' AND device = ?' : '';
    return this.db.prepare(
      `SELECT agent, model, vendor, SUM(tokens) tokens
       FROM agg_day_agent_model WHERE day = ?${dev}
       GROUP BY agent, model, vendor`
    ).all(day, ...(device ? [device] : []));
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
