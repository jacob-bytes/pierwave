import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./apiError.ts";
import {
  isEntryPortConflict,
  isTemplateUnsupported,
} from "./chainTemplateCreate.ts";

test("old masters are recognised from the error shape", () => {
  // serde 拒绝未知字段：直接说明 `template_id` 不认识。
  assert.equal(
    isTemplateUnsupported(
      new ApiError("unknown field `template_id`, expected `groups`", 400),
    ),
    true,
  );
  // 旧主控忽略 template_id 后把请求当成「没有 groups 的手建链」。
  assert.equal(
    isTemplateUnsupported(
      new ApiError("链必须包含 1-4 跳（当前 0 跳）", 400, "chain.hop_count_invalid"),
    ),
    true,
  );
  assert.equal(
    isTemplateUnsupported(
      new ApiError("链已启用但没有任何成员组", 400, "chain.groups_missing"),
    ),
    true,
  );
  // 后端明确给出「模板建链不支持」。
  assert.equal(
    isTemplateUnsupported(
      new ApiError("模板建链暂未支持", 422, "chain.template_unsupported"),
    ),
    true,
  );
  // 路由不存在（旧主控完全没有该接口）。
  assert.equal(
    isTemplateUnsupported(new ApiError("Not Found", 404, "route.not_found")),
    true,
  );
});

test("entry port conflicts are never treated as an unsupported master", () => {
  const conflict = new ApiError(
    "入口端口已被占用",
    409,
    "chain.entry_port_taken",
  );
  assert.equal(isEntryPortConflict(conflict), true);
  assert.equal(isTemplateUnsupported(conflict), false);
  // 同一个错误码但状态不是 409 时也不升级成「旧主控」。
  assert.equal(
    isTemplateUnsupported(
      new ApiError("入口端口已被占用", 400, "chain.entry_port_taken"),
    ),
    false,
  );
});

test("ordinary validation and permission errors keep their own message", () => {
  assert.equal(
    isTemplateUnsupported(
      new ApiError("服务器没有可用的 nftables", 400, "chain.nftables_unavailable"),
    ),
    false,
  );
  assert.equal(
    isTemplateUnsupported(
      new ApiError("入口组必须填写监听端口", 400, "chain.entry_port_required"),
    ),
    false,
  );
  assert.equal(
    isTemplateUnsupported(
      new ApiError("当前套餐不允许使用链模板", 403, "me.chain_template_not_allowed"),
    ),
    false,
  );
  assert.equal(isTemplateUnsupported(new Error("network down")), false);
  assert.equal(isTemplateUnsupported(null), false);
  assert.equal(isTemplateUnsupported(undefined), false);
});

test("entry port conflicts use the bilingual error dictionary", async () => {
  const { setCurrentLocale } = await import("../i18n/locale.ts");
  const { errorText } = await import("./errors.ts");
  const conflict = () =>
    new ApiError("入口端口已被占用", 409, "chain.entry_port_taken");

  setCurrentLocale("zh-CN");
  assert.equal(
    errorText(conflict(), "fallback"),
    "入口端口已被占用，请换一个端口后重试",
  );
  setCurrentLocale("en");
  assert.equal(
    errorText(conflict(), "fallback"),
    "The entry port is already in use; choose another port and try again",
  );
  setCurrentLocale("en");
});
