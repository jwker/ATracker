// 全局配置。和 device.json 放在同一个目录（~/.atracker/），命令行和桌面版共用。
//
// 目前只有同步目录一项：
//   { "syncDir": "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/ATracker" }
// syncDir 为 null 或不写表示关闭同步。

import { accessSync, constants, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic.ts';

export interface AppConfig {
  /** 多设备同步目录。null 表示关闭。 */
  syncDir: string | null;
}

/** iCloud Drive 里给 ATracker 用的子目录名。 */
const ICLOUD_SUBDIR = 'ATracker';

/** iCloud Drive 里给 ATracker 用的目录。macOS 和 Windows 的路径不同。 */
export function iCloudSyncDir(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', ICLOUD_SUBDIR);
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'iCloudDrive', ICLOUD_SUBDIR);
  }
  // Linux 上 iCloud 不是标准路径，退回本地目录，用户自己改成 Syncthing 之类的
  return join(homedir(), '.atracker', 'sync');
}

export function configFilePath(): string {
  // 空字符串也要当没设置，否则 readFileSync('') 会抛错
  const env = process.env.ATRACKER_CONFIG_FILE;
  return env && env.trim() ? env : join(homedir(), '.atracker', 'config.json');
}

export function loadConfig(): AppConfig {
  try {
    const raw: unknown = JSON.parse(readFileSync(configFilePath(), 'utf8'));
    // JSON 可能是 null、数组、数字。类型断言在运行时不成立，要自己查。
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { syncDir: null };
    const syncDir = (raw as Record<string, unknown>).syncDir;
    return { syncDir: typeof syncDir === 'string' && syncDir.trim() ? syncDir : null };
  } catch {
    // 文件不存在或坏了：当成没配置过同步。这不是错误状态，是「没开」。
    return { syncDir: null };
  }
}

export function saveConfig(config: AppConfig): void {
  // 原子写。直接覆盖的话进程在写一半被杀会留下半截 JSON，
  // 下次读到就解析失败，配置整个丢掉。
  writeFileAtomic(configFilePath(), JSON.stringify(config, null, 2) + '\n');
}

/** iCloud Drive 的根目录（不是 ATracker 子目录）。没开 iCloud Drive 时它不存在。 */
export function iCloudRoot(): string | null {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'iCloudDrive');
  }
  return null;
}

/**
 * iCloud 目录是否已经能读写。用来提示「iCloud Drive 没开」。
 *
 * 原来只看目录在不在。目录存在但没写权限时（iCloud 没登录、磁盘满），
 * 会误报成「可以」，然后同步在写的时候才失败。
 */
export function iCloudAvailable(): boolean {
  const root = iCloudRoot();
  if (root === null) return false;
  try {
    // 目录要在，而且能读能写。目录在但没权限时（iCloud 没登录、磁盘满）
    // 会误报成「可以」，然后同步在写的时候才失败。
    // 不用真的建文件来判断写权限——在 iCloud 目录里建临时文件会触发同步，
    // 白白产生垃圾文件。
    accessSync(root, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
