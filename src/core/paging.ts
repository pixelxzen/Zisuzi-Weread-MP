/**
 * 公众号列表分页 —— 纯逻辑，不依赖 Obsidian，可单测。
 *
 * 实测依据（2026-10-20，孙可可keke MP_WXS_3878069141，同一份有效 cookie）：
 *
 *   offset=0  → 20 条   （2026-10-14 ~ 2026-07-12）
 *   offset=20 → 19 条   （2026-07-10 ~ 2025-06-19）  ← 服务端过滤掉一条
 *   offset=40 →  9 条   （2025-06-18 ~ 2019-01-04）  ← 最早那篇
 *   offset=60 →  0 条   （真正到底）
 *
 * 由这两组数字定下两条铁律，v4.5.0 及之前的两个 bug 都是违反它们造成的：
 *
 * 1. offset 必须按服务端页槽位（20）固定推进。
 *    按「返回条数」累加会错位：offset=39 会重复返回 2025-06-19 那条，后面的页全歪。
 * 2. 「到底」的唯一判据是服务端返回 0 条。
 *    返回 19 / 9 条都只是「服务端过滤后剩下的」，不是最后一页 —— 旧逻辑用
 *    `items.length < 20` 判到底，于是孙可可keke 只加载 20 篇就显示「已经到底了」，
 *    用户永远滚不到 2019 年那篇。
 */

/** 服务端每页的槽位数（不是每页返回条数） */
export const LIST_PAGE_SIZE = 20;

/** 下一页 offset：固定按槽位推进 */
export function nextOffset(current: number): number {
  const n = Number.isFinite(current) ? Math.max(0, Math.trunc(current)) : 0;
  return n + LIST_PAGE_SIZE;
}

/** 是否到底：返回 0 条才算；19 / 9 都不算 */
export function isExhausted(pageLen: number): boolean {
  return !pageLen || pageLen <= 0;
}

/**
 * 老库升级（v4.5.1）后 offset 被清空时，用「已缓存篇数」推断下一页起点，
 * 免得用户第一次滚动又重复拉第一页。
 */
export function inferOffsetFromCache(cachedCount: number): number {
  const n = Number.isFinite(cachedCount) ? Math.max(0, Math.trunc(cachedCount)) : 0;
  if (n === 0) return 0;
  return Math.floor(n / LIST_PAGE_SIZE) * LIST_PAGE_SIZE;
}

/**
 * 推演「滚到底反复翻页」的完整过程，返回每次请求的 offset、累计篇数、是否到底。
 * 用来把上面那组实测数据固化成回归测试。
 */
export function walkPages(pageLens: number[]): { offsets: number[]; total: number; exhausted: boolean } {
  const offsets: number[] = [];
  let offset = 0;
  let total = 0;
  let exhausted = false;
  for (const len of pageLens) {
    offsets.push(offset);
    total += Math.max(0, len);
    if (isExhausted(len)) {
      exhausted = true;
      break;
    }
    offset = nextOffset(offset);
  }
  return { offsets, total, exhausted };
}
