// 生成 THIRD_PARTY_NOTICES.txt。
//
// 运行时依赖只有 react 和 react-dom（MIT），它们会被 vite 打进
// packages/web/dist，跟着安装包一起分发。MIT 要求在副本里保留版权和许可声明，
// 所以这里把依赖的原始声明收集起来。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function licenseText(name) {
  const dir = join(root, 'node_modules', name);
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE']) {
    const p = join(dir, file);
    if (existsSync(p)) {
      try {
        return readFileSync(p, 'utf8').trim();
      } catch {
        return '';
      }
    }
  }
  return '';
}

const names = Object.keys(pkg.dependencies || {});
const blocks = [];
for (const name of names) {
  const metaPath = join(root, 'node_modules', name, 'package.json');
  if (!existsSync(metaPath)) continue;
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const text = licenseText(name);
  blocks.push(
    `================================================================\n` +
    `${name} ${meta.version}\n` +
    `协议：${meta.license ?? '（包自己的包里没写）'}\n` +
    `================================================================\n` +
    (text || '（这个包没有单独的 LICENSE 文件，协议见上面的声明）')
  );
}

const out = [
  '第三方组件声明',
  '',
  'ATracker 自己用 MIT 协议（见 LICENSE）。下面这些第三方组件会跟着',
  '安装包一起分发，它们各自的声明也一并列在这里。',
  '',
  ...blocks,
  ''
].join('\n');

writeFileSync(join(root, 'THIRD_PARTY_NOTICES.txt'), out);
console.log(`第三方声明：${names.length} 个依赖 → THIRD_PARTY_NOTICES.txt`);
