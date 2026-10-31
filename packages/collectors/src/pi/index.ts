// pi 采集器。
// 数据在 ~/.pi/agent/sessions/<目录slug>/<时间戳>_<会话uuid>.jsonl。
//
// 口径：usage.input 不含缓存，cacheRead / cacheWrite 分开报。
// pi 的记录自带成本（usage.cost.total），直接采信，标 reported。

import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Collector, ScanContext, SessionMeta } from '../types.ts';
import type { UsageEvent } from '../../../core/src/types.ts';

/**
 * 读会话头。cwd 和会话 id 只写在文件第一行的 session 记录里，
 * 文件变大时从上次偏移接着读是读不到这一行的，所以每次解析前单独读一次。
 */
async function readHeader(ctx: ScanContext, path: string): Promise<{ sessionId: string; cwd: string }> {
  for await (const { line } of ctx.lines(path, 0)) {
    let rec: any;
    try { rec = JSON.parse(line); } catch { rec = null; }
    if (rec?.type === 'session') {
      return { sessionId: rec.id ?? '', cwd: rec.cwd ?? '' };
    }
    break; // 头就在第一行
  }
  return { sessionId: '', cwd: '' };
}

export const piCollector: Collector = {
  id: 'pi',
  label: 'pi',
  // v2：续读时补读会话头，并配合写入端允许重写 session_id，历史空目录一次补齐。
  version: '2',
  roots: () => [join(homedir(), '.pi', 'agent', 'sessions')],

  async *scan(ctx: ScanContext): AsyncGenerator<UsageEvent> {
    const root = this.roots()[0];
    const files = await ctx.files(root, p => p.endsWith('.jsonl'));
    let read = 0;
    let priced = 0;
    let skipped = 0;

    for (const path of files) {
      const st = ctx.shouldParse(path);
      if (!st.parse) { skipped++; continue; }

      const header = await readHeader(ctx, path);
      let sessionId = header.sessionId;
      let cwd = header.cwd;
      let offset = st.offset;

      for await (const { line, endOffset } of ctx.lines(path, st.offset)) {
        offset = endOffset;
        let rec: any;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        read++;

        if (rec.type === 'session') {
          sessionId = rec.id ?? sessionId;
          cwd = rec.cwd ?? cwd;
          continue;
        }

        if (rec.type !== 'message') continue;
        const msg = rec.message ?? {};
        if (msg.role !== 'assistant') continue;
        const u = msg.usage;
        if (!u) continue;

        const input = u.input ?? 0;
        const output = u.output ?? 0;
        const cacheRead = u.cacheRead ?? 0;
        const cacheWrite = u.cacheWrite ?? 0;
        if (!input && !output && !cacheRead && !cacheWrite) continue;

        const cost = typeof u.cost?.total === 'number' ? u.cost.total : null;
        if (cost !== null) priced++;

        yield {
          eventId: `pi:${rec.id ?? `${sessionId}:${read}`}`,
          agent: 'pi',
          sessionId,
          parentSessionId: null,
          isChild: false,
          ts: Date.parse(rec.timestamp ?? msg.timestamp ?? '') || Date.now(),
          cwd,
          model: msg.model ?? '',
          provider: msg.provider ?? null,
          buckets: {
            input,
            output,
            cacheRead,
            cacheWrite,
            // pi 的 reasoning 是 output 的子集
            reasoning: u.reasoning ?? 0
          },
          reportedCostUsd: cost,
          thinkingLevel: msg.thinkingLevel ?? null
        };
      }
      ctx.commitFile(path, offset, true);
    }

    ctx.log('info', 'pi',
      `读取 ${files.length} 个 jsonl（跳过未变化 ${skipped} 个）· 解析 ${read} 行 · 其中 ${priced} 条自带成本`);
  },

  async *sessions(ctx: ScanContext): AsyncGenerator<SessionMeta> {
    const root = this.roots()[0];
    const files = await ctx.files(root, p => p.endsWith('.jsonl'));
    for (const path of files) {
      if (!ctx.shouldParse(path).parse) continue;
      let sessionId = '';
      let cwd = '';
      let title: string | null = null;
      let firstTs: number | null = null;
      let lastTs: number | null = null;

      for await (const { line } of ctx.lines(path, 0)) {
        let rec: any;
        try { rec = JSON.parse(line); } catch { continue; }
        const ts = Date.parse(rec.timestamp ?? '') || null;
        if (ts) {
          if (firstTs === null || ts < firstTs) firstTs = ts;
          if (lastTs === null || ts > lastTs) lastTs = ts;
        }
        if (rec.type === 'session') {
          sessionId = rec.id ?? sessionId;
          cwd = rec.cwd ?? cwd;
        } else if (rec.type === 'session_info') {
          title = rec.name ?? title;
        }
      }
      if (!sessionId) continue;
      yield { agent: 'pi', sessionId, title, cwd: cwd || null, firstTs, lastTs };
    }
  }
};
