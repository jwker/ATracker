// 打包前生成 build/buildinfo.json：版本号 + 提交 + 构建时间。
// 应用里（日志页底部、About 面板）会显示它，用来判断两台机器装的是不是同一版。
// 只在打包时跑，平时开发不需要。

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 读 package.json。读不到就让构建失败，不要拿一个空版本号去打一个包。 */
function readPkg() {
  const file = join(root, 'package.json');
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`读不了 package.json：${err.message}`);
  }
  if (!raw || typeof raw.version !== 'string' || !raw.version) {
    throw new Error('package.json 里没有 version 字段');
  }
  return raw;
}

/**
 * 跑一条 git 命令。
 *
 * 用 execFileSync 而不是 execSync：execSync 把命令拼成字符串交给 shell，
 * 参数里带特殊字符会被 shell 解释。git 不可用时返回 null，调用方自己决定
 * 怎么办——不能把「git 失败」和「工作区干净」混为一谈。
 */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // git status 的输出可能超过默认的 1MB 限制，超了会抛错，
      // 超了不代表工作区是干净的。
      maxBuffer: 16 * 1024 * 1024
    }).trim();
  } catch {
    return null;
  }
}

const pkg = readPkg();

const commit = git(['rev-parse', '--short', 'HEAD']);
if (!commit) {
  console.warn('buildinfo: 拿不到 git 提交号（不在仓库里，或者没装 git），产物会标成 unknown');
}

// 拿不到提交号时不能假设工作区是干净的——那会让产物看起来是正式版
const status = commit ? git(['status', '--porcelain']) : null;
const dirty = status === null ? true : status !== '';

// detached HEAD 时 rev-parse --abbrev-ref 返回字面量 HEAD，那不是分支名
let branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (!branch || branch === 'HEAD') branch = 'detached';

const info = {
  version: pkg.version,
  commit: commit ?? 'unknown',
  dirty,
  branch: branch ?? 'unknown',
  builtAt: new Date().toISOString()
};

mkdirSync(join(root, 'build'), { recursive: true });
// 原子写：直接写的话进程在写一半被杀会留下半截 JSON，
// core/src/build.ts 读失败时会静默回落成 dev，所有包都标成 0.0.0。
const target = join(root, 'build', 'buildinfo.json');
const tmp = join(root, 'build', '.buildinfo.tmp');
try {
  writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n');
  renameSync(tmp, target);
} catch (err) {
  try { unlinkSync(tmp); } catch { /* 临时文件可能没建成 */ }
  throw err;
}
console.log(`buildinfo: ${info.version} · ${info.commit}${dirty ? '（未提交改动）' : ''} · ${info.builtAt}`);
