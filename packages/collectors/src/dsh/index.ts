// DeepSeek Harness 采集器。
// 数据在 ~/.dsh/sessions/<目录slug>/<会话id>/session*.jsonl.zstd。
//
// 一个会话目录里可能有多个版本文件（session.jsonl.zstd 是 v0，session.v2/v4 是后来的格式）。
// 新版本是旧版本的延续而不是叠加，所以只读编号最高的那个，避免重复计数。
//
// 口径：usage.inputTokens 不含缓存，cacheReadTokens / cacheWriteTokens 分开报。

import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Collector, ScanContext, SessionMeta } from '../types.ts';
import type { UsageEvent } from '../../../core/src/types.ts';

/** 从文件名取版本号：session.v4.jsonl.zstd → 4，session.jsonl.zstd → 0。 */
function versionOf(name: string): number {
  const m = name.match(/^session\.v(\d+)\.jsonl\.zstd$/);
  return m ? Number(m[1]) : 0;
}

export const dshCollector: Collector = {
  id: 'dsh',
  label: 'DeepSeek Harness',
  roots: () => [join(homedir(), '.dsh', 'sessions')],

  async *scan(ctx: ScanContext): AsyncGenerator<UsageEvent> {
    const all = await ctx.files(this.roots()[0], p => p.endsWith('.jsonl.zstd'));
    const bySession = new Map<string, { path: string; version: number }>();
    for (const path of all) {
      const dir = dirname(path);
      const sessionDir = basename(dir);
      const version = versionOf(basename(path));
      const prev = bySession.get(sessionDir);
      if (!prev || version > prev.version) bySession.set(sessionDir, { path, version });
    }

    let read = 0;
    let skipped = 0;

    for (const { path } of bySession.values()) {
      const st = ctx.shouldParse(path);
      if (!st.parse) { skipped++; continue; }

      let sessionId = '';
      let cwd = '';
      let prevCum = 0;

      for await (const { line } of ctx.zstdLines(path)) {
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

        if (rec.type !== 'assistant/message') continue;
        const u = rec.data?.usage;
        if (!u) continue;

        const input = u.inputTokens ?? 0;
        const output = u.outputTokens ?? 0;
        const cacheRead = u.cacheReadTokens ?? 0;
        const cacheWrite = u.cacheWriteTokens ?? 0;
        if (!input && !output && !cacheRead && !cacheWrite) continue;

        const source = rec.data?.message?.source ?? {};

        yield {
          eventId: `dsh:${sessionId}:${rec.seq ?? read}`,
          agent: 'dsh',
          sessionId,
          parentSessionId: null,
          isChild: false,
          ts: rec.time ?? Date.now(),
          cwd,
          model: source.model ?? '',
          provider: source.provider ?? null,
          buckets: {
            input,
            output,
            cacheRead,
            cacheWrite,
            reasoning: u.reasoningTokens ?? 0
          },
          thinkingLevel: null
        };
      }
      ctx.commitFile(path, 0, true);
    }

    ctx.log('info', 'dsh',
      `读取 ${bySession.size} 个会话文件（目录里共 ${all.length} 个版本文件，只取最高版本；跳过未变化 ${skipped} 个）· 解析 ${read} 行`);
  },

  async *sessions(ctx: ScanContext): AsyncGenerator<SessionMeta> {
    const all = await ctx.files(this.roots()[0], p => p.endsWith('.jsonl.zstd'));
    const bySession = new Map<string, { path: string; version: number }>();
    for (const path of all) {
      const dir = dirname(path);
      const sessionDir = basename(dir);
      const version = versionOf(basename(path));
      const prev = bySession.get(sessionDir);
      if (!prev || version > prev.version) bySession.set(sessionDir, { path, version });
    }

    for (const { path } of bySession.values()) {
      if (!ctx.shouldParse(path).parse) continue;
      let sessionId = '';
      let cwd = '';
      let title: string | null = null;
      let firstTs: number | null = null;
      let lastTs: number | null = null;

      for await (const { line } of ctx.zstdLines(path)) {
        let rec: any;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec.type === 'session') {
          sessionId = rec.id ?? sessionId;
          cwd = rec.cwd ?? cwd;
          if (rec.createdAt && firstTs === null) firstTs = rec.createdAt;
        } else if (rec.type === 'session/title') {
          title = rec.data?.title ?? title;
        }
        const ts = rec.time ?? null;
        if (ts) {
          if (firstTs === null || ts < firstTs) firstTs = ts;
          if (lastTs === null || ts > lastTs) lastTs = ts;
        }
      }
      if (!sessionId) continue;
      yield { agent: 'dsh', sessionId, title, cwd: cwd || null, firstTs, lastTs };
    }
  }
};
