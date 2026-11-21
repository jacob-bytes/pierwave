/**
 * 公开状态页空 / 筛选 / 全离线 / 关闭 / 失败五态的截图数据。
 *
 * 除了 `filtered` 与 `error`（两者先拿到正常数据，再在页面里触发状态），
 * 其余三态都由同一份 8 节点 fixture 派生；不启动后端、不写库。
 */
import { statusFixture } from "../status-hero/fixtures.mjs";

const EMPTY_SUMMARY = {
  servers_total: 0,
  servers_online: 0,
  nodes_total: 0,
  traffic_today: 0,
  traffic_month: 0,
};

function base(state) {
  const fixture = statusFixture(
    state === "all-offline" ? "all-offline" : "all-online",
  );
  // Panel name 不参与语言切换：用一个中性的品牌名，英文截图里不会混中文。
  return { ...fixture, panel_name: "PierWave" };
}

/**
 * 账期四种组合都出现在一屏里：
 * - srv-hk：四项齐全；
 * - srv-tokyo：只有到期日；
 * - srv-sg：只有价格 / 币种 / 周期；
 * - 其余：四项都缺 → 两行「未配置」。
 */
function withBilling(servers) {
  return servers.map((server) => {
    if (server.id === "srv-hk") {
      return {
        ...server,
        paid_until: "2026-12-17",
        price_cents: 26800,
        currency: "CNY",
        billing_cycle: "monthly",
      };
    }
    if (server.id === "srv-tokyo") {
      return { ...server, paid_until: "2026-12-01" };
    }
    if (server.id === "srv-sg") {
      return {
        ...server,
        price_cents: 9900,
        currency: "USD",
        billing_cycle: "yearly",
      };
    }
    return server;
  });
}

export function publicStatusFixture(state) {
  if (state === "empty") {
    return {
      ...base("all-online"),
      summary: EMPTY_SUMMARY,
      servers: [],
    };
  }
  if (state === "ready" || state === "selected") {
    const fixture = base("all-online");
    return { ...fixture, servers: withBilling(fixture.servers) };
  }
  return base(state);
}

export const DISABLED_BODY = {
  code: "public_status.disabled",
  error: "公开状态页已关闭",
};

export const ERROR_BODY = {
  code: "internal",
  error: "internal server error",
};

export const HERO_LABEL = {
  "zh-CN": "服务概况",
  en: "Service overview",
};

export const EXPECTED = {
  empty: {
    "zh-CN": {
      title: "状态页已就绪",
      description: "还没有接入任何节点。",
      notFailure: ["加载失败", "无法获取", "重试"],
    },
    en: {
      title: "Status page is ready",
      description: "No nodes have been connected yet.",
      notFailure: ["failed", "unavailable", "Retry"],
    },
  },
  filtered: {
    "zh-CN": {
      title: "没有匹配的节点",
      action: "清除筛选",
    },
    en: {
      title: "No matching nodes",
      action: "Clear filters",
    },
  },
  "all-offline": {
    "zh-CN": {
      note: /最近一次更新 \d{2}:\d{2}:\d{2}/,
      chip: "离线",
      headline: "当前没有在线节点",
    },
    en: {
      note: /Last updated \d{2}:\d{2}:\d{2}/,
      chip: "Offline",
      headline: "No nodes online right now",
    },
  },
  disabled: {
    "zh-CN": {
      title: "状态页未开放",
      description: "如需了解服务状态，请联系服务提供方。",
      retry: /重试/,
    },
    en: {
      title: "This status page is not public",
      description: "Contact the service provider if you need the current status.",
      retry: /Retry/i,
    },
  },
  error: {
    "zh-CN": {
      title: "暂时无法获取服务状态",
      lastSuccess: /上次成功 \d{2}:\d{2}:\d{2}/,
      retry: "重试",
    },
    en: {
      title: "Service status is temporarily unavailable",
      lastSuccess: /Last success \d{2}:\d{2}:\d{2}/,
      retry: "Retry",
    },
  },
  ready: {
    "zh-CN": {
      kpi: "平均延迟",
      latency: /44\s*ms/,
      notSet: "未配置",
      fullBilling: "¥268.00 / 月",
      yearlyBilling: "$99.00 / 年",
    },
    en: {
      kpi: "Avg latency",
      latency: /44\s*ms/,
      notSet: "Not set",
      fullBilling: "¥268.00 / mo",
      yearlyBilling: "$99.00 / yr",
    },
  },
  selected: {
    "zh-CN": {
      kpi: "平均延迟",
      latency: /44\s*ms/,
      notSet: "未配置",
      fullBilling: "¥268.00 / 月",
      yearlyBilling: "$99.00 / 年",
    },
    en: {
      kpi: "Avg latency",
      latency: /44\s*ms/,
      notSet: "Not set",
      fullBilling: "¥268.00 / mo",
      yearlyBilling: "$99.00 / yr",
    },
  },
};
