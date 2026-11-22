import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../components/servers/BillingFields.tsx", import.meta.url)),
  "utf8",
);

function indexOf(needle) {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `missing ${needle}`);
  return index;
}

test("费用与到期字段顺序：价格 → 币种 → 计费周期 → 到期日", () => {
  const order = [
    'label={t("servers.billing.price")}',
    'label={t("servers.billing.currency")}',
    'label={t("servers.billing.cycle")}',
    'label={t("servers.billing.paidUntil")}',
  ];
  const positions = order.map(indexOf);
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    "billing fields must render in the documented order",
  );
});

test("费用与到期是两行两列，390 单列按同一顺序堆叠", () => {
  assert.ok(
    source.includes('className="grid gap-3 sm:grid-cols-2"'),
    "billing fields should use a two-column grid from sm up",
  );
  // 价格与币种同在第一行，计费周期与到期日在第二行：由渲染顺序 + 两列网格保证。
  const price = indexOf('label={t("servers.billing.price")}');
  const paid = indexOf('label={t("servers.billing.paidUntil")}');
  assert.ok(paid > price, "paid_until must come after price");
});
