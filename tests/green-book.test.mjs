import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const gb = await import('../dist/green-book.mjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = fs.readFileSync(path.join(here, 'fixtures/green-book-mp.html'), 'utf8');

/* ------------------------------ extractJsArray ------------------------------ */

test('extractJsArray：按括号平衡取整个数组，不被字符串里的 ] 截断', () => {
  const html = `x = { picture_page_info_list: [ { cdn_url: 'u1', a: ']' }, { cdn_url: 'u2', b: '[' } ] , other: 1 }`;
  const arr = gb.extractJsArray(html, 'picture_page_info_list');
  assert.ok(arr.startsWith('[') && arr.endsWith(']'));
  assert.ok(arr.includes("a: ']'"), '字符串里的 ] 不能提前收尾');
  assert.ok(arr.includes('u2'), '第二个元素也要在');
});

test('extractJsArray：跳过「取数据对象」的切片赋值，只认真数据数组', () => {
  // 真实页面里 window.picture_page_info_list = ((window.cgiDataNew && …) || []).slice(0, 20);
  // 这种赋值没有 cdn_url，不能被当成数据；后面才是真正的 cgiData 数组。
  const html = `window.picture_page_info_list = ((window.cgiDataNew && window.cgiDataNew.picture_page_info_list) || []).slice(0, 20);
    cgi = { picture_page_info_list: [ { cdn_url: 'https://mmbiz.qpic.cn/ok/0' } ] };`;
  const arr = gb.extractJsArray(html, 'picture_page_info_list');
  assert.ok(arr.includes('/ok/'), `抓到了错误数组: ${arr.slice(0, 80)}`);
});

test('extractJsArray：缺 key 返回空串', () => {
  assert.equal(gb.extractJsArray('<html></html>', 'picture_page_info_list'), '');
});

/* ------------------------------- parsePicturePages ------------------------------- */

test('parsePicturePages：真实 fixture 解析出 4 条（去重后）', () => {
  const pages = gb.parsePicturePages(FIX);
  assert.equal(pages.length, 4, `实际 ${pages.length}`);
  assert.equal(pages[0].url.includes('mmbiz_png/AAA'), true);
  assert.equal(pages[0].width, 840);
  assert.equal(pages[0].height, 1206);
  assert.equal(pages[0].kind, 'bitmap');
  assert.equal(pages[1].kind, 'svg');
  assert.equal(pages[2].kind, 'bitmap');
  assert.equal(pages[3].isQr, true, '第 4 条是二维码');
});

test('parsePicturePages：不吃嵌套 share_cover / watermark_info 的 cdn_url', () => {
  const pages = gb.parsePicturePages(FIX);
  const all = pages.map((p) => p.url).join(' ');
  assert.ok(!all.includes('/SHARE/'), 'share_cover 的图不能当正文');
  assert.ok(!all.includes('/WM/'), 'watermark 的图不能当正文');
});

test('parsePicturePages：重复 URL 去重', () => {
  const pages = gb.parsePicturePages(FIX);
  const urls = pages.map((p) => p.url);
  assert.equal(new Set(urls).size, urls.length);
});

test('parsePicturePages：&amp; / \\x26amp; 实体还原', () => {
  const pages = gb.parsePicturePages(FIX);
  assert.ok(pages[0].url.includes('&from=appmsg'), pages[0].url);
  assert.ok(!pages[0].url.includes('amp;amp'), '不能出现双重转义');
});

/* --------------------------------- 判定 -------------------------------- */

test('detectGreenBook：无 js_content + 有图列表 → true', () => {
  const r = gb.detectGreenBook(FIX);
  assert.equal(r.green, true);
  assert.equal(r.pages.length, 4);
});

test('detectGreenBook：有 js_content 的普通图文 → false', () => {
  const html = `<div id="js_content"><p>正文</p></div>
    <script>window.picture_page_info_list = [{ cdn_url: 'https://mmbiz.qpic.cn/mmbiz_png/X/0' }];</script>`;
  const r = gb.detectGreenBook(html);
  assert.equal(r.green, false, '普通图文不能被判成小绿书（否则会把正文丢掉）');
});

test('detectGreenBook：空壳（无列表无正文）→ false', () => {
  const r = gb.detectGreenBook('<html><body><p>赞 在看 留言</p></body></html>');
  assert.equal(r.green, false);
});

/* --------------------------------- meta -------------------------------- */

test('greenBookMeta：标题/作者/摘要/时间', () => {
  const m = gb.greenBookMeta(FIX);
  assert.equal(m.title, '1024｜程序员的第十次幂');
  assert.equal(m.author, '紫苏子ACG');
  assert.equal(m.digest, 'AI时代，大家都可以开心地做开发。');
  assert.equal(m.publishTs, 1792655565);
});

test('greenBookMeta：缺字段不抛错', () => {
  const m = gb.greenBookMeta('<html></html>');
  assert.equal(m.title, undefined);
  assert.equal(m.publishTs, 0);
});

/* --------------------------------- 落盘策略 -------------------------------- */

test('pageExt：svg 内页必须按 .svg 存', () => {
  const pages = gb.parsePicturePages(FIX);
  assert.equal(gb.pageExt(pages[1]), 'svg', 'mmbiz_svg 当 jpg 存会得到坏图');
  assert.equal(gb.pageExt(pages[0]), 'png');
  assert.equal(gb.pageExt(pages[2]), 'jpg');
});

test('contentPages：排除二维码，保留 svg 与位图', () => {
  const pages = gb.parsePicturePages(FIX);
  const keep = gb.contentPages(pages);
  assert.equal(keep.length, 3);
  assert.ok(!keep.some((p) => p.isQr));
  assert.ok(keep.some((p) => p.kind === 'svg'));
});

test('真实样本量级：8 个 svg 内页不会被当成装饰丢掉', () => {
  const html = `<div class="x"></div><script>window.picture_page_info_list = [
    ${Array.from({ length: 8 }, (_, i) => `{ cdn_url: 'https://mmbiz.qpic.cn/mmbiz_svg/P${i}/0?wx_fmt=svg', is_qr_code: '0' * 1 }`).join(',')}
  ];</script>`;
  const pages = gb.parsePicturePages(html);
  assert.equal(pages.length, 8);
  assert.ok(pages.every((p) => p.kind === 'svg'));
  assert.equal(gb.contentPages(pages).length, 8);
});
