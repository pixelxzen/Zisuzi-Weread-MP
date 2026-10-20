#!/bin/bash
# 检查 GitHub latest release 与 Obsidian 社区站「Current release」是否一致。
# 不一致 = 忘了去后台点「Check for new releases」，弹 macOS 通知提醒。
#
# 用法：bash check-community-sync.sh [--quiet]
# 退出码：0 已同步 / 1 待同步（会弹通知） / 2 网络或接口异常

set -u
REPO="pixelxzen/Zisuzi-Weread-MP"
PLUGIN_ID="zisuzi-weread-mp"
STATE="${HOME}/.weread-monitor/community-sync.state"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

log() { [ "$QUIET" -eq 1 ] || echo "$@"; }

# 1) GitHub 上的最新版本（客户端真正会装的）
LATEST=$(curl -fsSL --max-time 30 \
  "https://github.com/${REPO}/releases/latest/download/manifest.json" 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["version"])' 2>/dev/null)
[ -z "${LATEST}" ] && { log "[err] 取不到 GitHub latest（网络？）"; exit 2; }

# 2) 社区站收录的最新版本（它的 RSS 直接反映 Current release）
COMM=$(curl -fsSL --max-time 30 \
  "https://community.obsidian.md/plugins/${PLUGIN_ID}/feed.xml" 2>/dev/null \
  | grep -o "Zisuzi-Weread-MP [0-9][0-9.]*" | head -1 | awk '{print $2}')
[ -z "${COMM}" ] && { log "[err] 取不到社区站 feed"; exit 2; }

log "GitHub latest: ${LATEST} | 社区站: ${COMM}"

# 自测：验证通知链路（不依赖真的存在版本差）
if [ "${1:-}" = "--self-test" ]; then
  COMM="0.0.0-selftest"
  log "[self-test] 强制走提醒分支"
fi

if [ "${LATEST}" = "${COMM}" ]; then
  log "[ok] 已同步"
  echo "${LATEST}" > "${STATE}" 2>/dev/null || true
  exit 0
fi

# 同一个未同步版本只提醒一次（避免每天弹同一个）
LAST=""
[ -f "${STATE}" ] && LAST=$(cat "${STATE}" 2>/dev/null)
if [ "${LAST}" = "pending:${LATEST}:${COMM}" ]; then
  log "[skip] ${LATEST} 已提醒过（社区站仍 ${COMM}）"
  exit 1
fi

MSG="GitHub 已是 ${LATEST}，社区站还停在 ${COMM} —— 去后台点 Check for new releases"
log "[todo] ${MSG}"

# macOS 通知（零配置、一定看得见）
if command -v osascript >/dev/null 2>&1; then
  osascript -e "display notification \"${MSG}\" with title \"Zisuzi-Weread-MP 发版提醒\" sound name \"Glass\"" 2>/dev/null || true
fi

mkdir -p "$(dirname "${STATE}")" 2>/dev/null
echo "pending:${LATEST}:${COMM}" > "${STATE}" 2>/dev/null || true
exit 1
