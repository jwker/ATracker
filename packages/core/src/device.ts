// 设备标识。一台机器一个 id，存在 ~/.atracker/device.json。
//
// 为什么不放在数据库里：命令行用 data/atracker.db、桌面版用
// ~/Library/Application Support/ATracker/atracker.db，两个库不同，但设备是
// 同一台。身份跟着机器走，不跟着库走。
// 环境变量 ATRACKER_DEVICE_FILE 可以改文件位置（测试用）。

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic.ts';

export interface DeviceInfo {
  /** 稳定 uuid，首次运行时生成，之后不再变 */
  id: string;
  /** 显示名，默认取主机名，可以在文件里改 */
  name: string;
  /** darwin / win32 / linux */
  platform: string;
}

function deviceFile(): string {
  // 空字符串也要当没设置：环境变量写成 ATRACKER_DEVICE_FILE= 时，
  // 路径会变成空串，dirname('') 拿到的是 '.'
  const env = process.env.ATRACKER_DEVICE_FILE;
  return env && env.trim() ? env : join(homedir(), '.atracker', 'device.json');
}

/**
 * 读本机身份。
 *
 * 文件坏了或者读不了时退回一份临时身份，不阻塞采集——这时同一台机器可能会
 * 被当成新设备，界面上能看出来。
 *
 * 临时身份在进程内是固定的：原来每次调用都重新 randomUUID()，同一进程里
 * 设备 id 会一直漂移，一次同步周期里写出去的文件就分属不同设备。
 */
let fallback: DeviceInfo | null = null;

/** 校验读到的内容是不是一份身份。字段类型不对就当没有。 */
function parseDevice(raw: unknown): DeviceInfo | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id.trim()) return null;
  return {
    id: o.id.trim(),
    name: typeof o.name === 'string' && o.name.trim() ? o.name : hostname(),
    platform: typeof o.platform === 'string' && o.platform ? o.platform : process.platform
  };
}

export function loadDevice(): DeviceInfo {
  const file = deviceFile();
  try {
    const parsed = parseDevice(JSON.parse(readFileSync(file, 'utf8')));
    if (parsed) return parsed;
  } catch {
    // 首次运行，或者文件坏了，下面重新生成
  }

  if (!fallback) {
    fallback = { id: randomUUID(), name: hostname(), platform: process.platform };
  }
  try {
    writeFileAtomic(file, JSON.stringify(fallback, null, 2) + '\n');
  } catch {
    // 写不了就先用内存里的这份
  }
  return fallback;
}

/** 改本机设备名，写回 device.json。返回更新后的身份。 */
export function saveDeviceName(name: string): DeviceInfo {
  const current = loadDevice();
  const trimmed = name.trim();
  if (!trimmed) return current;
  const next: DeviceInfo = { ...current, name: trimmed };
  try {
    writeFileAtomic(deviceFile(), JSON.stringify(next, null, 2) + '\n');
  } catch {
    // 写不了就只改内存里的，下次启动会退回旧名字
  }
  return next;
}

/** 设备文件的位置，界面上用来提示「身份存在哪」。 */
export function deviceFilePath(): string {
  return deviceFile();
}
