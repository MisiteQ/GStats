"use strict";

/**
 * 数据层：用户、GitHub 绑定关系、GitHub 仓库流量快照与聚合查询。
 *
 * 数据来源是 GitHub 官方 Repo Traffic API（外部访客数据），本系统不做任何
 * 「谁在应用内看了什么」的埋点。同步任务定期抓取快照并落盘，从而积累
 * GitHub 只保留 14 天以外的长期历史。
 *
 * 存储完全基于文件（无数据库依赖）：
 *   data/users.json    用户与 GitHub 绑定关系（token 为 AES-256-GCM 密文）
 *   data/traffic.json  每日流量快照、来源/热门路径快照、同步状态
 */

const fs = require("fs");
const path = require("path");
const util = require("./util");
const config = require("./config");

const KIND_VIEW = "view";
const KIND_CLONE = "clone";

function repoOwner(repoFull) {
  const i = String(repoFull || "").indexOf("/");
  return i > 0 ? repoFull.slice(0, i) : "";
}

class Store {
  constructor(cfg) {
    this.cfg = cfg;
    this.dataDir = config.DATA_DIR;
    this.users = new Map();

    // 每日流量：key = uid\0repo\0kind\0day -> { uid, repo, kind, day, count, uniques, updatedAt }
    this.trafficDaily = new Map();
    // 来源/热门路径（GitHub 只提供近 14 天滚动数据）：key = uid\0repo -> snapshot
    this.trafficRefs = new Map();
    // 每个用户的同步状态：uid -> { status, startedAt, finishedAt, ... }
    this.syncStatus = new Map();

    this.startedAt = Date.now();
  }

  /* ------------------------------------------------------------------ paths */

  get usersFile() {
    return path.join(this.dataDir, "users.json");
  }

  get trafficFile() {
    return path.join(this.dataDir, "traffic.json");
  }

  get tz() {
    return this.cfg.timezone || "Asia/Shanghai";
  }

  /* ------------------------------------------------------------------- init */

  init() {
    config.ensureDir(this.dataDir);
    this.loadUsers();
    this.loadTraffic();
    this.purgeExpired();
  }

  loadUsers() {
    try {
      const raw = fs.existsSync(this.usersFile) ? fs.readFileSync(this.usersFile, "utf8") : "";
      const parsed = util.safeJsonParse(raw, {}) || {};
      for (const [uid, u] of Object.entries(parsed)) {
        this.users.set(String(uid), { uid: String(uid), ...u });
      }
    } catch (e) {
      console.error("[store] loadUsers failed:", e.message);
    }
  }

  saveUsers() {
    const obj = {};
    for (const [uid, u] of this.users.entries()) obj[uid] = u;
    this.writeJsonAtomic(this.usersFile, obj, 0o600);
  }

  writeJsonAtomic(file, value, mode) {
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: mode || 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error("[store] write failed:", file, e.message);
    }
  }

  /* ------------------------------------------------------------- traffic io */

  loadTraffic() {
    try {
      const raw = fs.existsSync(this.trafficFile) ? fs.readFileSync(this.trafficFile, "utf8") : "";
      const parsed = util.safeJsonParse(raw, null);
      if (!parsed) return;

      for (const r of Array.isArray(parsed.daily) ? parsed.daily : []) {
        if (!r || !r.uid || !r.repo || !r.day || ![KIND_VIEW, KIND_CLONE].includes(r.kind)) continue;
        const key = this.dailyKey(r.uid, r.repo, r.kind, r.day);
        this.trafficDaily.set(key, {
          uid: String(r.uid),
          repo: String(r.repo),
          kind: r.kind,
          day: r.day,
          count: Number(r.count) || 0,
          uniques: Number(r.uniques) || 0,
          updatedAt: Number(r.updatedAt) || 0
        });
      }

      for (const r of Array.isArray(parsed.refs) ? parsed.refs : []) {
        if (!r || !r.uid || !r.repo) continue;
        this.trafficRefs.set(this.refsKey(r.uid, r.repo), {
          uid: String(r.uid),
          repo: String(r.repo),
          updatedAt: Number(r.updatedAt) || 0,
          referrers: Array.isArray(r.referrers) ? r.referrers : [],
          paths: Array.isArray(r.paths) ? r.paths : []
        });
      }

      const sync = parsed.sync && typeof parsed.sync === "object" ? parsed.sync : {};
      for (const [uid, s] of Object.entries(sync)) {
        if (s && typeof s === "object") {
          // 进程重启时把残留的 syncing 状态复位为失败
          this.syncStatus.set(String(uid), { ...s, status: s.status === "syncing" ? "failed" : s.status });
        }
      }
    } catch (e) {
      console.error("[store] loadTraffic failed:", e.message);
    }
  }

  persistTraffic() {
    const payload = {
      version: 1,
      savedAt: Date.now(),
      daily: Array.from(this.trafficDaily.values()),
      refs: Array.from(this.trafficRefs.values()),
      sync: Object.fromEntries(this.syncStatus.entries())
    };
    this.writeJsonAtomic(this.trafficFile, payload, 0o600);
  }

  dailyKey(uid, repo, kind, day) {
    return `${uid}\u0000${repo}\u0000${kind}\u0000${day}`;
  }

  refsKey(uid, repo) {
    return `${uid}\u0000${repo}`;
  }

  /* ---------------------------------------------------------- traffic writes */

  /** 写入/更新某仓库某天的流量数据（GitHub 会回填，取最新快照覆盖） */
  upsertTrafficDay(uid, repo, kind, day, count, uniques, updatedAt) {
    if (![KIND_VIEW, KIND_CLONE].includes(kind)) return;
    if (!util.isDayString(day)) return;
    const key = this.dailyKey(uid, repo, kind, day);
    const prev = this.trafficDaily.get(key);
    const next = {
      uid: String(uid),
      repo: String(repo),
      kind,
      day,
      count: Number(count) || 0,
      uniques: Number(uniques) || 0,
      updatedAt: Number(updatedAt) || Date.now()
    };
    if (!prev || next.updatedAt >= prev.updatedAt || next.count >= prev.count) {
      this.trafficDaily.set(key, next);
    }
  }

  /** 覆盖某仓库的来源网站 / 热门路径快照 */
  replaceTrafficRefs(uid, repo, referrers, paths, updatedAt) {
    const cleanReferrers = (Array.isArray(referrers) ? referrers : [])
      .filter((r) => r && r.referrer)
      .slice(0, 30)
      .map((r) => ({
        referrer: util.safeString(r.referrer, 100),
        count: Number(r.count) || 0,
        uniques: Number(r.uniques) || 0
      }));
    const cleanPaths = (Array.isArray(paths) ? paths : [])
      .filter((p) => p && p.path)
      .slice(0, 30)
      .map((p) => ({
        path: util.safeString(p.path, 300),
        title: util.safeString(p.title || p.path, 200),
        count: Number(p.count) || 0,
        uniques: Number(p.uniques) || 0
      }));
    this.trafficRefs.set(this.refsKey(uid, repo), {
      uid: String(uid),
      repo: String(repo),
      updatedAt: Number(updatedAt) || Date.now(),
      referrers: cleanReferrers,
      paths: cleanPaths
    });
  }

  setSyncStatus(uid, patch) {
    const key = String(uid);
    const prev = this.syncStatus.get(key) || {};
    this.syncStatus.set(key, { ...prev, ...patch, uid: key });
  }

  getSyncStatus(uid) {
    return this.syncStatus.get(String(uid)) || null;
  }

  listSyncStatus(uid) {
    if (uid) return this.syncStatus.get(String(uid)) ? [this.syncStatus.get(String(uid))] : [];
    return Array.from(this.syncStatus.values());
  }

  isSyncing(uid) {
    const s = this.syncStatus.get(String(uid));
    return Boolean(s && s.status === "syncing");
  }

  purgeExpired() {
    const cutoffDay = util.addDays(util.dayKey(Date.now(), this.tz), -this.cfg.retentionDays);
    let changed = false;
    for (const [key, r] of Array.from(this.trafficDaily.entries())) {
      if (r.day < cutoffDay) {
        this.trafficDaily.delete(key);
        changed = true;
      }
    }
    if (changed) this.persistTraffic();
  }

  /* ------------------------------------------------------------------- users */

  getUser(uid) {
    return this.users.get(String(uid)) || null;
  }

  listUsers() {
    return Array.from(this.users.values()).sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  }

  touchUser(uid, info = {}) {
    const key = String(uid);
    const now = Date.now();
    let user = this.users.get(key);
    let dirty = false;

    if (!user) {
      user = {
        uid: key,
        fnosUsername: info.fnosUsername || "",
        isAdmin: Boolean(info.isAdmin),
        github: null,
        token: "",
        authMethod: "",
        linkedAt: 0,
        lastLoginAt: 0,
        lastSeenAt: now,
        loginCount: 0
      };
      dirty = true;
    } else {
      if (info.fnosUsername && info.fnosUsername !== user.fnosUsername) {
        user.fnosUsername = info.fnosUsername;
        dirty = true;
      }
      if (info.isAdmin !== undefined && Boolean(info.isAdmin) !== Boolean(user.isAdmin)) {
        user.isAdmin = Boolean(info.isAdmin);
        dirty = true;
      }
      // lastSeenAt 变化频繁，最多每分钟落盘一次，避免每个请求都写磁盘
      if (now - (user.lastSeenAt || 0) > 60000) {
        user.lastSeenAt = now;
        dirty = true;
      }
    }

    this.users.set(key, user);
    if (dirty) this.saveUsers();
    return user;
  }

  linkGithub(uid, { token, profile, method }) {
    const user = this.touchUser(uid);
    const firstLink = !user.github;
    user.github = {
      id: profile.id,
      login: profile.login,
      name: profile.name || profile.login,
      avatarUrl: profile.avatar_url || "",
      htmlUrl: profile.html_url || `https://github.com/${profile.login}`,
      publicRepos: profile.public_repos || 0,
      followers: profile.followers || 0,
      following: profile.following || 0,
      bio: profile.bio || "",
      company: profile.company || "",
      location: profile.location || "",
      createdAt: profile.created_at || ""
    };
    user.token = config.encryptSecret(token);
    user.authMethod = method || "oauth";
    user.linkedAt = user.linkedAt || Date.now();
    this.users.set(String(uid), user);
    this.saveUsers();
    return { user, firstLink };
  }

  unlinkGithub(uid) {
    const user = this.users.get(String(uid));
    if (!user) return false;
    user.github = null;
    user.token = "";
    user.authMethod = "";
    this.users.set(String(uid), user);
    this.saveUsers();
    return true;
  }

  getToken(uid) {
    const user = this.users.get(String(uid));
    if (!user || !user.token) return "";
    return config.decryptSecret(user.token);
  }

  getById(uid) {
    return this.users.get(String(uid)) || null;
  }

  /** 登录计数（仅记录账号自身的登录信息，不作为访客统计） */
  recordLogin(user) {
    const now = Date.now();
    user.loginCount = (user.loginCount || 0) + 1;
    user.lastLoginAt = now;
    this.users.set(String(user.uid), user);
    this.saveUsers();
  }

  /* ------------------------------------------------------------------ 查询 */

  matchUid(recordUid, uid) {
    return !uid || String(recordUid) === String(uid);
  }

  /**
   * 总览：按天汇总 GitHub 仓库外部访客流量。
   * views/clones 可直接累加；uniques 是 GitHub 按单仓库、单天去重的值，
   * 跨仓库/跨天只能累加（页面上明确标注为「每日 UV 累计」）。
   */
  overview(from, to, uid) {
    const days = util.dayRange(from, to).map((day) => ({
      day,
      views: 0,
      uniques: 0,
      clones: 0,
      cloneUniques: 0,
      repos: 0
    }));
    const index = new Map(days.map((d) => [d.day, d]));
    const repoSets = new Map();

    for (const r of this.trafficDaily.values()) {
      if (!this.matchUid(r.uid, uid)) continue;
      const row = index.get(r.day);
      if (!row) continue;
      if (r.kind === KIND_VIEW) {
        row.views += r.count;
        row.uniques += r.uniques;
        if (!repoSets.has(r.day)) repoSets.set(r.day, new Set());
        repoSets.get(r.day).add(r.repo);
      } else if (r.kind === KIND_CLONE) {
        row.clones += r.count;
        row.cloneUniques += r.uniques;
      }
    }

    const totals = {
      views: 0,
      uniques: 0,
      avgDailyViews: 0,
      avgDailyUniques: 0,
      clones: 0,
      cloneUniques: 0,
      repos: 0,
      avgViewsPerRepo: 0,
      days: days.length
    };
    const allRepos = new Set();

    for (const row of days) {
      const set = repoSets.get(row.day) || new Set();
      row.repos = set.size;
      totals.views += row.views;
      totals.uniques += row.uniques;
      totals.clones += row.clones;
      totals.cloneUniques += row.cloneUniques;
      for (const repo of set) allRepos.add(repo);
    }

    totals.repos = allRepos.size;
    totals.avgDailyViews = days.length ? Number((totals.views / days.length).toFixed(2)) : 0;
    totals.avgDailyUniques = days.length ? Number((totals.uniques / days.length).toFixed(2)) : 0;
    totals.avgViewsPerRepo = totals.repos ? Math.round(totals.views / totals.repos) : 0;
    return { days, totals };
  }

  /** 仓库维度：每个仓库在区间内的外部访问量 / 克隆量 */
  repos(from, to, uid) {
    const map = new Map();
    for (const r of this.trafficDaily.values()) {
      if (!this.matchUid(r.uid, uid)) continue;
      if (r.day < from || r.day > to) continue;
      let item = map.get(r.repo);
      if (!item) {
        item = {
          repo: r.repo,
          owner: repoOwner(r.repo),
          uid: r.uid,
          views: 0,
          uniques: 0,
          clones: 0,
          cloneUniques: 0,
          days: new Set(),
          firstDay: r.day,
          lastDay: r.day
        };
        map.set(r.repo, item);
      }
      if (r.kind === KIND_VIEW) {
        item.views += r.count;
        item.uniques += r.uniques;
        item.days.add(r.day);
        if (r.day < item.firstDay) item.firstDay = r.day;
        if (r.day > item.lastDay) item.lastDay = r.day;
      } else if (r.kind === KIND_CLONE) {
        item.clones += r.count;
        item.cloneUniques += r.uniques;
      }
    }
    return Array.from(map.values())
      .map((item) => ({
        repo: item.repo,
        owner: item.owner,
        views: item.views,
        uniques: item.uniques,
        clones: item.clones,
        cloneUniques: item.cloneUniques,
        activeDays: item.days.size,
        avgDailyViews: item.days.size ? Number((item.views / item.days.size).toFixed(2)) : 0,
        firstDay: item.firstDay,
        lastDay: item.lastDay
      }))
      .sort((a, b) => b.views - a.views || b.clones - a.clones);
  }

  /** 来源网站：聚合各仓库最新一份近 14 天快照 */
  referrers(uid) {
    const map = new Map();
    let latestUpdatedAt = 0;
    for (const snap of this.trafficRefs.values()) {
      if (!this.matchUid(snap.uid, uid)) continue;
      latestUpdatedAt = Math.max(latestUpdatedAt, snap.updatedAt);
      for (const r of snap.referrers) {
        let item = map.get(r.referrer);
        if (!item) {
          item = { referrer: r.referrer, count: 0, uniques: 0, repos: new Set() };
          map.set(r.referrer, item);
        }
        item.count += r.count;
        item.uniques += r.uniques;
        item.repos.add(snap.repo);
      }
    }
    return {
      updatedAt: latestUpdatedAt,
      rows: Array.from(map.values())
        .map((item) => ({
          referrer: item.referrer,
          count: item.count,
          uniques: item.uniques,
          repoCount: item.repos.size
        }))
        .sort((a, b) => b.count - a.count)
    };
  }

  /** 热门访问路径：聚合各仓库最新一份近 14 天快照 */
  paths(uid) {
    const map = new Map();
    let latestUpdatedAt = 0;
    for (const snap of this.trafficRefs.values()) {
      if (!this.matchUid(snap.uid, uid)) continue;
      latestUpdatedAt = Math.max(latestUpdatedAt, snap.updatedAt);
      for (const p of snap.paths) {
        let item = map.get(p.path);
        if (!item) {
          item = { path: p.path, title: p.title, count: 0, uniques: 0, repos: new Set() };
          map.set(p.path, item);
        }
        item.count += p.count;
        item.uniques += p.uniques;
        item.repos.add(snap.repo);
        if (!item.title && p.title) item.title = p.title;
      }
    }
    return {
      updatedAt: latestUpdatedAt,
      rows: Array.from(map.values())
        .map((item) => ({
          path: item.path,
          title: item.title || item.path,
          count: item.count,
          uniques: item.uniques,
          repoCount: item.repos.size
        }))
        .sort((a, b) => b.count - a.count)
    };
  }

  /** 是否存在任何流量数据（用于空状态引导） */
  hasTraffic(uid) {
    for (const r of this.trafficDaily.values()) {
      if (r.kind === KIND_VIEW && this.matchUid(r.uid, uid)) return true;
    }
    return false;
  }

  stats() {
    const users = Array.from(this.users.values());
    const days = new Set();
    const repos = new Set();
    for (const r of this.trafficDaily.values()) {
      if (r.kind === KIND_VIEW) {
        days.add(r.day);
        repos.add(r.repo);
      }
    }
    let syncing = 0;
    for (const s of this.syncStatus.values()) if (s.status === "syncing") syncing += 1;
    return {
      uptimeMs: Date.now() - this.startedAt,
      recordCount: this.trafficDaily.size,
      dayCount: days.size,
      repoCount: repos.size,
      userCount: users.length,
      linkedCount: users.filter((u) => u.github).length,
      syncingCount: syncing,
      dataDir: this.dataDir
    };
  }
}

module.exports = {
  Store,
  KIND_VIEW,
  KIND_CLONE
};
