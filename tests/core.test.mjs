import { test } from 'node:test';
import assert from 'node:assert/strict';

const md = await import('../dist/html2md.mjs');
const wr = await import('../dist/weread.mjs');

/* ---------------------------- html2md ---------------------------- */

test('extractById 按 div 深度平衡取出 js_content', () => {
  const html = `<html><body><div id="js_content"><p>hello</p><div><p>nested</p></div></div><div>tail</div></body></html>`;
  const inner = md.extractById(html);
  assert.ok(inner.includes('hello'));
  assert.ok(inner.includes('nested'));
  assert.ok(!inner.includes('tail'));
});

test('htmlToMarkdown 保留标题/段落/加粗/实体', () => {
  const html = `<div id="js_content"><h2>标题</h2><p>第一段 &amp; 第二句 <strong>重点</strong></p><p>第二段&nbsp;结束</p></div>`;
  const { markdown } = md.htmlToMarkdown(html);
  assert.ok(markdown.includes('## 标题'));
  assert.ok(markdown.includes('第一段 & 第二句 **重点**'));
  assert.ok(markdown.includes('第二段 结束'));
});

test('htmlToMarkdown 提取 data-src 图片并生成占位', () => {
  const html = `<div id="js_content"><p>文中</p><img data-src="https://mmbiz.qpic.cn/a.jpg" src="data:image/gif;base64,x" alt="图一"/></div>`;
  const { markdown, images } = md.htmlToMarkdown(html);
  assert.equal(images.length, 1);
  assert.equal(images[0].src, 'https://mmbiz.qpic.cn/a.jpg');
  assert.ok(markdown.includes('@@IMG0@@'));
});

test('replaceImagePlaceholders 填本地路径，缺路径则丢弃', () => {
  const out = md.replaceImagePlaceholders('a @@IMG0@@ b @@IMG1@@ c', ['../assets/x/img-1.png']);
  // v1.0.1 起图片路径用尖括号包裹（中文/空格文件名不再需要 %20 转义）
  assert.ok(out.includes('![](<../assets/x/img-1.png>)'));
  assert.ok(!out.includes('@@IMG1@@'));
});

test('无 js_content（纯视频推送）返回空 markdown', () => {
  const { markdown } = md.htmlToMarkdown('<html><body><div class="video">only video</div></body></html>');
  assert.equal(markdown, '');
});

test('safeFileName 去掉非法字符并限长', () => {
  const n = md.safeFileName('科技周刊#415：3D 版《看不见的城市》/ 上', 30);
  assert.ok(!/[\\/:*?"<>|#]/.test(n));
  assert.ok(n.length <= 30);
});

/* ---------------------------- weread ---------------------------- */

test('checkCookie 缺 wr_gid 时判定不完整', () => {
  const bad = 'wr_vid=1; wr_skey=2; wr_rt=3';
  const r = wr.checkCookie(bad);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['wr_gid']);
  const good = wr.checkCookie('wr_vid=1; wr_skey=2; wr_rt=3; wr_gid=4');
  assert.equal(good.ok, true);
});

test('normalizeCookie 去前缀与多余空白', () => {
  assert.equal(wr.normalizeCookie('Cookie: a=1;  b=2 ;'), 'a=1; b=2');
});

test('parseArticleList 解析真实结构（subReviews → review.mpInfo）', () => {
  const json = {
    reviews: [
      {
        subReviews: [
          {
            review: {
              reviewId: 'MP_WXS_1_WRabc',
              createTime: 1700000000,
              mpInfo: { title: '标题A', time: 1700000100, readNum: 123, likeNum: 4, mp_name: '机器之心' },
            },
          },
          { review: { reviewId: 'MP_WXS_1_WRdef', mpInfo: { title: '标题B', time: 1700000200 } } },
        ],
      },
    ],
  };
  const items = wr.parseArticleList(json);
  assert.equal(items.length, 2);
  assert.equal(items[0].reviewId, 'MP_WXS_1_WRabc');
  assert.equal(items[0].title, '标题A');
  assert.equal(items[0].readNum, 123);
  assert.equal(items[0].mpName, '机器之心');
});

test('列表返回 -2012 抛 RiskError（供熔断使用）', async () => {
  const http = async () => ({
    status: 200,
    text: JSON.stringify({ errcode: -2012, errmsg: '登录态异常' }),
    bytes: new ArrayBuffer(0),
  });
  const c = new wr.WereadClient(http, 'wr_vid=1; wr_skey=2; wr_rt=3; wr_gid=4');
  await assert.rejects(() => c.listArticles('MP_WXS_1', 0), (e) => e instanceof wr.RiskError && e.code === -2012);
});

test('列表 200 正常解析且带正确 Referer', async () => {
  let seenHeaders = {};
  const http = async (_url, headers) => {
    seenHeaders = headers;
    return {
      status: 200,
      text: JSON.stringify({ reviews: [{ subReviews: [{ review: { reviewId: 'R1', mpInfo: { title: 'T', time: 1 } } }] }] }),
      bytes: new ArrayBuffer(0),
    };
  };
  const c = new wr.WereadClient(http, 'wr_vid=1');
  const items = await c.listArticles('MP_WXS_1', 0);
  assert.equal(items.length, 1);
  assert.equal(seenHeaders.Referer, 'https://weread.qq.com/');
  assert.ok(String(seenHeaders.Cookie).includes('wr_vid=1'));
});
