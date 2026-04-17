# kaolach 站点预览

基于 **Node.js 内置模块** 的静态 HTML 快照预览服务：将已抓取的 `illyvoip.com` 整页镜像在任意域名下浏览，并在输出时做链接、资源路径、品牌文案、CookieYes / Cloudflare 边缘脚本等改写，便于演示与验收。

> 本仓库 **不是** 正式站业务源码；内容为 `preview-server.mjs` + `pages/` 快照 + `pages/_manifest.json` 路由清单。

## 功能概览

- **路由**：根据请求路径与查询串在清单中查找对应 `.html` 快照；支持 `?lang=` 多语言快照。
- **HTML 改写**：主站绝对 URL 替换为当前访问的 origin；根路径资源（`/assets`、`/img` 等）改为绝对地址；可选注入 `<base>`。
- **首页语言**：根路径 `/` 无查询串时，可按 `PREVIEW_DEFAULT_HOME_QUERY`、`PREVIEW_GEO_HOME`（`CF-IPCountry` / `Accept-Language`）选择已有快照。
- **语言持久化**：`PREVIEW_LANG_PERSIST` 下用 Cookie 在无 `?lang=` 的内链上尽量保持同一语言快照。
- **CookieYes**：默认经 `/__preview/cookieyes-*.js` 代理并改写 `registeredDomain`，避免在非主域名预览时同意横幅无响应。
- **Cloudflare Zaraz / RUM**：对 `/cdn-cgi/` 相关请求提供占位或 shim，减少控制台报错。
- **reCAPTCHA**：输出前清空快照内已渲染的 `.g-recaptcha` 内部 DOM，并移除多余的 `gstatic` `recaptcha__*.js`，避免「placeholder must be empty」与版本冲突。
- **未命中快照**：`PREVIEW_PROXY_MISS` 开启时向 `LIVE_ORIGIN` 回源拉取静态资源（JS/CSS/字体等），减轻 404。

## 环境要求

- **Node.js** 18+（推荐当前 LTS；使用 `import` 与 `fetch`，无 `package.json` 依赖）。

## 快速开始

```bash
git clone https://github.com/astercc518/kaolach.git
cd kaolach
cp deploy/env.example .env   # 可选，按需编辑
node preview-server.mjs
```

浏览器访问：

- 站点首页（按环境变量选择快照）：`http://127.0.0.1:8787/`
- 全部已爬取 URL 目录：`http://127.0.0.1:8787/_catalog`

默认监听 **`127.0.0.1:8787`**。公网或由 Nginx 反代时，可在 `.env` 中设置 `PREVIEW_BIND=0.0.0.0` 并配合防火墙。

## 目录结构

| 路径 | 说明 |
|------|------|
| `preview-server.mjs` | HTTP(S) 服务、路由、HTML 改写与预览专用路由 |
| `pages/_manifest.json` | 原始 URL 与快照文件名的映射列表 |
| `pages/*.html` | 各路径的整页 HTML 快照 |
| `deploy/env.example` | 环境变量说明模板，可复制为项目根目录 `.env` |
| `deploy/illyvoip-preview.service` | systemd 单元示例 |
| `deploy/nginx-cloudflare-origin.conf` | Nginx 反代 + Cloudflare Origin 证书示例片段 |
| `brand/` | 品牌相关静态资源（字标等） |

## 环境变量（摘要）

完整说明见 **`deploy/env.example`**。常用项：

| 变量 | 含义 |
|------|------|
| `PORT` | HTTP 端口，默认 `8787` |
| `PREVIEW_BIND` | 监听地址，默认 `127.0.0.1` |
| `PREVIEW_PROXY_MISS` | 未命中快照是否回源，默认开启；`0` 关闭 |
| `LIVE_ORIGIN` | 回源站点，默认 `https://illyvoip.com` |
| `PREVIEW_BRAND_NAME` | 页面内 IllyVoIP 等文案替换目标，默认 `kaolach` |
| `PREVIEW_DEFAULT_HOME_QUERY` | 裸 `/` 时优先使用的查询串；`original` 保留清单中的 `/` |
| `PREVIEW_GEO_HOME` | 是否按地区/浏览器语言推断首页语言 |
| `PREVIEW_LANG_PERSIST` | 是否用 Cookie 保持语言快照 |
| `PREVIEW_COOKIEYES_PROXY` | 是否启用 CookieYes 同源代理 |
| `SSL_CERT_PATH` / `SSL_KEY_PATH` | 若设置，则额外监听 HTTPS（`HTTPS_PORT` 等） |

## 生产部署提示

1. 复制 `deploy/env.example` 为 `.env`，按域名与证书路径修改。
2. 使用 **`deploy/illyvoip-preview.service`** 时注意 `WorkingDirectory`、`ExecStart` 中的 Node 路径与项目路径。
3. 前置 **Nginx** 终止 TLS 时，可参考 `deploy/nginx-cloudflare-origin.conf`；若 CookieYes 报域名相关错误，请传入 **`X-Forwarded-Host`**（或设置 `PREVIEW_COOKIEYES_REGISTERED_HOST`）。
4. 更新 `preview-server.mjs` 后，若前有 CDN，建议对 HTML 关闭长期缓存或清除缓存，避免边缘仍返回未改写的旧页面。

## 快照与仓库体积

- 快照由外部爬取流程生成并写入 `pages/` 与 `_manifest.json`；更新站点镜像需重新跑爬取并替换对应文件。
- 仓库内若含较大打包文件（如 `deploy-site.zip`），GitHub 会提示大文件警告；长期维护可考虑 Git LFS 或改为 Release 附件。

## 许可证

若未另行声明，默认以仓库所有者指定为准；使用第三方站点快照内容时请遵守原站版权与使用条款。
