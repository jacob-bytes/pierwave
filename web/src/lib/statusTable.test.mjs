import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 公开页列表视图（`/status` 的 list 版式）的源码形状守卫。
 *
 * 列表数据全部来自 `GET /api/v1/public/status`（`PublicStatusServer` 已含
 * os_name / os_version / virt / arch）；不允许为了补「环境」列去逐台调详情
 * 接口 —— 那是 N+1。这里用源码断言把这条约束钉住。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(path.join(HERE, relative), "utf8");
const table = read("../components/status/ServerTable.tsx");

test("the list view renders an environment column from the list payload only", () => {
  // 第一行发行版、第二行 `虚拟化 · 架构`，两者都复用 publicStatus 里的纯函数。
  assert.match(table, /serverOsLine\(server\)/);
  assert.match(table, /serverPlatformLine\(server\)/);
  assert.match(table, /publicStatus\.table\.environment/);
  // 缺字段显示 —（不是空串，也不拼 `kvm · `）。
  assert.match(table, /os \?\? "—"/);
  assert.match(table, /platform \?\? "—"/);
  // N+1 守卫：列表不得调用详情查询，也不自己发请求。
  assert.doesNotMatch(table, /usePublicStatusDetail|useQuery|fetch\(|api\./);
  // 环境列插在节点列右侧，顺序在负载之前。
  assert.ok(
    table.indexOf("publicStatus.table.environment") <
      table.indexOf('t("publicStatus.server.load")'),
    "环境列必须位于节点与负载之间",
  );
});

test("resource columns are compressed to make room for the environment column", () => {
  // 节点收窄到 250，新增环境 220；负载 90、内存 / 硬盘各 170、可用率 110、
  // 心跳 130 —— 整体在 1440 内容区（1352）内，数值列不被挤到换行。
  for (const width of ["250px", "220px", "90px", "170px", "110px", "130px"]) {
    assert.ok(
      table.includes(`width: "${width}"`),
      `缺少列宽 ${width}`,
    );
  }
  assert.match(table, /table-fixed/);
  assert.match(table, /min-w-\[1140px\]/);
  // 数值列不改成右对齐；表格继续用等宽数字。
  assert.match(table, /tnum/);
});

test("the whole row is a link and Enter jumps to the detail page", () => {
  assert.match(table, /role="link"/);
  assert.match(table, /tabIndex=\{0\}/);
  assert.match(table, /event\.key !== "Enter"/);
  assert.match(table, /useNavigate\(\)/);
  // 与卡片一致的详情路径；id 必须 encode。
  assert.match(
    table,
    /navigate\(`\/status\/\$\{encodeURIComponent\(id\)\}`\)/,
  );
  // hover 背景反馈与指针光标（键盘聚焦也有反馈）。
  assert.match(table, /cursor-pointer/);
  assert.match(table, /hover:bg-muted\/40/);
  assert.match(table, /focus-visible:bg-muted\/60/);
});

test("row clicks ignore interactive descendants", () => {
  // 行内以后若出现按钮 / 输入 / 嵌套链接，点它们不能顺带跳详情。
  assert.match(table, /ROW_INTERACTIVE/);
  assert.match(table, /closest\(ROW_INTERACTIVE\)/);
  // 行自己的 role="link" 会被 closest 命中，必须排除，否则整行永远不跳。
  assert.match(table, /hit !== row/);
  assert.match(table, /defaultPrevented/);
});

test("the list page keeps rendering cards on the grid view at every width", () => {
  const page = read("../pages/Status.tsx");
  // list 版式才用表格；grid（390 的卡片）仍走 ServerCard，环境信息在卡片副行。
  assert.match(page, /view === "list" \? \(\s*<ServerTable/);
  assert.match(page, /<ServerCard key=\{server\.id\} server=\{server\} \/>/);
});
