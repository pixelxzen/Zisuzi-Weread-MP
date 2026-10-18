# Zisuzi-Weread-MP

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

---

---

中文文档见 [README.zh.md](README.zh.md).
