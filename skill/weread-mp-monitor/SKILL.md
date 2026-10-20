---
name: weread-mp-monitor
description: "微信读书公众号盯采与全量归档进 Obsidian。"
version: 1.15.0
author: 紫苏子ACG（pixelxzen）
license: MIT
metadata:
  hermes:
    tags: [obsidian, wechat, weread, monitor, clipping, archive, rss]
    related_skills: [save-article-to-obsidian, wechat-mp-batch-exporter]
---

# 微信读书公众号盯采 / 全量归档 → Obsidian

触发：微信读书公众号、盯采公众号、公众号存 Obsidian、公众号文章归档、单号历史全部导出、weread 公众号。
每个使用者各自登录自己的微信读书账号，互不影响。

## 四个核心功能

| 功能 | 命令 | 说明 |
|---|---|---|
| **① 增量盯采（定时任务）** | `node scripts/weread_mp_monitor.js` | 轮询书架里指定的 20+ 号 → 发现新文章 → 抓正文+图片 → 落 Obsidian。`state.json` 去重，同一篇永不重复。`--dry-run` 只预检不落盘 |
| **② 单号全量历史归档** | `node scripts/weread_mp_monitor.js --backfill "号名" --max 30` | 列表翻到底 + 逐篇抓正文归档；**分批**用 `--max`，断点续跑（已抓的自动跳过）。`--list "号名"` 只导列表 CSV（最轻） |
| **③ 静默存量（只盯以后的新文）** | `node scripts/weread_mp_monitor.js --seed [--pages N]` | 把各号现有存量一次性标记为「已处理」，**不抓正文、不落盘**，并清空 `pending`。之后每轮只落真正的新文章——「实时盯采」的正解 |
| **④ RSS 输出** | `python3 scripts/gen_feed.py` | 从 Obsidian 归档反生成标准 RSS 2.0：总 feed + 每号 feed + 订阅索引页（纯 stdlib，无额外依赖） |

实测规模：单号历史列表能翻到底——赛雷 439 篇 / Datawhale 470 篇（回溯 2025-09）/ 阮一峰 410 篇（回溯 2020-04），每页 20 条。
实测速度：27 号一轮（每号取最新 20～76 条）约 40～50 秒，含落盘与图片本地化——所以 15～30 分钟一轮完全跑得动，不需要把循环压得更密。
首轮积压预期：第一次跑增量会把每号历史都算成「未处理」，27 号实测 ≈ 1271 篇待抓；它只影响「只看从今天起的新文」这个预期，不影响正确性（每轮按号轮转落盘）。
实测 seed：27 号一次性标记 773 条存量（约 95 秒），跑完 27/27 号「未处理 0 条」——想只盯新文就先 `--seed`。

## 风控纪律（最重要，必须遵守）

| 项 | 默认值 | 说明 |
|---|---|---|
| 列表请求间隔 | 1200 ms | config `delayListMs` |
| 分钟级窗口 | **列表请求 ≤8 次/分钟** | 实测 1 分钟内 10 次列表请求会把整个会话打成 `-2012 登录超时`：连 `/web/user`、`/shelf/sync` 都报超时，外观像「登录彻底坏了」，用户会去反复重扫。客户端翻页同理——单页 ≥2.5 s，超窗口就 `await` 到窗口滑过去 |
| 正文请求间隔 | 2500 ms | config `delayContentMs` |
| 长休 | 每 15 篇休 60 s | config `batchRestEvery` / `batchRestMs` |
| 极保守档 | `--slow` | 列表 3 s / 正文 6 s / 每 10 篇休 120 s |
| 风控熔断 | 遇 `-2010 / -2012 / -2041 / LOGIN ERR` **立即停跑，退出码 4，不自动重试** | 避免"重试 → 加重风控"的恶性循环 |
| 单批上限 | `--max 30` 建议 | 不要一次拉几百篇 |
| 分批节奏 | 每批 ≤30 篇，批间隔 ≥10 分钟 | 或交给定时任务每天跑一批 |
| 时段 | 夜间/低频时段更稳 | — |

风吹信号与处置：日志出现 `[RISK]` → 等几小时（严重时一天）再跑；若是登录态问题先 `--login`；仍被拦则加 `--slow`。
`state.json.pending` 会记录"已发现但未抓正文"的条目，续跑时继续。

## 数据通路（全部实测可用）

| 用途 | 接口 | 关键点 |
|---|---|---|
| 书架公众号清单 | `POST https://i.weread.qq.com/api/agent/gateway`，body `{"api_name":"/shelf/sync","skill_version":"1.0.4"}`，Header `Authorization: Bearer $WEREAD_API_KEY` | 需官方 API key（`weread.qq.com/r/weread-skills` 领取）；`books[]` 里 `bookId` 以 `MP_WXS_` 开头的是公众号 |
| 文章列表（可翻页） | 页面内 `GET /web/mp/articles?bookId=MP_WXS_xxx&offset=N` | **每页 20 个槽位，不是每页 20 条**——服务端会过滤，实测同一号 offset=0→20 条 / 20→19 条 / 40→9 条 / 60→0 条。所以 offset 固定 +20 推进，**「返回 0 条」才是到底**：按返回条数累加会错位（offset=39 会重复上一页末条），按「<20 条」判最后一页会提前封底（只加载 20 篇就显示已到底，永远拉不到最早那篇）。字段在 `subReviews[].review.mpInfo`：`title / time / readNum / likeNum / pic_url` |
| 文章正文 | 页面内 `GET /web/mp/content?reviewId=...` | HTML（单篇实测约 4 MB），正文在 `#js_content` |
| 正文图片 | 正文 `data-src` | 下载带 `Referer: https://mp.weixin.qq.com/` |
| 登录用户资料 | `GET https://weread.qq.com/web/user?userVid=<wr_vid>` | **必须带桌面 UA**，否则只返回 `{"errCode":-2012}`（HTTP 仍 200）；带 UA 返回 `name / avatar / vDesc`，适合登录卡展示。头像是 `thirdwx.qlogo.cn` 外链，客户端展示前建议落盘 |

注：「`/web/mp/articles` 已被微信读书废弃」是网上流传的**过时结论**——实测 200 且数据完整，微信读书前端自己也在调它。

### 双凭证模型（API Key + Cookie，别用一个替代另一个）

两条通道能力**不重叠**，做客户端时必须同时支持：

| 凭证 | 覆盖 | 生命周期 |
|---|---|---|
| **官方 API Key**（`wrk-…`，Bearer） | `/shelf/sync`（全量书架，含公众号 bookId）、`/user/notebooks`、`/readdata/detail`、`/book/*`、推荐、书城搜索 | 长期有效（现网实测不失效） |
| **登录 cookie**（6 项） | `/web/mp/articles`（文章列表）、`/web/mp/content`（正文 + 图片） | 数周～数月失效 |

**关键判定：公众号的文章列表与正文只存在于页面接口，官方 Agent API 的 18 个接口里没有它们 → 纯 API Key 方案拿不到正文。** 任何「只用 API Key 抓公众号」的设计都是死路，先验这一点再动手。

**两套凭证必须同源，跨账号是最常见的假故障。** Key 的服务端身份是它签发时的账号，cookie 的身份是 `wr_vid`。两者不一致时会出现一组很有迷惑性的组合：`/shelf/sync` 正常（Key 读它自己账号的书架，数量也对）、`/web/user?userVid=<wr_vid>` 能返回昵称、但 `/web/mp/articles` 稳定 `-2041` 或 `-2012`。看起来像 cookie 过期，重扫也常「没用」，实际是拿 A 账号的 Key 配 B 账号的 cookie。判据：把 cookie 里的 `wr_vid` 打 `/web/user?userVid=` 看昵称，与 Key 账号（书架里的号、`/user/notebooks` 的笔记）是否同一个人的；两个账号的书架号数通常也不同，对不上就是错配。

换账号时**两套一起换**：重扫拿到新 cookie 后立刻再跑一次 `apikeyGet` 换新 Key，否则旧 Key 继续指向旧账号。只换一半必然跨账号，且报错码会把人往 cookie 上带。

**`wr_gid` 不落盘 —— 任何「解密 Chrome cookie 数据库」的路线都拿不到它。** 实测 Chrome 的 `Cookies` SQLite 里 `weread.qq.com` 只有 9 项（`wr_fp / wr_vid / wr_ql / wr_rt / wr_skey / wr_localvid / wr_name / wr_avatar / wr_gender`），**没有 `wr_gid`**——即便 Chrome 正常退出、`--restore-last-session` 也没用。它是页面 JS 运行后才写入的会话级 cookie，只活在运行中浏览器的内存里。能拿到它的只有三处：① 脚本自己的专用 profile `--login` 后在页面上下文取；② 运行中浏览器的 CDP `Network.getAllCookies`；③ 让页面在实际宿主里自己写下来（Obsidian 插件走 iframe，见 `obsidian-plugin-hands-on` 的「内嵌第三方登录」）。拿 6 项齐不齐判之前，先确认第十二项这条路有没有走通。

**Key 不能当 cookie 用，两个码不代表账号有问题。** `Authorization: Bearer wrk-…` 打 `/web/mp/articles` → `-2010 用户不存在`（网页接口只认 cookie，不认 Bearer）；官方网关打 `api_name: /mp/articles` → `499`（该 api_name 不存在）。排障时看到这两个码，不要去查账号状态或换 Key。

用登录态换 Key（一条 GET，不需要去网页点按钮）：

```bash
curl -s 'https://weread.qq.com/api/skills/apikeyGet' \
  -H "Cookie: $WEREAD_COOKIE" -H 'Referer: https://weread.qq.com/' \
  -H 'User-Agent: <桌面 UA>'
# → {"apikey":"wrk-...","created_at":1779269630,"last_used_at":...}
```

- 只有 **GET** 有效；POST 同路径 404。返回值形如 `wrk-` + 24 位，长度约 28。
- 因此「扫码登录」只需保证拿到完整 cookie，Key 与书架清单都能自动派生——用户只做一个动作。

官方 `/store/search` 同样搜不到公众号：scope 试过 `0 / 2 / 4 / 2+count`、参数名试过 `type=2`，响应里 `MP_WXS_` 命中恒为 0（接口文档里 scope=2「公众号」在当前线上不可用）。要加号仍然只有两条路：微信读书 App 里加入书架，或直接写已知 `MP_WXS_xxx`。

### 纯 HTTP 直调（不依赖浏览器；插件 / 后端 / 任意客户端可用）

同一套接口在普通 HTTP 客户端里也能跑通，**前提是 cookie 完整**：

- 必需 6 项：`wr_fp / wr_vid / wr_ql / wr_rt / wr_skey / wr_gid`。**缺 `wr_gid` 稳定返回 `-2012`**（HTTP 仍是 200，body 只有约 62 字节的 error JSON）。补 UA / Referer / Origin / `x-requested-with` 都没用——别往 header 方向排障。
- `wr_gid` 是**页面 JS 运行后写进去的**：刚连上时 `ctx.cookies()` 里没有它。取法：`goto('https://weread.qq.com/')` → 等 1.5–2 s → 再合并 `ctx.cookies()`（含 HttpOnly）与 `page.evaluate(document.cookie)`（补上 `wr_gid`）。
- 补齐后实测：`/web/mp/articles` 200 / 52 KB / 20 条；`/web/mp/content` 200 / 4.0 MB / 含 `#js_content`。
- 意义：可以不启浏览器、不用页面上下文——Obsidian 插件 `requestUrl`（主进程发起，自带 CORS 豁免）、Node `fetch`、任意后端都能直调，也绕开「扩展拦截 `/api/` 导航」那类问题。做插件或 Go/Python 客户端时优先走这条，只有拿不到 cookie 时才退回浏览器方案。

**加号只能在 App 里做**：网页版搜索（`/api/store/search`）与官方 gateway 的 `/store/search` 都**不返回公众号**（判据与实测覆盖范围见上节）。要盯一个新号，得在**微信读书 App** 搜索并切到「公众号」分类 → 加入书架；加入后除了 `accounts` 之外什么都不用改（脚本每轮重新读 `/shelf/sync`，新号自动纳入）。持官方 Key 的客户端可重拉一次 `/shelf/sync` 直接拿全量清单（实测 568 个）。

**挑号先做活跃度分诊**：`--list "号名"` 导出的 CSV 带 `published` 列（还有 `readNum` / `likeNum`），一眼能看出号是否停更；批量看就逐号跑或先 `--dry-run --only "号A,号B,..."` 看每号的未处理量。停更号留在 `accounts` 里只会白跑列表请求。

书架额度与账号口径（免费/付费的书架上限、公众号按「一本书」占额度、`books+albums+mp` 计数规则、账号会员状态怎么只读地看、上游 skill 升级会覆盖本地改动）→ `references/account-and-shelf-quota.md`。

## 写入通道归属与去重（被问「这些笔记是谁写进来的」先看这节）

同一台机器上会同时存在多条往 Obsidian 写的通道，别把它们混成一个。逐层取证，而不是凭印象归因：

| 层 | 判据 | 特征 |
|---|---|---|
| macOS launchd | `launchctl list \| grep -E 'weread\|obsidian'`；`ls ~/Library/LaunchAgents/` | plist 里 `StartInterval 1800` → 每 30 分钟跑 `~/.weread-monitor/run-once.sh` → **本 skill 的脚本**。不经过 Hermes、不经 LLM，人不在聊天它也照跑 |
| Obsidian 插件 | `.obsidian/plugins/<id>/data.json` 的 `settings`（`autoStart` / `intervalMin` / `outputDir`）与 `state.lastRun` | 插件自带定时器，独立于 launchd |
| Hermes cron | `~/.hermes/cron/jobs.json` 的 `jobs[]`：看 `no_agent` + `script` 还是 `prompt` | `no_agent: true` 的是脚本任务，既无 skill 也无推理；prompt 为空但 script 有值的 job 别当成空任务 |
| 浏览器扩展 | `~/Library/Application Support/Google/Chrome/*/Extensions/*/*/manifest.json` 的 `name` 含 Clipper | 手动点扩展才写，不构成「持续」通道 |

**frontmatter 就是写入者指纹，别靠猜目录名：**

- `source: "weread://MP_WXS_…"` + `author_org: "xx（微信读书）"` + `tags: [剪藏, 微信读书公众号]` = 微信读书通道。本 skill 脚本与 Obsidian 插件 weread-mp **格式同源**，只能靠输出目录区分：脚本写 `config.obsidianDir`，插件写 `outputDir`。
- 中文键 `标题 / 来源 / 作者 / 创建时间 / 描述 / 标签: clippings` = Obsidian Web Clipper 浏览器扩展（手动剪藏）。
- 想知道某条通道近 N 天真实产量：遍历 vault 取 `os.path.getmtime` 按天分桶、再按 frontmatter 的 `source` 前缀归类。比读日志可靠——日志会说「本轮成功」，但不会告诉你总共落了多少。

**判活各看各处：** 本 skill 看 `~/.weread-monitor/last-run.json` 的 `runAt / written / results`；插件看 `data.json` 的 `state.lastRun.error`（出现 `列表：登录态过期，需重新扫码 (-2012)` 就是插件这条挂了）。**两条通道故障独立**：插件挂 ≠ 脚本挂。别因为插件报错就断言「微信读书采集停了」——先看 `last-run.json` 的时间戳，它才代表脚本侧是否在跑。

**去重纪律（1.15.0 起有闸门兜底）**：本 skill 脚本与 Obsidian 插件 weread-mp 各自按自己的 `state.json` / `state.processed` 去重，**跨通道互不知道对方写过什么** → 同一篇会落两份（实测出现过同名重复）。

现在**落盘前**做三道检查，命中就跳过（不下载正文、不下载图片）：

| 检查 | 命中原因码 | 含义 |
|---|---|---|
| 目标目录里已有同名文件 | `target-exists` | 同目录同名（最直观的那种重复） |
| `frontmatter.source` 里同一个 reviewId | `same-review` | 同一篇文章（最准，跨标题改写也拦得住） |
| 任一 `config.dedupeDirs` 目录里已有同名 slug | `same-title` | 另一条通道（如插件 `outputDir`）已归档过 |

日志里显示 `⤵ 跳过（原因）标题`；`state.processed` 里记 `skipped: <原因码>`；`--json-out` 的摘要里 `dupSkipped` 是累计跳过数。

**要两条通道并存**：把插件的输出目录写进 `config.dedupeDirs`：

```json
{ "obsidianDir": "<脚本自己的归档目录>", "dedupeDirs": ["<插件的 outputDir 绝对路径>"] }
```

**更彻底的做法仍然二选一**：关掉插件 `autoStart`，或把 `config.obsidianDir` 与插件 `outputDir` 统一到同一目录只留一套 state。闸门是安全网，不是替代——它省掉重复落盘，但两条通道还是会各花一份请求额度。

## 安装（一次性）

```bash
cd <skill_dir>
npm i playwright-core            # 依赖
npx playwright install chromium  # 若本机没装 Google Chrome（脚本默认用 channel:chrome）

mkdir -p ~/.weread-monitor
cp <skill_dir>/templates/config.example.json ~/.weread-monitor/config.json
# 改 config.json：obsidianDir（你的剪藏目录）、accounts（要盯的号）
```

## 登录（每人一次，登录自己的账号）

```bash
node <skill_dir>/scripts/weread_mp_monitor.js --login
```

弹出 Chrome → 微信扫码 → 脚本自动确认，登录态存 `~/.weread-monitor/chrome-profile`（cookie 过期后重跑一次即可）。
可选：`export WEREAD_API_KEY=wrk-xxxx` → `accounts` 可直接写公众号名字；没 key → 写 `MP_WXS_xxxx` 或 `{"name":..,"bookId":..}`（怎么拿到 id 见下节）。

## 怎么拿到公众号的 `MP_WXS_xxx`

优先走 ①，一次拿全部；②只适合单个号。

**① 从书架全量导出（推荐）**：`/shelf/sync` 的 `books[]` 里 `bookId` 以 `MP_WXS_` 开头的就是公众号，`title` 是名称。一条命令生成「名称 | MP_WXS_xxx」清单（每行一个）：

```bash
curl -s -X POST https://i.weread.qq.com/api/agent/gateway \
  -H "Authorization: Bearer $WEREAD_API_KEY" -H 'Content-Type: application/json' \
  -d '{"api_name":"/shelf/sync","skill_version":"1.0.4"}' \
| python3 -c "
import sys, json
bs = [b for b in json.load(sys.stdin)['books'] if str(b.get('bookId','')).startswith('MP_WXS_')]
for b in sorted(bs, key=lambda x: x['title']): print(b['title'], '|', b['bookId'])
" > mp-ids.txt
```

实测本账号一次导出 **568** 个公众号条目（书架 4097 本电子书，2026-10-17 快照）。书架会变（本帐号 30 分钟内从 511→568），名字重名不保证唯一，需要时重跑这一条即可。

**② 从阅读页 URL 反解（单号）**：`/web/mp/reader/<hash>` 与 `/book-detail?v=` 里的 hash **不是** bookId 明文，而是「一小段前导字段 + bookId 的 ASCII 十六进制 + 尾部字段」拼起来的；把可打印段按 hex 解码即可（`MP_WXS_` 的 hex 是 `4d505f5758535f`）。**不要直接把 hash 当 bookId 写进 config**。

```python
import re
def wrid(url):
    seg = url.rstrip('/').split('/')[-1]; best = None
    for i in range(len(seg)):
        j, buf = i, []
        while j + 2 <= len(seg):
            b = int(seg[j:j+2], 16)
            if 32 <= b < 127: buf.append(chr(b)); j += 2
            else: break
        s = ''.join(buf)
        if re.fullmatch(r'MP_WXS_\d+', s): best = s
    return best
# /web/mp/reader/6a84218224d505f5758535f33323236333633343236a4e -> MP_WXS_3226363426（Datawhale，实测）
```

**③ 没订阅的号拿不到**：只有 App 里「公众号」分类加入书架后才进 `/shelf/sync` 清单；官方 `/store/search` 搜不到公众号（实测，见「数据通路」）。

## 用法

```bash
node scripts/weread_mp_monitor.js --dry-run                    # ① 预检：每号最新 N 条 + 未处理数
node scripts/weread_mp_monitor.js                              # ① 增量落盘（定时任务用这个）
node scripts/weread_mp_monitor.js --seed                       # ③ 静默存量：只盯以后的新文
node scripts/weread_mp_monitor.js --seed --pages 25            # ③ 深静默：每号翻 25 页再标记
node scripts/weread_mp_monitor.js --only "阮一峰的网络日志,Datawhale"
node scripts/weread_mp_monitor.js --list "赛雷"                 # ② 只导完整列表 CSV
node scripts/weread_mp_monitor.js --backfill "赛雷" --max 30    # ② 分批归档正文（可反复跑到抓完）
node scripts/weread_mp_monitor.js --backfill "赛雷" --from 2026-01-01   # 只归档该日期之后
node scripts/weread_mp_monitor.js --slow --backfill "赛雷" --max 10     # 极保守档
```

`--json-out /tmp/weread-mp.json` 可把本轮摘要写成 JSON，供定时任务/Agent 读取。

## RSS 输出

```bash
python3 scripts/gen_feed.py                                  # → ~/.weread-monitor/feed/
python3 -m http.server 8787 -d ~/.weread-monitor/feed        # 本地订阅服务
```

产出：`index.xml`（全部，最新 120 篇）、`<bookId>.xml`（每号，最新 60 篇）、`index.html`（订阅索引页）。
订阅方式：Reeder / NetNewsWire / FreshRSS 里加 `http://127.0.0.1:8787/index.xml`（或单号 feed）。
公网发布：`WEREAD_FEED_BASE=https://your.domain python3 scripts/gen_feed.py` 生成绝对链接，再把 `feed/` 传静态托管（CF Pages 等）。
边界：feed 内图片是本地 `file://` 路径 → 公网订阅时图片不显示（文字全文完整）；要带公网图需额外上传 assets 或改用原图 URL。
每日汇总：`python3 scripts/summary.py` → 最近 24h 新落盘笔记汇总成一份 md，默认写 `<vault>/AI日报/weread盯采-YYYY-MM-DD.md`（可用 `WEREAD_SUMMARY_DIR` 改）。

## config 字段

| 字段 | 说明 |
|---|---|
| `obsidianDir` | 输出目录（笔记落它下，图片落 `<它>/assets/<标题>/`） |
| `accounts` | 要盯的号：名字数组（需 API key）/ `MP_WXS_xxxx` / `{"name":..,"bookId":..}` |
| `perAccount` | 每号每轮检查最新多少条（默认 20） |
| `delayListMs` / `delayContentMs` | 列表 / 正文请求间隔（默认 1200 / 2500） |
| `batchRestEvery` / `batchRestMs` | 每 N 篇长休多少毫秒（默认 15 / 60000） |
| `maxNewPerRun` / `maxPerAccountPerRun` | 增量模式单轮总上限 / 每号上限（默认 6 / 2） |
| `stateFile` | 去重状态（`processed` 已落盘、`pending` 待抓） |
| `chrome.profileDir` / `chrome.headless` / `chrome.closeWhenOwned` | 专用 profile 路径 / 无人值守 true / 跑完关自己的窗口 |

## 定时任务

轮询间隔纪律：微信读书**没有推送 API**，「实时」只能靠轮询；公众号发文本身是小时/天级，**30 分钟一轮即准实时**。间隔**下限 15 分钟**，更密就进风控红线区——不要为了「更实时」把间隔压到几分钟。

**方式一：常驻守护（临时/手动）**

```bash
bash scripts/watch.sh 30                                   # 每 30 分钟一轮（前台）
nohup bash scripts/watch.sh 30 > /tmp/weread-watch.log 2>&1 &   # 挂后台
tail -f /tmp/weread-watch.log                              # 看日志
pkill -f "bash watch.sh"                                   # 停止
```

命中风控（主脚本 exit 4）时，守护脚本自动暂停 3 小时再试，**不做密集重试**。

Agent 侧启动守护进程：用 `terminal(background=true)` 直接跑 `bash scripts/watch.sh 30`；**不要**把 `nohup … &` 写进前台命令（Hermes 会拒绝带 shell 级后台包装的前台调用，白耗一轮）。上面那两行是给人用的。

**方式二：launchd（推荐长期；已实测）**

执行器 + 两个 plist（模板在 `templates/`）：

```bash
cp templates/com.zishen.weread-mp.plist         ~/Library/LaunchAgents/
cp templates/com.zishen.weread-mp-summary.plist ~/Library/LaunchAgents/
cp scripts/run-once.sh ~/.weread-monitor/ && chmod +x ~/.weread-monitor/run-once.sh
# plist 里的用户名/路径按自己环境改，然后：
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.zishen.weread-mp.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.zishen.weread-mp-summary.plist
launchctl kickstart -k gui/$(id -u)/com.zishen.weread-mp     # 立即跑一轮验证
tail -f ~/.weread-monitor/logs/monitor.log
```

- `com.zishen.weread-mp`：`StartInterval 1800` → 每 30 分钟增量
- `com.zishen.weread-mp-summary`：`StartCalendarInterval 08:30` → 每天汇总
- 卸载：`launchctl bootout gui/$(id -u)/com.zishen.weread-mp`
- **plist 的 PATH 必须含 node 的真实目录**（本机是 `~/.local/bin`）——launchd 不继承 shell PATH，漏了会 exit 127。
- `run-once.sh` 每轮结束自动重建 RSS（`gen_feed.py`），feed 与归档同步，不必单独给 feed 排任务。

**Hermes Agent 定时任务**：让 cron 执行同一条命令，读 `--json-out` 的 `newFound / written / results` 生成简报；要推手机则投递到飞书或微信（CLI 会话本身收不到 cron 输出）。

## 验收

1. 日志有每号 `最新 X 条，未处理 Y 条` 与 `本轮落盘 N 篇`；
2. 每篇笔记含 frontmatter + `## 正文`，正文引用图数 == `assets/<标题>/` 实存数（断链 0）；
3. `state.json.processed` 增加，**重跑同一轮不重复落盘**；
4. `--backfill` 可连续多次跑到列表耗尽（每轮 `--max` 上限）；
5. `--seed` 之后立刻跑一轮增量，全号应是「未处理 0 条」；
6. `gen_feed.py` 产物能被 `xml.etree` 解析且 item 数 > 0，本地 `http.server` 取 `index.xml` 返回 200。

## 坑（必读）

1. **浏览器扩展会拦「导航到 `/api/` 路径」**（`net::ERR_BLOCKED_BY_CLIENT`）→ 取数据必须**页面内 fetch**，不要 `page.goto(接口URL)`。
2. 运行中 Chrome 若由扩展提供调试端口，那是私有桥（`/json/*` 404、ws 连不上）→ **必须用脚本自己的专用 profile**（`--login`），别试图连用户日常 Chrome。
3. 若用标准 CDP：**不要调 `browser.close()`**（会关掉用户浏览器），用 `process.exit()`。
4. 图片 Referer：`mmbiz.qpic.cn` 用 `https://mp.weixin.qq.com/`（脚本已带，失败自动重试无 Referer）。
5. 微信 CDN 会把 PNG 挂在 `.jpg` 名下 → 按**魔数**判扩展名（脚本已处理）。
6. 接口报 `-2010/-2012/-2041` 一律熔断、不写循环重试，但三者**不都是「重登就能修」**：`-2010` 是没登录，`-2012` 是会话过期（重扫有效），`-2041` 是**登录态有效、公众号接口被限**（重扫无效，别在 cookie / header / UA 上打转）；实测有效的恢复动作是**手机微信读书 App 打开该号任一篇文章**（有滑动验证就划一下），当日即解除；深翻历史/连续翻页是最容易触发它的动作，先按上面的分钟级窗口节流。但判 `-2041` 前必须先排两个它自己的混淆项：① **这个 bookId 是否还在书架**（`-2041` 也含「不在书架」语义，用 `wrk-` Key 调 `/shelf/sync` 一查就知道）；② 错误码字段名有时是 `errCode` 而不是 `errcode`，只读一种会把码当空列表吞掉。三探针 + `wrk-` Key 第四轴、脚本化决定性验证（页面内同源 fetch）与恢复路径 → `references/error-codes.md`。
7. `headless: true` 通常够用；被风控时改 `false`。
8. 首次跑增量会"发现"每号最新 N 条（几百上千篇）；用 `maxNewPerRun/maxPerAccountPerRun` 控制单轮量，或先 `--dry-run` 看清规模。
9. `✗ <标题>: no js_content` **不是抓取失败，但也不该直接丢弃**：纯图片/视频型推送（小绿书）的正文由前端 JS 渲染，`/web/mp/content` 返回的 HTML 里根本没有 `#js_content`（判据 `hasJs=false`，HTML 仍可能好几 MB）。正确处理顺序：① 不要重试、不要改选择器（源头就没有）；② **回退到列表接口自带的字段**——`mpInfo.content`（摘要，实测有值）与 `mpInfo.pic_url`（封面），用它们写一篇「图片笔记」型笔记（一句说明 + 摘要 + 封面 + 原文链接）；③ 连这两个字段都空才记失败，原因写「无正文」。把这类推送当空跳过，用户看到的是「明明有文章却一篇都没落盘」。同号的图文文章照常正常。
10. **launchd / cron 不继承 shell 环境变量**：`WEREAD_API_KEY` 在定时任务里不存在 → `accounts` 写名字会 `exit=2 / 没有可用的 bookId`。把 `accounts` 改成 `{"name":..,"bookId":..}` 对象即彻底免疫，plist 里也不必塞密钥。
11. `--seed` 会**清空 `pending`**（语义：只盯以后的新文）；之后想补历史用 `--backfill` 重新拉，不受影响。
12. 纯 HTTP 调用报 `-2012`、而同一账号在浏览器页面内正常 → 先查 cookie 是否缺 `wr_gid`（取法与判据见「数据通路 → 纯 HTTP 直调」），不要在 header 组合上打转。若 6 项齐全仍 -2012：**cookie 已被轮换**（微信读书会刷新 `wr_skey`，尤其在同一账号多端登录或短时间高频请求后）。此时 profile 里已是新值，直接从 profile 重取即可恢复，不要当成账号被封。若重取后 curl 直连正常、而 **Obsidian 插件里仍报错**：先别改 HTTP 层。正确顺序是：① 用页面内同源 fetch 做决定性验证（见坑 6 与 `references/error-codes.md`）——**页面内也回同一个码，就是服务端限制或 cookie 真的过期了，插件侧改什么都没用**；② 只有「页面内正常、插件报错」才算 cookie 混入，而这时首选仍是 `requestUrl` + `Promise.race` 硬超时（8s，超时抛错、界面绝不静默挂住），**不要一上来就换 `net.request`**：它在 renderer 里可以永久 pending 且不触发 error，所有兜底都不跑，表现为「选号后一直转圈」的假死，比 cookie 混入危险得多。完整修法与实测教训见 `obsidian-plugin-hands-on` 的「requestUrl 会混入 defaultSession 的 cookie」。另外：`wr_skey` 短串（约 8 字符）是正常形态，判残缺只看六项是否缺失，不看长度。
13. **同一个 `chrome-profile` 不能被两个进程同时打开**：launchd 定时任务正在跑一轮时，另一个脚本再 `launchPersistentContext(同一个 profileDir)` 会直接失败退出。需要 cookie 时的优先顺序：① 从已落盘的 `data.json` / 配置里复用（不启浏览器，最快）；② 先 `pgrep -f weread_mp_monitor` 等它结束再取；③ 用独立 profile。不要把“取 cookie”写成默认先启浏览器。
14. 多产物共享 cookie 时（CLI + 插件 + RSS 生成器），把 cookie 当成**单一来源**：只在一处保存（插件的 `data.json` 或 `~/.weread-monitor/` 的登录 profile），其它端读它。多处各自扫码登录会互相挤掉登录态（微信读书同一账号多端登录会失效）。
15. **验证分页/接口行为时不要循环 curl 打线上**：一次性抓 4 页（offset 0/20/40/60）落成 fixture 文件，之后所有推演都在这份 fixture 上离线跑（写成单测更好）。连续十几次列表请求足以把用户账号打成 `-2012`，而你要的往往只是「页长序列」这一组数字。同理，排障时先用 `/web/user` 对照一次确认登录态，别靠反复打列表接口试。
16. **`--max` 只限「本次下载多少篇」，不是给其余篇目打标记。** 未抓的保持 `pending`（界面上的「待抓」），续跑接着取；把它理解成「超过 max 都失败/都被标记」会导致误判成 bug。做客户端（无限滚动 / 分批归档弹窗）时另有两条硬规则：① **判重必须在发请求之前完成，命中就回写已处理索引**——否则「文件在、索引无」的篇目每批重下一遍并吃满单批名额，48 篇的号每批只净推进个位数，用户会说「永远跑不完」；② 收尾进度不许拿全集篇数当 total（30 篇的批次会渲染成 `48/48 100%`），本批处理量与全库库存分两行给，并在有剩余时给「继续下一批（还有 N 篇）」。

## Obsidian 插件 cookie 过期抢救（-2012 确定性修法）

触发：插件 `data.json` 的 `state.lastRun.error` 出现 `登录态过期…(-2012)`，且 cookie 字符串里 `wr_localvid / wr_name / wr_avatar / wr_gender` 长度为 0（插件校验只看 `wr_vid/wr_skey/wr_rt/wr_gid` 四项是否**在**，不看值 → 残缺 cookie 能通过格式校验却一定 -2012）。

五步，全部可脚本化（实测 2026-10-18 一次通过）：

1. **先确认 profile 空闲**：`pgrep -f weread-monitor` 空 + `lsof +D ~/.weread-monitor/chrome-profile` 空，再动。运行中复制会拿到半写状态的 `Cookies`。
2. **复制专用 profile 到 scratch**（`cp -R ~/.weread-monitor/chrome-profile`），删 `Singleton*`，用 `playwright-core` `launchPersistentContext(dir, {channel:'chrome', headless:true})` 打开 `https://weread.qq.com/`，等 3s 后 `ctx.cookies(['https://weread.qq.com/'])`。
   - 这一步能拿到 **11 项**（含只在运行内存里的 `wr_gid`、`wr_localvid`、`wr_name`）；`wr_skey` 约 8 字符是正常形态。
3. **写前校验接口**（决定成败的唯一硬判据）：带新 cookie 打 `https://weread.qq.com/web/mp/articles?bookId=MP_WXS_xxx&offset=0`，要求 `HTTP 200` + `reviews` 有 20 条 + 无 `errcode`。不通就不要写进插件。
4. **原子写 `data.json`**：先 `shutil.copy2` 备份；`settings.cookie` 拼 `k=v; k=v`；`useSession=false`；更新 `webLoginOk/webLoginMsg/webLoginAt/lastCookieTime`；`state.lastRun.error=None`；tempfile + `os.replace`；回读断言「11 项全非空」「cookie 变了」。
5. **必须让 Obsidian 重读**：插件内存里是旧 settings，靠自己不会刷新；用 `osascript -e 'tell application "Obsidian" to quit'` + `open -a Obsidian`（实测比 System Events 发 Cmd+R 可靠）。重启后回读 `data.json` 确认 cookie 仍是新值（没被内存旧值写回）。

**不要误判的两种情况**：① 插件 `autoStart=true, intervalMin=30` 时，重启后**不会**立刻跑首轮，要等满一个 interval，别把「lastRun 没变」当成修复失败；② 插件还有一条 `webLogin`（内嵌网页登录）通道，`useSession=false` 不代表不能跑——本次 -2012 之后它靠网页登录照样在 23:46–23:51 写了 8 篇，`lastRun.error` 被下一轮成功自动清空。判活看 `lastRun.at` 是否前进 + `written` 是否 >0。

**收尾验证用轮询探针，别单次开枪**：`python3 scripts/plugin_cookie_check.py --wait 3000 --interval 180`。它把首次读到的 `state.lastRun.at` 当基线，之后每轮比对，出现「at 前进且 error 为空」才退出 0，超时退出 3，并把每轮一行写进日志（事后能区分「没到点」与「检查没跑」）。改完凭据当场只能证明到「接口 200 / 磁盘值正确」这一层，插件自身跑通必须等这一轮。

**`written` 是插件内部计数，落盘以文件系统为账**：实测出现 `written: 6` 而 `find <outputDir> -name '*.md' -newermt '<起始时刻>'` 只数到 5 篇——差那 1 篇可能被同名跳过或计数口径不同。报结果时以 `find` 的实数与清单为准，差的如实写「未对平」，不要用内部计数充数。

## 能力边界

- 单号历史列表**能翻到底**；列表自带**阅读数 / 点赞数**（公众号原生看不到）。
- 正文含图文 + 音频/视频，都可以落盘：
  - 音频：`<mpvoice voice_encode_fileid="X">` → 直链 `https://res.wx.qq.com/voice/getvoice?mediaid=X`；`<audio src>` 直接取 src。下载后在笔记里写 `<audio controls src="…"></audio>`。
  - 视频：`<video src>` 直接取；微信播放器 iframe（`data-mpvid="wxv_…"`）的 mp4 直链**就在正文 HTML 的 JS 数据块里**——每视频 4 档码率，按 `filesize` 取最大（通常 `f10002`）；带 `Referer: https://mp.weixin.qq.com/` 即可下载，**不需要 cookie**；签名参数会过期，抓到当场落盘。完整算法、curl 判据与体积闸门 → `references/media-extraction.md`。拿不到直链才降级为可点链接（`[🎬 视频：播放](<url>)`），不要写成坏掉的 img。
  - 落盘路径含中文/空格时，Markdown 引用必须用尖括号：`![](<../assets/标题/img-1.jpg>)`，否则笔记里显示不出来（图其实已经下载成功）。
- 内容版权归原作者，仅个人存档/研究，不得二次分发。

## Changelog

| 版本 | 日期 | 说明 |
|---|---|---|
| 1.15.0 | 2026-10-20 | 落盘闸门：标题同名 / reviewId 同源 / `dedupeDirs` 跨目录同名，命中即跳过（不发正文请求），state 记 `skipped` 原因、summary 出 `dupSkipped`；新增 `config.dedupeDirs` 让脚本通道与 Obsidian 插件通道并存不重复；实测 5 个用例（含 rememberNote 增量）全过 |
| 1.14.0 | 2026-10-20 | 补坑 16：`--max` / 单批上限只限本次下载量，未抓的保持 `pending`（待抓）而非标记失败；客户端实现分批归档时两条硬规则——判重必须在发请求前完成并回写索引（否则幽灵 pending 吃满单批名额、永跑不完），收尾进度不得拿全集篇数当 total（本批量 / 全库库存分两行），并给「继续下一批」入口 |
| 1.13.0 | 2026-10-20 | **纠正分页模型**：`/web/mp/articles` 是「每页 20 个槽位」而非「每页 20 条」（实测 20/19/9/0），offset 必须固定 +20，「返回 0 条」才是到底——按返回条数累加会重复一条，按「<20 条」判最后一页会提前封底；风控纪律补**分钟级窗口**（≤8 次/分钟，1 分钟内 10 次即把全会话打成 `-2012 登录超时`，连 `/web/user` 都读不出）；补 `-2041` 的实测恢复动作（手机 App 打开该号任一篇文章，当日解除）；新增坑 15「验证分页不要循环 curl 打线上，先落 fixture 再离线推演」 |
| 1.12.0 | 2026-10-18 | 新增「Obsidian 插件 cookie 过期抢救」五步法：复制专用 profile → playwright 取 11 项（含内存态 `wr_gid`）→ 用同款列表接口 200/20 条做硬校验 → 原子写 `data.json`（备份 + 回读断言）→ 重启 Obsidian 强制重读；钉死「插件校验只看四项存在不看值，空值 cookie 必然 -2012」「重启后要等满 interval 才有首轮」「webLogin 通道可独立存活，lastRun.at 前进 + written>0 才算活」；收尾验证归档为 `scripts/plugin_cookie_check.py`（基线比对轮询，区分「没到点」与「真坏了」）；钉死「`written` 是内部计数，落盘以 `find -newermt` 实数对账，差的那篇如实报未对平」 |
| 1.11.0 | 2026-10-18 | 新增「写入通道归属与去重」：四层取证（launchd plist / 插件 data.json / Hermes cron jobs.json / Chrome 扩展）+ frontmatter 指纹归属（`weread://` vs Web Clipper 中文键）+ 按 mtime 分桶统计真实产量；钉死「插件通道与脚本通道故障独立，判活各看 last-run.json 与 state.lastRun.error」；钉死「一个 vault 只留一条微信读书写入通道」，两条并存必然同标题重复（跨通道互不去重） |
| 1.10.0 | 2026-10-17 | 新增「凭证同源」：Key 与 cookie 必须同一账号，错配表现为书架正常 + 列表恒定 -2041/-2012（换账号要两套一起换）；钉死 **`wr_gid` 不落盘**（Chrome SQLite 9 项里没有它，只在运行中浏览器内存），任何磁盘解密路线拿不到；补 `Bearer Key` 打网页列表接口 → `-2010`、官方网关 `/mp/articles` → `499` 两个「不是账号问题」的码 |
| 1.9.0 | 2026-10-17 | **纠正坑 9**：`no js_content` 的图片/视频型推送不该当空跳过，回退 `mpInfo.content`（摘要）+ `mpInfo.pic_url`（封面）写「图片笔记」型笔记；这两个字段是这类内容唯一的兜底来源 |
| 1.8.1 | 2026-10-17 | **纠正坑 12 的错误处置顺序**：插件内报错时先把「页面内同源 fetch」跑完再判责任；`net.request` 不再是首选修法（renderer 里可永久 pending 且不报错 → 表现为假死），默认 `requestUrl` + 8s 硬超时 |
| 1.8.0 | 2026-10-17 | `references/error-codes.md` 补三块：① `errCode` / `errcode` 字段名大小写两种都存在（只读一种会把风控码吞成空列表）；② **第四轴：`wrk-` Key 调 `/shelf/sync` 能通 = 账号没问题**，且判 `-2041` 前必须先看「bookId 是否还在书架」（`-2041` 含「不在书架」语义）；③ 「决定性验证」从人工看 DevTools 改为可复跑的页面内同源 fetch 脚本 + 三行结果解读表。坑 6 相应改写 |
| 1.7.0 | 2026-10-17 | 新增 `references/error-codes.md`：`-2010 / -2012 / -2041` 三探针分诊表（`/web/user` + `apikeyGet` + `/web/mp/articles`）；钉死 `-2041 = 登录态有效但公众号接口被限`，决定性证据是官方网页自己发同一个请求也回 -2041；列「已验无效的排障方向」与恢复顺序。坑 6 相应改写 |
| 1.6.1 | 2026-10-17 | 坑 12 补：插件内 -2012 而 curl 正常 = `requestUrl` 混入 defaultSession 旧 cookie（改 Electron net + 独立 partition）；`wr_skey` 约 8 字符是正常形态，别按长度判残缺 |
| 1.6.0 | 2026-10-17 | **视频直链实测通关**：正文 HTML 的 JS 数据块里直接含 mp4 签名直链（每视频 4 档码率，按 `filesize` 取最大，通常 `f10002`），带 `Referer` 即可下载、不需要 cookie；新增 `references/media-extraction.md`（提取算法 + curl 判据 + 体积闸门）。**纠正旧结论**「视频需要再解一层、多数拿不到直链」；补「纯图片/纯视频推送不能按正文为空跳过」 |
| 1.5.0 | 2026-10-17 | 补 `/web/user?userVid=`（需 UA）拿昵称/头像/简介；**纠正旧结论**——音频/视频不再只是标记，给出 mpvoice/video/iframe 提取与 `<audio>/<video controls>` 落盘规范、尖括号路径规则；坑 12 补「6 项齐全仍 -2012 = cookie 被轮换，从 profile 重取即恢复」 |
| 1.4.1 | 2026-10-17 | 新增「怎么拿到 MP_WXS_xxx」：/shelf/sync 一条命令全量导出「名称 \| id」；纠正「阅读页 URL 的 hash 就是 bookId」的误读——hash 是前导字段+bookId 的 ASCII hex 拼串，给出可打印段 hex 解码函数（Datawhale 实测）；补「未订阅的号必须先进 App 书架」 |
| 1.4.0 | 2026-10-17 | 新增「双凭证模型」：官方 API Key（`wrk-…`，长期有效）覆盖书架/笔记/统计，登录 cookie 覆盖文章列表与正文；**明确判定公众号正文只走页面接口，纯 Key 方案拿不到**；补 `GET /api/skills/apikeyGet` 用登录态一键换 Key（仅 GET 有效）；实测官方 `/store/search` 同样搜不到公众号（scope 0/2/4/2+count 与 `type=2` 均 `MP_WXS_` 命中 0） |
| 1.3.1 | 2026-10-17 | 补两条并发/多端坑：同一 `chrome-profile` 不能被两进程同时打开（取 cookie 优先复用已落盘值，而不是先启浏览器）；CLI / 插件 / RSS 生成器共享 cookie 时只留一个来源，多处各自登录会互相挤掉登录态 |
| 1.3.0 | 2026-10-17 | 补「纯 HTTP 直调」通路：6 个 cookie 齐（含 `wr_gid`）即可脱离浏览器调用列表/正文接口，可直接支撑 Obsidian 插件 `requestUrl` 或任意后端；说明 `wr_gid` 要等页面 JS 跑完才出现在 cookie jar 里，缺了稳定 -2012 |
| 1.2.1 | 2026-10-17 | 验收补 `--seed` 与 feed 两项；说明 `run-once.sh` 每轮自动重建 RSS；补 Agent 侧启守护进程要用 `background=true`，前台命令里写 `nohup/&` 会被工具拒绝 |
| 1.2.0 | 2026-10-17 | 新增 `--seed`（静默存量 + 清 pending，只盯以后的新文）；RSS 输出层 `gen_feed.py`（总 feed + 每号 feed + 索引页）与每日汇总 `summary.py`；launchd 方案实测落地（run-once.sh + 2 个 plist）；记录「launchd 无环境变量 → accounts 用对象格式」与 node PATH 两个坑 |
| 1.1.3 | 2026-10-17 | 补：`no js_content` 的纯视频/图片型推送属预期跳过（附诊断判据，避免误判成 bug 去重试）；轮询间隔纪律（无推送 API、15 分钟下限、30 分钟即准实时）；实测单轮速度与首轮积压规模 |
| 1.1.2 | 2026-10-17 | 补两条边界：网页版搜索（`/api/store/search`）不返回公众号（加号必须去 App 的「公众号」分类）；挑号先做活跃度分诊（`--list` 导出的 CSV 带 published/readNum/likeNum 列） |
| 1.1.1 | 2026-10-17 | 新增 `references/account-and-shelf-quota.md`：书架额度（免费 500 本 / 付费无上限）、公众号占额度、书架计数口径、会员状态只读读法、上游 weread-skills 升级覆盖本地改动的处置 |
| 1.1.0 | 2026-10-17 | 增加 `--backfill` 单号全量历史（分批+断点续跑）、`--list` 列表导出；风控策略（间隔/长休/熔断/退出码 4）；`--slow` 极保守档；`--json-out` 摘要供定时任务读取 |
| 1.0.0 | 2026-10-17 | 首次落地：shelf → articles → content → Obsidian；20 号一轮实测通过 |
