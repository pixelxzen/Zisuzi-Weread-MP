#!/usr/bin/env python3
"""从 Obsidian 归档生成标准 RSS feed（总 feed + 每号 feed + 订阅索引页）

用法：
  python3 gen_feed.py                 # 生成到 ~/.weread-monitor/feed/
  WEREAD_FEED_BASE=https://x.pages.dev python3 gen_feed.py   # 生成公网可用的绝对链接

订阅：本地起 `python3 -m http.server 8787 -d ~/.weread-monitor/feed`，
     然后在 Reeder / NetNewsWire / FreshRSS 里加 http://127.0.0.1:8787/index.xml
"""
import os, re, json, glob, html, datetime, email.utils

HOME = os.path.expanduser("~")
MON = f"{HOME}/.weread-monitor"
def _obs_dir():
    """归档根目录：优先 WEREAD_OBS 环境变量，其次 config.json 的 obsidianDir，最后 ~/Obsidian"""
    v = os.environ.get("WEREAD_OBS")
    if v:
        return os.path.expanduser(v)
    try:
        cfg = json.load(open(f"{MON}/config.json", encoding="utf-8"))
        d = cfg.get("obsidianDir")
        if d:
            return os.path.expanduser(d)
    except Exception:
        pass
    return os.path.join(HOME, "Obsidian")


OBS = _obs_dir()
OUT = f"{MON}/feed"
BASE = os.environ.get("WEREAD_FEED_BASE", "").rstrip("/")
TOTAL_LIMIT, PER_LIMIT = 120, 60

os.makedirs(OUT, exist_ok=True)


def split_fm(txt):
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", txt, re.S)
    if not m:
        return {}, txt
    fm = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip().strip('"')
    return fm, m.group(2)


def md2html(md):
    out, para = [], []

    def flush():
        if para:
            out.append("<p>" + "<br/>".join(html.escape(x) for x in para) + "</p>")
            para.clear()

    for raw in md.splitlines():
        line = raw.rstrip()
        if not line.strip():
            flush(); continue
        m = re.match(r"^!\[([^\]]*)\]\(([^)]+)\)", line.strip())
        if m:
            flush()
            src = m.group(2)
            if not re.match(r"https?://", src):
                src = "file://" + os.path.join(OBS, src) if not src.startswith("/") else "file://" + src
            out.append(f'<p><img src="{html.escape(src)}" alt="{html.escape(m.group(1))}"/></p>')
            continue
        m = re.match(r"^(#{1,4})\s+(.*)", line.strip())
        if m:
            flush(); lv = len(m.group(1))
            out.append(f"<h{lv}>{html.escape(m.group(2))}</h{lv}>")
            continue
        if line.startswith("> "):
            flush(); out.append(f"<blockquote>{html.escape(line[2:])}</blockquote>"); continue
        if re.match(r"^[-*]\s", line.strip()):
            flush(); out.append(f"<p>• {html.escape(line.strip()[2:])}</p>"); continue
        para.append(line.strip())
    flush()
    return "\n".join(out)


def review_id(src):
    m = re.search(r"weread://(?:MP_WXS_\d+_)?(.+)$", src or "")
    return m.group(1) if m else ""


def rf822(datestr):
    try:
        dt = datetime.datetime.strptime(datestr[:10], "%Y-%m-%d")
    except Exception:
        dt = datetime.datetime.now()
    return email.utils.format_datetime(dt.replace(tzinfo=datetime.timezone.utc))


# ---- 读配置：bookId -> 名称 ----
cfg = json.load(open(f"{MON}/config.json", encoding="utf-8"))
names = {}
for a in cfg.get("accounts", []):
    if isinstance(a, dict):
        names[a["bookId"]] = a.get("name") or a["bookId"]

# ---- 扫笔记 ----
items = []
for f in glob.glob(os.path.join(OBS, "*.md")):
    try:
        txt = open(f, encoding="utf-8").read()
    except Exception:
        continue
    if "微信读书公众号" not in txt:
        continue
    fm, body = split_fm(txt)
    rid = review_id(fm.get("source", ""))
    if not rid:
        continue
    body = re.sub(r"^#\s+.*?\n", "", body, count=1)
    body = body.split("## 正文", 1)[-1]
    bid = (re.search(r"MP_WXS_\d+", fm.get("source", "")) or [""])[0]
    items.append(dict(
        title=fm.get("title") or os.path.basename(f)[:-3],
        author=fm.get("author") or names.get(bid, bid),
        bid=bid or "MP_WXS_unknown",
        published=fm.get("published") or fm.get("date") or "",
        read=fm.get("readNum", ""), like=fm.get("likeNum", ""),
        rid=rid, html_body=md2html(body),
        link=f"https://weread.qq.com/web/mp/content?reviewId={rid}",
    ))

items.sort(key=lambda x: (x["published"], x["rid"]), reverse=True)
print(f"[feed] 读到 {len(items)} 篇笔记，覆盖 {len(set(i['bid'] for i in items))} 个号")

FEED_TMPL = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>{title}</title>
  <link>{site}</link>
  <description>{desc}</description>
  <language>zh-CN</language>
  <lastBuildDate>{build}</lastBuildDate>
  <generator>zishen weread-mp-monitor</generator>
  <atom:link href="{self}" rel="self" type="application/rss+xml"/>
{items}
</channel>
</rss>
"""

ITEM_TMPL = """  <item>
    <title>{title}</title>
    <link>{link}</link>
    <guid isPermaLink="false">{guid}</guid>
    <pubDate>{pub}</pubDate>
    <author>noreply@weread.qq.com ({author})</author>
    <category>{author}</category>
    <description><![CDATA[{desc}]]></description>
  </item>"""


def build(items, title, desc, site, self_url):
    body = "\n".join(ITEM_TMPL.format(
        title=html.escape(i["title"]), link=i["link"], guid=html.escape(i["rid"]),
        pub=rf822(i["published"]), author=html.escape(i["author"]),
        desc=f'<p>来源：{html.escape(i["author"])}｜阅读 {i["read"]} · 赞 {i["like"]}｜{i["published"]}</p>' + i["html_body"],
    ) for i in items)
    return FEED_TMPL.format(title=html.escape(title), site=site, desc=html.escape(desc),
                            build=email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc)),
                            self=self_url, items=body)


site = BASE or "http://127.0.0.1:8787"
open(f"{OUT}/index.xml", "w", encoding="utf-8").write(
    build(items[:TOTAL_LIMIT], "紫神 · 微信读书公众号盯采（全部）",
          "微信读书书架公众号最新文章全量归档", site, f"{BASE}/index.xml"))

by_acc = {}
for i in items:
    by_acc.setdefault(i["bid"], []).append(i)
for bid, arr in by_acc.items():
    open(f"{OUT}/{bid}.xml", "w", encoding="utf-8").write(
        build(arr[:PER_LIMIT], f"紫神 · {arr[0]['author']}", f"{arr[0]['author']} 的公众号文章归档",
              site, f"{BASE}/{bid}.xml"))

# ---- 索引页 ----
rows = "\n".join(
    f'<tr><td><a href="{bid}.xml">{html.escape(arr[0]["author"])}</a></td><td>{len(arr)}</td>'
    f'<td>{html.escape(arr[0]["published"])}</td><td>{html.escape(arr[0]["title"][:40])}</td></tr>'
    for bid, arr in sorted(by_acc.items(), key=lambda kv: kv[1][0]["published"], reverse=True))
open(f"{OUT}/index.html", "w", encoding="utf-8").write(f"""<!doctype html><meta charset="utf-8">
<title>紫神 · 公众号盯采 RSS</title>
<style>body{{font:15px/1.7 -apple-system,Segoe UI,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#222}}
h1{{font-size:22px}}table{{border-collapse:collapse;width:100%}}td,th{{border-bottom:1px solid #eee;padding:8px 6px;text-align:left}}
a{{color:#474980}}</style>
<h1>紫神 · 微信读书公众号盯采</h1>
<p>共 <b>{len(items)}</b> 篇 / <b>{len(by_acc)}</b> 个公众号 · 全部订阅：<a href="index.xml">index.xml</a></p>
<table><tr><th>公众号</th><th>篇数</th><th>最新</th><th>最新标题</th></tr>{rows}</table>
<p style="color:#888">生成于 {datetime.datetime.now():%Y-%m-%d %H:%M}</p>""")

print(f"[feed] 已生成：index.xml + {len(by_acc)} 个号 feed + index.html → {OUT}")
