// codex 采集器。
// 数据在 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.zst，zstd 压缩的 JSONL。
//
// 关键口径：每轮的用量不能用 last_token_usage，要用 total_token_usage 的增量。
// 原因：一轮里可能有多次 API 调用（工具调用循环），last_token_usage 只记最后一次，
// 而累计值的增量才是这一轮的真实总量。实测一个会话里两者相差 4 万 token。
// 用增量算，合计正好等于 state_5.sqlite 里 threads.tokens_used。

import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { Collector, ScanContext, SessionMeta } from '../types.ts';
import type { UsageEvent } from '../../../core/src/types.ts';

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export const codexCollector: Collector = {
  id: 'codex',
  label: 'Codex',
  roots: () => [join(homedir(), '.codex', 'sessions')],

  async *scan(ctx: ScanContext): AsyncGenerator<UsageEvent> {
    const root = this.roots()[0];
    const files = await ctx.files(root, p => p.endsWith('.jsonl.zst') || p.endsWith('.jsonl'));
    let read = 0;

    let skipped = 0;
    for (const path of files) {
      const st = ctx.shouldParse(path);
      if (!st.parse) { skipped++; continue; }
      let sessionId = '';
      let cwd = '';
      let provider: string | null = null;
      let model = '';
      let ts = 0;
      let ordinal = 0;

      for await (const { line } of ctx.zstdLines(path)) {
        let rec: any;
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // 坏行跳过，不影响整批
        }
        read++;

        if (rec.type === 'session_meta') {
          sessionId = rec.payload?.session_id ?? '';
          cwd = rec.payload?.cwd ?? '';
          provider = rec.payload?.model_provider ?? null;
          continue;
        }

        if (rec.type === 'turn_context') {
          model = rec.payload?.model ?? model;
          cwd = rec.payload?.cwd ?? cwd;
          continue;
        }

        if (rec.type !== 'event_msg' || rec.payload?.type !== 'token_count') continue;

        const info = rec.payload.info ?? {};
        const cum: CodexUsage = info.total_token_usage ?? {};
        const state = ctx.sessionState(sessionId) ?? new Map<string, number>();
        const prev = state.get('cum') ?? 0;

        // 累计值可能因为换上下文而重置，这时把当前累计当作增量。
        const cumTotal = cum.total_tokens ?? 0;
        const deltaTotal = cumTotal >= prev ? cumTotal - prev : cumTotal;
        state.set('cum', cumTotal);
        ctx.setSessionState(sessionId, state);

        if (deltaTotal <= 0) continue;

        const scale = (v: number | undefined) =>
          cumTotal > 0 ? Math.round(((v ?? 0) / cumTotal) * deltaTotal) : 0;

        const input = scale(cum.input_tokens);
        const cached = scale(cum.cached_input_tokens);
        const cacheWrite = scale(cum.cache_write_input_tokens);
        const output = scale(cum.output_tokens);
        const reasoning = scale(cum.reasoning_output_tokens);

        ts = Date.parse(rec.timestamp ?? '');
        ordinal = rec.ordinal ?? ordinal + 1;

        yield {
          eventId: `codex:${sessionId}:${ordinal}`,
          agent: 'codex',
          sessionId,
          parentSessionId: null,
          isChild: false,
          ts: ts || Date.now(),
          cwd,
          model,
          provider,
          // codex 的 input_tokens 含缓存，要减掉才是未缓存输入
          buckets: {
            input: Math.max(0, input - cached),
            output,
            cacheRead: cached,
            cacheWrite,
            reasoning
          },
          reportedCostUsd: null,
          thinkingLevel: null
        };
      }
      ctx.commitFile(path, 0, true);
    }

    ctx.log('info', 'codex', `读取 ${files.length} 个 rollout（跳过未变化 ${skipped} 个）· 解析 ${read} 行`);
  },

  async *sessions(ctx: ScanContext): AsyncGenerator<SessionMeta> {
    // 会话标题在 state_5.sqlite 的 threads 表里，rollout 文件里没有
    const dbPath = join(homedir(), '.codex', 'state_5.sqlite');
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      return;
    }
    try {
      const rows = db.prepare('SELECT id, title, cwd, created_at, updated_at FROM threads').all() as any[];
      for (const r of rows) {
        yield {
          agent: 'codex',
          sessionId: r.id,
          title: r.title ?? null,
          cwd: r.cwd ?? null,
          firstTs: r.created_at ?? null,
          lastTs: r.updated_at ?? null
        };
      }
    } finally {
      db.close();
    }
  }
};
