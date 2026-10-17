# WeRead MP Catcher · 微信读书公众号盯采

在 Obsidian 里登录微信读书，自动盯采**你自己书架里订阅的公众号**更新，把每篇文章（含图片）归档成本地 Markdown 笔记。

> 解决的是"公众号文章看不过来、也不该锁在微信里"的问题：一次配置，之后新文章自动落进你的知识库。

## 状态

| 能力 | 状态 |
|---|---|
| 抓取引擎（列表 / 正文 / 图片本地化 / 去重 / 风控熔断） | ✅ 0.1.0 已真机验收 |
| 主库安装（27 个号、autoStart） | ✅ 已装 |
| 列表 UI（双栏 + 未读 + 缩略图） | 🚧 0.2.0 开发中 |
| LLM 路由（DeepSeek 默认，可切智谱/Kimi/OpenAI/Ollama） | 🚧 0.2.0 开发中 |

## 它和别的方案有什么不同

| | 本插件 | wechat2rss（付费） | qiaomu-ai-rss |
|---|---|---|---|
| 数据路径 | **直连你自己的微信读书账号**，不经任何第三方服务器 | 作者服务器中转 | 作者服务 `rss.qiaomu.ai` |
| 费用 | 0（只花你自己的模型 token，且默认关） | 150 元/年 | 免费 + AI 走作者服务 |
| 覆盖 | 微信读书已收录的公众号（可翻到底） | 同源 | RSS / 公众号 RSS |
| 全文 + 图片 | ✅ 归档到 vault，图片本地化 | ✅（走代理） | 部分源只有摘要 |

## 安装

1. 下载 `main.js` / `manifest.json` / `styles.css`
2. 放到 `<vault>/.obsidian/plugins/weread-mp-catcher/`
3. 设置 → 第三方插件 → 启用 **WeRead MP Catcher**
4. 设置页填入 Cookie（`wr_vid` / `wr_skey` / `wr_rt` / `wr_gid` 四项齐全，缺 `wr_gid` 会报 `-2012`）

## 使用

- 命令：`立即抓取一轮` / `开始·停止自动盯采` / `打开微信读书登录窗口`
- 设置：公众号清单（`名称 | MP_WXS_xxx` 一行一个）、笔记目录、轮询间隔（下限 15 分钟）、单轮上限、图片本地化开关
- 默认 `autoStart` 开启：打开 Obsidian 即按 30 分钟间隔轮询

## 风控纪律

- 列表 1.2s / 正文 2.5s 请求间隔；单轮上限默认 8 篇、每号 2 篇
- 命中 `-2010 / -2012 / -2041` **立即熔断**，不自动重试
- 轮询下限 15 分钟（公众号发文是小时级，30 分钟即准实时）

## 隐私

- 抓取只访问 `weread.qq.com`（你的登录态），不向你以外的任何服务器上传数据
- Cookie 以明文保存在本库 `.obsidian/plugins/weread-mp-catcher/data.json`，请勿把该文件同步到公共位置
- 启用 LLM 功能后，**文章正文会发送到你配置的模型端点**（默认 DeepSeek）。默认关闭，需你显式开启

## 已知限制

- 只能抓微信读书已收录的公众号文章（与所有同类方案同一边界）
- 纯视频/图片型推送没有正文容器，会被跳过（不落半截笔记）
- 微信读书接口属私有接口，可能变更；变更是本插件的主要维护成本

## 参考与致谢

- 交互与阅读面范式参考 [`joeseesun/qiaomu-ai-rss`](https://github.com/joeseesun/qiaomu-ai-rss)（GPL-3.0-only）
- 微信读书登录态与接口实践参考 [`zhaohongxuan/obsidian-weread-plugin`](https://github.com/zhaohongxuan/obsidian-weread-plugin)（MIT）
- 公众号接口通路验证：`/web/mp/articles`、`/web/mp/content`、`/api/mp/cover`

## License

**GPL-3.0-only**

Copyright © 2026 Creative by 紫苏子ACG
