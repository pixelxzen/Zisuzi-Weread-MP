# 微信读书接口错误码分诊（-2010 / -2012 / -2041）

三个错误码长得像，处置完全不同。**先用探针分诊再动手**，不要一上来就重扫码。

## 三个探针（纯 HTTP，不需要浏览器）

全部带完整的 6 项 cookie + 桌面 UA（`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) …Chrome/131…`）+ `Referer: https://weread.qq.com/`。

```bash
# ① 会话是否活着：能读到昵称就说明登录态在（必须带桌面 UA，否则恒 -2012）
curl -s "https://weread.qq.com/web/user?userVid=$WR_VID" -H "Cookie: $CK" -H "User-Agent: $UA"

# ② 能不能派生官方 Key（HTTP 200 + wrk-… 说明会话可用）
curl -s https://weread.qq.com/api/skills/apikeyGet -H "Cookie: $CK" \
  -H 'Referer: https://weread.qq.com/' -H "User-Agent: $UA"

# ③ 公众号列表接口（真正要看的那条）
curl -s "https://weread.qq.com/web/mp/articles?bookId=mpbook&offset=0" \
  -H "Cookie: $CK" -H "Referer: https://weread.qq.com/" -H "User-Agent: $UA"
```

## 先解字段名：`errCode` 与 `errcode` 两种写法都存在

同一个服务，不同接口回来的键名大小写不一致（实测见过 `{"errCode":-2012,"errMsg":"登录超时"}` 和 `{"errcode":-2010}` 两种）。只读一种 → 风控码被当成「空列表」静默吞掉，表现为界面一直转圈、日志里什么都没有。

```ts
const code = json?.errcode ?? json?.errCode;
const msg  = json?.errmsg ?? json?.errMsg ?? '';
if (typeof code === 'number' && code !== 0) throw new RiskError(code, msg);
```

**排查「接口返回空」时，第一件事是把原始响应体整个打出来**，不要只看解析后的数组长度。

## 判据表

| ① /web/user | ② apikeyGet | ③ mp/articles | 判定 | 处置 |
|---|---|---|---|---|
| `-2010 用户不存在` | 失败 | `-2010` | cookie 全丢了 / 没带 | 重新扫码 |
| 有昵称 | 有 `wrk-` | `-2012` | 会话在，列表接口要求刷新 | 查是否缺 `wr_gid`；6 项齐时是 cookie 被轮换，从 profile 重取 |
| 有昵称 | 有 `wrk-` | **`-2041`** | **登录态有效，但公众号接口对该账号受限** | 见下，**不要在 cookie / header 上排障** |
| 有昵称 | 有 `wrk-` | 200 + `subReviews` | 正常 | — |

## 第四轴：官方 `wrk-` Key 能通、页面接口不通 = 账号没问题

这是最容易被忽略的一根轴。`wrk-` Key 与页面 cookie 是**两条独立凭证**（见 SKILL.md「双凭证模型」），所以：

| wrk- Key 调 `/shelf/sync` | 页面接口 | 结论 |
|---|---|---|
| 200 + 书架完整 | `-2012` / `-2041` | 账号本身好的，问题在**页面 cookie 或接口策略**；同时能自证 bookId 真的在书架里 |
| 401 / 失败 | 任意 | Key 失效，先重换 Key（`apikeyGet`） |

判 `-2041` 前**务必先用 Key 查一次这个 `bookId` 在不在书架**：`-2041` 的官方语义含「内容不存在 / 不在书架」，若 bookId 已被移除，那 `-2041` 与账号限制无关，重加书架就好。

```bash
curl -s -X POST https://i.weread.qq.com/api/agent/gateway \
  -H "Authorization: Bearer $WEREAD_API_KEY" -H 'Content-Type: application/json' \
  -d '{"api_name":"/shelf/sync","skill_version":"1.0.4"}' \
| python3 -c "import sys,json;bs=json.load(sys.stdin)['books'];print(len(bs));print([b['title'] for b in bs if b['bookId']=='MP_WXS_xxx'])"
```

## -2041 的决定性验证（脚本化，可复跑）

不要靠人工看 DevTools 抓包（不可复现、不能贴进复盘）。用真实 profile 在**页面上下文**里发同源请求——自动带全部真实 cookie 与真实请求头，是最干净的责任切分：

```bash
node - <<'JS'
const { chromium } = require(process.env.HOME + '/node_modules/playwright-core');
const ctx = await chromium.launchPersistentContext(process.env.HOME + '/.weread-monitor/chrome-profile',
  { headless: true, channel: 'chrome' });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://weread.qq.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);   // 等页面 JS 写入 wr_gid
const r = await page.evaluate(async (u) => {
  const res = await fetch(u, { credentials: 'include' });
  const t = await res.text();
  return { status: res.status, body: t.slice(0, 260), len: t.length };
}, '/web/mp/articles?bookId=MP_WXS_xxx&offset=0');
console.log(r);
await ctx.close();
JS
```

结果解读：

- **页面内也 `-2041`** → 账号/平台侧限制，与客户端无关。官方页面自己发的同一个请求同样 `-2041`、而 `/web/mp/cover` 200，可作二次印证。只有拿到这个证据，才有资格跟用户说「不是我们这边的问题」。
- **页面内 200、插件/脚本 失败** → 是我们的请求头或 cookie 组合问题，不是账号。去查 header 差异与 cookie 混入。
- 两边都成功、只有某个客户端失败 → 那个客户端的 HTTP 层或 session 问题。

## 已验无效的排障方向（别重复烧时间）

- 换 bookId，包括 `mpbook`（文章收藏）：一律 `-2041`
- 加 `synckey` / `count` / `maxIdx` 参数：一律 `-2041`
- 换移动端 UA、加 `Origin` / `x-wr-vid`：一律 `-2041`
- 不带 cookie 会变成 `-2010` —— 可以拿它自证「码不同 = 语义不同」，别把 -2041 当 -2012 处理
- 换不同的 HTTP 客户端（node fetch / 浏览器内 fetch）：结果一致

## 恢复路径（按可能性从高到低）

1. 手机微信读书 App 里打开任意公众号、读几篇再退出（客户端侧激活），隔 10–30 分钟再试
2. 等数小时冷却（风控类限制常见按天恢复）
3. 换账号登录（同一 profile 重新扫码到另一个号）
4. 判 IP：同账号在手机蜂窝网络能看文章、本机（当前网络）不能 → 是 IP 侧限制，换网络/代理再试

## 客户端侧的产品要求

- **错误文案必须把 `-2012` 和 `-2041` 分开**。都写成「登录失效」会让用户白扫码，也会把后续排错方向整个带偏。
- 自检命令要能一条命令吐出「账号昵称 + 列表接口码 + 处置建议」，把判断交给程序而不是让用户描述现象。
- 超时（请求根本没回，`status === 0`）要和上面三个服务端错误码区分开：那是网络/通道问题，写成错误码会误导到登录态上去。
