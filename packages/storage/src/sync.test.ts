// 同步导入的回归测试。
//
// 导入是「先删这个设备这个月，再插新的」。如果收下了残缺的文件，
// 对方完整的月份就被残缺的数据覆盖了——这个损失没法恢复。
// 所以这几条要钉住：坏行、身份不符、原子导出。
//
// 跑法：node --test packages/storage/src/sync.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Repo } from './repo.ts';
import { exportRollup, importRollups, rollupFileName } from './sync.ts';
import type { DeviceInfo } from '../../core/src/device.ts';

const LOCAL: DeviceInfo = { id: 'aaaaaaaa-1111-2222-3333-444444444444', name: '本机', platform: 'darwin' };
const REMOTE: DeviceInfo = { id: 'bbbbbbbb-1111-2222-3333-444444444444', name: '另一台', platform: 'darwin' };

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'atracker-sync-'));
}

/** 一条 agg 行。 */
function aggLine(device: string, day: string, tokens: number) {
  return {
    t: 'agg', k: 'agent', device, day,
    agent: 'codex', input: tokens, output: 0, cacheRead: 0, cacheWrite: 0,
    reasoning: 0, tokens
  };
}

function deviceLine(device: string, name: string) {
  return { t: 'device', id: device, name, platform: 'darwin', writtenAt: Date.now() };
}

/** 造一个远端设备在本机库里的完整数据。 */
function seedRemote(repo: Repo, month: string, tokens: number): void {
  repo.db.prepare(
    `INSERT OR REPLACE INTO agg_day_agent (day, device, agent, input, output, cache_read, cache_write, reasoning, tokens)
     VALUES (?,?,?,?,0,0,0,0,?)`
  ).run(`${month}-15`, REMOTE.id, 'codex', tokens, tokens);
  repo.refreshTotal();
}

test('导出用临时文件加改名，目录里不会留下半截文件', () => {
  const dir = tmpDir();
  const repo = new Repo(join(dir, 'a.db'));
  // 导出的是本机自己的数据
  repo.db.prepare(
    `INSERT OR REPLACE INTO agg_day_agent (day, device, agent, input, output, cache_read, cache_write, reasoning, tokens)
     VALUES (?,?,?,?,0,0,0,0,?)`
  ).run('2026-10-15', LOCAL.id, 'codex', 1000, 1000);
  repo.refreshTotal();

  const files = exportRollup(repo, LOCAL, dir);
  assert.equal(files.length, 1);
  // 目录里应该只有最终的 .jsonl，没有 .tmp
  const names = readdirSync(dir).filter(n => n.endsWith('.jsonl') || n.endsWith('.tmp'));
  assert.deepEqual(names, [rollupFileName(LOCAL.id, '2026-10')]);
  // 内容是完整的 JSONL，每行都能解析
  const lines = readFileSync(files[0]!, 'utf8').trim().split('\n');
  assert.ok(lines.length > 0);
  for (const l of lines) JSON.parse(l);
  repo.close();
});

test('文件里有一行坏数据，整个文件都不导入', () => {
  const dir = tmpDir();
  const repo = new Repo(join(dir, 'a.db'));
  // 本机库里已经有远端 10 月的完整数据
  seedRemote(repo, '2026-10', 5000);

  const syncDir = tmpDir();
  const file = join(syncDir, rollupFileName(REMOTE.id, '2026-10'));
  writeFileSync(file, [
    JSON.stringify(deviceLine(REMOTE.id, '另一台')),
    JSON.stringify(aggLine(REMOTE.id, '2026-10-01', 100)),
    '这一行不是合法 JSON',
    JSON.stringify(aggLine(REMOTE.id, '2026-10-02', 100))
  ].join('\n') + '\n', 'utf8');

  const summary = importRollups(repo, syncDir, LOCAL.id);
  assert.equal(summary.aggRows, 0, '残缺的文件不能导入任何行');
  assert.ok(summary.errors.some(e => e.includes('整个文件已跳过')), '要说明为什么跳过');

  // 关键：库里原有的完整数据还在
  const row = repo.db.prepare('SELECT SUM(tokens) t FROM agg_day_agent WHERE device = ?').get(REMOTE.id) as any;
  assert.equal(row.t, 5000, '远端完整月份的数据不能被残缺文件覆盖');
  repo.close();
});

test('设备头里的 id 和文件名不一致，整个文件不导入', () => {
  const dir = tmpDir();
  const repo = new Repo(join(dir, 'a.db'));
  seedRemote(repo, '2026-10', 5000);

  const syncDir = tmpDir();
  // 文件名是远端的 id，设备头却写成本机
  const file = join(syncDir, rollupFileName(REMOTE.id, '2026-10'));
  writeFileSync(file, [
    JSON.stringify(deviceLine(LOCAL.id, '本机')),
    JSON.stringify(aggLine(REMOTE.id, '2026-10-01', 1))
  ].join('\n') + '\n', 'utf8');

  const summary = importRollups(repo, syncDir, LOCAL.id);
  assert.equal(summary.aggRows, 0);
  assert.ok(summary.errors.some(e => e.includes('id 和文件名不一致')));

  const row = repo.db.prepare('SELECT SUM(tokens) t FROM agg_day_agent WHERE device = ?').get(REMOTE.id) as any;
  assert.equal(row.t, 5000, '别人的文件不能改掉本机库里的数据');
  repo.close();
});

test('数据行的 device 和文件名不一致，整个文件不导入', () => {
  const dir = tmpDir();
  const repo = new Repo(join(dir, 'a.db'));
  seedRemote(repo, '2026-10', 5000);

  const syncDir = tmpDir();
  const file = join(syncDir, rollupFileName(REMOTE.id, '2026-10'));
  writeFileSync(file, [
    JSON.stringify(deviceLine(REMOTE.id, '另一台')),
    JSON.stringify(aggLine('cccccccc-9999-8888-7777-666666666666', '2026-10-01', 1))
  ].join('\n') + '\n', 'utf8');

  const summary = importRollups(repo, syncDir, LOCAL.id);
  assert.equal(summary.aggRows, 0);
  assert.ok(summary.errors.some(e => e.includes('device 和文件名不一致')));
  repo.close();
});

test('结构不对的行（t 不认识、缺字段）也会被拒', () => {
  const dir = tmpDir();
  const repo = new Repo(join(dir, 'a.db'));
  const syncDir = tmpDir();
  const file = join(syncDir, rollupFileName(REMOTE.id, '2026-10'));
  writeFileSync(file, [
    JSON.stringify(deviceLine(REMOTE.id, '另一台')),
    JSON.stringify({ t: 'agg', k: 'agent', device: REMOTE.id, day: '2026-10-01' })  // 缺数值字段
  ].join('\n') + '\n', 'utf8');

  const summary = importRollups(repo, syncDir, LOCAL.id);
  assert.equal(summary.aggRows, 0);
  assert.ok(summary.errors.some(e => e.includes('不合法')));
  repo.close();
});

test('导入完整文件能正常替换那个月的数据', () => {
  const dir = tmpDir();
  const repo = new Repo(join(dir, 'a.db'));
  seedRemote(repo, '2026-10', 5000);

  const syncDir = tmpDir();
  const file = join(syncDir, rollupFileName(REMOTE.id, '2026-10'));
  writeFileSync(file, [
    JSON.stringify(deviceLine(REMOTE.id, '另一台')),
    JSON.stringify(aggLine(REMOTE.id, '2026-10-01', 100)),
    JSON.stringify(aggLine(REMOTE.id, '2026-10-02', 200))
  ].join('\n') + '\n', 'utf8');

  const summary = importRollups(repo, syncDir, LOCAL.id);
  assert.equal(summary.aggRows, 2);
  assert.equal(summary.errors.length, 0);

  // 整月替换：旧的那行没了，新的是两行
  const rows = repo.db.prepare('SELECT day, tokens FROM agg_day_agent WHERE device = ? ORDER BY day').all(REMOTE.id) as any[];
  assert.deepEqual(rows.map(r => r.day), ['2026-10-01', '2026-10-02']);
  repo.close();
});

test('用户改过的设备名不会被别的机器的旧文件改回去', () => {
  const dir = tmpDir();
  const repo = new Repo(join(dir, 'a.db'));
  // 库里已经有这台设备，名字是用户改过的
  repo.touchDevice({ id: REMOTE.id, name: '办公室那台', platform: 'darwin' });

  const syncDir = tmpDir();
  const file = join(syncDir, rollupFileName(REMOTE.id, '2026-10'));
  writeFileSync(file, [
    JSON.stringify(deviceLine(REMOTE.id, '旧名字')),
    JSON.stringify(aggLine(REMOTE.id, '2026-10-01', 100))
  ].join('\n') + '\n', 'utf8');

  importRollups(repo, syncDir, LOCAL.id);
  const d = repo.device(REMOTE.id);
  assert.equal(d.name, '办公室那台', '用户在界面上改过的名字要保住');
  repo.close();
});
