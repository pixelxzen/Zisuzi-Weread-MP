# 4.4.4 复盘：cookie 校验只看「键在不在」，不看「值有没有」

## 现象

用户侧的登录态看起来完好，实际抓取必然报 `-2012`：

- 设置页/信息卡显示「已登录」，cookie 项数 10 项、`wr_vid=5617686` 正常；
- 「诊断登录态」写出的 `诊断.txt` 里 `checkCookie: {"ok":true,"missing":[]}`，同一份文件的下一条却是
  `/web/mp/articles` → `{"errCode":-2012,"errMsg":"登录超时"}`；
- 一键同步/盯采第一轮就失败，用户被推向「反复扫码」，而扫码又不解决。

实测到的坏 cookie 形态（从没真正登录成功过的会话读出来的就是这种）：

```
wr_fp=xxx; wr_localvid=; wr_name=; wr_avatar=; wr_gender=;
wr_vid=5617686; wr_ql=1; wr_rt=…; wr_skey=…; wr_gid=…
```

四项必需字段（`wr_vid / wr_skey / wr_rt / wr_gid`）**键都在**，其中若干值长度为 0。

## 根因

`src/core/weread.ts` 的 `checkCookie()` 只把 cookie 字符串切成 `name` 集合，然后判必需字段是否**存在**：

```ts
const have = new Set(norm.split(';').map((s) => s.split('=')[0].trim()));
const missing = need.filter((n) => !have.has(n));
```

于是「键齐、值空」被判成 `ok: true`。这一个判断被下游四层放大：

1. `hasLogin()` → 视图认为已登录，空态不出现，直接进抓取；
2. `saveAll()` 的「坏 cookie 不覆盖好 cookie」防护失效（它判的也是 `checkCookie(...).ok`）；
3. `loginState()` 返回 `full`，信息卡显示正常；
4. `probeAccess()` 的 `cookieOk` 为真，导致报告里「格式没问题」和「接口 -2012」自相矛盾。

## 解法

**判断升级为「格式 + 接口」双判，且格式判据同时看键与值。**

1. `checkCookie()` 返回值扩展为 `{ ok, missing, empty }`：
   - `missing`：必需字段整个缺失（原有语义）；
   - `empty`：字段存在但值为空（新增）；
   - `ok = missing.length === 0 && empty.length === 0`；
   - 切分改用 `indexOf('=')` 只切第一个等号，避免值里带 `=`（如 `wr_skey=abc==`）被误判。
2. 新增 `describeCookieCheck()`：把结论翻成人话（`缺 wr_gid` / `wr_skey 的值为空`）。
3. `probeAccess()` 的 hint 区分两种不完整，值为空时直接建议重新扫码。
4. 新增 `Plugin.verifyCookieLive(notify)`：保存 cookie 后**立刻用真实列表接口**验一次，把结果写进
   `webLoginOk / webLoginAt / webLoginMsg`，并在用户主动操作时用 Notice 汇报。挂在四个入口：
   - 设置页粘贴 cookie 保存后（`notify = true`）；
   - 「读取登录态」（`importSessionCookie`）成功后（`notify = true`）；
   - 扫码窗口轮询到成熟 cookie 后（`notify = false`，不打断扫码流程）；
   - `importCookieFromChrome()` 保持原有 `checkWebLogin()` 路径（已是接口级验证）。
5. `saveAll()` 的防护无需改代码——`checkCookie` 收紧后，「坏 cookie 不覆盖好 cookie」自动生效。

## 固化位置

| 位置 | 内容 |
|---|---|
| `src/core/weread.ts` | `CookieCheck` 接口、`checkCookie()` 值校验、`describeCookieCheck()`、`probeAccess()` hint |
| `src/main.ts` | `verifyCookieLive()` 方法 + 4 个调用点 |
| `tests/core.test.mjs` | 3 条回归用例：全空值、缺值/缺键区分、值含 `=` |

## 仍未完成 / 已知边界

- `verifyCookieLive()` 会多打 2 个请求（`/web/user` + `/web/mp/articles`）。只在「保存 cookie / 扫码完成」时触发，
  不在每轮盯采里跑，对风控没有实质影响；但如果用户频繁改 cookie 字段，仍会多几次请求。
- 探针只验**列表接口**，不验正文接口：`-2041`（账号级限流）会在列表阶段就被识别，正文层不会给出更细信息。
- 「值为空」只对四个必需字段判定。`wr_localvid / wr_name / wr_avatar / wr_gender` 为空是**正常**形态
  （未授权公开资料），不要因为它们报不完整。
- 已发布版本的坏 cookie 不会被自动修复：升级后仍需用户重新扫码一次，插件只会把「为什么必须重扫」说清楚。
