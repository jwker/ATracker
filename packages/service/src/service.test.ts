// 服务层的看门狗回归测试。
//
// 线上事故：一轮扫描开始后没再返回，`scanning` 永远是 true，之后所有触发
// （文件监听、5 分钟兜底轮询、手动重新扫描）都变成空操作，页面和日志一起停住，
// 直到重启进程。数据库里能看到一条 finished_at 为 NULL 的批次。
//
// 这几条钉住三件事：卡住的扫描会超时、超时后服务能继续干活、页面上看得出来。
//
// 跑法：node --test packages/service/src/service.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ATrackerService } from './service.ts';
import * as scanner from '../../collectors/src/scanner.ts';

/** runScan 用的是模块里的 COLLECTORS 数组，只能就地替换再恢复。 */
const collectors = (scanner as unknown as { COLLECTORS: any[] }).COLLECTORS;

async function withCollector<T>(list: any[], run: () => Promise<T>): Promise<T> {
  const original = [...collectors];
  collectors.length = 0;
  collectors.push(...list);
  try {
    return await run();
  } finally {
    collectors.length = 0;
    collectors.push(...original);
  }
}

/** 建一个只跑扫描、不监听也不同步的服务。设备身份写到临时文件，不碰真的 ~/.atracker。 */
function newService(scanTimeoutMs: number): ATrackerService {
  const dir = mkdtempSync(join(tmpdir(), 'atracker-svc-'));
  process.env.ATRACKER_DEVICE_FILE = join(dir, 'device.json');
  return new ATrackerService({
    dbPath: join(dir, 'a.db'),
    watch: false,
    pollMs: 0,
    syncDir: null,
    scanTimeoutMs
  });
}

/** 卡在这个 await 上直到被 abort。真实场景是卡在文件系统的读上，表现一样。 */
function stuckCollector() {
  return {
    id: 'stuck',
    label: 'stuck',
    version: '1',
    roots: () => ['/nonexistent'],
    async *scan(ctx: any) {
      await new Promise<void>(resolve => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (ctx.signal.aborted) throw new Error('扫描已中止');
      yield {} as any;
    }
  };
}

test('一轮扫描卡死超时后，服务要解锁，下一轮能真的跑起来', async () => {
  const svc = newService(120);

  await withCollector([stuckCollector()], () => svc.triggerScan('manual'));

  assert.equal(svc.isScanning, false, '超时后必须解锁，否则之后所有扫描都变空操作');
  const failure = svc.repo.db
    .prepare("SELECT message FROM scan_log WHERE level = 'err' ORDER BY id DESC LIMIT 1")
    .get() as any;
  assert.ok(failure && /未完成/.test(failure.message), '页面的日志里要能看出扫描放弃了');

  // 第二轮：采集器正常返回，必须被正常收尾
  await withCollector([{
    id: 'fine',
    label: 'fine',
    version: '1',
    roots: () => ['/nonexistent'],
    async *scan() { /* 什么都不产出 */ }
  }], () => svc.triggerScan('manual'));

  assert.equal(svc.isScanning, false);
  const last = svc.repo.db
    .prepare('SELECT finished_at FROM scan_batch ORDER BY id DESC LIMIT 1')
    .get() as any;
  assert.ok(last?.finished_at, '第二轮的批次要被正常收尾');
  await svc.close();
});

test('扫描进行中再次触发只记标记，不会叠着跑两份', async () => {
  const svc = newService(5_000);
  const seen: string[] = [];
  const slow = {
    id: 'slow',
    label: 'slow',
    version: '1',
    roots: () => ['/nonexistent'],
    async *scan() {
      seen.push('scan');
      await new Promise<void>(resolve => { setTimeout(resolve, 30); });
    }
  };

  await withCollector([slow], async () => {
    // 第二次触发不该另起一轮：没有新事件，只把 dirty 打上，本轮结束后再跑一次
    await Promise.all([svc.triggerScan('manual'), svc.triggerScan('poll')]);
    // 第一次结束后的补跑还在飞，等它落地
    while (svc.isScanning) await new Promise<void>(resolve => { setTimeout(resolve, 10); });
  });

  const batches = svc.repo.db
    .prepare("SELECT id FROM scan_batch WHERE trigger IN ('manual','poll')")
    .all() as any[];
  assert.ok(batches.length <= 2, `最多两轮（一次执行 + 一次补跑），实际 ${batches.length}`);
  await svc.close();
});

test('退出时还在跑的扫描不会抛出没人接的错', async () => {
  const svc = newService(5_000);
  let unhandled: unknown = null;
  const onUnhandled = (err: unknown): void => { unhandled = err; };
  process.on('unhandledRejection', onUnhandled);

  const slow = {
    id: 'slow',
    label: 'slow',
    version: '1',
    roots: () => ['/nonexistent'],
    async *scan() {
      // 卡在半路，让 close() 把库先关掉
      await new Promise<void>(resolve => { setTimeout(resolve, 50); });
    }
  };

  try {
    await withCollector([slow], async () => {
      const running = svc.triggerScan('manual');
      await new Promise<void>(resolve => { setTimeout(resolve, 20); });
      await svc.close();
      await running;
    });
    // 让 finally 里的日志写入有机会执行完
    await new Promise<void>(resolve => { setTimeout(resolve, 20); });
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.equal(unhandled, null, '关库之后写日志抛错会变成没人接的 promise rejection');
  assert.equal(svc.isScanning, false);
});

test('卡在永不落地的 await 上的扫描，超时后也要放开标记', async () => {
  // 11 月 18 日的真实情形：一轮扫描从 09:41 挂到发现时已经 5 个小时，
  // batch 的 finished_at 一直是 NULL。当时的做法是超时就 abort、然后继续 await
  // 那个 promise —— 卡在不可中断的 await 上时，abort 只是设个标记，永远轮不到
  // 检查，等于没救。现在超时就不等了。
  const svc = newService(120);

  const never = {
    id: 'never',
    label: 'never',
    version: '1',
    roots: () => ['/nonexistent'],
    async *scan() {
      // 不看 signal，也不会有任何结果：模拟卡在文件系统的 await 上
      await new Promise<void>(() => { /* 永不 resolve */ });
    }
  };

  await withCollector([never], () => svc.triggerScan('manual'));
  assert.equal(svc.isScanning, false, '超时后必须放开标记，不能等那个 promise 落地');

  // 被放弃的那一轮也要标成中断，否则日志页上会一直挂着一条「在跑」
  const abandoned = svc.repo.db.prepare('SELECT finished_at, errors FROM scan_batch ORDER BY id DESC LIMIT 1').get() as any;
  assert.ok(abandoned.finished_at !== null, '被放弃的批次不能永远停在 NULL');
  assert.equal(abandoned.errors, 1);

  // 下一轮要真能跑
  await withCollector([{
    id: 'fine',
    label: 'fine',
    version: '1',
    roots: () => ['/nonexistent'],
    async *scan() { /* 什么都不产出 */ }
  }], () => svc.triggerScan('manual'));

  const last = svc.repo.db.prepare('SELECT finished_at FROM scan_batch ORDER BY id DESC LIMIT 1').get() as any;
  assert.ok(last?.finished_at, '被放弃的那一轮之后再扫，批次要正常收尾');
  const err = svc.repo.db.prepare("SELECT message FROM scan_log WHERE level = 'err' ORDER BY id DESC LIMIT 1").get() as any;
  assert.match(err.message, /未完成/);
  await svc.close();
});

test('启动时把上次没结束的批次标成中断', async () => {
  const svc = newService(5_000);
  const id = svc.repo.startBatch('watch', Date.now() - 60_000);
  assert.ok(svc.repo.db.prepare('SELECT finished_at FROM scan_batch WHERE id = ?').get(id));

  svc.start(); // 启动时清理
  const row = svc.repo.db.prepare('SELECT finished_at, errors FROM scan_batch WHERE id = ?').get(id) as any;
  assert.ok(row.finished_at !== null, '遗留批次不该一直显示「在跑」');
  assert.equal(row.errors, 1, '中断也是一种错误，要计入');
  await svc.close();
});
