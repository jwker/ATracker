// 应用服务：数据库、扫描编排、文件监听、多设备同步。
//
// 这里不含任何传输层代码。桌面版主进程直接持有这个对象，查询走 handlers.ts，
// 命令行直接开 Repo，不经过服务。

import { existsSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { Repo } from '../../storage/src/repo.ts';
import { runScan } from '../../collectors/src/scanner.ts';
import { loadDevice, saveDeviceName, type DeviceInfo } from '../../core/src/device.ts';
import { exportRollup, importRollups, type ImportSummary } from '../../storage/src/sync.ts';
import type { PushEvent } from '../../core/src/api.ts';

export interface ServiceOptions {
  dbPath: string;
  /** 是否监听文件变化自动扫描，默认开启 */
  watch?: boolean;
  /** 扫描去抖窗口，毫秒。默认 2000。 */
  debounceMs?: number;
  /** 兜底轮询间隔，毫秒。0 表示关掉。默认 5 分钟。 */
  pollMs?: number;
  /** 多设备同步目录。不给就关掉同步（不读也不写）。 */
  syncDir?: string | null;
  /** 同步目录的轮询间隔，毫秒。默认 60 秒。 */
  syncPollMs?: number;
}

/**
 * 服务向界面推的事件。原先是 SSE，现在由主进程转发给窗口。
 *
 * 丢一条不会损坏数据：界面收到 scan_done 只是重新取数，漏了最多晚一轮刷新。
 */
export type ServiceEventListener = (event: PushEvent) => void;

export class ATrackerService {
  readonly repo: Repo;
  device: DeviceInfo;
  syncDir: string | null;
  private readonly syncPollMs: number;
  private readonly opts: Required<Pick<ServiceOptions, 'watch' | 'debounceMs' | 'pollMs'>>;
  private listeners = new Set<ServiceEventListener>();
  private watchers: FSWatcher[] = [];
  private scanTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private scanning = false;
  private dirty = false;

  /** 同步状态，给界面显示用 */
  lastExportAt: number | null = null;
  lastExportFiles: string[] = [];
  lastImportAt: number | null = null;
  lastImport: ImportSummary | null = null;

  constructor(opts: ServiceOptions) {
    this.repo = new Repo(opts.dbPath);
    // 本机身份：记进 device 表，顺手把升级前没有归属的历史行认领给本机。
    this.device = loadDevice();
    this.repo.touchDevice(this.device);
    this.repo.claimUnassigned(this.device.id);
    this.opts = {
      watch: opts.watch ?? true,
      debounceMs: opts.debounceMs ?? 2000,
      pollMs: opts.pollMs ?? 5 * 60_000
    };
    this.syncDir = opts.syncDir ?? null;
    this.syncPollMs = opts.syncPollMs ?? 60_000;
  }

  /** 订阅事件。返回取消订阅的函数。 */
  onEvent(listener: ServiceEventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: PushEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* 订阅方自己的错，不能影响服务 */ }
    }
  }

  /** 启动监听、轮询和同步。窗口和 IPC 由调用方负责。 */
  start(): void {
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
  }

  async close(): Promise<void> {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.scanTimer) clearTimeout(this.scanTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.listeners.clear();
    this.repo.close();
  }

  get isScanning(): boolean {
    return this.scanning;
  }

  get watchCount(): number {
    return this.watchers.length;
  }

  get pollInterval(): number {
    return this.opts.pollMs;
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
      this.emit({
        type: 'scan_done',
        batch: summary.batchId,
        eventsWritten: summary.eventsWritten,
        days: summary.days,
        durationMs: Date.now() - t0
      });
    } catch (err) {
      this.emit({ type: 'scan_error', message: (err as Error).message });
    } finally {
      this.scanning = false;
      if (this.dirty) {
        this.dirty = false;
        void this.triggerScan(trigger);
      }
    }
  }

  /* ---------- 多设备同步 ---------- */

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

  get syncPollInterval(): number {
    return this.syncPollMs;
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
  importSync(): void {
    if (!this.syncDir) return;
    try {
      const summary = importRollups(this.repo, this.syncDir, this.device.id);
      this.lastImport = summary;
      this.lastImportAt = Date.now();
      const changed = summary.aggRows + summary.sessionRows;
      if (changed > 0) this.emit({ type: 'sync_done', devices: summary.devices.map(d => d.id), rows: changed });
    } catch (err) {
      this.repo.log(0, Date.now(), 'warn', '同步', `导入失败：${(err as Error).message}`);
    }
  }

  /** 改本机显示名。菜单和「同步」面板都走这里。 */
  renameDevice(name: string): DeviceInfo {
    this.device = saveDeviceName(name);
    this.repo.touchDevice(this.device);
    return this.device;
  }

  /**
   * 设备过滤参数。没带就是本机；`device=all` 是全部设备；
   * 其它值是具体的设备 id。
   */
  deviceFilter(q: URLSearchParams): string | undefined {
    const v = q.get('device');
    if (v === 'all') return undefined;
    return v || this.device.id;
  }
}

export function searchParamsOf(
  params: Record<string, string | number | boolean | null | undefined> | undefined
): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== null && v !== undefined) q.set(k, String(v));
  }
  return q;
}
