#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Zisuzi-Weread-MP 一键安装：Obsidian 插件 + 跨 agent 技能包
#
#   一句话安装（复制给任何智能体或终端）：
#     curl -fsSL https://cdn.jsdelivr.net/gh/pixelxzen/Zisuzi-Weread-MP@master/install.sh | bash
#
#   常用参数：
#     --vault "/path/to/YourVault"   指定库（不传则自动探测 Obsidian 记录的库）
#     --tag 4.6.0                    指定版本（默认取最新 release）
#     --plugin-only / --skills-only  只装其中一半
#     --outdir "微信读书公众号"        笔记输出目录名（写进 skill）
#     --dry-run                      只打印要做什么，不落盘
#
#   环境变量等价：ZWM_VAULT / ZWM_TAG / ZWM_OUTDIR
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="${ZWM_REPO:-pixelxzen/Zisuzi-Weread-MP}"
PLUGIN_ID="zisuzi-weread-mp"
SKILL_NAME="weread-mp-vault"

VAULT="${ZWM_VAULT:-}"
TAG="${ZWM_TAG:-}"
OUTDIR="${ZWM_OUTDIR:-微信读书公众号}"
DO_PLUGIN=1
DO_SKILLS=1
DO_MONITOR=1
DRY=0

c_ok()   { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
c_info() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
c_warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
c_die()  { printf '\033[1;31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --vault)        VAULT="$2"; shift 2 ;;
    --tag)          TAG="$2"; shift 2 ;;
    --outdir)       OUTDIR="$2"; shift 2 ;;
    --plugin-only)  DO_SKILLS=0; shift ;;
    --skills-only)  DO_PLUGIN=0; shift ;;
    --no-monitor)   DO_MONITOR=0; shift ;;
    --dry-run)      DRY=1; shift ;;
    -h|--help)      sed -n '3,20p' "$0"; exit 0 ;;
    *)              c_die "未知参数：$1（--help 看用法）" ;;
  esac
done

need() { command -v "$1" >/dev/null 2>&1 || c_die "缺少依赖：$1"; }
need curl
need python3

# ------------------------------- 1. 找 vault -------------------------------
detect_vaults() {
  local cfg=""
  for c in "${HOME}/Library/Application Support/obsidian/obsidian.json" "${HOME}/.config/obsidian/obsidian.json"; do
    [ -f "${c}" ] && cfg="${c}" && break
  done
  [ -z "${cfg}" ] && return 1
  python3 - "${cfg}" <<'PY'
import json, sys, os
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
for v in (d.get('vaults') or {}).values():
    p = v.get('path')
    if p and os.path.isdir(p):
        print(p)
PY
}

if [ -z "${VAULT}" ]; then
  mapfile -t CANDIDATES < <(detect_vaults || true)
  if [ "${#CANDIDATES[@]}" -eq 1 ]; then
    VAULT="${CANDIDATES[0]}"
  elif [ "${#CANDIDATES[@]}" -gt 1 ]; then
    c_warn "本机有 ${#CANDIDATES[@]} 个 Obsidian 库，需要指定一个："
    for v in "${CANDIDATES[@]}"; do printf '    %s\n' "${v}"; done
    c_die "重跑并加参数：--vault \"<上面某个路径>\""
  else
    c_die "没找到 Obsidian 的库记录；请用 --vault \"/你的库路径\" 指定"
  fi
fi

[ -d "${VAULT}/.obsidian" ] || c_die "这个路径不像 Obsidian 库（缺 .obsidian）：${VAULT}"
[ "${VAULT}" = "${HOME}" ] && c_die "拒绝把库设在 ${HOME}"

PLUGIN_DIR="${VAULT}/.obsidian/plugins/${PLUGIN_ID}"

# ------------------------------- 2. 定版本 ---------------------------------
if [ -z "${TAG}" ]; then
  TAG=$(curl -fsSL --max-time 10 "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
        | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tag_name",""))
except Exception: print("")' 2>/dev/null || true)
  [ -z "${TAG}" ] && TAG="master" && c_warn "取不到最新 release 版本号，回退 master 分支"
fi

c_info "库：${VAULT}"
c_info "版本：${TAG}"
c_info "输出目录：${OUTDIR}"
[ "${DRY}" = "1" ] && c_warn "dry-run：只打印，不落盘"

TMP=$(mktemp -d)
trap 'rm -rf "${TMP}"' EXIT

# ------------------------------- 3. 下载 -----------------------------------
# 多镜像回退：jsDelivr（国内可达性好）→ GitHub raw
fetch_file() { # $1=仓库内路径  $2=落地文件
  local path="$1" dest="$2" url
  # 本地仓库模式（离线安装 / 自测）：ZWM_SRC=<仓库根>
  if [ -n "${ZWM_SRC:-}" ] && [ -f "${ZWM_SRC}/${path}" ]; then
    cp "${ZWM_SRC}/${path}" "${dest}"
    return 0
  fi
  # 1) jsDelivr（国内通常最快）
  # 2) GitHub raw（有代理时最直接）
  for base in \
    "https://cdn.jsdelivr.net/gh/${REPO}@${TAG}" \
    "https://raw.githubusercontent.com/${REPO}/${TAG}"
  do
    url="${base}/${path}"
    if curl -fsSL --max-time 60 "${url}" -o "${dest}" 2>/dev/null && [ -s "${dest}" ]; then
      return 0
    fi
  done
  # 3) api.github.com 的 raw 媒体类型：github.com / raw 都被墙时，这个域名往往还通
  #    （实测：某些网络下只有 api.github.com 可达）
  if curl -fsSL --max-time 90 -H "Accept: application/vnd.github.raw" \
       -H "X-GitHub-Api-Version: 2022-11-28" \
       "https://api.github.com/repos/${REPO}/contents/${path}?ref=${TAG}" \
       -o "${dest}" 2>/dev/null && [ -s "${dest}" ]; then
    return 0
  fi
  # 4) 公共加速代理兜底
  for host in "https://gh-proxy.com" "https://ghfast.top"; do
    if curl -fsSL --max-time 60 "${host}/https://raw.githubusercontent.com/${REPO}/${TAG}/${path}" -o "${dest}" 2>/dev/null && [ -s "${dest}" ]; then
      return 0
    fi
  done
  return 1
}

if [ "${DO_PLUGIN}" = "1" ]; then
  c_info "下载插件三件套…"
  for f in main.js manifest.json styles.css; do
    fetch_file "${f}" "${TMP}/${f}" || c_die "下载失败：${f}（三个镜像都不通，检查网络或代理）"
  done
  # 硬校验：manifest 里 version 必须与 TAG 对得上（main 分支时跳过）
  MAN_VER=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "${TMP}/manifest.json")
  MAIN_SIZE=$(wc -c < "${TMP}/main.js" | tr -d ' ')
  [ "${MAIN_SIZE}" -gt 100000 ] || c_die "main.js 只有 ${MAIN_SIZE} 字节，下载不完整"
  c_ok "manifest version=${MAN_VER} · main.js ${MAIN_SIZE}B"
fi

# ------------------------------- 4. 装插件 ---------------------------------
if [ "${DO_PLUGIN}" = "1" ]; then
  if [ "${DRY}" = "1" ]; then
    c_info "[dry-run] 会写入 ${PLUGIN_DIR}/{main.js,manifest.json,styles.css}"
  else
    mkdir -p "${PLUGIN_DIR}"
    for f in main.js manifest.json styles.css; do
      [ -f "${PLUGIN_DIR}/${f}" ] && cp "${PLUGIN_DIR}/${f}" "${PLUGIN_DIR}/${f}.bak.$(date +%Y%m%d-%H%M%S)"
      mv "${TMP}/${f}" "${PLUGIN_DIR}/${f}"
    done
    c_ok "插件已装到 ${PLUGIN_DIR}"
  fi
fi

# ------------------------------- 5. 装 skill -------------------------------
if [ "${DO_SKILLS}" = "1" ]; then
  c_info "生成技能包 SKILL.md…"
  fetch_file "skill/${SKILL_NAME}/SKILL.md.tmpl" "${TMP}/SKILL.md.tmpl" || c_die "下载 SKILL 模板失败"
  fetch_file "skill/${SKILL_NAME}/workbuddy.json" "${TMP}/workbuddy.json" || true
  python3 - "${TMP}/SKILL.md.tmpl" "${TMP}/SKILL.md" "${VAULT}" "${OUTDIR}" <<'PY'
import sys
tpl, out, vault, outdir = sys.argv[1:5]
s = open(tpl, encoding='utf-8').read()
open(out, 'w', encoding='utf-8').write(s.replace('@@VAULT@@', vault).replace('@@OUTDIR@@', outdir))
PY
  for d in .hermes/skills .workbuddy/skills .claude/skills .codex/skills .gemini/skills .cursor/skills; do
    target="${HOME}/${d}/${SKILL_NAME}"
    if [ "${DRY}" = "1" ]; then
      c_info "[dry-run] 会写入 ${target}/SKILL.md"
      continue
    fi
    mkdir -p "${target}"
    cp "${TMP}/SKILL.md" "${target}/SKILL.md"
    [ -f "${TMP}/workbuddy.json" ] && cp "${TMP}/workbuddy.json" "${target}/workbuddy.json"
    c_ok "skill → ${target}"
  done
  # 库里也留一份源：任何 agent 都能「复制这个目录到你的 skills 目录」自装
  if [ "${DRY}" != "1" ]; then
    src="${VAULT}/.agent-skills/${SKILL_NAME}"
    mkdir -p "${src}"
    cp "${TMP}/SKILL.md" "${src}/SKILL.md"
    [ -f "${TMP}/workbuddy.json" ] && cp "${TMP}/workbuddy.json" "${src}/workbuddy.json"
    c_ok "源目录 → ${src}"
  fi
fi

# --------------------------- 5b. 装抓取 skill -----------------------------
# 抓取 skill（扫码登录 / 定时盯采 / 全量历史）比「读归档」重：要 node + playwright。
# 这里只铺文件与配置，node 依赖让用户第一次跑时按提示装。
if [ "${DO_MONITOR}" = "1" ]; then
  MON_DIR="${HOME}/.weread-monitor"
  MON_FILES="SKILL.md
references/media-extraction.md
references/account-and-shelf-quota.md
references/error-codes.md
scripts/weread_mp_monitor.js
scripts/gen_feed.py
scripts/summary.py
scripts/watch.sh
scripts/run-once.sh
scripts/plugin_cookie_check.py
scripts/install-launchd.sh
templates/config.example.json
templates/com.zishen.weread-mp.plist
templates/com.zishen.weread-mp-summary.plist"

  if [ "${DRY}" = "1" ]; then
    c_info "[dry-run] 会装抓取 skill → 6 家 skills 目录 + ${MON_DIR}"
  else
    mkdir -p "${TMP}/monitor"
    while IFS= read -r rel; do
      [ -z "${rel}" ] && continue
      mkdir -p "${TMP}/monitor/$(dirname "${rel}")"
      fetch_file "skill/weread-mp-monitor/${rel}" "${TMP}/monitor/${rel}" || c_die "下载失败：skill/weread-mp-monitor/${rel}"
    done <<< "${MON_FILES}"

    for d in .hermes/skills .workbuddy/skills .claude/skills .codex/skills .gemini/skills .cursor/skills; do
      mkdir -p "${HOME}/${d}"
      rm -rf "${HOME}/${d}/weread-mp-monitor"
      cp -R "${TMP}/monitor" "${HOME}/${d}/weread-mp-monitor"
    done
    c_ok "抓取 skill → 6 家 skills 目录"

    mkdir -p "${MON_DIR}/logs"
    cp -R "${TMP}/monitor/scripts/." "${MON_DIR}/"
    chmod +x "${MON_DIR}"/*.sh 2>/dev/null || true
    if [ ! -f "${MON_DIR}/config.json" ]; then
      python3 - "${TMP}/monitor/templates/config.example.json" "${MON_DIR}/config.json" "${VAULT}/${OUTDIR}" <<'PY'
import json, sys
src, dst, obs = sys.argv[1:4]
d = json.load(open(src, encoding='utf-8'))
d['obsidianDir'] = obs
d['accounts'] = []  # 别把示例号带进用户配置
json.dump(d, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY
      c_ok "生成 ${MON_DIR}/config.json（obsidianDir=${VAULT}/${OUTDIR}）"
    else
      c_warn "已存在 ${MON_DIR}/config.json，保留不动（要改路径请手编辑）"
    fi
  fi

  command -v node >/dev/null 2>&1 || c_warn "没装 node 18+：抓取 skill 需要它，装好后重跑本脚本"
fi

# ------------------------------- 6. 下一步 ---------------------------------
cat <<EOF

────────────────────────────────────────────
装好了。Obsidian 里两步（一次就好）：
  1. 重启 Obsidian → 设置 → 第三方插件 → 启用「Zisuzi-Weread-MP」
  2. 打开它的设置页 → 点「扫码登录」，微信扫一下

装了的两个技能（任意智能体里都能用）：
  weread-mp-vault    读归档：「统计我的公众号归档」「哪个号还差几篇」
  weread-mp-monitor  抓取器：扫码登录 / 定时盯采 / 全量历史归档

第一次抓历史，终端里跑（三行）：
  cd ~/.weread-monitor
  npm i playwright-core && npx playwright install chromium
  node weread_mp_monitor.js --login          # 扫码登录你自己的账号

之后要什么：
  node weread_mp_monitor.js --dry-run                    # 预检：每号最新几条、未处理多少
  node weread_mp_monitor.js --backfill "某个号" --max 30  # 分批归档历史（可反复跑到抓完）
  bash scripts/install-launchd.sh                        # 每 30 分钟自动盯采（macOS）
  python3 gen_feed.py                                    # 顺手生成 RSS

风控纪律（插件与脚本共用同一套，别调太快）：
  · 列表请求 ≤8 次/分钟，单页间隔 ≥2.5s（插件已内置）
  · 单批 ≤30 篇，批间隔 ≥10 分钟
  · 撞到 -2041 用手机微信读书 App 打开该号任一篇文章，当日解除；别反复重扫
────────────────────────────────────────────
EOF
