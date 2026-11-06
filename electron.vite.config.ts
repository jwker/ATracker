import { defineConfig, type UserConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

const mainEntry = join(root, 'packages/desktop/src/main/index.ts');
const preloadEntry = join(root, 'packages/desktop/src/preload/index.ts');
const rendererRoot = join(root, 'packages/web');

/**
 * 主进程的 bundle 里包含存储层，它运行时要读同目录的 schema.sql。
 * 把 schema.sql 拷到 out/main/ 下，这样 repo.ts 里「模块同目录」的约定在
 * bundle 之后仍然成立，不用改存储层代码，也不用把 SQL 塞进字符串。
 */
function copySchema(): Plugin {
  return {
    name: 'atracker:copy-schema',
    apply: 'build',
    writeBundle() {
      const dest = join(root, 'out', 'main');
      mkdirSync(dest, { recursive: true });
      copyFileSync(join(root, 'packages/storage/src/schema.sql'), join(dest, 'schema.sql'));
    }
  };
}

/**
 * 随机挑一个空闲端口。
 *
 * 范围避开系统给临时连接用的区间（macOS 是 49152–65535，Linux 是 32768–60999），
 * 否则可能跟我们自己刚探测到的端口撞车。每次试到能 listen 就关掉，把端口交回去。
 */
function randomFreePort(from = 10_000, to = 30_000): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const attempt = (): void => {
      if (attempts++ >= 20) {
        reject(new Error(`在 ${from}–${to} 之间找不到空闲端口`));
        return;
      }
      const port = from + Math.floor(Math.random() * (to - from));
      const probe = createServer();
      probe.once('error', () => { probe.close(() => attempt()); });
      probe.once('listening', () => { probe.close(() => resolve(port)); });
      probe.listen(port, '127.0.0.1');
    };
    attempt();
  });
}

export default defineConfig(async (): Promise<UserConfig> => ({
  main: {
    plugins: [copySchema()],
    build: {
      rolldownOptions: { input: mainEntry }
    }
  },
  preload: {
    build: {
      rolldownOptions: {
        input: preloadEntry,
        // 沙箱化的 preload 不能用 ESM，只输出 CommonJS
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: rendererRoot,
    plugins: [react()],
    build: {
      rolldownOptions: { input: join(rendererRoot, 'index.html') },
      outDir: join(root, 'out', 'renderer')
    },
    server: {
      // 每次启动换一个端口，避免和本机其它项目的开发服务器撞车。
      // 实际端口由 electron-vite 写进 ELECTRON_RENDERER_URL，主进程直接读那个值，
      // 所以加载地址和导航白名单都不用跟着改。
      // 不设 strictPort：探测到 listen 之间如果有别的进程抢走，让 Vite 顺延一个就行。
      host: '127.0.0.1',
      port: await randomFreePort()
    }
  }
}));
