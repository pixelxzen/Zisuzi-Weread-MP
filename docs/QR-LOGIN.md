# 改造说明：登录、风控、正文、链接、性能

本 fork 在上游 4.4.4 基础上做的全部改动。每个结论都是实测得出，不是推测。

## 1. 上游扫码登录为什么用不了

两条旧路径都依赖新版 Obsidian（Electron 22+）已移除的能力：

| 旧实现 | 失效原因 |
|---|---|
| `openLoginWindow()` + `electron.remote.session.defaultSession.cookies` | `remote` 模块已移除，取到 `undefined`，轮询 90 秒必超时 |
| `startIframeLogin()` + `<webview>.executeJavaScript('document.cookie')` | Obsidian 默认关闭 `webviewTag`；退回跨域 `<iframe>` 又被同源策略拦住 |

即：登录协议本身没问题，是**客户端取 cookie 的方式**已经不成立。

## 2. 现在的实现：uid 长轮询扫码

`src/core/qrlogin.ts`（协议，可单测）+ `src/host/qr-login-modal.ts`（弹窗）。

| 步骤 | 接口 | 说明 |
|---|---|---|
| 1 | `GET /api/auth/getLoginUid` | 取一次性 `uid` |
| 2 | 本地生成二维码 | 内容 `https://weread.qq.com/web/confirm?pf=2&uid=<uid>`，`qrcode-generator` 出 data URL |
| 3 | `GET /api/auth/getLoginInfo?uid=&otp=` | 长轮询：`logicCode 0` 等待、`1` 已确认；`succeed:true` 返回 `vid`/`accessToken`/`refreshToken` |
| 4 | 组装 cookie | `wr_vid` + `wr_skey`(accessToken) + `wr_rt`(refreshToken)，再补 `wr_gid` |

三条必须遵守的细节：

1. **cookie 只能用 Node `https` 取**，不能用 `requestUrl`——后者丢弃 `Set-Cookie`。esbuild 的 `external: builtinModules` 保证不被打包。
2. **`LOGIN_TIMEOUT` 必须当 `waiting`**。服务端对未扫码的 uid hold 约 55 秒，然后返回 `{"succeed":false,"logicCode":"LOGIN_TIMEOUT","canRetry":false}`；同一 uid 可反复续查，`canRetry:false` 不代表作废。只有 `logicCode` 含 `EXPIRE` 才是真过期。
3. **二维码必须带 `pf`**。官方 `app.js` 的真实拼法是 `?pf=<1|2>&uid=`，`pf = 客户端是 iOS ? 1 : 2`，桌面固定 `2`。缺这个参数扫码不生效。

### wr_gid 只由首页下发

真实扫码成功后弹窗曾报「登录信息不完整：缺 wr_gid」。实测各接口的 `Set-Cookie`：

| 请求 | Set-Cookie |
|---|---|
| `GET https://weread.qq.com/` | `wr_gid=…`（一次两条，后者覆盖） |
| `/web/user`、`/web/shelf/sync`、`/api/auth/getLoginUid` | 无 |

所以 `warmUpSession()` 必须**先打首页**（`wr_gid` 是设备级游客标识，匿名请求也会下发），再带全 cookie 打 `/web/user`、`/web/shelf/sync`。只补后两个永远补不上。

## 3. 风控：`-2014` 的真实定位

现象：登录态正常，`/web/mp/articles` 持续 `-2014 请求频率过高`，等 30 分钟不恢复。

| 检查项 | 结果 | 结论 |
|---|---|---|
| `/web/shelf/sync` | `code=0` | cookie 有效 |
| `/web/mp/articles`（匿名） | `-2010 用户不存在` | IP 未被限 |
| `/web/mp/articles`（登录 + 完整浏览器头 + SSR id） | `-2014` | 不是请求头/指纹问题 |
| **真实 Chrome 内 fetch（同一 cookie）** | `-2014` | **账号 + 该接口**级限流，与插件实现无关 |
| 换第二个公众号 bookId | `-2014` | 不是单个号的问题 |

触发原因：上游 `delayListMs=1200`、`pages=1`，主循环对全部 27 个公众号逐个拉列表 → 每轮 27 次，按 `intervalMin=30` 算一天上千次。这类接口级限流按「天」计窗口，等 30 分钟当然不够。

### 防护：`rateSafeMode`（默认开启）

直接改 `data.json` 无效——插件在 Obsidian 里是活的，任意一次 `saveAll()`（改设置、标记已读、跑完一轮）会用内存里的 `settings` 回写磁盘，覆盖外部修改。所以保护做成**加载时收敛**：

| 参数 | 强制值 | 作用 |
|---|---|---|
| `maxAccountsPerRun` | ≤ 3 | 每轮只查 3 个号，用 `state.accountCursor` 轮转覆盖 |
| `delayListMs` | ≥ 6000 | 列表请求间隔，压掉「1.2 秒连发 27 次」的突发特征 |
| `intervalMin` | ≥ 45 | 轮次间隔（设更大不拦，只托底） |
| `delayContentMs` | ≥ 4500 | 文章之间的抓取间隔 |

请求量：`27×48 = 1296 次/天（1.2s 突发）` → `3×32 = 96 次/天（6s 间隔）`。

另外：命中 `-2014` 立即写 `state.listCooldownUntil`，冷却期内不发任何列表请求，退避 2h→4h→8h→16h→24h（封顶），跑通一轮自动清零；设置页显示剩余时间并有「解除冷却」。

风控码整体处理（命中即抛 `RiskError` 并停止本轮，不重试）：

| 码 | 含义 | 处置 |
|---|---|---|
| -2010 | 未登录 | 重新扫码 |
| -2012 | 登录态过期 | 重新扫码 |
| -2014 | 请求频率过高 | 停 5~15 分钟、调大间隔 |
| -2041 | 该账号被公众号接口限制 | 手机 App 打开一次该公众号，或换号/等冷却 |

## 4. 正文提取：三类空结果

| 现象 | 根因 | 修法 |
|---|---|---|
| 约 1/3 文章抓出来是空 | 页面里有**两个** `id="js_content"`，第一个是 `<div id="js_content" class="share_notice_wrp">`（分享提示空壳），旧实现取第一个就收工 | `extractById` 遍历所有同名容器，跳过 `share_notice`/`wx_tip` 装饰壳，取最长的那份 |
| 视频号/图片笔记整篇空 | 页面没有 `js_content`，正文只在 `content_noencode: '…\x0a…'` 里 | `extractNoencodeText()`：取最长一份、解 `\x0a`/`\uXXXX` 转义、去标签；`htmlToMarkdown` 在无 body 或结果为空时回退 |
| 图片类文章被直接判 `empty` | `archiveSingle` 丢了 `picUrl`/`digest` | 保留 `picUrl` 与 `digest`，生成带原文链接的笔记而不是空文件 |

## 5. 原文链接

- 列表接口 `mpInfo` 里只有 `originalId`（公众号内部 ID），**没有任何 URL** —— 所以 670 条列表默认一条原文地址都没有。
- 真正的原文地址在正文 HTML 的 `og:url`（`mp.weixin.qq.com/s?…`）。`extractMpOriginalUrl()` 优先取它，并拒绝 `${window.biz}` 这类 JS 模板假链接。
- `plugin.resolveMpUrl(reviewId)`：按需抓一次正文只取 og:url，**不归档、不写笔记**，结果进 `state.mpUrls`；同一 reviewId 有请求合并，命中 `contentCache` 不再下载。侧栏「原文」标签打开即自动取并**直接显示 URL 本身**，已归档笔记则回退读 frontmatter 的 `mp_url`。
- `weread.qq.com/web/mp/{reviewId}` 是 404、`/web/mp/content?reviewId=` 返回 `text/plain` 源码、`/web/mp/reader/{reviewId}` 显示「加载失败」——微信读书没有给读者看的文章页，所以界面上不再用这些地址。

`mp.weixin.qq.com` 链接在**非微信浏览器**里会显示「环境异常，完成验证后即可继续访问」，这是微信侧策略，不是链接失效；在微信（手机或 PC 客户端）里正常打开。想在 Obsidian 里读全文，用「正文」标签。

## 6. 归档耗时：19.5s → 1.24s

实测单篇（3.5MB 正文 / 8 张图），瓶颈不在网络：

| 阶段 | 修复前 | 修复后 |
|---|---|---|
| 下载正文 HTML | ~1040ms | ~1040ms（命中 `contentCache` 则 0） |
| HTML → Markdown | 26ms × **2 次** | 26ms × 1 次 |
| 8 张图 | 8 × (58ms + **2250ms sleep**) ≈ 18.5s | 并发 5 路 **178ms** |
| 合计 | ≈ 19.5s | **≈ 1.24s** |

三处改动：删掉图片循环里的 `sleep(delayContentMs / 2)`（那个延迟是给列表接口防 `-2014` 的，图片走 `mmbiz.qpic.cn` CDN，不是同一条限流通道）；图片改 `mapLimit(images, 5)` 并发，音视频的 sleep 从 4500ms 降到 200ms；正文 HTML 只解析一次并加 `contentCache`（最近 3 篇）。`delayContentMs` 现在只作用于文章之间。

## 7. 默认不自动归档

插件默认完全被动：加载后不轮询、不抓取、不写任何笔记。`DEFAULTS.autoStart = false`；`onload` 里做一次性迁移——`state.noAutoArchive` 未标记时强制把 `autoStart` 置 `false` 并写盘，防止旧 `data.json` 或备份配置让插件一启动就自己跑；迁移只做一次，之后手动开启仍然生效。`runOnce()` 的调用点只有 3 处：命令「立即抓取一轮」、状态栏按钮、定时器。

## 8. Windows 适配

| 位置 | 原实现（macOS） | 现实现 |
|---|---|---|
| User-Agent | 写死 `Macintosh; Intel Mac OS X` | `platformName()` 判断，win32 用 Windows Chrome UA |
| Agent PATH | 只补 `/opt/homebrew/bin`、`/usr/local/bin` | 补 `%APPDATA%\npm`、`%LOCALAPPDATA%\Programs`、`WindowsApps`、`%ProgramFiles%\nodejs`、`System32`，分隔符 `;` |
| 启动 CLI | `spawn(cmd, args)` | Windows 加 `shell: true`（`claude`/`codex` 是 `.cmd`，否则 ENOENT） |

**Chrome 登录兜底**（设置 → 高级 →「用 Chrome 登录」）：自动定位 Chrome/Edge，用独立 profile `--remote-debugging-port=<随机> --user-data-dir=<插件目录>/.chrome-login` 拉起，你在窗口里正常扫码，插件每 2.5s 用 CDP `Network.getAllCookies` 检查 `wr_*`，四项齐全后导入并用 `Browser.close` 关窗。

## 9. 部署

```
cd repo
npm install
npm run build      # tsc 类型检查 + esbuild 打包 main.js
npm test
cp main.js manifest.json styles.css <库>/.obsidian/plugins/weread-mp-fork/
```

插件 id `weread-mp-fork`，可与上游 `zisuzi-weread-mp` 并存、设置互不影响。本机安装位置：`D:\obsidian\collections\.obsidian\plugins\weread-mp-fork\`。

注意：库里若装了 obsidian-git 且开了 `autoPullOnBoot`，`.obsidian/community-plugins.json` 会被还原，表现为「插件突然消失」。装完让改动进一次提交，或临时关掉该选项。

## 10. 已放弃：`/api/login/wxCode`

早期走微信 OAuth 扫码（`qrconnect` → `connect/qrcode/<uuid>` → `l/qrconnect`）再 `POST /api/login/wxCode` 换 cookie。二维码与轮询都正常，换登录态这一步**稳定 401 / -2013「鉴权失败」**。已排除：body 形态、令牌在 JSON body、`X-SSR-Request-Id` + `wr_gid` 的四组合、CDP 抓真实请求逐字段比对（`redirect_uri`、`state`、`self_redirect`）。四种组合全部 -2013，说明该接口对非官方客户端来源有额外校验，继续猜参没有意义。改走 `getLoginUid`/`getLoginInfo` 后链路回到「网页版确认登录」这一官方语义。

`qrlogin.ts` 里保留了 `parseLoginInfo` 对旧响应的兼容分支，便于将来复用。
