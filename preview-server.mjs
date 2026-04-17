import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = join(__dirname, "pages");
const MANIFEST_PATH = join(PAGES_DIR, "_manifest.json");
const PORT = Number(process.env.PORT) || 8787;
/** 监听地址：本机预览用 127.0.0.1；服务器部署请设 PREVIEW_BIND=0.0.0.0 */
const BIND_HOST = process.env.PREVIEW_BIND || "127.0.0.1";
/** 可选：TLS 证书/私钥路径（与 Cloudflare Origin Certificate 搭配，用于 Node 直连 HTTPS） */
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || process.env.TLS_CERT_FILE || "";
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || process.env.TLS_KEY_FILE || "";
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8443;
const HTTPS_BIND = process.env.HTTPS_BIND || BIND_HOST;
/** 未命中快照时是否从原站拉取静态资源等（否则 CSS/JS/图 404，无法接近 1:1 还原） */
const LIVE_ORIGIN = (process.env.LIVE_ORIGIN || "https://illyvoip.com").replace(/\/$/, "");
const PROXY_MISS = process.env.PREVIEW_PROXY_MISS !== "0";

/**
 * CookieYes 脚本内写死 registeredDomain；在非 illyvoip.com 上打开会因校验失败整段不执行，横幅按钮无响应。
 * 默认经本服务代理并改写 registeredDomain 为当前访问主机名；设为 0 则仍从 cdn-cookieyes.com 直连。
 */
const COOKIEYES_PROXY_ENABLED = process.env.PREVIEW_COOKIEYES_PROXY !== "0";
const COOKIEYES_CACHE_MS = Number(process.env.PREVIEW_COOKIEYES_CACHE_MS) || 21600000;

/** @type {Map<string, { js: string; t: number }>} */
const cookieYesScriptCache = new Map();
/**
 * 访问 `/` 且无查询串时的回退候选之一（清单里 `https://illyvoip.com/` 常为爬虫当时的语言，如意大利语）。
 * 设为 `original` 表示仍用清单中的裸 `/`，且不启用 CF-IPCountry / Accept-Language 推断。
 * 非 original 时默认 `?lang=en`；若开启 PREVIEW_GEO_HOME，会优先按地区与浏览器语言匹配已有快照。
 */
function getDefaultHomeQuery() {
  const raw = process.env.PREVIEW_DEFAULT_HOME_QUERY;
  if (raw === "original") return null;
  if (raw && String(raw).trim()) {
    const t = String(raw).trim();
    return t.startsWith("?") ? t : `?${t}`;
  }
  return "?lang=en";
}
const DEFAULT_HOME_QUERY = getDefaultHomeQuery();

/** 设为 0 时根路径不按地区/浏览器语言推断，仅用 PREVIEW_DEFAULT_HOME_QUERY 与回退链 */
const GEO_HOME_ENABLED = process.env.PREVIEW_GEO_HOME !== "0";

/** 与清单 ?lang= 一致的首页语言码（仅命中已有快照时才会被采用） */
const SUPPORTED_LANGS = ["en", "es", "fr", "de", "zh", "ja", "pt", "hi", "it"];

/** Cloudflare 国家码（及直连时可用的启发式）→ 站点 lang；未列出的国家交给 Accept-Language 或回退 */
const CC_TO_LANG_BASE = {
  CN: "zh",
  TW: "zh",
  HK: "zh",
  MO: "zh",
  JP: "ja",
  KR: "en",
  IN: "hi",
  IT: "it",
  SM: "it",
  VA: "it",
  PT: "pt",
  BR: "pt",
  ES: "es",
  MX: "es",
  AR: "es",
  CO: "es",
  CL: "es",
  PE: "es",
  VE: "es",
  EC: "es",
  UY: "es",
  BO: "es",
  PY: "es",
  GT: "es",
  HN: "es",
  SV: "es",
  NI: "es",
  CR: "es",
  PA: "es",
  DO: "es",
  CU: "es",
  FR: "fr",
  LU: "fr",
  MC: "fr",
  BE: "fr",
  DE: "de",
  AT: "de",
  LI: "de",
};

function buildCcToLang() {
  const out = { ...CC_TO_LANG_BASE };
  const raw = process.env.PREVIEW_CC_LANG_JSON;
  if (!raw || !String(raw).trim()) return out;
  try {
    const extra = JSON.parse(raw);
    if (extra && typeof extra === "object" && !Array.isArray(extra)) {
      for (const [k, v] of Object.entries(extra)) {
        const cc = String(k).trim().toUpperCase();
        const lang = String(v).trim().toLowerCase();
        if (cc.length === 2 && SUPPORTED_LANGS.includes(lang)) out[cc] = lang;
      }
    }
  } catch {
    /* 忽略无效 JSON */
  }
  return out;
}

const CC_TO_LANG = buildCcToLang();

function langFromCfCountry(h) {
  if (!h || typeof h !== "string") return null;
  const cc = h.trim().toUpperCase();
  if (cc.length !== 2 || cc === "XX" || cc === "T1") return null;
  return CC_TO_LANG[cc] || null;
}

/** 取 Accept-Language 中第一个与快照语言列表匹配的主语言码 */
function langFromAcceptLanguage(h) {
  if (!h || typeof h !== "string") return null;
  for (const segment of h.split(",")) {
    const tag = segment.split(";")[0].trim().toLowerCase().replace(/_/g, "-");
    if (!tag) continue;
    const prim = tag.split("-")[0];
    if (SUPPORTED_LANGS.includes(prim)) return prim;
  }
  return null;
}

/** 设为 0 时不用 Cookie 记住站点语言，子页不会自动选用与首页一致的语言快照 */
const PREVIEW_LANG_PERSIST = process.env.PREVIEW_LANG_PERSIST !== "0";
const PREVIEW_LANG_COOKIE = (process.env.PREVIEW_LANG_COOKIE_NAME || "preview_site_lang").trim() || "preview_site_lang";
const PREVIEW_LANG_COOKIE_MAX_AGE = Number(process.env.PREVIEW_LANG_COOKIE_MAX_AGE) || 31536000;

/** 从请求 Cookie 读取上次选用的 lang */
function parsePreviewLangCookie(req) {
  const raw = req.headers.cookie;
  if (!raw || typeof raw !== "string") return null;
  for (const part of raw.split(";")) {
    const p = part.trim();
    if (!p.toLowerCase().startsWith(PREVIEW_LANG_COOKIE.toLowerCase() + "=")) continue;
    let v = p.slice(PREVIEW_LANG_COOKIE.length + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      /* 保留原样 */
    }
    v = v.toLowerCase();
    if (SUPPORTED_LANGS.includes(v)) return v;
  }
  return null;
}

/** 从路由键 path?lang=xx 且仅有 lang 参数时取出语言码 */
function langQueryFromRouteKey(keyPath) {
  const qi = keyPath.indexOf("?");
  if (qi === -1) return null;
  try {
    const sp = new URL(`http://local${keyPath.slice(qi)}`).searchParams;
    const keys = [...sp.keys()];
    if (keys.length !== 1 || keys[0] !== "lang") return null;
    const v = sp.get("lang");
    if (!v) return null;
    const lo = v.toLowerCase();
    return SUPPORTED_LANGS.includes(lo) ? lo : null;
  } catch {
    return null;
  }
}

/** 模拟浏览器回源，降低 CDN / 防火墙对非浏览器请求的拦截概率 */
const UPSTREAM_BROWSER_UA =
  process.env.UPSTREAM_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 规范化路径键（与爬虫子站去重思路一致） */
function routeKey(pathname, search) {
  let p = pathname || "/";
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p + (search || "");
}

/**
 * 原站「Site Language」仅带 ?lang= 跳转；清单里通常只有无查询的 URL，
 * 回退到同一路径的快照，避免预览里选语言后 404。
 */
function langOnlyFallbackKey(pathname, search) {
  if (!search || search === "?") return null;
  const q = search.startsWith("?") ? search : `?${search}`;
  let u;
  try {
    u = new URL(`http://local${q}`);
  } catch {
    return null;
  }
  const keys = [...u.searchParams.keys()];
  if (keys.length === 1 && keys[0] === "lang") {
    return routeKey(pathname, "");
  }
  return null;
}

/**
 * 根据请求头生成浏览器应使用的站点 origin（公网部署时用 Host，而非写死 127.0.0.1）
 * @param {import("node:http").IncomingMessage} req
 * @param {{ directTls?: boolean }} [meta] directTls 为 true 表示客户端直连本进程的 HTTPS
 */
function clientOrigin(req, meta = {}) {
  const xfHost = req.headers["x-forwarded-host"];
  const host = (typeof xfHost === "string" ? xfHost.split(",")[0].trim() : null) || req.headers.host;
  const xfProto = req.headers["x-forwarded-proto"];
  const protoRaw = typeof xfProto === "string" ? xfProto.split(",")[0].trim() : "";
  let proto = protoRaw === "https" ? "https" : "http";
  if (!protoRaw && meta.directTls) proto = "https";
  if (host) return `${proto}://${host}`;
  return `http://127.0.0.1:${PORT}`;
}

/**
 * 供 CookieYes registeredDomain 与浏览器 hostname 一致；优先反代头（避免 Node 只看到 127.0.0.1）。
 * 仍可用 PREVIEW_COOKIEYES_REGISTERED_HOST 强制覆盖。
 * @param {import("node:http").IncomingMessage} req
 */
function requestHostnameForCookieYes(req, origin) {
  const forced = (process.env.PREVIEW_COOKIEYES_REGISTERED_HOST || "").trim();
  if (forced) {
    try {
      if (/^https?:\/\//i.test(forced)) return new URL(forced).hostname;
      return new URL(`http://${forced}`).hostname;
    } catch {
      return forced.split(":")[0].replace(/^\[|\]$/g, "") || "localhost";
    }
  }
  const xf =
    typeof req.headers["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"].split(",")[0].trim() : "";
  const raw = xf || (typeof req.headers.host === "string" ? req.headers.host.split(",")[0].trim() : "");
  if (raw) {
    try {
      if (/^https?:\/\//i.test(raw)) return new URL(raw).hostname;
      return new URL(`http://${raw}`).hostname;
    } catch {
      return raw.split(":")[0];
    }
  }
  try {
    return new URL(origin).hostname;
  } catch {
    return "localhost";
  }
}

/**
 * 将 Zaraz / RUM / Insights 相关路径改到本站 __preview（含「当前 origin + /cdn-cgi/…」绝对 URL、fetch("/cdn-cgi/zaraz/t") 等）
 * @param {string} html
 * @param {string} base 无末尾斜杠的 origin
 */
function rewriteCdnCgiPathsForPreview(html, base) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let h = html;
  const bases = [base];
  const altProto = /^https:/i.test(base) ? base.replace(/^https:/i, "http:") : base.replace(/^http:/i, "https:");
  if (altProto !== base) bases.push(altProto);
  for (const o of bases) {
    const e = esc(o);
    h = h.replace(
      new RegExp(`${e}/cdn-cgi/zaraz/([a-z][a-z0-9_-]*\\.js)(\\?[^"'\\s<>]*)?`, "gi"),
      `${o}/__preview/zaraz-s.js$2`,
    );
    h = h.replace(new RegExp(`${e}/cdn-cgi/rum([^"'\\s<>]*)`, "gi"), `${o}/__preview/cf-rum$1`);
  }
  h = h.replace(/\/cdn-cgi\/zaraz\/[a-z][a-z0-9_-]*\.js/gi, "/__preview/zaraz-s.js");
  h = h.replace(/\/cdn-cgi\/zaraz\/t\b/g, "/__preview/zaraz-t");
  h = h.replace(/\/cdn-cgi\/rum\b/g, "/__preview/cf-rum");
  h = h.replace(/<script\b[^>]*?static\.cloudflareinsights\.com\/beacon\.min\.js[^>]*>\s*<\/script>/gi, "");
  return h;
}

/**
 * 与「最外层」成对的 </div> 起始下标（tagEnd 为开始 div 的 `>` 下标）
 * @param {string} html
 * @param {number} tagEnd
 * @returns {number} `</div>` 中 `<` 的下标，失败为 -1
 */
function findMatchingDivCloseIndex(html, tagEnd) {
  let depth = 1;
  let pos = tagEnd + 1;
  while (depth > 0 && pos < html.length) {
    const nextOpen = html.indexOf("<div", pos);
    const nextClose = html.indexOf("</div>", pos);
    if (nextClose === -1) return -1;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + 4;
    } else {
      depth--;
      if (depth === 0) return nextClose;
      pos = nextClose + 6;
    }
  }
  return -1;
}

/**
 * 抓取快照常把已渲染的 reCAPTCHA 整段写进 .g-recaptcha；再次执行 api.js 会报
 * "reCAPTCHA placeholder element must be empty"。输出前清空占位，仅保留开始标签。
 * @param {string} html
 */
function emptyRecaptchaPlaceholders(html) {
  let out = html;
  let scan = 0;
  for (let safety = 0; safety < 80; safety++) {
    const rel = out.slice(scan).search(/<div\b/i);
    if (rel === -1) break;
    const start = scan + rel;
    const openMatch = out.slice(start).match(/^<div\b[^>]*>/i);
    if (!openMatch) {
      scan = start + 1;
      continue;
    }
    const openTag = openMatch[0];
    const tagEnd = start + openTag.length - 1;
    const clsMatch = openTag.match(/\bclass\s*=\s*(["'])([\s\S]*?)\1/i);
    const classVal = clsMatch ? clsMatch[2] : "";
    // 仅匹配 class 词 g-recaptcha，避免 g-recaptcha-bubble-arrow 等
    if (!/(^|\s)g-recaptcha(\s|$)/.test(classVal)) {
      scan = start + 1;
      continue;
    }
    const closeLt = findMatchingDivCloseIndex(out, tagEnd);
    if (closeLt === -1) {
      scan = start + 1;
      continue;
    }
    out = out.slice(0, tagEnd + 1) + "</div>" + out.slice(closeLt + 6);
    scan = tagEnd + 7;
  }
  return out;
}

/** 将快照中的主站绝对地址改为当前预览源，便于本地点击跳转 */
function rewriteForPreview(html, origin) {
  const host = new URL(origin).host;
  const protoHost = "//" + host;
  const base = origin.replace(/\/$/, "");

  let out = html
    .replace(/https:\/\/www\.illyvoip\.com/gi, origin)
    .replace(/https:\/\/illyvoip\.com/gi, origin)
    .replace(/http:\/\/www\.illyvoip\.com/gi, origin)
    .replace(/http:\/\/illyvoip\.com/gi, origin)
    .replace(/\/\/www\.illyvoip\.com/gi, protoHost)
    .replace(/\/\/illyvoip\.com/gi, protoHost);

  /**
   * 根路径资源（/assets、/img、/cdn-cgi）改为带预览 origin 的绝对 URL，
   * 避免 file://、错误 base 或子路径下相对解析导致字体/图裂。
   */
  out = out.replace(/\b(src|href)=(["'])\/(assets\/|img\/|cdn-cgi\/)/gi, (_, a, q, p) => `${a}=${q}${base}/${p}`);
  out = out.replace(/url\(\s*(["']?)\/(assets\/|img\/|cdn-cgi\/)/gi, (_, q, p) => `url(${q}${base}/${p}`);
  /** 内联 CSS 常见无前导斜杠的 url(assets/、url(asset/（装饰图等） */
  out = out.replace(/url\(\s*(["']?)(assets\/|asset\/)/gi, (_, q, p) => (q ? `url(${q}${base}/${p}` : `url(${base}/${p}`));
  out = out.replace(/([,\s])\/(assets\/|img\/)/g, (_, sep, p) => `${sep}${base}/${p}`);

  /** 统一以本站为基准解析无前导斜杠的 assets 等相对路径（放在 charset 后以免编码提示） */
  if (!/<base\s/i.test(out)) {
    const baseTag = `<base href="${base}/">`;
    if (/<meta\s+charset=/i.test(out)) {
      out = out.replace(/(<meta\s+charset=[^>]*>)/i, `$1${baseTag}`);
    } else {
      out = out.replace(/<head(\s[^>]*)?>/i, `<head$1>${baseTag}`);
    }
  }

  /**
   * 本地预览没有 Cloudflare 的 __cfRLUnblockHandlers；原页里大量
   * onclick="if (!window.__cfRLUnblockHandlers) return false; openLanguagePopup()"
   * 会导致「Site Language」等按钮永远不执行后续逻辑。
   */
  out = out.replace(/if\s*\(\s*!window\.__cfRLUnblockHandlers\s*\)\s*return\s+false;\s*/gi, "");

  /**
   * 页头 logo：将带 logo-img 的 <img> 换为字标（渐变圆角，与站点主色 #2a9d8f 协调）
   */
  const rawLogo = (process.env.PREVIEW_LOGO_TEXT || process.env.PREVIEW_BRAND_NAME || "kaolach").trim() || "kaolach";
  const logoEsc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const logoText = logoEsc(rawLogo);
  const logoStyle = [
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "padding:0.32em 0.75em 0.36em",
    "border-radius:0.5em",
    "font:800 clamp(0.92rem,2.2vw,1.12rem)/1.15 system-ui,-apple-system,Segoe UI,sans-serif",
    "letter-spacing:0.06em",
    "text-transform:lowercase",
    "color:#fff",
    "background:linear-gradient(135deg,#145a52 0%,#1f7a6e 38%,#2a9d8f 72%,#4dd4b8 100%)",
    "box-shadow:0 1px 0 rgba(255,255,255,.22) inset,0 2px 6px rgba(10,20,37,.12),0 4px 14px rgba(42,157,143,.28)",
    "border:1px solid rgba(255,255,255,.18)",
    "text-shadow:0 1px 1px rgba(0,0,0,.12)",
  ].join(";");
  const logoSpan = `<span class="logo-img logo-wordmark--kaolach" role="img" aria-label="${logoText}" style="${logoStyle}">${logoText}</span>`;
  out = out.replace(/<img\b[^>]*\bclass="[^"]*logo-img[^"]*"[^>]*>/gi, logoSpan);
  out = out.replace(/<img\b[^>]*\bclass='[^']*logo-img[^']*'[^>]*>/gi, logoSpan);

  /** 文案品牌：IllyVoIP → kaolach（不区分大小写会破坏 URL 中的 illyvoip 片段，故仅替换常见书写形式） */
  out = replaceLegacyBrandName(out);

  /** 修复中文快照页脚爬取/机翻错误：重复「其他」电话文案、版权行「阻力」「伊利沃IP」等 */
  out = fixZhFooterSnapshotCorruption(out, base, logoEsc);

  /** 字标 hover 微交互（仅注入一次） */
  if (!/id=["']preview-brand-style["']/.test(out)) {
    const brandCss =
      '<style id="preview-brand-style">.logo-wordmark--kaolach{transition:transform .2s ease,filter .2s ease,box-shadow .2s ease}.logo-wordmark--kaolach:hover{filter:brightness(1.07);transform:translateY(-1px);box-shadow:0 1px 0 rgba(255,255,255,.25) inset,0 3px 10px rgba(10,20,37,.14),0 6px 18px rgba(42,157,143,.32)}</style>';
    out = out.replace(/<\/head>/i, `${brandCss}</head>`);
  }

  /** CookieYes：把外链改成本站代理 URL，由 handleRequest 拉取 CDN 并补丁 registeredDomain */
  if (COOKIEYES_PROXY_ENABLED) {
    out = out.replace(
      /https:\/\/cdn-cookieyes\.com\/client_data\/([a-zA-Z0-9_-]+)\/script\.js/gi,
      (_, id) => `${base}/__preview/cookieyes-script.js?id=${encodeURIComponent(id)}`,
    );
    out = out.replace(
      /\/\/cdn-cookieyes\.com\/client_data\/([a-zA-Z0-9_-]+)\/script\.js/gi,
      (_, id) => `${base}/__preview/cookieyes-script.js?id=${encodeURIComponent(id)}`,
    );
  }

  /** Zaraz/RUM：放输出链末端；内联里还有 fetch("/cdn-cgi/zaraz/t") 与「当前域+cdn-cgi」绝对 URL */
  out = rewriteCdnCgiPathsForPreview(out, base);

  /**
   * CookieYes 等会在同意前 preload gtag，但脚本未执行，Chrome 报「preloaded but not used」。
   * 仅移除 link preload，不删内联 gtag/config（同意后仍可按原逻辑加载）。
   */
  out = out.replace(/<link\b[^>]*googletagmanager\.com\/gtag\/js[^>]*>/gi, "");

  /** 缓存/边缘仍下发旧 HTML 时，在 head 最前拦截 fetch 与 script.src 对 /cdn-cgi 的请求 */
  if (!/data-preview-cdn-shim=/.test(out)) {
    const cdnShim =
      '<script data-preview-cdn-shim="1">' +
      "(function(){try{var F=window.fetch;if(F)window.fetch=function(i,n){if(typeof i==='string'){if(i.indexOf('/cdn-cgi/zaraz/')!==-1){var q=i.indexOf('?');return F.call(window,'/__preview/zaraz-s.js'+(q>=0?i.slice(q):''),n);}if(i.indexOf('/cdn-cgi/rum')!==-1){var q2=i.indexOf('?');return F.call(window,'/__preview/cf-rum'+(q2>=0?i.slice(q2):''),n);}}return F.call(window,i,n);};var d=Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,'src');if(d&&d.set){var os=d.set;Object.defineProperty(HTMLScriptElement.prototype,'src',{configurable:!0,enumerable:!0,get:d.get,set:function(v){if(typeof v==='string'&&v.indexOf('/cdn-cgi/zaraz/')!==-1){var q=v.indexOf('?');var o=(typeof location!=='undefined'&&location.origin)?location.origin:'';v=o+'/__preview/zaraz-s.js'+(q>=0?v.slice(q):'');}os.call(this,v);}});}}catch(e){}})();" +
      "</script>";
    out = out.replace(/<head(\s[^>]*)?>/i, `<head$1>${cdnShim}`);
  }

  /** 快照内已渲染的 reCAPTCHA 会阻塞客户端再次 render，并触发 Timeout */
  out = emptyRecaptchaPlaceholders(out);

  /** 抓取器常写入 gstatic 的 recaptcha__*.js（带 integrity）；与 api.js 实际版本不一致易导致异常或超时，仅保留 api.js 即可 */
  out = out.replace(
    /<script\b[^>]*\bsrc=["']https:\/\/www\.gstatic\.com\/recaptcha\/releases\/[^"']+["'][^>]*>\s*<\/script>/gi,
    "",
  );

  return out;
}

/**
 * 修复 lang=zh 等中文快照里页脚已知乱码（爬虫误把链接文本写成「其他」、版权行误译等）
 * @param {string} html
 * @param {string} base 站点 origin（无末尾 /）
 * @param {(s: string) => string} esc HTML 属性/文本转义
 */
function fixZhFooterSnapshotCorruption(html, base, esc) {
  let s = html;
  const zhName = esc(
    (process.env.PREVIEW_FOOTER_ZH_NAME || process.env.PREVIEW_COMPANY_ALT || process.env.PREVIEW_BRAND_NAME || "考拉出海").trim() ||
      "考拉出海",
  );
  /** 北美电话：正文曾被写成大量「其他」 */
  s = s.replace(/<a\s+href="tel:\+18776952209">[\s\S]*?<\/a>/gi, '<a href="tel:+18776952209">+1 877 695 2209</a>');
  /** 欧洲电话：曾被误标为「其他国家」 */
  s = s.replace(/<a\s+href="tel:\+442037695545">\s*其他国家\s*<\/a>/gi, '<a href="tel:+442037695545">+44 203 7695545</a>');
  /** 版权行：「阻力」= Powered by 误译；「伊利沃IP」= IllyVoIP 音译错误 */
  s = s.replace(
    /(<span id="currentYear">\d+<\/span>)阻力;<a class="fs-16" href="[^"]*" target="_blank">伊利沃IP LLC<\/a>保护所有权利\./g,
    `$1 <a class="fs-16" href="${base}/" target="_blank">${zhName}</a> 保留所有权利。`,
  );
  return s;
}

/** 将页面中的 IllyVoIP 品牌写法替换为 PREVIEW_BRAND_NAME（默认 kaolach）；保留 URL 路径/锚点中的 illyvoip 子串 */
function replaceLegacyBrandName(html) {
  const brand = (process.env.PREVIEW_BRAND_NAME || "kaolach").trim() || "kaolach";
  let s = html;
  /** 较长短语优先，避免先替成「kaolach LLC」等 */
  const pairs = [
    ["IllyVoIP LLC", brand],
    ["IllyVoIP's", `${brand}'s`],
    ["IllyVoIP\u2019s", `${brand}\u2019s`],
    ["IllyVoIP", brand],
    ["IllyVOIP", brand],
    ["ILLYVOIP", brand],
    ["Illyvoip", brand],
  ];
  for (const [from, to] of pairs) {
    s = s.split(from).join(to);
  }
  return s;
}

let manifest = [];
try {
  const raw = await readFile(MANIFEST_PATH, "utf8");
  manifest = JSON.parse(raw);
} catch (e) {
  console.error("无法读取清单:", MANIFEST_PATH, e.message);
  process.exit(1);
}

/** path+search -> 文件名（仅成功保存的条目） */
const routes = new Map();
for (const m of manifest) {
  if (!m.file || m.error || !m.chars) continue;
  try {
    const u = new URL(m.url);
    const k = routeKey(u.pathname, u.search);
    if (!routes.has(k)) routes.set(k, m.file);
  } catch {
    /* 跳过 */
  }
}

/**
 * 根路径 `/` 且无查询串时选择快照键。
 * `PREVIEW_DEFAULT_HOME_QUERY=original`（即 DEFAULT_HOME_QUERY 为 null）时始终用清单裸 `/`，不启用地区推断。
 */
function pickHomeSnapshotKey(req) {
  if (DEFAULT_HOME_QUERY === null) {
    return routeKey("/", "");
  }
  const candidates = [];
  if (GEO_HOME_ENABLED) {
    const geo = langFromCfCountry(req.headers["cf-ipcountry"]);
    if (geo) candidates.push(`?lang=${geo}`);
    const al = langFromAcceptLanguage(req.headers["accept-language"]);
    if (al) candidates.push(`?lang=${al}`);
  }
  if (DEFAULT_HOME_QUERY) {
    candidates.push(DEFAULT_HOME_QUERY);
  }
  candidates.push("?lang=en");
  candidates.push("__ROOT__");

  for (const q of candidates) {
    const k = q === "__ROOT__" ? routeKey("/", "") : routeKey("/", q);
    if (routes.has(k)) return k;
  }
  return routeKey("/", "");
}

function catalogHtml(origin) {
  const rows = manifest
    .filter((m) => m.file && m.chars && !m.error)
    .map((m) => {
      try {
        const u = new URL(m.url);
        const href = origin + routeKey(u.pathname, u.search);
        const title = m.url.replace(/^https:\/\//, "");
        return `<li><a href="${href}">${title}</a> <small>(${m.chars} 字)</small></li>`;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("\n");

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>已爬取页面目录</title>
<style>body{font-family:system-ui,sans-serif;max-width:56rem;margin:2rem auto;padding:0 1rem}ol{line-height:1.7}</style></head>
<body><h1>已爬取页面目录</h1><p>共 ${manifest.filter((m) => m.chars && !m.error).length} 个快照。<a href="${origin}/">打开首页快照</a></p><ol>${rows}</ol></body></html>`;
}

/**
 * 拉取并补丁 CookieYes 的 script.js / banner.js（banner 仍从 CDN 绝对路径加载会绕过 HTML 改写）。
 * @param {string} clientId
 * @param {"script.js" | "banner.js"} fileName
 * @param {string} registeredHost 与 window.location.hostname 应对齐（无端口）
 */
async function getPatchedCookieYesBundle(clientId, fileName, registeredHost) {
  if (fileName !== "script.js" && fileName !== "banner.js") throw new Error("invalid CookieYes file");
  const legacy = (process.env.PREVIEW_COOKIEYES_LEGACY_DOMAIN || "illyvoip.com").trim();
  /** 写入 JS 字面量时的转义（主机名极少含引号，防御性处理） */
  const escJsString = (h) => h.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const cacheKey = `${clientId}\t${fileName}\t${registeredHost}\t${legacy}`;
  const hit = cookieYesScriptCache.get(cacheKey);
  if (hit && Date.now() - hit.t < COOKIEYES_CACHE_MS) return hit.js;

  const upstream = `https://cdn-cookieyes.com/client_data/${clientId}/${fileName}`;
  const r = await fetch(upstream, {
    headers: { "user-agent": UPSTREAM_BROWSER_UA, accept: "*/*" },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  let js = await r.text();
  const needle = `registeredDomain:"${legacy}"`;
  const patchedDomain = `registeredDomain:"${escJsString(registeredHost)}"`;
  if (js.includes(needle)) {
    js = js.split(needle).join(patchedDomain);
  } else if (/registeredDomain:"[^"]+"/.test(js)) {
    /** 快照站点若更换主域，仍尝试只替换第一个 registeredDomain */
    js = js.replace(/registeredDomain:"[^"]+"/, patchedDomain);
  }
  /** script 运行时动态插入的 banner 仍指向 CDN，需改同源代理以便与 script 使用同一套域名校验结果 */
  if (fileName === "script.js") {
    js = js.replace(
      /https:\/\/cdn-cookieyes\.com\/client_data\/([a-zA-Z0-9_-]+)\/banner\.js/g,
      (_, bid) => `/__preview/cookieyes-banner.js?id=${encodeURIComponent(bid)}`,
    );
    js = js.replace(
      /\/\/cdn-cookieyes\.com\/client_data\/([a-zA-Z0-9_-]+)\/banner\.js/g,
      (_, bid) => `/__preview/cookieyes-banner.js?id=${encodeURIComponent(bid)}`,
    );
  }
  cookieYesScriptCache.set(cacheKey, { js, t: Date.now() });
  return js;
}

/** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res @param {{ directTls?: boolean }} meta */
async function handleRequest(req, res, meta = {}) {
  const origin = clientOrigin(req, meta);
  const reqUrl = new URL(req.url || "/", origin);

  if (reqUrl.pathname === "/_catalog") {
    const body = catalogHtml(origin);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
    return;
  }

  /** Zaraz 错误上报 fetch("/cdn-cgi/zaraz/t")，返回空 JSON 即可 */
  if (reqUrl.pathname === "/__preview/zaraz-t") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
      res.end("405");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=600",
    });
    res.end("{}");
    return;
  }
  /** HTML 已把 /cdn-cgi/zaraz/s.js 改到此处，避免橙云边缘对 /cdn-cgi 返回 404 */
  if (reqUrl.pathname === "/__preview/zaraz-s.js") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
      res.end("405");
      return;
    }
    const stub = "/* preview: Zaraz 占位 */\nvoid 0;\n";
    const headers = {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=600",
    };
    if (req.method === "HEAD") {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(stub);
    return;
  }
  /** HTML 将 /cdn-cgi/rum 指到此处；Insights beacon 已尽量移除，仍兼容残余 POST */
  if (reqUrl.pathname === "/__preview/cf-rum" || reqUrl.pathname.startsWith("/__preview/cf-rum/")) {
    res.writeHead(204, { "Cache-Control": "public, max-age=300" });
    res.end();
    return;
  }

  /** 直连 /cdn-cgi/zaraz/* 的兜底（橙云未回源或旧 HTML 未改写时） */
  if (reqUrl.pathname.startsWith("/cdn-cgi/zaraz/")) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
      res.end("405");
      return;
    }
    if (reqUrl.pathname === "/cdn-cgi/zaraz/t" || reqUrl.pathname.endsWith("/zaraz/t")) {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=600",
      });
      res.end("{}");
      return;
    }
    if (!reqUrl.pathname.endsWith(".js")) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404");
      return;
    }
    const stub = "/* preview: Cloudflare Zaraz 占位 */\nvoid 0;\n";
    const headers = {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=600",
    };
    if (req.method === "HEAD") {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(stub);
    return;
  }
  if (reqUrl.pathname === "/cdn-cgi/rum" || reqUrl.pathname.startsWith("/cdn-cgi/rum/")) {
    res.writeHead(204, { "Cache-Control": "public, max-age=300" });
    res.end();
    return;
  }

  const cookieYesFile =
    reqUrl.pathname === "/__preview/cookieyes-script.js"
      ? "script.js"
      : reqUrl.pathname === "/__preview/cookieyes-banner.js"
        ? "banner.js"
        : null;
  if (cookieYesFile) {
    if (!COOKIEYES_PROXY_ENABLED) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("CookieYes 代理已关闭（PREVIEW_COOKIEYES_PROXY=0）。");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
      res.end("405");
      return;
    }
    const id = reqUrl.searchParams.get("id");
    if (!id || !/^[a-zA-Z0-9_-]{8,128}$/.test(id)) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("缺少或无效的 id 参数。");
      return;
    }
    const registeredHost = requestHostnameForCookieYes(req, origin);
    try {
      const js = await getPatchedCookieYesBundle(id, cookieYesFile, registeredHost);
      const headers = {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      };
      if (req.method === "HEAD") {
        res.writeHead(200, headers);
        res.end();
        return;
      }
      res.writeHead(200, headers);
      res.end(js);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("CookieYes 资源拉取失败: " + String(e?.message || e));
    }
    return;
  }

  const langParam = reqUrl.searchParams.get("lang");
  const langFromUrlNorm =
    langParam && SUPPORTED_LANGS.includes(String(langParam).toLowerCase()) ? String(langParam).toLowerCase() : null;
  let cookieLangToSet = langFromUrlNorm;
  const langCookie = PREVIEW_LANG_PERSIST ? parsePreviewLangCookie(req) : null;

  let key = routeKey(reqUrl.pathname, reqUrl.search);
  const bareHome = reqUrl.pathname === "/" && (!reqUrl.search || reqUrl.search === "?");

  /** 非首页：URL 未带 lang 时，若 Cookie 与清单中有对应 ?lang= 快照则选用，避免中文首页点内链又回到英文页 */
  if (!bareHome && PREVIEW_LANG_PERSIST && langCookie && !langFromUrlNorm && !reqUrl.searchParams.has("lang")) {
    const u = new URL(req.url || "/", origin);
    u.searchParams.set("lang", langCookie);
    const sq = u.search;
    const altKey = routeKey(reqUrl.pathname, !sq || sq === "?" ? "" : sq);
    if (routes.has(altKey)) key = altKey;
  }

  if (bareHome) {
    if (PREVIEW_LANG_PERSIST && langCookie && routes.has(routeKey("/", `?lang=${langCookie}`))) {
      key = routeKey("/", `?lang=${langCookie}`);
    } else {
      key = pickHomeSnapshotKey(req);
    }
    const kl = langQueryFromRouteKey(key);
    if (kl) cookieLangToSet = kl;
  }

  let file = routes.get(key);
  if (!file && key !== "/") {
    const withSlash = reqUrl.pathname.endsWith("/")
      ? routeKey(reqUrl.pathname.replace(/\/+$/, "") || "/", reqUrl.search)
      : routeKey(reqUrl.pathname + "/", reqUrl.search);
    file = routes.get(withSlash);
  }
  if (!file) {
    const fk = langOnlyFallbackKey(reqUrl.pathname, reqUrl.search);
    if (fk) file = routes.get(fk);
  }

  if (!file) {
    if (!PROXY_MISS) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 无此路径快照: " + key + "\n请访问 /_catalog 查看全部已保存 URL。");
      return;
    }
    try {
      const upstream = LIVE_ORIGIN + reqUrl.pathname + reqUrl.search;
      const r = await fetch(upstream, {
        method: req.method === "HEAD" ? "HEAD" : "GET",
        headers: {
          "user-agent": req.headers["user-agent"]?.includes("Mozilla")
            ? req.headers["user-agent"]
            : UPSTREAM_BROWSER_UA,
          accept: req.headers["accept"] || "*/*",
          "accept-language": req.headers["accept-language"] || "en-US,en;q=0.9",
          referer: LIVE_ORIGIN + "/",
          origin: LIVE_ORIGIN,
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "no-cors",
        },
        redirect: "follow",
      });
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get("content-type") || "application/octet-stream";
      const outHeaders = { "Content-Type": ct };
      if (/\.(js|css|png|jpe?g|gif|webp|avif|svg|woff2?|ico|ttf|eot)$/i.test(reqUrl.pathname)) {
        outHeaders["Cache-Control"] = "public, max-age=300";
      }
      if (/\.(woff2?|ttf|otf)$/i.test(reqUrl.pathname)) {
        outHeaders["Access-Control-Allow-Origin"] = "*";
        outHeaders["Cross-Origin-Resource-Policy"] = "cross-origin";
      }
      res.writeHead(r.status, outHeaders);
      res.end(buf);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("上游拉取失败: " + String(e.message || e));
    }
    return;
  }

  try {
    let html = await readFile(join(PAGES_DIR, file), "utf8");
    html = rewriteForPreview(html, origin);
    const htmlHeaders = {
      "Content-Type": "text/html; charset=utf-8",
      /** 降低边缘/浏览器长期缓存旧 HTML（未含 /__preview 改写）的概率 */
      "Cache-Control": "private, max-age=0, must-revalidate",
    };
    if (PREVIEW_LANG_PERSIST && cookieLangToSet && SUPPORTED_LANGS.includes(cookieLangToSet)) {
      const secure = origin.startsWith("https:") || meta.directTls ? "; Secure" : "";
      htmlHeaders["Set-Cookie"] = `${PREVIEW_LANG_COOKIE}=${encodeURIComponent(cookieLangToSet)}; Path=/; Max-Age=${PREVIEW_LANG_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
    }
    res.writeHead(200, htmlHeaders);
    res.end(html);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(String(e.message));
  }
}

const httpServer = http.createServer((req, res) => {
  handleRequest(req, res, { directTls: false }).catch((e) => {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(String(e?.message || e));
  });
});

httpServer.listen(PORT, BIND_HOST, () => {
  console.log("预览服务已启动:");
  console.log(`  HTTP 监听  ${BIND_HOST}:${PORT}`);
  console.log(`  本机访问   http://127.0.0.1:${PORT}/`);
  console.log(`  目录列表   http://127.0.0.1:${PORT}/_catalog`);
  if (PROXY_MISS) {
    console.log(`  未命中快照时回源: ${LIVE_ORIGIN}（HTML 仍用本地快照）`);
  }
  if (BIND_HOST === "0.0.0.0") {
    console.log("  公网访问请用: http://<服务器IP>:" + PORT + "/ （HTML 内链按浏览器 Host 自动替换）");
  }
});

if (SSL_CERT_PATH && SSL_KEY_PATH) {
  let tlsContext;
  try {
    tlsContext = {
      cert: readFileSync(SSL_CERT_PATH),
      key: readFileSync(SSL_KEY_PATH),
    };
  } catch (e) {
    console.error("读取 TLS 证书失败:", e.message);
    process.exit(1);
  }
  const httpsServer = https.createServer(tlsContext, (req, res) => {
    handleRequest(req, res, { directTls: true }).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(String(err?.message || err));
    });
  });
  httpsServer.listen(HTTPS_PORT, HTTPS_BIND, () => {
    console.log(`  HTTPS 监听 ${HTTPS_BIND}:${HTTPS_PORT}（证书: ${SSL_CERT_PATH}）`);
  });
}
