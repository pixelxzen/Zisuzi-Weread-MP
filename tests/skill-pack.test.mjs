import { test } from 'node:test';
import assert from 'node:assert/strict';

const sp = await import('../dist/skill-pack.mjs');

const VAULT = '/Volumes/NodexPro/@知识库';
const OUT = '微信读书公众号';

test('SKILL.md frontmatter 合法且带版本', () => {
  const md = sp.renderSkillMd(VAULT, OUT);
  assert.match(md, /^---\nname: weread-mp-vault\n/);
  assert.match(md, /version: "1\.2\.0"/);
  assert.match(md, /description: .*只读/);
});

test('路径按 vault + outputDir 注入（不留占位符）', () => {
  const md = sp.renderSkillMd(VAULT, OUT);
  assert.ok(md.includes(`${VAULT}/${OUT}/<公众号名>/<文章标题>.md`));
  assert.ok(md.includes(`${VAULT}/.obsidian/plugins/zisuzi-weread-mp/data.json`));
  assert.equal(md.includes('${'), false);
});

test('四个任务脚本都在，且用注入的真实路径', () => {
  const md = sp.renderSkillMd(VAULT, OUT);
  assert.ok(md.includes('## 任务 A：快速统计'));
  assert.ok(md.includes('## 任务 B：完整统计'));
  assert.ok(md.includes('## 任务二：找缺口'));
  assert.ok(md.includes('## 任务三：时间窗汇总'));
  assert.ok(md.includes('## 任务四：全文检索'));
  // 每段 python 里的 root/base 都应是真实库路径
  const count = md.split(`root = '${VAULT}/${OUT}'`).length - 1;
  assert.ok(count >= 2, `应至少两处注入文章根目录，实际 ${count}`);
});

test('workbuddy.json 是合法 JSON 且带中文展示名', () => {
  const meta = JSON.parse(sp.renderWorkbuddyMeta());
  assert.equal(meta.display_name, '微信读书公众号归档库');
  assert.ok(meta.description_zh);
});

test('六个 agent 目标目录齐全', () => {
  const ids = sp.SKILL_TARGETS.map((t) => t.id);
  for (const id of ['hermes', 'workbuddy', 'claude', 'codex', 'gemini', 'cursor']) {
    assert.ok(ids.includes(id), `缺 ${id}`);
  }
});
