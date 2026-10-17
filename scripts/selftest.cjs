// CLI 接口自检：判定 cookie 是"过期"还是"公众号接口被限(-2041)"
// 用法：node scripts/selftest.cjs [path/to/data.json]
// 依赖：先跑 node scripts/build-core.mjs 生成 dist/weread.mjs
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const DEFAULT_DATA = '/Volumes/NodexPro/@知识库/.obsidian/plugins/zisuzi-weread-mp/data.json';

const http = async (url, headers) => {
  const r = await fetch(url, { headers });
  const text = await r.text();
  return { status: r.status, text };
};

(async () => {
  const dataPath = process.argv[2] || DEFAULT_DATA;
  const coreUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'weread.mjs')).href;
  const core = await import(coreUrl);

  if (!fs.existsSync(dataPath)) {
    console.error('FAIL: 找不到 data.json:', dataPath);
    process.exit(2);
  }
  const d = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const cookie = (d.settings && d.settings.cookie) || '';
  console.log('data.json:', dataPath);
  console.log('cookie 长度:', cookie.length);

  const chk = core.checkCookie(cookie);
  console.log('cookie 完整性:', chk.ok ? 'OK（四项齐全）' : `缺 ${chk.missing.join(', ')}`);

  const probe = await core.probeAccess(http, cookie);
  console.log('账号昵称:', probe.account ?? '（读不到 → 会话失效）');
  console.log('列表接口码:', probe.listCode);
  console.log('判定:', probe.verdict);
  console.log('结论:', probe.hint);

  // 退出码：0=可抓 / 3=被限 / 4=过期 / 5=未登录
  const code = { ok: 0, restricted: 3, expired: 4, 'no-cookie': 5 }[probe.verdict] ?? 9;
  process.exit(code);
})();
