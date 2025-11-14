# KeepAlive Worker

Cloudflare Workers 版的定时保活访问服务。

- 使用 KV 存储多个 URL
- 定时通过 Cron 自动访问这些 URL
- 提供 API 管理接口（添加 URL / 列出 URL / 立即访问）

---

## 🚀 部署步骤

### 1. 安装 Wrangler
npm install -g wrangler

### 2. 登录 Cloudflare
wrangler login

### 3. 创建 KV Namespace
wrangler kv:namespace create URLS_KV
把返回的 id 填到 wrangler.toml 中。

###4. 编辑环境变量
在 wrangler.toml 中设置：

ADMIN_TOKEN
REQUEST_TIMEOUT_MS
ALLOWED_DOMAINS（可选）

###5. 发布
wrangler publish

## 📡 API 使用
###添加 URL（需要 Token）
curl -X POST "https://<worker-url>/add-url" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-site.com"}'
  
###查看列表
curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
  "https://<worker-url>/list"
  
###立即访问
curl -X POST "https://<worker-url>/visit-now" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-site.com"}'

## ⏲ Cron
默认每 15 分钟 访问一次。

修改 wrangler.toml：
[[triggers.crons]]
cron = "*/5 * * * *"
即可每 5 分钟访问一次。

##🛡 安全
必须设置 ADMIN_TOKEN
可使用 ALLOWED_DOMAINS 限制域名白名单
所有修改操作必须带 Bearer Token
