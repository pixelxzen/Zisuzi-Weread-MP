import { test } from 'node:test';
import assert from 'node:assert/strict';

const pg = await import('../dist/paging.mjs');

/* 实测数据（2026-10-20，孙可可keke MP_WXS_3878069141）：
   offset=0 → 20 条, offset=20 → 19 条, offset=40 → 9 条, offset=60 → 0 条
   最早一篇 2019-01-04，全部 48 篇。 */

test('返回 19 条不算到底（旧逻辑在此提前封底）', () => {
  assert.equal(pg.isExhausted(19), false);
  assert.equal(pg.isExhausted(9), false);
  assert.equal(pg.isExhausted(1), false);
  assert.equal(pg.isExhausted(0), true);
});

test('offset 按 20 槽位推进，不按返回条数累加', () => {
  assert.equal(pg.nextOffset(0), 20);
  assert.equal(pg.nextOffset(20), 40);
  // 旧 bug 的形状：第二页只回 19 条就 offset=39，会重复 2025-06-19 那条
  assert.notEqual(pg.nextOffset(20), 20 + 19);
  assert.equal(pg.nextOffset(40), 60);
});

test('一路滚到最早一篇：20/19/9/0 → 48 篇且确认到底', () => {
  const r = pg.walkPages([20, 19, 9, 0]);
  assert.deepEqual(r.offsets, [0, 20, 40, 60]);
  assert.equal(r.total, 48);
  assert.equal(r.exhausted, true);
});

test('反例：旧逻辑「<20 就当最后一页」在第二页（19 条）就封底，停 39 篇', () => {
  // 旧代码顺序：先 total += len，再 if (len < 20) break
  let total = 0;
  let pages = 0;
  for (const len of [20, 19, 9, 0]) {
    total += len;
    pages += 1;
    if (len < 20) break; // 旧判定：19 条被当最后一页
  }
  assert.equal(total, 39);
  assert.equal(pages, 2);
  assert.equal(total < 48, true); // 剩下 9 篇（2025-06-18 往前到 2019-01-04）永远拉不到
});

test('反例：旧逻辑按返回条数推进 offset 会重复一条', () => {
  // 第一页 20 条 → offset=20；第二页只回 19 条 → offset=39
  // 实测 offset=39 返回的首条正是第二页末条 2025-06-19（重复），
  // 正确接续要从 offset=40 开始。
  let offset = 0;
  offset += 20; // 第一页
  assert.equal(offset, 20);
  offset += 19; // 第二页（按返回条数）
  assert.equal(offset, 39);
  assert.notEqual(offset, 40); // 差这一位 → 重复一条
});

test('用户滚动未到底时不应被误判（连续短页也不封底）', () => {
  const r = pg.walkPages([20, 3, 2, 0]);
  assert.equal(r.exhausted, true);
  assert.equal(r.total, 25);
  // 3 条、2 条都不触发提前封底
  assert.equal(r.offsets.includes(0), true);
});

test('inferOffsetFromCache：用已缓存篇数推断下一页起点', () => {
  assert.equal(pg.inferOffsetFromCache(0), 0);
  assert.equal(pg.inferOffsetFromCache(19), 0);
  assert.equal(pg.inferOffsetFromCache(20), 20);
  assert.equal(pg.inferOffsetFromCache(39), 20);
  assert.equal(pg.inferOffsetFromCache(48), 40);
});
