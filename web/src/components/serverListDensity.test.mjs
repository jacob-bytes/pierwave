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

test("名称列与复选框列一起 sticky，固定列不画 1px 实线", () => {
  const columns = serverTableColumns((key) => key);
  const select = columns.find((column) => column.key === "select");
  assert.match(select.headClassName, /w-10/);
  // 复选框列必须真的 40px：auto layout 会把它压到 24px，名称列的
  // left-10 就会右移 16px 盖住地址列。
  assert.match(select.headClassName, /min-w-10/);

  const name = columns.find((column) => column.key === "name");
  assert.equal(name?.sticky, "left");
  // 复选框列 40px（w-10），名称列紧贴它的右侧。
  assert.match(name.headClassName, /left-10/);
  assert.match(name.headClassName, /pw-sticky-name/);
  // 固定 208px：w-52 给目标宽度，max-w-52 防 auto layout 按内容撑宽。
  assert.match(name.headClassName, /w-52/);
  assert.match(name.headClassName, /max-w-52/);

  const address = columns.find((column) => column.key === "address");
  assert.match(address.headClassName, /min-w-40/);

  assert.match(
    servers,
    /<TableCell\s+sticky="left"\s+stickyShadow\s+className="pw-sticky-name left-10 w-52 max-w-52 px-2"/,
  );
  assert.match(servers, /w-10 min-w-10 px-2/);
  assert.match(servers, /hidden min-w-40 px-2[^"]*lg:table-cell/);
  assert.match(servers, /<TableCell\s+sticky="right"\s+stickyShadow/);
  assert.match(css, /\[data-slot="table-cell"\]\.pw-sticky-name/);

  // 默认不画任何分隔线 / 伪元素渐变。
  assert.doesNotMatch(css, /pw-sticky-name::after/);
  assert.doesNotMatch(css, /right:\s*-12px/);
  assert.doesNotMatch(css, /--foreground\) 20%/);
});

test("sticky 列的柔和投影只在横向滚动时出现，回滚后淡出", () => {
  const columns = serverTableColumns((key) => key);
  assert.equal(columns.find((column) => column.key === "name")?.stickyShadow, true);
  assert.equal(columns.find((column) => column.key === "actions")?.stickyShadow, true);
  // 复选框列与名称列同为 sticky left，但复选框列不该投影。
  assert.notEqual(columns.find((column) => column.key === "select")?.stickyShadow, true);

  // Table 把滚动位置同步到容器属性，CSS 才能只在该值下显示投影。
  assert.match(table, /data-scrolled-x=\{scrolled \? "true" : undefined\}/);
  assert.match(table, /setScrolled\(container\.scrollLeft > 1\)/);
  assert.match(table, /data-slot="sticky-scroll-shadow"/);
  assert.match(table, /data-side=\{side\}/);
  assert.match(table, /stickyShadow\?: boolean/);

  // 左右两个方向用 box-shadow，宽而不实；未滚动 opacity 0，滚动后 1。
  assert.match(css, /--sticky-scroll-shadow: rgb\(0 0 0 \/ 0\.6\)/);
  assert.match(css, /--sticky-scroll-shadow: rgb\(0 0 0 \/ 0\.16\)/);
  assert.match(
    css,
    /box-shadow: 6px 0 10px -6px var\(--sticky-scroll-shadow\)/,
  );
  assert.match(
    css,
    /box-shadow: -6px 0 10px -6px var\(--sticky-scroll-shadow\)/,
  );
  assert.match(css, /opacity: 0;/);
  assert.match(css, /transition: opacity 180ms/);
  assert.match(
    css,
    /\[data-slot="table-container"\]\[data-scrolled-x="true"\]\s*\[data-slot="sticky-scroll-shadow"\]\s*\{\s*opacity: 1/,
  );
});

test("名称 / 元信息都在单元格内收口：min-w-0 + truncate，完整内容进 title", () => {
  // 名称行与元信息行的 span 必须自己 min-w-0，否则作为 flex 子项会以
  // 内容宽度为下限，truncate 不生效、文字画到地址列下面。
  assert.match(
    servers,
    /<span\s+data-slot="server-name"\s+className="min-w-0 truncate font-medium"\s+title=\{server\.name\}\s*>/,
  );
  assert.match(
    servers,
    /<span\s+data-slot="server-meta"\s+className="min-w-0 truncate"\s+title=\{metaTitle\}\s*>/,
  );
  // 外层还兜一道 overflow-hidden，badge 等 shrink-0 子项也不会画出单元格。
  assert.match(servers, /flex min-w-0 items-center gap-2 overflow-hidden/);
  assert.match(servers, /metaParts\.join\(" · "\)/);
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

test("Shift+滚轮横向滚动表格，只在没有 deltaX 且确实溢出时接管", () => {
  assert.match(table, /addEventListener\("wheel", onWheel, \{ passive: false \}\)/);
  assert.match(table, /if \(!event\.shiftKey \|\| event\.deltaX !== 0 \|\| event\.deltaY === 0\) return/);
  assert.match(table, /scrollWidth <= container\.clientWidth \+ 1/);
  assert.match(table, /scrollLeft \+= event\.deltaY/);
  assert.match(table, /event\.preventDefault\(\)/);
  // 卸载时移除，避免 StrictMode / 路由切换后叠加多个监听。
  assert.match(table, /removeEventListener\("wheel", onWheel\)/);
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
