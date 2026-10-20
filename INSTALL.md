# 一句话安装

## 交给任意智能体（最省事）

把下面整段复制给你的智能体（Hermes / WorkBuddy / Claude Code / Codex / Cursor 都行），**把库路径换成你自己的**：

> 帮我装两样东西：Obsidian 插件 Zisuzi-Weread-MP，和它的两个技能包。
> 我的 Obsidian 库在 `<把你的库路径填这里>`。
> 执行这条命令，把输出完整贴给我；有报错就告诉我哪一行失败：
>
> `curl -fsSL https://cdn.jsdelivr.net/gh/pixelxzen/Zisuzi-Weread-MP@main/install.sh | bash -s -- --vault "<你的库路径>"`

智能体会执行并把结果报给你。装完你只需两步：重启 Obsidian → 启用插件 → 扫码登录。

## 自己跑（终端）

自动探测 Obsidian 记录的库（只有一个库时会直接用）：

```bash
# 通道 A：jsDelivr（多数网络最快）
curl -fsSL https://cdn.jsdelivr.net/gh/pixelxzen/Zisuzi-Weread-MP@main/install.sh | bash

# 通道 B：api.github.com（github.com / jsDelivr 被墙时用这条，实测最稳）
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/pixelxzen/Zisuzi-Weread-MP/contents/install.sh?ref=main" | bash

有多个库时指定一个：

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/pixelxzen/Zisuzi-Weread-MP@main/install.sh \
  | bash -s -- --vault "/Users/你的用户名/Documents/你的库"
```

只装插件、只装技能、或先干跑看看：

```bash
... | bash -s -- --plugin-only
... | bash -s -- --skills-only
... | bash -s -- --dry-run
```

> 脚本内部按 `jsDelivr → GitHub raw → api.github.com → ghproxy` 依次回退，四条都不通才报错。
> 取不到最新 release 号时自动回退 `main` 分支。

## 它到底装了什么

| 位置 | 内容 |
|---|---|
| `<你的库>/.obsidian/plugins/zisuzi-weread-mp/` | 插件三件套：`main.js` / `manifest.json` / `styles.css` |
| `~/.hermes/skills/`、`~/.workbuddy/skills/`、`~/.claude/skills/`、`~/.codex/skills/`、`~/.gemini/skills/`、`~/.cursor/skills/` | `weread-mp-vault`（读归档）+ `weread-mp-monitor`（抓取器） |
| `<你的库>/.agent-skills/weread-mp-vault/` | skill 源：以后装了新 agent，对它说「把这个目录复制到你的 skills 目录」即可 |
| `~/.weread-monitor/` | 抓取器运行目录 + `config.json`（`obsidianDir` 已指向你的库，`accounts` 为空等你填） |

装脚本会校验 `manifest.json` 的版本与 `main.js` 体积（>100KB），下载不完整直接报错退出，不会留半套文件。

## 装完的三步

1. 重启 Obsidian → 设置 → 第三方插件 → 启用「Zisuzi-Weread-MP」
2. 打开插件设置页 → 点「扫码登录」→ 微信扫一下（登录的是**你自己的**账号，每个人各自一份凭据）
3. 想抓历史 / 定时盯采（终端）：

```bash
cd ~/.weread-monitor
npm i playwright-core && npx playwright install chromium   # 只用一次
node weread_mp_monitor.js --login                          # 扫码；脚本用独立 profile，不动你日常浏览器
node weread_mp_monitor.js --dry-run                        # 预检：每号最新几条、未处理多少
node weread_mp_monitor.js --backfill "某个号" --max 30      # 分批归档历史，可反复跑到抓完
bash scripts/install-launchd.sh                            # 每 30 分钟自动盯采（macOS）
```

## 两个技能分别干什么

| 技能 | 你能说的话 | 干什么 |
|---|---|---|
| `weread-mp-vault` | 「统计我的公众号归档」<br>「哪个号还差几篇没归档」<br>「本周收了哪些号的文章」 | **只读**已归档的笔记与插件索引；快速模式 ≈0.1 秒，完整模式（字数/配图/占用）≈1 秒 |
| `weread-mp-monitor` | 「帮我扫码登录微信读书」<br>「把这个号的历史全抓下来」<br>「开定时盯采」 | 扫码登录、增量盯采、单号全量历史、RSS 输出、cookie 抢救；**自带风控节流** |

## 隐私与安全

- 安装脚本只做文件复制与下载，**不上传任何东西**、不修改系统设置、不加开机启动（launchd 需要你显式跑 `install-launchd.sh`）
- 凭据只在你本机：`<库>/.obsidian/plugins/zisuzi-weread-mp/data.json` 与 `~/.weread-monitor/`
- 仓库内脚本**已脱敏**：不含任何人的用户名、库路径、cookie、API Key；路径一律走 `$HOME`、`config.json` 或环境变量
  - `WEREAD_OBS` 指定归档目录
  - `WEREAD_SUMMARY_DIR` 指定每日汇总输出
  - `WEREAD_PLUGIN_DATA` 指定插件 `data.json`
- 每个使用者登录自己的微信读书账号，互不影响

## 卸载

```bash
# 插件：Obsidian 设置里禁用并删除；或直接删目录
rm -rf "<你的库>/.obsidian/plugins/zisuzi-weread-mp"

# 技能
rm -rf ~/.hermes/skills/weread-mp-vault ~/.hermes/skills/weread-mp-monitor
# （其余 agent 目录同理）

# 抓取器与定时任务
launchctl bootout gui/$(id -u)/com.zishen.weread-mp 2>/dev/null
launchctl bootout gui/$(id -u)/com.zishen.weread-mp-summary 2>/dev/null
rm -rf ~/.weread-monitor
```

已归档的笔记不会被删除。
