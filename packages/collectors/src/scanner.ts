// 采集编排：把采集器产出的事件算价、落库、维护聚合。

import { readdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';

import type { DeviceInfo } from '../../core/src/device.ts';
import type { Collector, ScanContext, LogLevel } from './types.ts';
import type { UsageEvent } from '../../core/src/types.ts';
import { resolveVendor } from '../../core/src/catalog.ts';
import { assignColors } from '../../core/src/palette.ts';
import { localDay, localMonth } from '../../core/src/time.ts';
import { loadDevice } from '../../core/src/device.ts';
import { zstdLines } from './zstd.ts';
import type { Repo } from '../../storage/src/repo.ts';
import { claudeCodeCollector } from './claude-code/index.ts';
import { codexCollector } from './codex/index.ts';
import { dshCollector } from './dsh/index.ts';
import { opencodeCollector } from './opencode/index.ts';
import { piCollector } from './pi/index.ts';

/**
 * 采集器清单。手写而不是扫目录，因为打包后（asar / 单文件）扫目录 + 动态
 * import 会把 `.ts` 路径和目录结构都当成前提，加一个来源改这里一行更稳。
 */
export const COLLECTORS: Collector[] = [
  claudeCodeCollector,
  codexCollector,
  dshCollector,
  opencodeCollector,
  piCollector
].sort((a, b) => a.id.localeCompare(b.id));

export interface ScanOptions {
  trigger: 'watch' | 'poll' | 'manual';
  only?: string[];
  /** 本机身份。不传就按 ~/.atracker/device.json 现读。 */
  device?: DeviceInfo;
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
  opts: ScanOptions
): Promise<ScanSummary> {
  const device = opts.device ?? loadDevice();
  repo.touchDevice(device);

  const collectors = COLLECTORS.filter(c => !opts.only || opts.only.includes(c.id));
  const batchId = repo.startBatch(opts.trigger, Date.now());
  const sessionStates = new Map<string, Map<string, number>>();
  let curSource = 'unknown';
  const affectedDays = new Set<string>();
  let filesScanned = 0;
  /**
   * 这一批「看过」的文件：不管指纹有没有变都算。
   * sessions() 和 scan() 会各问一次 shouldParse，用 Set 去重。
   */
  const seenPaths = new Set<string>();
  /** 读取时观察到的文件指纹。 */
  const preRead = new Map<string, { size: number; mtimeMs: number; inode: number }>();
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

    /**
     * 逐行读纯文本，从 fromOffset 开始。
     *
     * 自己按字节切行，不走 readline：readline 吃掉了行尾的 \r\n，
     * 按「字符数 + 1」算偏移在 CRLF 文件上会每行少算一个字节，误差逐行累积。
     * 这里数的是实际消耗的字节数，LF 和 CRLF 都算得对。
     *
     * partial 标记末尾那一行：它后面没有换行符，可能是写到一半的行。
     * 采集器遇到解析失败的 partial 行时不推进 offset，等写完下次重读；
     * 完整落盘的坏行直接跳过，不卡住后面的行。
     */
    async *lines(path, fromOffset) {
      const stream = createReadStream(path, { start: fromOffset });
      let consumed = fromOffset;
      let pending: Buffer = Buffer.alloc(0);
      for await (const chunk of stream) {
        const buf = chunk as Buffer;
        pending = pending.length ? Buffer.concat([pending, buf]) : buf;
        let nl: number;
        while ((nl = pending.indexOf(0x0a)) !== -1) {
          // 行尾是 \r\n 的话，\r 不算行内容，但算消耗的字节。
          const body = pending[0] === 0x0d ? pending.subarray(1, nl) : pending.subarray(0, nl);
          consumed += nl + 1;
          pending = pending.subarray(nl + 1);
          yield { line: body.toString('utf8'), endOffset: consumed, partial: false };
        }
      }
      if (pending.length) {
        // 末尾的半行：可能是还没写完，也可能就是最后一行没有换行符。
        // 字节不完整（多字节字符被截断）时不交，避免解出半个字符。
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(pending);
        } catch {
          return;
        }
        consumed += pending.length;
        yield { line: pending.toString('utf8'), endOffset: consumed, partial: true };
      }
    },

    async *zstdLines(path) {
      const buf = await readFile(path);
      for (const line of zstdLines(buf)) yield { line };
    },

    log(level: LogLevel, source: string, message: string) {
      repo.log(batchId, Date.now(), level, source, message);
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
      const mark = (r: { parse: boolean; offset: number; reason: string }) => {
        seenPaths.add(path);
        return r;
      };
      // 读取时观察到的指纹。commitFile 提交这个值而不是提交时重新 stat 的值，
      // 否则文件在读取期间被追加，下一轮会误判「指纹未变」而跳过新追加的内容。
      preRead.set(path, { size: st.size, mtimeMs: Math.floor(st.mtimeMs), inode: st.ino });
      const cur = repo.getCursor(path);
      if (!cur) return mark({ parse: true, offset: 0, reason: '新文件' });

      // 解析规则变了，这个来源的文件全部重扫
      if (cur.source !== curSource) return mark({ parse: true, offset: 0, reason: '解析规则已更新' });

      // 指纹没变，整个文件跳过
      if (cur.size === st.size && cur.mtimeMs === Math.floor(st.mtimeMs) && cur.inode === st.ino) {
        return mark({ parse: false, offset: cur.offset, reason: '指纹未变' });
      }
      // 文件被重写或替换了，从头读
      if (st.size < cur.size || cur.inode !== st.ino) {
        return mark({ parse: true, offset: 0, reason: '文件被重写' });
      }
      // 大小没变但 mtime 变了：内容被原地改写，旧偏移已经失效，从头读。
      // 不加这条的话会落到下面「从上次偏移继续」，而那个偏移在文件末尾，读到 0 行。
      if (st.size === cur.size) {
        return mark({ parse: true, offset: 0, reason: '文件被原地改写' });
      }
      // 变大了：纯文本可以从上次偏移继续
      return mark({ parse: true, offset: cur.offset, reason: '文件变大' });
    },

    commitFile(path, offset, complete) {
      try {
        // 用读取时观察到的指纹，不是提交时的最新值
        const seen = preRead.get(path);
        const st = seen ?? { size: statSync(path).size, mtimeMs: Math.floor(statSync(path).mtimeMs), inode: statSync(path).ino };
        repo.setCursor({
          path,
          source: curSource,
          size: st.size,
          mtimeMs: st.mtimeMs,
          inode: st.inode,
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

    // 会话元信息要先读。scan 跑完会把文件游标推进到新位置，
    // 之后同一个文件再问 shouldParse 就是「指纹没变」，元信息会被整个跳过。
    if (collector.sessions) {
      const sessionRows: any[] = [];
      try {
        for await (const meta of collector.sessions(ctx)) {
          sessionRows.push(meta);
        }
      } catch (err) {
        repo.log(batchId, Date.now(), 'warn', collector.id, `会话信息读取失败：${(err as Error).message}`);
      }
      if (sessionRows.length) repo.upsertSessions(sessionRows.map(r => ({ ...r, device: device.id })));
    }

    const collected: any[] = [];
    try {
      for await (const ev of collector.scan(ctx)) {
        eventsRead++;
        const day = localDay(ev.ts);
        affectedDays.add(day);
        collected.push({
          eventId: ev.eventId,
          device: device.id,
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
          thinkingLevel: ev.thinkingLevel
        });
      }
    } catch (err) {
      errors++;
      repo.log(batchId, Date.now(), 'err', collector.id, `采集失败：${(err as Error).message}`);
    }

    if (collected.length) eventsWritten += repo.upsertEvents(collected);
  }

  // 「文件」这一列统计这一批看过多少文件，和有没有新事件无关。
  // 以前只在写出事件时才 +1，没新数据的批次永远显示 0。
  filesScanned = seenPaths.size;

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
