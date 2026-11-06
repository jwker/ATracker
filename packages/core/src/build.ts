// 构建信息：版本号、提交、构建时间。
//
// 打包时由 scripts/buildinfo.mjs 生成 build/buildinfo.json，跟着 asar 一起进包；
// 开发时没有这个文件，返回 dev。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 形状定义在 api.ts，和 IPC 契约放一起，渲染进程不需要 import 这个文件。
import type { BuildInfo } from './api.ts';

export type { BuildInfo };

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 打包后的位置：app.asar/build/buildinfo.json；开发时是仓库根目录下的同一路径。
 *
 * 主进程会被打包成单个 bundle，模块位置不再等于源码位置，所以它启动时用
 * `ATRACKER_BUILDINFO` 显式指定路径。命令行直接跑源码，走默认拼出来的路径。
 *
 * 每次调用时再算，不能写成模块顶层的常量：模块顶层的代码比设置环境变量的那行先执行，
 * 那样读到的是空值，打包后会静默回落成 dev。
 */
function buildInfoFile(): string {
  return process.env.ATRACKER_BUILDINFO ?? join(here, '../../..', 'build', 'buildinfo.json');
}

/** 文件不存在或者读不了时返回的兜底值。 */
function devInfo(fallbackVersion: string): BuildInfo {
  return { version: fallbackVersion, commit: 'dev', dirty: false, branch: '', builtAt: '' };
}

/** 校验读到的内容。JSON 来自磁盘，可能被手工改坏。 */
function parseBuildInfo(raw: unknown, fallbackVersion: string): BuildInfo | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const str = (x: unknown): string => (typeof x === 'string' ? x : '');
  const version = str(o.version);
  if (!version) return null;
  return {
    version,
    commit: str(o.commit) || 'dev',
    dirty: o.dirty === true,
    branch: str(o.branch),
    builtAt: str(o.builtAt)
  };
}

let cached: BuildInfo | null = null;

export function buildInfo(fallbackVersion = '0.0.0'): BuildInfo {
  if (cached) return cached;
  try {
    const parsed = parseBuildInfo(JSON.parse(readFileSync(buildInfoFile(), 'utf8')), fallbackVersion);
    // 内容不对就当没有这个文件。原来是「字段缺失就补默认值」，
    // 一个手改坏的 buildinfo.json 会显示成半真半假的信息。
    cached = parsed ?? devInfo(fallbackVersion);
  } catch {
    // 文件不存在、JSON 语法错误、读不了：都是「没有构建信息」
    cached = devInfo(fallbackVersion);
  }
  return cached;
}

/** 一行短标签，例如「0.1.1 · 3f2a1c9」。 */
export function buildLabel(fallbackVersion = '0.0.0'): string {
  const b = buildInfo(fallbackVersion);
  return `${b.version} · ${b.commit}${b.dirty ? '+' : ''}`;
}
