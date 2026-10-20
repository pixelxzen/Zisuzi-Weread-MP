#!/usr/bin/env python3
"""每日汇总：最近 24h 落盘的公众号笔记 → 一份 md（落 AI日报 目录）"""
import os, re, glob, json, time, datetime

HOME = os.path.expanduser("~")
MON = f"{HOME}/.weread-monitor"
def _obs_dir():
    """归档根目录：WEREAD_OBS → config.json 的 obsidianDir → ~/Obsidian"""
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
OUTDIR = os.environ.get("WEREAD_SUMMARY_DIR") or os.path.join(HOME, "Obsidian", "AI日报")

acc = set()
try:
    acc = set(json.load(open(f"{MON}/final_accounts.json", encoding="utf-8")))
except Exception:
    pass

now = time.time()
rows = []
for f in glob.glob(os.path.join(OBS, "*.md")):
    try:
        if now - os.path.getmtime(f) > 86400:
            continue
        txt = open(f, encoding="utf-8").read(8000)
    except Exception:
        continue
    if "微信读书公众号" not in txt:
        continue
    m = re.search(r'^author:\s*"?([^"\n]+)"?', txt, re.M)
    if not m:
        continue
    a = m.group(1).strip()
    if acc and a not in acc:
        continue

    def g(k):
        mm = re.search(rf'^{k}:\s*"?([^"\n]+)"?', txt, re.M)
        return mm.group(1).strip() if mm else ""

    rows.append(dict(acc=a, title=g("title") or os.path.basename(f)[:-3],
                     date=g("date"), read=g("readNum"), like=g("likeNum"),
                     src=g("source"), path=f))

rows.sort(key=lambda r: (r["acc"], r["date"]))
today = datetime.date.today().isoformat()
os.makedirs(OUTDIR, exist_ok=True)
out = os.path.join(OUTDIR, f"weread盯采-{today}.md")
with open(out, "w", encoding="utf-8") as fh:
    fh.write(f"---\ntitle: \"微信读书公众号盯采汇总 {today}\"\ndate: {today}\nsource: weread-mp-monitor\n---\n\n")
    fh.write(f"# 公众号盯采汇总 {today}\n\n最近 24 小时新增 **{len(rows)}** 篇，覆盖 {len(set(r['acc'] for r in rows))} 个公众号。\n")
    cur = None
    for r in rows:
        if r["acc"] != cur:
            cur = r["acc"]
            fh.write(f"\n## {cur}\n\n")
        fh.write(f"- [{r['title']}]({r['src']})  阅读 {r['read']} · 赞 {r['like']} · {r['date']}\n")
    if not rows:
        fh.write("\n（本周期无新增）\n")
print(f"[summary] {out}  新增 {len(rows)} 篇")
