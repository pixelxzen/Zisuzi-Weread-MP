# Obsidian 插件工程构建、社区过审与 120 分制宣发动画全链路复盘手册

> **项目基线**：`Zisuzi-Weread-MP`（v0.1 → v4.4.0 官方社区商店正式上线）  
> **作者**：紫苏子ACG（GitHub: `pixelxzen`）  
> **适用范围**：未来所有新建或重构的 Obsidian 插件研发、官方社区目录（`obsidian-releases`）过审发布、以及演播室级（1920×1080 @ 60fps）产品宣传动画与交互式单文件 HTML 制作。

---

## 一、全链路核心认知总结（Executive Summary）

1. **插件工程架构铁律**：把「数据与网络核心层（`src/core/`）」和「Obsidian 宿主视图层（`src/host/`）」彻底解耦。任何核心逻辑必须能用纯 Node CLI 在 1 秒内跑通回归测试，不依赖每次重启 Obsidian。
2. **Obsidian UI 美学红线**：严禁使用 Obsidian 原生简陋的 `new Setting()` 表单行堆砌设置页。全量采用手写 DOM + 自定义设计系统（Tokens → Base → 组件层，对标 Apple / Linear 质感），并强制对亮色主题（`.theme-light`）做 `13.2 : 1` 以上的深色墨水字重校准，彻底免疫第三方浅灰主题污染。
3. **官方社区过审（`obsidian-plugin-bot`）三大禁区**：
   - 零 `innerHTML` / `outerHTML`（改用递归 DOM 工厂 `h()` + `DOMParser` 解析 SVG）；
   - 零运行时 `el.style.xxx = ...` 直接赋值（改用 CSS 变量 `el.style.setProperty('--var', val)` + 状态 class 切换）；
   - 零 `exec` / `spawn(..., { shell: true })`（调用本地 AI CLI 统一走 `execFile` 参数数组）。
4. **宣发动画从 65 分 → 75 分 → 95+ 分（按 120 分架构设计）的分水岭**：
   - **65 分（初级程序化动画）**：本地 TTS 吞标点/读错英文 + 单一指数缓动 + `Math.round` 半像素取整导致卡片/字体微抖 + 纯手绘简陋假框。
   - **75 分（合格动效片）**：换用 `gemini-3.8-flash-tts`（Charon 低音男声）+ `lyria-3.5`（128BPM 电子乐）+ Newton-Raphson 贝塞尔与弹簧物理 + 浮点仿射矩阵消除抖动，但仍存在「全片无真实软件界面、12 幕同质化版式、单色到底、背景弯曲粒子像蝌蚪乱窜」四大短板。
   - **95–100 分（120 分射程演播室级）**：**真实插件 `styles.css` 脱敏渲染窗口 3D 透视上屏** + **前景 `z+55` 放大特写卡与贝塞尔脉冲连线** + **四章节色彩戏剧弧线与内嵌衬线字体配对** + **幕内三关键帧运镜** + **四层母带声音设计（含 Foley 机械音效）** + **定向 45° 折角 PCB 电路总线与 3D 双链知识图谱拓扑背景**。

---

## 二、Part 1：Obsidian 插件工程架构与核心避坑指南

### 1.1 目录结构标准模板

```text
<plugin-repo>/
├── manifest.json              # id、version（不带 v 前缀）、minAppVersion、isDesktopOnly
├── package.json               # 构建脚本与依赖
├── esbuild.config.mjs         # 打包生成根目录 main.js
├── styles.css                 # 完整设计系统（Tokens + 暗/亮双主题 + 组件样式）
├── src/
│   ├── main.ts                # 插件生命周期入口、命令注册、定时任务与设置页挂载
│   ├── core/                  # 【零 Obsidian 依赖】纯 TypeScript 核心层
│   │   ├── api.ts             # 网络请求、Header 构造、风控错误码识别（RiskError）
│   │   ├── auth.ts            # Cookie 完整性校验（checkCookie）、状态机（none/cookie/full）
│   │   ├── parser.ts          # HTML -> Markdown 转换、图片魔数识别、音视频标签保留
│   │   ├── agent.ts           # 本地 AI CLI 调用封装（基于安全的 execFile）
│   │   └── assets.ts          # 品牌头像、演示占位图等内嵌 Base64 静态资产
│   └── host/                  # 【Obsidian 视图层】
│       ├── dom.ts             # 安全 DOM 构造器 h() 与 SVG 解析器（替代 innerHTML）
│       ├── weread-view.ts     # ItemView 主工作区、顶栏统计卡、视图路由与阅读抽屉
│       ├── view-cards.ts      # 视图 1：沉浸式卡片网格
│       ├── view-linear.ts     # 视图 2：Linear 极速信息流
│       └── view-modes.ts      # 视图 3/4：按公众号分组树、极简纯标题列表
└── docs/
    └── PLAYBOOK-OBSIDIAN-PLUGIN-AND-PROMO-VIDEO.md
```

### 1.2 Electron / Obsidian 1.14+ 内嵌扫码登录标准范式

Obsidian 1.14 起移除了 `electron.remote`，且 `requestUrl` 底层的 `net.request` 默认 `useSessionCookies: false`（请求不自动携带 Electron 会话 Cookie）。遇到需要第三方登录的插件，标准解法如下：

1. **使用 `<webview>` 而非 `<iframe>`**：
   - `<iframe>` 受同源策略限制无法读取跨域 `document.cookie`；
   - 在 Obsidian Modal 中创建 `<webview src="https://..." allowpopups>`，设置显式宽高。
2. **双通道提取并合并完整 Cookie**：
   - 许多站点（如微信读书）的部分关键 Cookie（如 `wr_gid`）由前端 JS 动态写入，另一些由服务端 `Set-Cookie` 写入；
   - 轮询 `webview.executeJavaScript('document.cookie')`，用 `checkCookie()` 检验必选字段全部齐备后，**立即自动关闭登录弹窗**并触发首次数据同步。
3. **凭据写入双道闸（防“好凭据被空状态覆盖”）**：
   - **第一道闸**：读取会话 Cookie 后必须通过 `checkCookie(raw).ok === true` 才允许赋给内存；
   - **第二道闸**：`saveSettings()` 落盘前再次比对，若内存中 Cookie 不完整而磁盘 `data.json` 中已有完整 Cookie，保留磁盘值，绝不写空覆盖。

### 1.3 Apple / Linear 级自定义 UI 与明暗主题对比度铁律

1. **彻底弃用 `new Setting(containerEl)`**：
   - 统一使用自定义 `.wmc-fr`（Form Row）卡片行、分段控制器（Segmented Control）、胶囊开关（`.wmc-fr-switch`）与三联统计卡（`.wmc-statbar`）。
2. **亮色主题（`.theme-light`）防污染设计**：
   - 许多用户的第三方 Obsidian 亮色主题会把 `--text-muted` 设得很浅，导致插件在亮色模式下字迹发灰难读；
   - 必须在 `styles.css` 的 `.theme-light .wmc-root` 下显式锁定高对比度语义变量：
     ```css
     .theme-light .wmc-root,
     .theme-light .wmc-settings,
     .theme-light .wmc-bf-modal {
       --wmc-bg-elev: #f6f4ef;
       --wmc-card-bg: #ffffff;
       --wmc-ink-1: #1c1c1e;                  /* 正文主色，对比度 >= 13.2:1 */
       --wmc-ink-2: rgba(28, 28, 30, 0.78);   /* 二级说明文字 */
       --wmc-ink-3: rgba(28, 28, 30, 0.56);   /* 元数据与时间戳 */
       --wmc-border: rgba(28, 28, 30, 0.14);
     }
     ```
3. **多媒体 Markdown 落盘规范**：
   - 远程图片下载后**按文件头魔数（Magic Bytes）**判定真实扩展名（微信 CDN 常把 PNG 挂在 `.jpg` URL 下）；
   - 公众号内嵌语音与视频解析后生成原生 `<audio controls src="...">` 与 `<video controls src="...">`，让用户在 Obsidian 阅读器内直接点击播放。

---

## 三、Part 2：Obsidian 官方社区目录（`obsidian-releases`）零 Warning 过审圣经

向 `obsidianmd/obsidian-releases` 提交 `community-plugins.json` PR 后，官方自动化扫描器 `obsidian-plugin-bot` 会对 Release 产物 `main.js` 执行静态 AST 审计。以下是三大高频阻断项与标准解法：

| 扫描器告警项 | 触发原因 | 根治解法 |
|---|---|---|
| `unsafe-innerHTML` | 出现 `.innerHTML = ...`、`outerHTML = ...` 或 `insertAdjacentHTML` | 编写 `h(tag, attrs, children)` 递归创建 DOM 节点；内联 SVG 图标统一走 `new DOMParser().parseFromString(svgStr, 'image/svg+xml').documentElement` 后 `appendChild` |
| `unsafe-style-assignment` | 出现 `el.style.width = ...`、`el.style.color = ...` 或 `setAttribute('style', ...)` | 全部样式收归 `styles.css`；动态进度条宽度或颜色通过 `el.style.setProperty('--wmc-prog', '83%')` 注入 CSS 变量，并在 CSS 中写 `width: var(--wmc-prog, 0%)` |
| `unsafe-child-process` | 使用 `child_process.exec` 或带 shell 拼接的命令调用 | 仅在桌面端按需获取 `child_process`，统一使用参数数组形式的 `execFile(bin, args, opts)`，杜绝 shell 注入 |

### 发布前本地自检一行命令

在打包 `node esbuild.config.mjs production` 后，务必运行以下正则自检，确认输出为 `0` 后再打 Tag 发 Release：

```bash
node -e '
const fs = require("fs");
const code = fs.readFileSync("main.js", "utf8");
const checks = [
  ["innerHTML/outerHTML", /\.(innerHTML|outerHTML)\s*=/g],
  ["direct style prop", /\.style\.(?!setProperty|removeProperty)[a-zA-Z]+\s*=/g],
  ["setAttribute(style)", /\.setAttribute\(\s*["\x27]style["\x27]/g]
];
for (const [name, re] of checks) {
  const m = code.match(re) || [];
  console.log(name, "->", m.length, m.length === 0 ? "PASS" : "FAIL");
}
'
```

### GitHub Release 与版本号铁律
1. **Tag 命名严禁加 `v` 前缀**：若 `manifest.json` 中 `"version": "4.4.0"`，GitHub Tag 必须命名为 `4.4.0`（不能是 `v4.4.0`），否则社区后台扫描器会报版本号不匹配。
2. **Release 附件必传三件套**：`gh release create 4.4.0 main.js manifest.json styles.css --title "4.4.0"`。

---

## 四、Part 3：120 分制演播室级产品宣传动画工程体系

> 目标：不依赖手工 AE 套模板，完全用代码驱动（WebGL2 着色器 + HTML5 Canvas 2D 3D 投影引擎 + AI 母带级配音配乐 + Playwright 多进程并发帧导出），产出 **90–100 分成片质量的 1920×1080 60fps MP4 与单文件自包含 HTML**。

### 4.1 65 分 → 75 分 → 100 分（120 分架构）质量演进对照表

| 维度 | 65 分（初级版） | 75 分（进阶版） | 95–100 分（120 分制演播室版） |
|---|---|---|---|
| **旁白配音 (TTS)** | 本地小模型直接出，偶发吞句号、把 `Markdown` 读成 `Marko` | `gemini-3.8-flash-tts`（Charon 104Hz 低音男声）+ `mlx_whisper` 复核 | 在 75 分基础上叠加 `115Hz` 胸腔共鸣 EQ、`1.18x` 黄金语速与逐帧呼吸气口留白 |
| **背景配乐与音效** | 手写 8 小节简单合成器循环，无音效 | `lyria-3.5` 128BPM 电子乐 + 侧链闪避 + 切点低音 | **四层母带声音设计**：旁白 + Lyria 128BPM 闪避配乐 + 章节 Riser 扫频 + 逐帧对齐的 UI 机械咔哒/扫码和弦/里程表跳字音效 |
| **产品界面呈现** | 100% 手绘抽象框线（观众看不出插件真实长相） | 五层玻璃拟态程序化卡片（精致但仍像概念框） | **真界面 3D 透视上屏**：直接加载插件真实 `styles.css` 渲染脱敏高清界面窗口（`drawUIWindow3D` 含立体厚度边），配合前景 `z+55` 放大特写卡与贝塞尔发光脉冲连线（`drawCalloutBeam`） |
| **色彩与版式结构** | 12 幕共用同一套暗紫底色与居中版式 | 四种 WebGL 着色器模式，但整体仍偏同质暗紫 | **四章节色彩戏剧弧线**（冷岩蓝 → 赛博翡翠绿 → 琥珀金/Moonstone 亮色暖白 → 皇家紫金）+ 子集化内嵌 `Bodoni Bold Italic` 巨幅章节衬线水印 + 瑞士网格系统 |
| **镜头与运动物理** | 单一指数缓动 + `Math.round` 取整（画面微抖） | Newton-Raphson 贝塞尔 + 二阶弹簧 + 纯浮点仿射矩阵 | **幕内三关键帧运镜（`makeMultiCam`）**：「甩镜切入 → 焦点推轨环绕 → 出场蓄力拉镜」+ 瞬时速度矢量驱动的 4 采样方向性动态模糊 |
| **大背景科技动效** | 随机圆点漂浮 | 圆头光斑 + 5 段正弦弯曲尾巴（形似蝌蚪/精子乱窜，缺乏方向感） | **三层定向科技拓扑**：1) 45° 折角 PCB 正交电路总线与直线菱形光子包；2) 3D 双链知识图谱星座拓扑与突触脉冲；3) 精密 CAD 几何微准星（`+` / `◇` / `□`） |

### 4.2 旁白 TTS 与 `mlx_whisper` 发音复核门禁 SOP

1. **Google `gemini-3.8-flash-tts` 零误读调用公式**：
   - 切勿在 `contents.parts.text` 中传入多段式 `DIRECTOR'S NOTES` 或中文提示词（会被模型直接念进音频）；
   - **标准写法**：单行英文方括号简短声线标签 + 空格 + 纯中文台词正文：
     ```text
     [deep resonant baritone, warm, confident, brisk pace] 这款插件做的事很纯粹：把微信读书里的公众号长文，原汁原味搬进你的 Obsidian 本地知识库。
     ```
   - 推荐声线：`Charon`（基频 104–120Hz，浑厚央视纪录片质感）或 `Orus`（122Hz）。
2. **`mlx_whisper` 强制发音复核门禁（100% 必跑）**：
   - 任何 TTS 生成完毕后，必须用 `mlx-community/whisper-large-v3-turbo`（设置 `language='zh'` 与包含专有名词的 `initial_prompt="Obsidian, Markdown, Cookie, AI Agent, GitHub, Zisuzi-Weread-MP"`）逐句回读转写；
   - 核对每一句的汉字字符匹配率与英文专有名词（`Obsidian` / `Cookie` / `Markdown` / `Agent` / `GitHub`），任何一处读错立即换写法或重出，绝不带病进入合成环节。

### 4.3 信息脱敏与隐私红线（公开宣发必检）

在渲染真实插件界面贴图（`capture_ui.mjs`）及打包最终 HTML/MP4 前，必须遵守以下脱敏替换规则：

| 真实私有信息类型 | 严禁出现的特征词 | 宣发片标准脱敏替代方案 |
|---|---|---|
| 内部非公开项目/机构 | `尊胜`、`决策体系` | 统一替换为：`紫苏子ACG · 独立动画导演 · AI 与知识工程` |
| 真实账号 ID / 凭据 | 真实 `wr_vid`（如 `5617686`）、真实 `wr_skey`、`wrk-` Key | 演示 VID `8842109`，全部 Token 不入前端代码 |
| 本机磁盘与主库路径 | `/Users/<真实用户名>`、`/Volumes/NodexPro`、`/Volumes/ZenProX` | 统一替换为：`~/Obsidian/KnowledgeVault/5-剪藏笔记` |
| 私人订阅列表 | 私人小众号或个人笔记标题 | 统一使用公开科技媒体：`数字生命卡兹克`、`极客公园`、`机器之心`、`少数派`、`量子位`、`宝玉XP` |

**交付前必跑的隐私扫描脚本（命中数必须全为 0）**：

```python
html = open('Zisuzi-Weread-MP-使用指南.html', encoding='utf-8').read()
forbidden = ['尊胜', '决策体系', '5617686', 'ligerui', 'NodexPro', 'ZenProX', 'wr_skey=v', 'wr_rt=', 'wrk-', 'AIzaSy']
for pat in forbidden:
    assert html.count(pat) == 0, f"Privacy leak: {pat}"
```

### 4.4 60fps 极速并发渲染与合成管线（80 秒导出 6,185 帧）

1. **纯函数帧渲染接口 `window.__WMC.renderFrame(f)`**：
   - 动画引擎内部所有位置、弹簧、粒子、着色器时间完全由帧号 `f`（`t = f / 60`）确定性计算，无任何跨帧状态累积；
   - 导出前必须调用 `window.__WMC.pause()` 停掉后台 `requestAnimationFrame` 循环，防止真实时间与导出帧覆盖叠画。
2. **Playwright 4 Worker 分批重启导出（`export_v5.mjs`）**：
   - 启动参数：`--enable-unsafe-swiftshader --use-gl=angle --force-device-scale-factor=1`；
   - **关键防黑屏机制**：Chromium 连续截图超过 3,000 帧会出现 GPU 上下文内存退化导致后续帧全黑；因此每个 Worker **每渲染 450 帧自动关闭并重启一次 Browser 实例**，4 进程并发可在 ~80 秒内稳定导出 6,185 帧（约 76 fps）。
3. **FFmpeg 母带编码与黑屏终检命令**：
   ```bash
   # H.264 High Profile CRF 16 + AAC 320kbps 48kHz 合成
   /opt/homebrew/bin/ffmpeg -y \
     -framerate 60 -i /tmp/v5/frames_jpg/%05d.jpg \
     -i /tmp/v5/master_audio.wav \
     -c:v libx264 -preset medium -crf 16 -pix_fmt yuv420p -profile:v high -level 4.2 \
     -c:a aac -b:a 320k -ar 48000 -movflags +faststart -shortest \
     ~/Downloads/Zisuzi-Weread-MP-使用指南.mp4

   # 全片黑屏段扫描（必须 0 命中）
   /opt/homebrew/bin/ffmpeg -v info -i ~/Downloads/Zisuzi-Weread-MP-使用指南.mp4 \
     -vf "blackdetect=d=0.1:pix_th=0.10" -an -f null - 2>&1 | grep "black_start"
   ```

---

## 五、Part 4：下一个新 Obsidian 插件开发与宣发速查清单（Checklist）

### 阶段 A：插件研发与本地验收
- [ ] `src/core` 与 `src/host` 解耦，核心逻辑具备独立 CLI 测试脚本
- [ ] 全量使用 `h()` 安全 DOM 构造器，0 处 `innerHTML`、0 处直接 `.style.xxx =` 赋值
- [ ] 彻底移除 `new Setting()`，使用 `.wmc-fr` 自定义表单系统
- [ ] 亮色主题（`.theme-light`）与暗色主题（`.theme-dark`）双模式实测，正文对比度 ≥ 13:1
- [ ] 涉及第三方接口时具备保守限速与风控错误码熔断停机机制

### 阶段 B：GitHub 开源与社区商店上架
- [ ] `.gitignore` 已排除测试库、凭据文件、`node_modules`；打包产物 grep 真实密钥/Cookie 为 0
- [ ] `manifest.json`、`package.json`、GitHub Tag 版本号三者严格一致（Tag 不带 `v`）
- [ ] GitHub Release 已上传 `main.js`、`manifest.json`、`styles.css`
- [ ] `obsidian-plugin-bot` 自动化扫描 0 Warning 通过

### 阶段 C：120 分制宣传动画与交互页制作
- [ ] 12 幕脚本控制在 90–105 秒内，`gemini-3.8-flash-tts`（Charon）生成旁白并通过 `mlx_whisper` 100% 准确率门禁
- [ ] `lyria-3.5` 生成 128BPM 配乐，锁定偶数拍网格切点，合成旁白闪避 + 4 层动作音效（Whoosh / Click / Chime / Riser）
- [ ] 使用插件真实 `styles.css` + 严格脱敏数据在无头浏览器中渲染 4 张真实插件窗口贴图，在 3D 空间中配合前景放大卡片与贝塞尔脉冲线展示
- [ ] 划分为 4 个色彩章节，内嵌子集化展示衬线字体（WOFF2），每幕配置 3 关键帧运镜
- [ ] 背景动效采用 45° 折角正交电路总线 + 3D 拓扑网格 + 几何微准星（杜绝弯曲蝌蚪状粒子）
- [ ] 交付前通过「隐私禁用词正则扫描 0 命中」与「FFmpeg `blackdetect` 0 黑屏帧」双重终检
