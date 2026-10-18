# Zisuzi-Weread-MP

**微信读书公众号盯采 · 在 Obsidian 里自动归档你书架里订阅的公众号文章（含图片、音视频）。**

> 公众号文章看不过来、也不该锁在微信里。一次扫码，之后新文章自动落进你的知识库。

- 数据直连你自己的微信读书账号，**不经任何第三方服务器中转**
- 不碰微信客户端，不破解任何服务
- 免费（唯一的可选开销是你自己配置的大模型 token）

## English

Zisuzi-Weread-MP archives the WeChat Official Account articles you subscribe to on
your own WeRead (微信读书) shelf into local Markdown notes inside your vault, images
and media included.

- **Scan to sign in.** The plugin opens an embedded WeRead login window; scan the QR
  code once with WeChat. No cookie copying required.
- **Your shelf is the subscription list.** Every Official Account you follow on WeRead
  is listed, searchable, and selectable.
- **Automatic collection.** A configurable poller saves new articles as they appear and
  shows progress, countdown, and the last run's results.
- **Full archive per account.** Backfill an entire account's history, newest first, with
  per-article status and retry.
- **Faithful content.** HTML is converted to Markdown; images are downloaded into a local
  `assets/` folder; audio and video are downloaded and embedded with native players.
- **Optional AI step.** Connect any OpenAI-compatible endpoint to summarise an article,
  extract quotes, or draft a comment, then write the result back into the note. Off by
  default.
- **Optional local agent.** Call a CLI you already have installed (Hermes, Claude Code,
  Codex, Kimi, Gemini, Cursor) to process an article. Off by default.

### Network and privacy

The plugin talks only to the hosts listed in the table below. There is no telemetry, no
analytics, and no remote code loading.

| Host | Purpose |
|---|---|
| `weread.qq.com` | Sign-in, shelf, article list and content, media URLs |
| `i.weread.qq.com` | Official Agent API (account list only) |
| `thirdwx.qlogo.cn` | WeRead avatar image |
| Your configured LLM endpoint | Only when you enable and trigger "AI"; off by default |
| Your local CLI | Only when you enable and trigger "local agent"; off by default |

Login credentials are stored in plain text in
`<vault>/.obsidian/plugins/zisuzi-weread-mp/data.json`. Do not sync that file to a public
location. "Sign out" clears it.

### Installation

Search **Zisuzi-Weread-MP** in `Settings → Community plugins → Browse`, or download
`main.js`, `manifest.json`, and `styles.css` from the releases page and place them in
`<vault>/.obsidian/plugins/zisuzi-weread-mp/`.

### Requirements and limits

- Desktop only: signing in relies on Electron's `webview`.
- Requires Obsidian 1.13.0 or newer (declarative settings API).
- Only articles already indexed by WeRead can be archived; this is the same boundary every
  client-side tool hits.
- The WeRead endpoints are private APIs and may change; that is the main maintenance cost.

---

## 功能

| | |
|---|---|
| **扫码登录** | 插件内嵌登录窗口，微信扫一下即可，不需要手工复制 Cookie |
| **书架即订阅源** | 自动读取你微信读书书架里订阅的公众号（几百个也能搜），勾选要盯的号 |
| **自动盯采** | 按设定间隔轮询，新文章自动落盘；状态条显示进度、倒计时、上次收了几篇 |
| **单号全量归档** | 把一个号的历史文章从新到旧整批抓下来，逐篇显示状态，失败可单独重试 |
| **正文完整归档** | HTML → Markdown；图片下载到本地 `assets/`（路径加尖括号，中文名不出错） |
| **音视频落盘** | 解析直链并下载，用 `<audio>` / `<video>` 原生播放器嵌进笔记 |
| **四种视图** | 卡片网格 / 瀑布流 / 列表 / 纯标题，按需切换；左侧常驻公众号导航栏 |
| **AI 处理** | 可接任意 OpenAI 兼容端点，对单篇做摘要、提炼金句、写评论，结果一键写回笔记 |
| **本地 Agent** | 可选调用本机 CLI（Hermes / Claude Code / Codex / Kimi / Gemini / Cursor）处理文章 |

## 安装

### 社区插件市场（推荐）

`设置 → 第三方插件 → 浏览 → 搜索「Zisuzi-Weread-MP」` → 安装 → 启用。

### 手动安装

1. 从 [Releases](https://github.com/pixelxzen/Zisuzi-Weread-MP/releases) 下载 `main.js`、`manifest.json`、`styles.css`
2. 放到 `<你的库>/.obsidian/plugins/zisuzi-weread-mp/`
3. `设置 → 第三方插件 → 重新加载 → 启用「Zisuzi-Weread-MP」`

## 快速开始

1. 打开 `设置 → Zisuzi-Weread-MP`
2. 点 **扫码登录**，在弹出的窗口里用微信扫一下
   - 登录成功后窗口自动关闭，头像、昵称、书架全部自动就位
3. 回到插件主界面，左侧勾选你要盯的公众号
4. 点 **抓取一轮** 立刻试一次，或打开自动盯采让它自己跑

> 首次同步书架需要几秒到十几秒（取决于你订阅了多少个号）。

## 网络与隐私

插件只向你配置的服务发起请求，没有遥测、没有统计上报、没有后台下发代码。

| 域名 | 用途 |
|---|---|
| `weread.qq.com` | 登录、书架、公众号文章列表与正文、媒体直链 |
| `i.weread.qq.com` | 官方 Agent API（仅用于读取书架公众号清单） |
| `thirdwx.qlogo.cn` | 微信读书头像图片（下载到插件目录后显示） |
| 你配置的 LLM 端点 | 仅在启用「AI 处理」并主动点击时调用，默认关闭 |
| 你的本机 CLI | 仅在启用「本地 Agent」并主动点击时调用，默认关闭 |

- 登录凭据以明文保存在 `<库>/.obsidian/plugins/zisuzi-weread-mp/data.json`，**请勿把这个文件同步到公共位置**；退出登录会清空它。
- 使用「AI 处理」时，**文章正文会发送到你自己填的模型端点**。该功能默认关闭，需要你显式开启并填 Key。
- 「本地 Agent」默认关闭，只在点击时启动本机命令行进程，不联网上传任何内容。

## 抓取节奏（为什么不快）

公众号接口是微信读书的私有接口，过度请求会触发风控。插件内置保守限速：

- 列表 1.2s / 正文 2.5s 间隔，每 15 篇休息 60s
- 命中风控码（`-2010` / `-2012` / `-2041`）**立即停止且不自动重试**
- 轮询间隔下限 15 分钟（公众号发文是小时级，30 分钟已接近实时）

请不要为了「快」改这些参数——代价是账号被限。

## 已知限制

- 只能抓微信读书已收录的公众号文章（与所有同类方案同一边界），未收录的号抓不到
- 纯图片型推送没有正文容器，会用摘要 + 封面写一篇短笔记，而不是整篇跳过
- 接口属私有接口，可能变更；这是本插件的主要维护成本
- 桌面端专用（登录窗口依赖 Electron 的 `webview`，移动端暂不支持）

## 开发

```bash
npm install
npm run dev      # 监听构建
npm run build    # 类型检查 + 生产构建
npm test         # 核心逻辑单测
```

产物为根目录的 `main.js` / `manifest.json` / `styles.css`。

## 致谢

交互与阅读面范式参考 [`joeseesun/qiaomu-ai-rss`](https://github.com/joeseesun/qiaomu-ai-rss)（GPL-3.0-only）；
微信读书接口实践参考 [`zhaohongxuan/obsidian-weread-plugin`](https://github.com/zhaohongxuan/obsidian-weread-plugin)（MIT）。

## License

**GPL-3.0-only**

Copyright © 2026 Creative by 紫苏子ACG
