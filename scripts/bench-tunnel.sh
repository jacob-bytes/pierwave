#!/usr/bin/env bash
# 隧道性能对比：本地回环基准 + 真实链路对比。
#
# 为什么两个模式：
#   --local  没有两台机器也能跑。测的是加密与拷贝的上限，与链路带宽无关。
#   --chain  真实链路对比：同一个目标，分别走直连与走隧道，比 iperf3 吞吐。
#            这才能回答"隧道是否比现有方案慢"。
#
# 用法：
#   ./scripts/bench-tunnel.sh --local
#   ./scripts/bench-tunnel.sh --chain 10.0.0.2:19402 --target 1.1.1.1:5201 --rate 200mbit
set -euo pipefail

MODE=""
CHAIN=""
TARGET=""
RATE=""
DURATION=15
PORT=5201

usage() {
  cat <<'USAGE'
用法:
  bench-tunnel.sh --local
  bench-tunnel.sh --chain <隧道入口 host:port> --target <iperf3 服务端 host:port> [--rate 200mbit] [--duration 15]

说明:
  --local      在本机跑回环基准（cargo test，release 构建）
  --chain      经隧道链跑 iperf3；请先把链的引擎配成 tunnel 并对端起 iperf3 -s
  --rate       （可选）本机对 veth 限速，用于在没有真实低带宽机器时模拟；需要 Linux + root
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) MODE=local; shift ;;
    --chain) MODE=chain; CHAIN="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --rate) RATE="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 2 ;;
  esac
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少命令: $1" >&2; exit 2; }; }

if [[ "$MODE" == "local" ]]; then
  need cargo
  echo "== 本机回环基准（与链路带宽无关） =="
  CARGO_HOME="${CARGO_HOME:-$PWD/.cargo-home}" \
    cargo test --release -q -p pierwave-agent bench_tunnel -- --ignored --nocapture 2>&1 \
    | grep -E "直接 TCP|经隧道|比值"
  echo
  echo "判读：绝对吞吐是隧道自身上限；比值低是正常的（直连回环是纯 memcpy）。"
  exit 0
fi

if [[ "$MODE" != "chain" ]]; then usage; exit 2; fi
[[ -n "$CHAIN" && -n "$TARGET" ]] || { echo "--chain 需要同时给 --target" >&2; exit 2; }
need iperf3

HOST="${CHAIN%%:*}"
PORT_T="${CHAIN##*:}"
T_HOST="${TARGET%%:*}"
T_PORT="${TARGET##*:}"

run_iperf() {
  local label="$1" h="$2" p="$3"
  local out
  out=$(iperf3 -c "$h" -p "$p" -t "$DURATION" -P 4 -J 2>/dev/null || true)
  if [[ -z "$out" ]]; then
    echo "${label}: 失败（对端未运行 iperf3 -s，或端口不通）"
    return 1
  fi
  python3 - "$label" <<'PY' <<<"$out"
import json,sys
label=sys.argv[1]
d=json.load(sys.stdin)["end"]
mbps=d["sum_received"]["bits_per_second"]/1e6 if "sum_received" in d else d["sum"]["bits_per_second"]/1e6
print(f"{label}: {mbps:.1f} Mbps")
PY
}

echo "== 真实链路对比（同一目标，同一时段） =="
direct=$(run_iperf "直连" "$T_HOST" "$T_PORT" || true)
tunnel=$(run_iperf "经隧道" "$HOST" "$PORT_T" || true)
echo "$direct"
echo "$tunnel"
echo
echo "判读：经隧道 / 直连 ≥ 0.85 视为可接受；再与 realm 引擎对比一次，≥ 0.90 说明不比现有方案差。"
echo "注意：--rate 只是本机 veth 限速的占位参数；真实带宽以实际链路为准。"
