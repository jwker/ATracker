// HTTP 接口。只读为主，写操作只有触发扫描。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { watch, type FSWatcher } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { Repo } from '../../storage/src/repo.ts';
import { COLLECTORS, runScan } from '../../collectors/src/scanner.ts';
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
}

interface Client {
  res: ServerResponse;
}

export class ATrackerServer {
  private repo: Repo;
  private opts: Required<Pick<ServerOptions, 'port' | 'host' | 'watch' | 'debounceMs' | 'pollMs'>>;
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
    this.opts = {
      // 端口 0 表示让系统分配一个空闲端口，桌面版用它避让已占用的端口。
      port: opts.port ?? 4178,
      // 默认只监听本机。要给局域网看就显式传 0.0.0.0。
      host: opts.host ?? '127.0.0.1',
      watch: opts.watch ?? true,
      debounceMs: opts.debounceMs ?? 2000,
      pollMs: opts.pollMs ?? 5 * 60_000
    };
    this.webDir = opts.webDir ?? join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  }

  /** 启动服务。返回实际监听的地址和端口（传 port: 0 时端口是系统分配的）。 */
  async start(): Promise<{ url: string; host: string; port: number }> {
    this.server.on('request', (req, res) => { void this.handle(req, res); });
    if (this.opts.watch) this.startWatchers();
    if (this.opts.pollMs > 0) {
      // 兜底轮询：监听可能丢事件，周期性全量对一遍指纹
      this.pollTimer = setInterval(() => { void this.triggerScan('poll'); }, this.opts.pollMs);
      this.pollTimer.unref?.();
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
      const summary = await runScan(this.repo, { trigger });
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

  /** 返回 true 表示这个请求已经处理完。 */
  private async serveStatic(p: string, res: ServerResponse): Promise<boolean> {
    if (p.startsWith('/api/')) return false;
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const target = join(this.webDir, normalize(rel));
    if (!target.startsWith(this.webDir)) return false;
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
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
    res.end(body);
    return true;
  }

  /* ---------- 路由 ---------- */

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const p = url.pathname;
    const q = url.searchParams;

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
        'Content-Length': Buffer.byteLength(body)
      });
      res.end(body);
    };

    try {
      if (p === '/api/status') {
        const total = totalPayload(this.repo);
        return json({
          ok: true,
          total,
          hasData: total.total > 0,
          scanning: this.scanning,
          clients: this.clients.size,
          watched: this.watchers.length,
          pollMs: this.opts.pollMs
        });
      }
      if (p === '/api/total') return json(totalPayload(this.repo));
      if (p === '/api/calendar') return json(calendarPayload(this.repo, q.get('month') ?? new Date().toISOString().slice(0, 7)));
      if (p === '/api/aggregate') {
        return json(aggregatePayload(this.repo, q.get('from'), q.get('to'), q.get('all') === '1'));
      }
      if (p === '/api/matrix') {
        return json(matrixPayload(this.repo, q.get('from'), q.get('to'), q.get('all') === '1'));
      }
      if (p === '/api/day') return json(dayPayload(this.repo, q.get('date')));
      if (p === '/api/conversations') {
        return json(conversationsPayload(this.repo, {
          dir: q.get('dir'), agent: q.get('agent'), model: q.get('model'),
          vendor: q.get('vendor'), q: q.get('q')
        }));
      }
      if (p === '/api/conversation') {
        const id = q.get('id') ?? '';
        if (!id) return json({ error: '缺少 id' }, 400);
        return json(conversationPayload(this.repo, id));
      }
      if (p === '/api/logs') {
        const batch = q.get('batch');
        return json(logPayload(this.repo, {
          batch: batch ? Number(batch) : null,
          level: q.get('level'), source: q.get('source'), q: q.get('q')
        }));
      }
      if (p === '/api/scan/batches') return json({ batches: this.repo.recentBatches(50) });
      if (p === '/api/doctor') {
        return json({
          sources: COLLECTORS.map(c => {
            const roots = c.roots();
            const ok = roots.some(r => existsSync(r));
            return { id: c.id, label: c.label, roots, ok };
          })
        });
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
      return json({ error: (err as Error).message }, 500);
    }
  }
}
