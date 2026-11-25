/**
 * 服务器列表密度与筛选的源码级回归。
 *
 * 这些是「表格粘住哪一列」「提示条在不在可见区」「卡头哪些控件属于同一组」
 * 这类布局契约，纯函数测不到；这里读组件源码断言结构，等 DOM 尺寸的断言
 * 放在 screenshots/server-list-density 的浏览器脚本里（行高 / 卡片高度）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import en from "../i18n/en.ts";
import zh from "../i18n/zh-CN.ts";
import { serverTableColumns } from "../lib/tableColumns.ts";

function read(relative) {
  return readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );
}

const servers = read("pages/Servers.tsx");
const table = read("components/ui/table.tsx");
const mobileCard = read("components/common/MobileDataCard.tsx");
const css = read("index.css");

test("名称列与复选框列一起 sticky，并带右侧阴影", () => {
  const columns = serverTableColumns((key) => key);
  const name = columns.find((column) => column.key === "name");
  assert.equal(name?.sticky, "left");
  // 复选框列 40px（w-10），名称列紧贴它的右侧。
  assert.match(name.headClassName, /left-10/);
  assert.match(name.headClassName, /pw-sticky-name/);

  assert.match(
    servers,
    /<TableCell\s+sticky="left"\s+className="pw-sticky-name left-10 max-w-56 px-2"/,
  );
  assert.match(servers, /sticky="right"/);
  assert.match(css, /\[data-slot="table-cell"\]\.pw-sticky-name/);
  assert.match(css, /box-shadow/);
});

test("滑动提示固定在表格右上角，不会被长表格或 sticky 操作列盖住", () => {
  const scrollStart = table.indexOf('data-slot="table-container"');
  const hintStart = table.indexOf('data-slot="table-scroll-hint"');
  // 提示条在滚动容器之前（表格上沿），不跟随横向滚动，也不在页脚。
  assert.ok(hintStart > 0 && hintStart < scrollStart);
  const hintBlock = table.slice(hintStart, hintStart + 700);
  assert.match(hintBlock, /border-b/);
  assert.match(hintBlock, /relative z-10/);
  assert.doesNotMatch(hintBlock, /absolute right-2 bottom-2/);
});

test("服务器行高固定 64px，配置信息收成一条 13px 弱化文字", () => {
  assert.match(servers, /"h-16"/);
  assert.match(servers, /text-\[13px\] text-muted-foreground/);
  assert.match(servers, /香港 · 端口 30000-31000 · eth0/); // 注释里的目标形态
  // 端口 / 网卡不再各占一行：名称列里只剩 metaParts.join(" · ")。
  assert.match(servers, /metaParts\.join\(" · "\)/);
  assert.doesNotMatch(servers, /<NicBadge\s+server=\{server\}\s+className=\{cn\("mt-0\.5"/);
});

test("卡头：在线计数进标题徽章，异常徽章变成可切换筛选并写 URL", () => {
  assert.match(servers, /t\("servers\.onlineCount", \{\s*online: onlineCount,/);
  assert.match(servers, /data-slot="server-abnormal-filter"/);
  assert.match(servers, /aria-pressed=\{abnormalActive\}/);
  assert.match(servers, /next\.set\("only", "abnormal"\)/);
  assert.match(servers, /next\.delete\("only"\)/);
  // 没有异常时不渲染筛选按钮。
  assert.match(servers, /\{serviceDownCount > 0 \? \(/);

  // 标题左侧一个容器：标题 + 计数 + ⓘ；筛选 / 刷新 / 历史在右侧同一组。
  const info = servers.indexOf('t("servers.aboutAria")');
  assert.ok(info > 0);
  assert.match(servers, /<TooltipContent className="max-w-72">\s*\{t\("servers\.descMore"\)\}/);
  assert.match(servers, /t\("servers\.descShort"\)/);
  assert.match(servers, /line-clamp-2/);
  assert.doesNotMatch(servers, /t\("servers\.desc"\)/);
});

test("移动卡片：更多字段折叠、默认收起、不持久化，老用法不受影响", () => {
  assert.match(mobileCard, /moreFields\?: MobileDataField\[\]/);
  assert.match(mobileCard, /const \[moreOpen, setMoreOpen\] = useState\(false\)/);
  assert.match(mobileCard, /data-slot="mobile-card-more-toggle"/);
  assert.match(mobileCard, /aria-expanded=\{moreOpen\}/);
  assert.doesNotMatch(mobileCard, /localStorage/);

  // 服务器卡片：表面只留身份 + 实时指标，配置类字段进 moreFields。
  assert.match(servers, /moreFields=\{\[/);
  const cardIndex = servers.indexOf("moreFields={[");
  const cardTail = servers.slice(cardIndex, cardIndex + 2600);
  for (const key of [
    "servers.portPolicy.section",
    "servers.portPolicy.internalAddressDetail",
    "servers.nic.field",
    "servers.mode.column",
  ]) {
    assert.ok(cardTail.includes(`t("${key}")`), `${key} 应在 moreFields 里`);
  }
  // 表面字段：地址 + 负载 / 内存 / 速率（实时指标）。
  const surface = servers.slice(servers.indexOf("fields={["), cardIndex);
  for (const key of [
    "common.address",
    "servers.detail.load",
    "servers.detail.memory",
    "servers.detail.rate",
  ]) {
    assert.ok(surface.includes(`t("${key}")`), `${key} 应在表面字段里`);
  }
});

test("详情弹层不再重复 label：端口值不带「允许端口」，延迟值不带「延迟」", () => {
  assert.match(servers, /value=\{portPolicyValue\(server\)\}/);
  assert.match(servers, /t\("servers\.detail\.latencyValue", \{ ms: server\.latency_ms \}\)/);
  // 旧的重复写法必须彻底消失。
  assert.doesNotMatch(
    servers,
    /label=\{t\("servers\.detail\.latency"\)\}[\s\S]{0,200}servers\.latencyValue/,
  );
  assert.doesNotMatch(
    servers,
    /label=\{t\("servers\.portPolicy\.section"\)\}\s+value=\{portPolicySummary\(server\)\}/,
  );
});

test("新文案同时进了中英词典", () => {
  for (const key of [
    "descShort",
    "descMore",
    "aboutAria",
    "filterAbnormalOn",
    "filterAbnormalOff",
  ]) {
    assert.equal(typeof zh.servers[key], "string", `zh servers.${key}`);
    assert.equal(typeof en.servers[key], "string", `en servers.${key}`);
  }
  assert.equal(typeof zh.servers.detail.latencyValue, "string");
  assert.equal(typeof en.servers.detail.latencyValue, "string");
  assert.equal(typeof zh.common.showMore, "string");
  assert.equal(typeof en.common.showMore, "string");
  assert.equal(typeof zh.common.showLess, "string");
  assert.equal(typeof en.common.showLess, "string");
});
