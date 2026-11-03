// 把 build/icon.svg 渲染成 build/icon.png（1024x1024）。
// 用 Electron 的无头窗口当渲染器，不引入额外的图形依赖。
//   npx electron packages/desktop/scripts/render-icon.mjs

import { app, BrowserWindow } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const SVG = join(root, 'build/icon.svg');
const PNG = join(root, 'build/icon.png');
const SIZE = 1024;

function fail(msg) {
  console.error(`图标渲染失败：${msg}`);
  app.exit(1);
}

if (!existsSync(SVG)) fail(`找不到 ${SVG}`);

let svg = '';
try {
  svg = readFileSync(SVG, 'utf8');
} catch (err) {
  fail(`读不了 build/icon.svg：${err.message}`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: SIZE,
    height: SIZE,
    // 窗口外框不算内容区。宽高要加上边框，画面才是完整的一比一。
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true }
  });
  // SVG 直接拼进 HTML，没做净化。加一条 CSP 挡住里面的脚本和外部引用：
  // 构建输入被污染时，图标渲染不该变成一次任意代码执行。
  const html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
</head><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  // 等首帧画完。固定 300ms 不可靠：loadURL 只保证文档加载完成，
  // 不保证第一帧已经绘制。慢的机器上会截到空白或半成品。
  await new Promise(r => setTimeout(r, 100));
  try {
    await win.webContents.executeJavaScript(
      'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'
    );
  } catch {
    // 页面还没准备好就多等一会儿
    await new Promise(r => setTimeout(r, 500));
  }

  const img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const size = img.getSize();
  if (size.width !== SIZE || size.height !== SIZE) {
    fail(`截到的尺寸是 ${size.width}x${size.height}，不是 ${SIZE}x${SIZE}`);
  }
  const buf = img.toPNG();
  if (!buf || buf.length < 1000) {
    fail('截到的图片是空的');
  }
  try {
    writeFileSync(PNG, buf);
  } catch (err) {
    fail(`写不了 build/icon.png：${err.message}`);
  }
  console.log('已写出 build/icon.png', size);
  app.quit();
}).catch(err => {
  fail(err && err.stack ? err.stack : String(err));
});
