import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { missingRequiredLabels } from "../lib/formRequired.ts";

function read(relative) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/**
 * F5：长表单对话框统一「头/脚固定 + 内容滚动」。
 *
 * 页脚必须永远在视口内，因此容器用 flex 列 + 88vh 上限，只有中间的内容区
 * 滚动；页脚自己不再参与滚动。这里断言四个表单都用了同一套外壳。
 */
const LONG_FORM_DIALOGS = [
  "components/packages/PackageFormDialog.tsx",
  "components/nodes/NodeFormDialog.tsx",
  "components/servers/ServerEditDialog.tsx",
  "pages/Servers.tsx",
];

test("long form dialogs pin header and footer, and scroll only the body", () => {
  for (const file of LONG_FORM_DIALOGS) {
    const source = read(`../${file}`);
    assert.ok(
      source.includes(
        "flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0",
      ),
      `${file} is missing the 88vh flex dialog shell`,
    );
    assert.match(
      source,
      /(?:min-h-0 flex-1[^"]*overflow-y-auto|min-h-0 flex-1 overflow-y-auto)/,
      `${file} is missing the scrollable body`,
    );
    assert.ok(
      source.includes('className="mx-0 mb-0 rounded-none border-border'),
      `${file} footer must sit flush against the dialog edge`,
    );
  }
});

test("server create dialog marks required fields and shows the missing list", () => {
  const source = read("../pages/Servers.tsx");

  // 必填标记：FormField required + 原生 required，两处都不能少。
  assert.ok(
    /htmlFor="server-name"\s+required/.test(source),
    "server name field must be marked required",
  );
  assert.ok(
    /htmlFor="server-address"\s+required/.test(source),
    "server address field must be marked required",
  );
  assert.ok(
    /id="server-name"[\s\S]{0,400}?required/.test(source),
    "name input must also get the native required attribute",
  );
  assert.ok(
    /id="server-address"[\s\S]{0,400}?required/.test(source),
    "address input must also get the native required attribute",
  );

  // 缺失项提示与按钮禁用条件同源。
  assert.ok(source.includes("missingRequiredLabels(["));
  assert.ok(source.includes('t("form.missingFields"'));
  assert.ok(
    /disabled=\{\s*create\.isPending \|\| createMissingLabels\.length > 0\s*\}/.test(
      source,
    ),
    "submit button must be disabled by the same missing-field list",
  );
});

test("missing-field wording exists in both locales", () => {
  const zh = read("../i18n/zh-CN.ts");
  const en = read("../i18n/en.ts");
  assert.match(zh, /missingFields:\s*"缺少：\{fields\}"/);
  assert.match(en, /missingFields:\s*"Missing: \{fields\}"/);
});

test("missingRequiredLabels feeds the footer hint without extra copy", () => {
  const labels = missingRequiredLabels([
    { label: "名称", value: "" },
    { label: "地址", value: "10.0.0.1" },
  ]);
  assert.deepEqual(labels, ["名称"]);
  assert.equal(labels.join(" · "), "名称");
});
