# 扫码登录改造说明（4.4.5）

## 上游为什么扫码登录用不了

原实现有两条路，都会在 Obsidian 里失效：

1. `openLoginWindow()`：`window.open('https://weread.qq.com/')` 之后用
   `electron.remote.session.defaultSession.cookies.get()` 读 cookie。
   Obsidian 新版（Electron 22+）已移除 `remote` 模块，取到的是 `undefined`，
   轮询 90 秒必然超时。
2. `startIframeLogin()`：用 `<webview>` 的 `executeJavaScript('document.cookie')` 取登录态。
   Obsidian 默认关闭 `webviewTag`，回退到跨域 `<iframe>` 后又读不到
   `document.cookie`（同源策略），所以「扫了也没反应」。

结论：登录不依赖服务端，是客户端取 cookie 的方式在新版 Electron 里已经不成立。

## 现在的实现（uid 长轮询扫码）

`src/core/qrlogin.ts` + `src/host/qr-login-modal.ts`，全程不碰 webview、不碰微信 OAuth：

| 步骤 | 接口 | 说明 |
|---|---|---|
| 1 | `GET weread.qq.com/api/auth/getLoginUid` | 返回一次性 `uid`（uuid 形态） |
| 2 | 本地生成二维码 | 内容为 `https://weread.qq.com/web/confirm?uid=<uid>`，用 `qrcode-generator` 出 data URL |
| 3 | `GET /api/auth/getLoginInfo?uid=&otp=` | 长轮询；`logicCode 0` 等待、`1` 已确认；`succeed:true` 时返回 `vid/accessToken/refreshToken` |
| 4 | 组装 cookie | `wr_vid` + `wr_skey`（accessToken）+ `wr_rt`（refreshToken） |

要点：

- 必须用 Node `https`，不能用 Obsidian 的 `requestUrl`：后者会丢掉 `Set-Cookie`。
  插件跑在 Electron 渲染进程，`window.require('https')` 可用（与既有
  `child_process` / `os` 用法一致），esbuild 的 `external: builtinModules` 保证不被打包。
- 二维码不再依赖远程图片，CSP 拦不到；`loadQrImageFallback()` 仅作历史兜底保留。
- 令牌既可能来自响应 header 也可能在 JSON body（`accessToken`/`refreshToken`），
  `cookieFromLoginBody()` 两种都收，再与 header 结果合并。
- 换到 cookie 后若缺 `wr_gid`（会话级），`warmUpSession()` 会再打
  `/web/user` 与 `/web/shelf/sync`，把响应里的 `Set-Cookie` 合并进来。
- 长轮询单轮 80s 超时按 `waiting` 处理，弹窗内可「刷新二维码」，也保留手动粘贴 cookie 的兜底入口。
- 登录成功后仍走原有链路：`saveAll → refreshApiKey → refreshProfile →
  syncAccountsFromShelf → checkWebLogin`，与旧实现保持一致。

## 实测记录（2026-10-19）

- `getLoginUid` 正常返回 uid，二维码本地生成成功（data URL 约 4KB）
- `getLoginInfo` 未扫码时：服务端 **hold 约 55 秒**，再返回
  `{"succeed":false,"logicCode":"LOGIN_TIMEOUT","canRetry":false}`
- 同一 uid 连续两轮都正常 hold 55 秒 → `canRetry:false` **不代表 uid 作废**，可以一直续查
- 因此两条实现细节从实测反推出来（都已修正）：
  1. **`LOGIN_TIMEOUT` 必须当 `waiting`**，不能当 `expired`。原先判成过期会导致
     刚生成二维码 55 秒就被判定失效、轮询直接停掉 —— 扫码必然失败。
     只有 `logicCode` 里含 `EXPIRE` 才算真过期。
  2. **二维码内容要带 `pf`**。抓官方 `app.js` 得到的真实拼法是
     `https://weread.qq.com/web/confirm?pf=<1|2>&uid=<uid>`，
     `pf` = `当前客户端是 iOS ? 1 : 2`。桌面插件固定取 `2`。
- 单测：`tests/qrlogin.test.mjs`（27 条），全部通过

### wr_gid 从哪来（真实扫码后暴露的最后一个坑）

真实扫码拿到 `succeed:true` 后，弹窗报「登录信息不完整：缺 wr_gid」。实测各接口的 Set-Cookie：

| 请求 | Set-Cookie |
|---|---|
| `GET https://weread.qq.com/` | `wr_gid=289906200` + `wr_gid=256166121`（后一条覆盖前一条） |
| `GET /web/user?userVid=0` | 无 |
| `GET /web/shelf/sync?synckey=0` | 无 |
| `GET /api/auth/getLoginUid` | 无 |

即 **`wr_gid` 只由首页下发**，而原来的 `warmUpSession()` 只打 `/web/user` 与 `/web/shelf/sync`，
所以永远补不上。现在的做法：

1. 本地没有 `wr_gid` 时，先发一次**匿名**首页请求（`wr_gid` 是设备级游客标识，与登录态无关）
2. 再带完整 cookie 打 `/web/user`、`/web/shelf/sync`
3. 端到端验证：`wr_vid + wr_skey + wr_rt` 三件进 → 出 `…; wr_gid=231000451`

另外，登录信息不完整时不再让用户重扫：已经拿到的那部分会填进弹窗下方的输入框，
点一次「保存这份 cookie」就会再走一遍自动补全（手动粘贴路径也支持补全 `wr_gid`）。

未验证项：真实扫码确认后的 `succeed:true` 响应与 cookie 组装，
需要一次人工扫码才能确认（header / body 两种下发方式都做了兜底）。

## 安装

插件 id 已改为 `weread-mp-fork`（显示名 `Weread MP · 微信读书公众号（Fork）`），可与上游
`zisuzi-weread-mp` 并存，互不覆盖设置。显示名带上 `Weread` 与「微信读书」两个关键词，
是为了在 Obsidian 第三方插件列表里搜得到（本地插件不会出现在「浏览」市场里）。

把 `build/weread-mp-fork/` 下三个文件（`main.js`、`manifest.json`、`styles.css`）
放到 `<你的库>/.obsidian/plugins/weread-mp-fork/`，重启或在 Obsidian 里
`Ctrl+R` 重载，然后在「第三方插件」里启用。

本机已安装到：`D://obsidian//collections//.obsidian//plugins//weread-mp-fork//`。

## 风控码处理

`RISK_CODES` 现为 `[-2010, -2012, -2014, -2041]`，命中即抛 `RiskError` 并**立即停止本轮**，不做重试：

| 码 | 含义 | 提示 |
|---|---|---|
| -2010 | 未登录 | 重新扫码 |
| -2012 | 登录态过期 | 重新扫码 |
| -2014 | 请求频率过高（限频） | 登录态没问题，停 5~15 分钟、把抓取间隔调大 |
| -2041 | 公众号接口对该账号受限 | 手机 App 打开一次公众号，或换账号/等冷却 |

`probeAccess()` 的 verdict 增加了 `rate-limited`，自检会单独报「被限频（-2014）」，
不再和「登录过期」混为一谈。

后续可做：`-2014` 命中的账号自动进冷却表，避免自动盯采反复撞墙。

## 附：已放弃的 `/api/login/wxCode` 方案

早期走微信 OAuth 扫码（`qrconnect` → `connect/qrcode/<uuid>` → `l/qrconnect`）再
`POST /api/login/wxCode` 换 cookie。二维码与轮询都正常，但换登录态这一步在真实扫码后
**稳定 401 / -2013「鉴权失败」**。已排除的原因：

- body 形态改成了数字 + 空串 `{webCode, isAutoLogout: 0, isFromweb: 1, state, vid: ''}`
- 令牌可能只在 JSON body：`cookieFromLoginBody()` 兼容 `accessToken`/`refreshToken`
- 请求头 `X-SSR-Request-Id` + `wr_gid`：按「SSR+COOKIE → SSR → COOKIE → PLAIN」四组合都试过
- 用 CDP 抓真实浏览器请求逐字段比对，`redirect_uri` 对齐成 `https://weread.qq.com/`、`state` 置空、`self_redirect=false`
- 四种组合实测**仍全部 -2013**

结论：该接口对非官方客户端来源做了额外校验（微信 OAuth 迁移或来源风控），继续猜参没有意义。
改用微信读书自己的 uid 扫码接口（`getLoginUid` / `getLoginInfo`）后，链路回到「网页版确认登录」
这一官方语义，是目前的主路径。

相关代码未删除，`qrlogin.ts` 里保留 `parseLoginInfo` 对旧响应的兼容分支，便于将来复用。

## `-2014` 限频的实际定位（2026-10-19，用真实登录态诊断）

现象：登录态正常，但 `/web/mp/articles` 持续返回 `-2014 请求频率过高`，等 30 分钟仍不恢复。

诊断脚本 `scripts/diag-mp-2014.mjs`（读插件保存的 cookie，拉起独立 Chrome 注入后复现）：

| 检查项 | 结果 | 结论 |
|---|---|---|
| `/web/shelf/sync` | `code=0` | **cookie 完全有效** |
| `/web/mp/articles`（匿名） | `-2010 用户不存在` | **IP 没被限**（限 IP 的话匿名也该 -2014） |
| `/web/mp/articles`（登录 + 完整浏览器头 + SSR id） | `-2014` | 不是请求头/指纹问题 |
| `/web/mp/articles`（**真实 Chrome 内** fetch，同一 cookie） | `-2014` | **账号 + 该接口**级限流，与插件实现无关 |
| 换第二个公众号 bookId | `-2014` | 不是单个号的问题 |

浏览器里同时能看到 `wr_fp`（指纹）这类插件没有的 cookie，但既然浏览器也 -2014，说明与它无关。

**触发原因**：上游默认 `delayListMs=1200`、`pages=1`，而主循环对**全部** 27 个公众号逐个拉列表 ——
每轮 27 次列表请求，另有封面图下载；按 `intervalMin=30` 算一天上千次，容易被判爬虫。
这类接口级限流的窗口按「天」计，30 分钟当然不够。

**已做的防护**：

1. `maxAccountsPerRun`（默认 5）：每轮只检查一部分公众号，用 `state.accountCursor` 轮转，
   27 个号也不会一次全拉。
2. 命中 `-2014` 立刻写 `state.listCooldownUntil`，冷却期内**不发任何列表请求**，直接提示剩余时间。
   退避时长 2h → 4h → 8h → 16h → 24h（封顶），一轮跑通后自动清零。
3. 默认 `delayListMs` 由 1200 抬到 2500，并对旧配置做一次性迁移。
4. 设置页显示冷却状态 + 「解除冷却」按钮（确认已恢复时手动放行）。

## 防风控保护（`rateSafeMode`，默认开启）

直接改 `data.json` 里的数值**没用**：Obsidian 里插件是活的，会在任意一次 `saveAll()`
（改设置、标记已读、跑完一轮）时用内存里的 `settings` 回写磁盘，把外部修改覆盖掉。
实测就撞到过这种情况——手改的 `maxAccountsPerRun` 下一秒就消失。

所以保护做成**加载时收敛**：每次 `loadAll()` 都把速率参数压到安全档，代码里恒定生效。

| 参数 | 安全下限/上限 | 说明 |
|---|---|---|
| `maxAccountsPerRun` | ≤ 3 | 每轮只查 3 个号，27 个号分 9 轮覆盖 |
| `delayListMs` | ≥ 6000ms | 列表请求间隔，压掉「1.2 秒连发 27 次」的突发特征 |
| `intervalMin` | ≥ 45 分钟 | 轮次间隔（用户设 120 也不会被压低，只托底） |
| `delayContentMs` | ≥ 4500ms | 正文抓取间隔 |

请求量对比（27 个号、每号 1 页）：

```
改前：27 次/轮 × 48 轮/天 = 1296 次/天，且是 1.2 秒间隔的连续突发
改后： 3 次/轮 × 32 轮/天 =   96 次/天，间隔 6 秒
```

设置页有开关（默认开）和一行实时估算，直接显示「每轮 N 次 × 每天 M 轮 ≈ X 次/天」
以及「覆盖一遍全部公众号需要几小时」。想自己调就关掉开关，但会回到容易撞 `-2014` 的状态。

## 安装注意

本地安装后 `.obsidian/community-plugins.json` 曾被库里的 obsidian-git
`autoPullOnBoot` 还原（该文件被 git 跟踪），表现为「插件突然消失」。
安装后需要让改动进入一次提交，或临时关闭该选项。

## Windows 适配（4.4.5-fork）

上游代码里有多处 macOS 假设，已逐项改为按平台判断：

| 位置 | 原实现（macOS） | 现实现 |
|---|---|---|
| User-Agent | 写死 `Macintosh; Intel Mac OS X` | `platformName()` 判断：win32 用 Windows Chrome UA，其余用 macOS UA |
| 本地 Agent PATH | 只补 `/opt/homebrew/bin`、`/usr/local/bin` | Windows 补 `%APPDATA%\npm`、`%LOCALAPPDATA%\Programs`、`WindowsApps`、`%ProgramFiles%\nodejs`、`System32`，分隔符用 `;` |
| 启动 CLI | `spawn(cmd, args)` | Windows 加 `shell: true`（`claude`/`codex` 是 `.cmd`，否则 ENOENT） |
| 占位提示 | `/usr/local/bin/my-agent` | Windows 显示 `C://Users//…//npm//my-agent.cmd` |

### Chrome 登录兜底（Windows 推荐）

扫码接口在部分账号上仍会被判 `-2013`，因此新增一条不依赖 `/api/login/wxCode` 的路径：

1. 插件自动定位 Chrome / Edge（Windows 下查 Program Files、Program Files (x86)、LOCALAPPDATA；macOS 查 /Applications）
2. 用独立 profile 拉起：`--remote-debugging-port=<随机端口> --user-data-dir=<插件目录>/.chrome-login`
3. 你在窗口里正常登录（扫码），插件每 2.5s 通过 CDP `Network.getAllCookies` 检查 `wr_*`
4. 四项齐全后自动导入、刷新资料与书架，并用 `Browser.close` 关闭窗口

入口：设置 → 高级 → 「用 Chrome 登录（Windows 推荐）」。

## 默认不自动归档（2026-10-19 起）

用户要求「不要自动归档」，插件默认**完全被动**：加载后不轮询、不抓取、不写任何笔记。

| 行为 | 触发条件 |
|---|---|
| 抓取一轮 | 只在手动操作时：命令面板「立即抓取一轮」、状态栏按钮、侧栏「抓取」 |
| 定时轮询 | 只有「自动盯采」被显式开启时（命令面板 / 侧栏按钮切换，或设置里「启动时自动盯采」） |
| 历史归档 | 只在手动打开「归档某个号的全部历史」后运行 |

实现要点：

- `DEFAULTS.autoStart = false`。
- `onload` 里做一次性迁移：`state.noAutoArchive` 未标记时，强制把 `autoStart` 置 `false` 并写盘，
  防止旧 `data.json` 或从备份恢复的配置让插件一启动就自己跑。迁移只做一次，
  之后你在设置页手动打开「启动时自动盯采」仍然生效（尊重显式选择）。
- `runOnce()` 的全部调用点已核查，只有 3 处：`fetch-now` 命令、状态栏按钮、`setInterval` 定时器。
  没有任何「登录成功后自动跑一轮」的隐式路径。

## 正文提取与「原文链接」（2026-10-19 17:0x 这轮）

线上反馈两件事：部分文章「正文提取失败」、侧栏链接仍然不可读。实测结论：

| 现象 | 根因 | 修法 |
|---|---|---|
| 约 1/3 文章抓出来是空 | 页面里有两个 `id="js_content"`，第一个是 `<div id="js_content" class="share_notice_wrp">`（分享提示壳子），旧实现只取第一个就结束 | `extractById` 遍历**全部**同名容器，跳过 share_notice/wx_tip 类装饰壳，取最长的那份 |
| 视频号/图片笔记整篇空 | 页面根本没有 `js_content`，正文只在 `content_noencode: '...\x0a...'` 里 | 新增 `extractNoencodeText()`：取最长一份、解 `\x0a`/`\uXXXX` 转义、去标签；`htmlToMarkdown` 在无 body 或结果为空时回退到它 |
| 670 条列表一条原文地址都没有 | 列表接口 `mpInfo` 里只有 `originalId`（内部 ID），**没有 URL**；og:url 只能从正文 HTML 抠 | 新增 `plugin.resolveMpUrl(reviewId)`：按需抓一次正文只取 og:url，不写笔记，结果缓存进 `state.mpUrls`；侧栏「原文」标签打开即自动取，**直接显示 URL 本身**（v4.4.7 去掉了「点按钮取链接」那一步） |

抽样验证（15 篇、跨 8 个号）：修复前 3/9 为空，修复后 14/15 有正文，15/15 都能拿到 `mp.weixin.qq.com` 原文链接。

另外确认：`mp.weixin.qq.com` 链接在**非微信浏览器**里会显示「环境异常，完成验证后即可继续访问」，
这是微信侧的策略，不是链接坏了；在微信里（手机或 PC 客户端）正常打开。

## 归档耗时优化（v4.4.8）

用户反馈「提取很慢」。实测单篇 `抓取并归档`，瓶颈根本不在网络：

| 阶段 | 耗时（Hypit 实测，3.5MB 正文 / 8 张图） |
|---|---|
| 下载正文 HTML | ~1040ms |
| HTML → Markdown | ~26ms |
| 8 张图（修复前：串行 + 每张 sleep 2250ms） | 8 × (58ms + 2250ms) ≈ **18.5s** |
| 8 张图（修复后：并发 5，无 sleep） | **178ms** |
| 合计 | 19.5s → **1.24s** |

三处改动：

1. **删掉图片循环里的 `sleep(delayContentMs / 2)`**。这个延迟原本是给「公众号列表接口」防 `-2014` 的，
   图片走 `mmbiz.qpic.cn` CDN，根本不是同一条限流通道，白等 18 秒。
2. **图片并发下载（5 路）**，`mapLimit()` 控制并发；音视频那段的 `sleep` 也从 4500ms 降到 200ms。
3. **正文 HTML 只解析一次**（原来 `htmlToMarkdown(html)` 连写两遍，3.5MB 白解析一次），
   并加 `contentCache`（最近 3 篇，约 10MB 内存）：归档完马上点「原文」不会再下一次同样 3.5MB。

`delayContentMs` 现在只作用于**文章之间**（列表接口的节奏），不再拖慢单篇归档。
