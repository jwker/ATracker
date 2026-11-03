// 桌面外壳：启动本地服务，窗口指向它。
//
// 服务端代码原样复用，不重写、不走 IPC：Electron 45 内置的 Node 24 能直接
// 跑项目里的 .ts，`node:sqlite` 也在，所以 main 进程里 import ATrackerServer
// 就能用。窗口只是把这个本地服务当普通网页打开。

import { app, BrowserWindow, dialog, Menu, screen, shell, type MenuItemConstructorOptions } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ATrackerServer } from '../../server/src/app.ts';
import { iCloudAvailable, iCloudRoot, iCloudSyncDir, loadConfig, saveConfig } from '../../core/src/config.ts';
import { buildInfo } from '../../core/src/build.ts';

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

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

/** 窗口大小记在 userData 里，用户拖过就沿用；没拖过用按屏幕算出来的默认值。 */
function windowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

/**
 * 默认窗口尺寸。小票本身是 820px 宽的纸，两边要留出桌面才好看，
 * 所以按屏幕宽度的 80% 取，并夹在 1000–1400 之间；高度同理。
 */
function defaultWindowState(): WindowState {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.min(1400, Math.max(1000, Math.round(width * 0.8))),
    height: Math.min(1200, Math.round(height * 0.92))
  };
}

/** 读上次的尺寸。位置只在还落在某块屏幕里时才用，否则只留尺寸让系统居中。 */
function loadWindowState(): WindowState {
  let saved: WindowState | null = null;
  try {
    const raw = JSON.parse(readFileSync(windowStatePath(), 'utf8')) as Partial<WindowState>;
    if (typeof raw.width === 'number' && typeof raw.height === 'number') {
      saved = { width: raw.width, height: raw.height, x: raw.x, y: raw.y };
    }
  } catch {
    // 首次启动或者文件坏了，用默认值
  }
  if (!saved) return defaultWindowState();

  const onScreen = saved.x !== undefined && saved.y !== undefined && screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return (
      saved!.x! + 120 > a.x && saved!.x! < a.x + a.width - 120 &&
      saved!.y! + 60 > a.y && saved!.y! < a.y + a.height - 60
    );
  });
  return onScreen ? saved : { width: saved.width, height: saved.height };
}

function saveWindowState(bounds: Electron.Rectangle): void {
  try {
    writeFileSync(windowStatePath(), JSON.stringify(bounds));
  } catch {
    // 写不了就算了，下次用默认值
  }
}

/** 读某个 .app 的版本号，读不到就给 null。 */
function bundleVersion(appPath: string): string | null {
  try {
    return execFileSync(
      'plutil',
      ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(appPath, 'Contents', 'Info.plist')],
      { encoding: 'utf8' }
    ).trim();
  } catch {
    return null;
  }
}

/**
 * macOS 没有「安装登记」，复制一份 .app 就是第二份，系统层面挡不住。
 * 能做的是：启动时发现「应用程序」里已经有一份、而自己是从别处跑的，就把情况
 * 说清楚，让用户知道该留哪一份。不自动替换，避免把用户装的那份悄悄覆盖掉。
 */
function warnIfDuplicateInstall(): void {
  if (!app.isPackaged) return;
  if (process.env.ATRACKER_NO_DUPLICATE_PROMPT) return;
  if (app.isInApplicationsFolder()) return;

  const installed = '/Applications/ATracker.app';
  if (!existsSync(installed)) return;

  const mine = app.getPath('exe').replace(/\/Contents\/MacOS\/ATracker$/, '');
  const mineVersion = bundleVersion(mine) ?? '未知版本';
  const installedVersion = bundleVersion(installed) ?? '未知版本';
  console.log(`发现另一份安装在 ${installed}（${installedVersion}），当前是 ${mine}（${mineVersion}）`);

  dialog.showMessageBox({
    type: 'info',
    message: '「应用程序」里已经装了一份 ATracker',
    detail:
      `正在运行的是 ${mine}（${mineVersion}）。\n` +
      `「应用程序」里那份是 ${installedVersion}。\n\n` +
      '平时用「应用程序」里的那份就行，这份可以直接删掉。',
    buttons: ['好']
  });
}

/**
 * 当前应该用的同步目录：配置里有就用配置的，没配过就是 iCloud 默认目录。
 * 也就是说「不改任何设置」也能直接用。
 */
function currentSyncDir(): string {
  return loadConfig().syncDir ?? iCloudSyncDir();
}

/**
 * 把某个目录设成同步目录并打开同步。iCloud 默认目录要求 iCloud Drive 已开；
 * 自己选的目录不检查这个，因为可能是 Syncthing 之类的普通文件夹。
 */
function applySyncDir(dir: string, opts: { requireICloud: boolean }): boolean {
  if (opts.requireICloud && !iCloudAvailable()) {
    dialog.showMessageBoxSync({
      type: 'warning',
      message: 'iCloud Drive 目录不可用',
      detail: `找不到 ${iCloudRoot() ?? '~/Library/Mobile Documents/com~apple~CloudDocs'}。\n` +
        '先在「系统设置 → Apple 账户 → iCloud」里打开 iCloud Drive；' +
        '或者用「文件 → 同步目录…」选一个别的文件夹。',
      buttons: ['好']
    });
    return false;
  }

  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    dialog.showMessageBoxSync({
      type: 'warning',
      message: '建不了同步目录',
      detail: `${dir}\n${(err as Error).message}`,
      buttons: ['好']
    });
    return false;
  }

  server?.setSyncDir(dir);
  saveConfig({ syncDir: dir });
  return true;
}

/** 开关多设备同步，用当前目录（没配过就是 iCloud 默认目录）。 */
function toggleSync(on: boolean): void {
  if (!on) {
    server?.setSyncDir(null);
    saveConfig({ syncDir: null });
    buildMenu();
    return;
  }
  applySyncDir(currentSyncDir(), { requireICloud: loadConfig().syncDir === null });
  buildMenu();
}

/** 选一个同步目录。选完自动打开同步。 */
async function chooseSyncDir(): Promise<void> {
  const result = await dialog.showOpenDialog({
    title: '选择多设备同步目录',
    message: '两台机器指向同一个目录即可（iCloud Drive、Syncthing、Dropbox、局域网共享盘都行）',
    defaultPath: currentSyncDir(),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '用这个目录'
  });
  if (result.canceled || !result.filePaths[0]) {
    buildMenu();
    return;
  }
  applySyncDir(result.filePaths[0], { requireICloud: false });
  buildMenu();
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
        {
          label: '多设备同步',
          type: 'checkbox',
          checked: loadConfig().syncDir !== null,
          click: (item) => { toggleSync(item.checked); }
        },
        {
          label: '同步目录…',
          // macOS 支持 sublabel，直接把当前目录显示在菜单里
          sublabel: currentSyncDir(),
          click: () => { void chooseSyncDir(); }
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
      Menu.getApplicationMenu()?.items.map(i => [
        i.label,
        i.submenu?.items.map(x => (x.sublabel ? `${x.label}（${x.sublabel}）` : x.label))
      ]),
      null, 1
    ));
  }
}

/** 只放行 http/https。别的协议（file、smb、tel、自定义协议）不交给系统打开。 */
function isWebUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function openWindow(): Promise<void> {
  const config = loadConfig();
  const instance = new ATrackerServer({
    dbPath: databasePath(),
    webDir: WEB_DIR,
    // 只监听本机回环，端口交给系统分配，避免和已经在跑的 serve 抢 4178。
    host: '127.0.0.1',
    port: 0,
    // 同步开关记在 ~/.atracker/config.json，命令行和桌面版共用
    syncDir: config.syncDir
  });
  server = instance;
  const addr = await instance.start();

  // 首屏就触发一次扫描，装上就有数据，不用等 5 分钟轮询。
  void instance.triggerScan('manual');

  const windowState = loadWindowState();
  win = new BrowserWindow({
    ...windowState,
    minWidth: 760,
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

  win.on('close', () => {
    if (win) saveWindowState(win.getBounds());
  });
  win.on('closed', () => { win = null; });

  // 页面里的外链交给系统浏览器，不在应用窗口里开新窗口。
  // 只放行 http/https：其它协议（file、smb、tel，以及系统里注册过的自定义协议）
  // 会让系统用别的程序打开，可能泄露凭据或者直接执行东西。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isWebUrl(url)) return { action: 'deny' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // 页面内跳转也一样：只允许留在本地服务上。
  // 少了这一条，页面里的 target=_self 链接或 302 重定向会把窗口带到外部网站，
  // 而窗口还在应用的菜单和 webContents 上下文里。
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(addr.url)) event.preventDefault();
  });

  win.once('ready-to-show', () => {
    win?.show();
    warnIfDuplicateInstall();
  });
  win.webContents.on('did-finish-load', () => {
    console.log(`窗口已加载 ${addr.url}`);
  });
  await win.loadURL(addr.url);
  console.log(`ATracker 已启动：${addr.url} · 数据库 ${databasePath()} · 窗口 ${windowState.width}x${windowState.height}`);
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
    // 「关于」面板显示版本和提交，两台机器对比用
    const b = buildInfo(app.getVersion());
    app.setAboutPanelOptions({
      applicationName: 'ATracker',
      applicationVersion: `${b.version}${b.dirty ? '+' : ''} (${b.commit})`,
      version: b.commit,
      credits: `本机 AI 编码 agent 的 token 用量看板\n${b.builtAt ? '构建于 ' + b.builtAt : ''}`
    });
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
