#!/usr/bin/env bash
# 系统层验证：确认「面板里配的东西」和「机器上真实发生的事」一致。
#
# 与 verify-xray.sh 的区别：那个验证配置能被真实 Xray 接受；这个验证 Agent 真的
# 监听端口、真的加上了 tc 限速、以及**能正确还原**。
#
# 只读为主：除了 --cleanup（删掉我们自己的 1f00 qdisc）不做任何修改。
# 需要 root（ss -p 与 tc 都要）。
#
#   sudo ./scripts/verify-runtime.sh --forward-port 18443
#   sudo ./scripts/verify-runtime.sh --iface eth0 --rate-mbps 100
#   sudo ./scripts/verify-runtime.sh --cleanup
set -euo pipefail

IFACE=""
FORWARD_PORT=""
RATE_MBPS=""
CLEANUP=0
FAILED=0

ok()   { printf '  \033[32mok\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; }
say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --iface) IFACE="${2:-}"; shift 2 ;;
    --forward-port) FORWARD_PORT="${2:-}"; shift 2 ;;
    --rate-mbps) RATE_MBPS="${2:-}"; shift 2 ;;
    --cleanup) CLEANUP=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "需要 root（ss -p / tc）" >&2; exit 2; }
command -v tc >/dev/null 2>&1 || { echo "缺少 iproute2（tc）" >&2; exit 2; }

if [ -z "${IFACE}" ]; then
  IFACE="$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')"
fi
say "出口网卡：${IFACE:-未知}"

# ---------- 1. 转发是否真的在监听 ----------
if [ -n "${FORWARD_PORT}" ]; then
  say "检查转发监听 0.0.0.0:${FORWARD_PORT}"
  if ss -ltnp 2>/dev/null | grep -q ":${FORWARD_PORT} "; then
    ok "端口已监听"
    ss -ltnp 2>/dev/null | grep ":${FORWARD_PORT} " | sed 's/^/     /'
  else
    bad "端口没有监听：面板里保存后是否已下发？Agent 是否在线？"
  fi
fi

# ---------- 2. 限速规则是否生效 ----------
if [ -n "${IFACE}" ]; then
  say "检查 tc 限速（handle 1f00:）"
  QDISC="$(tc qdisc show dev "${IFACE}" 2>/dev/null || true)"
  if printf '%s' "${QDISC}" | grep -q '1f00:'; then
    ok "根队列里有我们的 htb"
    printf '%s\n' "${QDISC}" | grep '1f00:' | sed 's/^/     /'
    CLASSES="$(tc class show dev "${IFACE}" 2>/dev/null || true)"
    printf '%s\n' "${CLASSES}" | grep '1f00:' | sed 's/^/     /'
    if [ -n "${RATE_MBPS}" ]; then
      # 100 Mbps → 100000kbit
      WANT="$((RATE_MBPS * 1000))kbit"
      if printf '%s' "${CLASSES}" | grep -q "rate ${WANT}"; then
        ok "限速档位匹配（${WANT}）"
      else
        bad "没有找到 rate ${WANT} 的 class，实际见上"
      fi
    fi
  else
    warn "没有 1f00: 规则（未配置限速，或 Agent 尚未应用）"
    printf '%s\n' "${QDISC}" | sed 's/^/     /'
  fi
fi

# ---------- 3. 还原能力（可选）----------
if [ "${CLEANUP}" = "1" ] && [ -n "${IFACE}" ]; then
  say "清理我们自己的 qdisc（只删 handle 1f00:）"
  if tc qdisc show dev "${IFACE}" 2>/dev/null | grep -q '1f00:'; then
    tc qdisc del dev "${IFACE}" root handle 1f00: 2>/dev/null || true
    sleep 0.3
    if tc qdisc show dev "${IFACE}" 2>/dev/null | grep -q '1f00:'; then
      bad "删除后仍然存在，需要手动处理"
    else
      ok "已删除；当前根队列："
      tc qdisc show dev "${IFACE}" | sed 's/^/     /'
    fi
  else
    ok "没有残留规则"
  fi
fi

echo
if [ "${FAILED}" = "0" ]; then
  printf '\033[32mPASS\033[0m 系统层检查通过\n'
else
  printf '\033[31mFAIL\033[0m 有检查项未通过\n'
fi
exit "${FAILED}"
