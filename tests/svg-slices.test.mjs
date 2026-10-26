import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sv = await import('../dist/svg-slices.mjs');
const md = await import('../dist/html2md.mjs');

const FIXTURE = 'tests/fixtures/svg-bitmap-e2cool.html';
const real = fs.readFileSync(FIXTURE, 'utf8');

/* ---------------- 真实样本（《8分钟与17节台阶｜8MIN/17》，E2.COOL，2026-10-26 归档） ---------------- */

test('真实样本：htmlToMarkdown 返回全空（这就是旧版本丢掉正文的原因）', () => {
  const r = md.htmlToMarkdown(real);
  assert.equal(r.markdown.trim(), '');
  assert.equal(r.images.length, 0);
  assert.equal(r.media.length, 0);
});

test('真实样本：识别为 SVG 交互图文变体 B', () => {
  const d = sv.detectSvgBitmap(real);
  assert.equal(d.isBitmapArticle, true);
  assert.equal(d.stats.textNodes, 0);
  assert.equal(d.stats.imgTags, 0);
  assert.equal(d.stats.editor, 'e2.cool');
  assert.ok(d.stats.svgRoots >= 20, `svgRoots=${d.stats.svgRoots}`);
});

test('真实样本：按文档顺序抽出 26 张切片，URL 已还原 &amp;', () => {
  const d = sv.detectSvgBitmap(real);
  assert.equal(d.slices.length, 26);
  for (const s of d.slices) {
    assert.ok(s.src.startsWith('https://mmbiz.qpic.cn/'), s.src.slice(0, 60));
    assert.ok(!s.src.includes('&amp;'), `未还原实体: ${s.src}`);
    assert.ok(!s.src.includes('&quot;'), `未还原实体: ${s.src}`);
  }
  // 封面是第一张，且是 GIF
  assert.ok(/wx_fmt=gif/.test(d.slices[0].src));
  assert.equal(d.stats.gifCount, 2);
});

test('真实样本：切片顺序稳定且无重复', () => {
  const a = sv.detectSvgBitmap(real).slices.map((s) => s.src);
  const b = sv.detectSvgBitmap(real).slices.map((s) => s.src);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
});

test('真实样本：正文生成 26 个 @@IMG 占位 + 技术指纹说明', () => {
  const d = sv.detectSvgBitmap(real);
  const body = sv.buildSvgBitmapMarkdown(d);
  assert.equal((body.match(/@@IMG\d+@@/g) || []).length, 26);
  assert.ok(body.includes('SVG 交互图文'));
  assert.ok(body.includes('26 张切片'));
  assert.ok(body.includes('e2.cool'));
  // 占位从 0 起连续
  assert.ok(body.includes('@@IMG0@@'));
  assert.ok(body.includes('@@IMG25@@'));
  assert.ok(!body.includes('@@IMG26@@'));
});

test('imageOffset：与已有图片混排时不串号', () => {
  const d = sv.detectSvgBitmap(real);
  const body = sv.buildSvgBitmapMarkdown(d, 3);
  assert.ok(body.includes('@@IMG3@@'));
  assert.ok(body.includes('@@IMG28@@'));
  assert.ok(!body.includes('@@IMG0@@'));
});

/* ---------------------------- 反例：不能误判 ---------------------------- */

test('corpus 层（隐形 AI 语料 <text>）不阻止识别，且被抽出来', () => {
  const corpus = '如果秋天只选一朵花，你觉得，会是哪一朵？我最后留下桂花。它细小，成簇，藏在叶间，香气却常常先一步抵达。';
  const html = `<div id="js_content">
    <section powered-by="e2.cool"><svg viewBox="0 0 1080 1080" label="AI语料学习文本">
      <text opacity="0"><tspan x="0" y="0">${corpus}</tspan></text>
    </svg></section>
    <section><svg viewBox="0 0 1080 1291"><rect style="background-image:url('https://mmbiz.qpic.cn/a.png')"/></svg></section>
    <section><svg viewBox="0 0 1080 1291"><rect style="background-image:url('https://mmbiz.qpic.cn/b.png')"/></svg></section>
  </div>`;
  const d = sv.detectSvgBitmap(html);
  assert.equal(d.isBitmapArticle, true, '有 1 个 <text> 也必须认出来（真实样本踩过这个坑）');
  assert.equal(d.stats.textNodes, 1);
  assert.equal(d.slices.length, 2);
  assert.equal(d.corpusText, corpus);
  // 关键：这层语料会让 htmlToMarkdown 抽出非空正文，所以门禁不能看 markdown 是否为空
  const conv = md.htmlToMarkdown(html);
  assert.ok(conv.markdown.trim().length > 0, 'htmlToMarkdown 应该抽到语料文字');
  assert.equal(sv.textOutsideSvg(html), 0, 'SVG 外加起来不该有字');
  const body = sv.buildSvgBitmapMarkdown(d);
  assert.ok(body.includes(corpus));
  assert.ok(body.includes('AI 语料层'));
  assert.ok(body.includes('1 个文本节点（不可读）'));
});

test('textOutsideSvg：SVG 外的真实正文能被数出来', () => {
  const body = `<section><svg><text><tspan>语料诱饵</tspan></text><rect style="background-image:url(x)"/></svg></section>
    <p>这是一段真正的正文，长度足够大，应该被数出来。</p>`;
  const n = sv.textOutsideSvg(body);
  assert.ok(n >= 20, `realTextLen=${n}`);
});

test('正文在 SVG 外面 + 2 张背景图的普通文章不误判', () => {
  const html = `<div id="js_content">
    <section style="background-image:url('https://mmbiz.qpic.cn/a.png')"></section>
    <section style="background-image:url('https://mmbiz.qpic.cn/b.png')"></section>
    <p>这是一篇正常的图文，正文在 SVG 外面，虽然也有几张背景图，但绝不能被当成位图切片而且把文字丢掉。</p>
  </div>`;
  assert.equal(sv.detectSvgBitmap(html).isBitmapArticle, false);
});

test('过短的隐形文字不采信（防装饰性 <text> 噪声）', () => {
  const html = `<div id="js_content" powered-by="e2.cool">
    <svg viewBox="0 0 1080 100"><text><tspan>装饰</tspan></text>
      <rect style="background-image:url('https://mmbiz.qpic.cn/a.png')"/></svg>
    <svg viewBox="0 0 1080 100"><rect style="background-image:url('https://mmbiz.qpic.cn/b.png')"/></svg>
  </div>`;
  assert.equal(sv.detectSvgBitmap(html).corpusText, '');
});

test('真实样本（8分钟）没有语料层 → corpusText 为空', () => {
  const d = sv.detectSvgBitmap(real);
  assert.equal(d.corpusText, '');
  assert.equal(d.stats.textNodes, 0);
});

test('普通图文（有 <img> 有文本）不判为位图切片', () => {
  const html = `<div id="js_content">
    <section style="background-image:url('https://mmbiz.qpic.cn/a.png')"></section>
    <section style="background-image:url('https://mmbiz.qpic.cn/b.png')"></section>
    <p>正常段落</p><img data-src="https://mmbiz.qpic.cn/c.jpg">
  </div>`;
  assert.equal(sv.detectSvgBitmap(html).isBitmapArticle, false);
});

test('SVG 里有 <text> 的（变体 A）不判为位图切片', () => {
  const html = `<div id="js_content"><svg viewBox="0 0 1080 9000">
    <text y="100">可还原的文字</text>
    <image href="https://mmbiz.qpic.cn/x.png"/>
  </svg></div>`;
  const d = sv.detectSvgBitmap(html);
  assert.equal(d.isBitmapArticle, false);
  assert.ok(d.stats.textNodes > 0);
});

test('只有一张背景图不判（阈值 2 张）', () => {
  const html = `<div id="js_content"><svg viewBox="0 0 1080 100">
    <rect style="background-image:url('https://mmbiz.qpic.cn/only.png')"/>
  </svg></div>`;
  assert.equal(sv.detectSvgBitmap(html).isBitmapArticle, false);
});

test('空 HTML / 无 js_content 不崩', () => {
  assert.equal(sv.detectSvgBitmap('').isBitmapArticle, false);
  assert.equal(sv.detectSvgBitmap('<html><body>hi</body></html>').isBitmapArticle, false);
});

/* ------------------------- 单块工具函数 ------------------------- */

test('splitTopLevelSvg：嵌套 foreignObject 内层 svg 不被重复计数', () => {
  const body = `<svg id="a"><foreignObject><svg id="inner"></svg></foreignObject></svg>
                <svg id="b"></svg>`;
  const blocks = sv.splitTopLevelSvg(body);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].includes('id="inner"'));
});

test('extractBgUrls：data: URI 被跳过，重复引用去重', () => {
  const block = `<svg><rect style="background-image:url('data:image/png;base64,AA')"/>
    <rect style="background-image:url(https://mmbiz.qpic.cn/1.png)"/>
    <rect style='background-image: url("https://mmbiz.qpic.cn/1.png")'/>
    <rect style="background-image:url(&quot;https://mmbiz.qpic.cn/2.png&quot;)"/></svg>`;
  const urls = sv.extractBgUrls(sv.splitTopLevelSvg(block).join(''));
  assert.deepEqual(urls, ['https://mmbiz.qpic.cn/1.png', 'https://mmbiz.qpic.cn/2.png']);
});
