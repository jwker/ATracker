// ATracker 命令行。
//   atracker scan [--source codex] [--trigger manual]
//   atracker stats
//   atracker doctor

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { execFileSync } from 'node:child_process';

import { Repo } from '../../storage/src/repo.ts';
import { COLLECTORS, runScan } from '../../collectors/src/scanner.ts';
import { localMonth } from '../../core/src/time.ts';
import { fmtTok } from '../../core/src/units.ts';
import { reconcile } from './reconcile.ts';
import { ATrackerServer } from '../../server/src/app.ts';

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

/**
 * 本机在局域网里的地址。服务监听 0.0.0.0 时，这些地址都能打开。
 * 第一个是默认路由所在的网卡，也就是手机上通常能连上的那个。
 */
function lanAddresses(): string[] {
  const all: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) all.push(ni.address);
    }
  }
  const primary = primaryAddress();
  if (!primary) return all;
  return [primary, ...all.filter(a => a !== primary)];
}

/** 默认路由所在的网卡地址。拿不到就退到第一个非内部网卡。 */
function primaryAddress(): string | undefined {
  // route 是 macOS 的命令。其他平台直接跳过，退到第一个非内部网卡。
  if (process.platform !== 'darwin') return undefined;
  try {
    const out = execFileSync('route', ['-n', 'get', 'default'], { encoding: 'utf8' });
    const name = out.match(/interface:\s*(\S+)/)?.[1];
    if (name) {
      const hit = (networkInterfaces()[name] ?? []).find(ni => ni.family === 'IPv4' && !ni.internal);
      if (hit) return hit.address;
    }
  } catch {
    // 不是 macOS 或没有默认路由
  }
  for (const list of Object.values(networkInterfaces())) {
    const hit = (list ?? []).find(ni => ni.family === 'IPv4' && !ni.internal);
    if (hit) return hit.address;
  }
  return undefined;
}

const cmd = process.argv[2] ?? 'help';

if (cmd === 'scan') {
  const only = arg('source')?.split(',').map(s => s.trim()).filter(Boolean);
  const trigger = (arg('trigger') as 'watch' | 'poll' | 'manual') ?? 'manual';
  const repo = openRepo();
  const t0 = Date.now();
  const s = await runScan(repo, { trigger, only });
  console.log(`批次 ${s.batchId} · 耗时 ${Date.now() - t0}ms`);
  console.log(`  读取 ${s.eventsRead} 条事件，落库 ${s.eventsWritten} 条，覆盖 ${s.days.length} 天`);
  if (s.errors) console.log(`  错误 ${s.errors} 个`);
  const total = repo.total();
  if (total) {
    console.log(`  累计 ${fmtTok(total.tokens, 'zh')} token`);
  }
  const first = repo.recentBatches(1)[0];
  if (first && first.id <= 2) {
    console.log('\n  起服务看界面：npm run serve   →  http://127.0.0.1:4178');
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
} else if (cmd === 'serve') {
  const port = Number(arg('port') ?? 4178);
  // 默认监听所有网卡，局域网里的设备可以用本机 IP 打开。
  const host = arg('host') ?? '0.0.0.0';
  const server = new ATrackerServer({
    dbPath: DB,
    port,
    host,
    watch: !process.argv.includes('--no-watch')
  });
  const addr = await server.start();
  console.log(`ATracker 已启动：监听 ${addr.host}:${addr.port}`);
  const addrs = lanAddresses();
  if (addr.host === '0.0.0.0') {
    if (addrs.length) {
      console.log(`  局域网访问 http://${addrs[0]}:${addr.port}`);
      if (addrs.length > 1) {
        console.log(`  其他网卡   ${addrs.slice(1).map(a => `http://${a}:${addr.port}`).join('  ')}`);
      }
    } else {
      console.log('  没有找到局域网地址，只能本机访问');
    }
  } else {
    console.log(`  只给本机访问：${addr.url}`);
  }
  console.log(`  数据库 ${DB}`);
  console.log(`  监听文件变化自动扫描，关掉用 --no-watch`);
  console.log(`  只给本机访问用 --host 127.0.0.1`);
  console.log('  Ctrl-C 退出');
  const shutdown = async () => { console.log('\n正在退出…'); await server.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
  atracker reconcile                                 拿各来源的汇总数据对账
  atracker serve [--port 4178] [--host 0.0.0.0] [--no-watch]   启动本地服务
  atracker doctor                                    看各来源是否可读`);
}
