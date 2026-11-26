import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const FILE = fileURLToPath(new URL("./worldMapPaths.json", import.meta.url));
const raw = readFileSync(FILE, "utf8");
const paths = JSON.parse(raw);
const keys = Object.keys(paths);

/** 每个子路径的坐标对；路径格式固定为 `M x y x y … Z`。 */
function subpathPoints(d) {
  const subpaths = d.match(/M[^Z]+Z/g);
  assert.ok(subpaths && subpaths.length > 0, "path must contain M…Z");
  return subpaths.map((subpath) => {
    const numbers = subpath.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    assert.equal(numbers.length % 2, 0, `odd coordinate count in ${subpath}`);
    assert.ok(numbers.length >= 4, `subpath needs at least 2 points: ${subpath}`);
    const points = [];
    for (let index = 0; index < numbers.length; index += 2) {
      points.push([numbers[index], numbers[index + 1]]);
    }
    return points;
  });
}

test("生成结果覆盖 ≥150 个国家/地区，键都是大写 ISO2", () => {
  assert.ok(keys.length >= 150, `only ${keys.length} countries`);
  for (const key of keys) {
    assert.match(key, /^[A-Z]{2}$/, `bad ISO2 key: ${key}`);
  }
  assert.ok(keys.includes("JP"));
  assert.ok(keys.includes("CN"));
  assert.ok(keys.includes("US"));
  // 110m 不含香港 / 新加坡；构建脚本用 50m 补齐，地图上的常见节点地区不能缺。
  assert.ok(keys.includes("HK"), "Hong Kong must be present");
  assert.ok(keys.includes("SG"), "Singapore must be present");
});

test("南极洲（AQ / numeric 010）被移除", () => {
  assert.equal(paths.AQ, undefined);
});

test("路径以 M 开头、以 Z 结尾，且每个国家至少一个子路径", () => {
  for (const [country, d] of Object.entries(paths)) {
    assert.equal(typeof d, "string", `${country} path must be a string`);
    assert.ok(d.startsWith("M"), `${country} path must start with M`);
    assert.ok(d.endsWith("Z"), `${country} path must end with Z`);
    assert.ok(!d.includes("NaN"), `${country} path contains NaN`);
    assert.ok(!d.includes("undefined"), `${country} path contains undefined`);
    const subpaths = subpathPoints(d);
    assert.ok(subpaths.length >= 1, `${country} has no subpaths`);
  }
});

test("所有坐标落在 viewBox 0–1000 / 0–500 内，且保留 1 位小数", () => {
  for (const [country, d] of Object.entries(paths)) {
    for (const points of subpathPoints(d)) {
      for (const [x, y] of points) {
        assert.ok(x >= 0 && x <= 1000, `${country} x out of viewBox: ${x}`);
        assert.ok(y >= 0 && y <= 500, `${country} y out of viewBox: ${y}`);
      }
    }
    // 生成器最多保留 1 位小数；出现 2 位以上说明格式化回退了。
    assert.doesNotMatch(d, /-?\d+\.\d{2,}/, `${country} has >1 decimal place`);
  }
});

test("文件 ≤150KB，且键排序稳定（重复执行不抖动）", () => {
  const bytes = statSync(FILE).size;
  assert.ok(bytes <= 150 * 1024, `worldMapPaths.json is ${bytes} bytes`);
  const sorted = [...keys].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(keys, sorted);
});

test("每个国家只出现一次，且没有空路径", () => {
  const seen = new Set();
  for (const key of keys) {
    assert.equal(seen.has(key), false, `duplicate key: ${key}`);
    seen.add(key);
    assert.ok(paths[key].length > 4, `${key} path is empty`);
  }
});
