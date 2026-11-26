#!/usr/bin/env node
/**
 * 构建期生成「节点分布」世界地图的 SVG 路径。
 *
 * 数据源（只在构建期请求，运行时不联网）：
 *   - https://unpkg.com/world-atlas@2.0.2/countries-110m.json
 *   - https://unpkg.com/i18n-iso-countries@7.11.0/codes.json
 *
 * 110m 不含香港 / 新加坡 / 澳门这类小地区（Natural Earth 只保留主权国家
 * 轮廓）。为了让这些常见节点地区也能落图，缺失的 ISO2 再从 world-atlas 的
 * countries-50m.json 补一次轮廓——只补 110m 没有的键，主图仍是 110m。
 * 50m 只是可选增强：本机无缓存且下载失败时跳过并告警，已提交的 JSON 不受影响。
 *
 * 本机优先读 /tmp 缓存（离线也能重建），缺失时才下载。
 *
 * 实现要点：
 *   - 自己解 TopoJSON：arcs 是 delta 编码，`transform.scale` / `translate`
 *     还原经纬度；不引入 topojson-client。
 *   - 等距圆柱投影到 viewBox 0 0 1000 500，坐标四舍五入到 1 位小数。
 *   - 去掉南极洲（numeric id 010）；numeric id 去前导零后与 ISO 数字码匹配，
 *     匹配不到的小地区跳过并记录数量。
 *   - 在 ±180° 经线处把环拆成多段，避免俄罗斯 / 斐济横穿整张地图。
 *   - 输出按 ISO2 排序、每个国家一行，重复执行字节级稳定，避免 diff 抖动。
 *
 * 用法：node web/scripts/build-world-map.mjs
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(WEB_ROOT, "src/lib/worldMapPaths.json");

const TOPO_CACHE = "/tmp/c110.json";
const CODES_CACHE = "/tmp/codes.json";
const FALLBACK_CACHE = "/tmp/c50.json";
const TOPO_URL = "https://unpkg.com/world-atlas@2.0.2/countries-110m.json";
const CODES_URL = "https://unpkg.com/i18n-iso-countries@7.11.0/codes.json";
const FALLBACK_URL = "https://unpkg.com/world-atlas@2.0.2/countries-50m.json";

const VIEW_W = 1000;
const VIEW_H = 500;
const ANTARCTICA = "010";
/** 体积目标：超过就报错，避免悄悄把 150KB 的包塞进首屏。 */
const MAX_BYTES = 150 * 1024;

/** 有限数字；非有限值抛出，避免把 NaN 写进路径。 */
function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} is not a finite number: ${String(value)}`);
  }
  return value;
}

async function readCache(file, label) {
  try {
    const text = await readFile(file, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw new Error(`failed to read ${label} cache ${file}: ${error.message}`);
  }
}

async function download(url, label) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`failed to download ${label}: HTTP ${response.status}`);
  }
  return response.json();
}

async function loadSource(cache, url, label) {
  const cached = await readCache(cache, label);
  if (cached !== null) return { data: cached, source: `cache ${cache}` };
  const data = await download(url, label);
  return { data, source: url };
}

/**
 * 解 TopoJSON arcs：每个 arc 是 delta 编码的 [dx, dy]，按 transform 还原成
 * 经纬度 [lon, lat]。返回与输入 arcs 一一对应的绝对坐标数组。
 */
function decodeArcs(topology) {
  const transform = topology.transform;
  if (!transform || !Array.isArray(transform.scale)) {
    // world-atlas 的 countries-110m 一定带 quantization transform；
    // 缺失时数据格式不对，直接失败而不是生成一张错位的地图。
    throw new Error("TopoJSON is missing transform.scale / transform.translate");
  }
  const [scaleX, scaleY] = transform.scale.map((value, index) =>
    finite(value, `transform.scale[${index}]`),
  );
  const [translateX, translateY] = transform.translate.map((value, index) =>
    finite(value, `transform.translate[${index}]`),
  );
  if (!Array.isArray(topology.arcs)) {
    throw new Error("TopoJSON is missing arcs");
  }
  return topology.arcs.map((arc) => {
    if (!Array.isArray(arc)) throw new Error("TopoJSON arc is not an array");
    let x = 0;
    let y = 0;
    return arc.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new Error("TopoJSON arc point is not [dx, dy]");
      }
      x += finite(pair[0], "arc dx");
      y += finite(pair[1], "arc dy");
      return [x * scaleX + translateX, y * scaleY + translateY];
    });
  });
}

/** 合并一次环引用到的 arcs；负数索引表示反向遍历（~index）。 */
function ringPoints(ring, arcs) {
  const points = [];
  for (const index of ring) {
    if (!Number.isInteger(index)) throw new Error(`bad arc index ${index}`);
    const arc = index < 0 ? arcs[~index].slice().reverse() : arcs[index];
    if (!arc) throw new Error(`arc index out of range: ${index}`);
    for (const point of arc) {
      const previous = points[points.length - 1];
      if (previous && previous[0] === point[0] && previous[1] === point[1]) {
        continue;
      }
      points.push(point);
    }
  }
  return points;
}

function formatCoord(value) {
  const rounded = Math.round(value * 10) / 10;
  // 避免 "-0" 出现在路径里。
  if (Object.is(rounded, -0)) return "0";
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * 等距圆柱投影。经度 [-180, 180] → x [0, 1000]，
 * 纬度 [90, -90] → y [0, 500]。
 */
function project(lon, lat) {
  return [
    (lon + 180) / 360 * VIEW_W,
    (90 - lat) / 180 * VIEW_H,
  ];
}

/**
 * 把一个环转成一段或多段 SVG 子路径。
 *
 * Natural Earth 的俄罗斯 / 斐济在 ±180° 处有跨经线跳变；直接连线会画出一条
 * 横穿整张地图的直线。这里在跳变处断开，让每个子路径各自闭合。
 */
function ringToPath(points) {
  if (points.length < 2) return "";
  // 若只有「终点 → 起点」这一处跨经线，把环旋转一格，让跳变落在序列内部。
  if (Math.abs(points[0][0] - points[points.length - 1][0]) > 180) {
    points = [...points.slice(1), points[0]];
  }

  const segments = [];
  let current = [];
  for (const point of points) {
    const previous = current[current.length - 1];
    if (previous && Math.abs(point[0] - previous[0]) > 180) {
      if (current.length > 0) segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) segments.push(current);

  const subpaths = [];
  for (const segment of segments) {
    const coords = [];
    let first = null;
    let last = null;
    for (const [lon, lat] of segment) {
      const [x, y] = project(
        finite(lon, "longitude"),
        finite(lat, "latitude"),
      );
      const px = Number(formatCoord(x));
      const py = Number(formatCoord(y));
      if (last && last[0] === px && last[1] === py) continue;
      if (!first) first = [px, py];
      last = [px, py];
      coords.push([px, py]);
    }
    // Z 会闭合，末尾重复的起点没有信息量。
    if (
      coords.length > 1 &&
      coords[0][0] === coords[coords.length - 1][0] &&
      coords[0][1] === coords[coords.length - 1][1]
    ) {
      coords.pop();
    }
    if (coords.length < 2) continue;
    subpaths.push(
      `M${coords.map(([x, y]) => `${formatCoord(x)} ${formatCoord(y)}`).join(" ")}Z`,
    );
  }
  return subpaths.join("");
}

function geometryToPath(geometry, arcs) {
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.arcs]
      : geometry.type === "MultiPolygon"
        ? geometry.arcs
        : null;
  if (!polygons) throw new Error(`unsupported geometry type ${geometry.type}`);
  const subpaths = [];
  for (const polygon of polygons) {
    if (!Array.isArray(polygon)) throw new Error("polygon is not an array");
    for (const ring of polygon) {
      if (!Array.isArray(ring)) throw new Error("ring is not an array");
      const path = ringToPath(ringPoints(ring, arcs));
      if (path) subpaths.push(path);
    }
  }
  return subpaths.join("");
}

/** numeric id（"004" / 4 / "4"）→ ISO2。 */
function numericIndex(codes) {
  if (!Array.isArray(codes)) throw new Error("ISO codes file is not an array");
  const byNumeric = new Map();
  for (const entry of codes) {
    if (!Array.isArray(entry) || entry.length < 3) continue;
    const [alpha2, , numeric] = entry;
    if (typeof alpha2 !== "string" || !/^[A-Z]{2}$/.test(alpha2)) continue;
    if (typeof numeric !== "string" || !/^\d{3}$/.test(numeric)) continue;
    const key = String(Number(numeric));
    if (!byNumeric.has(key)) byNumeric.set(key, alpha2);
  }
  if (byNumeric.size < 200) {
    throw new Error(`ISO codes file looks incomplete (${byNumeric.size} rows)`);
  }
  return byNumeric;
}

function numericKey(id) {
  if (id === undefined || id === null) return null;
  const raw = String(id).trim();
  if (!/^\d+$/.test(raw)) return null;
  return String(Number(raw));
}

function collectCountries(topology, byNumeric, output, skipped) {
  const geometries = topology?.objects?.countries?.geometries;
  if (!Array.isArray(geometries)) {
    throw new Error("TopoJSON is missing objects.countries.geometries");
  }
  const arcs = decodeArcs(topology);
  const antarctica = String(Number(ANTARCTICA));
  const sortedGeometries = [...geometries].sort((a, b) =>
    String(a.id ?? "").localeCompare(String(b.id ?? "")),
  );
  for (const geometry of sortedGeometries) {
    const key = numericKey(geometry.id);
    const name = geometry?.properties?.name ?? "unknown";
    if (key === null) {
      skipped.add(name);
      continue;
    }
    if (key === antarctica) continue;
    const iso2 = byNumeric.get(key);
    if (!iso2) {
      skipped.add(name);
      continue;
    }
    if (output.has(iso2)) continue;
    const d = geometryToPath(geometry, arcs);
    if (!d) {
      skipped.add(name);
      continue;
    }
    output.set(iso2, d);
  }
}

async function main() {
  const topoSource = await loadSource(TOPO_CACHE, TOPO_URL, "countries-110m");
  const codesSource = await loadSource(CODES_CACHE, CODES_URL, "ISO codes");

  const byNumeric = numericIndex(codesSource.data);
  const skipped = new Set();
  const byIso = new Map();
  collectCountries(topoSource.data, byNumeric, byIso, skipped);
  const primaryCount = byIso.size;

  // 可选：用 50m 补齐 110m 没有的小地区（HK / SG / MO 等）。失败不阻塞构建。
  let fallbackSource = null;
  try {
    const fallback = await loadSource(
      FALLBACK_CACHE,
      FALLBACK_URL,
      "countries-50m",
    );
    collectCountries(fallback.data, byNumeric, byIso, skipped);
    fallbackSource = fallback.source;
  } catch (error) {
    console.warn(
      `build-world-map: 50m fallback unavailable, keeping 110m only (${error.message})`,
    );
  }

  const sorted = [...byIso.entries()].sort(([a], [b]) => a.localeCompare(b));
  const body = sorted
    .map(([iso2, d]) => `  ${JSON.stringify(iso2)}: ${JSON.stringify(d)}`)
    .join(",\n");
  const json = `{\n${body}\n}\n`;
  const bytes = Buffer.byteLength(json);
  if (bytes > MAX_BYTES) {
    throw new Error(
      `worldMapPaths.json is ${bytes} bytes, over the ${MAX_BYTES}-byte budget`,
    );
  }
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, json, "utf8");

  const kb = (bytes / 1024).toFixed(1);
  console.log(
    `world map: ${sorted.length} countries (${primaryCount} from 110m, ` +
      `${sorted.length - primaryCount} added from 50m), ` +
      `${skipped.size} skipped, ${bytes} bytes (${kb} KB) → ` +
      path.relative(WEB_ROOT, OUTPUT),
  );
  console.log(`  countries: ${topoSource.source}`);
  console.log(`  ISO codes: ${codesSource.source}`);
  if (fallbackSource) console.log(`  small regions: ${fallbackSource}`);
  if (skipped.size > 0) {
    console.log(
      `  skipped (no ISO numeric match): ${[...skipped].join(", ")}`,
    );
  }
}

main().catch((error) => {
  console.error(`build-world-map: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
