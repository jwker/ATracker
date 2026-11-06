// ATracker 命令行。
//   atracker scan [--source codex] [--trigger manual]
//   atracker stats
//   atracker sync export|import [--dir <目录>]
//   atracker doctor

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { Repo } from '../../storage/src/repo.ts';
import { COLLECTORS, runScan } from '../../collectors/src/scanner.ts';
import { loadDevice } from '../../core/src/device.ts';
import { iCloudSyncDir, loadConfig } from '../../core/src/config.ts';
import { exportRollup, importRollups } from '../../storage/src/sync.ts';
import { localMonth } from '../../core/src/time.ts';
import { fmtTok } from '../../core/src/units.ts';
import { reconcile } from './reconcile.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DB = join(root, 'data', 'atracker.db');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function openRepo(): Repo {
  mkdirSync(dirname(DB), { recursive: true });
  return new Repo(DB);
}

const cmd = process.argv[2] ?? 'help';

if (cmd === 'scan') {
  const only = arg('source')?.split(',').map(s => s.trim()).filter(Boolean);
  const trigger = (arg('trigger') as 'watch' | 'poll' | 'manual') ?? 'manual';
  const repo = openRepo();
  const device = loadDevice();
  repo.touchDevice(device);
  repo.claimUnassigned(device.id);
  const t0 = Date.now();
  const s = await runScan(repo, { trigger, only, device });
  console.log(`批次 ${s.batchId} · 耗时 ${Date.now() - t0}ms`);
  console.log(`  读取 ${s.eventsRead} 条事件，落库 ${s.eventsWritten} 条，覆盖 ${s.days.length} 天`);
  if (s.errors) console.log(`  错误 ${s.errors} 个`);
  const total = repo.total();
  if (total) {
    console.log(`  累计 ${fmtTok(total.tokens, 'zh')} token`);
  }
  const first = repo.recentBatches(1)[0];
  if (first && first.id <= 2) {
    console.log('\n  看界面：npm run desktop（桌面版窗口）');
  }
  repo.close();
} else if (cmd === 'stats') {
  const repo = openRepo();
  const t = repo.total();
  if (!t) {
    console.log('库里还没有数据，先跑 atracker scan');
  } else {
    console.log(`总量        ${fmtTok(t.tokens, 'zh')}`);
    console.log(`  输入      ${fmtTok(t.input, 'zh')}`);
    console.log(`  输出      ${fmtTok(t.output, 'zh')}`);
    console.log(`  缓存命中  ${fmtTok(t.cache_read, 'zh')}`);
    console.log(`  缓存写入  ${fmtTok(t.cache_write, 'zh')}`);
  }
  repo.close();
} else if (cmd === 'sync') {
  const sub = process.argv[3] ?? 'import';
  const dir = arg('dir') ?? process.env.ATRACKER_SYNC_DIR ?? join(homedir(), '.atracker', 'sync');
  const repo = openRepo();
  const device = loadDevice();
  repo.touchDevice(device);

  if (sub === 'export') {
    const files = exportRollup(repo, device, dir);
    console.log(`已导出 ${files.length} 个文件到 ${dir}`);
    for (const f of files) console.log(`  ${f}`);
  } else if (sub === 'import') {
    const s = importRollups(repo, dir, device.id);
    console.log(`读取 ${s.files} 个文件，跳过自己的 ${s.skippedOwn} 个；导入 ${s.aggRows} 条聚合、${s.sessionRows} 条会话`);
    for (const d of s.devices) console.log(`  ${d.name}（${d.id.slice(0, 8)}）：${d.months.join(', ') || '无月份'}`);
    for (const e of s.errors) console.log(`  错误：${e}`);
  } else {
    console.log('用法：atracker sync export|import [--dir <目录>]');
  }
  repo.close();
} else if (cmd === 'reconcile') {
  const repo = openRepo();
  console.log('对账：拿各来源自带的汇总数据核对我们采到的数\n');
  console.log(reconcile(repo));
  repo.close();
} else if (cmd === 'doctor') {
  const collectors = COLLECTORS;
  const repo = openRepo();
  console.log('来源          路径      文件   事件        上次扫描');
  console.log('─'.repeat(78));
  for (const c of collectors) {
    const roots = c.roots();
    let files = 0;
    let ok = true;
    for (const r of roots) {
      try {
        const { statSync, readdirSync } = await import('node:fs');
        const st = statSync(r);
        if (st.isDirectory()) {
          const walk = (d: string): number => {
            let n = 0;
            for (const e of readdirSync(d, { withFileTypes: true })) {
              const p = join(d, e.name);
              n += e.isDirectory() ? walk(p) : 1;
            }
            return n;
          };
          files += walk(r);
        } else files += 1;
      } catch {
        ok = false;
      }
    }
    const row = repo.db.prepare(
      'SELECT COUNT(*) n, SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) t FROM usage_event WHERE agent = ?'
    ).get(c.id) as any;
    const cur = repo.db.prepare('SELECT MAX(last_scan_at) t FROM file_cursor').get() as any;
    const state = !ok ? '路径不存在' : files === 0 ? '没有文件' : '可读';
    const tokens = row.t ? (row.t / 1e8).toFixed(2) + ' 亿' : '—';
    console.log(
      `  ${c.id.padEnd(12)} ${(ok ? '在' : '缺').padEnd(6)} ${String(files).padStart(5)} ` +
      `${String(row.n ?? 0).padStart(5)} ${tokens.padStart(9)}  ${cur.t ? new Date(cur.t).toLocaleString('zh-CN') : '从未'}`
    );
    if (!ok) console.log(`  ${' '.repeat(12)}└ 这个 agent 可能没装，扫描会跳过`);
  }

  const total = repo.total();
  console.log(`\n数据库      ${DB}`);
  console.log(`累计        ${total ? fmtTok(total.tokens, 'zh') + ' token' : '还没有数据，先跑 atracker scan'}`);
  repo.close();
} else {
  console.log(`ATracker

  atracker scan [--source codex] [--trigger manual]   扫描本机 agent 的用量日志
  atracker stats                                     看累计用量
  atracker sync export|import [--dir <目录>]          多设备同步：导出自己的 rollup / 导入别人的
  atracker reconcile                                 拿各来源的汇总数据对账
  atracker doctor                                    看各来源是否可读`);
}
