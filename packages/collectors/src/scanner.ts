// 采集编排：把采集器产出的事件算价、落库、维护聚合。

import { readdir } from 'node:fs/promises';
import { readFile, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

import type { Collector, ScanContext, LogLevel } from './types.ts';
import type { UsageEvent } from '../../core/src/types.ts';
import type { CostResult, Pricing } from '../../core/src/pricing.ts';
import { resolveVendor } from '../../core/src/catalog.ts';
import { assignColors } from '../../core/src/palette.ts';
import { localDay, localMonth } from '../../core/src/time.ts';
import { zstdLines } from './zstd.ts';
import type { Repo } from '../../storage/src/repo.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** 自动发现采集器：扫目录，不手写列表，避免加了忘了注册。 */
export async function loadCollectors(): Promise<Collector[]> {
  const dir = here;
  const entries = await readdir(dir, { withFileTypes: true });
  const out: Collector[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name === 'node_modules') continue;
    const file = join(dir, e.name, 'index.ts');
    try {
      const mod = await import(pathToFileURL(file).href);
      const found = Object.values(mod).find((v: any) => v && typeof v === 'object' && typeof v.scan === 'function' && v.id);
      if (found) out.push(found as Collector);
    } catch {
      // 不是采集器目录，跳过
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export interface ScanOptions {
  trigger: 'watch' | 'poll' | 'manual';
  only?: string[];
}

export interface ScanSummary {
  batchId: number;
  filesScanned: number;
  eventsRead: number;
  eventsWritten: number;
  errors: number;
  days: string[];
}

export async function runScan(
  repo: Repo,
  pricing: Pricing,
  opts: ScanOptions
): Promise<ScanSummary> {
  const collectors = (await loadCollectors()).filter(c => !opts.only || opts.only.includes(c.id));
  const batchId = repo.startBatch(opts.trigger, Date.now());
  const sessionStates = new Map<string, Map<string, number>>();
  let curSource = 'unknown';
  const affectedDays = new Set<string>();
  let filesScanned = 0;
  let eventsRead = 0;
  let eventsWritten = 0;
  let errors = 0;

  const ctx: ScanContext = {
    async files(root, filter) {
      const out: string[] = [];
      async function walk(dir: string) {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else if (e.isFile() && (!filter || filter(p))) out.push(p);
        }
      }
      await walk(root);
      return out.sort();
    },

    async *lines(path, fromOffset) {
      const stream = createReadStream(path, { start: fromOffset, encoding: 'utf8' });
      let consumed = fromOffset;
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        consumed += Buffer.byteLength(line, 'utf8') + 1;
        yield { line, endOffset: consumed };
      }
    },

    async *zstdLines(path) {
      const buf = await readFile(path);
      for (const line of zstdLines(buf)) yield { line };
    },

    log(level: LogLevel, source: string, message: string) {
      repo.log(batchId, Date.now(), level, source, message);
    },

    price(ev: UsageEvent): CostResult {
      return pricing.cost(ev.ts, ev.agent, ev.model, {
        input: ev.buckets.input,
        output: ev.buckets.output,
        cacheRead: ev.buckets.cacheRead,
        cacheWrite: ev.buckets.cacheWrite
      }, ev.reportedCostUsd);
    },

    vendor(model, provider) {
      return resolveVendor(model, provider);
    },

    sessionState(sessionId) {
      return sessionStates.get(sessionId);
    },

    setSessionState(sessionId, state) {
      sessionStates.set(sessionId, state);
    },

    shouldParse(path) {
      let st;
      try {
        st = statSync(path);
      } catch {
        return { parse: false, offset: 0, reason: '文件不存在' };
      }
      const cur = repo.getCursor(path);
      if (!cur) return { parse: true, offset: 0, reason: '新文件' };

      // 解析规则变了，这个来源的文件全部重扫
      if (cur.source !== curSource) return { parse: true, offset: 0, reason: '解析规则已更新' };

      // 指纹没变，整个文件跳过
      if (cur.size === st.size && cur.mtimeMs === Math.floor(st.mtimeMs) && cur.inode === st.ino) {
        return { parse: false, offset: cur.offset, reason: '指纹未变' };
      }
      // 文件被重写或替换了，从头读
      if (st.size < cur.size || cur.inode !== st.ino) {
        return { parse: true, offset: 0, reason: '文件被重写' };
      }
      // 变大了：纯文本可以从上次偏移继续
      return { parse: true, offset: cur.offset, reason: '文件变大' };
    },

    commitFile(path, offset, complete) {
      try {
        const st = statSync(path);
        repo.setCursor({
          path,
          source: curSource,
          size: st.size,
          mtimeMs: Math.floor(st.mtimeMs),
          inode: st.ino,
          offset,
          complete: complete ? 1 : 0,
          lastScanAt: Date.now()
        });
      } catch {
        // 文件没了就不记
      }
    }
  };

  for (const collector of collectors) {
    curSource = collector.version ? `${collector.id}:${collector.version}` : collector.id;
    const collected: any[] = [];
    const sessionRows: any[] = [];
    try {
      for await (const ev of collector.scan(ctx)) {
        eventsRead++;
        const cost = ctx.price(ev);
        const day = localDay(ev.ts);
        affectedDays.add(day);
        collected.push({
          eventId: ev.eventId,
          agent: ev.agent,
          sessionId: ev.sessionId,
          parentSessionId: ev.parentSessionId,
          isChild: ev.isChild,
          ts: ev.ts,
          localDay: day,
          localMonth: day.slice(0, 7),
          cwd: ev.cwd,
          model: ev.model || '(未知模型)',
          provider: ctx.vendor(ev.model, ev.provider),
          input: ev.buckets.input,
          output: ev.buckets.output,
          cacheRead: ev.buckets.cacheRead,
          cacheWrite: ev.buckets.cacheWrite,
          reasoning: ev.buckets.reasoning,
          costCny: cost.cny,
          costUsd: cost.cny === null ? null : cost.cny / 6.5,
          costSource: cost.source,
          thinkingLevel: ev.thinkingLevel
        });
      }
    } catch (err) {
      errors++;
      repo.log(batchId, Date.now(), 'err', collector.id, `采集失败：${(err as Error).message}`);
    }

    if (collected.length) {
      eventsWritten += repo.upsertEvents(collected);
      filesScanned++;
    }

    // 会话元信息（标题等）
    if (collector.sessions) {
      try {
        for await (const meta of collector.sessions(ctx)) {
          sessionRows.push(meta);
        }
      } catch (err) {
        repo.log(batchId, Date.now(), 'warn', collector.id, `会话信息读取失败：${(err as Error).message}`);
      }
      if (sessionRows.length) repo.upsertSessions(sessionRows);
    }
  }

  // 没有变化就不重算聚合
  if (affectedDays.size) repo.rebuildAggregates([...affectedDays]);

  // 给这批出现的目录分配颜色，已经有的保持不变
  const paths = repo.db.prepare('SELECT DISTINCT cwd FROM usage_event').all().map((r: any) => r.cwd);
  const assigned = assignColors(repo.dirColors(), paths);
  repo.setDirColors(assigned);
  repo.finishBatch(batchId, {
    finishedAt: Date.now(),
    filesTotal: filesScanned,
    filesScanned,
    eventsRead,
    eventsWritten,
    errors
  });

  return { batchId, filesScanned, eventsRead, eventsWritten, errors, days: [...affectedDays] };
}
