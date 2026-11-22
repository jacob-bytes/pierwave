import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { alignClass, ID_CELL, NUMERIC_CELL, NUMERIC_HEAD } from "./tableCells.ts";

function read(relative) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

test("numeric cells are right aligned and use tabular figures", () => {
  assert.match(NUMERIC_CELL, /\btext-right\b/);
  assert.match(NUMERIC_CELL, /\btabular-nums\b/);
  assert.match(NUMERIC_HEAD, /\btext-right\b/);
});

test("id / address cells stay left aligned and monospace", () => {
  assert.match(ID_CELL, /\btext-left\b/);
  assert.match(ID_CELL, /\bfont-mono\b/);
  assert.doesNotMatch(ID_CELL, /\btext-right\b/);
});

test("alignClass maps the three column kinds", () => {
  assert.equal(alignClass("numeric"), NUMERIC_CELL);
  assert.equal(alignClass("id"), ID_CELL);
  assert.equal(alignClass("text"), undefined);
});

/** 数值列覆盖：每个页面至少有一处「右对齐 + 等宽数字」，且带对应的表头。 */
const NUMERIC_FILES = {
  "lib/tableColumns.ts": [
    // 负载 / 内存 / 速率三列表头右对齐（真实表头与骨架共用同一份元数据）
    "hidden text-right xl:table-cell",
    "text-right xl:table-cell",
  ],
  "pages/Packages.tsx": [
    // 额度 / 周期 / 倍率三个单元格
    "text-right font-mono text-xs tabular-nums",
    "text-right text-xs tabular-nums",
  ],
  "pages/Users.tsx": ["px-4 text-right", 'align="end"'],
  "pages/Subscriptions.tsx": ["px-4 text-right", 'align="end"'],
};

test("numeric columns keep text-right + tabular-nums in every covered page", () => {
  for (const [file, patterns] of Object.entries(NUMERIC_FILES)) {
    const source = read(`../${file}`);
    for (const pattern of patterns) {
      assert.ok(
        source.includes(pattern),
        `${file} is missing numeric alignment pattern: ${pattern}`,
      );
    }
  }
  // 流量条本身负责等宽数字，避免各页面重复写 tabular-nums。
  const usageBar = read("../components/UsageBar.tsx");
  assert.ok(usageBar.includes("tabular-nums"));
  assert.ok(usageBar.includes('align === "end"'));
});

test("servers memory / rate / load cells align their content to the right", () => {
  const source = read("../pages/Servers.tsx");
  assert.ok(source.includes('className="flex items-center justify-end gap-2"'));
  assert.ok(
    source.includes(
      'className="inline-flex items-center justify-end gap-2 whitespace-nowrap"',
    ),
  );
});

test("table rows share the 40px baseline and cells use the matching padding", () => {
  const source = read("../components/ui/table.tsx");
  assert.match(source, /"(?:[^"]*\s)?h-10\s/, "TableRow must carry h-10");
  assert.ok(
    source.includes("px-2 py-1.5"),
    "TableCell default padding must be py-1.5 so 28px actions fit 40px rows",
  );
});

test("multi-line tables were compacted into single-line rows", () => {
  const users = read("../pages/Users.tsx");
  // 身份列：名字与 short_code 同一行（不再堆两行）
  assert.ok(users.includes("items-baseline gap-1.5"));
  assert.ok(!users.includes("flex min-w-0 flex-col gap-1"));

  const chains = read("../pages/Chains.tsx");
  assert.match(chains, /renderChainName\(chain, true\)/);
  assert.match(chains, /renderChainGroups\(chain, false, true\)/);

  const nodes = read("../pages/Nodes.tsx");
  assert.match(nodes, /items-center gap-1\.5/);
  assert.match(nodes, /nodeMetaTitle\(node\)/);
});

/** W2：390 下榜单服务器行收敛成两行，桌面顺序由 order 恢复。 */
test("overview server leaderboard rows collapse to two lines below md", () => {
  // 原概览的榜单已整体搬进「流量」tab。
  const source = read("../components/overview/TrafficView.tsx");
  assert.ok(source.includes("md:flex-row"), "row switches to a single line at md");
  assert.ok(source.includes("md:contents"), "the two mobile rows flatten at md");
  assert.ok(source.includes("md:order-1"), "sparkline order is restored on desktop");
  assert.ok(source.includes("md:order-2"), "traffic order is restored on desktop");
  assert.ok(source.includes("md:order-3"), "status dot order is restored on desktop");
  assert.ok(source.includes("md:order-4"), "load order is restored on desktop");
  assert.ok(source.includes("md:order-5"), "chevron order is restored on desktop");
  assert.ok(
    !source.includes('className="hidden w-12 shrink-0 text-right font-mono'),
    "load is no longer hidden on mobile",
  );
  assert.ok(
    source.includes('className="min-w-0 flex-1 truncate text-sm" title={item.name}'),
    "truncated name keeps a desktop title",
  );
});

/** W3：移动端卡片提供行内复制，桌面表格保留 title。 */
test("server mobile cards expose copy buttons for name and address", () => {
  const mobile = read("../components/common/MobileDataCard.tsx");
  assert.ok(mobile.includes("titleCopyValue"), "MobileDataCard takes a title copy value");
  assert.ok(mobile.includes("subtitleCopyValue"), "MobileDataCard takes a subtitle copy value");
  assert.ok(mobile.includes("CopyButton"), "copies reuse the shared CopyButton");
  assert.ok(mobile.includes("iconOnly"), "copy buttons stay inline on narrow cards");

  const servers = read("../pages/Servers.tsx");
  assert.ok(servers.includes("titleCopyValue={server.name}"));
  assert.ok(servers.includes("subtitleCopyValue={server.address}"));
  assert.ok(servers.includes('title={server.name}'), "desktop name keeps a title");
  assert.ok(servers.includes('title={server.address}'), "desktop address keeps a title");
});

/** W6：应用结果徽标放在身份列 / 详情字段，不侵入在线-离线状态列。 */
test("apply status lives in identity and detail, not the online status cell", () => {
  const servers = read("../pages/Servers.tsx");
  assert.ok(servers.includes("ApplyStatusBadge server={server}"), "table identity uses the badge");
  assert.ok(servers.includes("ApplyStatusSection server={server}"), "detail popover uses the section");
  assert.ok(servers.includes('label: t("servers.apply.title")'), "mobile cards put apply in a field");
  assert.ok(
    servers.includes('label: t("common.status"),\n              value: <StatusBadge server={server} />,'),
    "status field stays exclusively online/offline",
  );
  const component = read("../components/servers/ApplyStatus.tsx");
  assert.ok(component.includes("apply_error"), "failed keeps apply_error");
  assert.ok(component.includes("summary.stage"), "partial shows stage");
  assert.ok(component.includes("summary.effective"), "partial lists effective paths");
  assert.ok(component.includes("data-slot=\"apply-status\""), "badge has a stable test hook");
});
