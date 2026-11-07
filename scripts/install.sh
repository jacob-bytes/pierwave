#!/usr/bin/env bash
# PierWave master one-click installer (systemd mode).
#
#   curl -fsSL .../install.sh | sudo bash -s -- install
#   ./install.sh upgrade --version v0.6.0
#
# Everything this script creates is listed by `status` and removed by `uninstall`,
# except the data directory, which is kept unless you pass --purge.
set -euo pipefail

# ---------------------------------------------------------------- constants
readonly SERVICE_NAME="pierwave-master"
readonly BIN_PATH="/usr/local/bin/pierwave-master"
readonly ETC_DIR="/etc/pierwave"
readonly ENV_FILE="${ETC_DIR}/pierwave.env"
readonly DATA_DIR="/var/lib/pierwave"
readonly UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
readonly REPO="jacob-bytes/pierwave"
readonly RELEASE_PUBKEY="pRXhWVFOKtVf3uzarnuIUhte1IHTqx7JsylIFf1nEb0="

readonly DEFAULT_PORT="8787"
readonly DEFAULT_BIND="0.0.0.0"

VERSION=""
PURGE=0
WORK_DIR=""
PORT="${DEFAULT_PORT}"
BIND="${DEFAULT_BIND}"
ADMIN_PASSWORD=""

# ---------------------------------------------------------------- logging
function cleanup_work() {
  if [ -n "${WORK_DIR}" ] && [ -d "${WORK_DIR}" ]; then rm -rf "${WORK_DIR}"; fi
}
trap cleanup_work EXIT

function log_info()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
function log_ok()    { printf '  \033[32mok\033[0m %s\n' "$*"; }
function log_warn()  { printf '  \033[33mwarn\033[0m %s\n' "$*"; }
function log_error() { printf '\033[31mERROR\033[0m %s\n' "$*" >&2; }
function die()       { log_error "$*"; exit 1; }

# ---------------------------------------------------------------- helpers
function require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "This script must run as root. Try: sudo bash $0 $*"
  fi
}

function require_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    die "systemd is required for this installer. Use the Docker deployment instead."
  fi
}

function detect_target() {
  case "$(uname -m)" in
    x86_64|amd64)   printf 'x86_64-unknown-linux-musl' ;;
    aarch64|arm64)  printf 'aarch64-unknown-linux-musl' ;;
    *) die "Unsupported architecture: $(uname -m). Supported: x86_64, aarch64" ;;
  esac
}

function download() {
  local url="$1" out="$2"
  log_info "Downloading ${url}"
  if curl -fsSL --retry 3 --connect-timeout 15 -o "${out}" "${url}"; then
    return 0
  fi
  die "Download failed: ${url}
Check network access, or set HTTPS_PROXY, or download the file manually and rerun with --file."
}

# Optional download: returns non-zero instead of aborting.
function download_optional() {
  local url="$1" out="$2"
  curl -fsSL --retry 2 --connect-timeout 10 --max-time 120 -o "${out}" "${url}" 2>/dev/null
}

function latest_version() {
  local json
  json="$(curl -fsSL --max-time 20 "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null || true)"
  if [ -z "${json}" ]; then
    return 1
  fi
  printf '%s' "${json}" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1
}

# Returns 0 when $1 > $2, comparing dot-separated numeric segments.
function version_gt() {
  local a="${1#v}" b="${2#v}"
  IFS='.' read -r -a ap <<< "${a}"
  IFS='.' read -r -a bp <<< "${b}"
  local i max=${#ap[@]}
  if [ "${#bp[@]}" -gt "${max}" ]; then max=${#bp[@]}; fi
  for ((i = 0; i < max; i++)); do
    local x="${ap[i]:-0}" y="${bp[i]:-0}"
    x="${x%%[!0-9]*}"; y="${y%%[!0-9]*}"
    x="${x:-0}"; y="${y:-0}"
    if [ "${x}" -gt "${y}" ]; then return 0; fi
    if [ "${x}" -lt "${y}" ]; then return 1; fi
  done
  return 1
}

function installed_version() {
  if [ -x "${BIN_PATH}" ]; then
    "${BIN_PATH}" --version 2>/dev/null | head -1 || true
  fi
}

function service_state() {
  systemctl is-active "${SERVICE_NAME}" 2>/dev/null || true
}

# Verify SHA256SUMS with the embedded Ed25519 public key when openssl 3 is available.
# Falls back to checksum-only verification, and says so loudly.
function verify_release() {
  local sums="$1" sig="$2" asset="$3" file="$4"

  if [ ! -f "${sig}" ]; then
    log_warn "Signature file missing; signature check skipped (checksum only)"
  elif openssl version 2>/dev/null | grep -q '^OpenSSL 3'; then
    # 内置的是 32 字节裸公钥；OpenSSL 需要 SPKI DER，这里手工拼上固定前缀。
    local pem sigbin
    pem="$(mktemp)"
    sigbin="$(mktemp)"
    {
      echo '-----BEGIN PUBLIC KEY-----'
      { printf '\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00'
        printf '%s' "${RELEASE_PUBKEY}" | base64 -d; } | base64
      echo '-----END PUBLIC KEY-----'
    } > "${pem}"
    # 签名文件是 base64 文本，OpenSSL 需要二进制
    base64 -d < "${sig}" > "${sigbin}" 2>/dev/null || true
    if openssl pkeyutl -verify -pubin -inkey "${pem}" -rawin \
         -in "${sums}" -sigfile "${sigbin}" >/dev/null 2>&1; then
      log_ok "Checksum manifest signature verified"
    else
      rm -f "${pem}" "${sigbin}"
      die "Signature verification failed. The download may have been tampered with; refusing to install."
    fi
    rm -f "${pem}" "${sigbin}"
  else
    log_warn "OpenSSL 3 not found; signature check skipped (checksum only)"
  fi

  local expected actual
  expected="$(awk -v name="${asset}" '$2 == name || $2 == "*" name { print $1; exit }' "${sums}")"
  [ -n "${expected}" ] || die "Checksum manifest does not list ${asset}"
  actual="$(sha256sum "${file}" | awk '{print $1}')"
  if [ "${expected}" != "${actual}" ]; then
    die "Checksum mismatch for ${asset}: expected ${expected}, got ${actual}"
  fi
  log_ok "Checksum verified (${asset})"
}

function ensure_layout() {
  install -d -m 0755 "${ETC_DIR}"
  install -d -m 0700 "${DATA_DIR}"
}

function write_env_file() {
  local password="$1"
  umask 077
  {
    printf 'PIERWAVE_ADDR=%s:%s\n' "${BIND}" "${PORT}"
    printf 'PIERWAVE_DB=sqlite://%s/pierwave.db?mode=rwc\n' "${DATA_DIR}"
    printf 'PIERWAVE_ADMIN_PASSWORD=%s\n' "${password}"
  } > "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
  log_ok "Wrote ${ENV_FILE} (mode 0600)"
}

function write_unit() {
  cat > "${UNIT_PATH}" <<UNIT
[Unit]
Description=PierWave master
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
ExecStart=${BIN_PATH}
Restart=always
RestartSec=3
User=root
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  log_ok "Installed systemd unit ${UNIT_PATH}"
}

function wait_healthy() {
  local tries="${1:-30}" i
  for ((i = 1; i <= tries; i++)); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

function report_runtime() {
  local state
  state="$(service_state)"
  if [ "${state}" = "active" ] && wait_healthy 5; then
    log_ok "Service is running and /api/v1/health responds"
  else
    log_error "Service state: ${state:-unknown}; health check failed"
    log_error "Inspect logs: journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
    return 1
  fi
  cat <<INFO

  Panel URL : http://<server-ip>:${PORT}
  Config    : ${ENV_FILE}
  Data      : ${DATA_DIR}
  Logs      : journalctl -u ${SERVICE_NAME} -f
  Status    : systemctl status ${SERVICE_NAME}
INFO
}

# ---------------------------------------------------------------- commands
function do_install() {
  require_root
  require_systemd
  ensure_layout

  local version="${VERSION}"
  if [ -z "${version}" ]; then
    version="$(latest_version || true)"
    [ -n "${version}" ] || die "Could not determine the latest release. Pass --version vX.Y.Z explicitly."
  fi
  local target sumfile archive asset
  target="$(detect_target)"
  asset="pierwave-master-${target}"
  sumfile="SHA256SUMS-${target}"

  WORK_DIR="$(mktemp -d)"
  local work="${WORK_DIR}"
  download "https://github.com/${REPO}/releases/download/${version}/${asset}" "${work}/${asset}"
  download_optional "https://github.com/${REPO}/releases/download/${version}/${sumfile}" "${work}/${sumfile}"
  download_optional "https://github.com/${REPO}/releases/download/${version}/${sumfile}.sig" "${work}/${sumfile}.sig"

  if [ -f "${work}/${sumfile}" ]; then
    verify_release "${work}/${sumfile}" "${work}/${sumfile}.sig" "${asset}" "${work}/${asset}"
  else
    log_warn "Checksum manifest unavailable; installing without verification"
  fi

  install -m 0755 "${work}/${asset}" "${BIN_PATH}"
  log_ok "Installed ${BIN_PATH} (${version})"

  local password="${ADMIN_PASSWORD}"
  if [ -f "${ENV_FILE}" ]; then
    log_warn "Existing ${ENV_FILE} kept; admin password unchanged"
  else
    if [ -z "${password}" ]; then
      password="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-20)"
      log_warn "Generated admin password (shown once): ${password}"
    fi
    write_env_file "${password}"
  fi

  write_unit
  systemctl enable --now "${SERVICE_NAME}" >/dev/null 2>&1 || true
  systemctl restart "${SERVICE_NAME}"
  report_runtime
}

function do_upgrade() {
  require_root
  [ -x "${BIN_PATH}" ] || die "PierWave is not installed. Run 'install' first."

  local current version
  current="$(installed_version)"
  version="${VERSION}"
  if [ -z "${version}" ]; then
    version="$(latest_version || true)"
    [ -n "${version}" ] || die "Could not determine the latest release. Pass --version vX.Y.Z explicitly."
  fi

  if [ -n "${current}" ] && ! version_gt "${version}" "${current}"; then
    die "Refusing to upgrade: ${version} is not newer than installed ${current} (downgrades are not supported)"
  fi

  log_info "Upgrading ${current:-unknown} -> ${version}"
  backup_database
  cp -f "${BIN_PATH}" "${BIN_PATH}.bak"
  log_ok "Kept previous binary at ${BIN_PATH}.bak"

  local target asset sumfile work
  target="$(detect_target)"
  asset="pierwave-master-${target}"
  sumfile="SHA256SUMS-${target}"
  WORK_DIR="$(mktemp -d)"
  local work="${WORK_DIR}"
  download "https://github.com/${REPO}/releases/download/${version}/${asset}" "${work}/${asset}"
  download_optional "https://github.com/${REPO}/releases/download/${version}/${sumfile}" "${work}/${sumfile}"
  download_optional "https://github.com/${REPO}/releases/download/${version}/${sumfile}.sig" "${work}/${sumfile}.sig"
  if [ -f "${work}/${sumfile}" ]; then
    verify_release "${work}/${sumfile}" "${work}/${sumfile}.sig" "${asset}" "${work}/${asset}"
  fi

  install -m 0755 "${work}/${asset}" "${BIN_PATH}"
  systemctl restart "${SERVICE_NAME}"
  if report_runtime; then
    log_ok "Upgrade finished: ${version}"
  else
    log_error "New version did not become healthy; rolling back"
    cp -f "${BIN_PATH}.bak" "${BIN_PATH}"
    systemctl restart "${SERVICE_NAME}"
    if report_runtime; then
      log_warn "Rolled back to ${current}"
    else
      log_error "Rollback also failed; manual attention required"
    fi
    exit 1
  fi
}

function backup_database() {
  local db="${DATA_DIR}/pierwave.db"
  [ -f "${db}" ] || return 0
  local stamp backup
  stamp="$(date +%Y%m%d-%H%M%S)"
  backup="${db}.${stamp}.bak"
  # A running process may hold the file; use the online backup if sqlite3 exists.
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "${db}" ".backup '${backup}'" && log_ok "Database backup: ${backup}"
  else
    cp -f "${db}" "${backup}" && log_ok "Database backup (file copy): ${backup}"
  fi
}

function do_start()    { require_root; systemctl start "${SERVICE_NAME}"; report_runtime; }
function do_stop()     { require_root; systemctl stop "${SERVICE_NAME}"; log_ok "Stopped ${SERVICE_NAME}"; }
function do_restart()  { require_root; systemctl restart "${SERVICE_NAME}"; report_runtime; }
function do_status() {
  printf 'Service : %s\n' "$(service_state)"
  printf 'Version : %s\n' "$(installed_version || true)"
  printf 'Binary  : %s\n' "${BIN_PATH}"
  printf 'Config  : %s\n' "${ENV_FILE}"
  printf 'Data    : %s\n' "${DATA_DIR}"
  printf 'Logs    : journalctl -u %s -n 50 --no-pager\n' "${SERVICE_NAME}"
  if wait_healthy 5; then log_ok "Health endpoint OK"; else log_warn "Health endpoint not responding"; fi
}

function do_uninstall() {
  require_root
  systemctl disable --now "${SERVICE_NAME}" >/dev/null 2>&1 || true
  rm -f "${UNIT_PATH}"
  systemctl daemon-reload
  rm -f "${BIN_PATH}" "${BIN_PATH}.bak"
  rm -f "${ENV_FILE}"
  rmdir "${ETC_DIR}" 2>/dev/null || true
  log_ok "Removed binary, config and systemd unit"
  if [ "${PURGE}" = "1" ]; then
    rm -rf "${DATA_DIR}"
    log_warn "Data directory removed (--purge)"
  else
    log_info "Data kept at ${DATA_DIR} (use --purge to delete it)"
  fi
}

function do_logs() { journalctl -u "${SERVICE_NAME}" -n 200 --no-pager; }

function usage() {
  cat <<USAGE
PierWave master installer (systemd)

Usage: ${0##*/} <command> [options]

Commands:
  install      Install or repair the installation (keeps existing config and data)
  upgrade      Upgrade to a newer release (downgrades are refused)
  start        Start the service
  stop         Stop the service
  restart      Restart the service
  status       Show service state, version, paths and health
  uninstall    Remove binary, config and unit (data kept unless --purge)
  logs         Show recent service logs

Options:
  --version <vX.Y.Z>     Target release (default: latest)
  --port <port>          Listen port (default: ${DEFAULT_PORT})
  --bind <addr>          Listen address (default: ${DEFAULT_BIND})
  --admin-password <pw>  Initial admin password (default: random, printed once)
  --purge                With uninstall: also delete ${DATA_DIR}
  -h, --help             Show this help
USAGE
}

# ---------------------------------------------------------------- entry
COMMAND="${1:-}"
if [ $# -gt 0 ]; then shift; fi

while [ $# -gt 0 ]; do
  case "$1" in
    --version)        VERSION="${2:-}"; shift 2 ;;
    --port)           PORT="${2:-}"; shift 2 ;;
    --bind)           BIND="${2:-}"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="${2:-}"; shift 2 ;;
    --purge)          PURGE=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

case "${COMMAND}" in
  install)   do_install ;;
  upgrade)   do_upgrade ;;
  start)     do_start ;;
  stop)      do_stop ;;
  restart)   do_restart ;;
  status)    do_status ;;
  uninstall) do_uninstall ;;
  logs)      do_logs ;;
  ""|-h|--help) usage; exit 0 ;;
  *) usage >&2; die "Unknown command: ${COMMAND}" ;;
esac
