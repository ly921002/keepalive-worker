/**
 * Cloudflare Worker: 定时访问服务（KV + Cron + 管理接口）
 *
 * API:
 *   POST /add-url      添加 URL
 *   GET  /list         查看所有 URL
 *   POST /visit-now    立即访问
 *
 * 环境变量:
 *   ADMIN_TOKEN        管理密码（必须设置）
 *   ALLOWED_DOMAINS    逗号分隔的域名白名单，可选
 *   REQUEST_TIMEOUT_MS 单次访问超时，默认 10000
 *
 * KV:
 *   URLS_KV            存储 URL 信息
 */

const DEFAULT_TIMEOUT = 10000;
const CONCURRENCY = 6;

// ----------- 工具函数 -----------

async function hashKey(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function parseAuth(request) {
  const h = request.headers.get("authorization") || "";
  if (h.startsWith("Bearer ")) return h.substring(7);
  return new URL(request.url).searchParams.get("token") || "";
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

async function timedFetch(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    const txt = await resp.text().catch(() => "");
    return { ok: resp.ok, status: resp.status, snippet: txt.slice(0, 120) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(t);
  }
}

// ----------- KV 操作 -----------

async function putUrl(env, url) {
  const key = await hashKey(url);
  const record = {
    url,
    addedAt: new Date().toISOString(),
    lastVisited: null,
    lastStatus: null,
    successCount: 0,
    failCount: 0
  };

  await env.URLS_KV.put(key, JSON.stringify(record));
  return { key, record };
}

async function listUrls(env) {
  let cursor = undefined;
  const list = [];

  do {
    const r = await env.URLS_KV.list({ cursor });
    cursor = r.cursor;

    for (const k of r.keys) {
      const val = await env.URLS_KV.get(k.name);
      if (val) {
        list.push({ key: k.name, ...JSON.parse(val) });
      }
    }
  } while (cursor);

  return list;
}

// ----------- API 处理 -----------

async function handleAddUrl(req, env) {
  const token = parseAuth(req);
  if (token !== env.ADMIN_TOKEN) return json({ error: "Unauthorized" }, 401);

  const body = await req.json().catch(() => null);
  if (!body || !body.url) return json({ error: "missing url" }, 400);

  const url = body.url.trim();
  if (!isValidUrl(url)) return json({ error: "invalid url" }, 400);

  const allowed = (env.ALLOWED_DOMAINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const host = new URL(url).hostname.toLowerCase();

  if (allowed.length && !allowed.includes(host)) {
    return json({ error: "domain not allowed", host }, 403);
  }

  const r = await putUrl(env, url);
  return json({ ok: true, added: r });
}

async function handleList(req, env) {
  const token = parseAuth(req);
  if (token !== env.ADMIN_TOKEN) return json({ error: "Unauthorized" }, 401);
  const res = await listUrls(env);
  return json({ count: res.length, items: res });
}

async function handleVisitNow(req, env) {
  const token = parseAuth(req);
  if (token !== env.ADMIN_TOKEN) return json({ error: "Unauthorized" }, 401);

  const body = await req.json().catch(() => null);
  if (!body?.url) return json({ error: "missing url" }, 400);

  const result = await timedFetch(body.url, parseInt(env.REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT));
  return json({ url: body.url, result });
}

// ----------- Cron 定时调度 -----------

async function scheduledHandler(env) {
  const items = await listUrls(env);
  if (!items.length) return;

  const timeout = parseInt(env.REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const p = items[index++];
      const r = await timedFetch(p.url, timeout);

      const rec = {
        ...p,
        lastVisited: new Date().toISOString(),
        lastStatus: r.ok ? r.status : r.error,
        successCount: p.successCount + (r.ok ? 1 : 0),
        failCount: p.failCount + (r.ok ? 0 : 1)
      };

      await env.URLS_KV.put(p.key, JSON.stringify(rec));
    }
  }

  await Promise.all(new Array(Math.min(CONCURRENCY, items.length)).fill(0).map(worker));
}

// ----------- Worker 主体 -----------

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;

    if (req.method === "POST" && path === "/add-url") return handleAddUrl(req, env);
    if (req.method === "GET" && path === "/list") return handleList(req, env);
    if (req.method === "POST" && path === "/visit-now") return handleVisitNow(req, env);

    return new Response("KeepAlive Worker running.", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    await scheduledHandler(env);
  }
};
