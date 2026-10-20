#!/bin/bash
# launchd 单轮执行器（幂等、带日志与风控标记）
set -u
DIR="$HOME/.weread-monitor"
LOG="$DIR/logs/monitor.log"
mkdir -p "$DIR/logs"
# launchd 不继承 shell PATH：把常见的 node / 包管理器目录都带上（按需增删）
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.hermes/node/bin:$HOME/.nvm/versions/node/current/bin:$HOME/.volta/bin:/usr/bin:/bin:/usr/sbin:/sbin"

{
  echo ""
  echo "=========== $(date '+%F %T') 开始一轮 ==========="
  cd "$DIR" || exit 1
  node weread_mp_monitor.js --json-out "$DIR/last-run.json"
  code=$?
  echo "[exit=$code] $(date '+%F %T') 结束"
  case $code in
    0) : ;;
    4) echo "!! RISK: 命中风控/登录失效 —— 需要人工重跑: node weread_mp_monitor.js --login" ;;
    *) echo "!! 异常退出 exit=$code" ;;
  esac
} >> "$LOG" 2>&1

# 每轮结束后重建 RSS（纯本地文件处理，开销可忽略）
if [ -f "$DIR/gen_feed.py" ]; then
  python3 "$DIR/gen_feed.py" >> "$LOG" 2>&1 || echo "[warn] gen_feed 失败" >> "$LOG"
fi

# 日志轮转（>5MB 归档一份）
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG")" -gt 5000000 ]; then
  mv "$LOG" "$LOG.1"
fi
exit 0
