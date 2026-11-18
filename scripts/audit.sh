#!/usr/bin/env bash
# 依赖漏洞扫描：Rust（cargo audit）+ 前端（npm audit --audit-level=high）。
#
# 默认只观察、不阻塞：即使发现漏洞也以 0 退出，避免第一轮接入就把 CI 打红。
# 需要阻塞时显式设置 AUDIT_BLOCKING=1（CI 里由 workflow_dispatch 的
# audit_blocking 输入映射成这个环境变量）。
#
# 用法：
#   ./scripts/audit.sh                     # Rust + 前端都跑，非阻塞
#   RUST=0 ./scripts/audit.sh              # 只跑前端
#   NPM=0 ./scripts/audit.sh               # 只跑 Rust
#   AUDIT_BLOCKING=1 ./scripts/audit.sh    # 发现漏洞 / 扫描失败时退出码非零
#   AUDIT_SUMMARY=/tmp/audit.md ./scripts/audit.sh   # 额外写一份 markdown 摘要
#   RUSTSEC_DB=/path/to/advisory-db ./scripts/audit.sh  # 离线/受限网络用本地库
#
# 依赖：
#   - cargo-audit：优先用 PATH 里的，其次找 $CARGO_HOME/bin；没有时给出安装命令
#     （AUDIT_INSTALL=1 会现场执行 cargo install）。CI 里预装到 .cargo-home。
#   - npm + web/package-lock.json；缓存走仓库内 .npm-cache。
#
# 退出码：
#   0 = 干净，或非阻塞模式（无论是否发现漏洞）
#   1 = 阻塞模式且发现漏洞，或阻塞模式下扫描工具失败
#   2 = 参数错误（RUST=0 NPM=0）
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD

# 与 Makefile 保持一致：缓存落在仓库内。
if [ -z "${CARGO_HOME:-}" ] && [ -d "$ROOT/.cargo-home" ]; then
  export CARGO_HOME="$ROOT/.cargo-home"
fi
if [ -z "${NPM_CONFIG_CACHE:-}" ] && [ -d "$ROOT/.npm-cache" ]; then
  export NPM_CONFIG_CACHE="$ROOT/.npm-cache"
fi

RUST="${RUST:-1}"
NPM="${NPM:-1}"
AUDIT_TOP="${AUDIT_TOP:-10}"
NPM_AUDIT_LEVEL="${NPM_AUDIT_LEVEL:-high}"
AUDIT_BLOCKING="${AUDIT_BLOCKING:-0}"
AUDIT_SUMMARY="${AUDIT_SUMMARY:-}"

case "$AUDIT_BLOCKING" in
  1|true|TRUE|yes) BLOCKING=1 ;;
  *) BLOCKING=0 ;;
esac

log()  { printf '==> %s\n' "$*" >&2; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

if [ "$RUST" != "1" ] && [ "$NPM" != "1" ]; then
  printf '用法：RUST=1 NPM=1 ./scripts/audit.sh（至少开启一个）\n' >&2
  exit 2
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/pierwave-audit.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

rust_status="skipped"
npm_status="skipped"

find_cargo_audit() {
  if [ -n "${CARGO_AUDIT:-}" ] && [ -x "$CARGO_AUDIT" ]; then
    printf '%s' "$CARGO_AUDIT"
    return 0
  fi
  if command -v cargo-audit >/dev/null 2>&1; then
    command -v cargo-audit
    return 0
  fi
  if [ -x "${CARGO_HOME:-$HOME/.cargo}/bin/cargo-audit" ]; then
    printf '%s' "${CARGO_HOME:-$HOME/.cargo}/bin/cargo-audit"
    return 0
  fi
  return 1
}

# ------------------------------------------------------------------ Rust
if [ "$RUST" = "1" ]; then
  log "Rust：cargo audit"
  AUDIT_BIN=$(find_cargo_audit || true)
  if [ -z "$AUDIT_BIN" ] && [ "${AUDIT_INSTALL:-0}" = "1" ]; then
    log "cargo-audit 未安装，执行 cargo install（--root ${CARGO_HOME:-$HOME/.cargo}）"
    if cargo install cargo-audit --locked --root "${CARGO_HOME:-$HOME/.cargo}" \
        >"$TMP/install.log" 2>&1; then
      AUDIT_BIN=$(find_cargo_audit || true)
    else
      warn "cargo install cargo-audit 失败："
      tail -20 "$TMP/install.log" >&2 || true
    fi
  fi

  if [ -z "$AUDIT_BIN" ]; then
    warn "找不到 cargo-audit；跳过 Rust 扫描。安装：cargo install cargo-audit --locked --root \"\${CARGO_HOME:-.cargo-home}\""
    rust_status="error"
  else
    # cargo-audit 0.23 直接调用二进制时要求显式 `audit` 子命令；
    # 老版本没有子命令。探测一次，两种都能跑。
    AUDIT_SUBCMD=()
    if "$AUDIT_BIN" audit --help >/dev/null 2>&1; then
      AUDIT_SUBCMD=(audit)
    fi
    AUDIT_ARGS=("${AUDIT_SUBCMD[@]}" --json)
    HUMAN_ARGS=("${AUDIT_SUBCMD[@]}" --color never --no-fetch)
    if [ -n "${RUSTSEC_DB:-}" ]; then
      [ -d "$RUSTSEC_DB" ] || warn "RUSTSEC_DB 不是目录：${RUSTSEC_DB}"
      AUDIT_ARGS+=(--no-fetch --db "$RUSTSEC_DB")
      HUMAN_ARGS+=(--db "$RUSTSEC_DB")
    fi
    "$AUDIT_BIN" "${AUDIT_ARGS[@]}" >"$TMP/rust.json" 2>"$TMP/rust.err"
    rust_rc=$?
    case "$rust_rc" in
      0) rust_status="clean" ;;
      1) rust_status="findings" ;;
      *)
        rust_status="error"
        warn "cargo audit 失败（退出码 ${rust_rc}）："
        tail -20 "$TMP/rust.err" >&2 || true
        ;;
    esac
    [ -s "$TMP/rust.json" ] || rust_status="error"
    # JSON 里只有 CVSS 向量，没有现成 severity；用第二遍人类可读输出补 v4 分数
    # （`--no-fetch` 复用上一遍刚更新/本地的库，不会再打网络）。
    if [ "$rust_status" = "findings" ]; then
      "$AUDIT_BIN" "${HUMAN_ARGS[@]}" >"$TMP/rust-human.txt" 2>/dev/null || true
    fi
  fi
fi

# ------------------------------------------------------------------ npm
if [ "$NPM" = "1" ]; then
  log "前端：npm audit --audit-level=${NPM_AUDIT_LEVEL}（web/）"
  if [ ! -f "$ROOT/web/package-lock.json" ]; then
    warn "web/package-lock.json 不存在；跳过前端扫描"
    npm_status="error"
  else
    (
      cd "$ROOT/web" &&
        npm audit --audit-level="$NPM_AUDIT_LEVEL" --json >"$TMP/npm.json" 2>"$TMP/npm.err"
    )
    npm_rc=$?
    case "$npm_rc" in
      0) npm_status="clean" ;;
      1) npm_status="findings" ;;
      *)
        npm_status="error"
        warn "npm audit 失败（退出码 ${npm_rc}）："
        tail -20 "$TMP/npm.err" >&2 || true
        ;;
    esac
    [ -s "$TMP/npm.json" ] || npm_status="error"
  fi
fi

# ------------------------------------------------------------------ 汇总
# 把两种 JSON 归一化后输出：人读摘要 + CI annotation 行 + markdown 摘要。
python3 - "$TMP" "$RUST" "$NPM" "$rust_status" "$npm_status" \
  "$AUDIT_TOP" "$AUDIT_SUMMARY" "$BLOCKING" "$NPM_AUDIT_LEVEL" "$TMP/rust-human.txt" <<'PY'
import json
import math
import os
import re
import sys

tmp, rust_on, npm_on, rust_status, npm_status = sys.argv[1:6]
top_n = int(sys.argv[6]) if sys.argv[6].isdigit() else 10
summary_path = sys.argv[7]
blocking = sys.argv[8] == "1"
npm_level = sys.argv[9]
human_rust_path = sys.argv[10] if len(sys.argv) > 10 else ""

RUST_FILE = os.path.join(tmp, "rust.json")
NPM_FILE = os.path.join(tmp, "npm.json")
SEVERITIES = ["critical", "high", "moderate", "medium", "low", "unknown", "info"]
RANK = {name: index for index, name in enumerate(SEVERITIES)}


def load(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def roundup(value):
    return math.ceil(value * 100000.0) / 100000.0


def cvss31_score(vector):
    """计算 CVSS v3.1 base score；向量不合法时返回 None。"""
    if not isinstance(vector, str) or not vector.startswith("CVSS:3"):
        return None
    parts = {}
    for chunk in vector.split("/")[1:]:
        if ":" in chunk:
            key, value = chunk.split(":", 1)
            parts[key] = value
    try:
        av = {"N": 0.85, "A": 0.62, "L": 0.55, "P": 0.2}[parts["AV"]]
        ac = {"L": 0.77, "H": 0.44}[parts["AC"]]
        ui = {"N": 0.85, "R": 0.62}[parts["UI"]]
        changed = parts["S"] == "C"
        pr = {
            "U": {"N": 0.85, "L": 0.62, "H": 0.27},
            "C": {"N": 0.85, "L": 0.68, "H": 0.5},
        }["C" if changed else "U"][parts["PR"]]
        cia = {"H": 0.56, "L": 0.22, "N": 0.0}
        iss = 1.0 - (1.0 - cia[parts["C"]]) * (1.0 - cia[parts["I"]]) * (1.0 - cia[parts["A"]])
        if changed:
            impact = 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
        else:
            impact = 6.42 * iss
        exploitability = 8.22 * av * ac * pr * ui
        if impact <= 0:
            return 0.0
        if changed:
            return roundup(min(1.08 * (impact + exploitability), 10.0))
        return roundup(min(impact + exploitability, 10.0))
    except (KeyError, TypeError, ValueError):
        return None


def severity_for(score):
    if score is None:
        return "unknown"
    if score >= 9.0:
        return "critical"
    if score >= 7.0:
        return "high"
    if score >= 4.0:
        return "moderate"
    if score > 0.0:
        return "low"
    return "info"


def rust_human_severities(path):
    """cargo-audit JSON 只有 CVSS 向量；人类可读输出里有现成的 score/severity。"""
    mapping = {}
    try:
        text = open(path, encoding="utf-8").read()
    except OSError:
        return mapping
    crate = advisory_id = None
    for line in text.splitlines():
        match = re.match(r"\s*Crate:\s+(\S+)", line)
        if match:
            crate, advisory_id = match.group(1), None
            continue
        match = re.match(r"\s*ID:\s+(RUSTSEC-\d{4}-\d+)", line)
        if match:
            advisory_id = match.group(1)
            continue
        match = re.match(r"\s*Severity:\s+([0-9.]+)\s+\(([^)]+)\)", line)
        if match and crate and advisory_id:
            mapping[(crate, advisory_id)] = (float(match.group(1)), match.group(2).lower())
    return mapping


def normalize_severity(label):
    label = label.replace("medium", "moderate")
    if label == "none":
        return "info"
    return label if label in RANK else "unknown"


findings = []
scan_error = False
counts = {"rust": 0, "npm": 0}
rust_warning_count = 0
npm_meta = {}
rust_severities = rust_human_severities(human_rust_path) if rust_on == "1" else {}

if rust_on == "1":
    if rust_status == "error":
        scan_error = True
    data = load(RUST_FILE)
    if not isinstance(data, dict):
        if rust_status != "error":
            scan_error = True
    else:
        for item in (data.get("vulnerabilities") or {}).get("list") or []:
            advisory = item.get("advisory") or {}
            package = advisory.get("package") or "?"
            advisory_id = advisory.get("id") or ""
            human = rust_severities.get((package, advisory_id))
            if human:
                score, severity = human
                severity = normalize_severity(severity)
            else:
                score = cvss31_score(advisory.get("cvss"))
                severity = severity_for(score)
            findings.append(
                {
                    "ecosystem": "rust",
                    "severity": severity,
                    "package": package,
                    "id": advisory_id,
                    "title": advisory.get("title") or "",
                    "url": advisory.get("url") or "",
                    "detail": f"CVSS {score:.1f}" if score is not None else "CVSS n/a",
                }
            )
        counts["rust"] = len(findings)
        rust_warning_count = sum(
            len(entries) for entries in (data.get("warnings") or {}).values()
        )

if npm_on == "1":
    if npm_status == "error":
        scan_error = True
    data = load(NPM_FILE)
    if not isinstance(data, dict):
        if npm_status != "error":
            scan_error = True
    else:
        npm_meta = (data.get("metadata") or {}).get("vulnerabilities") or {}
        npm_vulns = data.get("vulnerabilities") or {}

        def resolve_via(name, seen=None):
            """沿 npm 的 via 依赖链找到真正的 advisory（via 可能只是包名）。"""
            seen = (seen or set()) | {name}
            item = npm_vulns.get(name) or {}
            resolved = []
            for via in item.get("via") or []:
                if isinstance(via, dict):
                    cvss = via.get("cvss") or {}
                    score = None
                    if isinstance(cvss, dict) and isinstance(cvss.get("score"), (int, float)):
                        score = float(cvss["score"])
                    resolved.append(
                        (
                            via.get("title") or "",
                            via.get("url") or "",
                            score,
                        )
                    )
                elif isinstance(via, str) and via not in seen:
                    resolved.extend(resolve_via(via, seen))
            return resolved

        for name, item in npm_vulns.items():
            severity = item.get("severity") or "unknown"
            advisories = resolve_via(name)
            title = next((entry[0] for entry in advisories if entry[0]), "")
            url = next((entry[1] for entry in advisories if entry[1]), "")
            score = next((entry[2] for entry in advisories if entry[2] is not None), None)
            if not title:
                title = "npm advisory"
            findings.append(
                {
                    "ecosystem": "npm",
                    "severity": severity if severity in RANK else "unknown",
                    "package": name,
                    "id": "",
                    "title": title,
                    "url": url,
                    "detail": f"CVSS {score:.1f}" if score is not None else (
                        "direct" if item.get("isDirect") else "transitive"
                    ),
                }
            )
        counts["npm"] = len(npm_vulns)

findings.sort(key=lambda item: (RANK.get(item["severity"], 99), item["ecosystem"], item["package"]))
total = len(findings)
# 阻塞阈值对齐工具语义：Rust 任何漏洞都算；npm 只算 critical/high
# （`--audit-level=high` 的退出码也只在这两档非零）。
blocking_total = sum(
    1
    for item in findings
    if item["ecosystem"] == "rust" or item["severity"] in ("critical", "high")
)

print("== 依赖漏洞扫描 / Dependency audit ==")
if rust_on == "1":
    if rust_status == "error":
        print("- Rust `cargo audit`：扫描失败 / failed to run")
    else:
        extra = f"（另有 {rust_warning_count} 个 unmaintained/yanked 警告）" if rust_warning_count else ""
        print(f"- Rust `cargo audit`：{counts['rust']} 个漏洞 / vulnerabilities{extra}")
if npm_on == "1":
    if npm_status == "error":
        print(f"- npm `web/`（--audit-level={npm_level}）：扫描失败 / failed to run")
    else:
        print(
            "- npm `web/`（--audit-level={lvl}）：{n} 个（critical {c} / high {h} / moderate {m} / low {lo}）"
            .format(
                lvl=npm_level,
                n=npm_meta.get("total", counts["npm"]),
                c=npm_meta.get("critical", 0),
                h=npm_meta.get("high", 0),
                m=npm_meta.get("moderate", 0),
                lo=npm_meta.get("low", 0),
            )
        )

if total:
    print(f"\nTop {min(top_n, total)}（按严重度 / by severity）：")
    for index, item in enumerate(findings[:top_n], 1):
        print(
            f"  {index}. [{item['severity']}] {item['ecosystem']} {item['package']} — "
            f"{item['title']}" + (f" ({item['url']})" if item["url"] else "")
        )
    print()

rust_findings = [item for item in findings if item["ecosystem"] == "rust"]
if rust_findings:
    # Top N 可能全被 npm 的 high 占满，Rust 的条目单独列出来，避免摘要里只有计数。
    print("Rust 漏洞明细 / Rust advisories：")
    for item in rust_findings:
        print(
            f"  - [{item['severity']}] {item['package']} {item['id']} — {item['title']} "
            f"({item['detail']})" + (f" {item['url']}" if item["url"] else "")
        )
    print()

for item in findings:
    print(
        f"AUDIT_FINDING: [{item['severity']}] {item['ecosystem']} {item['package']} — "
        f"{item['title']}" + (f" ({item['url']})" if item["url"] else "")
    )

mode = "阻塞 / blocking" if blocking else "非阻塞（观察期）/ non-blocking"
print(f"\n模式 / mode：{mode}")
print(f"AUDIT_RESULT: {'findings' if total else ('error' if scan_error else 'clean')}")
print(f"AUDIT_BLOCKING_FINDINGS: {blocking_total}")

# CI 需要知道「扫描失败」「发现漏洞」和「达到阻塞阈值」是三件事。
with open(os.path.join(tmp, "total"), "w", encoding="utf-8") as handle:
    handle.write(str(total))
with open(os.path.join(tmp, "blocking_total"), "w", encoding="utf-8") as handle:
    handle.write(str(blocking_total))
with open(os.path.join(tmp, "scan_error"), "w", encoding="utf-8") as handle:
    handle.write("1" if scan_error else "0")

if summary_path:
    lines = []
    lines.append("## 依赖漏洞扫描 / Dependency audit\n")
    lines.append("| 生态 / Ecosystem | 工具 / Tool | 结果 / Result |")
    lines.append("|---|---|---|")
    if rust_on == "1":
        rust_result = (
            "扫描失败 / failed"
            if rust_status == "error"
            else f"{counts['rust']} 个漏洞 / vulnerabilities"
        )
        if rust_warning_count:
            rust_result += f"（另有 {rust_warning_count} 个 unmaintained/yanked 警告）"
        lines.append(f"| Rust | `cargo audit` | {rust_result} |")
    if npm_on == "1":
        if npm_status == "error":
            npm_result = "扫描失败 / failed"
        else:
            npm_result = (
                f"{npm_meta.get('total', counts['npm'])} 个（critical {npm_meta.get('critical', 0)} / "
                f"high {npm_meta.get('high', 0)} / moderate {npm_meta.get('moderate', 0)} / "
                f"low {npm_meta.get('low', 0)}）"
            )
        lines.append(f"| npm (`web/`) | `npm audit --audit-level={npm_level}` | {npm_result} |")
    lines.append("")
    if total:
        lines.append(f"### Top {min(top_n, total)}（按严重度 / by severity）\n")
        lines.append("| # | 严重度 | 生态 | 包 | 摘要 |")
        lines.append("|---|---|---|---|---|")
        for index, item in enumerate(findings[:top_n], 1):
            title = item["title"].replace("|", "\\|")
            url = f" [{item['id'] or 'advisory'}]({item['url']})" if item["url"] else ""
            lines.append(
                f"| {index} | {item['severity']} | {item['ecosystem']} | "
                f"`{item['package']}` | {title}{url} |"
            )
        lines.append("")
    if rust_findings:
        lines.append("### Rust 漏洞明细 / Rust advisories\n")
        lines.append("| 严重度 | 包 | Advisory | 摘要 |")
        lines.append("|---|---|---|---|")
        for item in rust_findings:
            title = item["title"].replace("|", "\\|")
            url = f" [{item['id']}]({item['url']})" if item["url"] else f" {item['id']}"
            lines.append(
                f"| {item['severity']} | `{item['package']}` | {item['detail']} | {title}{url} |"
            )
        lines.append("")
    lines.append(
        f"模式 / mode：{mode}。设置 `AUDIT_BLOCKING=1`（或 workflow_dispatch 的 "
        "`audit_blocking`）可切换为阻塞。"
    )
    lines.append(
        f"阻塞阈值 / blocking threshold：Rust 任意漏洞 + npm critical/high，"
        f"当前达到阈值 {blocking_total} 个 / {blocking_total} finding(s) at or above threshold。"
    )
    summary_dir = os.path.dirname(summary_path)
    if summary_dir:
        os.makedirs(summary_dir, exist_ok=True)
    with open(summary_path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
PY

total=$(cat "$TMP/total" 2>/dev/null || echo 0)
blocking_total=$(cat "$TMP/blocking_total" 2>/dev/null || echo 1)
scan_error=$(cat "$TMP/scan_error" 2>/dev/null || echo 1)
printf '发现 %s 个依赖漏洞（达到阻塞阈值 %s 个；扫描失败=%s）/ %s findings (%s blocking; scanner error=%s)\n' \
  "$total" "$blocking_total" "$scan_error" "$total" "$blocking_total" "$scan_error" >&2

if [ "$BLOCKING" = "1" ] && { [ "$blocking_total" -gt 0 ] || [ "$scan_error" = "1" ]; }; then
  printf 'AUDIT_BLOCKING=1：发现达到阈值的漏洞或扫描失败，退出码 1\n' >&2
  exit 1
fi
exit 0
