// opencode 采集器。
// 数据在 ~/.local/share/opencode/opencode.db 的 message 表，data 列是 JSON。
// 数据库用只读方式打开，不写不锁。
//
// 口径：tokens.input 不含缓存，cache.read / cache.write 分开报。
// 记录自带 cost，直接采信，标 reported。

import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { Collector, ScanContext, SessionMeta } from '../types.ts';
import type { UsageEvent } from '../../../core/src/types.ts';

export const opencodeCollector: Collector = {
  id: 'opencode',
  label: 'opencode',
  roots: () => [join(homedir(), '.local', 'share', 'opencode', 'opencode.db')],

  async *scan(ctx: ScanContext): AsyncGenerator<UsageEvent> {
    const file = this.roots()[0];
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file, { readOnly: true });
    } catch (err) {
      ctx.log('err', 'opencode', `打开数据库失败：${(err as Error).message}`);
      return;
    }

    try {
      const st = ctx.shouldParse(file);
      if (!st.parse) {
        ctx.log('info', 'opencode', '数据库指纹未变，跳过');
        return;
      }
      const rows = db.prepare('SELECT id, session_id, data FROM message ORDER BY time_created ASC').all() as any[];
      let read = 0;
      let priced = 0;

      for (const row of rows) {
        let rec: any;
        try {
          rec = JSON.parse(row.data);
        } catch {
          continue;
        }
        read++;
        if (rec.role !== 'assistant') continue;

        const t = rec.tokens ?? {};
        const input = t.input ?? 0;
        const output = t.output ?? 0;
        const cacheRead = t.cache?.read ?? 0;
        const cacheWrite = t.cache?.write ?? 0;
        if (!input && !output && !cacheRead && !cacheWrite) continue;

        const cost = typeof rec.cost === 'number' ? rec.cost : null;
        if (cost !== null) priced++;

        yield {
          eventId: `opencode:${row.id}`,
          agent: 'opencode',
          sessionId: row.session_id ?? '',
          parentSessionId: null,
          isChild: false,
          ts: rec.time?.created ?? Date.now(),
          cwd: rec.path?.cwd ?? '',
          model: rec.modelID ?? '',
          provider: rec.providerID ?? null,
          buckets: {
            input,
            output,
            cacheRead,
            cacheWrite,
            reasoning: t.reasoning ?? 0
          },
          reportedCostUsd: cost,
          thinkingLevel: null
        };
      }

      ctx.commitFile(file, 0, true);
      ctx.log('info', 'opencode', `读取 ${rows.length} 条消息 · 其中 ${priced} 条自带成本`);
    } finally {
      db.close();
    }
  },

  async *sessions(ctx: ScanContext): AsyncGenerator<SessionMeta> {
    const file = this.roots()[0];
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file, { readOnly: true });
    } catch {
      return;
    }
    try {
      const rows = db.prepare(
        'SELECT id, directory, title, time_created, time_updated FROM session ORDER BY time_updated DESC'
      ).all() as any[];
      for (const r of rows) {
        yield {
          agent: 'opencode',
          sessionId: r.id,
          title: r.title ?? null,
          cwd: r.directory ?? null,
          firstTs: r.time_created ?? null,
          lastTs: r.time_updated ?? null
        };
      }
    } finally {
      db.close();
    }
  }
};
