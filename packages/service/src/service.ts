// 应用服务：数据库、扫描编排、文件监听、多设备同步。
//
// 这里不含任何传输层代码。桌面版主进程直接持有这个对象，查询走 handlers.ts，
// 命令行直接开 Repo，不经过服务。

import { existsSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { Repo, type LogLevel } from '../../storage/src/repo.ts';
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
  /**
   * 一轮扫描的限制，毫秒。默认 120 秒。
   * 正常批次是 0.5–3 秒，大文件全量重扫也只是几十秒，超过这个数就是卡住了。
   */
  scanTimeoutMs?: number;
}

/**
 * 服务向界面推的事件。原先是 SSE，现在由主进程转发给窗口。
 *
 * 丢一条不会损坏数据：界面收到 scan_done 只是重新取数，漏了最多晚一轮刷新。
 */
export type ServiceEventListener = (event: PushEvent) => void;

/**
 * 一轮扫描最多允许多久（默认值）。正常情况下一个批次是 0.5–3 秒，遇到大文件全量重扫
 * 也只是几十秒，所以 120 秒是「肯定出问题了」的阈值。超过就放弃这一轮，
 * 不让一个卡住的扫描把服务焊死。测试可以传 scanTimeoutMs 改小。
 */
const DEFAULT_SCAN_TIMEOUT_MS = 120_000;

/**
 * 一轮同步最多允许多久。iCloud 这类目录卡住时，read/write 会挂在核里不返回，
 * 这时调用方不能跟着一起等——超时后先放过这一轮，界面上能看出同步停了。
 */
const SYNC_TIMEOUT_MS = 20_000;

export class ATrackerService {
  readonly repo: Repo;
  device: DeviceInfo;
  syncDir: string | null;
  private readonly syncPollMs: number;
  private readonly opts: Required<Pick<ServiceOptions, 'watch' | 'debounceMs' | 'pollMs' | 'scanTimeoutMs'>>;
  private listeners = new Set<ServiceEventListener>();
  private watchers: FSWatcher[] = [];
  private scanTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private scanning = false;
  private dirty = false;
  /** 扫描代际。判定超时后，旧那一轮晚到的结果直接丢弃。 */
  private scanGeneration = 0;
  /** 本进程已经完整导出过的月份。导出按月份增量，不再每轮重写全部历史。 */
  private exportedMonths = new Set<string>();
  /** 正在进行的同步。同一个时刻只允许一轮：卡住时不能让下一轮再叠上去占线程池。 */
  private syncRunning: Promise<unknown> | null = null;
  private closed = false;

  /** 同步状态，给界面显示用 */
  lastExportAt: number | null = null;
  lastExportFiles: string[] = [];
  lastImportAt: number | null = null;
  lastImport: ImportSummary | null = null;
  /** 最后一次同步失败/超时的原因。界面和状态接口都读它。 */
  lastSyncError: string | null = null;
  /** 最近一次扫描的开始/结束时刻，状态接口用它判断「扫描是不是卡住了」。 */
  lastScanStartedAt: number | null = null;
  lastScanFinishedAt: number | null = null;
  /** 最后一次发出事件的时间。页面据此判断「数据多久没更新了」。 */
  lastEventAt: number | null = null;

  constructor(opts: ServiceOptions) {
    this.repo = new Repo(opts.dbPath);
    // 本机身份：记进 device 表，顺手把升级前没有归属的历史行认领给本机。
    this.device = loadDevice();
    this.repo.touchDevice(this.device);
    this.repo.claimUnassigned(this.device.id);
    this.opts = {
      watch: opts.watch ?? true,
      debounceMs: opts.debounceMs ?? 2000,
      pollMs: opts.pollMs ?? 5 * 60_000,
      scanTimeoutMs: opts.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS
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
    this.lastEventAt = Date.now();
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
      void this.importSync();
      this.syncTimer = setInterval(() => { void this.importSync(); }, this.syncPollMs);
      this.syncTimer.unref?.();
    }
  }

  async close(): Promise<void> {
    // 关掉之后不再接受新的扫描和同步：否则关库之后还有一次写入，会抛出没人接的错。
    this.closed = true;
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

  get scanTimeout(): number {
    return this.opts.scanTimeoutMs;
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
    if (this.closed) return;
    // 只重置去抖窗口。兜底轮询不能在这里清掉：清了没有地方重新 setInterval，
    // 5 分钟轮询会在第一次文件变化之后永久失效。
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => { void this.triggerScan('watch'); }, this.opts.debounceMs);
  }

  /**
   * 触发一次扫描。正在扫就记个标记，扫完再跑一次。
   *
   * 关键：扫描必须会结束。以前只要一轮不返回（卡在文件系统的 await 上），
   * `scanning` 就永远是 true，之后所有触发（包括 5 分钟兜底轮询）都变空操作，
   * 页面也就永远收不到新事件。现在给了超时和中止信号：超时后这一轮被丢弃、
   * 标记恢复，下一轮能真正跑起来。
   */
  async triggerScan(trigger: 'watch' | 'poll' | 'manual'): Promise<void> {
    if (this.closed) return;
    if (this.scanning) {
      this.dirty = true;
      return;
    }

    this.scanning = true;
    const generation = ++this.scanGeneration;
    const ac = new AbortController();
    const timeoutMs = this.opts.scanTimeoutMs;
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = Date.now();
    this.lastScanStartedAt = t0;
    let timedOut = false;

    try {
      const summary = await runScan(this.repo, { trigger, device: this.device, signal: ac.signal });
      if (generation !== this.scanGeneration) return; // 已被判超时，结果直接丢
      // 导出只写这轮动过的月份，历史月份不重写（iCloud 目录每 2 秒重写 6 个文件是灾难）
      await this.exportSync(summary.days);
      if (generation !== this.scanGeneration) return;
      this.lastScanFinishedAt = Date.now();
      this.emit({
        type: 'scan_done',
        batch: summary.batchId,
        eventsWritten: summary.eventsWritten,
        days: summary.days,
        durationMs: Date.now() - t0
      });
    } catch (err) {
      timedOut = ac.signal.aborted;
      const message = timedOut
        ? `扫描超过 ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`}未完成，已放弃这一轮`
        : (err as Error).message;
      this.logLine('err', '扫描', message);
      this.emit({ type: 'scan_error', message });
    } finally {
      clearTimeout(timer);
      // 只有「还是当前这一代」才能解锁：超时后已经开了新的一轮，不能把它的标记清掉。
      if (generation === this.scanGeneration) {
        this.scanning = false;
        if (timedOut) {
          // 超时后不立即重跑（否则卡住时变成热循环），等下一次文件变化或轮询触发
          this.dirty = false;
        }
        if (this.dirty) {
          this.dirty = false;
          void this.triggerScan(trigger);
        }
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
    this.lastSyncError = null;
    // 换了目录，之前导过的月份不算了，下一次导出重新写全量
    this.exportedMonths.clear();
    if (!dir) return;
    this.lastImport = null;
    this.lastImportAt = null;
    this.lastExportAt = null;
    this.lastExportFiles = [];
    void this.importSync();
    void this.exportSync([]);
    this.syncTimer = setInterval(() => { void this.importSync(); }, this.syncPollMs);
    this.syncTimer.unref?.();
  }

  get syncPollInterval(): number {
    return this.syncPollMs;
  }

  get isSyncing(): boolean {
    return this.syncRunning !== null;
  }

  /** 写一条服务自己的日志。退出过程中库可能已经关了，不能因此再抛一次。 */
  private logLine(level: LogLevel, source: string, message: string): void {
    try {
      this.repo.log(0, Date.now(), level, source, message);
    } catch {
      // 库已经关了（退出中），记不下就算了
    }
  }

  /**
   * 记一次同步问题。同一个错误只写一行日志：
   * 同步目录不可用时每 60 秒会试一次，不去重的话一晚上就能把 5000 行的日志冲掉。
   */
  private noteSyncError(message: string): void {
    if (this.lastSyncError === message) return;
    this.lastSyncError = message;
    this.logLine('warn', '同步', message);
  }

  /**
   * 同一时刻只允许一轮同步，且调用方最多等 SYNC_TIMEOUT_MS。
   *
   * 卡在 iCloud 里的调用无法被真正杀掉，所以这里有意「不排队」：上一轮还没回来就
   * 跳过本轮。这样最多只会有一轮卡在看，不会每 60 秒再叠一轮把 libuv 的线程池占满。
   * 能返回的错（权限、目录被删）仍然写进 lastSyncError，页面上看得出来。
   */
  private startSync<T>(
    what: string,
    job: (signal: AbortSignal) => Promise<T>
  ): Promise<T | null> | null {
    if (this.closed || !this.syncDir || this.syncRunning) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), SYNC_TIMEOUT_MS);
    const run = (async (): Promise<T | null> => {
      try {
        return await job(ac.signal);
      } catch (err) {
        const message = ac.signal.aborted
          ? `${what}超过 ${Math.round(SYNC_TIMEOUT_MS / 1000)} 秒未完成`
          : `${what}失败：${(err as Error).message}`;
        this.noteSyncError(message);
        return null;
      } finally {
        clearTimeout(timer);
        this.syncRunning = null;
      }
    })();
    this.syncRunning = run;
    return run;
  }

  /** 调用方不等超过 SYNC_TIMEOUT_MS + 1 秒；旧那一轮晚到的结果由 startSync 自己丢。 */
  private async waitBounded<T>(run: Promise<T | null>): Promise<T | null> {
    let timer: NodeJS.Timeout | undefined;
    const stalled = new Promise<null>(resolve => {
      timer = setTimeout(() => {
        this.noteSyncError(`同步超过 ${Math.round(SYNC_TIMEOUT_MS / 1000)} 秒仍未返回，本轮先放过`);
        resolve(null);
      }, SYNC_TIMEOUT_MS + 1_000);
    });
    try {
      return await Promise.race([run, stalled]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 把本机数据写成 rollup 文件。`days` 是这一轮扫描动过的自然日，
   * 只有落在里面的月份才重写；本进程第一次导出时写全量。
   */
  private async exportSync(days: string[]): Promise<void> {
    if (!this.syncDir) return;
    const months = new Set(days.map(d => d.slice(0, 7)));
    const full = this.exportedMonths.size === 0;
    const run = this.startSync('导出', signal => exportRollup(this.repo, this.device, this.syncDir!, {
      months: full ? undefined : [...months],
      signal
    }));
    if (!run) return;
    const files = await this.waitBounded(run);
    if (files) {
      this.lastExportFiles = files;
      this.lastExportAt = Date.now();
      for (const m of months) this.exportedMonths.add(m);
      if (full) {
        // 全量那一轮把历史月份都写过了；记下来，后续不再重写
        for (const f of files) {
          const m = f.match(/-(\d{4}-\d{2})\.jsonl$/)?.[1];
          if (m) this.exportedMonths.add(m);
        }
      }
    }
  }

  /** 读目录里其它设备的文件，导入本机库。 */
  async importSync(): Promise<void> {
    if (!this.syncDir) return;
    const run = this.startSync('导入', signal => importRollups(this.repo, this.syncDir!, this.device.id, { signal }));
    if (!run) return;
    const summary = await this.waitBounded(run);
    if (!summary) return;
    this.lastImport = summary;
    this.lastImportAt = Date.now();
    // 读目录、读文件、校验失败的明细在 errors 里：同步面板和日志页都要看得到。
    // 不是抛错，所以不能只靠 startSync 的 catch。
    if (summary.errors.length) this.noteSyncError(`导入：${summary.errors[0]}`);
    else this.lastSyncError = null;
    const changed = summary.aggRows + summary.sessionRows;
    if (changed > 0) this.emit({ type: 'sync_done', devices: summary.devices.map(d => d.id), rows: changed });
  }

  /** 改本机显示名。菜单和「同步」面板都走这里。 */
  renameDevice(name: string): DeviceInfo {
    this.device = saveDeviceName(name);
    this.repo.touchDevice(this.device);
    // 导出文件里带设备名，改完要把所有月份重写一遍（下次扫描时做）
    this.exportedMonths.clear();
    void this.exportSync([]);
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
