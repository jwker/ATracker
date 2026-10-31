// 极简 hash 路由。每个视图的状态都写在自己的 URL 里，视图之间互不影响。
//
// 用 hash 而不是 pathname：服务端只做静态文件托管，没有 history 回退规则；
// 打包成桌面版后可能用 file:// 打开页面，hash 路由两种情况都能用。
//
// 路由形状：
//   #/                                        总账，可带 ?month=YYYY-MM&from=&to=&scope=total
//   #/today                                   今日（今天）
//   #/today/YYYY-MM-DD                        今日（指定日期）
//   #/conversations[?dir=&agent=&model=&vendor=&q=&id=]
//   #/logs[?batch=&level=&source=&q=]
//
// 不带参数就是该视图的默认状态：总账是本月无选区，今日是今天，会话和日志无筛选。

import { useEffect, useState } from 'react';

/** URL 参数列表。值为 null / undefined / 空串时不写进 URL。 */
export type Params = Array<[string, string | null | undefined]>;

export interface Route {
  /** 去掉 # 的路径，例如 '/'、'/today/2026-10-31' */
  path: string;
  params: URLSearchParams;
}

export function parseRoute(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const cut = raw.indexOf('?');
  const path = cut >= 0 ? raw.slice(0, cut) : raw;
  const params = new URLSearchParams(cut >= 0 ? raw.slice(cut + 1) : '');
  return { path: path || '/', params };
}

export function buildHash(path: string, params: Params = []): string {
  const usp = new URLSearchParams();
  for (const [k, v] of params) {
    if (v !== null && v !== undefined && v !== '') usp.set(k, v);
  }
  const q = usp.toString();
  return `#${path}${q ? '?' + q : ''}`;
}

/**
 * 跳转。默认往浏览器历史里加一条，`replace: true` 则替换当前这一条
 * （同一视图里改筛选条件用 replace，免得后退要点很多次）。
 *
 * 用 pushState/replaceState 而不是赋值 location.hash，是为了顺手清掉
 * 旧版 URL 留在 query string 里的参数。
 */
export function navigate(path: string, params: Params = [], opts: { replace?: boolean } = {}): void {
  const url = location.pathname + buildHash(path, params);
  if (location.pathname + location.hash === url) return;
  if (opts.replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  window.dispatchEvent(new Event('routechange'));
}

/** 订阅路由变化。后退/前进走 popstate，手改地址栏走 hashchange。 */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const sync = () => setRoute(parseRoute(location.hash));
    window.addEventListener('routechange', sync);
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('routechange', sync);
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);
  return route;
}
