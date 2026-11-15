// 多设备同步：rollup 文件的导出与导入。
//
// 文件永远是一台设备一份，谁都不改别人的。导入只写自己库里那张表，不碰别人的文件。
// 「合并」发生在查询阶段：库里每行都带 device，页面按条件做 SUM。
//
// 读写一律走异步 fs：同步目录经常是 iCloud、Syncthing、局域网共享盘，
// 同步调用一旦卡在内核里，主进程的事件循环就停了，界面、扫描、退出全部没反应。
// 异步化的代价是「等不到结果」，那是调用方的事（service 里给了超时）。
//
// 文件命名：atracker-<deviceId>-<YYYY-MM>.jsonl
// 每行一条 JSON，三种类型：
//   {"t":"device", ...}                    设备自述，文件头一行
//   {"t":"agg","k":"agent"|"dir"|...}      日级聚合，四种维度各一行一条
//   {"t":"session", ...}                   会话汇总

import { mkdir, readdir, readFile as readFileAsync, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Repo } from './repo.ts';
import type { DeviceInfo } from '../../core/src/device.ts';

/** 聚合类型，和 schema 里的四张 agg_day_* 一一对应。 */
const KINDS = ['agent', 'dir', 'model', 'agent_model'] as const;
export type AggKind = typeof KINDS[number];

interface AggLine {
  t: 'agg';
  k: AggKind;
  day: string;
  device: string;
  agent?: string;
  dir?: string;
  model?: string;
  vendor?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  tokens: number;
}

interface SessionLine {
  t: 'session';
  device: string;
  month: string;
  agent: string;
  sessionId: string;
  title: string | null;
  dir: string | null;
  /** 会话里用得最多的模型 */
  model: string | null;
  vendor: string | null;
  events: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  firstTs: number | null;
  lastTs: number | null;
}

interface DeviceLine {
  t: 'device';
  id: string;
  name: string;
  platform: string;
  writtenAt: number;
}

type Line = AggLine | SessionLine | DeviceLine;

const FILE_RE = /^atracker-([0-9a-fA-F-]{8,})-(\d{4}-\d{2})\.jsonl$/;

export function rollupFileName(deviceId: string, month: string): string {
  return `atracker-${deviceId}-${month}.jsonl`;
}

export interface ExportOptions {
  /** 只导出这些月份（YYYY-MM）。不给就导出该设备的所有月份。 */
  months?: string[];
  /** 超时才用；卡在文件系统里的调用未必能被打断，所以调用方还要有自己的超时。 */
  signal?: AbortSignal;
}

export interface ImportOptions {
  signal?: AbortSignal;
}

/** 中止请求。库里已经改动之前调用它，避免超时之后旧的一轮把数据写进去。 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('同步操作已中止');
}

/* ---------- 导出 ---------- */

/** 把本机数据按「设备 + 月」写成 rollup 文件，返回写出的文件路径。 */
export async function exportRollup(
  repo: Repo,
  device: DeviceInfo,
  dir: string,
  opts: ExportOptions = {}
): Promise<string[]> {
  throwIfAborted(opts.signal);
  await mkdir(dir, { recursive: true });
  // 月份取两处的并集：聚合表有、但明细被清掉的月份，会话汇总里还留着，
  // 少了它那个月的会话就同步不过去。
  const months = (repo.db.prepare(
    `SELECT m FROM (
       SELECT DISTINCT substr(day, 1, 7) m FROM agg_day_agent WHERE device = ?
       UNION
       SELECT DISTINCT month m FROM session_usage WHERE device = ?
     ) ORDER BY m`
  ).all(device.id, device.id) as any[]).map(r => r.m as string);

  const wanted = opts.months ? new Set(opts.months) : null;
  const written: string[] = [];
  for (const month of months) {
    if (wanted && !wanted.has(month)) continue;
    // 每写一个月都要重新确认一次，别在超时之后继续写
    throwIfAborted(opts.signal);
    const lines: Line[] = [{ t: 'device', id: device.id, name: device.name, platform: device.platform, writtenAt: Date.now() }];

    lines.push(...aggLines(repo, device.id, month, 'agent'));
    lines.push(...aggLines(repo, device.id, month, 'dir'));
    lines.push(...aggLines(repo, device.id, month, 'model'));
    lines.push(...aggLines(repo, device.id, month, 'agent_model'));
    lines.push(...sessionLines(repo, device.id, month));

    const file = join(dir, rollupFileName(device.id, month));
    // 先写临时文件再改名。直接写最终文件的话，进程在写一半被杀，
    // 或者另一台设备正好读到正在写的文件，产出的就是一份半截 JSON。
    // 半截文件被导入时会被整个丢掉，但丢掉之前它已经占着那个名字。
    const tmp = join(dir, `.${rollupFileName(device.id, month)}.tmp`);
    try {
      await writeFile(tmp, lines.map(l => JSON.stringify(l)).join('\n') + '\n', { signal: opts.signal });
      await rename(tmp, file);
    } catch (err) {
      try { await unlink(tmp); } catch { /* 临时文件可能没建成 */ }
      throw err;
    }
    written.push(file);
  }
  return written;
}

function aggLines(repo: Repo, deviceId: string, month: string, kind: AggKind): AggLine[] {
  const cols = 'input, output, cache_read, cache_write, reasoning, tokens';
  const sql =
    kind === 'agent'
      ? `SELECT day, agent, ${cols} FROM agg_day_agent WHERE device = ? AND substr(day,1,7) = ? ORDER BY day`
      : kind === 'dir'
        ? `SELECT day, dir, ${cols} FROM agg_day_dir WHERE device = ? AND substr(day,1,7) = ? ORDER BY day`
        : kind === 'model'
          ? `SELECT day, model, vendor, ${cols} FROM agg_day_model WHERE device = ? AND substr(day,1,7) = ? ORDER BY day`
          : `SELECT day, agent, model, vendor, ${cols} FROM agg_day_agent_model WHERE device = ? AND substr(day,1,7) = ? ORDER BY day`;

  return (repo.db.prepare(sql).all(deviceId, month) as any[]).map(r => ({
    t: 'agg' as const,
    k: kind,
    device: deviceId,
    day: r.day,
    ...(r.agent !== undefined ? { agent: r.agent } : {}),
    ...(r.dir !== undefined ? { dir: r.dir } : {}),
    ...(r.model !== undefined ? { model: r.model } : {}),
    ...(r.vendor !== undefined ? { vendor: r.vendor } : {}),
    input: r.input ?? 0,
    output: r.output ?? 0,
    cacheRead: r.cache_read ?? 0,
    cacheWrite: r.cache_write ?? 0,
    reasoning: r.reasoning ?? 0,
    tokens: r.tokens ?? 0
  }));
}

function sessionLines(repo: Repo, deviceId: string, month: string): SessionLine[] {
  return (repo.db.prepare(
    `SELECT agent, session_id, title, dir, model, vendor, events, tokens, input, output, cache_read, cache_write, first_ts, last_ts
     FROM session_usage WHERE device = ? AND month = ?`
  ).all(deviceId, month) as any[]).map(r => ({
    t: 'session' as const,
    device: deviceId,
    month,
    agent: r.agent,
    sessionId: r.session_id,
    title: r.title ?? null,
    dir: r.dir ?? null,
    model: r.model ?? null,
    vendor: r.vendor ?? null,
    events: r.events ?? 0,
    tokens: r.tokens ?? 0,
    input: r.input ?? 0,
    output: r.output ?? 0,
    cacheRead: r.cache_read ?? 0,
    cacheWrite: r.cache_write ?? 0,
    firstTs: r.first_ts ?? null,
    lastTs: r.last_ts ?? null
  }));
}

/* ---------- 导入 ---------- */

export interface ImportSummary {
  /** 读了几个文件 */
  files: number;
  /** 跳过自己的文件 */
  skippedOwn: number;
  /** 跳过被忽略的设备的文件 */
  skippedIgnored: number;
  /** 导入了哪些设备 */
  devices: { id: string; name: string; months: string[] }[];
  aggRows: number;
  sessionRows: number;
  errors: string[];
}

/**
 * 读目录里所有 rollup 文件，把别的设备的数据写进本机库。
 * 按「设备 + 月」整块替换：先删该设备该月的行再插入，所以重复导入是幂等的。
 * 自己的文件会被跳过——本机数据本来就该从明细重算，导入自己的文件没有意义。
 */
export async function importRollups(
  repo: Repo,
  dir: string,
  localDeviceId: string,
  opts: ImportOptions = {}
): Promise<ImportSummary> {
  const summary: ImportSummary = { files: 0, skippedOwn: 0, skippedIgnored: 0, devices: [], aggRows: 0, sessionRows: 0, errors: [] };

  let names: string[];
  try {
    names = (await readdir(dir)).filter(n => FILE_RE.test(n)).sort();
  } catch (err) {
    summary.errors.push(`读不了目录 ${dir}：${(err as Error).message}`);
    return summary;
  }

  // 设备 id 在文件名里可能和库里的大小写不一致（文件复制过程会改），
  // 比较一律按小写来。
  const ignored = new Set([...repo.ignoredDevices()].map(id => id.toLowerCase()));
  const isIgnored = (id: string) => ignored.has(id.toLowerCase());
  const local = localDeviceId.toLowerCase();
  type PayloadLine = AggLine | SessionLine;
  const perDevice = new Map<string, { name: string; platform: string; months: Map<string, PayloadLine[]> }>();

  /**
   * 读一个文件，全部行都合法才收下。
   *
   * 有一行坏就整个文件不要：导入是「先删这个设备这个月，再插新的」。
   * 收下残缺的文件等于用残缺的数据覆盖对方完整的月份。
   */
  const readFile = async (name: string, fileDevice: string): Promise<PayloadLine[] | null> => {
    let text: string;
    try {
      text = await readFileAsync(join(dir, name), { encoding: 'utf8', signal: opts.signal });
    } catch (err) {
      summary.errors.push(`${name}：${(err as Error).message}`);
      return null;
    }
    const lines: PayloadLine[] = [];
    let bad = 0;
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      let line: unknown;
      try {
        line = JSON.parse(raw);
      } catch {
        bad++;
        continue;
      }
      if (!isValidLine(line)) {
        bad++;
        continue;
      }
      if (line.t === 'device') {
        // 设备头必须和文件名对得上。否则一台设备的文件能改掉别的设备的身份。
        if (line.id.toLowerCase() !== fileDevice.toLowerCase()) {
          summary.errors.push(`${name}：设备头里的 id 和文件名不一致，整个文件已跳过`);
          return null;
        }
        const entry = perDevice.get(fileDevice) ?? { name: line.name, platform: line.platform, months: new Map() };
        entry.name = line.name || entry.name;
        entry.platform = line.platform || entry.platform;
        perDevice.set(fileDevice, entry);
        continue;
      }
      // 数据行的 device 也必须和文件名一致。文件内容决定写谁的数据是不行的。
      if (line.device.toLowerCase() !== fileDevice.toLowerCase()) {
        summary.errors.push(`${name}：有一行的 device 和文件名不一致，整个文件已跳过`);
        return null;
      }
      if (line.device.toLowerCase() === local || isIgnored(line.device)) continue;
      lines.push(line);
    }
    if (bad > 0) {
      summary.errors.push(`${name}：有 ${bad} 行不合法，整个文件已跳过（不导入残缺数据）`);
      return null;
    }
    return lines;
  };

  for (const name of names) {
    throwIfAborted(opts.signal);
    summary.files++;
    const fileDevice = name.match(FILE_RE)![1]!;
    if (fileDevice.toLowerCase() === local) {
      summary.skippedOwn++;
      continue;
    }
    if (isIgnored(fileDevice)) {
      summary.skippedIgnored++;
      continue;
    }
    const lines = await readFile(name, fileDevice);
    if (!lines) continue;

    const entry = perDevice.get(fileDevice) ?? { name: fileDevice.slice(0, 8), platform: '', months: new Map() };
    for (const line of lines) {
      const month = line.t === 'session' ? line.month : line.day.slice(0, 7);
      const bucket = entry.months.get(month) ?? [];
      bucket.push(line);
      entry.months.set(month, bucket);
    }
    perDevice.set(fileDevice, entry);
  }

  // 所有文件都校验过了，现在才开始改库。
  // 超时中止时不写库：宁可这一轮白读，也不能把半轮的旧数据写进去。
  if (opts.signal?.aborted) {
    summary.errors.push('同步已中止，本轮没有写入');
    return summary;
  }
  try {
    repo.db.exec('BEGIN');
  } catch (err) {
    summary.errors.push(`开事务失败：${(err as Error).message}`);
    return summary;
  }
  try {
    for (const [deviceId, entry] of perDevice) {
      // 名字只在第一次见到这台设备时用对方自报的。用户在界面上改过的名字
      // 不该被别的机器的旧文件改回去。
      const known = repo.device(deviceId);
      repo.touchDevice({
        id: deviceId,
        name: known ? known.name : entry.name,
        platform: entry.platform || known?.platform || ''
      });

      for (const [month, lines] of entry.months) {
        replaceMonth(repo, deviceId, month);
        for (const line of lines) {
          if (line.t === 'agg') {
            insertAgg(repo, line);
            summary.aggRows++;
          } else {
            insertSession(repo, line);
            summary.sessionRows++;
          }
        }
      }

      summary.devices.push({
        id: deviceId,
        name: entry.name,
        months: [...entry.months.keys()].sort()
      });
    }
    repo.db.exec('COMMIT');
  } catch (err) {
    try { repo.db.exec('ROLLBACK'); } catch { /* 事务已经没了 */ }
    // 回滚了就不能再报导入了多少行，计数要清掉。
    summary.aggRows = 0;
    summary.sessionRows = 0;
    summary.devices = [];
    summary.errors.push(`导入失败：${(err as Error).message}`);
    return summary;
  }

  // 数据已经入库了，累计刷新失败只影响总数显示，不该把整次导入说成失败。
  try {
    repo.refreshTotal();
  } catch (err) {
    summary.errors.push(`导入成功但刷新累计失败：${(err as Error).message}`);
  }
  return summary;
}

/** 一行是不是结构合法的同步记录。 */
function isValidLine(v: unknown): v is Line {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const str = (x: unknown): boolean => typeof x === 'string' && x.length > 0;
  const num = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x);
  if (o.t === 'device') {
    return str(o.id) && typeof o.name === 'string' && typeof o.platform === 'string';
  }
  if (o.t === 'agg') {
    if (!(KINDS as readonly string[]).includes(o.k as string)) return false;
    if (!str(o.day) || !str(o.device)) return false;
    return num(o.input) && num(o.output) && num(o.cacheRead) && num(o.cacheWrite) && num(o.tokens);
  }
  if (o.t === 'session') {
    if (!str(o.month) || !str(o.device) || !str(o.agent) || !str(o.sessionId)) return false;
    return num(o.events) && num(o.tokens);
  }
  return false;
}

/** 删掉某设备某月的聚合和会话行，等着重新写入。 */
function replaceMonth(repo: Repo, deviceId: string, month: string): void {
  for (const table of ['agg_day_agent', 'agg_day_dir', 'agg_day_model', 'agg_day_agent_model']) {
    repo.db.prepare(`DELETE FROM ${table} WHERE device = ? AND substr(day, 1, 7) = ?`).run(deviceId, month);
  }
  repo.db.prepare('DELETE FROM session_usage WHERE device = ? AND month = ?').run(deviceId, month);
}

function insertAgg(repo: Repo, l: AggLine): void {
  const cols = 'input, output, cache_read, cache_write, reasoning, tokens';
  const vals = [l.input, l.output, l.cacheRead, l.cacheWrite, l.reasoning, l.tokens];
  if (l.k === 'agent') {
    repo.db.prepare(
      `INSERT OR REPLACE INTO agg_day_agent (day, device, agent, ${cols}) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(l.day, l.device, l.agent ?? '', ...vals);
  } else if (l.k === 'dir') {
    repo.db.prepare(
      `INSERT OR REPLACE INTO agg_day_dir (day, device, dir, ${cols}) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(l.day, l.device, l.dir ?? '', ...vals);
  } else if (l.k === 'model') {
    repo.db.prepare(
      `INSERT OR REPLACE INTO agg_day_model (day, device, model, vendor, ${cols}) VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(l.day, l.device, l.model ?? '', l.vendor ?? '', ...vals);
  } else {
    repo.db.prepare(
      `INSERT OR REPLACE INTO agg_day_agent_model (day, device, agent, model, vendor, ${cols}) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(l.day, l.device, l.agent ?? '', l.model ?? '', l.vendor ?? '', ...vals);
  }
}

function insertSession(repo: Repo, l: SessionLine): void {
  repo.db.prepare(
    `INSERT OR REPLACE INTO session_usage
       (device, agent, session_id, month, title, dir, model, vendor, events, tokens,
        input, output, cache_read, cache_write, first_ts, last_ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    l.device, l.agent, l.sessionId, l.month, l.title ?? null, l.dir ?? null,
    l.model ?? null, l.vendor ?? null,
    l.events, l.tokens, l.input, l.output, l.cacheRead, l.cacheWrite, l.firstTs, l.lastTs
  );
}
