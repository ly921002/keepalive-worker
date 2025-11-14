/**
 * Cloudflare Worker - KeepAlive 管理后台（HTML 控制台 + KV + Cron）
 *
 * UI Features:
 *   - 查看所有 URL 状态
 *   - 添加 URL
 *   - 删除 URL
 *   - 强制立即访问
 *
 * API:
 *   GET  /api/list
 *   POST /api/add
 *   POST /api/delete
 *   POST /api/visit-now
 *
 * Web UI:
 *   GET /
 */

const DEFAULT_TIMEOUT = 10000;
const CONCURRENCY = 6;

// ------------ Helper ------------
async function sha1(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, "0")).join("");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseAuth(req) {
  const h = req.headers.get("authorization") || "";
  if (h.startsWith("Bearer ")) return h.substring(7);
  return new URL(req.url).searchParams.get("token") || "";
}

function isValidUrl(url) {
  try { new URL(url); return true; }
  catch { return false; }
}

async function timedFetch(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: "GET", signal: controller.signal });
    const text = await resp.text().catch(() => "");
    return { ok: resp.ok, status: resp.status, snippet: text.slice(0, 150) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

// ------------ KV Operations ------------
async function getAll(env) {
  let cursor;
  const items = [];
  do {
    const res = await env.URLS_KV.list({ cursor });
    cursor = res.cursor;
    for (const { name } of res.keys) {
      const v = await env.URLS_KV.get(name);
      if (v) items.push({ key: name, ...JSON.parse(v) });
    }
  } while (cursor);
  return items;
}

async function addUrl(env, url) {
  const key = await sha1(url);
  const record = {
    url,
    addedAt: new Date().toISOString(),
    lastVisited: null,
    lastStatus: null,
    successCount: 0,
    failCount: 0,
  };
  await env.URLS_KV.put(key, JSON.stringify(record));
  return { key, record };
}

async function deleteUrl(env, key) {
  await env.URLS_KV.delete(key);
}

// ------------ HTML UI ------------
function renderHtml() {
  return new Response(
    `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>KeepAlive 控制台</title>
<style>
body { font-family: sans-serif; padding: 20px; background: #111; color: #eee; }
h1 { color: #4fd1c5; }
input, button { padding: 8px; margin: 5px; }
table { width: 100%; margin-top: 20px; border-collapse: collapse; }
td, th { padding: 8px; border-bottom: 1px solid #333; }
button { cursor: pointer; }
</style>
</head>
<body>
<h1>KeepAlive 控制台</h1>

<div>
  <h3>添加 URL</h3>
  <input id="url-input" placeholder="https://example.com" size="50"/>
  <input id="token-input" placeholder="Admin Token" size="30"/>
  <button onclick="addUrl()">添加</button>
</div>

<h3>URL 列表</h3>
<table id="list">
  <tr><th>URL</th><th>最后访问</th><th>状态</th><th>成功/失败</th><th>操作</th></tr>
</table>

<script>
async function loadList() {
  const token = document.getElementById("token-input").value;
  const res = await fetch("/api/list", {
    headers: { Authorization: "Bearer " + token }
  });
  const data = await res.json();

  const tbl = document.getElementById("list");
  tbl.innerHTML = '<tr><th>URL</th><th>最后访问</th><th>状态</th><th>成功/失败</th><th>操作</th></tr>';

  data.items.forEach(item => {
    const tr = document.createElement("tr");
    tr.innerHTML = \`
      <td>\${item.url}</td>
      <td>\${item.lastVisited || "-"}</td>
      <td>\${item.lastStatus || "-"}</td>
      <td>\${item.successCount}/\${item.failCount}</td>
      <td>
        <button onclick="visitNow('\${item.url}')">访问</button>
        <button onclick="delUrl('\${item.key}')">删除</button>
      </td>
    \`;
    tbl.appendChild(tr);
  });
}

async function addUrl() {
  const url = document.getElementById("url-input").value;
  const token = document.getElementById("token-input").value;

  await fetch("/api/add", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ url })
  });
  loadList();
}

async function delUrl(key) {
  const token = document.getElementById("token-input").value;
  await fetch("/api/delete", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ key })
  });
  loadList();
}

async function visitNow(url) {
  const token = document.getElementById("token-input").value;
  await fetch("/api/visit-now", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ url })
  });
  alert("访问完成");
}

loadList();
</script>
</body>
</html>
`,
    { headers: { "Content-Type": "text/html" } },
  );
}

// ------------ API Handlers ------------
async function handleAPI(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const token = parseAuth(req);

  if (token !== env.ADMIN_TOKEN)
    return json({ error: "Unauthorized" }, 401);

  if (path === "/api/list")
    return json({ items: await getAll(env) });

  if (path === "/api/add") {
    const body = await req.json();
    if (!body.url || !isValidUrl(body.url)) return json({ error: "invalid url" }, 400);
    return json(await addUrl(env, body.url));
  }

  if (path === "/api/delete") {
    const body = await req.json();
    await deleteUrl(env, body.key);
    return json({ ok: true });
  }

  if (path === "/api/visit-now") {
    const body = await req.json();
    return json(await timedFetch(body.url, DEFAULT_TIMEOUT));
  }

  return json({ error: "Unknown API path" }, 404);
}

// ------------ Cron Job ------------
async function cronRun(env) {
  const items = await getAll(env);
  const timeout = DEFAULT_TIMEOUT;
  let i = 0;

  async function worker() {
    while (i < items.length) {
      const idx = i++;
      const item = items[idx];
      const result = await timedFetch(item.url, timeout);

      const updated = {
        ...item,
        lastVisited: new Date().toISOString(),
        lastStatus: result.ok ? result.status : result.error,
        successCount: item.successCount + (result.ok ? 1 : 0),
        failCount: item.failCount + (result.ok ? 0 : 1)
      };

      await env.URLS_KV.put(item.key, JSON.stringify(updated));
    }
  }

  await Promise.all(new Array(Math.min(CONCURRENCY, items.length)).fill(0).map(worker));
}

// ------------ Worker Entry ------------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      return handleAPI(req, env);
    }
    return renderHtml();
  },

  async scheduled(event, env) {
    await cronRun(env);
  },
};
