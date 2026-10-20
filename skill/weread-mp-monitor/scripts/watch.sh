#!/bin/bash
# 微信读书公众号盯采 · 常驻守护脚本
# 用法：
#   nohup bash watch.sh 30 > /tmp/weread-watch.log 2>&1 &     # 每 30 分钟一轮
#   tail -f /tmp/weread-watch.log                             # 看日志
#   pkill -f "weread_mp_monitor.js"                           # 停止
# 参数：第 1 个是间隔分钟数（默认 30，风控建议不要低于 15），其余参数原样传给主脚本（如 --dry-run / --only "a,b"）
set -u
INTERVAL="${1:-30}"
shift || true
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

echo "[watch] 启动：每 ${INTERVAL} 分钟一轮，附加参数：$* "
while true; do
  echo ""
  echo "================= $(date '+%F %T') 开始一轮 ================="
  node weread_mp_monitor.js --json-out /tmp/weread-mp.json "$@" 2>&1
  code=$?
  case $code in
    0) echo "[watch] 本轮正常结束" ;;
    4) echo "[watch] ⚠️ 命中风控，暂停 3 小时后重试（不做密集重试）"; sleep 10800; continue ;;
    *) echo "[watch] 本轮异常退出（exit=$code）" ;;
  esac
  echo "[watch] 下一轮在 ${INTERVAL} 分钟后（$(date -v+${INTERVAL}M '+%F %T')）"
  sleep $((INTERVAL * 60))
done
