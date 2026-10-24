<div align="center">
  <img src="assets/hero.jpg" alt="Zisuzi-Weread-MP" width="100%" />
</div>

<h1 align="center">
  <img src="assets/logo.svg" alt="Zisuzi-Weread-MP" width="420" />
</h1>

<p align="center">
  <b>WeRead Official Account collector</b> · One QR scan, and every Official Account on your WeRead shelf lands in Obsidian as Markdown.
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#reading-the-login-indicator">Login status</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="https://github.com/pixelxzen/Zisuzi-Weread-MP/issues">Issues</a>
</p>

<p align="center">
  <a href="https://github.com/pixelxzen/Zisuzi-Weread-MP/releases"><img src="https://img.shields.io/github/v/release/pixelxzen/Zisuzi-Weread-MP?style=flat-square&color=474980" alt="Release" /></a>
  <a href="https://github.com/pixelxzen/Zisuzi-Weread-MP/releases"><img src="https://img.shields.io/github/downloads/pixelxzen/Zisuzi-Weread-MP/total?style=flat-square&color=474980" alt="Downloads" /></a>
  <img src="https://img.shields.io/badge/Obsidian-1.13.0%2B-7C3AED?style=flat-square" alt="Obsidian 1.13.0+" />
  <img src="https://img.shields.io/badge/Desktop-only-555?style=flat-square" alt="Desktop only" />
  <a href="LICENSE"><img src="https://img.shields.io/github/license/pixelxzen/Zisuzi-Weread-MP?style=flat-square&color=474980" alt="License" /></a>
</p>

---

Articles published on WeChat Official Accounts are built to disappear: buried in the subscription feed, lost in favourites, scattered across group chats. The long reads you meant to keep usually survive as one dead link.

**This plugin does one thing, and does it cleanly: it watches the Official Accounts already on your own WeRead shelf, saves new articles as they appear, and writes them into your vault as Markdown — images and media included.**

- Talks directly to **your own** WeRead account. No third-party relay server.
- Does not touch the WeChat client, does not break any service, keeps no account pool.
- Free. The only optional cost is the LLM tokens you configure yourself.

```
WeRead shelf  ──▶  plugin poller  ──▶  your vault
 subscribed accounts   manual / timed     text + images + audio + video
```

## Why it is worth installing

| What you deal with today | What you get |
|---|---|
| Articles you want to keep sink in the feed | One folder per account, easy to browse |
| Copy-paste into Obsidian loses every image | Images downloaded into a local `assets/` folder |
| Saved links 404 six months later | Full text on disk, immune to link rot |
| Podcast / video posts can only be watched | Direct media URLs downloaded and embedded with native players |
| No way to backfill an account's history | Full-archive per account, newest first, per-article retry |

## Features

| | |
|---|---|
| **Scan to sign in** | Embedded WeRead login window; scan once with WeChat. No cookie copying |
| **Your shelf is the subscription list** | Every Official Account on your WeRead shelf is listed and searchable |
| **Automatic collection** | Configurable poller saves new articles and shows progress, countdown and last-run results |
| **Full archive per account** | Backfill an account's history newest-first with per-article status and retry |
| **Faithful content** | HTML to Markdown; image extensions detected from magic bytes (WeChat CDN serves PNG under `.jpg`) |
| **Media saved locally** | Audio and video downloaded and embedded with `<audio>` / `<video>` players |
| **Four layouts** | Card grid, waterfall, list, title-only; persistent account sidebar |
| **Two themes** | Linear neutral or the Zisuzi brand theme |
| **Optional AI step** | Any OpenAI-compatible endpoint (DeepSeek preset included): summarise, extract quotes, draft a comment, write the result back into the note |
| **Optional local agent** | Call a CLI you already have (Hermes, Claude Code, Codex, Kimi, Gemini, Cursor). Nothing is uploaded |

> AI processing and the local agent are **off by default** and require your own key or command.

```mermaid
flowchart LR
  A["Scan to sign in<br/>embedded window"] --> B["Read shelf<br/>subscribed accounts"]
  B --> C["Poller<br/>30 min default"]
  C --> D["Fetch new article list"]
  D --> E["Fetch body + download media"]
  E --> F["HTML to Markdown"]
  F --> G["Write into vault<br/>微信读书公众号/"]
  G --> H["Optional: AI summary<br/>Optional: local agent"]
```

## Interface

<div align="center">
  <img src="assets/ui-demo.jpg" alt="Zisuzi-Weread-MP interface" width="100%" />
  <br />
  <sub>Interface illustration with sample data. Accounts and articles are fictional; the installed build is authoritative.</sub>
</div>

- **Top bar**: sign-in state plus one-click actions (fetch once / full archive / settings)
- **Sidebar**: account list, tick to track, archived count per account
- **Main area**: card, waterfall, list and title-only views, each article carrying its archive status
- **Status bar**: last run result, progress, next countdown, auto-collect state

## Quickstart

**1. Install**

`Settings → Community plugins → Browse → search "Zisuzi-Weread-MP"` → Install → Enable.

Manual: download `main.js`, `manifest.json`, `styles.css` from [Releases](https://github.com/pixelxzen/Zisuzi-Weread-MP/releases), drop them into `<vault>/.obsidian/plugins/zisuzi-weread-mp/`, then reload and enable.

**2. Sign in**

`Settings → Zisuzi-Weread-MP` → **Sign in with QR code** → scan with WeChat. The window closes itself; avatar, nickname and shelf load automatically.

**3. Pick accounts**

Back in the plugin view, tick the Official Accounts you want to track. The list is searchable, even with hundreds of entries.

**4. Run**

Press **Fetch once** to test, or enable **auto-collect** and let it poll.

> The first shelf sync takes a few seconds up to half a minute depending on how many accounts you follow.

## Reading the login indicator

The dot on the login card in settings answers exactly one question: **does the web session actually work right now, as measured against the real API?**

| Colour | Meaning | What to do |
| --- | --- | --- |
| 🟢 Green | The list endpoint responded — fetching works | Nothing |
| 🟡 Amber | The login is valid, but the Official Account endpoint is rate-limiting this account (`-2041`) | **Do not re-scan** — it will not help. Wait out the cooldown, or use another account |
| 🔴 Red | The web session is gone (missing or expired cookies, usually `-2012`) | Click "Scan QR code" again |
| ⚪ Grey | Never measured | Opening settings runs a probe automatically; "Test list" works too |

Three layers, none of which replaces another:

| Layer | What it controls | How it fails |
| --- | --- | --- |
| Official key (`wrk-…`) | Reading your shelf and book metadata | Key missing — re-scan to exchange a new one |
| Web session (`wr_vid` / `wr_skey` / `wr_rt` / `wr_gid`) | Article lists, bodies, images, audio and video | Turns red — re-scan |
| The account itself | Whether the server is rate-limiting it | Turns amber — re-scanning does nothing |

## Nothing loads? Match your symptom first

Check the single plain-language line at the top of the settings tab — it already names the cause. The short version:

| What you see | Real cause | Do this | Never do this |
|---|---|---|---|
| `-2041` (amber) "MP endpoint restricted" | This **account** is restricted on the article-list endpoint only. Login, shelf and book info are fine | Open any article of that Official Account in the WeRead mobile app (complete the slider if shown), then click "verified in app, clear cooldown" | ❌ **Do not scan the QR code again** — it changes the session, not the permission, and only adds another hit |
| `-2012` / `-2010` (red) "session expired" | The session really expired (or was invalidated by repeated `-2041` hits) | Settings → Sign out → Scan to sign in | ❌ Do not spam refresh during cooldown |
| "Daily quota reached" | The plugin applied its own brake; the account is fine | Try tomorrow; archived notes are untouched | ❌ Do not raise the quota/interval just to keep going |
| One account empty, others fine | WeRead does not index that account | Open one of its articles in the app, then "Sync shelf" | — |

Verify it yourself in 30 seconds (two requests, same cookie):

```bash
# ① Session: returns {"userVid":…,"name":"<your name>",…} when valid
curl -s "https://weread.qq.com/web/user?userVid=<your vid>" \
  -H "Cookie: <cookie from the settings tab>" -H "Referer: https://weread.qq.com/"

# ② Article list: this is where -2041 comes from
curl -s "https://weread.qq.com/web/mp/articles?bookId=MP_WXS_xxxx&offset=0" \
  -H "Cookie: <same cookie>" -H "Referer: https://weread.qq.com/web/mp/MP_WXS_xxxx"
```

① has a name and ② returns `-2041` → the login is healthy, the account is throttled. ① also fails → the session is really gone.

**Why it happens:** the list endpoint is a private API with no published quota. Community experience puts the safe line at roughly **10 accounts × 2 refreshes per day (≈20 list requests/day)** per WeRead account. Exceed it and you get a slider challenge; keep exceeding it and you land in a ~24-hour penalty box. 4.5.0 encodes that as hard limits.

## Fetch cadence: why it is not "fast"

| Parameter | Default | Why this number |
|---|---|---|
| Poll interval | **240 min** | 3 accounts × 6 runs/day ≈ 18 list requests, inside the safe line |
| Articles per run | **3** | Article requests are counted separately; they get throttled too |
| Per-account per-run | 2 | Spreads requests across accounts |
| List delay | 1.2 s | Between consecutive list requests |
| Content delay | 2.5 s | Between consecutive article requests |

More accounts → longer interval: 4–6 accounts ≈ 360 min, 7–10 ≈ 480 min, beyond that split accounts or use manual runs only.

### Three brakes added in 4.5.0

1. **Daily budget** — list and content requests each get `accounts × 20` per day; exceeding it raises a clear budget notice, not a fake "session expired".
2. **Cooldown with exponential backoff** — 60 min on the first `-2041`, then 120 / 240 / 480 min; one successful list call resets it.
3. **No requests during cooldown** — refresh, auto-watch and the settings-tab probe are all short-circuited, so "retry every hour" cannot become "hit them every hour".

> On `-2010` / `-2012` / `-2041` the plugin **stops immediately, does not retry**, and pauses auto-watch by itself.
> Do not lower these values for speed. The cost is your WeRead account being throttled, not the plugin crashing.

## Network and privacy

The plugin only contacts the hosts below. No telemetry, no analytics, no remote code loading.

| Host | Purpose |
|---|---|
| `weread.qq.com` | Sign-in, shelf, article list and content, media URLs |
| `i.weread.qq.com` | Official Agent API (account list only) |
| `thirdwx.qlogo.cn` | WeRead avatar image |
| Your configured LLM endpoint | Only when you enable and trigger AI; off by default |
| Your local CLI | Only when you enable and trigger the local agent; off by default |

- Credentials are stored in plain text in `<vault>/.obsidian/plugins/zisuzi-weread-mp/data.json`. **Never sync that file to a public location.** "Sign out" clears it.
- During QR login the plugin reads Obsidian's own Chromium cookie store once (macOS: `~/Library/Application Support/obsidian/Cookies`), taking **only a few `weread.qq.com` login fields**, and deletes the temporary copy immediately — nothing is written to disk or uploaded. Reason: `wr_vid` / `wr_skey` / `wr_rt` are HttpOnly and therefore invisible to `document.cookie`, so the login window would otherwise keep reporting them as missing. On Windows, if that store is encrypted, the plugin falls back to manual cookie paste.
- With AI processing enabled, **the article body is sent to the endpoint you configured**. Off by default, requires your explicit opt-in and key.
- The local agent is off by default and only spawns a CLI process when you click.

## Limitations

- Only articles **already indexed by WeRead** can be archived — the same boundary every client-side tool hits.
- Image-only posts have no text container; they become a short note with summary and cover instead of being skipped.
- The endpoints are private and may change. That is the main maintenance cost of this plugin.
- **Desktop only** (the login window relies on Electron's `webview`), Obsidian 1.13.0 or newer.

## FAQ

**An account I follow is missing from the list.**
Make sure the account is searchable and readable inside the WeRead app itself. Accounts WeRead has not indexed cannot be reached by any client-side tool. Open any of its articles in WeRead once, then re-sync the shelf in the plugin.

**Some images are missing from a note.**
Network hiccups or CDN throttling. Use "Repair images of the current note" from the note menu, or the "Repair all notes with missing images" command.

**Login expired / every fetch fails suddenly.**
WeRead web sessions expire. Click **Sign out**, then scan again. Signing out stops collection and clears credentials; your archived notes are untouched.

**Can my account get banned?**
The plugin uses your own session at conservative delays and stops on the first rate-control response. Unless you drop the interval below 15 minutes or run several instances, the risk is comparable to browsing the web reader yourself. **These are private APIs — nobody can promise 100%.**

**Does it conflict with the Weread highlights plugin?**
No. That plugin syncs book highlights and notes; this one archives Official Account articles.

**Can it archive paid content?**
No. Only what your account can already read.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # typecheck + production build
npm test         # core unit tests (builds dist/core first)
```

Outputs `main.js` / `manifest.json` / `styles.css` at the repo root. Architecture notes and post-mortems live in [`docs/`](docs/).

## Contributing

- **Bugs / ideas**: [Issues](https://github.com/pixelxzen/Zisuzi-Weread-MP/issues) — include Obsidian version, plugin version and the error from `Settings → Community plugins → Debug`.
- **PRs**: welcome. Run `npm run build && npm test` and keep `eslint-plugin-obsidianmd` recommended at zero warnings.

## Credits

- Interaction and reading-surface patterns inspired by [`joeseesun/qiaomu-ai-rss`](https://github.com/joeseesun/qiaomu-ai-rss) (GPL-3.0-only)
- WeRead API practice informed by [`zhaohongxuan/obsidian-weread-plugin`](https://github.com/zhaohongxuan/obsidian-weread-plugin) (MIT)

## Star History

[![RepoStars](https://repostars.dev/api/embed?repo=pixelxzen%2FZisuzi-Weread-MP&theme=grape)](https://repostars.dev/?repos=pixelxzen%2FZisuzi-Weread-MP&theme=grape)

## License

**GPL-3.0-only**

Copyright © 2026 Creative by [紫苏子ACG](https://github.com/pixelxzen)
