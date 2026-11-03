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
  // 只关掉证书的「自动发现」。环境里如果已经有 CSC_LINK / CSC_KEY_PASSWORD
  // （CI 里很常见），或者 macOS 的 APPLE_ID 这些 notarization 凭据，
  // 打包还是会去签名。--unsigned 就该真的不签。
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  delete env.CSC_LINK;
  delete env.CSC_KEY_PASSWORD;
  delete env.APPLE_ID;
  delete env.APPLE_APP_SPECIFIC_PASSWORD;
  delete env.APPLE_TEAM_ID;
}

// 3. 前端构建 + electron-builder
const passthrough = args.filter(a => a !== '--unsigned');
// Windows 上 npm / npx 是 .cmd 包装器，直接 execFileSync('npm') 会 ENOENT。
const bin = (name) => (process.platform === 'win32' ? `${name}.cmd` : name);
execFileSync(bin('npm'), ['run', 'build:web'], { cwd: root, stdio: 'inherit', env });
// 第三方组件声明跟着安装包一起分发，打包前生成
execFileSync('node', [join(root, 'scripts', 'third-party-notices.mjs')], { cwd: root, stdio: 'inherit' });
execFileSync(bin('npx'), ['electron-builder', ...passthrough], { cwd: root, stdio: 'inherit', env });

// 4. mac 的中间目录用完就删（里面的 .app 会被 Spotlight 当成第二个应用）
// ATRACKER_KEEP_APP_DIR=1 可以留着，排查打包问题时用
//
// 判断条件不能只认 '--mac'：electron-builder 还支持 -m、--mac=universal、
// --universal 这些写法，漏了就会在 universal 包打完之后留下 mac-arm64 目录。
const macBuild = passthrough.some(a => a === '--mac' || a === '-m' || a.startsWith('--mac=') || a === '--universal');
if (!process.env.ATRACKER_KEEP_APP_DIR && macBuild && !passthrough.includes('--dir')) {
  for (const dir of ['release/mac-arm64', 'release/mac']) {
    rmSync(join(root, dir), { recursive: true, force: true });
  }
}
console.log(`完成：版本 ${info.version} · 提交 ${stamp}`);
