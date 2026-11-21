import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function read(relative) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/**
 * F1：所有列表错误态都必须走 `ListError` / `ListErrorRow`。
 *
 * 组件级渲染断言需要 DOM 运行时（项目只装了 node:test），这里改为对源文件做
 * 契约断言：`role="alert"` 必须在统一组件里出现，页面不得再手写错误块。
 */
test("ListError exposes role=alert and always renders a retry button", () => {
  const source = read("./common/ListError.tsx");
  assert.match(source, /role="alert"/);
  assert.ok(source.includes('data-slot="list-error"'));
  assert.ok(source.includes('t("common.retry")'));
  assert.ok(source.includes("TriangleAlertIcon"));
});

test("ListErrorRow keeps the table row/cell structure and spans all columns", () => {
  const source = read("./common/ListError.tsx");
  assert.ok(source.includes("<TableRow"));
  assert.ok(source.includes("<TableCell"));
  assert.match(source, /colSpan=\{colSpan\}/);
  // 行内错误复用同一个 ListError，不允许复制一份文案/图标。
  assert.match(source, /<ListError \{\.\.\.props\}/);
});

test("the shared list error component is exported from the common barrel", () => {
  const source = read("./common/index.ts");
  assert.match(source, /ListError,/);
  assert.match(source, /ListErrorRow/);
});

/** F1 覆盖清单：页面、日志面板、设置各 panel、用户端各页。 */
const COVERED_SURFACES = [
  "App.tsx",
  "pages/Servers.tsx",
  "pages/Users.tsx",
  "pages/Packages.tsx",
  "pages/Chains.tsx",
  "pages/Nodes.tsx",
  "pages/NodesIndex.tsx",
  "pages/Forwards.tsx",
  "pages/Outbounds.tsx",
  "pages/Subscriptions.tsx",
  "pages/ChainTemplates.tsx",
  "pages/Overview.tsx",
  "pages/Settings.tsx",
  "pages/me/Overview.tsx",
  "pages/me/Packages.tsx",
  "components/logs/EventsPanel.tsx",
  "components/logs/AuditPanel.tsx",
  "components/me/MeShell.tsx",
  "components/me/MyChainsCard.tsx",
  "components/me/MyForwardsCard.tsx",
  "components/me/MyForwardUsageCard.tsx",
  "components/sessions/SessionList.tsx",
  "components/nodes/NodeTrafficSheet.tsx",
  "components/servers/AgentUpgradeHistoryDialog.tsx",
  "components/servers/AgentBatchUpgradeProgressDialog.tsx",
  "components/settings/AlertsCard.tsx",
  "components/settings/ApiTokensCard.tsx",
  "components/settings/BackupCard.tsx",
  "components/settings/BackupEncryptionCard.tsx",
  "components/settings/RemoteBackupCard.tsx",
  "components/settings/UpdatesSection.tsx",
  "components/settings/RuleTemplatesPanel.tsx",
  "components/settings/CertificatesPanel.tsx",
  "components/settings/SubscriptionTemplatesPanel.tsx",
];

test("every covered surface renders the shared list error component", () => {
  for (const surface of COVERED_SURFACES) {
    const source = read(`../${surface}`);
    assert.ok(
      source.includes("ListError") || source.includes("ListErrorRow"),
      `${surface} must use ListError/ListErrorRow`,
    );
    assert.ok(
      !source.includes("function ErrorRow("),
      `${surface} still defines a local ErrorRow`,
    );
    assert.ok(
      !source.includes(
        "mx-auto flex max-w-md flex-col items-center gap-3 text-center",
      ),
      `${surface} still has the duplicated inline error markup`,
    );
  }
});

test("tables use the row variant so sticky columns and borders stay intact", () => {
  const tableSurfaces = [
    "pages/Servers.tsx",
    "pages/Users.tsx",
    "pages/Packages.tsx",
    "pages/Chains.tsx",
    "pages/Nodes.tsx",
    "pages/Forwards.tsx",
    "pages/Outbounds.tsx",
    "pages/Subscriptions.tsx",
    "pages/ChainTemplates.tsx",
    "components/logs/EventsPanel.tsx",
    "components/logs/AuditPanel.tsx",
    "components/settings/ApiTokensCard.tsx",
    "components/settings/RuleTemplatesPanel.tsx",
    "components/settings/CertificatesPanel.tsx",
    "components/settings/SubscriptionTemplatesPanel.tsx",
  ];
  for (const surface of tableSurfaces) {
    const source = read(`../${surface}`);
    assert.match(
      source,
      /<ListErrorRow[\s\S]{0,200}?colSpan=/,
      `${surface} must use ListErrorRow with a colSpan`,
    );
  }
});

test("legacy duplicated error markup only exists inside ListError", () => {
  const legacy = "grid size-10 place-items-center rounded-full bg-destructive/10";
  const covered = new Set(COVERED_SURFACES.map((path) => `../${path}`));
  for (const surface of covered) {
    assert.ok(!read(surface).includes(legacy), `${surface} still owns an error glyph`);
  }
});
