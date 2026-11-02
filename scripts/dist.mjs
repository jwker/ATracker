// 打包入口。比直接跑 electron-builder 多三件事：
//   1. 先刷新 build/buildinfo.json（版本号 + 提交 + 构建时间）
//   2. 把提交哈希放进环境变量 BUILD_STAMP，产物文件名带它
//   3. mac 打完删掉中间目录 release/mac-arm64
//
// 用法：node scripts/dist.mjs --mac [--dir] [--unsigned] [其它 electron-builder 参数]

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

// 1. buildinfo
execFileSync('node', [join(root, 'scripts', 'buildinfo.mjs')], { cwd: root, stdio: 'inherit' });
const info = JSON.parse(readFileSync(join(root, 'build', 'buildinfo.json'), 'utf8'));

// 2. 产物名里带提交哈希，避免同名覆盖；有未提交改动标成 -dev
const stamp = `${info.commit}${info.dirty ? '-dev' : ''}`;

const env = { ...process.env, BUILD_STAMP: stamp };
if (args.includes('--unsigned')) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}

// 3. 前端构建 + electron-builder
const passthrough = args.filter(a => a !== '--unsigned');
execFileSync('npm', ['run', 'build:web'], { cwd: root, stdio: 'inherit', env });
execFileSync('npx', ['electron-builder', ...passthrough], { cwd: root, stdio: 'inherit', env });

// 4. mac 的中间目录用完就删（里面的 .app 会被 Spotlight 当成第二个应用）
// ATRACKER_KEEP_APP_DIR=1 可以留着，排查打包问题时用
if (!process.env.ATRACKER_KEEP_APP_DIR && passthrough.includes('--mac') && !passthrough.includes('--dir')) {
  for (const dir of ['release/mac-arm64', 'release/mac']) {
    rmSync(join(root, dir), { recursive: true, force: true });
  }
}
console.log(`完成：版本 ${info.version} · 提交 ${stamp}`);
