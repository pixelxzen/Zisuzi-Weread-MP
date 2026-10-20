# 公众号正文里的音频 / 视频直链提取（实测配方）

## 结论先看

| 媒体 | 线索位置 | 直链怎么拿 | 需要 cookie 吗 |
|---|---|---|---|
| 语音 `mpvoice` | `<mpvoice voice_encode_fileid="X">` | `https://res.wx.qq.com/voice/getvoice?mediaid=X` | 不需要，下载带 Referer |
| `<audio src>` / `<video src>` | 标签属性 | 直接取 `src` | 同上 |
| 微信视频 iframe | `data-mpvid="wxv_…"` | **正文 HTML 的 JS 数据块里就有 mp4 直链** | **不需要**，带 `Referer: https://mp.weixin.qq.com/` 即可 |

## iframe 的真实结构（别去猜 `get_mp_video_play_url`）

```html
<iframe class="video_iframe rich_pages"
  data-src="https://mp.weixin.qq.com/mp/readtemplate?t=pages/video_player_tmpl&action=mpvideo&auto=0&vid=wxv_4369010745125109763"
  data-mpvid="wxv_4369010745125109763" data-vidtype="2"
  data-ratio="1.7777777777777777" data-w="1920">
```

`data-mpvid` 是最稳的 vid 来源（`data-src` 里的 `vid=` 同值）。带 `videoplayer?action=get_mp_video_play_url` 形态的 iframe 也存在，但**不是唯一形态**，按它写死解析会漏。

## mp4 直链在 JS 数据块里（每视频多档码率）

```js
{ … width:'1920', height:'1080', duration:'193', filesize:'25370736',
  url:'http://mpvideo.qpic.cn/0bc32iae….f10002.mp4?dis_k=…&dis_t=…&play_scene=10120&auth_info=…&auth_key=…' }
```

- 同一文件 ID 有 4 档：`f10002`（通常最大最高清）、`f10004`、`f10102` 等 → **按 `filesize` 取最大**，不要按后缀猜画质。
- `dis_k / dis_t / auth_info / auth_key` 是签名，**会过期** → 抓到就立刻下载，别缓存过夜。
- 实测规模：一篇含 9 个视频的号 → 9 个 iframe ↔ 9 个文件 ID 组 ↔ 36 条 mp4，一一对应。

## 提取算法（vid → 最大码率直链）

```ts
function extractVideoUrls(html: string): Map<string, string> {
  const s = html
    .replace(/\\x26amp;/g, '&').replace(/\\x26/g, '&').replace(/&amp;/g, '&')
    .replace(/\\x22/g, '"').replace(/\\x3c/gi, '<').replace(/\\x3e/gi, '>');
  const vids: Array<{ vid: string; idx: number }> = [];
  for (const m of s.matchAll(/(wxv_\d+)/g)) vids.push({ vid: m[1], idx: m.index! });

  const best = new Map<string, { size: number; url: string }>();
  for (const m of s.matchAll(/filesize:\s*'(\d+)'[\s\S]{0,400}?url:\s*'([^']*\.mp4[^']*)'/g)) {
    const size = Number(m[1]), url = m[2];
    let owner: string | undefined;
    for (const v of vids) { if (v.idx < m.index!) owner = v.vid; else break; }
    if (!owner) continue;
    const cur = best.get(owner);
    if (!cur || size > cur.size) best.set(owner, { size, url });
  }
  return new Map([...best].map(([k, v]) => [k, v.url]));
}
```

要点：**用「最近的、位置在前面的 vid」做归属**。数组顺序恰好对得上过（9↔9），但不要依赖顺序。

## 下载与落盘

```bash
curl -sS -L -A "<桌面 UA>" -e "https://mp.weixin.qq.com/" "<mp4 url>" -o out.mp4
# 实测：HTTP 206 / content-type: video/mp4 / ISO Media MP4 —— 无 cookie
```

笔记里写 Obsidian 原生播放器（阅读视图可直接播）：

```html
<video controls src="../assets/<标题>/media-1.mp4"></video>
<audio controls src="../assets/<标题>/media-1.mp3"></audio>
```

## 体积闸门（必须有）

一篇图文里的视频可能单条几十 MB、合计几百 MB。落盘前按 `maxMediaMB`（默认 50）判断，超限就**不下载**、只保留可点链接并在 Notice 里报出体量。判据不是「能不能下」，而是「下完磁盘还剩多少」。

## 判据：什么时候 mp 原页能直取

带**桌面 UA** 请求 `https://mp.weixin.qq.com/s/<hash>` 可能直接拿到完整 HTML。硬指标：

```bash
curl -sS -L -A "<桌面 UA>" "https://mp.weixin.qq.com/s/XXX" -o mp.html
ls -lh mp.html                          # 成功通常 1–4 MB
grep -o js_content mp.html | wc -l      # > 0 才算拿到正文
grep -o 'wxv_' mp.html | wc -l          # > 0 说明视频线索也在里面
```

成功时这一份 HTML 同时含正文、图片、视频直链，一次够用；返回十几 KB 且 `js_content` 为 0 = 被引到验证/空壳页，退回微信读书 `/web/mp/content` 通道（见 SKILL.md 数据通路）。**不要因为一次失败就断言「mp 直取永久失效」——先看字节数与 `js_content` 计数再判定。**

## 归档判定

纯视频/纯图片推送没有正文文本，但 `@@MEDIA{n}@@` / `@@IMG{n}@@` 占位符仍在 markdown 里 → 跳过条件必须是「无正文**且**无图**且**无媒体」，不要用「正文为空就跳过」，否则小绿书（纯图片笔记）会被整篇丢掉。
