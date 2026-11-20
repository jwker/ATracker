// 应用服务：数据库、扫描编排、文件监听、多设备同步。
//
// 这里不含任何传输层代码。桌面版主进程直接持有这个对象，查询走 handlers.ts，
// 命令行直接开 Repo，不经过服务。

import { existsSync, watch, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';

import { Repo, type LogLevel } from '../../storage/src/repo.ts';
import { runScan, type ScanProgress, type ScanSummary } from '../../collectors/src/scanner.ts';
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
  /**
   * 运行时坏掉时的通知。
   *
   * 连续两轮扫描都卡在文件系统上（超时或者 fs 操作直接不返回），说明不是某个文件的问题，
   * 而是进程里的线程池坏了：这时重试没有意义，只能重启进程。桌面版接上这个回调去重启。
   */
  onUnhealthy?: (reason: string) => void;
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
 *
 * 60 秒而不是 20 秒：iCloud 正常但慢的时候，读一个 100KB 的文件实测要 2.5 秒，
 * 十个文件就是 25 秒。20 秒会把正常情况误判成卡住（11 月 18 日那次就是这样）。
 */
const SYNC_TIMEOUT_MS = 60_000;

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
  /** 连续超时次数。连续两次之后进入冷却，避免卡住时每两分钟重来一次。 */
  private consecutiveTimeouts = 0;
  /**
   * 连续「不健康」的轮次数：被看门狗放弃，或者采集时文件系统直接卡死。
   * 一个健康的轮次会清零。到 2 就认为是运行时坏了，通知外面重启进程。
   */
  private unhealthyRounds = 0;
  /** 冷却到什么时候。冷却期间不接自动扫描（手动重新扫描会绕过它）。 */
  private scanCooldownUntil = 0;
  /** 这一轮扫描目前干到哪儿了。超时时写进日志和状态接口。 */
  scanProgress: ScanProgress | null = null;
  private readonly onUnhealthy: ((reason: string) => void) | undefined;
  /** 本进程已经完整导出过的月份。导出按月份增量，不再每轮重写全部历史。 */
  private exportedMonths = new Set<string>();
  /** 正在进行的同步。同一时刻只允许一轮：卡住时不能让下一轮再叠上去占线程池。 */
  private syncRunning: Promise<unknown> | null = null;
  /**
   * 超时了但还没回来的同步。卡在 iCloud 里的调用杀不掉，只能让它们自己了结；
   * 但也不能因为它们把同步永久停掉（11 月 18 日就是这样：09:42 卡了一轮，
   * 之后所有对表都被跳过，直到重启）。
   * 策略：最多容忍两轮挂着，之后暂停，等其中一个回来再继续。
   */
  private syncParked = new Set<Promise<unknown>>();
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
    this.onUnhealthy = opts.onUnhealthy;
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
    // 上次进程走的时候可能有一轮扫描没结束（强制退出、卡死）。它们不是「在跑」，
    // 是「中断了」，先标掉，日志页才不会显示一条永远在扫的记录。
    try {
      const stale = this.repo.abortStaleBatches();
      if (stale) this.repo.log(0, Date.now(), 'warn', '扫描', `上次退出时有 ${stale} 轮扫描没正常结束，已标记为中断`);
    } catch (err) {
      console.error(`清理未结束的批次失败：${(err as Error).message}`);
    }
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

  /** 冷却还剩多久（毫秒）。0 表示没在冷却。 */
  get scanCooldownRemaining(): number {
    return Math.max(0, this.scanCooldownUntil - Date.now());
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
   * 页面也就永远收不到新事件。
   *
   * 现在用看门狗：只等结果的落地信号或超时信号，超时就不等了。
   * 以前的做法是超时就 abort 然后继续 await —— 如果卡在一个永远不会落地的 await 上
   * （11 月 18 日那次：一轮扫描从 09:41 一直挂到发现时，5 个小时），abort
   * 只能设个标记，根本轮不到检查，所以等于没救。现在的结果是谁先来听谁的。
   */
  /**
   * 触发一次扫描。正在扫就记个标记，扫完再跑一次。
   *
   * `force` 是手动触发的：冷却期间也照跑。
   * （不加这个的话，卡住进入冷却后用户点「重新扫描」是没反应的，看上去像按钮坏了。）
   */
  async triggerScan(trigger: 'watch' | 'poll' | 'manual', opts: { force?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    if (this.scanning) {
      this.dirty = true;
      return;
    }
    if (!opts.force && Date.now() < this.scanCooldownUntil) return;

    this.scanning = true;
    const t0 = Date.now();
    const timeoutMs = this.opts.scanTimeoutMs;
    this.lastScanStartedAt = t0;
    this.scanProgress = { phase: '启动', path: '', files: 0 };

    type Outcome =
      | { kind: 'done'; summary: ScanSummary }
      | { kind: 'failed'; message: string }
      | { kind: 'timeout' };

    const ac = new AbortController();
    let batchId: number | null = null;
    const settled = new Promise<Outcome>(resolve => {
      runScan(this.repo, {
        trigger,
        device: this.device,
        signal: ac.signal,
        onProgress: p => { this.scanProgress = p; },
        onBatch: id => { batchId = id; }
      }).then(
        summary => resolve({ kind: 'done', summary }),
        err => resolve({ kind: 'failed', message: (err as Error).message })
      );
    });
    let watchdog: NodeJS.Timeout | undefined;
    const timedOut = new Promise<Outcome>(resolve => {
      watchdog = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    });

    let outcome: Outcome;
    try {
      outcome = await Promise.race([settled, timedOut]);

      if (outcome.kind === 'timeout') {
        // 先让还在跑的那一轮尽快退出（能不能停不保证，所以下面不等它）
        ac.abort();
        // 这一轮不会再进 finishBatch 了，在这里把批次标成中断，
        // 否则日志页上会一直挂着一条「在跑」的记录
        if (batchId !== null) {
          try { this.repo.abortBatch(batchId); } catch { /* 库可能已经关了 */ }
        }
        this.consecutiveTimeouts++;
        const where = this.scanProgress
          ? `，卡在 ${this.scanProgress.phase}${this.scanProgress.path ? ' · ' + basename(this.scanProgress.path) : ''}（已看 ${this.scanProgress.files} 个文件）`
          : '';
        const message = `扫描超过 ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`}未完成，已放弃这一轮${where}`;
        this.logLine('err', '扫描', message);
        this.emit({ type: 'scan_error', message });
        this.markUnhealthy();
        if (this.consecutiveTimeouts >= 2) {
          this.scanCooldownUntil = Date.now() + 10 * 60_000;
          this.logLine('warn', '扫描', '连续两轮扫描超时，接下来 10 分钟不再自动扫描（手动重新扫描不受限）；先检查同步目录和磁盘');
        }
        this.dirty = false;
        return;
      }

      this.consecutiveTimeouts = 0;

      if (outcome.kind === 'failed') {
        this.logLine('err', '扫描', outcome.message);
        this.emit({ type: 'scan_error', message: outcome.message });
        return;
      }

      const summary = outcome.summary;
      if (summary.fsStalled) {
        // 批次正常收尾了，但里面有文件操作直接不返回：和超时一样，是运行时坏了
        this.markUnhealthy();
      } else {
        this.unhealthyRounds = 0;
      }
      // 导出只写这轮动过的月份，历史月份不重写（iCloud 目录每 2 秒重写 6 个文件是灾难）
      await this.exportSync(summary.days);
      this.lastScanFinishedAt = Date.now();
      this.emit({
        type: 'scan_done',
        batch: summary.batchId,
        eventsWritten: summary.eventsWritten,
        days: summary.days,
        durationMs: Date.now() - t0
      });
    } finally {
      if (watchdog) clearTimeout(watchdog);
      this.scanning = false;
      if (this.dirty && Date.now() >= this.scanCooldownUntil) {
        this.dirty = false;
        void this.triggerScan(trigger);
      }
    }
  }

  /**
   * 记一次「这一轮不健康」。连续两次就通知外面：重试解决不了，得重启进程。
   *
   * 为什么是两次：单个 120 秒超时也可能真的只是碰到了超大文件的一次性长耗时，
   * 连续两轮都卡住就不是偶然了。
   */
  private markUnhealthy(): void {
    this.unhealthyRounds++;
    if (this.unhealthyRounds < 2) return;
    const reason = `扫描连续 ${this.unhealthyRounds} 轮卡在文件系统上，进程内的文件操作已经不可用`;
    this.logLine('err', '扫描', `${reason}，需要重启应用才能恢复`);
    this.unhealthyRounds = 0;
    try {
      this.onUnhealthy?.(reason);
    } catch (err) {
      this.logLine('warn', '扫描', `重启回调失败：${(err as Error).message}`);
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
    return this.syncRunning !== null || this.syncParked.size > 0;
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
   * 同一时刻只允许一轮同步，调用方最多等 SYNC_TIMEOUT_MS。
   *
   * 卡在 iCloud 里的调用无法被真正杀掉，所以这里有意「不排队」，并且允许最多两个
   * 「超时但还没回来」的轮次：大于这个数就跳过新的轮次，免得把 libuv 的线程池占满。
   * 能返回的错（权限、目录被删）仍然写进 lastSyncError，页面上看得出来。
   */
  private startSync<T>(
    what: string,
    job: (signal: AbortSignal) => Promise<T>
  ): Promise<T | null> | null {
    if (this.closed || !this.syncDir) return null;
    // 上一轮还没回来就跳过本轮；但允许最多两个“卡住但未返回”的，
    // 否则一次卡住就会让同步到重启前都不再工作。
    if (this.syncRunning || this.syncParked.size >= 2) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), SYNC_TIMEOUT_MS);
    // self 声明在前、赋值在后：finally 里要拿它和一个可能还没赋值的变量比，
    // 用 const 会撞上暂时性死区。
    let self: Promise<T | null> | undefined;
    const body = async (): Promise<T | null> => {
      try {
        const result = await job(ac.signal);
        // 成功了就把上一次的错误信息清掉，页面上不要继续挂着已经不成立的错误
        this.lastSyncError = null;
        return result;
      } catch (err) {
        const message = ac.signal.aborted
          ? `${what}超过 ${Math.round(SYNC_TIMEOUT_MS / 1000)} 秒未完成`
          : `${what}失败：${(err as Error).message}`;
        this.noteSyncError(message);
        return null;
      } finally {
        clearTimeout(timer);
        if (self && this.syncRunning === self) this.syncRunning = null;
        if (self) this.syncParked.delete(self);
      }
    };
    self = body();
    this.syncRunning = self;
    return self;
  }

  /**
   * 调用方不等超过 SYNC_TIMEOUT_MS + 1 秒。超过就把这一轮记成「挂着」，
   * 让下一轮能继续试，而不是让同步到重启前都不再工作。
   */
  private async waitBounded<T>(run: Promise<T | null>): Promise<T | null> {
    let timer: NodeJS.Timeout | undefined;
    const stalled = new Promise<null>(resolve => {
      timer = setTimeout(() => {
        this.noteSyncError(`同步超过 ${Math.round(SYNC_TIMEOUT_MS / 1000)} 秒仍未返回，本轮先放过`);
        // 不再等它：把小区让出来，下一轮可以继续试（总共最多同时挂两个）
        this.syncParked.add(run);
        if (this.syncRunning === run) this.syncRunning = null;
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
    else this.lastSyncError = null;    const changed = summary.aggRows + summary.sessionRows;
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
