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
export const SKILL_VERSION = '1.1.0';

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

## 任务一：每个号收了多少篇、最近更新

\`\`\`bash
python3 - <<'PY'
import os, datetime
root = '${base}'
rows = []
for d in sorted(os.listdir(root)):
    p = os.path.join(root, d)
    if not os.path.isdir(p) or d == 'assets':
        continue
    fs = [os.path.join(p, f) for f in os.listdir(p) if f.endswith('.md')]
    newest = datetime.datetime.fromtimestamp(max(os.path.getmtime(f) for f in fs)).strftime('%Y-%m-%d') if fs else ''
    rows.append((d, len(fs), newest))
rows.sort(key=lambda r: -r[1])
for name, n, t in rows[:40]:
    print(f'{n:4d}  {t}  {name}')
print('---')
print('总计', sum(r[1] for r in rows), '篇 /', len(rows), '个号')
PY
\`\`\`

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
import os, re, datetime
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
        m = re.search(r'^published:\\s*(\\d{4}-\\d{2}-\\d{2})', txt, re.M)
        if m and datetime.date.fromisoformat(m.group(1)) >= since:
            hits.append((m.group(1), acc, f[:-3]))
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
