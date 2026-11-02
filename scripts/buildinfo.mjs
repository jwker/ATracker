// 打包前生成 build/buildinfo.json：版本号 + 提交 + 构建时间。
// 应用里（日志页底部、About 面板）会显示它，用来判断两台机器装的是不是同一版。
// 只在打包时跑，平时开发不需要。

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const commit = git('rev-parse --short HEAD') || 'unknown';
const dirty = git('status --porcelain') ? true : false;
const branch = git('rev-parse --abbrev-ref HEAD') || 'unknown';

const info = {
  version: pkg.version,
  commit,
  dirty,
  branch,
  builtAt: new Date().toISOString()
};

mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build', 'buildinfo.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`buildinfo: ${info.version} · ${commit}${dirty ? '（未提交改动）' : ''} · ${info.builtAt}`);
