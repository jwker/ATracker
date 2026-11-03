// 卡片取数的边界用例。
//
// 卡片的数据来源是 URL 里的参数和接口返回，理论上什么值都可能出现。
// 非法输入不能变成异常——弹窗会直接白屏，用户连错在哪都看不出来。
//
// 跑法：node --test packages/web/src/card/data.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { monthsBetween, dayList, splitValue, buildRangeCard, buildTodayCard } from './data.ts';

test('非法月份区间返回空数组，不产生垃圾结果', () => {
  assert.deepEqual(monthsBetween('x', '2026-11'), []);
  assert.deepEqual(monthsBetween('2026-11', 'x'), []);
  assert.deepEqual(monthsBetween('2026-13', '2026-14'), []);
  assert.deepEqual(monthsBetween('', ''), []);
});

test('月份区间正常', () => {
  assert.deepEqual(monthsBetween('2026-06-11', '2026-11-02'), [
    '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'
  ]);
  assert.deepEqual(monthsBetween('2026-11-01', '2026-11-30'), ['2026-11']);
});

test('非法日期区间返回空数组', () => {
  assert.deepEqual(dayList('x', '2026-11-30'), []);
  assert.deepEqual(dayList('2026-11-30', 'x'), []);
  assert.deepEqual(dayList('2026-02-30', '2026-03-01'), []);   // 2 月没有 30 号
  assert.deepEqual(dayList('2026-11-30', '2026-11-01'), []);   // from 比 to 大
});

test('日期区间正常', () => {
  const d = dayList('2026-10-01', '2026-10-31');
  assert.equal(d.length, 31);
  assert.equal(d[0], '2026-10-01');
  assert.equal(d[d.length - 1], '2026-10-31');
});

test('大数字的单位不会越界', () => {
  // 99999999 在万位上是 9999.9999，四舍五入到一位小数是 10000.0 万，
  // 读起来比 1 亿还大，要提升一档。
  assert.deepEqual(splitValue(99999999), { value: '1.00', unit: '亿' });
  assert.deepEqual(splitValue(100000000), { value: '1.00', unit: '亿' });
  assert.deepEqual(splitValue(9999), { value: '9999', unit: '' });
  assert.deepEqual(splitValue(12345678), { value: '1234.6', unit: '万' });
});

test('区间非法时范围卡不抛异常', () => {
  const card = buildRangeCard({
    kind: 'month',
    from: 'x',
    to: 'y',
    agg: { total: 0, buckets: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, byModel: [] } as any,
    calendars: [],
    version: 'test'
  });
  assert.equal(card.bars.length, 0);
  assert.deepEqual(card.axisLabels, []);
  assert.equal(card.chartNoteLeft, '没有数据');
});

test('同一天出现在多份日历里要累加', () => {
  const agg = { total: 300, buckets: { input: 100, output: 100, cacheRead: 100, cacheWrite: 0 }, byModel: [] } as any;
  const day = { day: '2026-10-01', total: 100 };
  const card = buildRangeCard({
    kind: 'month',
    from: '2026-10-01',
    to: '2026-10-01',
    agg,
    calendars: [{ month: '2026-10', days: [day] } as any, { month: '2026-10', days: [day] } as any],
    version: 'test'
  });
  assert.equal(card.bars.length, 1);
  assert.equal(card.bars[0]!.v, 1, '两根柱子叠在一起，总量是 200 而不是 100');
});

test('远端设备没有逐轮明细时不报「高峰 00:00」', () => {
  const card = buildTodayCard({
    date: '2026-11-02', weekday: '周一', isToday: false, scope: 'remote', canDetail: false,
    cutoff: '23:59',
    today: { tokens: 1000, events: null, buckets: { input: 100, output: 100, cacheRead: 800, cacheWrite: 0 } },
    hourly: [],
    byModel: []
  } as any, 'test');
  assert.equal(card.bars.length, 0);
  assert.match(card.chartNoteLeft, /没有逐轮明细/);
});
