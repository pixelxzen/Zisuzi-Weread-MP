# 0.4.0 开发复盘：所有坑与解法

日期：2026-10-17｜项目：obsidian-weread-mp（WeRead MP Catcher）｜许可：GPL-3.0-only © 2026 Creative by 紫苏子ACG

一句话结论：**这个插件的技术难点不在"抓文章"，而在"登录态的生命周期管理"——cookie 会自己失效、会被自己写坏、会被宿主环境吃掉。**

---

## 一、认证与登录态（最容易踩，且最容易踩第二次）

### 1. 纯 HTTP 调用稳定 `-2012`，只因 cookie 缺一项
- **现象**：浏览器页面内 fetch `/web/mp/articles` 返回 200 / 20 条；同样 cookie 用纯 HTTP（fetch/curl/requestUrl）请求却返回 `-2012`。
- **根因**：cookie 不完整。Playwright 的 `ctx.cookies()` 在页面 not 完全加载时拿不到 `wr_gid`（它由页面 JS 后写入，非 HttpOnly）。
- **解法**：`ctx.cookies()` 与 `page.evaluate(() => document.cookie)` **合并**后再用。补齐 6 项（wr_fp / wr_vid / wr_ql / wr_rt / wr_skey / wr_gid）即 200。
- **固化**：`scripts/refresh-cookie.cjs`（合并两侧）+ `checkCookie()` 四要素校验（缺 wr_gid 直接报错而不是盲发请求）。

### 2. 插件把好 cookie 写成坏 cookie（自伤）
- **现象**：主库 `data.json` 的 cookie 从 113 字节变成 64 字节，只剩 `wr_fp / wr_localvid / wr_name / wr_avatar / wr_gender` 五个值（后四个为空），抓取从此拿空列表。
- **根因**：`importSessionCookie()` 从 Obsidian 自己的 Electron session 读 cookie，而该 session 里 weread 只是"访问过但没登录"的空态；读到即写盘，覆盖了好的登录态。
- **解法**：两道闸——① `importSessionCookie` 先 `checkCookie` 校验，不完整直接拒绝；② `saveAll()` 永不把不完整 cookie 写盘（若内存不完整而磁盘完整，则保留磁盘值）。
- **教训**：**"能读到"不等于"可写入"。凭据类字段写入前必须校验完整性。**

### 3. cookie 会自己失效，而且失效得很安静
- **现象**：同一份 cookie 上午能用，高频调用若干次后，`articles` 与 `/web/user` 同时返回 `-2012 登录超时`。
- **根因**：微信读书会轮换 `wr_skey`（浏览器 profile 里已刷新，我们缓存的是旧值）；叠加短时间高频请求。
- **解法**：a) 重新从登录 profile 取即可恢复；b) 产品层面把 API Key 作为长期凭证（书架/统计），cookie 只承担"抓正文"；c) 界面只留"扫码登录"，不要求用户理解 cookie。
- **固化**：`loginState()` 三态（none/cookie/full）+ 风控熔断（`RiskError` → 停跑不重试）。

### 4. 官方 API Key 能换，但权限有限
- **事实**：`GET /api/skills/apikeyGet`（带 cookie）直接返回 `wrk-…` 长期 Key。
- **边界**：Agent API 18 个接口里**没有公众号正文**；`/store/search` 试过 `scope=0/2/4/2+count/type=2` **全部搜不到公众号**（MP_WXS 命中 0）。
- **结论**：Key 用于书架（568 个号）、统计、书架同步；正文必须 cookie。加新号只能在微信读书 App 加书架，再「同步书架」。

### 5. `/web/user` 不带 UA 就只返回错误体
- **现象**：`/web/user?userVid=` 返回 `{"errCode":-2012,...}`；带上 UA 才有昵称/头像。
- **解法**：所有 weread 请求统一走 `baseHeaders()`（含 UA + Referer + Accept）。

---

## 二、宿主环境（Obsidian / Electron / launchd）

### 6. launchd 不继承 shell 环境变量
- **现象**：手动跑正常，`launchctl kickstart` 后 `exit=2 / 没有可用的 bookId`。
- **根因**：`WEREAD_API_KEY` 只存在于交互 shell。
- **解法**：config 的账号改写成 `{"name":..,"bookId":..}` 对象 → 完全不需要环境变量；plist 里也不塞密钥。

### 7. plist 的 PATH 找不到 node
- **现象**：exit 127。
- **根因**：本机 node 在 `~/.local/bin`，不在 `/opt/homebrew/bin`。
- **解法**：plist 的 `EnvironmentVariables.PATH` 显式列出 node 的真实目录。

### 8. Electron `remote` 存在，但读到的 session 未必有登录态
- 能用来截图（`remote.getCurrentWindow()`），也能读 cookie，但读到的是 Obsidian 自己的 session。
- 扫码登录的正确做法：`window.open('https://weread.qq.com/')` + 轮询 session cookie 直到出现完整 6 项。

### 9. 切库必须重启 Obsidian
- 改 `obsidian.json` 的 `open` 标记后，运行中的 Obsidian 不会重新读 → 必须 quit + open。每次验收代价 2 次重启（切去 QA、切回主库）。

---

## 三、工程与工具链

### 10. `"type": "module"` 让 .js 脚本里的 `require` 直接崩
- **解法**：一次性脚本用 `.cjs` 扩展名。

### 11. `write_file` 被"分页读保护"挡住
- **现象**：`Refusing to overwrite ... was last read with offset/limit pagination`。
- **解法**：改用 `patch` 做分段精确修改（也更好审）。

### 12. 同一文件多处 patch 不要并行发
- 会读到中间态。分轮、顺序执行。

### 13. host_eval 的 `--vault` 要"库名"不是路径
- 传路径报 `Vault not found`。库名从 `obsidian vaults` 里取（本例 `qa-vault`）。

### 14. host_eval 的 CLI 会周期性"半死"
- 报 `Your Obsidian installer is out of date`（假阳性），实测连续 4–6 次失败。
- **解法**：先 ping（`return 1`）再执行真操作；仍失败就改用**文件证据**（读 data.json / 读笔记），不要死磕 CLI。

### 15. 设置页的 DOM 验收不可靠
- `app.setting.openTabById()` 常被 CLI 抖动吞掉。
- **解法**：设置页交给人工看；自动化只验"数据写入正确"（data.json 的 shelfAccounts / loginProfile / accounts）。

---

## 四、抓取与风控

### 16. 微信 CDN 把 PNG 挂在 .jpg 名下
- 按**魔数**判扩展名（脚本已处理），否则存下来的图打不开。

### 17. 纯视频/图片型推送没有 `#js_content`
- `video=true && hasJs=false` → 预期跳过（fail-closed），**不要重试、不要改选择器**。

### 18. 高频请求会招来 -2012
- 风控纪律（来自 weread-mp-monitor skill）：列表 1.2s / 正文 2.5s / 每 15 篇休 60s；极保守 3s/6s/每 10 篇 120s；单批 ≤30；命中即停不重试。
- 已固化进 `runBackfill` 的两档速度 + `RiskError` 熔断。

### 19. 本机代理会让 python urllib 偶发 SSL EOF
- 现象：`SSLEOFError: UNEXPECTED_EOF_WHILE_READING`，而 curl 与 Chrome 正常（代理 `127.0.0.1:7897`）。
- **解法**：诊断优先用 curl / node(playwright)；python 只做重试版探测，别把它当唯一真相。

---

## 五、数据安全

### 20. 含 cookie 的目录绝不能进 git / zip
- `qa-vault/` 内 `data.json` 含完整登录态。
- **做法**：`.gitignore` 排除 `qa-vault/`、`node_modules/`、`dist/`；打包后**用真实 cookie 值 grep zip**，命中必须为 0（本次实测 0；字段名命中不算泄漏）。

---

## 六、仍未完成 / 已知边界（写清楚，免得下次误判为 bug）

| 项 | 状态 | 说明 |
|---|---|---|
| 卡片网格列表（对齐 obsidian-weread-plugin 书架页） | 未做 | 当前是双栏密列表 |
| 详情页 4 Tab（正文/摘要/原文…） | 未做 | 当前是右侧单栏渲染 |
| 主题系统（内置主题 + 自定义 + 导入导出） | 未做 | 用户明确要求对齐基座 |
| 阅读统计视图（热力图/偏好） | 未做 | 官方 `/readdata/detail` 已接通，只差渲染 |
| 官方 API 搜公众号 | 做不到 | scope 全组合实测 0 命中 |
| 正文走 API Key | 做不到 | 18 个接口无公众号正文 |
| 移动端 | 不支持 | `isDesktopOnly: true`（扫码依赖 Electron） |

## 七、下个版本必须先看的三条

1. **任何写入凭据的路径都要先校验完整性**（坑 1、2）。
2. **cookie 是消耗品**，产品交互必须假设它会随时失效（坑 3）。
3. **CLI 不可靠时不要改代码去迎合它**，换文件证据（坑 14、15）。
