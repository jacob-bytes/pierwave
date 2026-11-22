/* Shared interactions for the overview-views prototypes. No dependencies. */
(function () {
  "use strict";

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const pct = (value, digits = 0) =>
    `${(value * 100).toFixed(digits)}%`;
  const pad2 = (value) => String(value).padStart(2, "0");
  const dayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  function readTheme() {
    let stored = null;
    try { stored = localStorage.getItem("pv-theme"); } catch (_) { /* file:// */ }
    const query = new URLSearchParams(location.search).get("theme");
    const theme = query || stored || "dark";
    document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
  }

  function initTheme() {
    readTheme();
    if (new URLSearchParams(location.search).get("shot") === "1") {
      document.body.classList.add("is-shot");
    }
    const button = document.querySelector(".js-theme");
    if (!button) return;
    function sync() {
      const light = document.documentElement.dataset.theme === "light";
      button.setAttribute("aria-label", light ? "切换到深色 / Switch to dark" : "切换到浅色 / Switch to light");
      button.setAttribute("title", light ? "切换到深色 / Switch to dark" : "切换到浅色 / Switch to light");
    }
    sync();
    button.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("pv-theme", next); } catch (_) { /* file:// */ }
      sync();
    });
  }

  /* ---------- money / dates ---------- */
  const SYMBOLS = { CNY: "¥", USD: "$", EUR: "€" };

  function groupDigits(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function fmtAmount(cents, currency) {
    if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
    const amount = (cents / 100).toFixed(2);
    const [whole, fraction] = amount.split(".");
    const symbol = SYMBOLS[currency];
    const body = `${groupDigits(whole)}.${fraction}`;
    return symbol ? `${symbol}${body}` : `${currency} ${body}`;
  }

  function fmtCny(cents) {
    if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
    const amount = (cents / 100).toFixed(2);
    const [whole, fraction] = amount.split(".");
    return fraction === "00"
      ? `¥${groupDigits(whole)}`
      : `¥${groupDigits(whole)}.${fraction}`;
  }

  function fmtCnyShort(cents) {
    if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
    const value = cents / 100;
    if (value >= 10000) return `¥${(value / 1000).toFixed(1)}k`;
    if (value >= 1000) return `¥${(value / 1000).toFixed(2)}k`;
    return Number.isInteger(value) ? `¥${value}` : `¥${value.toFixed(2)}`;
  }

  function isoDay(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    if (!match) return null;
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }

  function addMonths(date, count) {
    const next = new Date(date.getTime());
    const day = next.getUTCDate();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + count);
    const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(day, last));
    return next;
  }

  function monthStart(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }

  function monthKey(date) {
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
  }

  function monthDiff(a, b) {
    return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  }

  /* ---------- svg sparkline ---------- */
  function svgSpark(options) {
    const {
      values, lower, upper, baseline, minY = 0, maxY = 120,
      width = 600, height = 42, incident = null,
    } = options;
    const count = values.length;
    const x = (index) => (count <= 1 ? 0 : (index / (count - 1)) * (width - 2) + 1);
    const y = (value) => height - ((value - minY) / (maxY - minY)) * (height - 4) - 2;

    const line = (() => {
      let d = "";
      let pen = false;
      values.forEach((value, index) => {
        if (value === null || value === undefined) { pen = false; return; }
        d += `${pen ? "L" : "M"}${x(index).toFixed(2)} ${y(value).toFixed(2)}`;
        pen = true;
      });
      return d;
    })();

    let band = "";
    if (lower && upper) {
      let run = [];
      const flush = () => {
        if (run.length >= 2) {
          let d = "";
          run.forEach((index, position) => {
            d += `${position === 0 ? "M" : "L"}${x(index).toFixed(2)} ${y(upper[index]).toFixed(2)}`;
          });
          for (let position = run.length - 1; position >= 0; position -= 1) {
            const index = run[position];
            d += `L${x(index).toFixed(2)} ${y(lower[index]).toFixed(2)}`;
          }
          band += `${d}Z`;
        }
        run = [];
      };
      values.forEach((value, index) => {
        if (value === null || lower[index] === null || upper[index] === null) flush();
        else run.push(index);
      });
      flush();
    }

    const grid = [0, 40, 80, 120]
      .filter((value) => value >= minY && value <= maxY)
      .map((value) => `<line class="grid" x1="0" x2="${width}" y1="${y(value).toFixed(2)}" y2="${y(value).toFixed(2)}" />`)
      .join("");

    const lastIndex = values.reduce((last, value, index) => (value === null ? last : index), 0);
    const now = values[lastIndex] === null || values[lastIndex] === undefined
      ? ""
      : `<line class="now" x1="${x(lastIndex).toFixed(2)}" x2="${x(lastIndex).toFixed(2)}" y1="0" y2="${height}" />`;

    const base = baseline === null || baseline === undefined
      ? ""
      : `<line class="baseline" x1="0" x2="${width}" y1="${y(baseline).toFixed(2)}" y2="${y(baseline).toFixed(2)}" />`;

    const incidentRect = incident && incident.length >= 2
      ? `<rect class="incident" x="${x(incident[0]).toFixed(2)}" y="0" width="${Math.max(0, x(Math.min(count - 1, incident[1])) - x(incident[0])).toFixed(2)}" height="${height}" />`
      : "";

    return `<svg class="spark-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-hidden="true">${grid}${incidentRect}${base}${band ? `<path class="band" d="${band}" />` : ""}${line ? `<path class="line" d="${line}" />` : ""}${now}</svg>`;
  }

  /* ---------- cost view ---------- */
  function initCost(config) {
    const today = isoDay(config.today);
    const windowStart = monthStart(today);
    const months = Array.from({ length: 12 }, (_, index) => addMonths(windowStart, index));
    const monthLabel = months.map((date) => `${date.getUTCMonth() + 1}月`);
    const rates = config.rates;
    const servers = config.servers.map((server) => {
      const hasPrice = Number.isFinite(server.priceCents) && Boolean(server.currency);
      const rate = hasPrice ? rates[server.currency] : undefined;
      const configured = hasPrice && Number.isFinite(rate);
      const unitMonths = server.unit === "year" ? 12 : server.unit === "month" ? 1 : null;
      const monthsInCycle = unitMonths === null ? null : unitMonths * server.count;
      const monthlyOrig = configured && unitMonths !== null
        ? server.priceCents / monthsInCycle
        : null;
      const monthlyCny = configured && unitMonths !== null
        ? Math.round(monthlyOrig * rate)
        : null;
      const cycleAmountCny = configured ? Math.round(server.priceCents * rate) : null;
      return { ...server, rate, configured, monthsInCycle, monthlyOrig, monthlyCny, cycleAmountCny };
    });

    const priced = servers.filter((server) => server.configured && server.unit !== "once");
    const oneTime = servers.filter((server) => server.configured && server.unit === "once");
    const unknown = servers.filter((server) => server.currency && !server.configured && server.priceCents !== null);
    const unpriced = servers.filter((server) => !server.currency || server.priceCents === null);

    const totalMonthly = priced.reduce((sum, server) => sum + server.monthlyCny, 0);
    const totalAnnual = totalMonthly * 12;

    function scheduleFor(server) {
      const cells = months.map(() => ({ amount: 0, prepaid: false, payments: 0 }));
      if (server.unit === "once" || !server.configured) return cells;
      const paid = server.paidUntil ? isoDay(server.paidUntil) : null;
      const start = paid && paid > today ? paid : today;
      const end = addMonths(windowStart, 12);
      for (let index = 0; index < 12; index += 1) {
        const startOfMonth = addMonths(windowStart, index);
        const endOfMonth = addMonths(windowStart, index + 1);
        if (startOfMonth >= end) break;
        if (endOfMonth <= start) cells[index].prepaid = true;
      }
      let due = new Date(start.getTime());
      let guard = 0;
      while (due < end && guard < 80) {
        const index = monthDiff(windowStart, due);
        if (index >= 0 && index < 12) {
          cells[index].amount += server.cycleAmountCny;
          cells[index].payments += 1;
        }
        due = addMonths(due, server.monthsInCycle);
        guard += 1;
      }
      return cells;
    }

    priced.forEach((server) => { server.schedule = scheduleFor(server); });
    const totalScheduled = priced.reduce(
      (sum, server) => sum + server.schedule.reduce((cellSum, cell) => cellSum + cell.amount, 0),
      0,
    );

    /* metrics */
    document.getElementById("cost-monthly").textContent = fmtCny(totalMonthly);
    document.getElementById("cost-annual").textContent = fmtCny(totalAnnual);
    document.getElementById("cost-next").textContent = fmtCny(totalScheduled);
    const oneTimeCny = oneTime.reduce((sum, server) => sum + (server.cycleAmountCny || 0), 0);
    document.getElementById("cost-monthly-sub").textContent =
      `${priced.length} 台计费 · 一次性 ${oneTime.length ? fmtCny(oneTimeCny) : "¥0"} 未计入`;
    document.getElementById("cost-annual-sub").textContent = "按当前价格与周期年化";
    const saved = totalAnnual - totalScheduled;
    document.getElementById("cost-next-sub").textContent =
      saved > 0 ? `比年化少 ${fmtCny(saved)}（已预付）` : "按 paid_until 排期";

    /* empty state: no configured recurring cost at all */
    if (priced.length === 0) {
      const copy = `<div class="empty-state"><div class="empty-icon">¥</div><div class="empty-title">还没有可折算的成本</div><div class="empty-desc">先在服务器页填写价格、币种与计费周期；未知币种需要在设置中配置汇率。</div></div>`;
      document.getElementById("cost-calendar").innerHTML = copy;
      document.getElementById("cost-bars").innerHTML = copy;
      document.getElementById("currency-mix").innerHTML = "";
      document.getElementById("currency-mix-legend").innerHTML = "";
      document.getElementById("cost-monthly").textContent = "¥0";
      document.getElementById("cost-annual").textContent = "¥0";
      document.getElementById("cost-next").textContent = "—";
      return;
    }

    /* calendar */
    const calendar = document.getElementById("cost-calendar");
    const maxCell = Math.max(...priced.map((server) => server.cycleAmountCny || 0), 1);
    const groups = [];
    const groupMap = new Map();
    priced.forEach((server) => {
      if (!groupMap.has(server.currency)) {
        groupMap.set(server.currency, []);
        groups.push(server.currency);
      }
      groupMap.get(server.currency).push(server);
    });
    groups.sort((a, b) => {
      const sum = (currency) => groupMap.get(currency).reduce((value, server) => value + server.monthlyCny, 0);
      return sum(b) - sum(a);
    });

    let html = `<div class="cal-row cal-head"><div class="cal-label"></div>${monthLabel.map((label) => `<div class="cal-cell">${label}</div>`).join("")}</div>`;
    groups.forEach((currency) => {
      const rows = groupMap.get(currency).sort((a, b) => b.monthlyCny - a.monthlyCny);
      html += `<div class="cal-group">${currency} · ${rows.length} 台 · ${fmtCny(rows.reduce((sum, server) => sum + server.monthlyCny, 0))}/月</div>`;
      rows.forEach((server) => {
        html += `<div class="cal-row"><div class="cal-label"><span class="name">${server.name}</span><span class="chip cur">${server.currency}</span></div>`;
        server.schedule.forEach((cell, index) => {
          const month = months[index];
          const monthText = `${month.getUTCFullYear()}-${pad2(month.getUTCMonth() + 1)}`;
          if (cell.amount > 0) {
            const fill = Math.min(55, 8 + Math.round((cell.amount / maxCell) * 47));
            const title = `${server.name} · ${monthText} · 原币 ${fmtAmount(cell.amount / server.rate, server.currency)} · 按 ${server.rate} 折算 ${fmtCny(cell.amount)}`;
            html += `<div class="cal-cell is-pay" style="--fill:${fill}%" title="${title}"><span class="amt">${Math.round(cell.amount / 100)}</span></div>`;
          } else if (cell.prepaid) {
            const title = `${server.name} · ${monthText} · 已预付（paid_until ${server.paidUntil}）`;
            html += `<div class="cal-cell is-prepaid" title="${title}"></div>`;
          } else {
            const title = `${server.name} · ${monthText} · 本周期无付款`;
            html += `<div class="cal-cell is-empty" title="${title}"></div>`;
          }
        });
        html += "</div>";
      });
    });
    calendar.innerHTML = html;

    /* top bars */
    const top = [...priced].sort((a, b) => b.monthlyCny - a.monthlyCny).slice(0, 5);
    const maxTop = top[0] ? top[0].monthlyCny : 1;
    document.getElementById("cost-bars").innerHTML = top.map((server, index) => {
      const share = totalMonthly > 0 ? server.monthlyCny / totalMonthly : 0;
      const sharePct = Math.round(share * 100);
      const tip = `${server.name} · 原币 ${fmtAmount(server.monthlyOrig, server.currency)}/月 · 汇率 ${server.rate < 1 ? server.rate.toFixed(3) : server.rate.toFixed(2)} · 折合 ${fmtCny(server.monthlyCny)}/月 · 占 ${sharePct}%`;
      return `<div class="bar-row" title="${tip}">
        <span class="bar-rank">${index + 1}</span>
        <span class="bar-name"><span class="name">${server.name}</span><span class="chip cur">${server.currency}</span></span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(4, (server.monthlyCny / maxTop) * 100)}%"></span></span>
        <span class="bar-value">${fmtCny(server.monthlyCny)}</span>
        <span class="bar-share">${sharePct}%</span>
      </div>`;
    }).join("");
    const topShare = top.reduce((sum, server) => sum + server.monthlyCny, 0) / totalMonthly;
    document.getElementById("cost-top-share").textContent = `前 5 占 ${pct(topShare)}`;

    /* currency mix: original exposure vs CNY share */
    const currencyOrder = ["CNY", "USD", "EUR", "JPY"];
    const mix = currencyOrder
      .map((currency) => {
        const rows = priced.filter((server) => server.currency === currency);
        if (!rows.length) return null;
        const cny = rows.reduce((sum, server) => sum + server.monthlyCny, 0);
        const original = rows.reduce((sum, server) => sum + server.monthlyOrig, 0);
        return { currency, cny, original, share: cny / totalMonthly };
      })
      .filter(Boolean)
      .sort((a, b) => b.cny - a.cny);
    document.getElementById("currency-mix").innerHTML = mix.map((item, index) =>
      `<span class="mix-seg series-${(index % 4) + 1}" style="width:${item.share * 100}%" title="${item.currency} · 折合 ${fmtCny(item.cny)} · ${pct(item.share)}"></span>`).join("");
    document.getElementById("currency-mix-legend").innerHTML = mix.map((item, index) =>
      `<div class="mix-row" title="${item.currency} · 原币 ${fmtAmount(item.original, item.currency)}/月 · 折合 ${fmtCny(item.cny)}/月 · ${pct(item.share)}">
        <span class="mix-name"><span class="mix-dot series-${(index % 4) + 1}"></span><span class="chip cur">${item.currency}</span></span>
        <span class="mix-orig">${fmtAmount(item.original, item.currency)}/月</span>
        <span class="mix-cny">${fmtCny(item.cny)}</span>
        <span class="mix-share">${pct(item.share)}</span>
      </div>`).join("");

    /* warnings */
    const warning = document.getElementById("cost-warning");
    if (unknown.length) {
      const names = unknown.map((server) => `${server.name} ${fmtAmount(server.priceCents, server.currency)}/月`).join("；");
      warning.hidden = false;
      warning.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
        <span class="warn-copy"><strong>${unknown.map((server) => server.currency).join(" / ")}</strong> · ${unknown.length} 台使用未配置汇率的币种，未计入总额。${names}</span>
        <a class="warn-tail" href="#" title="设置 → 汇率">去设置 →</a>`;
    }
    const rateItems = Object.entries(rates)
      .filter(([currency]) => currency !== "CNY")
      .map(([currency, rate]) =>
        `<span class="fx-rate"><span class="chip cur">${currency}</span> ${rate < 1 ? rate.toFixed(3) : rate.toFixed(2)}</span>`).join("");
    document.getElementById("fx-rates").innerHTML = rateItems;
    document.getElementById("cost-once").textContent = oneTime.length
      ? `一次性：${oneTime.map((server) => `${server.name} ${fmtAmount(server.priceCents, server.currency)}（${server.paidUntil} 到期，不计入年化/预测）`).join("；")}${unpriced.length ? ` · 另有 ${unpriced.length} 台未填价格` : ""}`
      : `另有 ${unpriced.length} 台未填价格，未计入`;
  }

  /* ---------- server status view ---------- */
  function initServer(config) {
    const servers = config.servers;
    const days = ["11/16 周一", "11/17 周二", "11/18 周三", "11/19 周四", "11/20 周五", "11/21 周六", "11/22 周日"];
    const offline = {
      "香港-03": [[3, 3, 6], [5, 2, 5]],
      "美西-01": [[6, 4, 11]],
    };
    const loadSpikes = {
      "新加坡-02": [[4, 18, 21, 8.4], [5, 19, 21, 6.2]],
      "东京-02": [[5, 20, 23, 3.8]],
    };

    function wave(seed, hour, day) {
      return Math.sin((hour / 24) * Math.PI * 2 + seed) * 0.5 + Math.sin(day * 1.7 + seed) * 0.5;
    }

    servers.forEach((server, serverIndex) => {
      server.data = [];
      for (let day = 0; day < 7; day += 1) {
        for (let hour = 0; hour < 24; hour += 1) {
          const future = day === 6 && hour >= 11;
          const noData = Boolean(server.noData);
          const isOffline = !noData && (offline[server.name] || []).some((run) =>
            run[0] === day && hour >= run[1] && hour < run[2]);
          const spike = (loadSpikes[server.name] || []).find((run) =>
            run[0] === day && hour >= run[1] && hour < run[2]);
          const load = server.noData ? null : Math.max(0,
            server.load + wave(serverIndex * 1.3 + 0.2, hour, day) * 0.18 + (spike ? spike[3] : 0));
          const mem = server.noData ? null : Math.min(0.98, Math.max(0.1,
            server.mem + Math.min(day, 6) * server.memRamp + wave(serverIndex + 1.1, hour, day) * 0.015));
          const disk = server.noData ? null : Math.min(0.99, Math.max(0.1,
            server.disk + Math.min(day, 6) * server.diskRamp + Math.max(0, hour - 12) * 0.0008));
          server.data.push({
            day, hour, future, noData,
            online: noData ? null : (isOffline ? 0 : 1),
            load, mem, disk,
            latency: server.noData ? null : server.latency + Math.round(wave(serverIndex, hour, day) * 6),
          });
        }
      }
    });

    const sampled = servers.filter((server) => !server.noData);
    const last24 = sampled.map((server) => {
      const cells = server.data.slice(5 * 24 + 11, 6 * 24 + 11);
      return cells.reduce((sum, cell) => sum + cell.online, 0) / cells.length;
    });
    const uptime24 = last24.reduce((sum, value) => sum + value, 0) / last24.length;
    const uptime7d = sampled.reduce(
      (sum, server) => sum + server.data.filter((cell) => !cell.future).reduce((inner, cell) => inner + cell.online, 0)
        / server.data.filter((cell) => !cell.future).length,
      0,
    ) / sampled.length;

    document.getElementById("server-uptime").textContent = pct(uptime24, 1);
    document.getElementById("server-uptime-sub").textContent = `7 天 ${pct(uptime7d, 1)} · ${sampled.length} 台有采样`;
    document.getElementById("server-anomalies").textContent = "3";
    document.getElementById("server-anomalies-sub").textContent = "2 台离线过 · 1 台资源告警";
    document.getElementById("server-disk").textContent = "91%";
    document.getElementById("server-disk-sub").textContent = "东京-02 · 已持续 27h";

    const modeCopy = {
      composite: "颜色 = 负载 / 内存 / 硬盘中最差的一项；斜纹 = 离线或无采样。",
      load: "颜色 = load1 绝对值（未按 CPU 核数归一），斜纹 = 离线或无采样。",
      mem: "颜色 = 内存使用率，斜纹 = 离线或无采样。",
      disk: "颜色 = 硬盘使用率，斜纹 = 离线或无采样。",
    };
    let mode = "composite";

    function metricValue(cell) {
      if (mode === "load") return cell.load / 4;
      if (mode === "mem") return cell.mem;
      if (mode === "disk") return cell.disk;
      return Math.max(cell.load / 4, cell.mem, cell.disk);
    }

    function sevClass(cell) {
      if (cell.noData) return "nodata";
      if (cell.future) return "future";
      if (cell.online === 0) return "offline";
      const value = metricValue(cell);
      if (value >= 0.9) return "sev4";
      if (value >= 0.8) return "sev3";
      if (value >= 0.6) return "sev2";
      return "sev1";
    }

    function cellTitle(server, cell) {
      const date = `11/${16 + cell.day}`;
      if (cell.noData) return `${server.name} · ${date} ${pad2(cell.hour)}:00 · 无采样`;
      if (cell.future) return `${server.name} · ${date} ${pad2(cell.hour)}:00 · 尚未发生`;
      const online = cell.online ? "在线" : "离线";
      return `${server.name} · ${date} ${pad2(cell.hour)}:00 · ${online} · 负载 ${cell.load.toFixed(2)} · 内存 ${pct(cell.mem)} · 硬盘 ${pct(cell.disk)} · RTT ${cell.latency} ms`;
    }

    function renderGrid(root, isMobile) {
      const cols = isMobile ? 24 : 168;
      const rows = servers.map((server) => {
        const cells = isMobile ? server.data.slice(5 * 24 + 11, 6 * 24 + 11) : server.data;
        const items = cells.map((cell) => {
          const title = cellTitle(server, cell);
          return `<div class="hm-cell ${sevClass(cell)}" title="${title}" aria-label="${title}"></div>`;
        }).join("");
        const dot = server.noData ? "off" : (server.data[6 * 24 + 10].online === 0 ? "danger" : "primary");
        return `<div class="hm-row"><div class="hm-name"><span class="dot ${dot}"></span><span class="name">${server.name}</span><span class="flag">${server.flag || ""}</span></div>${items}</div>`;
      }).join("");

      let head;
      if (isMobile) {
        head = `<div class="hm-head" style="--cols:${cols}"><div></div><div class="hm-day" style="grid-column:span 24">11/21 11:00 → 11/22 11:00</div></div>
          <div class="hm-hour-axis"><span>11:00</span><span>17:00</span><span>23:00</span><span>05:00</span><span>11:00</span></div>`;
      } else {
        head = `<div class="hm-head" style="--cols:${cols}"><div></div>${days.map((day) => `<div class="hm-day" style="grid-column:span 24">${day}</div>`).join("")}</div>`;
      }
      root.innerHTML = `${head}${rows}`;
      root.style.setProperty("--cols", String(cols));
    }

    const desktop = document.getElementById("server-heat-desktop");
    const mobile = document.getElementById("server-heat-mobile");
    function renderAll() {
      renderGrid(desktop, false);
      renderGrid(mobile, true);
      document.getElementById("server-heat-desc").textContent = modeCopy[mode];
    }
    renderAll();
    document.querySelectorAll("[data-heat-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        mode = button.dataset.heatMode;
        document.querySelectorAll("[data-heat-mode]").forEach((item) =>
          item.setAttribute("aria-pressed", String(item === button)));
        renderAll();
      });
    });

    const current = servers.map((server) => {
      const cell = server.data[6 * 24 + 10];
      return { server, cell };
    }).filter(({ server }) => !server.noData).sort((a, b) => {
      const risk = (item) => Math.max(item.cell.load / 4, item.cell.mem, item.cell.disk);
      return risk(b) - risk(a);
    });

    document.getElementById("server-resources").innerHTML = current.slice(0, 6).map(({ server, cell }) => {
      const loadTone = cell.load / 4 >= 0.85 ? "danger" : cell.load / 4 >= 0.7 ? "warn" : "";
      const memTone = cell.mem >= 0.85 ? "danger" : cell.mem >= 0.7 ? "warn" : "";
      const diskTone = cell.disk >= 0.85 ? "danger" : cell.disk >= 0.7 ? "warn" : "";
      const state = cell.online === 0 ? "离线" : (Math.max(cell.load / 4, cell.mem, cell.disk) >= 0.85 ? "告警" : "");
      const dot = cell.online === 0 ? "danger" : state === "告警" ? "warn" : "primary";
      return `<div class="resource-row">
        <div class="resource-name"><span class="dot ${dot}"></span><span class="name">${server.name}</span>${state ? `<span class="chip ${state === "告警" ? "warn" : "danger"}">${state}</span>` : ""}</div>
        <div class="resource-bars">
          <div class="resource-bar"><span>负载</span><span class="resource-track"><span class="resource-fill ${loadTone}" style="width:${Math.min(100, (cell.load / 4) * 100)}%"></span></span><span class="resource-val">${cell.load.toFixed(2)}</span></div>
          <div class="resource-bar"><span>内存</span><span class="resource-track"><span class="resource-fill ${memTone}" style="width:${Math.min(100, cell.mem * 100)}%"></span></span><span class="resource-val">${pct(cell.mem)}</span></div>
          <div class="resource-bar"><span>硬盘</span><span class="resource-track"><span class="resource-fill ${diskTone}" style="width:${Math.min(100, cell.disk * 100)}%"></span></span><span class="resource-val">${pct(cell.disk)}</span></div>
        </div>
      </div>`;
    }).join("");

    document.getElementById("server-anomaly-list").innerHTML = config.anomalies.map((item) => `
      <div class="anomaly">
        <span class="dot ${item.tone || "warn"}" style="margin-top:5px"></span>
        <div class="body">
          <div class="line1"><span class="name">${item.name}</span><span class="when">${item.when}</span></div>
          <div class="what">${item.what}</div>
        </div>
        <span class="dur">${item.duration}</span>
      </div>`).join("");
  }

  /* ---------- chain view ---------- */
  function initChain(config) {
    const buckets = 96;
    const startLabel = "11/21 11:00";
    const endLabel = "11/22 11:00";
    const minY = 0;
    const maxY = 120;

    function timeLabel(index) {
      const minutes = 11 * 60 + index * 15; // 11:00 + 15m
      const day = minutes >= 24 * 60 ? 22 : 21;
      const current = minutes % (24 * 60);
      return `11/${day} ${pad2(Math.floor(current / 60))}:${pad2(current % 60)}`;
    }

    function buildSeries(base, anomaly) {
      const values = [];
      const lower = [];
      const upper = [];
      for (let index = 0; index < buckets; index += 1) {
        const hour = ((11 + index * 0.25) % 24);
        let value = base + Math.sin(index / 6.5) * 1.6 + Math.sin(index / 17) * 1.1;
        let variance = 2.2;
        if (anomaly && index >= anomaly[0] && index < anomaly[1]) {
          value += anomaly[2];
          variance = 5.5;
        }
        values.push(Math.max(1, value));
        lower.push(Math.max(0, value - variance));
        upper.push(value + variance);
      }
      return { values, lower, upper };
    }

    const chains = config.chains.map((chain) => {
      const segments = chain.segments.map((segment) => {
        const series = buildSeries(segment.base, segment.anomaly);
        const current = series.values[buckets - 1];
        const baseline = segment.base;
        return { ...segment, ...series, current, baseline, delta: current - baseline };
      });
      const overallValues = Array.from({ length: buckets }, (_, index) =>
        segments.reduce((sum, segment) => sum + segment.values[index], 0));
      const overallLower = Array.from({ length: buckets }, (_, index) =>
        segments.reduce((sum, segment) => sum + segment.lower[index], 0));
      const overallUpper = Array.from({ length: buckets }, (_, index) =>
        segments.reduce((sum, segment) => sum + segment.upper[index], 0));
      const current = overallValues[buckets - 1];
      const baseline = segments.reduce((sum, segment) => sum + segment.baseline, 0);
      return {
        ...chain,
        segments,
        overall: { values: overallValues, lower: overallLower, upper: overallUpper },
        current,
        baseline,
        delta: current - baseline,
      };
    });

    let selected = chains.find((chain) => chain.id === config.selected) || chains[0];

    function deltaText(delta) {
      if (!Number.isFinite(delta)) return "—";
      if (Math.abs(delta) < 0.5) return "持平";
      return `${delta > 0 ? "+" : ""}${delta.toFixed(0)} ms`;
    }

    function renderOverall() {
      document.getElementById("chain-rows").innerHTML = chains.map((chain) => {
        const empty = chain.segments.length === 0;
        const tone = empty ? "muted" : chain.delta >= 8 ? "up" : chain.delta <= -8 ? "down" : "muted";
        const value = empty ? "—" : `${chain.current.toFixed(0)} ms`;
        const delta = empty ? "无跳间样本" : deltaText(chain.delta);
        const numeric = chain.overall.values.filter((value) => value !== null);
        const rowMin = numeric.length ? Math.max(0, Math.floor((Math.min(...numeric) * 0.82) / 10) * 10) : minY;
        const rowMax = numeric.length ? Math.max(rowMin + 20, Math.ceil((Math.max(...numeric) * 1.18) / 10) * 10) : maxY;
        const svg = empty
          ? `<svg class="spark-svg" viewBox="0 0 600 42" preserveAspectRatio="none" aria-hidden="true"><line class="baseline" x1="0" x2="600" y1="21" y2="21" /></svg>`
          : svgSpark({
              values: chain.overall.values,
              lower: chain.overall.lower,
              upper: chain.overall.upper,
              baseline: chain.baseline,
              minY: rowMin,
              maxY: rowMax,
              incident: chain.segments.map((segment) => segment.anomaly).find(Boolean) || null,
            });
        const rowTip = empty
          ? `${chain.name} · 无跳间样本`
          : `${chain.name} · 当前 ${chain.current.toFixed(0)} ms · 7 天基线 ${chain.baseline.toFixed(0)} ms · ${deltaText(chain.delta)}`;
        return `<button type="button" class="spark-row ${chain.id === selected.id ? "is-selected" : ""}" data-chain="${chain.id}" aria-pressed="${chain.id === selected.id}" title="${rowTip}">
          <span class="spark-label">
            <span class="spark-name"><span class="name">${chain.name}</span>${chain.path === "multi" ? `<span class="chip">多路径</span>` : ""}${empty ? `<span class="chip">无样本</span>` : ""}</span>
            <span class="spark-meta">${chain.segments.length} 段 · ${chain.path === "multi" ? "估算" : "单路径"} · 虚线为 7 天基线</span>
          </span>
          ${svg}
          <span class="spark-value"><span class="v">${value}</span><span class="d ${tone}">${delta}</span></span>
        </button>`;
      }).join("");

      document.querySelectorAll("[data-chain]").forEach((button) => {
        button.addEventListener("click", () => {
          selected = chains.find((chain) => chain.id === button.dataset.chain) || selected;
          renderOverall();
          renderHop();
        });
      });
      const allSegments = chains.flatMap((chain) =>
        chain.segments.map((segment) => ({ chain, segment })));
      const slowest = allSegments.reduce((best, item) =>
        !best || item.segment.current > best.segment.current ? item : best, null);
      document.getElementById("chain-slowest").textContent = slowest
        ? `${slowest.segment.current.toFixed(0)} ms`
        : "—";
      document.getElementById("chain-slowest-sub").textContent = slowest
        ? `${slowest.chain.name} · 第 ${slowest.segment.seq} 段`
        : "没有跳间样本";
      document.getElementById("chain-current").textContent = selected.segments.length
        ? `${selected.current.toFixed(0)} ms`
        : "—";
      document.getElementById("chain-current-sub").textContent = selected.segments.length
        ? `较 7 天基线 ${deltaText(selected.delta)} · ${selected.name}`
        : `${selected.name} 没有跳间样本`;
    }

    function renderHop() {
      const title = document.getElementById("hop-title");
      const meta = document.getElementById("hop-meta");
      const body = document.getElementById("hop-body");
      const diagnosis = document.getElementById("hop-diagnosis");
      title.textContent = "逐段时延";
      if (!selected.segments.length) {
        meta.textContent = `${selected.name} · 单跳链 / 无跳间探测`;
        body.innerHTML = `<div class="empty"><div class="empty-icon">—</div><div class="empty-title">没有跳间样本</div><div class="empty-desc">单跳链的入口组没有上一跳；端到端时延请查看链列表的实时值。</div></div>`;
        diagnosis.hidden = true;
        document.getElementById("hop-contrib").innerHTML = "";
        return;
      }
      meta.textContent = `${selected.name} · ${selected.segments.length} 段 · ${selected.path === "multi" ? "多路径估算" : "单路径"} · 24h`;

      const contrib = selected.segments.map((segment) => ({
        label: `第 ${segment.seq} 段`,
        delta: segment.delta,
      }));
      const totalDelta = contrib.reduce((sum, item) => sum + item.delta, 0);
      const maxPositive = contrib.reduce((best, item) => item.delta > best.delta ? item : best, contrib[0]);
      const maxShare = totalDelta > 0 ? maxPositive.delta / totalDelta : 0;
      let diagnosisText;
      if (totalDelta >= 8 && maxPositive.delta >= 5 && maxShare >= 0.6) {
        diagnosisText = `<strong>单段变慢</strong>：整体 ${deltaText(totalDelta)}，其中${maxPositive.label} ${deltaText(maxPositive.delta)}，贡献 ${Math.round(maxShare * 100)}%；其余段基本持平。`;
      } else if (totalDelta >= 8) {
        diagnosisText = `<strong>整体变慢</strong>：整体 ${deltaText(totalDelta)}，各段同步上升，没有单段主导。`;
      } else if (totalDelta <= -8) {
        diagnosisText = `<strong>整体变快</strong>：整体 ${deltaText(totalDelta)}。`;
      } else {
        diagnosisText = `<strong>稳定</strong>：整体 ${deltaText(totalDelta)}，没有超过 8 ms 的变化。`;
      }
      diagnosis.hidden = false;
      diagnosis.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg><span>${diagnosisText}</span>`;

      const maxDelta = Math.max(8, ...contrib.map((item) => Math.abs(item.delta)));
      const contribHtml = contrib.map((item) => {
        const width = Math.min(50, (Math.abs(item.delta) / maxDelta) * 50);
        const positive = item.delta >= 0;
        const style = positive
          ? `left:50%;width:${width}%`
          : `left:${50 - width}%;width:${width}%`;
        return `<div class="contrib-row"><span class="contrib-label">${item.label}</span><span class="contrib-track"><span class="contrib-fill ${positive ? "" : "down"}" style="${style}"></span></span><span class="contrib-val ${positive ? "up" : ""}">${deltaText(item.delta)}</span></div>`;
      }).join("");

      function heatClass(value) {
        if (value === null || value === undefined) return "nodata";
        if (value >= 45) return "l4";
        if (value >= 32) return "l3";
        if (value >= 22) return "l2";
        return "l1";
      }

      function renderHeat(root, mobile) {
        const cols = mobile ? 24 : 96;
        const step = mobile ? 4 : 1;
        const labels = mobile
          ? ["11:00", "17:00", "23:00", "05:00", "11:00"]
          : ["11:00", "17:00", "23:00", "05:00", "11:00"];
        const rows = selected.segments.map((segment) => {
          const cells = [];
          for (let index = 0; index < cols; index += 1) {
            const from = index * step;
            const values = segment.values.slice(from, from + step);
            const missing = index === 8 || index === 37;
            const value = missing ? null : values.reduce((sum, item) => sum + item, 0) / values.length;
            const title = missing
              ? `第 ${segment.seq} 段 · ${timeLabel(from)} · 无样本`
              : `第 ${segment.seq} 段 ${segment.from} → ${segment.to} · ${timeLabel(from)} · P50 ${value.toFixed(1)} ms · 样本 ${step * 4}`;
            cells.push(`<div class="hop-cell ${heatClass(value)}" title="${title}" aria-label="${title}"></div>`);
          }
          return `<div class="hop-row"><div class="hop-label"><span class="seg">第 ${segment.seq} 段</span><span class="ends">${segment.from} → ${segment.to}</span></div>${cells.join("")}</div>`;
        }).join("");
        root.innerHTML = `<div class="hop-axis">${labels.map((label) => `<span>${label}</span>`).join("")}</div>${rows}`;
        root.style.setProperty("--cols", String(cols));
      }

      body.innerHTML = `<div class="hop-heat hop-desktop" id="hop-heat-desktop"></div><div class="hop-heat hop-mobile" id="hop-heat-mobile"></div>`;
      renderHeat(document.getElementById("hop-heat-desktop"), false);
      renderHeat(document.getElementById("hop-heat-mobile"), true);
      document.getElementById("hop-contrib").innerHTML = `<div class="contrib-title"><span>相对 7 天基线的增量</span><span>${deltaText(totalDelta)}</span></div>${contribHtml}`;
    }

    renderOverall();
    renderHop();
    document.getElementById("chain-window").textContent = `${startLabel} → ${endLabel}`;
    document.getElementById("chain-note").textContent =
      "跳间 P50 之和；不含最后一跳到链目标；多路径链为估算值。";
  }

  window.PV = { initTheme, initCost, initServer, initChain, fmtCny, fmtAmount };
  document.addEventListener("DOMContentLoaded", initTheme);
})();
