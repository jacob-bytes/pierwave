#!/usr/bin/env bash
# flaky 测试基线：同一份代码连跑 N 次 `cargo test --workspace`，
# 输出每次的 pass/fail 与耗时；任一次失败就打印该次的失败用例名并以非零退出。
#
# 为什么需要它：CI 每次只跑一遍，偶发失败通常被「重跑一次就绿」掩盖，
# 真正的数据竞争/时序问题因此长期留在主干上。基线跑 N 次能把它暴露出来，
# 也让「这次失败是不是 flaky」有据可查（失败日志按 run 号保留）。
#
# 用法：
#   ./scripts/flaky-baseline.sh              # 连跑 10 次（默认）
#   ./scripts/flaky-baseline.sh 3            # 连跑 3 次（本地快速自检）
#   FLAKY_RUNS=20 ./scripts/flaky-baseline.sh
#   FLAKY_FAIL_FAST=1 ./scripts/flaky-baseline.sh   # 第一次失败就停
#   KEEP_LOGS=1 ./scripts/flaky-baseline.sh         # 全绿也保留日志
#   FLAKY_TEST_ARGS="-p pierwave-domain" ./scripts/flaky-baseline.sh
#                                                   # 只跑某个包（默认 --workspace）
#
# 环境：
#   CARGO_HOME   默认 $PWD/.cargo-home（本机沙箱不允许写 ~/.cargo）
#   FLAKY_WORK   日志目录，默认 mktemp -d
#
# 退出码：0 = 全部通过；1 = 至少一次失败（或参数/环境错误）。
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD

# ---- 参数 ----
RUNS="${FLAKY_RUNS:-${1:-10}}"
case "$RUNS" in
  ''|*[!0-9]*)
    echo "FAIL: 运行次数必须是正整数，实际收到 '${RUNS}'" >&2
    exit 1
    ;;
esac
if [ "$RUNS" -lt 1 ]; then
  echo "FAIL: 运行次数必须 >= 1，实际 ${RUNS}" >&2
  exit 1
fi

# ---- 缓存目录：与 Makefile 保持一致 ----
if [ -z "${CARGO_HOME:-}" ] && [ -d "$ROOT/.cargo-home" ]; then
  export CARGO_HOME="$ROOT/.cargo-home"
fi
if [ -z "${NPM_CONFIG_CACHE:-}" ] && [ -d "$ROOT/.npm-cache" ]; then
  export NPM_CONFIG_CACHE="$ROOT/.npm-cache"
fi

# ---- 时间与日志 ----
# macOS 的 date 没有 %N；python3 在仓库脚本里已经是硬依赖（e2e.sh 也用），
# 但仍留一个纯 shell 兜底，避免为了计时多出一个前置条件。
if command -v python3 >/dev/null 2>&1; then
  now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
else
  now() { date +%s; }
fi

WORK="${FLAKY_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/pierwave-flaky.XXXXXX")}"
mkdir -p "$WORK"
# 默认与 CI 完全一致（--workspace）；调成单个包用来看清「到底哪个包在抖」。
TEST_ARGS="${FLAKY_TEST_ARGS:---workspace}"
printf '日志目录: %s\n' "$WORK"
printf '测试命令: cargo test %s\n' "$TEST_ARGS"

# 失败用例名解析：cargo/libtest 把失败列表放在 `failures:` 段，
# 每行缩进 4 空格；同一段可能被多个测试二进制重复打印，这里去重。
failed_cases() {
  local log=$1
  awk '
    /^failures:$/ { in_failures = 1; next }
    in_failures && /^[[:space:]]*$/ { in_failures = 0; next }
    in_failures {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+$/, "", line)
      # 排除 doc-test 的 "---- xxx stdout ----" 标题与嵌套的 "failures:" 行
      if (line != "" && line !~ /^----/ && line != "failures:") print line
    }
  ' "$log" | awk '!seen[$0]++'
}

# 表格宽度按最长内容算，避免某次失败名字很长时把表挤歪。
run_width=${#RUNS}
result_width=6
dur_width=10

printf '\n%-*s  %-*s  %-*s  %s\n' \
  "$run_width" "#" "$result_width" "结果" "$dur_width" "耗时(s)" "失败用例"
printf '%s\n' "----------------------------------------------------------------------"

failed_runs=0
: >"$WORK/failed-names.txt"
total_start=$(now)

for i in $(seq 1 "$RUNS"); do
  log="$WORK/run-${i}.log"
  # 进度写 stderr：stdout 只留汇总表，CI 里 tee 出来的就是一张干净的表。
  printf 'run %d/%d ... ' "$i" "$RUNS" >&2
  start=$(now)
  rc=0
  # 与 CI 的 `make test` 等价（默认 --workspace、同样的默认特性）；
  # 不用 --quiet，否则失败时拿不到用例名。
  # shellcheck disable=SC2086  # 允许 FLAKY_TEST_ARGS 里带多个参数
  cargo test $TEST_ARGS >"$log" 2>&1 || rc=$?
  end=$(now)
  duration=$(awk -v a="$start" -v b="$end" 'BEGIN { printf "%.1f", b - a }')

  if [ "$rc" -eq 0 ]; then
    printf 'pass\n' >&2
    printf '%-*s  %-*s  %-*s  %s\n' \
      "$run_width" "$i" "$result_width" "PASS" "$dur_width" "$duration" "-"
  else
    printf 'FAIL（rc=%d）\n' "$rc" >&2
    names=$(failed_cases "$log" | paste -sd ',' - | sed 's/,/, /g')
    [ -n "$names" ] || names="（未能从日志解析出用例名，见 ${log}）"
    printf '%-*s  %-*s  %-*s  %s\n' \
      "$run_width" "$i" "$result_width" "FAIL" "$dur_width" "$duration" "$names"
    failed_runs=$((failed_runs + 1))
    # 逐行记录，最后按出现次数汇总：十次失败如果都是同一批用例，
    # 那是一个真问题；如果是不同用例，才更像环境抖动。
    printf '%s\n' "$names" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
      >>"$WORK/failed-names.txt"
    if [ "${FLAKY_FAIL_FAST:-0}" = "1" ]; then
      echo
      echo "FAIL: 第 ${i} 次失败，已按 FLAKY_FAIL_FAST=1 停止"
      echo "      日志：${log}"
      echo "      失败用例：${names}"
      exit 1
    fi
  fi
done

total_end=$(now)
total_duration=$(awk -v a="$total_start" -v b="$total_end" 'BEGIN { printf "%.1f", b - a }')
passed_runs=$((RUNS - failed_runs))

printf '%s\n' "----------------------------------------------------------------------"
printf '汇总: 共 %d 次，pass %d，fail %d，总耗时 %s s\n' \
  "$RUNS" "$passed_runs" "$failed_runs" "$total_duration"

if [ "$failed_runs" -gt 0 ]; then
  echo
  echo "FAIL: ${failed_runs}/${RUNS} 次运行失败（同一份代码跑多次结果不同 ⇒ flaky 或真实竞态）"
  echo "      失败用例（按出现次数）："
  sort "$WORK/failed-names.txt" | uniq -c | sort -rn | sed 's/^/        /'
  echo "      失败日志都保留在：${WORK}"
  exit 1
fi

# 全绿时日志没有价值，清掉；KEEP_LOGS=1 时保留（排查「慢但通过」的用例有用）。
if [ "${KEEP_LOGS:-0}" = "1" ]; then
  echo "日志保留在：${WORK}（KEEP_LOGS=1）"
else
  rm -f "$WORK"/run-*.log
  rmdir "$WORK" 2>/dev/null || true
fi
echo "PASS: ${RUNS} 次运行全部通过"
