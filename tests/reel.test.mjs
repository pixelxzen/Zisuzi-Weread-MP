import { test } from 'node:test';
import assert from 'node:assert/strict';

const rl = await import('../dist/reel.mjs');

/** 造 32x32 签名：fill 决定亮度，便于控制 MAD */
const sig = (fill, bytes) => ({ sig: new Array(1024).fill(fill), bytes });

/* ------------------------------ mad ------------------------------ */

test('mad：完全相同 = 0，全黑 vs 全白 = 1', () => {
  assert.equal(rl.mad(new Array(1024).fill(10), new Array(1024).fill(10)), 0);
  assert.equal(rl.mad(new Array(1024).fill(0), new Array(1024).fill(255)), 1);
  assert.ok(Math.abs(rl.mad(new Array(1024).fill(0), new Array(1024).fill(25.5)) - 0.1) < 1e-6);
});

/* ------------------------- 停顿（字节游程） ------------------------- */

test('停顿：连续字节相同 → 折成 1 个 pose，权重 = 游程长度', () => {
  const sigs = [0, 1, 2, 3, 4].map(() => sig(100, 'SAME'));
  const p = rl.planReel(sigs, { stillsMinWeight: 1 });
  assert.equal(p.poses, 1, '字节全同应折成 1 个 pose');
  assert.equal(p.slices, 5);
  assert.equal(p.frames.length, 1);
  assert.equal(p.frames[0].weight, 5, '停顿时长必须等于游程长度');
  assert.equal(p.stills.length, 1);
});

test('停顿被异图切断时，游程不能跨段合并', () => {
  const sigs = [sig(10, 'A'), sig(10, 'A'), sig(200, 'B'), sig(10, 'A'), sig(10, 'A'), sig(10, 'A')];
  const p = rl.planReel(sigs, { stillsMinWeight: 1 });
  assert.equal(p.poses, 3, 'poses 应为 A/B/A 三段');
  assert.deepEqual(p.frames.map((f) => f.weight), [2, 1, 3]);
});

/* ---------------------------- 序列帧（运动） ---------------------------- */

test('序列帧：字节不同但视觉相近 → 抽样保留运动，不能压成 1 帧', () => {
  const sigs = Array.from({ length: 72 }, (_, i) => sig(100 + (i % 3), `B${i}`));
  const p = rl.planReel(sigs, { sampleEvery: 8 });
  assert.equal(p.poses, 72);
  assert.equal(p.motionClusters, 1, '视觉上应聚成一簇');
  assert.equal(p.frames.length, Math.ceil(72 / 8), '每 8 原帧抽 1 帧');
  assert.ok(p.frames.length > 2, '绝不能压成 1 帧');
  assert.equal(p.frames[p.frames.length - 1].index, 71, '最后一帧必须是段尾');
  const total = p.frames.reduce((s, f) => s + f.weight, 0);
  assert.ok(Math.abs(total - 72) <= p.frames.length, `权重合计 ${total} 应≈72`);
});

test('内容页：MAD 差异大 → 各自成帧，各权重 = 自身停留', () => {
  const sigs = [sig(0, 'a'), sig(120, 'b'), sig(255, 'c')];
  const p = rl.planReel(sigs, { stillsMinWeight: 1 });
  assert.equal(p.motionClusters, 3);
  assert.deepEqual(p.frames.map((f) => f.index), [0, 1, 2]);
  assert.deepEqual(p.frames.map((f) => f.weight), [1, 1, 1]);
});

test('聚类锚点是簇首，不是上一帧（防逐帧漂移吞掉整段）', () => {
  const sigs = [0, 1, 2, 3, 4, 5].map((v, i) => sig(v, `d${i}`));
  const p = rl.planReel(sigs, { motionThreshold: 0.01, sampleEvery: 1 });
  assert.ok(p.motionClusters >= 2, `簇数 ${p.motionClusters}；按上一帧比较会塌成 1 簇`);
});

/* ------------------------- 静帧筛选（页面级） ------------------------- */

test('静帧按停留权重筛：一闪而过的过渡态（权重 1）不出图', () => {
  const sigs = [
    sig(0, 'p1'), sig(0, 'p1'),                 // 页面 A，停留 2
    sig(200, 't1'),                              // 过渡帧，停留 1
    sig(60, 'p2'), sig(60, 'p2'), sig(60, 'p2'), // 页面 B，停留 3
  ];
  const p = rl.planReel(sigs, { stillsThreshold: 0.05, stillsMinWeight: 2 });
  const idx = p.stills.map((s) => s.index);
  assert.ok(idx.includes(0), '权重 2 的页面要保留');
  assert.ok(!idx.includes(2), '权重 1 的过渡帧必须被筛掉');
  assert.ok(idx.includes(3), '权重 3 的页面要保留');
  assert.equal(p.stills.find((s) => s.index === 3).weight, 3);
});

test('静帧代表取簇内停得最久的那一帧', () => {
  const sigs = [sig(50, 'a'), sig(50, 'b'), sig(50, 'b'), sig(50, 'b'), sig(50, 'c')];
  const p = rl.planReel(sigs, { stillsThreshold: 0.5, stillsMinWeight: 1 });
  assert.equal(p.stills.length, 1);
  assert.equal(p.stills[0].index, 1, '应取权重最大的 pose 的起始帧');
  assert.equal(p.stills[0].weight, 5);
});

test('空输入不崩', () => {
  const p = rl.planReel([]);
  assert.deepEqual(p.frames, []);
  assert.deepEqual(p.stills, []);
  assert.equal(p.slices, 0);
});

/* ------------------------------ SVG ------------------------------ */

const imgs = (n) => Array.from({ length: n }, (_, i) => ({ dataUri: `data:image/webp;base64,AAA${i}`, weight: i + 1 }));

test('buildReelSvg：帧数/自包含/keyTimes 合法/dur 按权重', () => {
  const svg = rl.buildReelSvg(imgs(4), { width: 900, height: 1100, slotMs: 250 });
  assert.equal((svg.match(/<image /g) || []).length, 4);
  assert.equal((svg.match(/<animate /g) || []).length, 4);
  assert.ok(!/href="https?:/.test(svg), '不能有外链');
  assert.ok(!svg.includes('<script'), '不能有脚本');
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('dur="2.500s"'), '总时长 = (1+2+3+4)*250ms');
  assert.equal((svg.match(/opacity="1"/g) || []).length, 1, '只有首帧 opacity=1');
  for (const m of svg.matchAll(/keyTimes="([^"]+)"/g)) {
    const ts = m[1].split(';').map(Number);
    assert.ok(ts.every((t) => t >= 0 && t <= 1), `keyTimes 越界: ${m[1]}`);
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] >= ts[i - 1], `keyTimes 非单调: ${m[1]}`);
  }
});

test('buildReelSvg：单帧 / 空输入', () => {
  const one = rl.buildReelSvg([{ dataUri: 'data:image/webp;base64,AAA', weight: 1 }], { width: 100, height: 100, slotMs: 500 });
  assert.equal((one.match(/<image /g) || []).length, 1);
  assert.ok(one.includes('dur="0.500s"'));
  assert.equal(rl.buildReelSvg([], { width: 100, height: 100, slotMs: 100 }), '');
});
