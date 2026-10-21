// 对账：拿各 agent 自带的汇总数据核对我们采到的数。
// 不是每个来源都有可靠的汇总，所以逐个来源用不同的基准，能对上的和对不上的都如实报出来。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { Repo } from '../../storage/src/repo.ts';

interface Line {
  name: string;
  ours: number;
  theirs: number;
  note: string;
  ok: boolean;
}

const home = homedir();

function oursBySession(repo: Repo, agent: string): Map<string, number> {
  const rows = repo.db.prepare(
    `SELECT session_id, SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) t
     FROM usage_event WHERE agent = ? GROUP BY session_id`
  ).all(agent) as any[];
  return new Map(rows.map(r => [r.session_id, r.t]));
}

function oursTotal(repo: Repo, agent: string): number {
  const r = repo.db.prepare(
    `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens),0) t
     FROM usage_event WHERE agent = ?`
  ).get(agent) as any;
  return r.t;
}

/* ---------- codex：threads.tokens_used ---------- */
function checkCodex(): Line {
  const dbPath = join(home, '.codex', 'state_5.sqlite');
  if (!existsSync(dbPath)) return { name: 'codex', ours: 0, theirs: 0, note: '没有 state_5.sqlite', ok: false };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const r = db.prepare('SELECT COALESCE(SUM(tokens_used),0) t FROM threads').get() as any;
  db.close();
  return { name: 'codex', ours: 0, theirs: r.t, note: 'threads.tokens_used 全量合计', ok: true };
}

/* ---------- Claude Code：cost-state ---------- */
/**
 * cost-state 会被会话继承或复制，可能来自另一个会话（模型对不上）。
 * 所以只在「cost-state 的模型集合与本会话实际用过的模型一致」时才拿来比。
 */
function checkClaudeCode(repo: Repo): { matched: number; mismatched: number; active: number; detail: string[] } {
  const root = join(home, '.claude', 'projects');
  const ours = oursBySession(repo, 'claude-code');
  let matched = 0;
  let mismatched = 0;
  let active = 0;
  const detail: string[] = [];

  const walk = (dir: string): string[] => {
    const out: string[] = [];
    if (!existsSync(dir)) return out;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
    return out;
  };

  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
    const models = new Set<string>();
    const seen = new Set<string>();
    let usageTotal = 0;
    let costState: any = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let d: any;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.type === 'assistant') {
        const m = d.message ?? {};
        const u = m.usage;
        if (u) {
          // 同一条消息按内容块写成多行，usage 重复，按 message.id 去重
          const key = m.id ?? d.uuid;
          if (!seen.has(key)) {
            seen.add(key);
            usageTotal += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          }
          if (m.model) models.add(m.model);
        }
      } else if (d.type === 'cost-state' && !costState) {
        costState = d;
      }
    }
    if (!costState) continue;
    const usage = costState.modelUsage ?? {};
    const costModels = Object.keys(usage).map(k => k.replace(/\[[^\]]*\]$/, ''));
    // 模型对不上说明这个 cost-state 是别的会话留下来的，不拿来比
    if (!costModels.some(m => models.has(m))) continue;

    const theirTotal = Object.values(usage).reduce((s: number, m: any) =>
      s + (m.inputTokens ?? 0) + (m.outputTokens ?? 0) +
      (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0), 0);
    const sessionId = Object.keys(ours)[0] ? '' : '';
    if (Math.abs(theirTotal - usageTotal) <= Math.max(3, usageTotal * 0.001)) {
      matched++;
    } else if (Date.now() - statSync(file).mtimeMs < 2 * 3600_000) {
      // 最近还在写的会话，cost-state 是写完那一刻的快照，对不上是正常的
      active++;
      detail.push(`    会话 ${file.split('/').pop()?.slice(0, 12)}：进行中，对方 ${theirTotal.toLocaleString()}，我们 ${usageTotal.toLocaleString()}`);
    } else {
      mismatched++;
      detail.push(`    会话 ${file.split('/').pop()?.slice(0, 12)}：对方 ${theirTotal.toLocaleString()}，我们 ${usageTotal.toLocaleString()}`);
    }
  }
  return { matched, mismatched, active, detail };
}

/* ---------- pi：meta.json ---------- */
function checkPi(repo: Repo): { matched: number; stale: number; detail: string[] } {
  const root = join(home, '.pi', 'agent', 'sessions');
  const ours = oursBySession(repo, 'pi');
  let matched = 0;
  let stale = 0;
  const detail: string[] = [];

  const walk = (dir: string): string[] => {
    const out: string[] = [];
    if (!existsSync(dir)) return out;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (e.name.endsWith('.meta.json')) out.push(p);
    }
    return out;
  };

  for (const file of walk(root)) {
    const meta = JSON.parse(readFileSync(file, 'utf8'));
    const uuid = file.split('/').pop()!.replace('.meta.json', '').split('_').pop()!;
    const sid = meta.sessionId ?? uuid;
    const theirs = (meta.tokensIn ?? 0) + (meta.tokensOut ?? 0) +
      (meta.cacheRead ?? 0) + (meta.cacheWrite ?? 0);
    const mine = ours.get(sid);
    if (mine === undefined) continue;
    if (Math.abs(mine - theirs) <= Math.max(3, theirs * 0.001)) matched++;
    else {
      stale++;
      detail.push(`    会话 ${sid.slice(0, 12)}：meta ${theirs.toLocaleString()}，我们 ${mine.toLocaleString()}（meta 是会话中途的快照）`);
    }
  }
  return { matched, stale, detail };
}

/* ---------- opencode：session 表 ---------- */
function checkOpencode(): Line | null {
  const dbPath = join(home, '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  // 桌面端用新表，旧表是迁移前的副本，两边不能相加
  const v2 = !!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_v2'").get());
  const r = v2
    ? db.prepare(
      `SELECT COALESCE(SUM(tokens_input + tokens_output + COALESCE(tokens_cache_read,0) + COALESCE(tokens_cache_write,0)),0) t
       FROM session_v2`
    ).get() as any
    : db.prepare(
      `SELECT COALESCE(SUM(tokens_input + tokens_output + COALESCE(tokens_cache_read,0) + COALESCE(tokens_cache_write,0)),0) t
       FROM session`
    ).get() as any;
  db.close();
  return { name: 'opencode', ours: 0, theirs: r.t, note: v2 ? 'session_v2 汇总列' : 'session 表汇总列（旧格式）', ok: true };
}

/* ---------- DeepSeek Harness：session_projcache ---------- */
function checkDsh(repo: Repo): { matched: number; missing: number; extra: number; theirTotal: number } {
  const path = join(home, '.dsh', 'storages', 'session_projcache.json');
  const ours = oursBySession(repo, 'dsh');
  const empty = { matched: 0, missing: 0, extra: 0, theirTotal: 0 };
  if (!existsSync(path)) return empty;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const sessions = data?.tables?.sessions ?? {};

  let matched = 0;
  let missing = 0;
  let theirTotal = 0;
  for (const [sid, rec] of Object.entries<any>(sessions)) {
    const t = rec?.rows?.tokenUsage?.val?.totals;
    if (!t) continue;
    const theirs = (t.uncachedInputTokens ?? 0) + (t.outputTokens ?? 0) +
      (t.cacheReadTokens ?? 0) + (t.cacheWriteTokens ?? 0);
    if (theirs === 0) continue;
    theirTotal += theirs;
    const mine = ours.get(sid);
    if (mine === undefined) { missing++; continue; }
    if (Math.abs(mine - theirs) <= Math.max(3, theirs * 0.001)) matched++;
  }
  return { matched, missing, extra: [...ours.keys()].filter(k => !sessions[k]).length, theirTotal };
}

export function reconcile(repo: Repo): string {
  const lines: string[] = [];

  const codex = checkCodex();
  const ourCodex = oursTotal(repo, 'codex');
  lines.push(`codex        对方 ${codex.theirs.toLocaleString().padStart(14)}  我们 ${ourCodex.toLocaleString().padStart(14)}  差 ${(ourCodex - codex.theirs).toLocaleString().padStart(10)}  ${Math.abs(ourCodex - codex.theirs) <= 3 ? '✓' : '✗'}`);

  const cc = checkClaudeCode(repo);
  lines.push(`claude-code  可比的会话 ${cc.matched} 个一致，${cc.active} 个进行中，${cc.mismatched} 个不一致（cost-state 常是别的会话继承来的，不计入）`);
  cc.detail.forEach(d => lines.push(d));

  const pi = checkPi(repo);
  lines.push(`pi           可比的会话 ${pi.matched} 个一致，${pi.stale} 个 meta 已过期（meta 是会话中途的快照）`);
  pi.detail.forEach(d => lines.push(d));

  const oc = checkOpencode();
  if (oc) {
    const ourOc = oursTotal(repo, 'opencode');
    lines.push(`opencode     对方 ${oc.theirs.toLocaleString().padStart(14)}  我们 ${ourOc.toLocaleString().padStart(14)}  差 ${(ourOc - oc.theirs).toLocaleString().padStart(10)}  ${Math.abs(ourOc - oc.theirs) <= 3 ? '✓' : '✗'}`);
  }

  const dsh = checkDsh(repo);
  const ourDsh = oursTotal(repo, 'dsh');
  lines.push(`dsh          对方 ${dsh.theirTotal.toLocaleString().padStart(14)}  我们 ${ourDsh.toLocaleString().padStart(14)}  可比会话 ${dsh.matched} 个一致`);
  lines.push(`             我们多采到 ${dsh.extra} 个 projcache 没记的会话，projcache 多记 ${dsh.missing} 个我们没有的会话`);

  return lines.join('\n');
}
