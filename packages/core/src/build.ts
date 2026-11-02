// 构建信息：版本号、提交、构建时间。
//
// 打包时由 scripts/buildinfo.mjs 生成 build/buildinfo.json，跟着 asar 一起进包；
// 开发时没有这个文件（或是不匹配的旧文件），返回 dev。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
  version: string;
  /** git 短哈希 */
  commit: string;
  /** 打包时工作区是否有未提交改动 */
  dirty: boolean;
  branch: string;
  /** ISO 时间 */
  builtAt: string;
}

const here = dirname(fileURLToPath(import.meta.url));

/** 打包后的位置：app.asar/build/buildinfo.json；开发时是仓库根目录下的同一路径 */
const FILE = join(here, '../../..', 'build', 'buildinfo.json');

let cached: BuildInfo | null = null;

export function buildInfo(fallbackVersion = '0.0.0'): BuildInfo {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<BuildInfo>;
    cached = {
      version: raw.version ?? fallbackVersion,
      commit: raw.commit ?? 'dev',
      dirty: raw.dirty ?? false,
      branch: raw.branch ?? '',
      builtAt: raw.builtAt ?? ''
    };
  } catch {
    cached = { version: fallbackVersion, commit: 'dev', dirty: false, branch: '', builtAt: '' };
  }
  return cached;
}

/** 一行短标签，例如「0.1.1 · 3f2a1c9」。 */
export function buildLabel(fallbackVersion = '0.0.0'): string {
  const b = buildInfo(fallbackVersion);
  return `${b.version} · ${b.commit}${b.dirty ? '+' : ''}`;
}
