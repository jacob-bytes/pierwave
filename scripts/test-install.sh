#!/usr/bin/env bash
# install.sh 的自测：把脚本关进临时前缀，用 stub 的 systemctl 与本地假 release，
# 完整跑 install → status → upgrade → uninstall，断言文件布局与删除语义。
#
# 安全前提（缺一不可，任何一条不满足就立刻退出，绝不碰真机）：
#   1. PIERWAVE_PREFIX 必须是我们自己建的临时目录，且位于 $TMPDIR 下
#   2. systemctl 用 stub，绝不调用真 systemd
#   3. release 用本地目录，不走网络
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_SH="${ROOT}/scripts/install.sh"
[ -x "${INSTALL_SH}" ] || { echo "找不到 ${INSTALL_SH}"; exit 1; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/pierwave-install-test.XXXXXX")"
SANDBOX="$(cd "${SANDBOX}" && pwd -P)"

cleanup() { rm -rf "${SANDBOX}"; }
trap cleanup EXIT

# ---- 安全护栏：前缀必须在我们自己建的沙箱里 ----
case "${SANDBOX}" in
  "${TMPDIR:-/tmp}"/*|/tmp/*|/private/var/folders/*) ;;
  *) echo "沙箱目录不在临时区（${SANDBOX}），拒绝继续"; exit 1 ;;
esac

PREFIX="${SANDBOX}/root"
RELEASE="${SANDBOX}/release"
STUB_BIN="${SANDBOX}/bin"
SYSTEMCTL_LOG="${SANDBOX}/systemctl.log"
export SYSTEMCTL_LOG
mkdir -p "${PREFIX}" "${RELEASE}/v0.1.0" "${RELEASE}/v0.2.0" "${RELEASE}/v0.3.0" "${STUB_BIN}"
: > "${SYSTEMCTL_LOG}"

# ---- stub：绝不碰真 systemd ----
cat > "${STUB_BIN}/systemctl" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "${SYSTEMCTL_LOG}"
case "$1" in
  is-active) echo active ;;
  status) echo "stub: active" ;;
  *) : ;;
esac
exit 0
STUB
chmod +x "${STUB_BIN}/systemctl"

# ---- 假 release：两个版本，各带清单与签名由测试生成 ----
make_release() {
  local version="$1" payload="$2"
  local dir="${RELEASE}/${version}"
  local target="x86_64-unknown-linux-musl"
  [ "$(uname -m)" = "arm64" ] && target="aarch64-unknown-linux-musl"
  [ "$(uname -m)" = "aarch64" ] && target="aarch64-unknown-linux-musl"
  # 假二进制要能被 `--version` 调用，否则 status/upgrade 拿不到版本
  cat > "${dir}/pierwave-master-${target}" <<FAKE
#!/bin/sh
[ "\$1" = "--version" ] && echo "${version#v}" && exit 0
echo "${payload}"
FAKE
  chmod +x "${dir}/pierwave-master-${target}"
  (cd "${dir}" && sha256sum "pierwave-master-${target}" > "SHA256SUMS-${target}")
  echo "${target}" > "${SANDBOX}/target"
}
make_release "v0.1.0" "old-binary"
TARGET="$(cat "${SANDBOX}/target")"
make_release "v0.2.0" "new-binary"
make_release "v0.3.0" "newest-binary"

run_installer() {
  # 每个用例都从干净前缀开始，避免相互影响
  PATH="${STUB_BIN}:${PATH}" \
  PIERWAVE_PREFIX="${PREFIX}" \
  PIERWAVE_TEST_MODE=1 \
  PIERWAVE_SYSTEMCTL="${STUB_BIN}/systemctl" \
  PIERWAVE_RELEASE_BASE="file://${RELEASE}" \
  PIERWAVE_LATEST_VERSION="v0.2.0" \
  PIERWAVE_SKIP_HEALTH=1 \
  bash "${INSTALL_SH}" "$@"
}

fail() { echo "  FAIL $*" >&2; exit 1; }
pass() { echo "  ok $*"; }

echo "--- install：文件布局与权限 ---"
run_installer install --admin-password "test-password-123" > "${SANDBOX}/install.log" 2>&1 \
  || { cat "${SANDBOX}/install.log"; fail "install 退出码非 0"; }
[ -x "${PREFIX}/usr/local/bin/pierwave-master" ] || fail "二进制没装上"
[ "$("${PREFIX}/usr/local/bin/pierwave-master")" = "new-binary" ] || fail "装错了版本"
[ -f "${PREFIX}/etc/pierwave/pierwave.env" ] || fail "配置文件没写"
[ "$(stat -c '%a' "${PREFIX}/etc/pierwave/pierwave.env" 2>/dev/null || stat -f '%Lp' "${PREFIX}/etc/pierwave/pierwave.env")" = "600" ] \
  || fail "配置文件权限不是 600"
grep -q 'PIERWAVE_ADMIN_PASSWORD=test-password-123' "${PREFIX}/etc/pierwave/pierwave.env" \
  || fail "密码没写进 env 文件"
[ -f "${PREFIX}/etc/systemd/system/pierwave-master.service" ] || fail "systemd unit 没装"
grep -q 'EnvironmentFile=' "${PREFIX}/etc/systemd/system/pierwave-master.service" || fail "unit 没引用 env 文件"
grep -q 'restart' "${SYSTEMCTL_LOG}" || fail "没有调用 systemctl restart"
pass "install 布局正确（binary / env 0600 / unit / restart）"

echo "--- install 幂等：重跑不覆盖已有密码 ---"
run_installer install --admin-password "another-password" >/dev/null 2>&1 || fail "重复 install 失败"
grep -q 'test-password-123' "${PREFIX}/etc/pierwave/pierwave.env" \
  || fail "重复 install 覆盖了已有密码"
pass "重复 install 保留原密码"

echo "--- status：报告版本与路径 ---"
OUT="$(run_installer status 2>&1)" || fail "status 退出码非 0"
printf '%s' "${OUT}" | grep -q "0.2.0" || fail "status 没报出版本：${OUT}"
printf '%s' "${OUT}" | grep -q "${PREFIX}/usr/local/bin/pierwave-master" || fail "status 没报出路径"
pass "status 输出包含版本与路径"

echo "--- upgrade：拒绝降级 ---"
if run_installer upgrade --version v0.1.0 > "${SANDBOX}/downgrade.log" 2>&1; then
  fail "降级居然成功了"
fi
grep -qi 'not newer\|downgrade\|必须比当前' "${SANDBOX}/downgrade.log" || fail "降级报错文案不明确"
pass "降级被拒绝"

echo "--- upgrade：健康检查失败要回滚 ---"
# 关掉 SKIP_HEALTH 并指向一个必然连不上的端口 → report_runtime 失败 → 回滚 .bak
PATH="${STUB_BIN}:${PATH}" \
PIERWAVE_PREFIX="${PREFIX}" PIERWAVE_TEST_MODE=1 \
PIERWAVE_SYSTEMCTL="${STUB_BIN}/systemctl" \
PIERWAVE_RELEASE_BASE="file://${RELEASE}" PIERWAVE_LATEST_VERSION="v0.2.0" \
PIERWAVE_HEALTH_URL="http://127.0.0.1:9/api/v1/health" \
bash "${INSTALL_SH}" upgrade --version v0.3.0 > "${SANDBOX}/upgrade.log" 2>&1 || true
grep -qi 'rolling back\|Rolled back' "${SANDBOX}/upgrade.log" || fail "回滚没有被触发：$(tail -5 "${SANDBOX}/upgrade.log")"
[ "$("${PREFIX}/usr/local/bin/pierwave-master")" = "new-binary" ] || fail "回滚后二进制不是旧版本"
pass "健康检查失败触发回滚（二进制已还原）"

echo "--- uninstall：默认保留数据目录 ---"
mkdir -p "${PREFIX}/var/lib/pierwave"
echo "keep-me" > "${PREFIX}/var/lib/pierwave/pierwave.db"
run_installer uninstall >/dev/null 2>&1 || fail "uninstall 失败"
[ ! -f "${PREFIX}/usr/local/bin/pierwave-master" ] || fail "二进制没删"
[ ! -f "${PREFIX}/etc/systemd/system/pierwave-master.service" ] || fail "unit 没删"
[ -f "${PREFIX}/var/lib/pierwave/pierwave.db" ] || fail "数据目录被误删了"
pass "卸载移除程序但保留数据"

echo "--- uninstall --purge：连数据一起删 ---"
run_installer install --admin-password "test-password-123" >/dev/null 2>&1
mkdir -p "${PREFIX}/var/lib/pierwave" && echo x > "${PREFIX}/var/lib/pierwave/pierwave.db"
run_installer uninstall --purge >/dev/null 2>&1 || fail "uninstall --purge 失败"
[ ! -d "${PREFIX}/var/lib/pierwave" ] || fail "--purge 没有删数据目录"
pass "--purge 删除数据目录"

echo "--- 安全护栏：前缀外的路径必须被拒绝 ---"
if PIERWAVE_PREFIX="/" PIERWAVE_TEST_MODE=1 PIERWAVE_SYSTEMCTL="${STUB_BIN}/systemctl" \
   bash "${INSTALL_SH}" uninstall --purge > "${SANDBOX}/danger.log" 2>&1; then
  fail "PREFIX=/ 时居然执行了 uninstall"
fi
grep -qi 'outside prefix\|refusing\|requires PIERWAVE_PREFIX' "${SANDBOX}/danger.log" || fail "护栏没有给出明确拒绝"
pass "越界路径被拒绝"

# ---- 最后一道检查：沙箱外没有被动过 ----
[ -e /etc/pierwave ] && fail "真机的 /etc/pierwave 被创建了！"
[ -e /usr/local/bin/pierwave-master ] && fail "真机的 /usr/local/bin/pierwave-master 被创建了！"
pass "沙箱外没有任何改动"

echo "PASS install.sh 自测通过（沙箱：${SANDBOX}）"
