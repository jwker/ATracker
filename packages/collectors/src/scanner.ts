// 采集编排：把采集器产出的事件算价、落库、维护聚合。

import { readdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';

import type { DeviceInfo } from '../../core/src/device.ts';
import type { Collector, ScanContext, LogLevel, SessionMeta } from './types.ts';
import type { UsageEvent } from '../../core/src/types.ts';
import type { StoredEvent } from '../../storage/src/repo.ts';
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
  /**
   * 中止信号。服务层扫描超时时会 abort：
   * 已经在读的文件会在下一个检查点退出，不再继续走完整棵树。
   */
  signal?: AbortSignal;
  /**
   * 进度回调。扫描卡住时，服务层靠它才知道卡在哪——
   * 光看「扫描超过了 120 秒」没法查，得知道是在哪个来源、哪个文件上。
   */
  onProgress?: (progress: ScanProgress) => void;
  /** 批次一开始就回调批号。服务层超时后用它把这一批标成中断。 */
  onBatch?: (batchId: number) => void;
}

/** 扫描进度。字段给日志和状态接口用，不改任何行为。 */
export interface ScanProgress {
  /** `来源:阶段`，阶段是 sessions 或 scan（用量） */
  phase: string;
  /** 正在处理的文件。目录遍历和收尾阶段为空 */
  path: string;
  /** 这一轮已经看过的文件数 */
  files: number;
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
  const signal = opts.signal ?? new AbortController().signal;
  const aborted = (): boolean => signal.aborted;
  repo.touchDevice(device);

  const collectors = COLLECTORS.filter(c => !opts.only || opts.only.includes(c.id));
  const batchId = repo.startBatch(opts.trigger, Date.now());
  try { opts.onBatch?.(batchId); } catch { /* 观察用的回调，不能影响扫描 */ }
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
  /**
   * 同一批次内复用目录枚举结果。
   *
   * 每个采集器的 sessions() 和 scan() 都要列一次目录，而 ~/.pi/agent/sessions 底下有
   * 近六千个子目录，两轮下来就是每轮多几百毫秒的纯遍历。一次扫描里树几乎不会变，
   * 缓存到本轮结束为止；这一轮看不到的新文件，下一轮补。
   */
  const walkCache = new Map<string, Promise<string[]>>();

  /** 当前阶段和文件。只在变化时报一次，不打热循环。 */
  let phase = '启动';
  let currentPath = '';
  const report = (): void => {
    if (!opts.onProgress) return;
    try {
      opts.onProgress({ phase, path: currentPath, files: seenPaths.size });
    } catch {
      // 进度回调是观察用的，不能因为它把扫描搞挂
    }
  };
  const setPhase = (next: string): void => {
    phase = next;
    currentPath = '';
    report();
  };
  let eventsRead = 0;
  let eventsWritten = 0;
  let errors = 0;
  /** 目录枚举失败的个数。 */
  let dirErrors = 0;

  const ctx: ScanContext = {
    signal,

    async files(root, filter) {
      let walked = walkCache.get(root);
      if (!walked) {
        walked = (async (): Promise<string[]> => {
          const out: string[] = [];
          async function walk(dir: string) {
            if (aborted()) throw new Error('扫描已中止');
            let entries;
            try {
              entries = await readdir(dir, { withFileTypes: true });
            } catch (err) {
              // 目录读不到（权限、正在被删、软链接断了）不能当成「这里没有文件」。
              // 静默吞掉的话，缺数据很难排查。
              repo.log(batchId, Date.now(), 'warn', curSource, `目录读不到：${dir}（${(err as Error).message}）`);
              dirErrors++;
              return;
            }
            for (const e of entries) {
              const p = join(dir, e.name);
              if (e.isDirectory()) await walk(p);
              else if (e.isFile()) out.push(p);
            }
          }
          await walk(root);
          return out;
        })();
        walkCache.set(root, walked);
      }
      const all = await walked;
      const out = filter ? all.filter(p => filter(p)) : all.slice();
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
      currentPath = path;
      report();
      const stream = createReadStream(path, { start: fromOffset });
      try {
        let consumed = fromOffset;
        let pending: Buffer = Buffer.alloc(0);
        for await (const chunk of stream) {
          if (aborted()) throw new Error('扫描已中止');
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
      } finally {
        // 中止时也要把文件句柄放掉，不能等 GC
        stream.destroy();
      }
    },

    async *zstdLines(path) {
      currentPath = path;
      report();
      const buf = await readFile(path);
      for (const line of zstdLines(buf)) {
        if (aborted()) throw new Error('扫描已中止');
        yield { line };
      }
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
      currentPath = path;
      report();
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
    },

    meta(path) {
      const c = repo.getMetaCursor(path);
      if (!c) return null;
      return {
        offset: c.offset,
        sessionId: c.sessionId,
        cwd: c.cwd,
        title: c.title,
        firstTs: c.firstTs,
        lastTs: c.lastTs
      };
    },

    commitMeta(path, patch) {
      try {
        const seen = preRead.get(path);
        const st = seen ?? { size: statSync(path).size, mtimeMs: Math.floor(statSync(path).mtimeMs), inode: statSync(path).ino };
        repo.setMetaCursor({
          path,
          source: curSource,
          size: st.size,
          mtimeMs: st.mtimeMs,
          inode: st.inode,
          offset: patch.offset,
          sessionId: patch.sessionId,
          cwd: patch.cwd,
          title: patch.title,
          firstTs: patch.firstTs,
          lastTs: patch.lastTs
        });
      } catch {
        // 文件没了就不记
      }
    }
  };

  let abortedError: string | null = null;
  try {
    for (const collector of collectors) {
      if (aborted()) throw new Error('扫描已中止');
      curSource = collector.version ? `${collector.id}:${collector.version}` : collector.id;
      setPhase(`${collector.id}:sessions`);

      // 会话元信息要先读。scan 跑完会把文件游标推进到新位置，
      // 之后同一个文件再问 shouldParse 就是「指纹没变」，元信息会被整个跳过。
      if (collector.sessions) {
        const sessionRows: SessionMeta[] = [];
        try {
          for await (const meta of collector.sessions(ctx)) {
            sessionRows.push(meta);
          }
        } catch (err) {
          // 中止不是「采集失败」：已经采到的部分要保住，交给下面统一收尾
          if (aborted()) throw err;
          // 这条路的元信息是缺的，要计入错误数，否则批次摘要显示「全部成功」，
          // 实际有一路的会话标题没拿到。
          errors++;
          repo.log(batchId, Date.now(), 'warn', collector.id, `会话信息读取失败：${(err as Error).message}`);
        }
        if (sessionRows.length) repo.upsertSessions(sessionRows.map(r => ({ ...r, device: device.id })));
      }

      if (aborted()) throw new Error('扫描已中止');
      setPhase(`${collector.id}:scan`);
      const collected: StoredEvent[] = [];
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
        if (aborted()) throw err;
        errors++;
        repo.log(batchId, Date.now(), 'err', collector.id, `采集失败：${(err as Error).message}`);
      }

      if (collected.length) eventsWritten += repo.upsertEvents(collected);
    }
  } catch (err) {
    // 只有中止会走到这里：采集器自己的错误已经在上面吞掉了。
    // 不直接往外抛，先让批次和聚合正常收尾，保持库里的账对得上。
    if (!aborted()) throw err;
    abortedError = (err as Error).message;
    errors++;
    repo.log(batchId, Date.now(), 'warn', curSource, `扫描中止：${abortedError}`);
  }

  setPhase('收尾');

  // 「文件」这一列统计这一批看过多少文件，和有没有新事件无关。
  // 以前只在写出事件时才 +1，没新数据的批次永远显示 0。
  filesScanned = seenPaths.size;
  errors += dirErrors;

  // 收尾的几步放进 try/finally：任何一处抛错都要保证 finishBatch 被调用，
  // 否则 scan_batch 里会留下一条永远「在跑」的批次。
  try {
    // 没有变化就不重算聚合，也不重新分配目录颜色。
    //
    // 颜色那段以前是「没变化也跑一遍」：dirsOf() 不给日期就是全表
    // SELECT DISTINCT cwd（每轮一次全表扫 + 临时 B 树）。目录只会随新事件出现，
    // 有变化的那一轮补色就够了。
    if (affectedDays.size) {
      repo.rebuildAggregates([...affectedDays]);
      const paths = repo.dirsOf([...affectedDays]);
      const assigned = assignColors(repo.dirColors(), paths);
      repo.setDirColors(assigned);
    }
  } catch (err) {
    errors++;
    repo.log(batchId, Date.now(), 'err', curSource, `收尾失败：${(err as Error).message}`);
  } finally {
    repo.finishBatch(batchId, {
      finishedAt: Date.now(),
      filesTotal: filesScanned,
      filesScanned,
      eventsRead,
      eventsWritten,
      errors
    });
  }

  // 批次已经正常收尾，这时才把中止当作错误报给调用方：
  // scan_batch 里不会留下永远「在跑」的批次。
  if (abortedError) throw new Error(abortedError);

  return { batchId, filesScanned, eventsRead, eventsWritten, errors, days: [...affectedDays] };
}
