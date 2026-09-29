"use strict";

/**
 * GitHub API 客户端。
 * 使用 Node.js 内置 fetch，未引入任何第三方依赖。
 */

const DEFAULT_API_BASE = "https://api.github.com";
const OAUTH_AUTHORIZE = "https://github.com/login/oauth/authorize";
const OAUTH_TOKEN = "https://github.com/login/oauth/access_token";
const USER_AGENT = "GStats-fnOS/1.0";
const TIMEOUT_MS = 20000;

/** GitHub API 地址：支持在配置中改为镜像 / 反代地址（网络受限环境） */
function apiBase() {
  try {
    const cfg = require("./config").readConfig();
    if (cfg && cfg.githubApiBase) return cfg.githubApiBase;
  } catch (e) {
    /* fallthrough */
  }
  return DEFAULT_API_BASE;
}

/** 简单的内存缓存，减少对 GitHub API 的重复请求与限流压力 */
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache.entries()) {
      if (now > v.expiresAt) cache.delete(k);
    }
  }
}

function invalidate(prefix) {
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

async function request(url, { token, method = "GET", body, accept } = {}) {
  const res = await rawRequest(url, { token, method, body, accept });
  // Token 过期/失效时，对非认证类接口自动降级为匿名重试一次
  if (token && res.status === 401 && method === "GET" && !body) {
    return rawRequest(url, { token: "", method, body, accept });
  }
  return res;
}

async function rawRequest(url, { token, method = "GET", body, accept } = {}) {
  const headers = {
    Accept: accept || "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: "manual"
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = text;
      }
    }
    const rateLimit = {
      limit: Number(res.headers.get("x-ratelimit-limit") || 0),
      remaining: Number(res.headers.get("x-ratelimit-remaining") || 0),
      reset: Number(res.headers.get("x-ratelimit-reset") || 0)
    };
    return { ok: res.ok, status: res.status, data, rateLimit };
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    return {
      ok: false,
      status: aborted ? 504 : 502,
      data: null,
      message: aborted ? "请求 GitHub 超时，请稍后重试" : `无法连接 GitHub：${err.message}`,
      rateLimit: null
    };
  } finally {
    clearTimeout(timer);
  }
}

function failMessage(result) {
  if (result.message) return result.message;
  const d = result.data;
  if (d && typeof d === "object" && d.message) return d.message;
  if (result.status === 401) return "GitHub 授权已失效，请重新登录";
  if (result.status === 403) return "GitHub 接口访问受限（可能触发限流），请稍后重试";
  if (result.status === 404) return "未找到对应的 GitHub 资源";
  return `GitHub 接口返回 ${result.status}`;
}

/* --------------------------------------------------------------------- OAuth */

function buildAuthorizeUrl({ clientId, redirectUri, scope, state }) {
  const url = new URL(OAUTH_AUTHORIZE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const res = await request(OAUTH_TOKEN, {
    method: "POST",
    accept: "application/json",
    body: {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri
    }
  });
  if (!res.ok || !res.data || !res.data.access_token) {
    return { ok: false, message: (res.data && res.data.error_description) || failMessage(res) };
  }
  return {
    ok: true,
    token: res.data.access_token,
    scope: res.data.scope || "",
    tokenType: res.data.token_type || "bearer"
  };
}

/* ---------------------------------------------------------------------- User */

async function getUser(token, { useCache = false } = {}) {
  const key = `user:${token.slice(-12)}`;
  if (useCache) {
    const cached = cacheGet(key);
    if (cached) return cached;
  }
  const res = await request(`${apiBase()}/user`, { token });
  if (!res.ok) return { ok: false, status: res.status, message: failMessage(res) };
  const out = { ok: true, data: res.data, rateLimit: res.rateLimit };
  cacheSet(key, out, 120000);
  return out;
}

async function getRateLimit(token) {
  const res = await request(`${apiBase()}/rate_limit`, { token });
  if (!res.ok) return { ok: false, status: res.status, message: failMessage(res) };
  return { ok: true, data: res.data };
}

/* ---------------------------------------------------------------------- Repos */

function normalizeRepo(repo) {
  return {
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    owner: repo.owner ? repo.owner.login : "",
    ownerAvatar: repo.owner ? repo.owner.avatar_url : "",
    description: repo.description || "",
    htmlUrl: repo.html_url,
    homepage: repo.homepage || "",
    language: repo.language || "",
    private: Boolean(repo.private),
    fork: Boolean(repo.fork),
    archived: Boolean(repo.archived),
    stars: repo.stargazers_count || 0,
    forks: repo.forks_count || 0,
    watchers: repo.watchers_count || 0,
    openIssues: repo.open_issues_count || 0,
    size: repo.size || 0,
    defaultBranch: repo.default_branch || "main",
    topics: Array.isArray(repo.topics) ? repo.topics : [],
    updatedAt: repo.updated_at || "",
    pushedAt: repo.pushed_at || "",
    createdAt: repo.created_at || ""
  };
}

/** 列出一个用户的仓库（含搜索与排序） */
async function listUserRepos(token, { login, page = 1, perPage = 30, sort = "updated", q = "" }) {
  const needle = String(q || "").trim();
  const cacheKey = `repos:${login}:${page}:${perPage}:${sort}:${needle.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let result;
  if (needle) {
    // 有搜索词时走 search 接口，避免把全部仓库拉下来
    const query = encodeURIComponent(`user:${login} ${needle}`);
    const res = await request(
      `${apiBase()}/search/repositories?q=${query}&per_page=${perPage}&page=${page}&sort=${
        sort === "stars" ? "stars" : "updated"
      }`,
      { token }
    );
    if (!res.ok) return { ok: false, status: res.status, message: failMessage(res) };
    result = {
      ok: true,
      items: (res.data.items || []).map(normalizeRepo),
      total: res.data.total_count || 0,
      page,
      perPage
    };
  } else {
    const vis = await getVisibility(token, login);
    const sortParam = sort === "stars" ? "pushed" : sort === "name" ? "full_name" : "updated";
    const res = await request(
      `${apiBase()}/user/repos?per_page=${perPage}&page=${page}&sort=${sortParam}&direction=desc&affiliation=owner,collaborator,organization_member&visibility=${vis}`,
      { token }
    );
    if (!res.ok) return { ok: false, status: res.status, message: failMessage(res) };
    const items = Array.isArray(res.data) ? res.data.map(normalizeRepo) : [];
    if (sort === "stars") items.sort((a, b) => b.stars - a.stars);
    if (sort === "name") items.sort((a, b) => a.fullName.localeCompare(b.fullName));
    if (sort === "pushed") items.sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt)));
    result = { ok: true, items, total: null, page, perPage, link: res.data && res.data.length };
  }
  cacheSet(cacheKey, result, 180000);
  return result;
}

async function getVisibility(token, login) {
  const key = `visibility:${login}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const res = await request(`${apiBase()}/user`, { token, cache: true });
  const isSelf = res.ok && res.data && res.data.login && res.data.login === login;
  const vis = isSelf ? "all" : "public";
  cacheSet(key, vis, 300000);
  return vis;
}

async function getRepo(token, owner, repo) {
  // 匿名与登录用户的缓存分开，避免 A 用户可见的私有仓库被缓存后泄露给匿名访问
  const key = `repo:${token ? "auth" : "anon"}:${owner}/${repo}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const res = await request(`${apiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    token: token || ""
  });
  if (!res.ok) return { ok: false, status: res.status, message: failMessage(res) };
  const out = { ok: true, data: normalizeRepo(res.data), raw: res.data };
  cacheSet(key, out, 120000);
  return out;
}

async function getReadme(token, owner, repo) {
  const res = await request(
    `${apiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
    { token }
  );
  if (!res.ok) {
    if (res.status === 404) return { ok: true, data: null };
    return { ok: false, status: res.status, message: failMessage(res) };
  }
  const d = res.data || {};
  let content = "";
  if (d.content) {
    try {
      content = Buffer.from(d.content, d.encoding === "base64" ? "base64" : "utf8").toString("utf8");
    } catch (e) {
      content = "";
    }
  }
  return { ok: true, data: { name: d.name || "README.md", content, htmlUrl: d.html_url || "" } };
}

async function getLanguages(token, owner, repo) {
  const res = await request(
    `${apiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/languages`,
    { token }
  );
  if (!res.ok) return { ok: false, status: res.status, message: failMessage(res) };
  return { ok: true, data: res.data || {} };
}

async function listIssues(token, owner, repo, { state = "open", perPage = 20 } = {}) {
  const res = await request(
    `${apiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo
    )}/issues?state=${state}&per_page=${perPage}`,
    { token }
  );
  if (!res.ok) return { ok: false, status: res.status, message: failMessage(res) };
  const items = (Array.isArray(res.data) ? res.data : [])
    .filter((it) => !it.pull_request)
    .map((it) => ({
      number: it.number,
      title: it.title,
      state: it.state,
      user: it.user ? it.user.login : "",
      comments: it.comments || 0,
      createdAt: it.created_at,
      updatedAt: it.updated_at,
      htmlUrl: it.html_url,
      labels: (it.labels || []).map((l) => (typeof l === "string" ? l : l.name))
    }));
  return { ok: true, data: items };
}

async function listCommits(token, owner, repo, { perPage = 20 } = {}) {
  const res = await request(
    `${apiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo
    )}/commits?per_page=${perPage}`,
    { token }
  );
  if (!res.ok) return { ok: false, status: res.status, message: failMessage(res) };
  const items = (Array.isArray(res.data) ? res.data : []).map((c) => ({
    sha: (c.sha || "").slice(0, 7),
    message: ((c.commit && c.commit.message) || "").split("\n")[0].slice(0, 200),
    author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || "",
    date: (c.commit && c.commit.author && c.commit.author.date) || "",
    htmlUrl: c.html_url
  }));
  return { ok: true, data: items };
}

async function searchRepositories(token, { q, page = 1, perPage = 20, sort = "best-match" }) {
  const params = new URLSearchParams({
    q: String(q || "").trim(),
    per_page: String(perPage),
    page: String(page)
  });
  if (sort === "stars") params.set("sort", "stars");
  if (sort === "updated") params.set("sort", "updated");
  const res = await request(`${apiBase()}/search/repositories?${params.toString()}`, { token: token || "" });
  if (!res.ok) {
    // 匿名调用时 GitHub 搜索接口限流为 10 次/分钟，给出可操作的提示
    if (!token && res.status === 403) {
      return {
        ok: false,
        status: 403,
        message: "未登录状态下 GitHub 搜索限流较严格（10 次/分钟），请稍后再试，或在「我的 GitHub」登录后搜索"
      };
    }
    return { ok: false, status: res.status, message: failMessage(res) };
  }
  return {
    ok: true,
    items: (res.data.items || []).map(normalizeRepo),
    total: res.data.total_count || 0
  };
}

async function listEvents(token, login, { perPage = 30 } = {}) {
  const key = `events:${login}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const res = await request(`${apiBase()}/users/${encodeURIComponent(login)}/events/public?per_page=${perPage}`, {
    token
  });
  if (!res.ok) return { ok: false, status: res.status, message: failMessage(res) };
  const items = (Array.isArray(res.data) ? res.data : []).map((e) => ({
    id: e.id,
    type: e.type,
    repo: e.repo ? e.repo.name : "",
    createdAt: e.created_at,
    payload:
      e.type === "PushEvent"
        ? { commits: (e.payload && e.payload.size) || 0 }
        : e.type === "WatchEvent"
        ? { action: e.payload && e.payload.action }
        : {}
  }));
  const out = { ok: true, data: items };
  cacheSet(key, out, 180000);
  return out;
}

/* ------------------------------------------------------------ Traffic API */

/**
 * 列出当前 token 有推送权限的仓库（只有这些仓库能读取 Traffic 数据）。
 * 自动翻页，最多 maxPages 页，避免仓库过多时吃光限流额度。
 */
async function listEditableRepos(token, { perPage = 100, maxPages = 3 } = {}) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await request(
      `${apiBase()}/user/repos?per_page=${perPage}&page=${page}&affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc`,
      { token }
    );
    if (!res.ok) return { ok: false, status: res.status, message: failMessage(res) };
    const rows = Array.isArray(res.data) ? res.data : [];
    for (const r of rows) items.push(normalizeRepo(r));
    if (rows.length < perPage) break;
  }
  return { ok: true, items };
}

function trafficResult(res) {
  if (res.ok) return { ok: true, data: res.data, rateLimit: res.rateLimit };
  // 404：对该仓库没有推送权限；403：限流或权限不足，交由调用方决定是否中止
  return { ok: false, status: res.status, message: failMessage(res), rateLimit: res.rateLimit };
}

/** 仓库访问量：近 14 天每日 PV / UV */
async function getTrafficViews(token, owner, repo) {
  const res = await request(
    `${apiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/traffic/views`,
    { token }
  );
  return trafficResult(res);
}

/** 仓库克隆量：近 14 天每日克隆次数 / 克隆者数 */
async function getTrafficClones(token, owner, repo) {
  const res = await request(
    `${apiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/traffic/clones`,
    { token }
  );
  return trafficResult(res);
}

/** 热门来源网站（近 14 天） */
async function getTrafficReferrers(token, owner, repo) {
  const res = await request(
    `${apiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/traffic/popular/referrers`,
    { token }
  );
  return trafficResult(res);
}

/** 热门访问路径（近 14 天） */
async function getTrafficPaths(token, owner, repo) {
  const res = await request(
    `${apiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/traffic/popular/paths`,
    { token }
  );
  return trafficResult(res);
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCode,
  getUser,
  getRateLimit,
  listUserRepos,
  getRepo,
  getReadme,
  getLanguages,
  listIssues,
  listCommits,
  searchRepositories,
  listEvents,
  listEditableRepos,
  getTrafficViews,
  getTrafficClones,
  getTrafficReferrers,
  getTrafficPaths,
  invalidate,
  normalizeRepo,
  failMessage
};
