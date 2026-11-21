import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function read(relative) {
  return readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );
}

test("regular settings pairs updates + public base and keeps the rest full width", () => {
  const source = read("pages/Settings.tsx");
  // 两列网格 + 等高；单列时没有列位类，DOM 顺序就是 390 的顺序。
  assert.match(source, /md:grid-cols-2 md:items-stretch/);
  // 只有语义相邻的两张卡并排，且都带 h-full 由 items-stretch 拉平。
  assert.match(source, /className="h-full md:col-start-1 md:row-start-2"/);
  assert.match(source, /className="h-full md:col-start-2 md:row-start-2"/);
  // 面板、Agent 升级、公开状态页都整宽。
  assert.match(
    source,
    /title=\{t\("settings\.panel\.title"\)\}[\s\S]{0,160}className="md:col-span-2"/,
  );
  assert.match(
    source,
    /title=\{t\("settings\.agentUpgrade\.title"\)\}[\s\S]{0,160}className="md:col-span-2"/,
  );
  assert.match(
    source,
    /<PublicStatusCard[\s\S]{0,220}className="md:col-span-2"/,
  );

  // 顺序不变：面板 → 版本更新 → 对外地址 → Agent 升级 → 公开状态页。
  const order = [
    't("settings.panel.title")',
    "<UpdatesSection",
    't("settings.publicBase.title")',
    't("settings.agentUpgrade.title")',
    "<PublicStatusCard",
  ].map((needle) => source.indexOf(needle));
  assert.ok(order.every((index) => index >= 0), "all five cards must exist");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "order changed");
});

test("the one paired row stretches and only those two cards are half width", () => {
  const source = read("pages/Settings.tsx");
  // 一对（两张）短卡并排；多一张或少一张都会破坏等高/顺序。
  assert.equal((source.match(/className="h-full md:col-start-/g) ?? []).length, 2);
  // 行高由 items-stretch 决定，卡内不残留固定高度。
  assert.match(source, /md:items-stretch/);
  assert.doesNotMatch(source, /className="h-full md:row-start-1"/);
});

test("backup encryption is in the size card and save bars are page-level", () => {
  const settings = read("pages/Settings.tsx");
  // 独立加密卡已删除，开关移进「当前数据库大小」卡。
  const deadCard = ["Backup", "EncryptionCard"].join("");
  assert.doesNotMatch(settings, new RegExp(deadCard));
  const backup = read("components/settings/BackupCard.tsx");
  assert.match(backup, /backup_encrypt: next/);
  assert.match(backup, /checked=\{encryptionEnabled\}/);
  assert.match(backup, /settings\.backup\.encrypt\.offWarning/);
  assert.match(backup, /settings\.backup\.encrypt\.exportHint/);

  // 安全 tab：API 访问卡随安全表单一起渲染，但排在安全卡之前。
  assert.match(settings, /before=\{<ApiTokensCard \/>\}/);
  const securityFormStart = settings.indexOf("function SecurityForm");
  const securityForm = settings.slice(
    securityFormStart,
    settings.indexOf("\/** tab 顺序", securityFormStart),
  );
  assert.ok(
    securityForm.indexOf("{before ?") <
      securityForm.indexOf('id="settings-security-form"'),
    "API access must come before the security form",
  );

  // 三个 tab 共用 SettingsSaveBar；条在滚动区之外，不是 Card，也没有圆角/阴影。
  const saveBar = read("components/settings/SettingsSaveBar.tsx");
  assert.match(saveBar, /data-slot="settings-savebar"/);
  assert.match(saveBar, /border-t border-border bg-background/);
  assert.match(saveBar, /form=\{formId\}/);
  assert.doesNotMatch(saveBar, /<Card|CardContent|rounded-|shadow/);
  // 普通文档流：不能 sticky / fixed / 贴底。
  assert.doesNotMatch(saveBar, /className="[^"]*(sticky|fixed|bottom-0)/);
  const shell = read("components/settings/SettingsSaveBar.tsx");
  assert.doesNotMatch(shell, /overflow-y-auto/);
  // 普通流：children 在前，footer 在后。
  assert.match(shell, /\{children\}\s*\{footer\}/);
  for (const source of [
    settings,
    read("components/settings/AlertsCard.tsx"),
  ]) {
    assert.match(source, /SettingsSaveBar/);
  }
  assert.match(settings, /id="settings-general-form"/);
  assert.match(settings, /id="settings-security-form"/);
  assert.match(
    read("components/settings/AlertsCard.tsx"),
    /id="settings-alerts-form"/,
  );
});
