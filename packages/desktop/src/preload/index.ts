// 预加载脚本：渲染进程能看到的全部主进程能力，都在这里显式列出。
//
// 沙箱打开着（sandbox: true），所以这个文件必须是 CommonJS，也不能做任何 Node
// 的事情——只能 require electron 的两个模块。构建配置里把它的输出格式固定成 cjs。

import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC_CHANNEL,
  type ApiCall,
  type ApiResult,
  type AppInfo,
  type PushEvent
} from '../../../core/src/api.ts';

/**
 * 暴露给页面的对象。渲染进程只能调用这几个方法，拿不到 ipcRenderer，
 * 也就没法往任意通道发消息。
 */
const bridge = {
  /** 版本、平台、构建信息。窗口启动时取一次。 */
  info: (): Promise<AppInfo> => ipcRenderer.invoke(IPC_CHANNEL.info),

  /**
   * 唯一的取数入口。传进来的是一次调用（方法 + 路径 + 参数 + 请求体），
   * 主进程交给 service/handlers.ts 分发；路径不在白名单里就是 404。
   */
  request: (call: ApiCall): Promise<ApiResult> => ipcRenderer.invoke(IPC_CHANNEL.request, call),

  /** 打开数据目录。菜单里有同样的入口，日志页也有按钮。 */
  openDataDir: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNEL.openDataDir),

  /** 订阅扫描/同步事件。返回取消订阅的函数。 */
  onEvent: (listener: (event: PushEvent) => void): (() => void) => {
    const handler = (_e: unknown, payload: PushEvent): void => listener(payload);
    ipcRenderer.on(IPC_CHANNEL.event, handler);
    return () => { ipcRenderer.off(IPC_CHANNEL.event, handler); };
  }
};

export type AtrackerBridge = typeof bridge;

contextBridge.exposeInMainWorld('atracker', bridge);
