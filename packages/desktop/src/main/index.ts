// 主进程入口：窗口、菜单、单实例、自定义协议。
//
// 不需要再起一个本地 HTTP 服务：应用服务（数据库、扫描、监听、同步）就在这个进程里，
// 页面通过 preload 暴露的 IPC 取数。构建产物在 out/，由 electron-vite 生成。

import { app, BrowserWindow, dialog, Menu, protocol, screen, shell, type MenuItemConstructorOptions } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';

import { ATrackerService } from '../../../service/src/service.ts';
import { registerIpc } from './ipc.ts';
import { iCloudAvailable, iCloudRoot, iCloudSyncDir, loadConfig, saveConfig } from '../../../core/src/config.ts';
import { buildInfo } from '../../../core/src/build.ts';

/** 打包后是 .../Resources/app.asar，开发时是仓库根目录。 */
const ROOT = app.getAppPath();
/** electron-vite 的构建产物目录，main / preload / renderer 三段都在里面。 */
const OUT = join(ROOT, 'out');
const RENDERER_DIR = join(OUT, 'renderer');
const PRELOAD_FILE = join(OUT, 'preload', 'index.cjs');
/** 开发时 electron-vite 会把渲染进程的 Vite 服务器地址放到这个变量里。 */
const DEV_URL = process.env.ELECTRON_RENDERER_URL;
/** 冒烟检查：不显示窗口、不弹对话框，跑完打印结果就退出。 */
const SMOKE_TEST = !!process.env.ATRACKER_SMOKE_TEST;
/** 生产环境的页面来源。window.location.origin 就是它，localStorage 按它分区。 */
const APP_ORIGIN = 'app://atracker';

// 构建信息不在模块旁边（bundle 之后 import.meta.url 指向 out/main），
// 显式告诉 core/build.ts 去哪儿找。开发时这个文件不存在，会回落成 dev。
process.env.ATRACKER_BUILDINFO = join(ROOT, 'build', 'buildinfo.json');

// 开发时把用户数据换到仓库里的一个目录。不这么做的话，`npm run desktop` 会和
// 「应用程序」里装的那一份抢同一个单实例锁，启动时弹一句「ATracker 已经在运行」，
// 窗口位置也会跟着一起改。打包后的路径保持不变。
if (!app.isPackaged) {
  app.setPath('userData', join(ROOT, '.dev-userdata'));
}

// 页面用一个自定义协议加载，不用 file://：file:// 没有可用的 origin，
// localStorage（明暗模式、单位偏好）会失效，也没法在响应头里给 CSP。
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

let service: ATrackerService | null = null;
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

  service?.setSyncDir(dir);
  saveConfig({ syncDir: dir });
  return true;
}

/** 开关多设备同步，用当前目录（没配过就是 iCloud 默认目录）。 */
function toggleSync(on: boolean): void {
  if (!on) {
    service?.setSyncDir(null);
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
          click: () => { void service?.triggerScan('manual'); }
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

/** 静态文件的内容类型。渲染进程只有这几种文件。 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};

/**
 * 每个响应都带的安全头。以前由 HTTP 服务加，现在由协议处理器加。
 * 页面里有本机用量，XSS 的后果比一般站点大。
 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
};

/**
 * 把 out/renderer 挂到 app:// 上。
 *
 * 拼出来跑到目录外面的请求一律 404。页面是哈希路由，不需要「找不到就返回
 * index.html」的兜底，拼错的路径应该如实报错。
 */
function serveRenderer(): void {
  protocol.handle('app', async request => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const target = normalize(join(RENDERER_DIR, rel));
    const inside = relative(RENDERER_DIR, target);
    const notFound = (): Response =>
      new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
    if (inside.startsWith('..') || isAbsolute(inside)) return notFound();
    if (!existsSync(target) || !statSync(target).isFile()) return notFound();

    const body = await readFile(target);
    return new Response(new Uint8Array(body), {
      headers: {
        'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
        // 产物文件名带 hash，页面本身不缓存就行
        'Cache-Control': 'no-cache',
        ...SECURITY_HEADERS
      }
    });
  });
}

async function openWindow(): Promise<void> {
  const windowState = loadWindowState();
  win = new BrowserWindow({
    ...windowState,
    minWidth: 760,
    minHeight: 560,
    title: 'ATracker',
    backgroundColor: '#cfd0cb',
    show: false,
    webPreferences: {
      preload: PRELOAD_FILE,
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

  // 页面内跳转也一样：只允许留在这个页面自己的来源上。
  // 少了这一条，页面里的 target=_self 链接或 302 重定向会把窗口带到外部网站，
  // 而窗口还在应用的菜单和 webContents 上下文里。
  const origin = DEV_URL ?? APP_ORIGIN;
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) event.preventDefault();
  });

  win.once('ready-to-show', () => {
    if (SMOKE_TEST) return;
    win?.show();
    warnIfDuplicateInstall();
  });
  win.webContents.on('did-finish-load', () => {
    console.log(`窗口已加载 ${origin}`);
  });
  await win.loadURL(DEV_URL ?? `${APP_ORIGIN}/index.html`);
  console.log(`ATracker 已启动：${origin} · 数据库 ${databasePath()} · 窗口 ${windowState.width}x${windowState.height}`);
  if (SMOKE_TEST) await runSmokeTest(win);
}

/**
 * 端到端冒烟检查：页面真的挂载了、桥接能调、端口没通也能取数、localStorage 可用。
 *
 * 只在设了 `ATRACKER_SMOKE_TEST=1` 时跑，跑完打印一行 JSON 并以退出码报告结果。
 * 窗口不显示，所以不会打扰正在用电脑的人。用来验证打包产物，不进入日常启动路径。
 */
async function runSmokeTest(target: BrowserWindow): Promise<void> {
  // 给 React 首屏和一次 IPC 往返留时间
  await new Promise(resolve => setTimeout(resolve, 1200));
  const result = await target.webContents.executeJavaScript(`(async () => {
    const bridge = window.atracker;
    const info = bridge ? await bridge.info() : null;
    const total = bridge ? await bridge.request({ method: 'GET', path: '/api/total' }) : null;
    let stored = false;
    try {
      localStorage.setItem('__smoke', '1');
      stored = localStorage.getItem('__smoke') === '1';
      localStorage.removeItem('__smoke');
    } catch { stored = false; }
    return {
      mounted: document.querySelector('#app')?.children.length ?? 0,
      bridge: !!bridge,
      version: info?.version ?? null,
      commit: info?.build?.commit ?? null,
      totalStatus: total?.status ?? null,
      tokens: total?.body?.total ?? null,
      stored
    };
  })()`) as { mounted: number; bridge: boolean; totalStatus: number | null; stored: boolean };

  const ok = result.mounted > 0 && result.bridge && result.totalStatus === 200 && result.stored;
  console.log(`SMOKE ${ok ? 'PASS' : 'FAIL'} ${JSON.stringify(result)}`);
  app.exit(ok ? 0 : 1);
}

// 单实例：两个进程同时写一个 SQLite 文件没必要，也容易互相抢写锁。
if (!app.requestSingleInstanceLock()) {
  // 拿不到锁说明已经有一个在跑。这里要给出反馈，否则用户只会看到「双击没反应」。
  // 主实例会在 second-instance 事件里把窗口提到前面。
  app.whenReady().then(() => {
    // 冒烟检查不能停在对话框上等一个永远按不到的按钮，直接报失败
    if (SMOKE_TEST) {
      console.error('SMOKE FAIL 已经有另一个实例在运行，换一个 --user-data-dir 再跑');
      app.exit(1);
      return;
    }
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
    // 协议处理器要在创建窗口之前注册，否则第一次加载拿不到文件
    serveRenderer();
    // 同步开关记在 ~/.atracker/config.json，命令行和桌面版共用
    const instance = new ATrackerService({
      dbPath: databasePath(),
      syncDir: loadConfig().syncDir
    });
    service = instance;
    instance.start();
    // 首屏就触发一次扫描，装上就有数据，不用等 5 分钟轮询。
    void instance.triggerScan('manual');
    // 事件只推给当前窗口。窗口可能关掉，所以每次推之前重新问一遍。
    registerIpc(instance, () => (win ? [win] : []));
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
    void service?.close();
  });
}
