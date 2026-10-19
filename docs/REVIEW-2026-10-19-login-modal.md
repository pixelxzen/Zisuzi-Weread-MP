# 2026-10-19 扫码登录弹窗两个故障复盘

## 现象

1. **「弹窗刚点就自己消失」**（作者本人复现）：点「扫码登录」，窗口一闪即关，来不及扫码，等于无法重新登录。
2. **「小窗白色、页面点不动、找不到二维码」**（Mac mini 用户，卸载重装 + 大退重启仍复现）：窗口开着，但里面既没有二维码，也无法点击任何按钮、无法滚动。

## 根因

### 1. 秒关 = 成功判据太松

`startIframeLogin()` 的 `finish()` 只看 `document.cookie` 里**存在** `wr_skey` 与 `wr_vid`：

```ts
if (/wr_skey=/.test(str) && /wr_vid=/.test(str)) { … ok = true }
```

登录态过期后，这两个键**依然存在**（只是服务端不认）。而 `dom-ready` 一触发就会调 `finish()`，
于是「旧 cookie 还在」被当成「刚刚扫码成功」→ 立即 `modal.close()`。
用户看到的就是「弹窗刚点就消失」，且每次重开都一样，永远扫不到码。

### 2. 白框 / 点不动 = 先设 src，后挂载

原实现顺序：

```ts
wv = createWebviewElement();
wv.setAttribute('src', 'https://weread.qq.com/');   // ← 此时 webview 还没进文档
box.appendChild(wv);
…
modal.open();                                        // ← 之后才挂进 DOM
```

`webview` 在**游离（未挂载）状态**下被设 `src`，随后随 modal 一起被重新挂载。
部分 Electron / Obsidian 版本组合下 guest 进程不会加载 —— 表现为白色圆角框、
无滚动、点哪都没反应（因为里面根本没有页面）。这与「卸载重装无效」一致：不是数据问题。

## 解法（本次改动）

- **打开时给 cookie 拍快照**：只有「cookie 相对打开时变了」或「旧 cookie 经 `verifyCookieLive()`
  真实接口验证仍然有效」才收工。旧 cookie 已过期时，窗口留在原地并提示「请在下方扫码刷新」。
- **收工必须过真实接口**：`checkCookie()` 只证明格式完整，`verifyCookieLive()` 才证明服务端认。
  探针有 12 秒节流，手动点按钮时绕过节流。
- **顺序修正**：先 `modal.open()` → 下一帧把 webview 挂进已挂载的 `frameHost` → 再设 `src`。
- **看门狗与手动出路**：15 秒无 `dom-ready`、或 `did-fail-load`，显示诊断行 +
  「重新加载窗口」「在浏览器里打开」两个按钮；后者配合设置里的「粘贴 Cookie」可完全绕过 webview。
- **单例 + 关窗清轮询**：`loginModal` 保证不叠窗；`modal.onClose` 里停轮询，避免用户手动关窗后
  6 分钟又被自动关闭并弹「等待扫码超时」。

## 固化位置

- `src/main.ts` → `startIframeLogin()`
- `styles.css` → `.wmc-login-modal / .wmc-login-frame-host / .wmc-login-actions / .wmc-login-link / .wmc-login-diag`

## 已知边界

- 若宿主环境**根本没有 webviewTag**，「在浏览器里打开 + 粘贴 Cookie」是唯一的可用路径（已在弹窗里显式给出）。
- 内嵌窗口里扫码仍受微信读书既有风控，与本次改动无关。
- 本次未改抓取 / 解析 / 存储链路。

## 补记（同日 22:40 真机复测）：二维码能弹了，但登录态仍然进不来

现象：弹窗里完成登录、点「我已经扫码了，立即同步」，状态行仍是「还缺 wr_vid、wr_skey、wr_rt」。

根因（不是检测慢，是通道取不到）：

```bash
/usr/bin/sqlite3 -readonly ~/Library/Application\ Support/obsidian/Cookies \
  "SELECT name, is_httponly, length(value) FROM cookies WHERE host_key='.weread.qq.com';"
# wr_vid    http_only=1  value_len=7
# wr_skey   http_only=1  value_len=8
# wr_rt     http_only=1  value_len=28
# wr_gid    不在库里（页面 JS 写入，非 HttpOnly）
```

`wr_vid` / `wr_skey` / `wr_rt` 是 **HttpOnly**，`document.cookie` 永远看不到——所以原实现
（只靠 `executeJavaScript('document.cookie')`）从根上不可能拿到完整登录态。这也解释了为什么
文档里「扫码后自动写入」在某些机器上从来没真正成功过，只是有人手贴过 cookie 才看起来能跑。

解法：`readCookiesFromStore()` —— 复制 `Cookies`（连同 `-wal`）到临时文件，用
`/usr/bin/sqlite3 -readonly` 查 weread 域的登录字段（Obsidian 该库 `value` 列是**明文**，
不需要解密），查完删临时副本；再与 `document.cookie` 按 key 合并（页面里的 `wr_gid` 补进来），
四字段齐全才走 `verifyCookieLive()`。实测查询 5ms。

边界：Windows 上该库若为 DPAPI 加密且无 sqlite3 CLI，读不到 → 退回「手动粘贴 Cookie」。
