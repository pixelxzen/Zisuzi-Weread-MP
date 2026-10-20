#!/bin/bash
# ---------------------------------------------------------------------------
# 生成并安装 launchd 定时任务（macOS）
#   - com.zishen.weread-mp          每 30 分钟增量盯采
#   - com.zishen.weread-mp-summary  每天 08:30 汇总
#
# 用法：bash scripts/install-launchd.sh [--interval 1800]
# 卸载：launchctl bootout gui/$(id -u)/com.zishen.weread-mp
# ---------------------------------------------------------------------------
set -euo pipefail

INTERVAL=1800
while [ $# -gt 0 ]; do
  case "$1" in
    --interval) INTERVAL="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TPL="$HERE/../templates"
MON="$HOME/.weread-monitor"
LA="$HOME/Library/LaunchAgents"

[ -d "$TPL" ] || { echo "找不到模板目录：$TPL" >&2; exit 1; }
mkdir -p "$MON/logs" "$LA"

# 1) 执行器
cp "$HERE/run-once.sh" "$MON/run-once.sh"
chmod +x "$MON/run-once.sh"

# 2) 渲染 plist：把模板里的 __USER__ 换成当前用户，按需改间隔
render() { # $1=模板名 $2=输出名
  sed -e "s|/Users/__USER__|$HOME|g" "$TPL/$1" > "$LA/$2.plist"
  plutil -lint "$LA/$2.plist" >/dev/null || { echo "plist 校验失败：$2" >&2; exit 1; }
}

render "com.zishen.weread-mp.plist" "com.zishen.weread-mp"
render "com.zishen.weread-mp-summary.plist" "com.zishen.weread-mp-summary"

# 3) 改间隔（模板默认 1800）
if [ "$INTERVAL" != "1800" ]; then
  /usr/libexec/PlistBuddy -c "Set :StartInterval $INTERVAL" "$LA/com.zishen.weread-mp.plist" 2>/dev/null || true
fi

# 4) 加载（先卸旧的，幂等）
UID_N=$(id -u)
for n in com.zishen.weread-mp com.zishen.weread-mp-summary; do
  launchctl bootout "gui/$UID_N/$n" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_N" "$LA/$n.plist"
  echo "✔ 已加载 $n"
done

echo
echo "看日志：tail -f $MON/logs/monitor.log"
echo "立即跑一轮：launchctl kickstart -k gui/$UID_N/com.zishen.weread-mp"
echo "改间隔：bash scripts/install-launchd.sh --interval 3600"
