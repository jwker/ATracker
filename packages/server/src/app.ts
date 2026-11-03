// HTTP 接口。只读为主，写操作只有触发扫描。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { watch, type FSWatcher } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { Repo } from '../../storage/src/repo.ts';
import { COLLECTORS, runScan } from '../../collectors/src/scanner.ts';
import { deviceFilePath, loadDevice, saveDeviceName, type DeviceInfo } from '../../core/src/device.ts';
import { exportRollup, importRollups, type ImportSummary } from '../../storage/src/sync.ts';
import { buildInfo } from '../../core/src/build.ts';
import {
  aggregatePayload, calendarPayload, conversationsPayload, conversationPayload,
  dayPayload, logPayload, matrixPayload, totalPayload
} from './queries.ts';

export interface ServerOptions {
  dbPath: string;
  /** 前端静态目录，默认 packages/web/dist（Vite 构建产物） */
  webDir?: string;
  port?: number;
  host?: string;
  /** 是否监听文件变化自动扫描 */
  watch?: boolean;
  /** 扫描去抖窗口，毫秒 */
  debounceMs?: number;
  /** 兜底轮询间隔，毫秒。0 表示关掉 */
  pollMs?: number;
  /** 多设备同步目录。不给就关掉同步（不读也不写）。 */
  syncDir?: string | null;
  /** 同步目录的轮询间隔，毫秒。默认 60 秒。 */
  syncPollMs?: number;
}

interface Client {
  res: ServerResponse;
}

/** 写接口的请求体上限。写接口只传一个 id 或一个设备名，几 KB 就够。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 每个响应都带的安全头。页面里有本机用量，XSS 的后果比一般站点大。 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
};

/** 会改数据的接口。只有这几个需要检查请求来源。 */
const WRITE_PATHS = new Set(['/api/scan', '/api/sync/ignore', '/api/sync/restore', '/api/device/name']);

export class ATrackerServer {
  private repo: Repo;
  private device: DeviceInfo;
  private opts: Required<Pick<ServerOptions, 'port' | 'host' | 'watch' | 'debounceMs' | 'pollMs'>>;
  private syncDir: string | null;
  private syncPollMs: number;
  private syncTimer: NodeJS.Timeout | null = null;
  private lastExportAt: number | null = null;
  private lastExportFiles: string[] = [];
  private lastImportAt: number | null = null;
  private lastImport: ImportSummary | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private clients = new Set<Client>();
  private watchers: FSWatcher[] = [];
  private scanTimer: NodeJS.Timeout | null = null;
  private scanning = false;
  private dirty = false;
  private server = createServer();
  private webDir: string;

  constructor(opts: ServerOptions) {
    this.repo = new Repo(opts.dbPath);
    // 本机身份：记进 device 表，顺手把升级前没有归属的历史行认领给本机。
    this.device = loadDevice();
    this.repo.touchDevice(this.device);
    this.repo.claimUnassigned(this.device.id);
    this.opts = {
      // 端口 0 表示让系统分配一个空闲端口，桌面版用它避让已占用的端口。
      port: opts.port ?? 4178,
      // 默认只监听本机。要给局域网看就显式传 0.0.0.0。
      host: opts.host ?? '127.0.0.1',
      watch: opts.watch ?? true,
      debounceMs: opts.debounceMs ?? 2000,
      pollMs: opts.pollMs ?? 5 * 60_000
    };
    this.syncDir = opts.syncDir ?? null;
    this.syncPollMs = opts.syncPollMs ?? 60_000;
    this.webDir = opts.webDir ?? join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  }

  /** 启动服务。返回实际监听的地址和端口（传 port: 0 时端口是系统分配的）。 */
  async start(): Promise<{ url: string; host: string; port: number }> {
    // 请求处理里的异常不能变成 unhandled rejection（进程会挂）。
    this.server.on('request', (req, res) => {
      this.handle(req, res).catch(err => {
        this.repo.log(0, Date.now(), 'err', 'server', `请求处理失败：${(err as Error).message}`);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '服务器内部错误' }));
      });
    });
    this.server.on('error', err => {
      this.repo.log(0, Date.now(), 'err', 'server', `HTTP 服务出错：${(err as Error).message}`);
    });
    if (this.opts.watch) this.startWatchers();
    if (this.opts.pollMs > 0) {
      // 兜底轮询：监听可能丢事件，周期性全量对一遍指纹
      this.pollTimer = setInterval(() => { void this.triggerScan('poll'); }, this.opts.pollMs);
      this.pollTimer.unref?.();
    }
    if (this.syncDir) {
      // 启动先读一遍别人的文件，再定期对表。
      this.importSync();
      this.syncTimer = setInterval(() => this.importSync(), this.syncPollMs);
      this.syncTimer.unref?.();
    }
    await new Promise<void>(resolve => this.server.listen(this.opts.port, this.opts.host, resolve));
    const addr = this.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
    return { url: `http://${this.opts.host}:${port}`, host: this.opts.host, port };
  }

  async close(): Promise<void> {
    for (const w of this.watchers) w.close();
    if (this.scanTimer) clearTimeout(this.scanTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    for (const c of this.clients) { try { c.res.end(); } catch { /* 已断开 */ } }
    this.clients.clear();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    this.repo.close();
  }

  /* ---------- 事件推送 ---------- */

  private broadcast(type: string, data: unknown): void {
    const payload = `data: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
    for (const c of this.clients) {
      try { c.res.write(payload); } catch { this.clients.delete(c); }
    }
  }

  /* ---------- 文件监听 ---------- */

  private startWatchers(): void {
    const roots = [
      join(homedir(), '.codex', 'sessions'),
      join(homedir(), '.claude', 'projects'),
      join(homedir(), '.pi', 'agent', 'sessions'),
      join(homedir(), '.dsh', 'sessions'),
      join(homedir(), '.local', 'share', 'opencode')
    ];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      try {
        const w = watch(root, { recursive: true }, () => this.scheduleScan());
        w.on('error', () => { /* 目录被删就放弃这个监听，靠轮询兜底 */ });
        this.watchers.push(w);
      } catch (err) {
        console.error(`监听 ${root} 失败：${(err as Error).message}`);
      }
    }
  }

  private scheduleScan(): void {
    // 只重置去抖窗口。兜底轮询不能在这里清掉：清了没有地方重新 setInterval，
    // 5 分钟轮询会在第一次文件变化之后永久失效。
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => { void this.triggerScan('watch'); }, this.opts.debounceMs);
  }

  /** 触发一次扫描。正在扫就记个标记，扫完再跑一次。 */
  async triggerScan(trigger: 'watch' | 'poll' | 'manual'): Promise<void> {
    if (this.scanning) {
      this.dirty = true;
      return;
    }
    this.scanning = true;
    const t0 = Date.now();
    try {
      const summary = await runScan(this.repo, { trigger, device: this.device });
      this.exportSync();
      this.broadcast('scan_done', {
        batch: summary.batchId,
        eventsWritten: summary.eventsWritten,
        days: summary.days,
        durationMs: Date.now() - t0
      });
    } catch (err) {
      this.broadcast('scan_error', { message: (err as Error).message });
    } finally {
      this.scanning = false;
      if (this.dirty) {
        this.dirty = false;
        void this.triggerScan(trigger);
      }
    }
  }

  /** 运行时开关同步。桌面版菜单用它，不用重启进程。 */
  setSyncDir(dir: string | null): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.syncDir = dir;
    if (!dir) return;
    this.lastImport = null;
    this.lastImportAt = null;
    this.lastExportAt = null;
    this.lastExportFiles = [];
    this.importSync();
    this.exportSync();
    this.syncTimer = setInterval(() => this.importSync(), this.syncPollMs);
    this.syncTimer.unref?.();
  }

  /** 把本机数据写成 rollup 文件。同步目录没开就什么也不做。 */
  private exportSync(): void {
    if (!this.syncDir) return;
    try {
      this.lastExportFiles = exportRollup(this.repo, this.device, this.syncDir);
      this.lastExportAt = Date.now();
    } catch (err) {
      this.repo.log(0, Date.now(), 'warn', '同步', `导出失败：${(err as Error).message}`);
    }
  }

  /** 读目录里其它设备的文件，导入本机库。 */
  private importSync(): void {
    if (!this.syncDir) return;
    try {
      const summary = importRollups(this.repo, this.syncDir, this.device.id);
      this.lastImport = summary;
      this.lastImportAt = Date.now();
      const changed = summary.aggRows + summary.sessionRows;
      if (changed > 0) this.broadcast('sync_done', { devices: summary.devices.map(d => d.id), rows: changed });
    } catch (err) {
      this.repo.log(0, Date.now(), 'warn', '同步', `导入失败：${(err as Error).message}`);
    }
  }

  /**
   * 设备过滤参数。URL 里没带就是本机；`device=all` 是全部设备；
   * 其它值是具体的设备 id。
   */
  private deviceFilter(q: URLSearchParams): string | undefined {
    const v = q.get('device');
    if (v === 'all') return undefined;
    return v || this.device.id;
  }

  /**
   * 请求来源是否允许。
   *
   * 有 Origin 就必须和 Host 同源（协议、主机、端口全一样）。
   * 没有 Origin 的（curl、桌面版自己的请求）一律放行。
   */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    const host = req.headers.host;
    if (!host) return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  /** 读 JSON 请求体。只给几个小的写接口用。 */
  private async body(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      // 写接口只传一个 id 或一个设备名，几 KB 就够。
      // 不限制的话一个请求就能把内存吃光。
      if (size > MAX_BODY_BYTES) throw new Error('请求体太大');
      chunks.push(chunk as Buffer);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return {};
    }
  }

  /** 返回 true 表示这个请求已经处理完。 */
  private async serveStatic(p: string, res: ServerResponse): Promise<boolean> {
    if (p.startsWith('/api/')) return false;
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const target = join(this.webDir, normalize(rel));
    // 判断是不是在 webDir 里面。用 relative() 而不是 startsWith()：
    // 前缀匹配会把 /data/web/dist-evil 也算进来。
    const inside = relative(this.webDir, target);
    if (inside.startsWith('..') || isAbsolute(inside)) return false;
    if (!existsSync(target) || !statSync(target).isFile()) return false;

    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.woff2': 'font/woff2'
    };
    const body = await readFile(target);
    const type = types[extname(target)] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS
    });
    res.end(body);
    return true;
  }

  /* ---------- 路由 ---------- */

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const p = url.pathname;
    const q = url.searchParams;

    // 写接口检查请求来源。浏览器发的请求带 Origin，同源才放行；
    // 命令行工具（curl 等）不带 Origin，也放行。
    // 没有这一步的话，任意网页都能用简单跨站 POST 改本机的数据：
    // 「简单请求」不触发 CORS 预检，响应读不到但副作用已经产生。
    if (WRITE_PATHS.has(p) && !this.originAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
      res.end(JSON.stringify({ error: '请求来源不被允许' }));
      return;
    }

    // SSE
    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write(': connected\n\n');
      const client: Client = { res };
      this.clients.add(client);
      req.on('close', () => { this.clients.delete(client); });
      return;
    }

    const json = (data: unknown, code = 200) => {
      const body = JSON.stringify(data);
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
        ...SECURITY_HEADERS
      });
      res.end(body);
    };

    try {
      if (p === '/api/status') {
        const total = totalPayload(this.repo);
        return json({
          ok: true,
          build: buildInfo(),
          total,
          hasData: total.total > 0,
          scanning: this.scanning,
          clients: this.clients.size,
          watched: this.watchers.length,
          pollMs: this.opts.pollMs
        });
      }
      if (p === '/api/total') return json(totalPayload(this.repo, this.deviceFilter(q)));
      if (p === '/api/calendar') {
        return json(calendarPayload(this.repo, q.get('month') ?? new Date().toISOString().slice(0, 7), this.deviceFilter(q)));
      }
      if (p === '/api/aggregate') {
        return json(aggregatePayload(this.repo, q.get('from'), q.get('to'), q.get('all') === '1', this.deviceFilter(q)));
      }
      if (p === '/api/matrix') {
        return json(matrixPayload(this.repo, q.get('from'), q.get('to'), q.get('all') === '1', this.deviceFilter(q)));
      }
      if (p === '/api/day') {
        return json(dayPayload(this.repo, q.get('date'), this.deviceFilter(q), this.device.id));
      }
      if (p === '/api/conversations') {
        return json(conversationsPayload(this.repo, {
          dir: q.get('dir'), agent: q.get('agent'), model: q.get('model'),
          vendor: q.get('vendor'), q: q.get('q')
        }));
      }
      if (p === '/api/conversation') {
        const id = q.get('id') ?? '';
        if (!id) return json({ error: '缺少 id' }, 400);
        // 带 device 的话只查那台设备的会话。列表页把本机和远端的会话混在一起，
        // 不带设备参数会拿到另一台设备上同名 session_id 的数据。
        return json(conversationPayload(this.repo, id, 200, q.get('device')));
      }
      if (p === '/api/logs') {
        const batch = q.get('batch');
        return json(logPayload(this.repo, {
          batch: batch ? Number(batch) : null,
          level: q.get('level'), source: q.get('source'), q: q.get('q')
        }));
      }
      if (p === '/api/scan/batches') return json({ batches: this.repo.recentBatches(50) });
      if (p === '/api/sync') {
        return json({
          dir: this.syncDir,
          enabled: this.syncDir !== null,
          pollMs: this.syncPollMs,
          lastExportAt: this.lastExportAt,
          lastExportFiles: this.lastExportFiles,
          lastImportAt: this.lastImportAt,
          lastImport: this.lastImport,
          // 每台设备在本机库里占多少 token：排查「数字翻倍」时一眼能看出是哪台
          devices: this.repo.devices().map((d: any) => ({
            ...d,
            local: d.id === this.device.id,
            tokens: (this.repo.db.prepare(
              'SELECT COALESCE(SUM(tokens),0) t FROM agg_day_agent WHERE device = ?'
            ).get(d.id) as any).t
          }))
        });
      }
      if (p === '/api/devices') {
        return json({
          local: this.device,
          file: deviceFilePath(),
          devices: this.repo.devices()
        });
      }
      if (p === '/api/doctor') {
        return json({
          sources: COLLECTORS.map(c => {
            const roots = c.roots();
            const ok = roots.some(r => existsSync(r));
            return { id: c.id, label: c.label, roots, ok };
          })
        });
      }
      if (p === '/api/sync/ignore' && req.method === 'POST') {
        const b = await this.body(req);
        const id = typeof b.id === 'string' ? b.id : '';
        if (!id) return json({ error: '缺少 id' }, 400);
        if (id === this.device.id) return json({ error: '不能忽略本机' }, 400);
        this.repo.ignoreDevice(id);
        return json({ ok: true, ignored: true });
      }
      if (p === '/api/sync/restore' && req.method === 'POST') {
        const b = await this.body(req);
        const id = typeof b.id === 'string' ? b.id : '';
        if (!id) return json({ error: '缺少 id' }, 400);
        this.repo.restoreDevice(id);
        // 立刻尝试导一次，用户不用等下一轮轮询
        this.importSync();
        return json({ ok: true, ignored: false });
      }
      if (p === '/api/device/name' && req.method === 'POST') {
        const b = await this.body(req);
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        if (!name) return json({ error: '名字不能为空' }, 400);
        this.device = saveDeviceName(name);
        this.repo.touchDevice(this.device);
        return json({ ok: true, device: this.device });
      }
      if (p === '/api/scan' && req.method === 'POST') {
        void this.triggerScan('manual');
        return json({ ok: true, queued: true });
      }

      if (p === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      // 前端静态文件
      const served = await this.serveStatic(p, res);
      if (served) return;
      return json({ error: '没有这个接口', path: p }, 404);
    } catch (err) {
      const msg = (err as Error).message;
      // 请求体超限是客户端的问题，返回 413 而不是 500
      return json({ error: msg }, msg === '请求体太大' ? 413 : 500);
    }
  }
}
