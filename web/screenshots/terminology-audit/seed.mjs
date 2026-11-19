// 术语 / 审计 / 390 文案验收用的种子数据。
//
// 前置：master 跑在 8787（fresh DB，admin/devpass），vite dev 跑在 5173。
// 用法：DB_PATH=/path/to/db.sqlite node web/screenshots/terminology-audit/seed.mjs
//
// 通过真实 API 建服务器 / 节点 / 转发 / 链 / 模板 / 证书 / API Token，
// 让审计日志自然产生；随后用 sqlite3 补几条后端暂时无法在测试环境触发的
// 审计动作（backup.remote.upload、updates.check、未知动作等），并挂到真实
// 对象 id 上，验证对象列的名称解析。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const DB_PATH =
  process.env.DB_PATH ?? "/Users/jlthzy/Documents/mmrust/.tmp-ui/db.sqlite";

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`ok - ${message}`);
}

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
  const body = await res.json();
  return { cookie, user: body.user };
}

async function api(cookie, path, method = "GET", body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Cookie: cookie,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const value = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text}`);
  return value;
}

function sqlite(statements) {
  execFileSync("sqlite3", [DB_PATH, statements], { stdio: "pipe" });
}

function auditRow({ id, actorId, action, target, detail, createdAt }) {
  const escape = (value) =>
    value === null || value === undefined
      ? "NULL"
      : `'${String(value).replaceAll("'", "''")}'`;
  const detailText =
    detail === undefined
      ? null
      : typeof detail === "string"
        ? detail
        : JSON.stringify(detail);
  return `INSERT INTO audit_log (id, actor_id, action, target, detail, created_at)
    VALUES (${escape(id)}, ${escape(actorId)}, ${escape(action)}, ${escape(target)}, ${escape(detailText)}, ${createdAt});`;
}

async function seed() {
  const { cookie, user } = await login();
  const actorId = user.id;

  // 已有数据时只补审计行，避免重复建对象导致 409。
  const existing = await api(cookie, "/api/v1/servers");
  if (existing.items.length > 0) {
    console.log("servers already seeded, skip");
    return { cookie, actorId };
  }

  const servers = {};
  for (const [key, name, group] of [
    ["hk", "香港-01", "香港"],
    ["jp", "日本-01", "日本"],
    ["us", "美国-01", "美国"],
  ]) {
    servers[key] = (
      await api(cookie, "/api/v1/servers", "POST", { name, address: `10.0.0.${Object.keys(servers).length + 1}`, group_name: group })
    ).server;
  }
  assert(Object.keys(servers).length === 3, "three servers created");

  const nodes = {};
  for (const [key, name, tag, port] of [
    ["hk", "香港节点", "hk-node", 10001],
    ["jp", "日本节点", "jp-node", 10002],
    ["us", "美国节点", "us-node", 10003],
  ]) {
    nodes[key] = (
      await api(cookie, `/api/v1/servers/${servers[key].id}/nodes`, "POST", {
        name,
        tag,
        protocol: "vless",
        transport: "tcp",
        security: "none",
        port,
        enabled: true,
        tags: [key],
        region: key.toUpperCase(),
        config: {},
      })
    ).node;
  }

  const forward = (
    await api(cookie, `/api/v1/servers/${servers.hk.id}/forwards`, "POST", {
      name: "港-办公转发",
      listen_port: 20001,
      target_host: "10.0.0.8",
      target_port: 443,
      enabled: true,
    })
  ).forward;

  const chain = (
    await api(cookie, "/api/v1/chains", "POST", {
      name: "港日中转链",
      target_host: "1.1.1.1",
      target_port: 443,
      enabled: true,
      engine: "native",
      protocol: "tcp",
      groups: [servers.hk, servers.jp].map((server, index) => ({
        strategy: "round_robin",
        members: [
          {
            server_id: server.id,
            ...(index === 0 ? { listen_port: 19011 } : {}),
            priority: 0,
          },
        ],
      })),
    })
  ).chain;

  const chainTemplate = (
    await api(cookie, "/api/v1/chain-templates", "POST", {
      name: "单跳模板",
      engine: "native",
      protocol: "tcp",
      groups: [{ strategy: "round_robin", server_ids: [servers.hk.id] }],
    })
  ).template;

  const ruleTemplate = (
    await api(cookie, "/api/v1/rule-templates", "POST", {
      name: "广告拦截",
      rules: ["DOMAIN-SUFFIX,doubleclick.net,REJECT", "MATCH,PROXY"],
    })
  ).template;

  const outbound = (
    await api(cookie, `/api/v1/servers/${servers.hk.id}/outbounds`, "POST", {
      tag: "office-socks",
      protocol: "socks",
      config: { address: "127.0.0.1", port: 1080 },
    })
  ).outbound;

  const routingRule = (
    await api(
      cookie,
      `/api/v1/servers/${servers.hk.id}/routing-rules`,
      "POST",
      {
        domain: "example.com",
        outbound_tag: "direct",
      },
    )
  ).rule;

  const apiToken = (
    await api(cookie, "/api/v1/api-tokens", "POST", {
      name: "监控脚本",
      scope: "read",
      expires_at: null,
    })
  ).item;

  const subscriptionTemplate = (
    await api(cookie, "/api/v1/subscription-templates", "POST", {
      name: "默认分组",
      groups: [{ name: "Auto", type: "url-test", filters: [{}] }],
    })
  ).template;

  // 自签证书只为让证书列表有一条可解析的记录。
  const dir = mkdtempSync(join(tmpdir(), "pierwave-cert-"));
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "30",
    "-subj",
    "/CN=example.com",
  ]);
  const certificate = (
    await api(cookie, "/api/v1/certificates", "POST", {
      name: "example.com",
      cert_pem: readFileSync(certPath, "utf8"),
      key_pem: readFileSync(keyPath, "utf8"),
    })
  ).certificate;
  rmSync(dir, { recursive: true, force: true });

  // 删除一条链，产生 chain.delete（destructive 语义色）。
  const doomed = (
    await api(cookie, "/api/v1/chains", "POST", {
      name: "待删除链",
      target_host: "9.9.9.9",
      target_port: 53,
      enabled: false,
      engine: "native",
      protocol: "tcp",
      groups: [
        {
          strategy: "round_robin",
          members: [{ server_id: servers.us.id, listen_port: 19099, priority: 0 }],
        },
      ],
    })
  ).chain;
  await api(cookie, `/api/v1/chains/${doomed.id}`, "DELETE");

  // 失败登录：真实产生 auth.login_failed。
  await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "wrong-pass" }),
  });

  // 设置更新：真实产生 settings.update。
  await api(cookie, "/api/v1/settings", "PATCH", { panel_name: "PierWave" });

  const now = Math.floor(Date.now() / 1000);
  const rows = [
    // 后端存在、前端此前没映射的 code。
    ["backup.remote.upload", null, { ok: true, size: 2048 }],
    ["updates.check", null, { latest: "0.15.3", update_available: false }],
    ["event.cleanup", null, { removed: 12 }],
    ["package_instance.batch_renew", null, { updated: 3, days: 30 }],
    ["server.token_rotated", servers.hk.id, { name: "香港-01", address: "10.0.0.1" }],
    ["user_chain.create", chain.id, { chain_id: chain.id, template_name: "单跳模板", target_host: "1.1.1.1", target_port: 443 }],
    ["user_chain.update", chain.id, { chain_id: chain.id, fields: ["target_host"], enabled: true }],
    ["user_chain.delete", chain.id, { chain_id: chain.id, target_host: "1.1.1.1", target_port: 443 }],
    ["user_forward.create", forward.id, { forward_id: forward.id, server_name: "香港-01", listen_port: 20001, target_host: "10.0.0.8", target_port: 443 }],
    ["user_forward.delete", forward.id, { forward_id: forward.id, listen_port: 20001, target_host: "10.0.0.8", target_port: 443 }],
  ];
  let offset = 1;
  const statements = rows
    .map(([action, target, detail]) => {
      const createdAt = now - offset * 60;
      offset += 1;
      return auditRow({
        id: crypto.randomUUID(),
        actorId,
        action,
        target,
        detail,
        createdAt,
      });
    })
    .join("\n");

  // 对象解析失败：target 是已删除对象的 UUID，detail 里没有 name。
  const missingTarget = "80b918f8-6a7c-4b1d-9f02-3c5e8d7a1b64";
  const extras = [
    auditRow({
      id: crypto.randomUUID(),
      actorId,
      action: "forward.update",
      target: missingTarget,
      detail: { changes: [{ field: "target_port", from: 443, to: 8443 }] },
      createdAt: now - offset++ * 60,
    }),
    auditRow({
      id: crypto.randomUUID(),
      actorId,
      action: "chain_template.update",
      target: chainTemplate.id,
      detail: { name: "单跳模板", changes: [{ field: "name", from: "单跳", to: "单跳模板" }] },
      createdAt: now - offset++ * 60,
    }),
    auditRow({
      id: crypto.randomUUID(),
      actorId,
      action: "outbound.update",
      target: outbound.id,
      detail: { server_id: servers.hk.id, tag: "office-socks", changes: [{ field: "enabled", from: true, to: false }] },
      createdAt: now - offset++ * 60,
    }),
    auditRow({
      id: crypto.randomUUID(),
      actorId,
      action: "routing_rule.update",
      target: routingRule.id,
      detail: { server_id: servers.hk.id, inbound_tag: null, domain: "example.com", ip: null, outbound_tag: "direct" },
      createdAt: now - offset++ * 60,
    }),
    auditRow({
      id: crypto.randomUUID(),
      actorId,
      action: "api_token.revoke",
      target: apiToken.id,
      detail: { name: "监控脚本", scope: "read" },
      createdAt: now - offset++ * 60,
    }),
    auditRow({
      id: crypto.randomUUID(),
      actorId,
      action: "subscription_template.update",
      target: subscriptionTemplate.id,
      detail: { name: "默认分组", changes: [{ field: "name", from: "旧分组", to: "默认分组" }] },
      createdAt: now - offset++ * 60,
    }),
    auditRow({
      id: crypto.randomUUID(),
      actorId,
      action: "node.tcping",
      target: nodes.hk.id,
      detail: { reachable: true, latency_ms: 12, address: "1.1.1.1:443" },
      createdAt: now - offset++ * 60,
    }),
    auditRow({
      id: crypto.randomUUID(),
      actorId,
      action: "certificate.upload",
      target: certificate.id,
      detail: { name: "example.com", domains: ["example.com"] },
      createdAt: now - offset++ * 60,
    }),
    // 前端完全未知的 code：必须显示原文 +「未知动作」，不能像裸代码。
    auditRow({
      id: crypto.randomUUID(),
      actorId,
      action: "mystery.action",
      target: null,
      detail: { hint: "backend added a new action" },
      createdAt: now - offset++ * 60,
    }),
  ].join("\n");

  sqlite(`${statements}\n${extras}`);

  console.log(
    `seeded servers=${Object.keys(servers).length} nodes=${Object.keys(nodes).length} audit+=${rows.length + 9}`,
  );
  return { cookie, actorId };
}

await seed();
