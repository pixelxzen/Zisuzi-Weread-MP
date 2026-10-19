import { test } from 'node:test';
import assert from 'node:assert/strict';

const qr = await import('../dist/qrlogin.mjs');

/* ---------------------------- 二维码 ---------------------------- */

test('buildConfirmUrl 与官方网页端一致（带 pf 平台位）', () => {
  // 官方 app.js 里的拼法：.../web/confirm?pf=<iOS?1:2>&uid=<uid>
  assert.equal(
    qr.buildConfirmUrl('4aa50110-c892-4666'),
    'https://weread.qq.com/web/confirm?pf=2&uid=4aa50110-c892-4666',
  );
  assert.equal(
    qr.buildConfirmUrl('4aa50110-c892-4666', '1'),
    'https://weread.qq.com/web/confirm?pf=1&uid=4aa50110-c892-4666',
  );
});

test('renderQrDataUrl 本地生成二维码图片', () => {
  const url = qr.renderQrDataUrl('https://weread.qq.com/web/confirm?uid=abc');
  assert.ok(url.startsWith('data:image/gif;base64,'), url.slice(0, 40));
  assert.ok(url.length > 500);
});

/* ---------------------------- 长轮询解析 ---------------------------- */

test('parseLoginInfo：logicCode 0 表示等待扫码', () => {
  const r = qr.parseLoginInfo(JSON.stringify({ succeed: false, logicCode: 0 }));
  assert.equal(r.status, 'waiting');
});

test('parseLoginInfo：logicCode 1 表示已扫码待确认', () => {
  const r = qr.parseLoginInfo(JSON.stringify({ succeed: false, logicCode: 1 }));
  assert.equal(r.status, 'scanned');
});

test('parseLoginInfo：succeed=true 时解析出 cookie', () => {
  const r = qr.parseLoginInfo(
    JSON.stringify({ succeed: true, vid: '123456', accessToken: 'abcdefgh', refreshToken: 'web@refresh' }),
  );
  assert.equal(r.status, 'confirmed');
  assert.equal(r.cookie, 'wr_vid=123456; wr_skey=abcdefgh; wr_rt=web%40refresh');
});

test('parseLoginInfo：LOGIN_TIMEOUT 算「本轮没动静」而不是过期（同一 uid 可续查）', () => {
  // 实测：服务端 hold 约 55 秒后返回 {succeed:false, logicCode:"LOGIN_TIMEOUT", canRetry:false}，
  // 同一 uid 连续两轮都正常 hold，说明 uid 不是一次性的，不能据此判定二维码失效。
  assert.equal(qr.parseLoginInfo(JSON.stringify({ succeed: false, logicCode: 'LOGIN_TIMEOUT' })).status, 'waiting');
  assert.equal(
    qr.parseLoginInfo(JSON.stringify({ succeed: false, logicCode: 'LOGIN_TIMEOUT', canRetry: false })).status,
    'waiting',
  );
  assert.equal(qr.parseLoginInfo(JSON.stringify({ succeed: false, logicCode: 'LOGIN_EXPIRED' })).status, 'expired');
  assert.equal(qr.parseLoginInfo(JSON.stringify({ succeed: false, logicCode: 'NEED_OTP' })).status, 'need-otp');
});

test('parseLoginInfo：空响应按等待处理，非法 JSON 按未知处理', () => {
  assert.equal(qr.parseLoginInfo('').status, 'waiting');
  assert.equal(qr.parseLoginInfo('<html>').status, 'unknown');
});

/* ---------------------------- cookie 组装 ---------------------------- */

test('cookieFromSetCookie 只保留 name=value 并去重', () => {
  const cookie = qr.cookieFromSetCookie([
    'wr_vid=123; Path=/; Domain=.weread.qq.com; HttpOnly',
    'wr_skey=abcdef123456; Path=/; Domain=.weread.qq.com',
    'wr_rt=web%40abc; Path=/',
    'wr_gid=999; Path=/',
    'wr_vid=456; Path=/',
  ]);
  assert.equal(cookie, 'wr_vid=456; wr_skey=abcdef123456; wr_rt=web%40abc; wr_gid=999');
});

test('cookieFromLoginBody 兼容顶层 / data 子层 / webLoginVid', () => {
  assert.equal(
    qr.cookieFromLoginBody(JSON.stringify({ succeed: true, vid: 111, accessToken: 'AT', refreshToken: 'RT' })),
    'wr_vid=111; wr_skey=AT; wr_rt=RT',
  );
  assert.equal(
    qr.cookieFromLoginBody(JSON.stringify({ succeed: true, data: { webLoginVid: '222', accessToken: 'A2' } })),
    'wr_vid=222; wr_skey=A2',
  );
});

test('cookieFromLoginBody 缺 vid 时返回空串', () => {
  assert.equal(qr.cookieFromLoginBody(JSON.stringify({ succeed: true, accessToken: 'A' })), '');
  assert.equal(qr.cookieFromLoginBody('not json'), '');
});

test('mergeCookieStrings 后面的值覆盖前面的', () => {
  const merged = qr.mergeCookieStrings('wr_vid=1; wr_gid=', 'wr_gid=9; wr_skey=s');
  const jar = Object.fromEntries(merged.split('; ').map((p) => p.split('=')));
  assert.deepEqual(jar, { wr_vid: '1', wr_gid: '9', wr_skey: 's' });
});

test('parseSsrRequestId 从 Nuxt payload 里取校验头', () => {
  const html = '...{"$sinnerData":6013},{"requestId":6014},"6K-oriFYlKKtBEabmRDQW",{"hasLogin":70}...';
  assert.equal(qr.parseSsrRequestId(html), '6K-oriFYlKKtBEabmRDQW');
  assert.equal(qr.parseSsrRequestId('<html>no payload</html>'), null);
});

test('arrayBufferToBase64 能编码二维码图片字节', () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(qr.arrayBufferToBase64(bytes.buffer), Buffer.from(bytes).toString('base64'));
});
