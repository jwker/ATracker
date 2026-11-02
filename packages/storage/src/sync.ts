// 多设备同步：rollup 文件的导出与导入。
//
// 文件永远是一台设备一份，谁都不改别人的。导入只写自己库里那张表，不碰别人的文件。
// 「合并」发生在查询阶段：库里每行都带 device，页面按条件做 SUM。
//
// 文件命名：atracker-<deviceId>-<YYYY-MM>.jsonl
// 每行一条 JSON，三种类型：
//   {"t":"device", ...}                    设备自述，文件头一行
//   {"t":"agg","k":"agent"|"dir"|...}      日级聚合，四种维度各一行一条
//   {"t":"session", ...}                   会话汇总

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

/* ---------- 导出 ---------- */

/** 把本机数据按「设备 + 月」写成 rollup 文件，返回写出的文件路径。 */
export function exportRollup(repo: Repo, device: DeviceInfo, dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const months = (repo.db.prepare(
    'SELECT DISTINCT substr(day, 1, 7) m FROM agg_day_agent WHERE device = ? ORDER BY m'
  ).all(device.id) as any[]).map(r => r.m as string);

  const written: string[] = [];
  for (const month of months) {
    const lines: Line[] = [{ t: 'device', id: device.id, name: device.name, platform: device.platform, writtenAt: Date.now() }];

    lines.push(...aggLines(repo, device.id, month, 'agent'));
    lines.push(...aggLines(repo, device.id, month, 'dir'));
    lines.push(...aggLines(repo, device.id, month, 'model'));
    lines.push(...aggLines(repo, device.id, month, 'agent_model'));
    lines.push(...sessionLines(repo, device.id, month));

    const file = join(dir, rollupFileName(device.id, month));
    writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
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
    `SELECT agent, session_id, title, dir, events, tokens, input, output, cache_read, cache_write, first_ts, last_ts
     FROM session_usage WHERE device = ? AND month = ?`
  ).all(deviceId, month) as any[]).map(r => ({
    t: 'session' as const,
    device: deviceId,
    month,
    agent: r.agent,
    sessionId: r.session_id,
    title: r.title ?? null,
    dir: r.dir ?? null,
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
export function importRollups(repo: Repo, dir: string, localDeviceId: string): ImportSummary {
  const summary: ImportSummary = { files: 0, skippedOwn: 0, devices: [], aggRows: 0, sessionRows: 0, errors: [] };

  let names: string[];
  try {
    names = readdirSync(dir).filter(n => FILE_RE.test(n)).sort();
  } catch (err) {
    summary.errors.push(`读不了目录 ${dir}：${(err as Error).message}`);
    return summary;
  }

  // 先按设备把文件里的行归拢好，再整块替换，避免边删边插。
  type PayloadLine = AggLine | SessionLine;
  const perDevice = new Map<string, { name: string; platform: string; months: Map<string, PayloadLine[]> }>();

  for (const name of names) {
    summary.files++;
    const fileDevice = name.match(FILE_RE)![1]!;
    if (fileDevice === localDeviceId) {
      summary.skippedOwn++;
      continue;
    }
    let text: string;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch (err) {
      summary.errors.push(`${name}：${(err as Error).message}`);
      continue;
    }
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        summary.errors.push(`${name}：有一行不是合法 JSON，已跳过`);
        continue;
      }
      if (line.t === 'device') {
        const entry = perDevice.get(line.id) ?? { name: line.name, platform: line.platform, months: new Map() };
        entry.name = line.name || entry.name;
        entry.platform = line.platform || entry.platform;
        perDevice.set(line.id, entry);
        continue;
      }
      const deviceId = line.device ?? fileDevice;
      if (deviceId === localDeviceId) continue;
      const entry = perDevice.get(deviceId) ?? { name: deviceId.slice(0, 8), platform: '', months: new Map() };
      const month = line.t === 'session' ? line.month : line.day.slice(0, 7);
      const bucket = entry.months.get(month) ?? [];
      bucket.push(line);
      entry.months.set(month, bucket);
      perDevice.set(deviceId, entry);
    }
  }

  repo.db.exec('BEGIN');
  try {
    for (const [deviceId, entry] of perDevice) {
      repo.touchDevice({ id: deviceId, name: entry.name, platform: entry.platform });

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
    repo.db.exec('ROLLBACK');
    summary.errors.push(`导入失败：${(err as Error).message}`);
    return summary;
  }

  repo.refreshTotal();
  return summary;
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
       (device, agent, session_id, month, title, dir, events, tokens, input, output, cache_read, cache_write, first_ts, last_ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    l.device, l.agent, l.sessionId, l.month, l.title ?? null, l.dir ?? null,
    l.events, l.tokens, l.input, l.output, l.cacheRead, l.cacheWrite, l.firstTs, l.lastTs
  );
}
