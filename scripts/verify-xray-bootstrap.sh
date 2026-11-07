#!/usr/bin/env bash
# 一键在 Linux 机器上跑真机验证：
#   curl -fsSL https://raw.githubusercontent.com/jacob-bytes/pierwave/main/scripts/verify-xray-bootstrap.sh | bash
#
# 只做三件事：把验证脚本与 pierwave-master 二进制取到临时目录、执行、删掉自己下载的东西。
# 不安装任何软件、不改系统目录。验证脚本自己负责清理它创建的进程与端口。
set -euo pipefail

REPO="jacob-bytes/pierwave"
REF="${PIERWAVE_REF:-main}"
# raw.githubusercontent.com 会缓存几分钟，加时间戳确保拿到最新脚本
CACHEBUST="$(date +%s)"
BOOT_VERSION="2026-11-07.3"

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

case "$(uname -m)" in
  x86_64|amd64)  ARCH="x86_64" ;;
  aarch64|arm64) ARCH="aarch64" ;;
  *) die "不支持的架构：$(uname -m)" ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pierwave-boot.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

say "bootstrap $BOOT_VERSION"
say "下载验证脚本（$REF，cache-bust=$CACHEBUST）"
curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/scripts/verify-xray.sh?v=$CACHEBUST" -o "$WORK/verify-xray.sh" \
  || die "下载验证脚本失败；确认这台机器能访问 raw.githubusercontent.com"

say "下载 pierwave-master（$ARCH）"
curl -fsSL --retry 2 \
  "https://github.com/$REPO/releases/latest/download/pierwave-master-${ARCH}-unknown-linux-musl" \
  -o "$WORK/pierwave-master" \
  || die "下载 pierwave-master 失败；可从 Releases 页面手动下载后用 PIERWAVE_BIN 指定"

chmod +x "$WORK/verify-xray.sh" "$WORK/pierwave-master"

say "开始验证（脚本退出时会清理端口与进程）"
set +e
PIERWAVE_BIN="$WORK/pierwave-master" "$WORK/verify-xray.sh" "$@"
code=$?
set -e

say "bootstrap 清理：删除临时文件 $WORK"
exit "$code"
