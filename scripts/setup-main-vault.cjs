// 装到主库：迁移 27 个号 + 复用已有登录态；切回主库 open
const fs = require('fs');
const path = require('path');
const { chromium } = require('/Users/ligerui/node_modules/playwright-core');

const P = '/Volumes/ZenProX/@AIGC2026/@Developer/obsidian-weread-mp';
const VAULT = '/Volumes/NodexPro/@知识库';
const PLUG = path.join(VAULT, '.obsidian/plugins/zisuzi-weread-mp');
const ID = 'zisuzi-weread-mp';
const PROFILE = '/Users/ligerui/.weread-monitor/chrome-profile';

(async () => {
  fs.mkdirSync(PLUG, { recursive: true });
  for (const f of ['main.js', 'manifest.json', 'styles.css']) {
    fs.copyFileSync(path.join(P, f), path.join(PLUG, f));
  }

  // 启用
  const cjPath = path.join(VAULT, '.obsidian/community-plugins.json');
  let cj = [];
  if (fs.existsSync(cjPath)) {
    try { cj = JSON.parse(fs.readFileSync(cjPath, 'utf8')); } catch (e) { cj = []; }
  }
  if (!cj.includes(ID)) cj.push(ID);
  fs.writeFileSync(cjPath, JSON.stringify(cj, null, 2));

  // 迁移账号
  const monCfg = JSON.parse(fs.readFileSync('/Users/ligerui/.weread-monitor/config.json', 'utf8'));
  const accounts = (monCfg.accounts || [])
    .filter((a) => a && a.bookId && String(a.bookId).startsWith('MP_WXS_'))
    .map((a) => ({ name: a.name || a.bookId, bookId: a.bookId }));

  // 取完整 cookie
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, channel: 'chrome' });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://weread.qq.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
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

  const data = {
    settings: {
      cookie,
      accounts,
      outputDir: '微信读书公众号',
      pages: 1,
      intervalMin: 30,
      maxPerRun: 8,
      maxPerAccount: 2,
      delayListMs: 1200,
      delayContentMs: 2500,
      downloadImages: true,
      autoStart: true,
    },
    state: { processed: {} },
  };
  fs.writeFileSync(path.join(PLUG, 'data.json'), JSON.stringify(data, null, 2));

  console.log('主库插件目录:', PLUG);
  console.log('账号迁移:', accounts.length, '个');
  console.log('cookie 项:', Object.keys(m).join(','), '| 字节:', cookie.length);
  console.log('community-plugins:', JSON.stringify(cj));
})();
