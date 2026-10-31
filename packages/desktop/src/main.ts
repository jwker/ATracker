// 桌面外壳：启动本地服务，窗口指向它。
//
// 服务端代码原样复用，不重写、不走 IPC：Electron 45 内置的 Node 24 能直接
// 跑项目里的 .ts，`node:sqlite` 也在，所以 main 进程里 import ATrackerServer
// 就能用。窗口只是把这个本地服务当普通网页打开。

import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron';
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

/**
 * 应用菜单。自己写一份，因为默认菜单里没有「重新扫描」这种本应用的常用动作。
 * 角色项（role）交给系统翻译，自定义项用中文。
 */
function buildMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    // 菜单项的 role 交给系统处理，但 label 自己写中文，和界面保持一致
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' as const, label: `关于 ${app.name}` },
            { type: 'separator' as const },
            { role: 'services' as const, label: '服务' },
            { type: 'separator' as const },
            { role: 'hide' as const, label: `隐藏 ${app.name}` },
            { role: 'hideOthers' as const, label: '隐藏其他' },
            { role: 'unhide' as const, label: '全部显示' },
            { type: 'separator' as const },
            { role: 'quit' as const, label: `退出 ${app.name}` }
          ]
        }]
      : []),
    {
      label: '文件',
      submenu: [
        {
          label: '重新扫描',
          accelerator: 'CmdOrCtrl+R',
          click: () => { void server?.triggerScan('manual'); }
        },
        {
          label: '打开数据目录',
          click: () => { void shell.openPath(app.getPath('userData')); }
        },
        { type: 'separator' },
        isMac
          ? { role: 'close', label: '关闭窗口' }
          : { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        // 页面刷新和扫描是两件事，刷新用 Shift，把 ⌘R 让给「重新扫描」
        { role: 'reload', label: '重新加载页面', accelerator: 'CmdOrCtrl+Shift+R' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const, label: '全部置于顶层' }
            ]
          : [{ role: 'close' as const, label: '关闭窗口' }])
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  if (process.env.ATRACKER_DEBUG_MENU) {
    console.log('菜单：', JSON.stringify(
      Menu.getApplicationMenu()?.items.map(i => [i.label, i.submenu?.items.map(x => x.label)]),
      null, 1
    ));
  }
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
  // 拿不到锁说明已经有一个在跑。这里要给出反馈，否则用户只会看到「双击没反应」。
  // 主实例会在 second-instance 事件里把窗口提到前面。
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({
      type: 'info',
      message: 'ATracker 已经在运行',
      detail: '切到已经打开的那个窗口就行。',
      buttons: ['好']
    });
    app.quit();
  });
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // macOS 上只调 win.focus() 未必能切到最前，steal 才稳
    app.focus({ steal: true });
  });

  app.whenReady().then(() => {
    buildMenu();
    return openWindow();
  }).catch(err => {
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
