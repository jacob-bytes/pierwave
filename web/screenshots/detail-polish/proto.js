/* 原型渲染脚本 / prototype renderer.
 * 纯静态：从 fixtures-data.js 读取公开 API fixture，渲染 24h 曲线、环形图和数字。
 * 不联网、不依赖产品代码；URL 参数 state=healthy|incident|offline & theme=dark|light。
 */
(function () {
  const params = new URLSearchParams(location.search);
  const state = params.get("state") || "healthy";
  const theme = params.get("theme") || "dark";
  document.documentElement.dataset.theme = theme;

  const payload = (window.PW_FIXTURES || {})[state] || window.PW_FIXTURES.healthy;
  const server = payload.server;
  const HOUR = 3_600;
  const now = payload.generated_at;

  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const pad = (value) => String(value).padStart(2, "0");
  const clamp = (value) => Math.min(1, Math.max(0, value));

  function formatByteValue(value) {
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const negative = value < 0;
    const absolute = Math.abs(value);
    const sign = negative ? "-" : "";
    if (absolute < 1024) return `${sign}${Math.round(absolute)} B`;
    const exponent = Math.min(
      Math.floor(Math.log(absolute) / Math.log(1024)),
      units.length - 1,
    );
    const scaled = absolute / 1024 ** exponent;
    const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
    const fixed = scaled.toFixed(digits);
    const text = fixed.includes(".")
      ? fixed.replace(/0+$/, "").replace(/\.$/, "")
      : fixed;
    return `${sign}${text} ${units[exponent]}`;
  }

  function rateParts(bps) {
    if (typeof bps !== "number" || !Number.isFinite(bps) || bps < 0) return null;
    if (bps === 0) return { value: "0", unit: "B/s" };
    if (bps < 1) return { value: "<1", unit: "B/s" };
    if (bps < 1024) return { value: String(Math.round(bps)), unit: "B/s" };
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let exponent = Math.min(
      Math.floor(Math.log(bps) / Math.log(1024)),
      units.length - 1,
    );
    const scaledText = (value) => {
      const scaled = value;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      const fixed = scaled.toFixed(digits);
      return fixed.includes(".")
        ? fixed.replace(/0+$/, "").replace(/\.$/, "")
        : fixed;
    };
    let value = scaledText(bps / 1024 ** exponent);
    if (Number(value) >= 1024 && exponent < units.length - 1) {
      exponent += 1;
      value = scaledText(bps / 1024 ** exponent);
    }
    return { value, unit: `${units[exponent]}/s` };
  }

  function percentText(ratio) {
    if (typeof ratio !== "number" || !Number.isFinite(ratio)) return null;
    if (ratio >= 1) return "100";
    if (ratio <= 0) return "0";
    const truncated = Math.floor(Math.min(1, ratio) * 100 * 100) / 100;
    if (truncated <= 0) return "<0.01";
    return truncated
      .toFixed(2)
      .replace(/0+$/, "")
      .replace(/\.$/, "");
  }

  function tone(ratio) {
    if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "unknown";
    if (ratio >= 0.99) return "ok";
    if (ratio >= 0.95) return "warn";
    return "down";
  }

  function hourLabel(ts) {
    const date = new Date(ts * 1_000);
    return `${pad(date.getHours())}:00`;
  }

  function rangeLabel(ts) {
    const end = new Date((ts + HOUR) * 1_000);
    return `${hourLabel(ts)}–${pad(end.getHours())}:00`;
  }

  function summarize(buckets) {
    const list = Array.from({ length: 24 }, (_, index) => buckets[index] ?? null);
    let sampled = 0;
    let zeroHours = 0;
    let outageCount = 0;
    let previousZero = false;
    let normalRun = 0;
    let longestNormal = 0;
    let currentStart = null;
    let currentLast = null;
    let currentHours = 0;
    const periods = [];
    let lowest = null;
    let highest = null;
    const closeOutage = () => {
      if (currentStart !== null && currentLast !== null) {
        periods.push({
          startTs: currentStart,
          endTs: currentLast + HOUR,
          hours: currentHours,
        });
      }
      currentStart = null;
      currentLast = null;
      currentHours = 0;
    };
    for (const bucket of list) {
      const raw = bucket?.online_ratio;
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        closeOutage();
        previousZero = false;
        normalRun = 0;
        continue;
      }
      const ratio = clamp(raw);
      sampled += 1;
      if (ratio >= 0.99) {
        normalRun += 1;
        longestNormal = Math.max(longestNormal, normalRun);
      } else {
        normalRun = 0;
      }
      if (ratio === 0) {
        zeroHours += 1;
        if (!previousZero) {
          outageCount += 1;
          currentStart = bucket.ts;
        }
        currentLast = bucket.ts;
        currentHours += 1;
        previousZero = true;
      } else {
        closeOutage();
        previousZero = false;
      }
      if (!lowest || ratio < lowest.ratio) lowest = { ts: bucket.ts, ratio };
      if (!highest || ratio > highest.ratio) highest = { ts: bucket.ts, ratio };
    }
    closeOutage();
    return {
      list,
      sampled,
      zeroHours,
      outageCount,
      lowest,
      highest,
      longestNormal,
      periods,
      coverage: `${sampled}/24`,
    };
  }

  const buckets = Array.from(
    { length: 24 },
    (_, index) => server.buckets_24h?.[index] ?? null,
  );
  const summary = summarize(buckets);
  const hasData = summary.sampled > 0;
  const uptime24 = hasData ? percentText(server.uptime_24h) : null;
  const uptime7d = percentText(server.uptime_7d);
  const delta =
    hasData && uptime24 !== null && uptime7d !== null
      ? (Number(uptime24) - Number(uptime7d)).toFixed(1)
      : null;
  const deltaText =
    delta === null
      ? "—"
      : `${Number(delta) > 0 ? "+" : Number(delta) < 0 ? "−" : ""}${Math.abs(
          Number(delta),
        ).toFixed(1)} pp`;
  const rx = rateParts(server.net_rx_bps);
  const tx = rateParts(server.net_tx_bps);
  const memPercent =
    typeof server.mem_used === "number" && typeof server.mem_total === "number" && server.mem_total > 0
      ? (server.mem_used / server.mem_total) * 100
      : null;
  const diskPercent =
    typeof server.disk_used === "number" && typeof server.disk_total === "number" && server.disk_total > 0
      ? (server.disk_used / server.disk_total) * 100
      : null;
  const memPair =
    typeof server.mem_used === "number" && typeof server.mem_total === "number" && server.mem_total > 0
      ? `${formatByteValue(server.mem_used)} / ${formatByteValue(server.mem_total)}`
      : "未上报";
  const diskPair =
    typeof server.disk_used === "number" && typeof server.disk_total === "number" && server.disk_total > 0
      ? `${formatByteValue(server.disk_used)} / ${formatByteValue(server.disk_total)}`
      : "未上报";

  const uptimeParts = (() => {
    const secs = server.uptime_secs;
    if (typeof secs !== "number" || !Number.isFinite(secs) || secs <= 0) return null;
    const days = Math.floor(secs / 86_400);
    const hours = Math.floor((secs % 86_400) / 3_600);
    const mins = Math.floor((secs % 3_600) / 60);
    if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
    if (hours > 0) return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
    return `${Math.max(1, mins)} 分钟`;
  })();

  const os = [server.os_name, server.os_version]
    .filter((part) => typeof part === "string" && part.trim())
    .join(" ");

  const paidUntil = server.paid_until;
  const todayUtc8 = (() => {
    const nowMs = now * 1_000 + 8 * HOUR * 1_000;
    return Math.floor(nowMs / 86_400_000);
  })();
  const paidDay = (() => {
    if (typeof paidUntil !== "string") return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(paidUntil.trim());
    if (!match) return null;
    return Math.floor(Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`) / 86_400_000);
  })();
  const daysLeft = paidDay === null ? null : paidDay - todayUtc8;
  const cycleDays =
    server.billing_cycle === "monthly" ? 30 : server.billing_cycle === "yearly" ? 365 : null;
  const remaining =
    daysLeft === null || cycleDays === null
      ? null
      : Math.max(0, Math.min(cycleDays, daysLeft));
  const remainingPercent =
    remaining === null || cycleDays === null ? null : (remaining / cycleDays) * 100;
  const price =
    typeof server.price_cents === "number"
      ? `¥${(server.price_cents / 100).toFixed(2)}`
      : "—";
  const cycleText =
    server.billing_cycle === "monthly"
      ? "/ 月"
      : server.billing_cycle === "yearly"
        ? "/ 年"
        : "";
  const expiryText =
    daysLeft === null
      ? "到期日未配置"
      : daysLeft < 0
        ? "已过期"
        : daysLeft === 0
          ? "今天到期"
          : daysLeft === 1
            ? "明天到期"
            : `${daysLeft} 天后到期`;

  const rxBytes =
    typeof server.net_rx_bytes === "number" && server.net_rx_bytes >= 0
      ? server.net_rx_bytes
      : null;
  const txBytes =
    typeof server.net_tx_bytes === "number" && server.net_tx_bytes >= 0
      ? server.net_tx_bytes
      : null;
  const totalBytes =
    rxBytes !== null && txBytes !== null ? rxBytes + txBytes : (rxBytes ?? txBytes);
  const rxShare =
    rxBytes !== null && txBytes !== null && rxBytes + txBytes > 0
      ? (rxBytes / (rxBytes + txBytes)) * 100
      : 50;
  const uptimeHours =
    typeof server.uptime_secs === "number" && server.uptime_secs > 0
      ? server.uptime_secs / HOUR
      : null;
  const avgRx = rxBytes !== null && uptimeHours ? formatByteValue(rxBytes / uptimeHours) : "—";
  const avgTx = txBytes !== null && uptimeHours ? formatByteValue(txBytes / uptimeHours) : "—";

  /* ---------- text bindings ---------- */
  const bindings = {
    name: server.name,
    flag: server.country_code === "HK" ? "🇭🇰" : "",
    country: "香港",
    group: server.group_name || "未分组",
    uptimeOnly: uptimeParts || "—",
    latency: server.latency_ms === null ? "—" : String(Math.round(server.latency_ms)),
    uptime24: uptime24 ?? "—",
    rxValue: rx ? rx.value : "—",
    txValue: tx ? tx.value : "—",
    rateUnit: rx ? rx.unit : "MB/s",
    samples: `${summary.sampled}/24 采样`,
    outageCount: hasData ? `${summary.outageCount} 次` : "—",
    duration: hasData ? `${summary.zeroHours} 小时` : "—",
    coverage: hasData ? summary.coverage : "—",
    lowestPct: summary.lowest ? `${percentText(summary.lowest.ratio)}%` : "—",
    lowestRange: summary.lowest ? rangeLabel(summary.lowest.ts) : "—",
    highestPct: summary.highest ? `${percentText(summary.highest.ratio)}%` : "—",
    highestRange: summary.highest ? rangeLabel(summary.highest.ts) : "—",
    uptime24Pct: uptime24 === null ? "—" : `${uptime24}%`,
    uptime7dPct: uptime7d === null ? "—" : `${uptime7d}%`,
    lowestDetail: summary.lowest
      ? `${rangeLabel(summary.lowest.ts)} · ${percentText(summary.lowest.ratio)}%`
      : "—",
    highestDetail: summary.highest
      ? `${rangeLabel(summary.highest.ts)} · ${percentText(summary.highest.ratio)}%`
      : "—",
    delta: deltaText,
    longest: hasData ? `${summary.longestNormal} 小时` : "—",
    periods:
      summary.periods.length === 0
        ? "无中断"
        : summary.periods
            .slice(0, 2)
            .map((period) => `${rangeLabel(period.startTs).slice(0, 5)}–${rangeLabel(period.endTs).slice(0, 5)}`)
            .join(" · "),
    memoryPct: memPercent === null ? "—" : `${Math.round(memPercent)}%`,
    memoryPair: memPair,
    diskPct: diskPercent === null ? "—" : `${Math.round(diskPercent)}%`,
    diskPair: diskPair,
    load: typeof server.load1 === "number" ? server.load1.toFixed(2) : "—",
    os: os || "—",
    virt: server.virt || "—",
    arch: server.arch || "—",
    xray:
      server.xray_running === true
        ? "Xray 运行中"
        : server.xray_running === false
          ? "Xray 未运行"
          : "Xray 状态未知",
    price,
    cycle: cycleText,
    remaining: remaining === null ? "—" : String(remaining),
    cycleDays: cycleDays === null ? "—" : String(cycleDays),
    remainingMeta:
      remaining === null ? "—" : `${remaining} / ${cycleDays} 天`,
    paidUntil: paidUntil || "未配置",
    expiryText,
    estimate: cycleDays === 30 ? "按月估算" : cycleDays === 365 ? "按年估算" : "",
    total: totalBytes === null ? "—" : formatByteValue(totalBytes),
    rxBytes: rxBytes === null ? "—" : formatByteValue(rxBytes),
    txBytes: txBytes === null ? "—" : formatByteValue(txBytes),
    avgRx,
    avgTx,
    lastReport: "最后上报 刚刚",
  };

  for (const el of qa("[data-bind]")) {
    const value = bindings[el.dataset.bind];
    if (value !== undefined) el.textContent = value;
  }

  // tone classes
  const toneMap = {
    uptime24: tone(hasData ? server.uptime_24h : null),
    uptime24Pct: tone(hasData ? server.uptime_24h : null),
    lowestPct: summary.lowest ? tone(summary.lowest.ratio) : "unknown",
    highestPct: summary.highest ? tone(summary.highest.ratio) : "unknown",
    uptime7dPct: tone(server.uptime_7d),
  };
  for (const [key, value] of Object.entries(toneMap)) {
    for (const el of qa(`[data-bind="${key}"]`)) {
      el.classList.remove("ok", "warn", "down", "unknown");
      el.classList.add(value);
    }
  }

  // fill bindings (bar widths)
  for (const el of qa("[data-fill]")) {
    const key = el.dataset.fill;
    let value = 0;
    if (key === "memory") value = memPercent ?? 0;
    if (key === "disk") value = diskPercent ?? 0;
    if (key === "remaining") value = remainingPercent ?? 0;
    if (key === "rx") value = rxShare;
    if (key === "uptime24") value = typeof server.uptime_24h === "number" ? clamp(server.uptime_24h) * 100 : 0;
    if (key === "uptime7d") value = typeof server.uptime_7d === "number" ? clamp(server.uptime_7d) * 100 : 0;
    if (key === "coverage") value = (summary.sampled / 24) * 100;
    el.style.width = `${Math.min(100, Math.max(0, value))}%`;
  }

  if (server.xray_running === false) {
    for (const el of qa('[data-xray]')) {
      el.classList.add("warn");
      const dot = el.querySelector(".dot");
      if (dot) dot.style.background = "var(--warning)";
    }
  }

  // warning tone for expired billing
  if (daysLeft !== null && daysLeft < 0) {
    for (const el of qa('[data-tone="billing"]')) el.classList.add("warn");
    for (const el of qa('[data-fill="remaining"]')) el.classList.add("warn");
  }

  /* ---------- chart ---------- */
  function buildChart(container) {
    const ratios = buckets.map((bucket) => bucket?.online_ratio ?? null);
    const sampled = ratios.filter((ratio) => typeof ratio === "number").length;
    const yFor = (ratio) => 4 + (1 - ratio) * 96;
    const toneClass = (ratio) => {
      const value = tone(ratio);
      return value === "unknown" ? "muted" : value;
    };
    const areaOpacity = { ok: 0.06, warn: 0.09, down: 0.12, unknown: 0 };
    const anchor = (() => {
      for (let index = 0; index < buckets.length; index += 1) {
        if (buckets[index]?.ts) return { index, ts: buckets[index].ts };
      }
      return { index: 23, ts: now };
    })();
    const tsAt = (index) => anchor.ts + (index - anchor.index) * HOUR;
    const ticks = [0, 6, 12, 18].map((index) => hourLabel(tsAt(index)));

    container.innerHTML = `
      <div class="chart-head">
        <h3>${container.dataset.title || "24 小时可用率"}</h3>
        <span class="samples num">${sampled}/24 采样</span>
      </div>
      <div class="chart-grid">
        <div class="yaxis" aria-hidden="true">
          <span>100%</span><span>50%</span><span>0%</span>
        </div>
        <div class="plot-wrap">
          <div class="plot" role="img" tabindex="0"
               aria-label="${server.name} 的 24 小时可用率">
            <span class="gridline" data-at="100" aria-hidden="true"></span>
            <span class="gridline" data-at="50" aria-hidden="true"></span>
            ${ratios
              .map((ratio, index) =>
                typeof ratio === "number"
                  ? ""
                  : `<span class="missing" aria-hidden="true" style="left:${
                      (index / 24) * 100
                    }%;width:${100 / 24}%"></span>`,
              )
              .join("")}
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              ${ratios
                .map((ratio, index) => {
                  if (typeof ratio !== "number") return "";
                  const y = yFor(ratio);
                  return `<rect x="${(index / 24) * 100}" y="${y}" width="${
                    100 / 24
                  }" height="${100 - y}" fill="currentColor" opacity="${
                    areaOpacity[tone(ratio)]
                  }" class="${toneClass(ratio)}"></rect>`;
                })
                .join("")}
              ${ratios
                .map((ratio, index) => {
                  if (typeof ratio !== "number") return "";
                  const y = yFor(ratio);
                  return `<line x1="${(index / 24) * 100}" x2="${
                    ((index + 1) / 24) * 100
                  }" y1="${y}" y2="${y}" stroke="currentColor" stroke-width="1.5"
                    vector-effect="non-scaling-stroke" class="${toneClass(ratio)}"></line>`;
                })
                .join("")}
              ${ratios
                .map((ratio, index) => {
                  if (index === 0 || typeof ratio !== "number") return "";
                  const previous = ratios[index - 1];
                  if (typeof previous !== "number") return "";
                  const y1 = yFor(previous);
                  const y2 = yFor(ratio);
                  if (y1 === y2) return "";
                  const worse = Math.min(previous, ratio);
                  return `<line x1="${(index / 24) * 100}" x2="${
                    (index / 24) * 100
                  }" y1="${y1}" y2="${y2}" stroke="currentColor" stroke-width="1.5"
                    vector-effect="non-scaling-stroke" class="${toneClass(worse)}"></line>`;
                })
                .join("")}
            </svg>
            <span class="now" aria-hidden="true"></span>
          </div>
          <div class="xaxis" aria-hidden="true">
            ${ticks.map((label) => `<span class="num">${label}</span>`).join("")}
            <span>现在</span>
          </div>
        </div>
      </div>
      <div class="legend" aria-hidden="true">
        <span class="item"><i class="swatch ok"></i>正常</span>
        <span class="item"><i class="swatch warn"></i>下降</span>
        <span class="item"><i class="swatch down"></i>中断</span>
        <span class="item"><i class="swatch none"></i>无采样</span>
      </div>
      <ul style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">
        ${buckets
          .map((bucket, index) => {
            const ratio = bucket?.online_ratio;
            const label =
              typeof ratio === "number"
                ? `${rangeLabel(bucket.ts)} · ${percentText(ratio)}% · ${
                    { ok: "正常", warn: "下降", down: "中断" }[tone(ratio)]
                  }`
                : `${hourLabel(tsAt(index))} · 无采样`;
            return `<li>${label}</li>`;
          })
          .join("")}
      </ul>
    `;
  }
  for (const chart of qa("[data-chart]")) buildChart(chart);

  /* ---------- 24-cell per-hour histogram ---------- */
  for (const hours of qa("[data-hours]")) {
    hours.innerHTML = buckets
      .map((bucket) => {
        const ratio = bucket?.online_ratio;
        if (typeof ratio !== "number") {
          return '<span class="hour none"></span>';
        }
        const value = tone(ratio);
        return `<span class="hour ${value === "unknown" ? "none" : value}"><span class="fill" style="height:${
          Math.round(clamp(ratio) * 100)
        }%"></span></span>`;
      })
      .join("");
    const first = buckets.find((bucket) => bucket?.ts);
    const range = document.querySelector("[data-ribbon-range]");
    if (range) range.textContent = `${first ? hourLabel(first.ts) : "—"}–现在`;
  }

  /* ---------- rings ---------- */
  for (const ring of qa("[data-ring]")) {
    const percent =
      ring.dataset.ringPercent === "memory"
        ? (memPercent ?? 0)
        : ring.dataset.ringPercent === "disk"
          ? (diskPercent ?? 0)
          : Number(ring.dataset.percent);
    const size = 92;
    const stroke = 8;
    const radius = (size - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    const fill = Math.min(100, Math.max(0, percent || 0));
    ring.innerHTML = `
      <svg viewBox="0 0 ${size} ${size}" aria-hidden="true">
        <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none"
          stroke="var(--muted)" stroke-width="${stroke}"></circle>
        ${
          fill > 0
            ? `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none"
                stroke="var(--primary)" stroke-width="${stroke}" stroke-linecap="round"
                stroke-dasharray="${(fill / 100) * circumference} ${circumference}"></circle>`
            : ""
        }
      </svg>
      <div class="ring-center">
        <strong class="num">${ring.dataset.percentLabel || `${Math.round(fill)}%`}</strong>
        <span>${ring.dataset.label}</span>
      </div>
    `;
  }
})();
