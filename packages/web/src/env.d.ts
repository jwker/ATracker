// 渲染进程能看到的全局对象。
//
// 桌面窗口里，preload 会把桥接对象挂到 window.atracker 上；类型定义在
// core/api.ts，preload 实现它。声明成可选，是为了让「桥没加载」这件事
// 在运行时报一句明确的错，而不是类型上假装它一定存在。

import type { AtrackerBridge } from '../../core/src/api.ts';

declare global {
  interface Window {
    atracker?: AtrackerBridge;
  }
}

export {};
