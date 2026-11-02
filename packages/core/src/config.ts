// 全局配置。和 device.json 放在同一个目录（~/.atracker/），命令行和桌面版共用。
//
// 目前只有同步目录一项：
//   { "syncDir": "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/ATracker" }
// syncDir 为 null 或不写表示关闭同步。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface AppConfig {
  /** 多设备同步目录。null 表示关闭。 */
  syncDir: string | null;
}

/** iCloud Drive 里给 ATracker 用的目录。macOS 和 Windows 的路径不同。 */
export function iCloudSyncDir(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'ATracker');
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'iCloudDrive', 'ATracker');
  }
  // Linux 上 iCloud 不是标准路径，退回本地目录，用户自己改成 Syncthing 之类的
  return join(homedir(), '.atracker', 'sync');
}

export function configFilePath(): string {
  return process.env.ATRACKER_CONFIG_FILE ?? join(homedir(), '.atracker', 'config.json');
}

export function loadConfig(): AppConfig {
  try {
    const raw = JSON.parse(readFileSync(configFilePath(), 'utf8')) as Partial<AppConfig>;
    return { syncDir: typeof raw.syncDir === 'string' && raw.syncDir ? raw.syncDir : null };
  } catch {
    return { syncDir: null };
  }
}

export function saveConfig(config: AppConfig): void {
  const file = configFilePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
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

/** iCloud 目录是否已经能读写。用来提示「iCloud Drive 没开」。 */
export function iCloudAvailable(): boolean {
  const root = iCloudRoot();
  return root !== null && existsSync(root);
}
