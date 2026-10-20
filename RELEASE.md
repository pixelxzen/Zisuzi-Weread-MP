# 发版流程（每次都要走完）

> 这份清单存在的唯一原因：**GitHub 发 release 不会自动进 Obsidian 社区站**，
> 必须在开发者后台手动点一次「Check for new releases」。
> 漏了这一步，社区站会一直停在旧版本（本仓库曾因此积压 5 个版本：4.4.4 → 4.6.3）。

## 六步

### 1. 改版本号（三处必须一致）

```bash
# manifest.json / package.json 的 version，versions.json 增加新键
```

`manifest.json` 的 `version` 决定客户端装哪一版；tag 名必须与它**完全一致**（`4.6.4`，不带 `v`）。

### 2. 构建 + 测试

```bash
npm run build      # tsc -noEmit && esbuild production
npm test           # 26 条；有失败不许发
md5 -q main.js     # 记住这个值，CI 会做 byte-for-byte 比对
```

### 3. 提交 master 并推送

```bash
git add -A && git commit -m "release X.Y.Z: ..."
git push origin master
```

### 4. 打 annotated tag 触发 CI

```bash
git tag -a X.Y.Z -m "X.Y.Z"
git push origin X.Y.Z
```

**不要用 `gh release create` 手动发。** 手发会绕过 `.github/workflows/release.yml`，
导致 release 资产缺少 build provenance attestation —— 社区 review 的 `RELEASES`
检查项会挂（4.4.4 是 Pass，4.5.0～4.6.1 都是手发的，见 `docs` 里的 review 记录）。

### 5. 等 CI 出 draft，再发布

```bash
gh run list --limit 2          # 等到 completed/success
gh release edit X.Y.Z --draft=false
curl -sL https://github.com/pixelxzen/Zisuzi-Weread-MP/releases/latest/download/manifest.json
```

CI 的 `release.yml` 是幂等的（`create || true` + `upload --clobber`），
重推同一个 tag 不会因为 `HTTP 422 ReleaseAsset.name already exists` 挂掉。

### 6. 去社区后台点一次「Check for new releases」← **最容易忘，必须做**

<https://community.obsidian.md/account/plugins/zisuzi-weread-mp/check-release>

点完会显示 `Your manifest points at version X.Y.Z. A scan has been queued.`，
然后 Reviews 里出现一条 `Pending` → 几分钟后 `Completed` → **Current release 自动更新**。

验证：

```bash
bash scripts/check-community-sync.sh
# GitHub latest: X.Y.Z | 社区站: X.Y.Z
# [ok] 已同步
```

不一致时它会弹一条 macOS 通知（`--self-test` 可自测通知链路）。

## 自动提醒（已装在本机）

- launchd `com.zishen.weread-mp-community-sync`：**每天 10:00** 比对一次
  GitHub latest 与社区站 feed，不一致就弹通知，同一版本只提醒一次
- 日志：`~/.weread-monitor/logs/community-sync.log`
- 卸载：`launchctl unload ~/Library/LaunchAgents/com.zishen.weread-mp-community-sync.plist`

## 两条纪律（血泪）

1. **tag 用 annotated**（`git tag -a`），且 tag 名 = manifest 版本号，不带 `v`
2. **每次发版后都要点那个按钮** —— 客户端能装到新版，但社区站页面不会自己更新；
   用户看到 4.4.4 却装到 4.6.3，观感很差

## 附：review 里出现过的 Warning（不阻塞，别慌）

| 检查项 | 说明 |
|---|---|
| `Irregular whitespace not allowed` | 源码字符串里的全角空格 U+3000，改成半角（4.6.3 已清） |
| `README does not appear to contain English text` | README.md 必须有英文段（4.6.2 已加） |
| `README title does not match the manifest name` | README 首个 heading 必须是 Markdown `#` 标题，且文本等于 `manifest.name`（HTML `<h1>` 不认，master 已改） |
| `Unexpected aliasing of 'this'` / `Promise returned in void context` | 静态分析警告，涉及运行逻辑，不值得为消警告改源码 |
