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

  // 安全 tab：API 访问在安全卡之前。
  const apiIndex = settings.indexOf("<ApiTokensCard />");
  const securityIndex = settings.indexOf("<SecurityForm");
  assert.ok(apiIndex >= 0 && securityIndex >= 0);
  assert.ok(apiIndex < securityIndex, "API access must come before security");

  // 保存条在 form 之外，且自身不是 Card；按钮通过 form 属性提交外部表单。
  assert.match(
    settings,
    /<\/form>\s*<SaveBar\s+formId="settings-general-form"/,
  );
  assert.match(
    settings,
    /<\/form>\s*<SaveBar\s+formId="settings-security-form"/,
  );
  const saveBar = settings.slice(
    settings.indexOf("function SaveBar"),
    settings.indexOf("function GeneralForm"),
  );
  assert.doesNotMatch(saveBar, /<Card|CardContent|rounded-/);
  assert.match(saveBar, /form=\{formId\}/);
});
