// Claude Code 采集器。
// 主会话在 ~/.claude/projects/<项目slug>/<会话uuid>.jsonl，
// 子 agent 在 ~/.claude/projects/<项目slug>/<父会话uuid>/subagents/agent-<agentId>.jsonl。
//
// 口径：usage.input_tokens 不含缓存（Anthropic 口径），缓存命中和写入分别报。
// 子 agent 的行带 isSidechain=true，行里的 sessionId 就是父会话。
//
// 去重：同一条 assistant 消息会按内容块写成多行（apiBlockIndex 不同、uuid 也不同），
// 但每行带的是同一份 usage，直接累加会翻倍。message.id 才是消息的唯一标识。

import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Collector, ScanContext, SessionMeta } from '../types.ts';
import type { UsageEvent } from '../../../core/src/types.ts';

export const claudeCodeCollector: Collector = {
  id: 'claude-code',
  label: 'Claude Code',
  roots: () => [join(homedir(), '.claude', 'projects')],

  async *scan(ctx: ScanContext): AsyncGenerator<UsageEvent> {
    const root = this.roots()[0];
    const files = await ctx.files(root, p => p.endsWith('.jsonl'));
    let read = 0;
    let childFiles = 0;
    let skipped = 0;
    const seen = new Set<string>();

    for (const path of files) {
      const isSub = path.includes('/subagents/');
      const st = ctx.shouldParse(path);
      if (!st.parse) { skipped++; continue; }
      if (isSub) childFiles++;

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
        if (rec.type !== 'assistant') continue;

        const msg = rec.message ?? {};
        const u = msg.usage;
        if (!u) continue;
        const input = u.input_tokens ?? 0;
        const output = u.output_tokens ?? 0;
        const cacheRead = u.cache_read_input_tokens ?? 0;
        const cacheWrite = u.cache_creation_input_tokens ?? 0;
        if (!input && !output && !cacheRead && !cacheWrite) continue;

        const sessionId = rec.sessionId ?? rec.session_id ?? '';
        const isChild = rec.isSidechain === true || isSub;

        // 同一条消息的多行只算一次
        const messageId = msg.id ?? rec.uuid ?? `${sessionId}:${read}`;
        const key = `${sessionId}:${messageId}`;
        if (seen.has(key)) continue;
        seen.add(key);

        yield {
          eventId: `claude-code:${key}`,
          agent: 'claude-code',
          sessionId,
          parentSessionId: isChild ? sessionId : null,
          isChild,
          ts: Date.parse(rec.timestamp ?? '') || Date.now(),
          cwd: rec.cwd ?? '',
          model: msg.model ?? '',
          provider: null, // 由 catalog 按模型名推断
          buckets: {
            input,
            output,
            cacheRead,
            cacheWrite,
            reasoning: u.output_tokens_details?.thinking_tokens ?? 0
          },
          thinkingLevel: null
        };
      }
      ctx.commitFile(path, offset, true);
    }

    ctx.log('info', 'claude-code',
      `读取 ${files.length} 个 jsonl（子 agent ${childFiles} 个，跳过未变化 ${skipped} 个）· 解析 ${read} 行`);
  },

  async *sessions(ctx: ScanContext): AsyncGenerator<SessionMeta> {
    const root = this.roots()[0];
    const files = await ctx.files(root, p => p.endsWith('.jsonl'));
    for (const path of files) {
      // 元信息要整读（要拿到会话头），但没变化的文件直接跳过
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
        if (rec.type === 'ai-title') {
          title = rec.aiTitle ?? title;
          sessionId = rec.sessionId ?? sessionId;
        }
        if (rec.cwd) cwd = rec.cwd;
        if (rec.sessionId) sessionId = rec.sessionId;
      }
      if (!sessionId) continue;
      yield { agent: 'claude-code', sessionId, title, cwd: cwd || null, firstTs, lastTs };
    }
  }
};
