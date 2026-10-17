// 重新抓取完整 cookie（6 项）并写回两个 vault 的插件 data.json（保留 llm 配置）
const fs = require('fs');
const { chromium } = require('/Users/ligerui/node_modules/playwright-core');

const PROFILE = '/Users/ligerui/.weread-monitor/chrome-profile';
const TARGETS = [
  '/Volumes/ZenProX/@AIGC2026/@Developer/obsidian-weread-mp/qa-vault/.obsidian/plugins/weread-mp-catcher/data.json',
  '/Volumes/NodexPro/@知识库/.obsidian/plugins/weread-mp-catcher/data.json',
];
const NEED = ['wr_vid', 'wr_skey', 'wr_rt', 'wr_gid'];

(async () => {
  let ctx = null;
  for (let i = 1; i <= 4; i++) {
    try {
      ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, channel: 'chrome' });
      break;
    } catch (e) {
      console.log(`尝试 ${i} 失败（profile 可能被占用）：${String(e.message).slice(0, 70)}`);
      await new Promise((r) => setTimeout(r, 9000));
    }
  }
  if (!ctx) {
    console.error('FAIL: 无法启动 Chrome profile');
    process.exit(9);
  }

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://weread.qq.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const jar = await ctx.cookies('https://weread.qq.com');
  const doc = await page.evaluate(() => document.cookie);
  await ctx.close();

  const m = {};
  for (const c of jar) m[c.name] = c.value;
  for (const kv of doc.split('; ').filter(Boolean)) {
    const i = kv.indexOf('=');
    if (i > 0) m[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const cookie = Object.entries(m).map(([k, v]) => `${k}=${v}`).join('; ');
  const have = new Set(Object.keys(m));
  const missing = NEED.filter((n) => !have.has(n));
  console.log('取到 cookie:', cookie.length, '字节 | 项:', Object.keys(m).join(','));
  if (missing.length) {
    console.error('FAIL: 缺少', missing.join(','), '→ 请重跑 node weread_mp_monitor.js --login');
    process.exit(8);
  }

  for (const p of TARGETS) {
    if (!fs.existsSync(p)) continue;
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    d.settings = d.settings || {};
    d.settings.cookie = cookie;
    fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf8');
    console.log('已写入:', p.split('/.obsidian')[0]);
  }
})();
