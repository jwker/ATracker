// 采集游标的回归测试。
//
// 游标记录「这个文件读到哪个字节了」。推进方式不对，内容会被永久跳过——
// 不是延迟一轮，是再也读不到。这些用例把那几种情况钉住。
//
// 跑法：node --test packages/collectors/src/scanner.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, utimesSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runScan, type ScanOptions } from './scanner.ts';
import { Repo } from '../../storage/src/repo.ts';
import { parseRecord, parseTimestamp } from './parse.ts';

/** 建一个临时目录当 agent 的家目录。 */
function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'atracker-scan-'));
}

/** 一个只产出固定事件的采集器，用来观察扫描编排的行为。 */
function fakeCollector(id: string, files: () => string[]) {
  return {
    id,
    label: id,
    version: '1',
    roots: () => ['/nonexistent'],
    async *scan(ctx: any) {
      for (const path of files()) {
        const st = ctx.shouldParse(path);
        if (!st.parse) continue;
        let offset = st.offset;
        for await (const { line, endOffset, partial } of ctx.lines(path, st.offset)) {
          const rec = parseRecord(line);
          if (!rec) {
            if (!partial) offset = endOffset;
            continue;
          }
          offset = endOffset;
          yield {
            eventId: `${id}:${rec.id ?? line}`,
            agent: id,
            sessionId: String(rec.id ?? 's'),
            parentSessionId: null,
            isChild: false,
            ts: 1767225600000,
            cwd: '/tmp',
            model: 'm',
            provider: 'p',
            buckets: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            thinkingLevel: null
          };
        }
        ctx.commitFile(path, offset, true);
      }
    }
  };
}

/** 跑一次扫描，返回新库。 */
async function scanWith(collector: any): Promise<Repo> {
  const dir = tmpRoot();
  const repo = new Repo(join(dir, 'a.db'));
  const opts: ScanOptions = { trigger: 'manual' };
  // 临时替换采集器清单
  const scanners = await import('./scanner.ts');
  const original = scanners.COLLECTORS;
  (scanners as any).COLLECTORS.length = 0;
  (scanners as any).COLLECTORS.push(collector);
  try {
    await runScan(repo, opts);
  } finally {
    (scanners as any).COLLECTORS.length = 0;
    (scanners as any).COLLECTORS.push(...original);
  }
  return repo;
}

test('CRLF 换行的文件，每一行的偏移都算得对', async () => {
  const dir = tmpRoot();
  const file = join(dir, 'a.jsonl');
  const body = '{"id":1}\r\n{"id":2}\r\n{"id":3}\r\n';
  writeFileSync(file, body, 'utf8');

  let seen: number[] = [];
  const repo = await scanWith({
    ...fakeCollector('t', () => [file]),
    async *scan(ctx: any) {
      const st = ctx.shouldParse(file);
      for await (const { line, endOffset, partial } of ctx.lines(file, st.offset)) {
        seen.push(endOffset);
        assert.equal(partial, false);
        assert.equal(JSON.parse(line).id, seen.length);
      }
      ctx.commitFile(file, seen[seen.length - 1] ?? 0, true);
    }
  });
  repo.close();

  // 三行的结束偏移应该分别是 10、20、30 字节
  // （`{"id":1}` 8 字节 + CRLF 2 字节）
  assert.deepEqual(seen, [10, 20, 30]);
  assert.equal(statSync(file).size, 30);
});

test('读取期间追加的内容，下一轮能读到', async () => {
  const dir = tmpRoot();
  const file = join(dir, 'a.jsonl');
  writeFileSync(file, '{"id":1}\n', 'utf8');

  const repo = new Repo(join(dir, 'a.db'));
  const { COLLECTORS } = await import('./scanner.ts');
  const original = [...COLLECTORS];

  // 采集器在读完文件之后、写游标之前，往文件里追加一行。
  // 这模拟「日志正在被写入时我们扫了一遍」：shouldParse 看到的是旧大小，
  // 提交游标时文件已经变了。
  const collector = {
    ...fakeCollector('t', () => [file]),
    async *scan(ctx: any) {
      const st = ctx.shouldParse(file);
      if (!st.parse) return;
      let offset = st.offset;
      for await (const { line, endOffset, partial } of ctx.lines(file, st.offset)) {
        const rec = parseRecord(line);
        if (!rec) {
          if (!partial) offset = endOffset;
          continue;
        }
        offset = endOffset;
        yield {
          eventId: `t:${rec.id}`,
          agent: 't',
          sessionId: String(rec.id),
          parentSessionId: null,
          isChild: false,
          ts: 1767225600000,
          cwd: '/tmp',
          model: 'm',
          provider: 'p',
          buckets: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          thinkingLevel: null
        };
      }
      appendFileSync(file, '{"id":2}\n', 'utf8'); // 扫描过程中被追加
      ctx.commitFile(file, offset, true);
    }
  };
  (COLLECTORS as any).length = 0;
  (COLLECTORS as any).push(collector);

  await runScan(repo, { trigger: 'manual' });
  let rows = repo.db.prepare('SELECT count(*) n FROM usage_event').get() as any;
  assert.equal(rows.n, 1);

  // 第二轮：追加的那一行必须能被读到
  await runScan(repo, { trigger: 'manual' });
  rows = repo.db.prepare('SELECT count(*) n FROM usage_event').get() as any;
  assert.equal(rows.n, 2, '扫描期间追加的那一行必须在下一轮读到');

  (COLLECTORS as any).length = 0;
  (COLLECTORS as any).push(...original);
  repo.close();
});

test('大小没变但内容被改写，从头重读', async () => {
  const dir = tmpRoot();
  const file = join(dir, 'a.jsonl');
  writeFileSync(file, '{"id":1}\n', 'utf8');

  const repo = new Repo(join(dir, 'a.db'));
  const { COLLECTORS } = await import('./scanner.ts');
  const original = [...COLLECTORS];
  (COLLECTORS as any).length = 0;
  (COLLECTORS as any).push(fakeCollector('t', () => [file]));

  await runScan(repo, { trigger: 'manual' });
  let rows = repo.db.prepare('SELECT count(*) n FROM usage_event').get() as any;
  assert.equal(rows.n, 1);

  // 同样长度，内容换成另一条，然后改 mtime
  writeFileSync(file, '{"id":9}\n', 'utf8');
  const future = new Date(Date.now() + 5000);
  utimesSync(file, future, future);

  await runScan(repo, { trigger: 'manual' });
  const ids = (repo.db.prepare('SELECT event_id FROM usage_event').all() as any[]).map(r => r.event_id);
  assert.ok(ids.includes('t:9'), '改写后的内容必须被读到');

  (COLLECTORS as any).length = 0;
  (COLLECTORS as any).push(...original);
  repo.close();
});

test('末尾写到一半的行不推进偏移，写完之后能补上', async () => {
  const dir = tmpRoot();
  const file = join(dir, 'a.jsonl');
  writeFileSync(file, '{"id":1}\n{"id":2', 'utf8'); // 第二行没写完

  const repo = new Repo(join(dir, 'a.db'));
  const { COLLECTORS } = await import('./scanner.ts');
  const original = [...COLLECTORS];
  (COLLECTORS as any).length = 0;
  (COLLECTORS as any).push(fakeCollector('t', () => [file]));

  await runScan(repo, { trigger: 'manual' });
  let rows = repo.db.prepare('SELECT count(*) n FROM usage_event').get() as any;
  assert.equal(rows.n, 1, '半行不算一条');

  // 写方把这一行补完
  appendFileSync(file, '}\n', 'utf8');

  await runScan(repo, { trigger: 'manual' });
  rows = repo.db.prepare('SELECT count(*) n FROM usage_event').get() as any;
  assert.equal(rows.n, 2, '补完之后这一行必须能读到');

  (COLLECTORS as any).length = 0;
  (COLLECTORS as any).push(...original);
  repo.close();
});

test('完整落盘的坏行不卡住后面的行', async () => {
  const dir = tmpRoot();
  const file = join(dir, 'a.jsonl');
  writeFileSync(file, '{"id":1}\n这不是 JSON\n{"id":3}\n', 'utf8');

  const repo = new Repo(join(dir, 'a.db'));
  const { COLLECTORS } = await import('./scanner.ts');
  const original = [...COLLECTORS];
  (COLLECTORS as any).length = 0;
  (COLLECTORS as any).push(fakeCollector('t', () => [file]));

  await runScan(repo, { trigger: 'manual' });
  const ids = (repo.db.prepare('SELECT event_id FROM usage_event').all() as any[]).map(r => r.event_id);
  assert.deepEqual(ids.sort(), ['t:1', 't:3']);

  (COLLECTORS as any).length = 0;
  (COLLECTORS as any).push(...original);
  repo.close();
});

test('一行字面量 null 不会让整个来源中断', () => {
  assert.equal(parseRecord('null'), null);
  assert.equal(parseRecord('[1,2]'), null);
  assert.equal(parseRecord('42'), null);
  assert.equal(parseRecord('"x"'), null);
  assert.deepEqual(parseRecord('{"a":1}'), { a: 1 });
});

test('时间解析不出来返回 null，不兜底成现在', () => {
  assert.equal(parseTimestamp('2026-10-05T07:27:55.603Z'), Date.parse('2026-10-05T07:27:55.603Z'));
  assert.equal(parseTimestamp('不是时间'), null);
  assert.equal(parseTimestamp(undefined), null);
  assert.equal(parseTimestamp(''), null);
});
