// 设备标识。一台机器一个 id，存在 ~/.atracker/device.json。
//
// 为什么不放在数据库里：命令行用 data/atracker.db、桌面版用
// ~/Library/Application Support/ATracker/atracker.db，两个库不同，但设备是
// 同一台。身份跟着机器走，不跟着库走。
// 环境变量 ATRACKER_DEVICE_FILE 可以改文件位置（测试用）。

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface DeviceInfo {
  /** 稳定 uuid，首次运行时生成，之后不再变 */
  id: string;
  /** 显示名，默认取主机名，可以在文件里改 */
  name: string;
  /** darwin / win32 / linux */
  platform: string;
}

function deviceFile(): string {
  return process.env.ATRACKER_DEVICE_FILE ?? join(homedir(), '.atracker', 'device.json');
}

/**
 * 读本机身份，没有就生成一份。文件坏了或读不了时退回内存里的临时身份，
 * 不阻塞采集——这时同一台机器可能会被当成新设备，界面上能看出来。
 */
export function loadDevice(): DeviceInfo {
  const file = deviceFile();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<DeviceInfo>;
    if (typeof raw.id === 'string' && raw.id) {
      return {
        id: raw.id,
        name: raw.name || hostname(),
        platform: raw.platform || process.platform
      };
    }
  } catch {
    // 首次运行，或者文件坏了，下面重新生成
  }

  const info: DeviceInfo = { id: randomUUID(), name: hostname(), platform: process.platform };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(info, null, 2) + '\n');
  } catch {
    // 写不了就先用内存里的这份
  }
  return info;
}

/** 设备文件的位置，界面上用来提示「身份存在哪」。 */
export function deviceFilePath(): string {
  return deviceFile();
}
