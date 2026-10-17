// 准备 QA 库：装插件 + 从已登录 profile 取完整 cookie + 写插件 data.json
const fs = require('fs');
const path = require('path');
const { chromium } = require('/Users/ligerui/node_modules/playwright-core');

const P = '/Volumes/ZenProX/@AIGC2026/@Developer/obsidian-weread-mp';
const QA = path.join(P, 'qa-vault');
const PLUG = path.join(QA, '.obsidian/plugins/weread-mp-catcher');
const PROFILE = '/Users/ligerui/.weread-monitor/chrome-profile';
const ID = 'weread-mp-catcher';

(async () => {
  // 1) 目录 + 产物
  fs.mkdirSync(PLUG, { recursive: true });
  for (const f of ['main.js', 'manifest.json', 'styles.css']) {
    fs.copyFileSync(path.join(P, f), path.join(PLUG, f));
  }

  // 2) 启用插件
  const cjPath = path.join(QA, '.obsidian/community-plugins.json');
  let cj = [];
  if (fs.existsSync(cjPath)) {
    try { cj = JSON.parse(fs.readFileSync(cjPath, 'utf8')); } catch (e) { cj = []; }
  }
  if (!cj.includes(ID)) cj.push(ID);
  fs.writeFileSync(cjPath, JSON.stringify(cj, null, 2));

  // 3) 取完整 cookie（含 wr_gid，必须等页面写入）
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

  // 4) 插件 data.json（模拟用户在设置页填好）
  const data = {
    settings: {
      cookie,
      accounts: [
        { name: '阮一峰的网络日志', bookId: 'MP_WXS_3286016687' },
        { name: '机器之心', bookId: 'MP_WXS_3073282833' },
      ],
      outputDir: '公众号盯采',
      pages: 1,
      intervalMin: 30,
      maxPerRun: 2,
      maxPerAccount: 1,
      delayListMs: 1200,
      delayContentMs: 2500,
      downloadImages: true,
      autoStart: false,
    },
    state: { processed: {} },
  };
  fs.writeFileSync(path.join(PLUG, 'data.json'), JSON.stringify(data, null, 2));

  console.log('插件已装入 QA 库:', PLUG);
  console.log('community-plugins:', JSON.stringify(cj));
  console.log('cookie 项:', Object.keys(m).join(','), '| 字节:', cookie.length);
  console.log('data.json 已写（2 个号，单轮上限 2 篇）');
})();
