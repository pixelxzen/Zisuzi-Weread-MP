#!/usr/bin/env node
/**
 * 微信读书·公众号盯采 / 全量归档 → Obsidian
 *
 *  监控增量（定时任务用）:
 *    node weread_mp_monitor.js --config <cfg> [--dry-run] [--only "号A,号B"]
 *  单号完整历史（分批 + 风控保护）:
 *    node weread_mp_monitor.js --backfill "号名" [--max 30] [--from 2025-01-01] [--pages 200]
 *    node weread_mp_monitor.js --list "号名"            # 只导文章列表（标题/时间/阅读数），不抓正文
 *  登录（一次性）:
 *    node weread_mp_monitor.js --login
 *
 * 数据通路（全部实测）:
 *   /shelf/sync（官方网关）        → 书架公众号（名称 → MP_WXS_*）
 *   /web/mp/articles?offset=N      → 文章列表，每页 20，可翻到底（title/time/readNum/likeNum/封面）
 *   /web/mp/content?reviewId=      → 全文 HTML（#js_content）
 *
 * 风控策略（重要）: 全程保守限速 + 风险码熔断 + 断点续跑；宁可慢，不触发风控。
 * 只读：全部 GET，不写任何远端数据。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadPW() {
  const cands = ['playwright-core', 'playwright',
    path.join(__dirname, 'node_modules', 'playwright-core'),
    path.join(__dirname, 'node_modules', 'playwright'),
    path.join(os.homedir(), '.weread-monitor', 'node_modules', 'playwright-core'),
    path.join(os.homedir(), 'node_modules', 'playwright-core')];
  for (const c of cands) { try { return require(c); } catch (e) { } }
  console.error('[ERR] 找不到 playwright-core。请在本目录执行：npm i playwright-core && npx playwright install chromium');
  process.exit(3);
}
const { chromium } = loadPW();

// ---------- 参数 ----------
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
/** 从任意子目录向上找 Obsidian 库根（含 .obsidian 的那层） */
function findVaultRoot(start) {
    let d = path.resolve(start);
    for (let i = 0; i < 8; i++) {
        if (fs.existsSync(path.join(d, '.obsidian'))) return d;
        const up = path.dirname(d);
        if (up === d) break;
        d = up;
    }
    return '';
}

/**
 * 自动发现 Obsidian 插件的归档目录（不用用户手填 dedupeDirs）。
 * 判据：从 obsidianDir 往上找到库根 → 读插件 data.json 的 settings.outputDir。
 */
function pluginArchiveDir(obsDir) {
    try {
        const vault = findVaultRoot(obsDir);
        if (!vault) return '';
        const dj = path.join(vault, '.obsidian', 'plugins', 'zisuzi-weread-mp', 'data.json');
        if (!fs.existsSync(dj)) return '';
        const d = JSON.parse(fs.readFileSync(dj, 'utf8'));
        const out = d && d.settings && d.settings.outputDir;
        if (!out) return '';
        const p = path.join(vault, out);
        return fs.existsSync(p) ? p : '';
    } catch (e) {
        return '';
    }
}

/** 读插件的盯采状态：判断「两边同时跑会不会把请求量叠爆」 */
function pluginRuntimeInfo(obsDir) {
    try {
        const vault = findVaultRoot(obsDir);
        if (!vault) return null;
        const dj = path.join(vault, '.obsidian', 'plugins', 'zisuzi-weread-mp', 'data.json');
        if (!fs.existsSync(dj)) return null;
        const d = JSON.parse(fs.readFileSync(dj, 'utf8'));
        const s = (d && d.settings) || {};
        const st = (d && d.state) || {};
        return {
            intervalMin: Number(s.intervalMin) || 0,
            autoStart: !!s.autoStart,
            accounts: Array.isArray(s.accounts) ? s.accounts.map((a) => a && a.name).filter(Boolean) : [],
            lastRunAt: Number((st.lastRun || {}).at) || 0,
            outputDir: s.outputDir || '',
            vault,
        };
    } catch (e) {
        return null;
    }
}

// ---------- 落盘闸门状态（必须在 main0() 调用点之前初始化，否则 TDZ）----------
const DEDUPE = { reviewIds: new Set(), slugs: new Set(), dirs: [], scanned: 0 };
const DUP_LABEL = {
    'target-exists': '目标目录已有同名文件',
    'same-review': '同一篇已归档过',
    'same-title': '其它归档目录已有同名笔记',
};
let dupSkipped = 0;

const CONFIG = argOf('--config', path.join(os.homedir(), '.weread-monitor', 'config.json'));
const DRY = args.includes('--dry-run');
const SLOW = args.includes('--slow');
const ONLY = argOf('--only', '').split(',').map(s => s.trim()).filter(Boolean);
const BACKFILL = args.includes('--backfill') ? argOf('--backfill', '') : '';
const LISTONLY = args.includes('--list') ? argOf('--list', '') : '';
const FROM = argOf('--from', '');
const MAX_ITEMS = parseInt(argOf('--max', '0'), 10) || 0;
const MAX_PAGES = parseInt(argOf('--pages', '0'), 10) || 0;
const SEED = args.includes('--seed');
const JSON_OUT = argOf('--json-out', '');

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const STATE = String(cfg.stateFile || '~/.weread-monitor/state.json').replace('~', os.homedir());
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
state.processed = state.processed || {};
state.pending = state.pending || {};          // 已发现但未抓正文的（供续跑）
const saveState = () => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(state, null, 2)); };

// 限速：宁可慢。slow 档更保守
const T = SLOW
  ? { list: 3000, content: 6000, batchEvery: 10, batchRest: 120000 }
  : { list: cfg.delayListMs ?? cfg.delayMs ?? 1200, content: cfg.delayContentMs ?? 2500, batchEvery: cfg.batchRestEvery ?? 15, batchRest: cfg.batchRestMs ?? 60000 };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const RISK_CODES = ['-2010', '-2012', '-2041'];
class RiskStop extends Error { }
const isRiskText = t => !t || RISK_CODES.some(c => t.includes('"errcode":' + c)) || /LOGIN ERR/i.test(t);

// ---------- 登录模式 ----------
if (args.includes('--login')) {
  (async () => {
    const dir = String(cfg.chrome?.profileDir || '~/.weread-monitor/chrome-profile').replace('~', os.homedir());
    fs.mkdirSync(dir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(dir, {
      headless: false, channel: 'chrome',
      args: ['--no-first-run', '--no-default-browser-check', '--window-size=1100,860']
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://weread.qq.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('[login] 请在弹出的 Chrome 窗口里扫码登录微信读书（成功后自动确认并关闭窗口）');
    for (let i = 0; i < 100; i++) {
      await sleep(3000);
      const ok = await page.evaluate(async () => {
        try { const r = await fetch('/web/shelf/sync', { credentials: 'include' }); if (!r.ok) return false; return (await r.text()).length > 500; } catch (e) { return false; }
      }).catch(() => false);
      if (ok) { console.log('[login] 登录成功，profile: ' + dir); await ctx.close(); process.exit(0); }
    }
    console.log('[login] 超时未检测到登录'); process.exit(1);
  })();
} else main0();

function slugify(s) { return String(s).replace(/[\\/:*?"<>|]/g, '／').replace(/\s+/g, ' ').trim().slice(0, 60); }

// ---------- 书架：名称 → bookId ----------
async function shelfMap() {
  const key = process.env.WEREAD_API_KEY;
  if (!key) {
    console.error('[warn] 未设置 WEREAD_API_KEY → 无法用名字解析 bookId；请在 config.accounts 里直接写 MP_WXS_xxxx');
    return {};
  }
  const r = await fetch('https://i.weread.qq.com/api/agent/gateway', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_name: '/shelf/sync', skill_version: '1.0.4' })
  });
  const j = await r.json().catch(() => ({}));
  const map = {};
  for (const b of (j.books || [])) if (String(b.bookId || '').startsWith('MP_WXS_')) map[b.title] = b.bookId;
  return map;
}

// ---------- 浏览器 ----------
async function connect() {
  if (cfg.chrome?.profileDir) {
    const ctx = await chromium.launchPersistentContext(String(cfg.chrome.profileDir).replace('~', os.homedir()), {
      headless: cfg.chrome.headless !== false, channel: 'chrome',
      args: ['--no-first-run', '--no-default-browser-check']
    });
    return { ctx, own: true };
  }
  let ep = cfg.chrome?.wsEndpoint;
  if (!ep) {
    const apr = fs.readFileSync(path.join(os.homedir(), 'Library/Application Support/Google/Chrome/DevToolsActivePort'), 'utf8').trim().split('\n');
    ep = 'ws://127.0.0.1:' + apr[0].trim() + apr[1].trim();
  }
  const b = await chromium.connectOverCDP(ep);
  return { ctx: b.contexts()[0], own: false };
}
async function getPage(ctx) {
  let page = ctx.pages().find(p => (p.url() || '').includes('weread.qq.com'));
  if (!page) {
    page = await ctx.newPage();
    await page.goto('https://weread.qq.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  return page;
}

// ---------- 列表（一页 / 全部） ----------
async function fetchPage(page, bookId, offset) {
  const raw = await page.evaluate(async (u) => {
    try { const r = await fetch(u, { credentials: 'include' }); return { status: r.status, text: await r.text() }; }
    catch (e) { return { status: 0, text: '' }; }
  }, `/web/mp/articles?bookId=${encodeURIComponent(bookId)}&offset=${offset}`);
  if (isRiskText(raw.text)) throw new RiskStop('列表接口返回风控/登录错误');
  let j = null; try { j = JSON.parse(raw.text); } catch (e) { }
  if (!j || !j.reviews) return [];
  const flat = [];
  for (const rv of j.reviews) for (const s of (rv.subReviews || [])) {
    const d = s.review || {}, mi = d.mpInfo || {};
    flat.push({
      reviewId: d.reviewId, title: mi.title || '', time: mi.time || d.createTime || rv.createTime,
      readNum: mi.readNum ?? null, likeNum: mi.likeNum ?? null, cover: mi.pic_url || '', mpName: mi.mp_name || ''
    });
  }
  return flat;
}

async function listAll(page, bookId, { maxPages = 0, from = '', onPage } = {}) {
  const out = [];
  for (let off = 0, p = 0; ; off += 20, p++) {
    if (maxPages && p >= maxPages) break;
    const batch = await fetchPage(page, bookId, off);
    if (!batch.length) break;
    out.push(...batch);
    if (onPage) onPage(off, batch.length, out.length);
    if (batch.length < 20) break;
    if (from) {
      const oldest = Math.min(...batch.map(b => b.time || Infinity).filter(Boolean));
      if (oldest && new Date(oldest * 1000).toISOString().slice(0, 10) < from) break;
    }
    await sleep(T.list);
  }
  return out;
}

// ---------- 正文 ----------
async function fetchContent(page, reviewId) {
  const raw = await page.evaluate(async (rid) => {
    try { const r = await fetch('/web/mp/content?reviewId=' + encodeURIComponent(rid), { credentials: 'include' }); return { status: r.status, text: await r.text() }; }
    catch (e) { return { status: 0, text: '' }; }
  }, reviewId);
  if (!raw.text || raw.status === 0) return { error: 'HTTP ' + raw.status };
  if (isRiskText(raw.text.slice(0, 600))) throw new RiskStop('正文接口返回风控/登录错误');
  const parsed = await page.evaluate((h) => {
    const doc = new DOMParser().parseFromString(h, 'text/html');
    const root = doc.querySelector('#js_content');
    if (!root) return null;
    const imgs = [];
    function conv(node) {
      let out = '';
      for (const n of node.childNodes) {
        if (n.nodeType === 3) { out += n.textContent.replace(/\s+/g, ' '); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName.toLowerCase();
        if (tag === 'img') { const src = n.getAttribute('data-src') || n.getAttribute('src') || ''; if (src && !src.startsWith('data:')) { imgs.push(src); out += '\n\n![img](' + src + ')\n\n'; } continue; }
        if (tag === 'br') { out += '\n'; continue; }
        if (tag === 'a') { const t = conv(n).trim(); const href = n.getAttribute('href') || ''; out += href ? '[' + t + '](' + href + ')' : t; continue; }
        if (tag === 'strong' || tag === 'b') { out += '**' + conv(n).trim() + '**'; continue; }
        if (tag === 'em' || tag === 'i') { out += '*' + conv(n).trim() + '*'; continue; }
        const inner = conv(n);
        if (['p', 'section', 'div', 'blockquote', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
          const isH = /^h[1-6]$/.test(tag);
          out += '\n\n' + (isH ? '#'.repeat(Number(tag[1])) + ' ' : '') + inner.trim() + '\n';
        } else out += inner;
      }
      return out;
    }
    return {
      markdown: conv(root).replace(/\n{3,}/g, '\n\n').trim(),
      images: [...new Set(imgs)],
      meta: {
        title: ((doc.querySelector('.rich_media_title') || {}).textContent || doc.title || '').trim(),
        nickname: ((doc.querySelector('#js_name') || {}).textContent || '').trim()
      }
    };
  }, raw.text).catch(() => null);
  if (!parsed) return { error: 'no js_content' };
  return parsed;
}

// ---------- 落盘 ----------
const EXT = [[Buffer.from([0xff, 0xd8, 0xff]), 'jpg'], [Buffer.from([0x89, 0x50]), 'png'], [Buffer.from('GIF8'), 'gif']];
function sniffExt(b) { for (const [k, v] of EXT) if (b.subarray(0, k.length).equals(k)) return v; return (b.subarray(8, 12).toString() === 'WEBP') ? 'webp' : 'jpg'; }

async function downloadImages(urls, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const map = {}; let ok = 0;
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    for (const ref of ['https://mp.weixin.qq.com/', null]) {
      try {
        const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36', ...(ref ? { Referer: ref } : {}) } });
        if (!r.ok) continue;
        const b = Buffer.from(await r.arrayBuffer());
        if (b.length < 200) continue;
        const fn = `img_${String(i + 1).padStart(2, '0')}.${sniffExt(b)}`;
        fs.writeFileSync(path.join(dir, fn), b);
        map[u] = fn; ok++;
        break;
      } catch (e) { }
    }
  }
  return { map, ok, fail: urls.length - ok };
}

function slugKey(name) {
    return String(name).replace(/\.md$/i, '').replace(/\s+/g, '').toLowerCase();
}

function dedupeDirsOf(obsDir) {
    const dirs = [obsDir];
    // 自动并入 Obsidian 插件的归档目录（两个目录不同时，这是唯一能发现重复的办法）
    const auto = pluginArchiveDir(obsDir);
    if (auto) dirs.push(auto);
    for (const d of (CONFIG.dedupeDirs || [])) {
        if (d) dirs.push(String(d).replace(/^~(?=$|\/)/, os.homedir()));
    }
    return [...new Set(dirs)].filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
}

function buildDedupeIndex(obsDir) {
    DEDUPE.dirs = dedupeDirsOf(obsDir);
    DEDUPE.reviewIds.clear();
    DEDUPE.slugs.clear();
    DEDUPE.scanned = 0;
    for (const root of DEDUPE.dirs) {
        for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
            if (!ent.isDirectory() || ent.name === 'assets') continue;
            const sub = path.join(root, ent.name);
            for (const fn of fs.readdirSync(sub)) {
                if (!fn.toLowerCase().endsWith('.md')) continue;
                DEDUPE.slugs.add(slugKey(fn));
                DEDUPE.scanned++;
                try {
                    const head = fs.readFileSync(path.join(sub, fn), 'utf8').slice(0, 800);
                    const m = head.match(/^source:\s*"?weread:\/\/([A-Za-z0-9_-]+)/m);
                    if (m) DEDUPE.reviewIds.add(m[1]);
                } catch (e) { /* 读不到就只按文件名判 */ }
            }
        }
    }
    const pinfo = pluginRuntimeInfo(obsDir);
    if (pinfo) {
        const perDay = pinfo.intervalMin > 0 ? Math.round((1440 / pinfo.intervalMin) * Math.max(1, pinfo.accounts.length)) : 0;
        console.log(`  [plugin] 插件通道：${pinfo.accounts.length} 个号 · 每 ${pinfo.intervalMin || '?'} 分钟 ≈ ${perDay} 次列表/天 · autoStart=${pinfo.autoStart} · 最近一轮 ${pinfo.lastRunAt ? new Date(pinfo.lastRunAt).toLocaleString() : '无'}`);
        if (perDay > 20) console.log(`  [warn] 插件单通道已超过 20 次/天的安全线，本脚本再叠加会更容易撞 -2041`);
    }
    console.log(`  [dedupe] 索引 ${DEDUPE.scanned} 篇已有笔记 · ${DEDUPE.reviewIds.size} 个 reviewId · 目录 ${DEDUPE.dirs.join(' · ') || '(无)'}`);
}

function dupReason(item, obsDir) {
    const slug = slugify(item.title || item.reviewId);
    if (fs.existsSync(path.join(obsDir, slug + '.md'))) return 'target-exists';
    if (item.reviewId && DEDUPE.reviewIds.has(item.reviewId)) return 'same-review';
    if (DEDUPE.slugs.has(slugKey(slug + '.md'))) return 'same-title';
    return '';
}

function rememberNote(item, slug) {
    if (item.reviewId) DEDUPE.reviewIds.add(item.reviewId);
    DEDUPE.slugs.add(slugKey(slug + '.md'));
}

function writeNote(item, content, assetMap, obsDir) {
  const today = new Date().toISOString().slice(0, 10);
  const slug = slugify(item.title || item.reviewId);
  let md = content.markdown;
  for (const [u, fn] of Object.entries(assetMap)) md = md.split(u).join(`assets/${slug}/${fn}`);
  const fm = [
    '---',
    `title: "${String(item.title || '').replace(/"/g, '“')}"`,
    `date: ${today}`,
    `source: "weread://${item.reviewId}"`,
    `author: "${item.mpName || ''}"`,
    `author_org: "${item.mpName || ''}（微信读书）"`,
    'tags:', '  - 剪藏', '  - 微信读书公众号',
    `readNum: ${item.readNum ?? ''}`,
    `likeNum: ${item.likeNum ?? ''}`,
    `published: ${item.time ? new Date(item.time * 1000).toISOString().slice(0, 10) : ''}`,
    `created: ${today}`,
    '---', '',
    `# ${item.title || item.reviewId}`, '',
    `> 来源：微信读书 · ${item.mpName || ''}｜阅读 ${item.readNum ?? '-'} · 赞 ${item.likeNum ?? '-'}｜发布 ${item.time ? new Date(item.time * 1000).toISOString().slice(0, 10) : '-'}`, '',
    '## 正文', '', md, ''
  ].join('\n');
  fs.writeFileSync(path.join(obsDir, slug + '.md'), fm, 'utf8');
  return path.join(obsDir, slug + '.md');
}

// ---------- 抓一篇（正文+图片+笔记） ----------
let written = 0;
async function saveOne(page, item, obsDir) {
  // 闸门：同名 / 同源先判，命中就不发正文请求（省额度，也避免双通道重复落盘）
  const dup = dupReason(item, obsDir);
  if (dup) {
    dupSkipped++;
    state.processed[item.reviewId] = {
      account: item.mpName || item.account, title: item.title, time: item.time,
      note: '', at: Date.now(), skipped: dup,
    };
    if (state.pending) delete state.pending[item.reviewId];
    console.log(`  ⤵ 跳过（${DUP_LABEL[dup]}）${String(item.title).slice(0, 30)}`);
    return null;
  }
  const c = await fetchContent(page, item.reviewId);
  if (c.error) { console.error(`  ✗ ${String(item.title).slice(0, 26)}: ${c.error}`); return null; }
  const slug = slugify(item.title || item.reviewId);
  const { map, ok, fail } = await downloadImages(c.images, path.join(obsDir, 'assets', slug));
  const p = writeNote(item, c, map, obsDir);
  rememberNote(item, slug);
  state.processed[item.reviewId] = { account: item.mpName || item.account, title: item.title, time: item.time, note: p, at: Date.now() };
  delete state.pending[item.reviewId];
  written++;
  if (written % T.batchEvery === 0 && T.batchRest > 0) {
    console.log(`  … 已落盘 ${written} 篇，按风控策略长休 ${Math.round(T.batchRest / 1000)}s`);
    await sleep(T.batchRest);
  } else {
    await sleep(T.content);
  }
  return { title: item.title, account: item.mpName || item.account, words: c.markdown.length, imgs: `${ok}/${c.images.length}`, note: p };
}

// ---------- 主流程 ----------
async function main0() {
  const obsDir = String(cfg.obsidianDir).replace('~', os.homedir());
  buildDedupeIndex(obsDir);

  // 方案 A（共享节流窗口）：插件刚跑过 → 本轮直接跳过，两条通道不叠加请求。
  // 原理：插件与本脚本的请求量都算在同一个账号上，叠加才是 -2041 的真因；
  // 笔记去重只解决落盘冗余，解决不了「账号被怼」。
  {
    const guardMin = Number(CONFIG.skipIfPluginRecentMin == null ? 30 : CONFIG.skipIfPluginRecentMin) || 0;
    const pin = guardMin > 0 ? pluginRuntimeInfo(obsDir) : null;
    if (pin && pin.autoStart && pin.lastRunAt && !BACKFILL && !SEED && !LISTONLY) {
      const idleMin = (Date.now() - pin.lastRunAt) / 60000;
      if (idleMin >= 0 && idleMin < guardMin) {
        const reason = `Obsidian 插件 ${Math.round(idleMin)} 分钟前刚跑过（窗口 ${guardMin} 分钟）`;
        console.log(`  ⏸ 跳过本轮：${reason}，两条通道不叠加请求`);
        console.log('     要强制跑：--backfill <号>（手动全量）或 --list（只列不抓）；关掉此闸门：config.skipIfPluginRecentMin = 0');
        const skip = {
            mode: 'skipped-plugin-active', runAt: new Date().toISOString(),
            accounts: 0, newFound: 0, written: 0, dupSkipped: 0, results: [], limited: false,
            stop: 'plugin-active', skippedReason: reason,
        };
        if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(skip, null, 2));
        process.exit(0);
      }
      console.log(`  [guard] 插件上一轮 ${Math.round(idleMin)} 分钟前（窗口 ${guardMin} 分钟）→ 本轮正常跑`);
    }
  }
  fs.mkdirSync(obsDir, { recursive: true });
  const map = await shelfMap();
  const want = BACKFILL || LISTONLY || ONLY.length ? [BACKFILL || LISTONLY || ONLY[0]] : null;
  let names = ONLY.length ? ONLY : (BACKFILL || LISTONLY ? [BACKFILL || LISTONLY] : cfg.accounts);
  if (!names.length) { console.error('config.accounts 为空'); process.exit(2); }
  const resolved = names.map(n => {
    if (n && typeof n === 'object') return { name: n.name || n.bookId, bookId: n.bookId };
    const s = String(n);
    return s.startsWith('MP_WXS_') ? { name: s, bookId: s } : { name: s, bookId: map[s] };
  });
  const targets = resolved.filter(r => r.bookId);
  if (!targets.length) { console.error('[ERR] 没有可用的 bookId（缺 WEREAD_API_KEY 时请在 accounts 直接写 MP_WXS_xxxx）'); process.exit(2); }

  const { ctx, own } = await connect();
  const page = await getPage(ctx);
  const summary = { mode: BACKFILL ? 'backfill' : (LISTONLY ? 'list' : 'monitor'), runAt: new Date().toISOString(), accounts: targets.length, newFound: 0, written: 0, dupSkipped: 0, results: [], limited: false };
  let stop = 'done';
  try {
    if (SEED) {
      // 把各号现有存量标记为「已处理」（不抓正文），之后每轮只落真正的新文章
      const pages = MAX_PAGES || Math.max(1, Math.ceil((cfg.perAccount || 20) / 20));
      let marked = 0;
      console.log(`[seed] 标记现有存量为已处理（不抓正文），每号翻 ${pages} 页`);
      for (const t of targets) {
        const arts = await listAll(page, t.bookId, { maxPages: pages });
        let n = 0;
        for (const a of arts) {
          delete state.pending[a.reviewId];
          if (a.reviewId && !state.processed[a.reviewId]) {
            state.processed[a.reviewId] = { account: t.name, title: a.title, time: a.time, seeded: true, at: Date.now() };
            n++; marked++;
          }
        }
        console.log(`  ${t.name}: 列表 ${arts.length} 条，新标记 ${n} 条`);
        await sleep(T.list);
      }
      state.pending = {};
      summary.seeded = marked;
      summary.mode = 'seed';
      console.log(`[seed] 完成：共标记 ${marked} 条。之后跑监控模式只会落新出现的文章。`);
    } else if (LISTONLY || BACKFILL) {
      // ===== 全量历史：先拉列表，再逐篇抓正文 =====
      const t = targets[0];
      console.log(`[info] ${LISTONLY ? '导出列表' : '全量归档'}：${t.name}（列表间隔 ${T.list}ms，正文间隔 ${T.content}ms，每 ${T.batchEvery} 篇长休 ${Math.round(T.batchRest / 1000)}s）`);
      const arts = await listAll(page, t.bookId, {
        maxPages: MAX_PAGES, from: FROM,
        onPage: (off, n, total) => console.log(`  列表 offset=${off} +${n}（累计 ${total}）`)
      });
      console.log(`[info] 该号共取到 ${arts.length} 篇${FROM ? `（≥${FROM}）` : ''}`);
      if (LISTONLY) {
        const rows = arts.map(a => ({ ...a, account: t.name }));
        const csv = ['published,title,readNum,likeNum,reviewId,account']
          .concat(rows.map(r => [r.time ? new Date(r.time * 1000).toISOString().slice(0, 10) : '', `"${String(r.title).replace(/"/g, '""')}"`, r.readNum ?? '', r.likeNum ?? '', r.reviewId, t.name].join(',')))
          .join('\n');
        const out = path.join(obsDir, `_列表-${slugify(t.name)}.csv`);
        fs.writeFileSync(out, '\uFEFF' + csv, 'utf8');
        console.log(`[done] 列表已导出：${out}（${arts.length} 篇）`);
        summary.results.push({ list: out, count: arts.length });
        if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ ...summary, list: out, count: arts.length }, null, 2));
        if (own && cfg.chrome?.closeWhenOwned) await ctx.close();
        process.exit(0);
      }
      // backfill：按时间倒序（列表即倒序）逐篇抓，跳过已抓
      const todo = arts.filter(a => a.reviewId && !state.processed[a.reviewId]);
      const target = MAX_ITEMS ? todo.slice(0, MAX_ITEMS) : todo;
      summary.newFound = todo.length;
      summary.limited = MAX_ITEMS > 0 && todo.length > MAX_ITEMS;
      console.log(`[info] 待抓 ${todo.length} 篇${MAX_ITEMS ? `，本轮上限 ${MAX_ITEMS} 篇` : ''}（已抓过的自动跳过）`);
      for (const it of target) {
        it.account = t.name;
        const r = await saveOne(page, it, obsDir);
        if (r) { summary.results.push(r); console.log(`  ✓ ${String(it.title).slice(0, 34)} → ${r.words}字 ${r.imgs}图`); }
      }
    } else {
      // ===== 监控增量 =====
      console.log(`[info] 增量监控 ${targets.length} 个号，每号最新 ${cfg.perAccount || 20} 条（列表间隔 ${T.list}ms，正文间隔 ${T.content}ms）`);
      const found = [];
      for (const t of targets) {
        const arts = await listAll(page, t.bookId, { maxPages: Math.ceil((cfg.perAccount || 20) / 20) });
        const fresh = arts.filter(a => a.reviewId && !state.processed[a.reviewId]);
        for (const f of fresh) { f.account = t.name; state.pending[f.reviewId] = { account: t.name, title: f.title, time: f.time }; }
        console.log(`  ${t.name}: 最新 ${arts.length} 条，未处理 ${fresh.length} 条${fresh[0] ? ' ｜ 最新: ' + String(fresh[0].title).slice(0, 30) : ''}`);
        found.push(...fresh);
        await sleep(T.list);
      }
      summary.newFound = found.length;
      if (DRY || !found.length) {
        console.log(JSON.stringify({ dry: DRY, newCount: found.length, sample: found.slice(0, 8).map(f => ({ a: f.account, t: f.title, time: f.time })) }, null, 2));
        saveState();
        if (own && cfg.chrome?.closeWhenOwned) await ctx.close();
        process.exit(0);
      }
      const limit = cfg.maxNewPerRun ?? 6, perAcct = cfg.maxPerAccountPerRun ?? 2;
      const byAcct = new Map();
      for (const f of found) { const a = byAcct.get(f.account) || []; if (a.length < perAcct) a.push(f); byAcct.set(f.account, a); }
      const todo = [];
      for (let round = 0; round < perAcct && todo.length < limit; round++)
        for (const arr of byAcct.values()) if (arr[round] && todo.length < limit) todo.push(arr[round]);
      summary.limited = found.length > todo.length;
      if (summary.limited) console.log(`[warn] 本轮落盘 ${todo.length} 篇（共发现 ${found.length} 篇，其余下轮继续）`);
      for (const it of todo) {
        const r = await saveOne(page, it, obsDir);
        if (r) { summary.results.push(r); console.log(`  ✓ ${r.account} · ${String(it.title).slice(0, 30)} → ${r.words}字 ${r.imgs}图`); }
      }
    }
  } catch (e) {
    if (e instanceof RiskStop) {
      stop = 'risk';
      console.error('\n[RISK] 检测到微信读书风控/登录失效 → 立即停止（不做自动重试，避免加重风控）');
      console.error('[RISK] 处理：等几小时（严重时一天）后重跑；或先 `--login` 重新登录；或加 --slow 降低速度');
    } else { stop = 'error'; console.error('[FAIL]', e.message, '|', String(e.stack || '').split('\n')[1] || ''); }
  }
  summary.written = written;
  summary.stop = stop;
  saveState();
  console.log(`[done] 本轮落盘 ${written} 篇；state: ${STATE}`);
  console.log(JSON.stringify(summary, null, 2));
  summary.dupSkipped = dupSkipped;
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(summary, null, 2));
  if (own && cfg.chrome?.closeWhenOwned) await ctx.close();
  process.exit(stop === 'risk' ? 4 : (stop === 'error' ? 9 : 0));
}
