/**
 * 跨 agent 的技能包：把「读这份公众号归档库」的查询能力装成 SKILL.md。
 *
 * 为什么不用各家私有格式：Hermes / WorkBuddy / Claude Code / Codex / Gemini / Cursor
 * 在本机都认 `<X>/skills/<name>/SKILL.md`（YAML frontmatter + markdown 正文），
 * 所以一份内容复制到多个目录就能通用 —— 不需要为每家写适配层。
 *
 * 路径由插件运行时注入（vault 绝对路径、输出目录名），所以装到任何一台机器都对。
 */

export const SKILL_NAME = 'weread-mp-vault';
export const SKILL_VERSION = '1.2.0';

export interface SkillTarget {
  id: string;
  label: string;
  /** 相对 $HOME 的 skills 根目录 */
  dir: string;
}

/** 本机实测存在的 skills 目录（不存在也没关系，安装时会自动创建） */
export const SKILL_TARGETS: SkillTarget[] = [
  { id: 'hermes', label: 'Hermes', dir: '.hermes/skills' },
  { id: 'workbuddy', label: 'WorkBuddy', dir: '.workbuddy/skills' },
  { id: 'claude', label: 'Claude Code', dir: '.claude/skills' },
  { id: 'codex', label: 'Codex CLI', dir: '.codex/skills' },
  { id: 'gemini', label: 'Gemini CLI', dir: '.gemini/skills' },
  { id: 'cursor', label: 'Cursor', dir: '.cursor/skills' },
];

export function renderSkillMd(vaultPath: string, outputDir: string): string {
  const base = `${vaultPath}/${outputDir}`;
  return `---
name: ${SKILL_NAME}
version: "${SKILL_VERSION}"
description: 读取本机 Obsidian 里由 Zisuzi-Weread-MP 插件归档的微信读书公众号文章 —— 统计每个号收了多少篇、找「已发现但没归档」的缺口、按时间窗汇总、全文检索。用户提到「公众号归档库」「我收的公众号文章」「哪个号还差几篇」「本周收了哪些」时使用。只读，绝不修改 Obsidian 库和插件配置。
license: MIT
agent_created: true
---

# 微信读书公众号归档库（Zisuzi-Weread-MP）

用户本机有一份由 Obsidian 插件 **Zisuzi-Weread-MP** 维护的公众号归档。这个 skill 让你直接读它，不需要任何 API、不需要登录微信读书。

## 路径约定

| 用途 | 路径 |
|---|---|
| 库根 | \`${vaultPath}\` |
| 文章 | \`${base}/<公众号名>/<文章标题>.md\` |
| 图片 | \`${base}/assets/<文章标题>/img-1.jpg …\` |
| 插件索引（**只读**） | \`${vaultPath}/.obsidian/plugins/zisuzi-weread-mp/data.json\` |

\`data.json\` 里三个关键字段：

- \`state.discovered[reviewId]\` —— 插件**已经发现**的文章（含还没归档的），带 \`account\` / \`title\` / \`time\`
- \`state.processed[reviewId]\` —— **已归档**的文章，带 \`path\`
- \`settings.accounts\` —— 用户勾选盯采的号；\`settings.shelfAccounts\` —— 书架里的全部号

## 三条铁律

1. **只读。** 不要改 \`data.json\`：插件内存里的旧设置会在重载时覆盖回去，手动改还会让登录态判断错乱。
2. **归档真伪只看文件系统。** \`processed\` 里有记录但文件被删/被挪走，就不算归档。
3. **先按号过滤再扫。** 书架可能有几百个号，别一上来递归全库。

## 两种模式：先快后慢

用户问「统计我的公众号归档」这类问题时，**先跑快速模式**（≈2 秒）。只有他明确要「字数 / 配图数 / 占用空间」时才跑完整模式（≈40–60 秒，会遍历 assets 里几百张图）。

| 模式 | 耗时 | 给什么 |
|---|---|---|
| 快速（任务 A） | ≈2 s | 每号篇数、最近更新、总计 |
| 完整（任务 B） | ≈40–60 s | 再加正文字符数（最短/最长）、配图张数、占用空间、时间跨度 |

## 任务 A：快速统计（默认先跑这个）

不读文件内容、不进 \`assets/\`，只数目录里的 \`.md\` 并取 mtime：

\`\`\`bash
python3 - <<'PY'
import os, time, datetime
root = '${base}'
t0 = time.time()
rows = []
with os.scandir(root) as it:
    for e in it:
        if e.name == 'assets' or not e.is_dir(follow_symlinks=False):
            continue
        n, newest = 0, 0.0
        with os.scandir(e.path) as inner:
            for f in inner:
                if not f.name.endswith('.md'):
                    continue
                st = f.stat(follow_symlinks=False)
                if not (st.st_mode & 0o040000):
                    n += 1
                    newest = max(newest, st.st_mtime)
        rows.append((e.name, n, newest))
rows.sort(key=lambda r: -r[1])
for name, n, newest in rows[:40]:
    d = datetime.datetime.fromtimestamp(newest).strftime('%Y-%m-%d') if newest else ''
    print(f'{n:4d}  {d}  {name}')
print('---')
print('总计', sum(r[1] for r in rows), '篇 /', len(rows), '个号', f'（{time.time()-t0:.1f}s）')
PY
\`\`\`

输出形如 \`48   2026-10-20  孙可可keke\` … \`总计 82 篇 / 20 个号（0.1s）\`。

## 任务 B：完整统计（只在需要字数/配图/占用时跑）

会读每篇正文、统计 \`assets/\` 下图片文件；82 篇 / 876 张图实测约 40–60 秒。

\`\`\`bash
python3 - <<'PY'
import os, time
root = '${base}'
t0 = time.time()
arts = chars = imgs = size = img_sets = 0
cmin, cmax = 10**9, 0
oldest = newest_pub = None
accounts = 0
for acc in os.scandir(root):
    if acc.name == 'assets' or not acc.is_dir(follow_symlinks=False):
        continue
    accounts += 1
    for f in os.scandir(acc.path):
        if not f.name.endswith('.md'):
            continue
        st = f.stat(follow_symlinks=False)
        if st.st_mode & 0o040000:
            continue
        arts += 1
        size += st.st_size
        txt = open(f.path, encoding='utf-8', errors='ignore').read()
        body = txt.split('## 正文', 1)[-1]
        c = len(''.join(body.split()))
        chars += c
        cmin, cmax = min(cmin, c), max(cmax, c)
        pub = ''
        for line in txt.split('\n'):
            if line.startswith('published:'):
                pub = line.split(':', 1)[1].strip()[:10]
                break
        if len(pub) == 10:
            oldest = pub if oldest is None or pub < oldest else oldest
            newest_pub = pub if newest_pub is None or pub > newest_pub else newest_pub
asset_root = os.path.join(root, 'assets')
if os.path.isdir(asset_root):
    for sub in os.scandir(asset_root):
        if not sub.is_dir(follow_symlinks=False):
            continue
        cnt = 0
        for x in os.scandir(sub.path):
            if x.name.lower().endswith(('.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mp3', '.m4a')):
                cnt += 1
                try:
                    size += x.stat(follow_symlinks=False).st_size
                except OSError:
                    pass
        if cnt:
            img_sets += 1
            imgs += cnt
print(f'文章 {arts} 篇 | 号 {accounts} 个')
print(f'正文 {chars/10000:.1f} 万字符（最短 {cmin} / 最长 {cmax}）')
print(f'配图 {imgs} 张（{img_sets} 个图集）')
print(f'占用 {size/1048576:.0f} MB')
print(f'时间跨度 {oldest} → {newest_pub}')
print(f'（{time.time()-t0:.1f}s）')
PY
\`\`\`

> 口径：正文字符数 = \`## 正文\` 之后剥掉空白后的长度；配图 = \`assets/\` 下媒体文件个数；占用含笔记 + 媒体。
> 完整模式读全文，只用于统计；不要为了「看一眼」反复跑。

## 任务二：找缺口（已发现但没归档）

\`\`\`bash
python3 - <<'PY'
import json, os
base = '${vaultPath}'
plug = f'{base}/.obsidian/plugins/zisuzi-weread-mp/data.json'
d = json.load(open(plug))
disc = d['state'].get('discovered', {}) or {}
proc = d['state'].get('processed', {}) or {}
gap = {}
for rid, v in disc.items():
    rec = proc.get(rid)
    path = rec.get('path') if rec else None
    ok = bool(path) and os.path.exists(f'{base}/{path}')
    if not ok:
        gap.setdefault(v.get('account', '?'), []).append(v.get('title', '?'))
for acc, titles in sorted(gap.items(), key=lambda kv: -len(kv[1])):
    print(f'{len(titles):3d} 篇待归档  {acc}')
    for t in titles[:5]:
        print('        ·', t[:40])
PY
\`\`\`

> 缺口只会出现在用户勾选盯采的号上。看到大量缺口先确认：是不是刚切过账号，或被 \`-2041/-2012\` 限过。

## 任务三：时间窗汇总

\`\`\`bash
python3 - <<'PY'
import os, datetime
root = '${base}'
since = datetime.date.today() - datetime.timedelta(days=7)   # 改这里
hits = []
for acc in os.listdir(root):
    p = os.path.join(root, acc)
    if not os.path.isdir(p) or acc == 'assets':
        continue
    for f in os.listdir(p):
        if not f.endswith('.md'):
            continue
        txt = open(os.path.join(p, f), encoding='utf-8', errors='ignore').read(1200)
        pub = ''
        for line in txt.split('\n')[:40]:
            if line.startswith('published:'):
                pub = line.split(':', 1)[1].strip()[:10]
                break
        if len(pub) == 10:
            try:
                if datetime.date.fromisoformat(pub) >= since:
                    hits.append((pub, acc, f[:-3]))
            except ValueError:
                pass
hits.sort(reverse=True)
for d_, acc, t in hits:
    print(d_, '|', acc, '|', t[:50])
print('---', len(hits), '篇')
PY
\`\`\`

## 任务四：全文检索

\`\`\`bash
rg -l --glob '*.md' '关键词' '${base}' | head -30
\`\`\`

## 输出风格

- 结论先行：先给数字（几篇 / 几个号 / 缺口几篇），再列清单。
- 缺口给「号 + 篇数 + 前几篇标题」，并提示「在 Obsidian 里打开插件 → 归档全部历史 → 继续下一批」。
- 引用文件名时用相对库根的路径，方便用户直接点开。
- 不要编造文章内容：需要正文就真去读 \`.md\`。
`;
}

export function renderWorkbuddyMeta(): string {
  return JSON.stringify(
    {
      display_name: '微信读书公众号归档库',
      display_name_en: 'WeRead MP Vault',
      description_zh: '查本机 Obsidian 里的公众号归档：每号篇数、未归档缺口、本周新增、全文检索。只读。',
      description_en:
        'Query the local Obsidian WeRead Official-Account archive: counts, gaps, weekly digest, full-text search. Read-only.',
    },
    null,
    2,
  );
}
