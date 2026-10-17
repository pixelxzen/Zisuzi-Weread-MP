// 回填去重状态：扫描已归档笔记的 frontmatter，重建 state.processed
// 场景：切账号/重置把 processed 清空了，但笔记还躺在库里 → 下一轮会把老文章当新文重下
// 用法：
//   node scripts/backfill-state.cjs                # 默认主库
//   node scripts/backfill-state.cjs /path/to/data.json /path/to/vault
const fs = require('fs');
const path = require('path');

const DATA = process.argv[2] || '/Volumes/NodexPro/@知识库/.obsidian/plugins/weread-mp-catcher/data.json';
const VAULT = process.argv[3] || '/Volumes/NodexPro/@知识库';

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.md')) out.push({ p, mtime: st.mtimeMs });
  }
  return out;
}

function pick(fm, key) {
  const m = fm.match(new RegExp('^' + key + ':\\s*(?:"([^"]*)"|(.*))$', 'm'));
  return m ? (m[1] !== undefined ? m[1] : (m[2] || '').trim()) : '';
}

(function main() {
  // 红线：先读进变量并确认非空，再写回（避免 'w' 截断导致 0 字节）
  const rawBefore = fs.readFileSync(DATA, 'utf8');
  if (!rawBefore || rawBefore.length < 20) {
    console.error('FAIL: data.json 读取为空，中止');
    process.exit(2);
  }
  const d = JSON.parse(rawBefore);
  const outDir = (d.settings && d.settings.outputDir) || '微信读书公众号';
  const root = path.join(VAULT, outDir);
  if (!fs.existsSync(root)) {
    console.error('FAIL: 归档目录不存在:', root);
    process.exit(3);
  }

  d.state = d.state || {};
  d.state.processed = d.state.processed || {};
  d.state.discovered = d.state.discovered || {};
  const before = Object.keys(d.state.processed).length;

  const files = walk(root);
  let added = 0;
  let skipped = 0;
  for (const f of files) {
    const txt = fs.readFileSync(f.p, 'utf8');
    const fmEnd = txt.indexOf('\n---', 4);
    const fm = fmEnd > 0 ? txt.slice(0, fmEnd) : '';
    const src = pick(fm, 'source');
    const rid = src.replace(/^weread:\/\//, '').trim();
    if (!rid || !/^MP_WXS_/.test(rid)) {
      skipped++;
      continue;
    }
    if (d.state.processed[rid]) continue;
    const published = pick(fm, 'published');
    const ts = published ? Date.parse(published + 'T00:00:00+08:00') : 0;
    const rel = path.relative(VAULT, f.p);
    d.state.processed[rid] = {
      account: pick(fm, 'author') || path.basename(path.dirname(f.p)),
      title: pick(fm, 'title'),
      time: Number.isFinite(ts) ? ts : 0,
      path: rel,
      at: Math.round(f.mtime),
    };
    if (!d.state.discovered[rid]) {
      const readNum = pick(fm, 'readNum');
      const likeNum = pick(fm, 'likeNum');
      d.state.discovered[rid] = {
        account: pick(fm, 'author') || path.basename(path.dirname(f.p)),
        title: pick(fm, 'title'),
        time: Number.isFinite(ts) ? ts : 0,
        ...(readNum ? { readNum: Number(readNum) } : {}),
        ...(likeNum ? { likeNum: Number(likeNum) } : {}),
      };
    }
    added++;
  }

  const after = Object.keys(d.state.processed).length;
  const out = JSON.stringify(d, null, 2);
  if (!out || out.length < 20) {
    console.error('FAIL: 序列化结果为空，中止');
    process.exit(4);
  }
  const bak = `${DATA}.bak.${Date.now()}`;
  fs.writeFileSync(bak, rawBefore, 'utf8');
  fs.writeFileSync(DATA, out, 'utf8');

  const check = fs.statSync(DATA).size;
  console.log('data.json:', DATA);
  console.log('归档目录:', root, '| 笔记文件:', files.length, '| 无法识别:', skipped);
  console.log(`processed: ${before} → ${after}（新增 ${added}）`);
  console.log('discovered:', Object.keys(d.state.discovered).length, '| 备份:', bak);
  console.log('写回字节数:', check);
  if (check < 1000) {
    console.error('FAIL: 写回后文件过小，疑似写坏，请用备份恢复');
    process.exit(5);
  }
})();
