// opencode 采集器。
// 数据在 ~/.local/share/opencode/opencode.db。
// 数据库用只读方式打开，不写不锁。
//
// opencode 有两代存储格式，同一个库里都有：
//   旧格式：session / message 表
//   新格式（2.x，桌面端在用）：session_v2 / session_message 表
// 新格式是旧格式迁移过来的，同一批会话在两张表里各存一份
// （实测 session_0de322576f 在两边的 tokens_input 都是 24481）。
// 所以只要 session_v2 有数据就只读新表，两张都读会重复计算。
//
// 口径：tokens.input 不含缓存，cache.read / cache.write 分开报。
// 记录自带 cost，直接采信，标 reported。

import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { Collector, ScanContext, SessionMeta } from '../types.ts';
import type { UsageEvent } from '../../../core/src/types.ts';

interface OpencodeSession {
  id: string;
  directory: string;
  title: string | null;
  agent: string | null;
  model: { id?: string; providerID?: string } | null;
  cost: number;
  timeCreated: number;
  timeUpdated: number;
  /** 会话级汇总的四个桶，用来补压缩掉的旧消息 */
  buckets: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** 新表优先：库里有 session_v2 且有数据就用它。 */
function useV2(db: DatabaseSync): boolean {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_v2'").get();
  if (!t) return false;
  const n = db.prepare('SELECT COUNT(*) n FROM session_v2').get() as any;
  return n.n > 0;
}

function readSessionsV2(db: DatabaseSync): Map<string, OpencodeSession> {
  const rows = db.prepare(
    `SELECT id, directory, title, agent, model, cost, time_created, time_updated,
            tokens_input, tokens_output, tokens_cache_read, tokens_cache_write
     FROM session_v2`
  ).all() as any[];
  const map = new Map<string, OpencodeSession>();
  for (const r of rows) {
    let model: any = null;
    try { model = r.model ? JSON.parse(r.model) : null; } catch { model = null; }
    map.set(r.id, {
      id: r.id,
      directory: r.directory ?? '',
      title: r.title ?? null,
      agent: r.agent ?? null,
      model,
      cost: r.cost ?? 0,
      timeCreated: r.time_created ?? 0,
      timeUpdated: r.time_updated ?? 0,
      buckets: {
        input: r.tokens_input ?? 0,
        output: r.tokens_output ?? 0,
        cacheRead: r.tokens_cache_read ?? 0,
        cacheWrite: r.tokens_cache_write ?? 0
      }
    });
  }
  return map;
}

function readSessionsLegacy(db: DatabaseSync): Map<string, OpencodeSession> {
  const rows = db.prepare(
    `SELECT id, directory, title, agent, model, cost, time_created, time_updated,
            tokens_input, tokens_output, tokens_cache_read, tokens_cache_write
     FROM session`
  ).all() as any[];
  const map = new Map<string, OpencodeSession>();
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      directory: r.directory ?? '',
      title: r.title ?? null,
      agent: r.agent ?? null,
      model: r.model ? { id: r.model } : null,
      cost: r.cost ?? 0,
      timeCreated: r.time_created ?? 0,
      timeUpdated: r.time_updated ?? 0,
      buckets: {
        input: r.tokens_input ?? 0,
        output: r.tokens_output ?? 0,
        cacheRead: r.tokens_cache_read ?? 0,
        cacheWrite: r.tokens_cache_write ?? 0
      }
    });
  }
  return map;
}

export const opencodeCollector: Collector = {
  id: 'opencode',
  label: 'opencode',
  // v2：改读 session_v2 / session_message 新表（旧表是迁移前的副本）
  // v3：压缩掉的旧消息按会话汇总补差
  version: 'v4',
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

      const v2 = useV2(db);
      const sessions = v2 ? readSessionsV2(db) : readSessionsLegacy(db);
      ctx.log('info', 'opencode', `存储格式：${v2 ? 'session_v2 / session_message' : 'session / message（旧格式）'}，${sessions.size} 个会话`);

      let read = 0;
      let priced = 0;
      // 按会话累积，最后和会话级汇总对账
      const perSession = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }>();

      if (v2) {
        const rows = db.prepare(
          "SELECT id, session_id, data FROM session_message WHERE type = 'assistant' ORDER BY time_created ASC"
        ).all() as any[];

        for (const row of rows) {
          let rec: any;
          try {
            rec = JSON.parse(row.data);
          } catch {
            continue;
          }
          read++;

          const t = rec.tokens ?? {};
          const input = t.input ?? 0;
          const output = t.output ?? 0;
          const cacheRead = t.cache?.read ?? 0;
          const cacheWrite = t.cache?.write ?? 0;
          if (!input && !output && !cacheRead && !cacheWrite) continue;

          const session = sessions.get(row.session_id);
          const cost = typeof rec.cost === 'number' ? rec.cost : null;
          if (cost !== null) priced++;

          const acc = perSession.get(row.session_id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
          acc.input += input; acc.output += output; acc.cacheRead += cacheRead; acc.cacheWrite += cacheWrite;
          acc.cost += cost ?? 0;
          perSession.set(row.session_id, acc);

          yield {
            eventId: `opencode:${row.id}`,
            agent: 'opencode',
            sessionId: row.session_id,
            parentSessionId: session && session.id !== row.session_id ? session.id : null,
            isChild: false,
            ts: rec.time?.created ?? rec.timeCreated ?? Date.now(),
            cwd: session?.directory ?? '',
            model: rec.model?.id ?? session?.model?.id ?? '',
            provider: rec.model?.providerID ?? session?.model?.providerID ?? null,
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
      } else {
        const rows = db.prepare('SELECT id, session_id, data FROM message ORDER BY time_created ASC').all() as any[];
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

          const session = sessions.get(row.session_id);
          const cost = typeof rec.cost === 'number' ? rec.cost : null;
          if (cost !== null) priced++;

          const acc = perSession.get(row.session_id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
          acc.input += input; acc.output += output; acc.cacheRead += cacheRead; acc.cacheWrite += cacheWrite;
          acc.cost += cost ?? 0;
          perSession.set(row.session_id, acc);

          yield {
            eventId: `opencode:${row.id}`,
            agent: 'opencode',
            sessionId: row.session_id,
            parentSessionId: null,
            isChild: false,
            ts: rec.time?.created ?? Date.now(),
            cwd: rec.path?.cwd ?? session?.directory ?? '',
            model: rec.modelID ?? session?.model?.id ?? '',
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
      }

      // 压缩掉的旧消息不在消息表里，只在会话汇总里。
      // 总量以来源自己的口径为准，差出来的量补成一条事件，
      // 桶的拆分用会话汇总列减消息累计，模型取会话的模型。
      let gaps = 0;
      for (const [sid, acc] of perSession) {
        const session = sessions.get(sid);
        if (!session) continue;
        const dIn = session.buckets.input - acc.input;
        const dOut = session.buckets.output - acc.output;
        const dCr = session.buckets.cacheRead - acc.cacheRead;
        const dCw = session.buckets.cacheWrite - acc.cacheWrite;
        if (dIn <= 0 && dOut <= 0 && dCr <= 0 && dCw <= 0) continue;
        gaps++;
        const dCost = Math.max(0, session.cost - acc.cost);
        yield {
          eventId: `opencode:gap:${sid}`,
          agent: 'opencode',
          sessionId: sid,
          parentSessionId: null,
          isChild: false,
          ts: session.timeUpdated || session.timeCreated || Date.now(),
          cwd: session.directory,
          model: session.model?.id ?? '',
          provider: session.model?.providerID ?? null,
          buckets: {
            input: Math.max(0, dIn),
            output: Math.max(0, dOut),
            cacheRead: Math.max(0, dCr),
            cacheWrite: Math.max(0, dCw),
            reasoning: 0
          },
          // 差额的成本也按来源的口径：来源说 0 就是 0（免费模型），
          // null 才是「不知道」，两者不能混
          reportedCostUsd: dCost,
          thinkingLevel: null
        };
      }

      ctx.commitFile(file, 0, true);
      ctx.log('info', 'opencode',
        `读取 ${read} 条 assistant 消息 · 其中 ${priced} 条自带成本 · 压缩补差 ${gaps} 个会话`);
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
      const v2 = useV2(db);
      const sessions = v2 ? readSessionsV2(db) : readSessionsLegacy(db);
      for (const s of sessions.values()) {
        yield {
          agent: 'opencode',
          sessionId: s.id,
          title: s.title,
          cwd: s.directory || null,
          firstTs: s.timeCreated || null,
          lastTs: s.timeCreated || null
        };
      }
    } finally {
      db.close();
    }
  }
};
