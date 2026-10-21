// ATracker 命令行。
//   atracker scan [--source codex] [--trigger manual]
//   atracker stats
//   atracker pricing
//   atracker doctor

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Repo } from '../../storage/src/repo.ts';
import { Pricing } from '../../core/src/pricing.ts';
import { loadCollectors, runScan } from '../../collectors/src/scanner.ts';
import { localMonth } from '../../core/src/time.ts';
import { fmtTok } from '../../core/src/units.ts';
import { reconcile } from './reconcile.ts';
import { ATrackerServer } from '../../server/src/app.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DB = join(root, 'data', 'atracker.db');
const PRICING = join(root, 'config', 'pricing.json');

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
  const pricing = Pricing.load(PRICING);
  const t0 = Date.now();
  const s = await runScan(repo, pricing, { trigger, only });
  console.log(`批次 ${s.batchId} · 耗时 ${Date.now() - t0}ms`);
  console.log(`  读取 ${s.eventsRead} 条事件，落库 ${s.eventsWritten} 条，覆盖 ${s.days.length} 天`);
  if (s.errors) console.log(`  错误 ${s.errors} 个`);
  const total = repo.total();
  if (total) {
    console.log(`  累计 ${fmtTok(total.tokens, 'zh')} token · ¥${total.cost_cny.toFixed(2)}`);
    if (total.unpriced_tokens > 0) {
      console.log(`  ${fmtTok(total.unpriced_tokens, 'zh')} token 未计价（模型缺价）`);
    }
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
    console.log(`成本        ¥${t.cost_cny.toFixed(2)}  $${t.cost_usd.toFixed(2)}`);
    if (t.unpriced_tokens > 0) console.log(`未计价      ${fmtTok(t.unpriced_tokens, 'zh')}`);
  }
  repo.close();
} else if (cmd === 'pricing') {
  const pricing = Pricing.load(PRICING);
  const repo = openRepo();
  const models = repo.db.prepare('SELECT model, COUNT(*) n, SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) t FROM usage_event GROUP BY model ORDER BY t DESC').all() as any[];
  console.log('模型                          用量            价格');
  for (const m of models) {
    const r = pricing.resolve(m.model, null);
    const label = r ? `${r.label}${r.kind === 'exact' ? '' : '（' + r.kind + '）'}` : '未配置';
    console.log(`  ${m.model.padEnd(26)} ${fmtTok(m.t, 'zh').padEnd(14)} ${label}`);
  }
  repo.close();
} else if (cmd === 'serve') {
  const port = Number(arg('port') ?? 4178);
  const server = new ATrackerServer({
    dbPath: DB,
    pricingPath: PRICING,
    port,
    watch: !process.argv.includes('--no-watch')
  });
  const url = await server.start();
  console.log(`ATracker 已启动：${url}`);
  console.log(`  数据库 ${DB}`);
  console.log(`  监听文件变化自动扫描，关掉用 --no-watch`);
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
  const collectors = await loadCollectors();
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

  // 缺价的模型
  const missing = repo.db.prepare(
    `SELECT model, SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) t
     FROM usage_event WHERE cost_cny IS NULL GROUP BY model ORDER BY t DESC`
  ).all() as any[];
  if (missing.length) {
    console.log('\n没有价格的模型（成本留空，不按 0 计）');
    for (const m of missing) console.log(`  ${m.model.padEnd(28)} ${(m.t / 1e4).toFixed(1)} 万 token`);
  }

  const total = repo.total();
  console.log(`\n数据库      ${DB}`);
  console.log(`价格表      ${PRICING}`);
  console.log(`累计        ${total ? fmtTok(total.tokens, 'zh') + ' token' : '还没有数据，先跑 atracker scan'}`);
  repo.close();
} else {
  console.log(`ATracker

  atracker scan [--source codex] [--trigger manual]   扫描本机 agent 的用量日志
  atracker stats                                     看累计用量和成本
  atracker pricing                                   看哪些模型缺价
  atracker reconcile                                 拿各来源的汇总数据对账
  atracker serve [--port 4178] [--no-watch]         启动本地服务
  atracker doctor                                    看各来源是否可读`);
}
