// 路由的回归测试。
//
// 路由是 hash 路由：路径写在 location.hash 里。这里最容易出的错是拼接 URL
// 时把旧的 hash 一起带上，于是路径越点越长（#/#/today#/#/month），
// 解析出来始终是 '/'，页面看着就是「点不动」。
//
// 跑法：node --test packages/web/src/router.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRoute, buildHash, navigate } from './router.ts';

/** 装一个假的 location / history，返回设置 URL 的函数。 */
function fakeDom(href: string): (next: string) => void {
  const g = globalThis as any;
  let current = href;
  g.location = {
    get href() { return current; },
    get hash() { return current.slice(current.indexOf('#')); },
    get pathname() { return current.slice(0, current.indexOf('#')).split('?')[0]; },
    get search() { const i = current.indexOf('?'); return i < 0 ? '' : current.slice(i); }
  };
  g.history = {
    pushState: (_a: unknown, _b: string, url: string) => { current = url; },
    replaceState: (_a: unknown, _b: string, url: string) => { current = url; }
  };
  g.window = { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} };
  return (next: string) => { current = next; };
}

test('parseRoute 拆出路径和参数', () => {
  const r = parseRoute('#/today/2026-10-31?scope=total');
  assert.equal(r.path, '/today/2026-10-31');
  assert.equal(r.params.get('scope'), 'total');

  assert.equal(parseRoute('#/').path, '/');
  assert.equal(parseRoute('#').path, '/');
  assert.equal(parseRoute('').path, '/');
});

test('buildHash 空参数不写问号', () => {
  assert.equal(buildHash('/'), '#/');
  assert.equal(buildHash('/today', [['scope', 'total']]), '#/today?scope=total');
  assert.equal(buildHash('/today', [['scope', null], ['q', '']]), '#/today');
});

test('navigate 换页时不把旧的 hash 带进新 URL', () => {
  const set = fakeDom('http://127.0.0.1:4178/#/today');
  navigate('/month');
  const g = globalThis as any;
  assert.equal(g.location.href, 'http://127.0.0.1:4178/#/month');
  // 连续换页，hash 不能越接越长
  navigate('/');
  assert.equal(g.location.href, 'http://127.0.0.1:4178/#/');
  navigate('/logs');
  assert.equal(g.location.href, 'http://127.0.0.1:4178/#/logs');
  set('');
});

test('navigate 清掉旧版留在 query string 里的参数', () => {
  fakeDom('http://127.0.0.1:4178/?legacy=1#/today');
  navigate('/month');
  const g = globalThis as any;
  assert.equal(g.location.href, 'http://127.0.0.1:4178/#/month');
});

test('navigate 到当前地址时不推历史', () => {
  fakeDom('http://127.0.0.1:4178/#/month');
  const g = globalThis as any;
  let pushed = 0;
  let replaced = 0;
  g.history.pushState = () => { pushed++; };
  g.history.replaceState = () => { replaced++; };
  navigate('/month');
  assert.equal(pushed, 0, '同一个地址不该再推一条历史');
  assert.equal(replaced, 0, '也不该替换');
});

test('navigate 默认推历史，replace 时替换', () => {
  fakeDom('http://127.0.0.1:4178/#/month');
  const g = globalThis as any;
  let pushed = 0;
  let replaced = 0;
  g.history.pushState = () => { pushed++; };
  g.history.replaceState = () => { replaced++; };
  navigate('/today');
  assert.equal(pushed, 1);
  assert.equal(replaced, 0);
  navigate('/logs', [], { replace: true });
  assert.equal(pushed, 1);
  assert.equal(replaced, 1);
});
