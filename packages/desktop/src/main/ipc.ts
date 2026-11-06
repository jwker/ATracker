// IPC 注册：把渲染进程的调用转给 service/handlers.ts，把服务事件推给窗口。

import { app, ipcMain, shell, type BrowserWindow } from 'electron';

import { handleApi } from '../../../service/src/handlers.ts';
import type { ATrackerService } from '../../../service/src/service.ts';
import {
  IPC_CHANNEL,
  type ApiCall,
  type ApiMethod,
  type ApiResult,
  type AppInfo
} from '../../../core/src/api.ts';
import { buildInfo } from '../../../core/src/build.ts';

/** 允许通过桥接的方法，其余一律拒绝。 */
const METHODS: readonly ApiMethod[] = ['GET', 'POST'];

/**
 * 校验从渲染进程过来的调用。
 *
 * 页面代码是我们自己的，但这个函数挡住的是「页面被 XSS 之后能做什么」：
 * 通道名是固定的，能调的只有 handlers.ts 里那些接口，传坏数据也不该让主进程抛错。
 */
function normalize(raw: unknown): ApiCall | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.path !== 'string' || !o.path.startsWith('/api/')) return null;
  if (!METHODS.includes(o.method as ApiMethod)) return null;

  const params: Record<string, string | number | boolean | null | undefined> = {};
  if (o.params !== undefined) {
    if (o.params === null || typeof o.params !== 'object') return null;
    for (const [k, v] of Object.entries(o.params as Record<string, unknown>)) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
        params[k] = v as string | number | boolean | null;
      }
    }
  }

  return { method: o.method as ApiMethod, path: o.path, params, body: o.body };
}

/**
 * 注册全部通道。`windows` 用来决定事件推给谁：窗口可能已经关掉，
 * 所以每次推之前重新取一遍列表。
 */
export function registerIpc(service: ATrackerService, windows: () => BrowserWindow[]): () => void {
  ipcMain.handle(IPC_CHANNEL.request, async (_event, raw: unknown): Promise<ApiResult> => {
    const call = normalize(raw);
    if (!call) return { status: 400, body: { error: '调用参数不对' } };
    return handleApi(service, call);
  });

  ipcMain.handle(IPC_CHANNEL.info, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    packaged: app.isPackaged,
    build: buildInfo()
  }));

  ipcMain.handle(IPC_CHANNEL.openDataDir, async (): Promise<void> => {
    await shell.openPath(app.getPath('userData'));
  });

  const off = service.onEvent(event => {
    for (const win of windows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNEL.event, event);
    }
  });

  return () => {
    off();
    for (const channel of Object.values(IPC_CHANNEL)) ipcMain.removeHandler(channel);
  };
}
