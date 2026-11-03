// pi 采集器。
// 数据在 ~/.pi/agent/sessions/<目录slug>/<时间戳>_<会话uuid>.jsonl。
//
// 口径：usage.input 不含缓存，cacheRead / cacheWrite 分开报。

import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Collector, ScanContext, SessionMeta } from '../types.ts';
import type { UsageEvent } from '../../../core/src/types.ts';
import { parseRecord, parseTimestamp } from '../parse.ts';
import { eventId } from '../../../core/src/types.ts';

/**
 * 读会话头。cwd 和会话 id 只写在文件第一行的 session 记录里，
 * 文件变大时从上次偏移接着读是读不到这一行的，所以每次解析前单独读一次。
 */
async function readHeader(ctx: ScanContext, path: string): Promise<{ sessionId: string; cwd: string }> {
  for await (const { line } of ctx.lines(path, 0)) {
    const rec = parseRecord(line);
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
  // v3：厂商改成信任自报的 provider（不再按模型名覆盖），历史行重扫一遍补上。
  version: '3',
  roots: () => [join(homedir(), '.pi', 'agent', 'sessions')],

  async *scan(ctx: ScanContext): AsyncGenerator<UsageEvent> {
    const root = this.roots()[0];
    const files = await ctx.files(root, p => p.endsWith('.jsonl'));
    let read = 0;
    let skipped = 0;

    for (const path of files) {
      const st = ctx.shouldParse(path);
      if (!st.parse) { skipped++; continue; }

      const header = await readHeader(ctx, path);
      let sessionId = header.sessionId;
      let cwd = header.cwd;
      let offset = st.offset;

      for await (const { line, endOffset, partial } of ctx.lines(path, st.offset)) {
        const rec = parseRecord(line);
        if (!rec) {
          // 完整落盘的坏行直接跳过，不卡住后面的行；
          // 末尾写到一半的行不推进 offset，等写完下次重读。
          if (!partial) offset = endOffset;
          continue;
        }
        offset = endOffset;
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

        // 时间解析不出来就跳过这条，不兜底成「现在」——
        // 兜底会把历史用量记到扫描那一天。
        const ts = parseTimestamp(rec.timestamp ?? msg.timestamp);
        if (ts === null) {
          ctx.log('warn', 'pi', `一条记录的时间无法解析，已跳过（会话 ${sessionId}）`);
          continue;
        }

        // 没有稳定 id 就跳过这条。库里 event_id 是主键，靠它去重；
        // 用扫描序号兜底的话，断点续扫之后同一个事件会拿到不同的 id，
        // 库里就会多出一份，token 直接翻倍。
        if (!rec.id) {
          ctx.log('warn', 'pi', `一条记录没有 id，已跳过（会话 ${sessionId}）`);
          continue;
        }

        yield {
          eventId: eventId('pi', rec.id),
          agent: 'pi',
          sessionId,
          parentSessionId: null,
          isChild: false,
          ts,
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
          thinkingLevel: msg.thinkingLevel ?? null
        };
      }
      ctx.commitFile(path, offset, true);
    }

    ctx.log('info', 'pi',
      `读取 ${files.length} 个 jsonl（跳过未变化 ${skipped} 个）· 解析 ${read} 行`);
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
        const rec = parseRecord(line);
        if (!rec) continue;
        const ts = parseTimestamp(rec.timestamp);
        if (ts !== null) {
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
