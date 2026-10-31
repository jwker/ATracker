// 把 build/icon.svg 渲染成 build/icon.png（1024x1024）。
// 用 Electron 的无头窗口当渲染器，不引入额外的图形依赖。
//   npx electron packages/desktop/scripts/render-icon.mjs
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const svg = readFileSync(join(root, 'build/icon.svg'), 'utf8');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    webPreferences: { offscreen: true }
  });
  const html = `<!DOCTYPE html><html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise(r => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  writeFileSync(join(root, 'build/icon.png'), img.toPNG());
  console.log('已写出 build/icon.png', img.getSize());
  app.quit();
});
