"use strict";

/**
 * GStats —— 飞牛 fnOS 应用服务端。
 *
 * 通过飞牛统一网关（Unix Socket）对外提供服务，全部逻辑均使用 Node.js 内置模块，
 * 不依赖任何第三方 npm 包，便于在离线 NAS 环境中安装与运行。
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const config = require("./lib/config");
const auth = require("./lib/auth");
const github = require("./lib/github");
const report = require("./lib/report");
const traffic = require("./lib/traffic");
const util = require("./lib/util");
const { Store } = require("./lib/store");

config.initDirs();

let cfg = config.readConfig();
const store = new Store(cfg);
store.init();

const startedAt = Date.now();

/* ------------------------------------------------------------------ HTTP 工具 */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8"
};

function sendJson(res, status, payload, extraHeaders) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    ...(extraHeaders || {})
  });
  res.end(body);
}

function sendError(res, status, message, code) {
  sendJson(res, status, { ok: false, error: message, code: code || status });
}

function sendBinary(res, status, contentType, buffer, extraHeaders) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": buffer.length,
    ...(extraHeaders || {})
  });
  res.end(buffer);
}

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      resolve(util.safeJsonParse(text, null) || {});
    });
    req.on("error", reject);
  });
}

function readRawBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* -------------------------------------------------------------------- 路由表 */

const routes = [];

function toRegex(pattern) {
  const keys = [];
  const source = pattern
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      if (seg.startsWith("*")) {
        keys.push(seg.slice(1) || "rest");
        return "(.*)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${source}/?$`), keys };
}

function route(method, pattern, handler) {
  const { regex, keys } = toRegex(pattern);
  routes.push({ method, pattern, regex, keys, handler });
}

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.regex.exec(pathname);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { route: r, params };
    }
  }
  return null;
}

/* -------------------------------------------------------------------- 上下文 */

function buildContext(req, url, identity) {
  const user = store.touchUser(identity.uid, {
    fnosUsername: identity.username,
    isAdmin: identity.isAdmin
  });
  return {
    req,
    url,
    identity,
    user,
    isAdmin: identity.isAdmin,
    token: store.getToken(identity.uid),
    agent: req.headers["user-agent"] || ""
  };
}

function requireGithub(ctx, res) {
  if (!ctx.user.github || !ctx.token) {
    sendError(res, 428, "请先登录 GitHub 账号", "github_not_linked");
    return false;
  }
  return true;
}

function requireAdmin(ctx, res) {
  if (!ctx.isAdmin) {
    sendError(res, 403, "该操作仅管理员可用", "forbidden");
    return false;
  }
  return true;
}

/** 后台异步同步某用户的 GitHub 流量，不阻塞当前请求 */
function scheduleUserSync(uid, delayMs = 3000) {
  setTimeout(() => {
    traffic.syncUser(store, uid).catch((e) => {
      console.error(`[gstats] traffic sync for ${uid} failed:`, e.message);
      store.setSyncStatus(uid, { status: "failed", finishedAt: Date.now(), message: e.message });
      store.persistTraffic();
    });
  }, delayMs).unref();
}

/** 统计查询的用户范围：非管理员只能看自己绑定账号的数据 */
function statsUid(ctx, url) {
  return ctx.isAdmin ? url.searchParams.get("uid") || null : ctx.identity.uid;
}

/** 解析统计区间，默认最近 7 天 */
function resolveRange(url, tz) {
  const today = util.dayKey(Date.now(), tz);
  let to = url.searchParams.get("to") || today;
  let from = url.searchParams.get("from") || util.addDays(to, -6);
  if (!util.isDayString(from)) from = util.addDays(today, -6);
  if (!util.isDayString(to)) to = today;
  if (from > to) [from, to] = [to, from];
  // 最多查询一年，避免超长区间拖慢响应
  if (util.dayDiff(from, to) > 366) from = util.addDays(to, -366);
  return { from, to };
}

/* ------------------------------------------------------------------- 基础接口 */

route("GET", "/api/health", async (req, res, ctx) => {
  sendJson(res, 200, {
    ok: true,
    app: config.APP_NAME,
    version: config.APP_VERSION,
    config: {
      oauthConfigured: Boolean(cfg.oauth.clientId && cfg.oauth.clientSecret),
      timezone: cfg.timezone,
      gateway: config.GATEWAY_PREFIX
    },
    runtime: {
      node: process.version,
      pid: process.pid,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      viaGateway: ctx.identity.viaGateway
    },
    data: store.stats()
  });
});

route("GET", "/api/me", async (req, res, ctx) => {
  sendJson(res, 200, {
    ok: true,
    identity: {
      uid: ctx.user.uid,
      fnosUsername: ctx.user.fnosUsername || ctx.identity.username,
      isAdmin: ctx.isAdmin,
      viaGateway: ctx.identity.viaGateway
    },
    github: ctx.user.github || null,
    linked: Boolean(ctx.user.github),
    authMethod: ctx.user.authMethod || "",
    lastLoginAt: ctx.user.lastLoginAt || 0,
    loginCount: ctx.user.loginCount || 0,
    syncStatus: store.getSyncStatus(ctx.identity.uid),
    system: config.publicConfig(cfg)
  });
});

/* ------------------------------------------------------------------ GitHub 登录 */

route("GET", "/api/auth/github/start", async (req, res, ctx) => {
  if (!cfg.oauth.clientId || !cfg.oauth.clientSecret) {
    sendError(res, 400, "尚未配置 GitHub OAuth 凭据，请先在「设置」中填写 Client ID 与 Client Secret", "oauth_not_configured");
    return;
  }
  const state = auth.createState(ctx.identity.uid);
  const redirectUri = auth.buildRedirectUri(req, cfg);
  const target = github.buildAuthorizeUrl({
    clientId: cfg.oauth.clientId,
    redirectUri,
    scope: auth.buildScope(cfg),
    state
  });
  res.writeHead(302, { Location: target, "Cache-Control": "no-store" });
  res.end();
});

route("GET", "/api/auth/github/callback", async (req, res, ctx) => {
  const base = config.GATEWAY_PREFIX;
  const code = ctx.url.searchParams.get("code") || "";
  const state = ctx.url.searchParams.get("state") || "";
  const error = ctx.url.searchParams.get("error") || "";

  const redirectBack = (query) => {
    res.writeHead(302, { Location: `${base}/?${query}`, "Cache-Control": "no-store" });
    res.end();
  };

  if (error) return redirectBack(`login=error&reason=${encodeURIComponent(error)}`);
  if (!code) return redirectBack("login=error&reason=" + encodeURIComponent("缺少授权码"));

  const stateItem = auth.consumeState(state);
  if (!stateItem) return redirectBack("login=error&reason=" + encodeURIComponent("授权状态已失效，请重试"));
  if (stateItem.uid !== String(ctx.identity.uid)) {
    return redirectBack("login=error&reason=" + encodeURIComponent("授权会话与当前用户不匹配"));
  }

  const redirectUri = auth.buildRedirectUri(req, cfg);
  const exchanged = await github.exchangeCode({
    clientId: cfg.oauth.clientId,
    clientSecret: cfg.oauth.clientSecret,
    code,
    redirectUri
  });
  if (!exchanged.ok) {
    return redirectBack("login=error&reason=" + encodeURIComponent(exchanged.message || "换取令牌失败"));
  }

  const profile = await github.getUser(exchanged.token, { useCache: false });
  if (!profile.ok) {
    return redirectBack("login=error&reason=" + encodeURIComponent(profile.message || "读取 GitHub 资料失败"));
  }

  const { user, firstLink } = store.linkGithub(ctx.identity.uid, {
    token: exchanged.token,
    profile: profile.data,
    method: "oauth"
  });
  store.recordLogin(user);
  github.invalidate("repos:");
  github.invalidate("visibility:");
  scheduleUserSync(ctx.identity.uid);

  return redirectBack(`${firstLink ? "linked=1" : "relinked=1"}&login=ok`);
});

route("POST", "/api/auth/pat", async (req, res, ctx) => {
  const body = await readJsonBody(req);
  const token = util.safeString(body.token, 512).trim();
  if (!token) return sendError(res, 400, "请填写 GitHub 个人访问令牌");

  const profile = await github.getUser(token, { useCache: false });
  if (!profile.ok) {
    return sendError(res, 401, profile.message || "令牌校验失败，请确认令牌有效且具备 read:user 权限");
  }
  const { user, firstLink } = store.linkGithub(ctx.identity.uid, {
    token,
    profile: profile.data,
    method: "pat"
  });
  store.recordLogin(user);
  github.invalidate("repos:");
  github.invalidate("visibility:");
  scheduleUserSync(ctx.identity.uid);
  sendJson(res, 200, { ok: true, firstLink, github: user.github });
});

route("POST", "/api/auth/logout", async (req, res, ctx) => {
  store.unlinkGithub(ctx.identity.uid);
  sendJson(res, 200, { ok: true });
});

/* ---------------------------------------------------------------- GitHub 代理 */

route("GET", "/api/github/profile", async (req, res, ctx) => {
  if (!requireGithub(ctx, res)) return;
  const result = await github.getUser(ctx.token, { useCache: true });
  if (!result.ok) return sendError(res, result.status || 502, result.message);
  sendJson(res, 200, { ok: true, profile: result.data });
});

route("GET", "/api/github/rate-limit", async (req, res, ctx) => {
  if (!requireGithub(ctx, res)) return;
  const result = await github.getRateLimit(ctx.token);
  if (!result.ok) return sendError(res, result.status || 502, result.message);
  sendJson(res, 200, { ok: true, rateLimit: result.data });
});

route("GET", "/api/github/repos", async (req, res, ctx) => {
  if (!requireGithub(ctx, res)) return;
  const login = ctx.url.searchParams.get("login") || (ctx.user.github ? ctx.user.github.login : "");
  const result = await github.listUserRepos(ctx.token, {
    login,
    page: util.clampInt(ctx.url.searchParams.get("page"), 1, 100, 1),
    perPage: util.clampInt(ctx.url.searchParams.get("perPage"), 1, 100, 30),
    sort: util.safeString(ctx.url.searchParams.get("sort") || "updated", 20),
    q: util.safeString(ctx.url.searchParams.get("q") || "", 80)
  });
  if (!result.ok) return sendError(res, result.status || 502, result.message);
  sendJson(res, 200, {
    ok: true,
    items: result.items,
    total: result.total,
    page: result.page,
    perPage: result.perPage,
    hasMore: result.items.length >= result.perPage
  });
});

route("GET", "/api/github/repos/:owner/:repo", async (req, res, ctx, params) => {
  // 公开仓库无需登录即可查看（发现项目入口）；已登录用户携带 token 以读到私有仓库
  const token = ctx.token || "";
  const [repoRes, langRes] = await Promise.all([
    github.getRepo(token, params.owner, params.repo),
    github.getLanguages(token, params.owner, params.repo)
  ]);
  if (!repoRes.ok) return sendError(res, repoRes.status || 502, repoRes.message);
  sendJson(res, 200, {
    ok: true,
    repo: repoRes.data,
    languages: langRes.ok ? langRes.data : {}
  });
});

route("GET", "/api/github/repos/:owner/:repo/readme", async (req, res, ctx, params) => {
  const result = await github.getReadme(ctx.token || "", params.owner, params.repo);
  if (!result.ok) return sendError(res, result.status || 502, result.message);
  sendJson(res, 200, { ok: true, readme: result.data });
});

route("GET", "/api/github/repos/:owner/:repo/issues", async (req, res, ctx, params) => {
  const result = await github.listIssues(ctx.token || "", params.owner, params.repo, {
    state: ctx.url.searchParams.get("state") === "closed" ? "closed" : "open",
    perPage: util.clampInt(ctx.url.searchParams.get("perPage"), 1, 50, 20)
  });
  if (!result.ok) return sendError(res, result.status || 502, result.message);
  sendJson(res, 200, { ok: true, items: result.data });
});

route("GET", "/api/github/repos/:owner/:repo/commits", async (req, res, ctx, params) => {
  const result = await github.listCommits(ctx.token || "", params.owner, params.repo, {
    perPage: util.clampInt(ctx.url.searchParams.get("perPage"), 1, 50, 20)
  });
  if (!result.ok) return sendError(res, result.status || 502, result.message);
  sendJson(res, 200, { ok: true, items: result.data });
});

route("GET", "/api/github/search", async (req, res, ctx) => {
  // 发现项目：简单的 GitHub 仓库搜索，不要求登录；匿名时受 GitHub 限流（搜索 10 次/分钟）
  const q = util.safeString(ctx.url.searchParams.get("q") || "", 120).trim();
  if (!q) return sendJson(res, 200, { ok: true, items: [], total: 0 });
  const result = await github.searchRepositories(ctx.token || "", {
    q,
    page: util.clampInt(ctx.url.searchParams.get("page"), 1, 50, 1),
    perPage: util.clampInt(ctx.url.searchParams.get("perPage"), 1, 50, 20),
    sort: util.safeString(ctx.url.searchParams.get("sort") || "best-match", 20)
  });
  if (!result.ok) return sendError(res, result.status || 502, result.message);
  sendJson(res, 200, { ok: true, items: result.items, total: result.total });
});

route("GET", "/api/github/activity", async (req, res, ctx) => {
  if (!requireGithub(ctx, res)) return;
  const login = ctx.url.searchParams.get("login") || (ctx.user.github ? ctx.user.github.login : "");
  if (!login) return sendJson(res, 200, { ok: true, items: [] });
  const result = await github.listEvents(ctx.token, login);
  if (!result.ok) return sendError(res, result.status || 502, result.message);
  sendJson(res, 200, { ok: true, items: result.data });
});

/* ------------------------------------------------------------- 流量同步 */

route("POST", "/api/traffic/sync", async (req, res, ctx) => {
  // 普通用户只能同步自己；管理员可通过 uid=all 同步全部已绑定账号
  const targetUid = ctx.url.searchParams.get("uid");
  let syncing = false;

  if (targetUid === "all") {
    if (!requireAdmin(ctx, res)) return;
    const linked = store.listUsers().filter((u) => u.github);
    if (!linked.length) return sendError(res, 428, "还没有任何用户绑定 GitHub 账号", "github_not_linked");
    linked.forEach((u, i) => {
      if (!store.isSyncing(u.uid)) {
        traffic.syncUser(store, u.uid).catch((e) => {
          console.error(`[gstats] traffic sync for ${u.uid} failed:`, e.message);
          store.setSyncStatus(u.uid, { status: "failed", finishedAt: Date.now(), message: e.message });
          store.persistTraffic();
        });
        syncing = true;
      }
    });
  } else {
    const uid = ctx.isAdmin && targetUid ? targetUid : ctx.identity.uid;
    if (!store.getUser(uid) || !store.getUser(uid).github) {
      return sendError(res, 428, "该用户尚未绑定 GitHub 账号", "github_not_linked");
    }
    if (store.isSyncing(uid)) {
      return sendJson(res, 202, { ok: true, alreadyRunning: true, status: store.getSyncStatus(uid) });
    }
    // 后台执行，接口立即返回；前端通过 /api/stats/summary 轮询进度
    traffic.syncUser(store, uid).catch((e) => {
      console.error(`[gstats] traffic sync for ${uid} failed:`, e.message);
      store.setSyncStatus(uid, { status: "failed", finishedAt: Date.now(), message: e.message });
      store.persistTraffic();
    });
    syncing = true;
  }
  sendJson(res, 202, { ok: true, started: syncing, alreadyRunning: !syncing });
});

route("GET", "/api/stats/sync-status", async (req, res, ctx) => {
  const uid = statsUid(ctx, ctx.url);
  sendJson(res, 200, {
    ok: true,
    scope: uid ? "user" : "all",
    items: store.listSyncStatus(uid)
  });
});

/* ---------------------------------------------------------------------- 统计 */

route("GET", "/api/stats/overview", async (req, res, ctx) => {
  const { from, to } = resolveRange(ctx.url, cfg.timezone);
  const uid = statsUid(ctx, ctx.url);
  const data = store.overview(from, to, uid);
  sendJson(res, 200, {
    ok: true,
    range: { from, to, timezone: cfg.timezone },
    scope: uid ? "user" : "all",
    ...data
  });
});

route("GET", "/api/stats/repos", async (req, res, ctx) => {
  const { from, to } = resolveRange(ctx.url, cfg.timezone);
  const uid = statsUid(ctx, ctx.url);
  const items = store.repos(from, to, uid);
  const limit = util.clampInt(ctx.url.searchParams.get("limit"), 1, 500, 100);
  sendJson(res, 200, {
    ok: true,
    range: { from, to, timezone: cfg.timezone },
    total: items.length,
    items: items.slice(0, limit)
  });
});

route("GET", "/api/stats/referrers", async (req, res, ctx) => {
  const uid = statsUid(ctx, ctx.url);
  const data = store.referrers(uid);
  sendJson(res, 200, {
    ok: true,
    window: "近14天（GitHub 仅提供滚动快照）",
    updatedAt: data.updatedAt,
    total: data.rows.length,
    items: data.rows.slice(0, 100)
  });
});

route("GET", "/api/stats/paths", async (req, res, ctx) => {
  const uid = statsUid(ctx, ctx.url);
  const data = store.paths(uid);
  sendJson(res, 200, {
    ok: true,
    window: "近14天（GitHub 仅提供滚动快照）",
    updatedAt: data.updatedAt,
    total: data.rows.length,
    items: data.rows.slice(0, 100)
  });
});

route("GET", "/api/stats/summary", async (req, res, ctx) => {
  const today = util.dayKey(Date.now(), cfg.timezone);
  const uid = statsUid(ctx, ctx.url);
  const todayData = store.overview(today, today, uid);
  const week = store.overview(util.addDays(today, -6), today, uid);
  const linkedUser = uid ? store.getUser(uid) : null;
  sendJson(res, 200, {
    ok: true,
    timezone: cfg.timezone,
    scope: uid ? "user" : "all",
    today: { day: today, ...todayData.totals },
    week: week.totals,
    topReposToday: store.repos(today, today, uid).slice(0, 5),
    linked: uid ? Boolean(linkedUser && linkedUser.github) : store.listUsers().some((u) => u.github),
    hasTraffic: store.hasTraffic(uid),
    sync: uid ? store.getSyncStatus(uid) : null,
    syncItems: store.listSyncStatus(uid),
    stats: store.stats()
  });
});

/* ---------------------------------------------------------------------- 报表 */

route("GET", "/api/export", async (req, res, ctx) => {
  const { from, to } = resolveRange(ctx.url, cfg.timezone);
  const type = report.REPORT_TYPES[ctx.url.searchParams.get("type")] ? ctx.url.searchParams.get("type") : "daily";
  const format = ["csv", "json", "html"].includes(ctx.url.searchParams.get("format"))
    ? ctx.url.searchParams.get("format")
    : "csv";
  const requestedUid = ctx.url.searchParams.get("uid") || null;
  const uid = ctx.isAdmin ? requestedUid : ctx.identity.uid;

  let scopeLabel = "全部用户";
  if (uid) {
    const u = store.getById(uid);
    scopeLabel = u
      ? `用户 ${u.fnosUsername || u.uid}${u.github ? "（@" + u.github.login + "）" : ""}`
      : `用户 ${uid}`;
  }

  const result = report.build({ type, store, from, to, uid, format, scopeLabel });

  let savedTo = null;
  if (cfg.exportToShare && ctx.url.searchParams.get("save") !== "0") {
    savedTo = report.writeToShare(result);
  }

  const disposition = `attachment; filename="${result.filename}"; filename*=UTF-8''${encodeURIComponent(
    result.filename
  )}`;
  const headers = {
    "Content-Disposition": disposition,
    "Cache-Control": "no-store"
  };
  if (savedTo) headers["X-GStats-Saved-To"] = encodeURIComponent(savedTo);
  if (ctx.url.searchParams.get("inline") === "1") delete headers["Content-Disposition"];

  sendBinary(res, 200, result.contentType, Buffer.from(result.content, "utf8"), headers);
});

/* ---------------------------------------------------------------------- 设置 */

route("GET", "/api/config", async (req, res, ctx) => {
  if (!requireAdmin(ctx, res)) return;
  sendJson(res, 200, { ok: true, config: config.publicConfig(cfg), themes: config.THEMES });
});

route("PUT", "/api/config", async (req, res, ctx) => {
  if (!requireAdmin(ctx, res)) return;
  const body = await readJsonBody(req);
  const next = {
    ...cfg,
    oauth: { ...cfg.oauth },
    timezone: cfg.timezone,
    retentionDays: cfg.retentionDays
  };

  if (body.timezone !== undefined) {
    const tz = util.safeString(body.timezone, 60).trim();
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: tz });
      next.timezone = tz;
    } catch (e) {
      return sendError(res, 400, `无效的时区：${tz}`);
    }
  }
  if (body.retentionDays !== undefined) {
    next.retentionDays = util.clampInt(body.retentionDays, 7, 3650, cfg.retentionDays);
  }
  if (body.allowPrivateRepos !== undefined) next.allowPrivateRepos = Boolean(body.allowPrivateRepos);
  if (body.exportToShare !== undefined) next.exportToShare = Boolean(body.exportToShare);
  if (body.githubApiBase !== undefined) {
    const apiBase = util.safeString(body.githubApiBase, 300).trim().replace(/\/+$/, "");
    if (apiBase && !/^https?:\/\//i.test(apiBase)) {
      return sendError(res, 400, "GitHub API 地址需要以 http:// 或 https:// 开头");
    }
    next.githubApiBase = apiBase;
  }
  if (body.defaultTheme !== undefined) {
    const theme = util.safeString(body.defaultTheme, 40);
    if (!config.THEMES.some((t) => t.id === theme) && theme !== "auto") {
      return sendError(res, 400, `未知主题：${theme}`);
    }
    next.defaultTheme = theme;
  }
  if (body.oauth && typeof body.oauth === "object") {
    if (body.oauth.clientId !== undefined) {
      next.oauth.clientId = util.safeString(body.oauth.clientId, 200).trim();
    }
    if (body.oauth.publicBaseUrl !== undefined) {
      const base = util.safeString(body.oauth.publicBaseUrl, 300).trim().replace(/\/+$/, "");
      if (base && !/^https?:\/\//i.test(base)) {
        return sendError(res, 400, "对外访问地址需要以 http:// 或 https:// 开头");
      }
      next.oauth.publicBaseUrl = base;
    }
    // 留空表示保持原密钥不变
    if (body.oauth.clientSecret !== undefined && String(body.oauth.clientSecret).length > 0) {
      next.oauth.clientSecret = util.safeString(body.oauth.clientSecret, 200).trim();
    }
  }

  cfg = config.writeConfig(next);
  store.cfg = cfg;
  sendJson(res, 200, { ok: true, config: config.publicConfig(cfg) });
});

route("GET", "/api/users", async (req, res, ctx) => {
  if (!requireAdmin(ctx, res)) return;
  const users = store.listUsers().map((u) => ({
    uid: u.uid,
    fnosUsername: u.fnosUsername,
    isAdmin: Boolean(u.isAdmin),
    github: u.github
      ? { login: u.github.login, name: u.github.name, avatarUrl: u.github.avatarUrl }
      : null,
    authMethod: u.authMethod || "",
    linkedAt: u.linkedAt || 0,
    lastLoginAt: u.lastLoginAt || 0,
    lastSeenAt: u.lastSeenAt || 0,
    loginCount: u.loginCount || 0
  }));
  sendJson(res, 200, { ok: true, items: users });
});

route("GET", "/api/callback-url", async (req, res, ctx) => {
  sendJson(res, 200, { ok: true, callbackUrl: auth.buildRedirectUri(req, cfg) });
});

/* -------------------------------------------------------------------- 静态资源 */

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  rel = rel.replace(/\\/g, "/");
  if (rel.includes("..")) {
    sendError(res, 400, "非法的资源路径");
    return;
  }
  const target = path.join(config.PUBLIC_DIR, rel);
  if (!target.startsWith(config.PUBLIC_DIR)) {
    sendError(res, 400, "非法的资源路径");
    return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      // 前端为单页应用，未知路径统一回落到 index.html
      const fallback = path.join(config.PUBLIC_DIR, "index.html");
      fs.readFile(fallback, (e2, buf) => {
        if (e2) {
          sendError(res, 404, "页面不存在");
          return;
        }
        sendBinary(res, 200, MIME[".html"], injectPrefix(buf), { "Cache-Control": "no-cache" });
      });
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const isHtml = ext === ".html";
    fs.readFile(target, (e2, buf) => {
      if (e2) {
        sendError(res, 500, "读取资源失败");
        return;
      }
      sendBinary(res, 200, MIME[ext] || "application/octet-stream", isHtml ? injectPrefix(buf) : buf, {
        "Cache-Control": isHtml ? "no-cache" : "public, max-age=300"
      });
    });
  });
}

/**
 * HTML 中统一使用 __GSTATS_PREFIX__ 占位符书写资源路径，
 * 服务端在响应时替换为真实网关前缀，避免缺少结尾斜杠时相对路径解析错误。
 */
function injectPrefix(buf) {
  const text = buf.toString("utf8");
  if (text.indexOf("__GSTATS_PREFIX__") === -1) return buf;
  return Buffer.from(text.split("__GSTATS_PREFIX__").join(config.GATEWAY_PREFIX), "utf8");
}

/* -------------------------------------------------------------------- 主入口 */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  let pathname = url.pathname;

  // 统一网关会带上 /app/gstats 前缀，这里统一剥掉
  if (pathname === config.GATEWAY_PREFIX) pathname = "/";
  else if (pathname.startsWith(config.GATEWAY_PREFIX + "/")) {
    pathname = pathname.slice(config.GATEWAY_PREFIX.length);
  }

  try {
    if (pathname.startsWith("/api/")) {
      const method = req.method === "HEAD" ? "GET" : req.method;
      const matched = matchRoute(method, pathname);
      if (!matched) {
        sendError(res, 404, `接口不存在：${method} ${pathname}`);
        return;
      }
      const identity = auth.resolveIdentity(req);
      const ctx = buildContext(req, url, identity);
      await matched.route.handler(req, res, ctx, matched.params);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendError(res, 405, "不支持的请求方法");
      return;
    }
    serveStatic(req, res, pathname);
  } catch (err) {
    console.error("[gstats] request failed:", req.method, pathname, err);
    if (!res.headersSent) {
      sendError(res, 500, err && err.message ? err.message : "服务器内部错误");
    } else {
      try {
        res.end();
      } catch (e) {
        /* ignore */
      }
    }
  }
});

/* ------------------------------------------------------------------ 定时任务 */

const timers = [];
const TRAFFIC_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 每 6 小时同步一次

// 定时裁剪超过保留期的流量快照
timers.push(
  setInterval(() => {
    try {
      store.purgeExpired();
    } catch (e) {
      console.error("[gstats] purge failed:", e.message);
    }
  }, 60 * 60 * 1000)
);

// GitHub Traffic 每 6 小时全量同步一次
timers.push(
  setInterval(() => {
    traffic.syncAll(store).catch((e) => {
      console.error("[gstats] scheduled traffic sync failed:", e.message);
    });
  }, TRAFFIC_SYNC_INTERVAL_MS)
);

// 启动 45 秒后做一次全量同步（避开开机高峰；未绑定账号会自动跳过）
setTimeout(() => {
  traffic.syncAll(store).catch((e) => {
    console.error("[gstats] startup traffic sync failed:", e.message);
  });
}, 45 * 1000).unref();

/* ------------------------------------------------------------------- 启动 */

function shutdown(signal) {
  console.log(`[gstats] received ${signal}, shutting down ...`);
  for (const t of timers) clearInterval(t);
  try {
    store.persistTraffic();
  } catch (e) {
    console.error("[gstats] persist traffic failed:", e.message);
  }
  try {
    server.close();
  } catch (e) {
    /* ignore */
  }
  setTimeout(() => {
    try {
      fs.rmSync(config.SOCKET_PATH, { force: true });
    } catch (e) {
      /* ignore */
    }
    process.exit(0);
  }, 300).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  console.error("[gstats] uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[gstats] unhandled rejection:", err);
});

function listen() {
  const onListening = () => {
    if (config.HTTP_PORT) {
      console.log(`[gstats] listening on http://127.0.0.1:${config.HTTP_PORT} (dev mode)`);
    } else {
      console.log(`[gstats] listening on unix socket ${config.SOCKET_PATH}`);
    }
    console.log(`[gstats] gateway prefix: ${config.GATEWAY_PREFIX}`);
    console.log(`[gstats] data dir: ${config.DATA_DIR}`);
    console.log(`[gstats] public dir: ${config.PUBLIC_DIR}`);
    console.log(`[gstats] timezone: ${cfg.timezone}, retention: ${cfg.retentionDays}d`);
  };

  if (config.HTTP_PORT) {
    server.listen(config.HTTP_PORT, "127.0.0.1", onListening);
    return;
  }

  try {
    fs.rmSync(config.SOCKET_PATH, { force: true });
  } catch (e) {
    /* ignore */
  }
  server.listen(config.SOCKET_PATH, onListening);
}

server.on("error", (err) => {
  console.error("[gstats] server error:", err);
  process.exit(1);
});

listen();
