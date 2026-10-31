// 桌面外壳：启动本地服务，窗口指向它。
//
// 服务端代码原样复用，不重写、不走 IPC：Electron 45 内置的 Node 24 能直接
// 跑项目里的 .ts，`node:sqlite` 也在，所以 main 进程里 import ATrackerServer
// 就能用。窗口只是把这个本地服务当普通网页打开。

import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

import { ATrackerServer } from '../../server/src/app.ts';

/** 打包后是 .../Resources/app.asar，开发时是仓库根目录。 */
const ROOT = app.getAppPath();
const WEB_DIR = join(ROOT, 'packages', 'web', 'dist');

let server: ATrackerServer | null = null;
let win: BrowserWindow | null = null;

/**
 * 数据库位置：
 * - 打包后放用户数据目录（~/Library/Application Support/ATracker/atracker.db）；
 * - 开发时用仓库里的 data/atracker.db，和 CLI 共用一份，不重复扫描；
 * - 设置 ATRACKER_DB 可以显式指定。
 */
function databasePath(): string {
  const fromEnv = process.env.ATRACKER_DB;
  if (fromEnv) return fromEnv;
  if (!app.isPackaged) return join(ROOT, 'data', 'atracker.db');
  return join(app.getPath('userData'), 'atracker.db');
}

async function openWindow(): Promise<void> {
  const instance = new ATrackerServer({
    dbPath: databasePath(),
    webDir: WEB_DIR,
    // 只监听本机回环，端口交给系统分配，避免和已经在跑的 serve 抢 4178。
    host: '127.0.0.1',
    port: 0
  });
  server = instance;
  const addr = await instance.start();

  // 首屏就触发一次扫描，装上就有数据，不用等 5 分钟轮询。
  void instance.triggerScan('manual');

  win = new BrowserWindow({
    width: 960,
    height: 1100,
    minWidth: 720,
    minHeight: 560,
    title: 'ATracker',
    backgroundColor: '#cfd0cb',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => { win = null; });

  // 页面里的外链交给系统浏览器，不在应用窗口里开新窗口。
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-finish-load', () => {
    console.log(`窗口已加载 ${addr.url}`);
  });
  await win.loadURL(addr.url);
  console.log(`ATracker 已启动：${addr.url} · 数据库 ${databasePath()}`);
}

// 单实例：两个进程同时写一个 SQLite 文件没必要，也容易互相抢写锁。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(openWindow).catch(err => {
    // 起不来就把原因打出来，别留一个空白窗口。
    console.error('启动失败：', err);
    app.quit();
  });

  app.on('activate', () => {
    if (!win) void openWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  // 退出前关掉服务和文件监听，让 SQLite 正常收尾。
  app.on('before-quit', () => {
    void server?.close();
  });
}
