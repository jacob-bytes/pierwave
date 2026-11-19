// web-polish 截图用的最小数据集：服务器 / 套餐 / 用户 / 链 / 链模板。
// 只写本地预览库（PIERWAVE_DB=data/web-polish.db），不碰产品数据库。
//
// Minimal fixture for the web-polish screenshots. Only writes to the local
// preview DB (data/web-polish.db); never touches the product database.
const BASE = process.env.PREVIEW_BASE ?? "http://127.0.0.1:8787";

async function login() {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "devpass" }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const cookie = res.headers
    .getSetCookie()
    .map((item) => item.split(";")[0])
    .find((item) => item.startsWith("pierwave_session="));
  if (!cookie) throw new Error("no session cookie");
  return cookie;
}

async function call(cookie, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // 非 JSON 响应保留原文，便于定位。
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

const cookie = await login();

async function ensureUnique(path, name, create) {
  const list = await call(cookie, "GET", path);
  const items = Array.isArray(list) ? list : (list.items ?? []);
  const found = items.find((item) => item.name === name);
  if (found) return found;
  return create();
}

const servers = [];
for (const [name, address, group, country] of [
  ["hk-1", "203.0.113.21", "香港", "HK"],
  ["hk-2", "203.0.113.22", "香港", "HK"],
  ["jp-1", "203.0.113.31", "日本", "JP"],
]) {
  servers.push(
    await ensureUnique("/api/v1/servers", name, async () => {
      const res = await call(cookie, "POST", "/api/v1/servers", {
        name,
        address,
        xray_mode: "external",
        group_name: group,
        country_code: country,
      });
      return res.server ?? res;
    }),
  );
}

const packages = [];
for (const [name, quota, days, ratio] of [
  ["标准版", 100 * 1024 ** 3, 30, 1],
  ["高级版", 500 * 1024 ** 3, 90, 1.2],
]) {
  packages.push(
    await ensureUnique("/api/v1/packages", name, async () => {
      const res = await call(cookie, "POST", "/api/v1/packages", {
        name,
        quota_bytes: quota,
        period_days: days,
        direction: "both",
        node_ratio: ratio,
      });
      return res.package ?? res;
    }),
  );
}

const users = [];
for (const [username, role] of [
  ["alice", "user"],
  ["bob", "user"],
  ["carol", "user"],
  ["dave", "user"],
]) {
  const listResponse = await call(cookie, "GET", "/api/v1/users");
  const list = Array.isArray(listResponse)
    ? listResponse
    : (listResponse.items ?? []);
  const found = list.find((item) => item.username === username);
  if (found) {
    users.push(found);
    continue;
  }
  const res = await call(cookie, "POST", "/api/v1/users", {
    username,
    password: "userpass123",
    role,
  });
  users.push(res.user ?? res);
}

// 给用户绑定套餐，用户页的套餐列才有内容。
for (const user of users.slice(0, 3)) {
  const existing = await call(
    cookie,
    "GET",
    `/api/v1/users/${user.id}/packages`,
  );
  const list = Array.isArray(existing) ? existing : (existing.items ?? []);
  if (list.length > 0) continue;
  await call(cookie, "POST", `/api/v1/users/${user.id}/packages`, {
    package_id: packages[0].id,
  });
}

// 链：两台香港服务器组成一条两跳链，目标用文档地址（无需外网）。
const chainList = await call(cookie, "GET", "/api/v1/chains");
const chainItems = Array.isArray(chainList) ? chainList : (chainList.items ?? []);
if (!chainItems.some((item) => item.name === "香港中转")) {
  await call(cookie, "POST", "/api/v1/chains", {
    name: "香港中转",
    target_host: "198.51.100.10",
    target_port: 443,
    enabled: true,
    engine: "native",
    protocol: "tcp",
    groups: [
      {
        name: "入口",
        members: [{ server_id: servers[0].id, listen_port: 24001 }],
      },
      {
        name: "出口",
        members: [{ server_id: servers[1].id, listen_port: 24002 }],
      },
    ],
  });
}

// 链模板：给「链模板」页一个正常态数据行。
const templateList = await call(cookie, "GET", "/api/v1/chain-templates");
const templateItems = Array.isArray(templateList)
  ? templateList
  : (templateList.items ?? []);
if (!templateItems.some((item) => item.name === "香港双跳模板")) {
  await call(cookie, "POST", "/api/v1/chain-templates", {
    name: "香港双跳模板",
    engine: "native",
    protocol: "tcp",
    enabled: true,
    groups: [
      { name: "入口", server_ids: [servers[0].id], listen_port: 24011 },
      { name: "出口", server_ids: [servers[1].id], listen_port: 24012 },
    ],
  });
}

console.log(
  JSON.stringify(
    {
      servers: servers.map((item) => item.id),
      packages: packages.map((item) => item.id),
      users: users.map((item) => ({ id: item.id, username: item.username })),
    },
    null,
    2,
  ),
);
