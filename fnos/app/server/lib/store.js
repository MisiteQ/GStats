"use strict";

/**
 * 数据层：用户、事件、浏览会话与统计聚合。
 *
 * 存储完全基于文件（无数据库依赖）：
 *   data/users.json          用户与 GitHub 绑定关系（token 为 AES-256-GCM 密文）
 *   data/events.ndjson       已完成的埋点事件，追加写入，按保留期裁剪
 *   data/open-sessions.json  进行中的浏览会话，用于进程异常退出后恢复
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const util = require("./util");
const config = require("./config");

const EVENT_LOGIN = "login";
const EVENT_APP_OPEN = "app_open";
const EVENT_VIEW = "view";

const MAX_EVENTS_IN_MEMORY = 500000;
const OPEN_SESSION_IDLE_MS = 180000; // 3 分钟无心跳则自动结算
const APP_OPEN_DEDUPE_MS = 30 * 60 * 1000;

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
}

function setToArray(set) {
  return Array.from(set || []);
}

class Store {
  constructor(cfg) {
    this.cfg = cfg;
    this.dataDir = config.DATA_DIR;
    this.users = new Map();
    this.events = [];
    this.byDay = new Map();
    this.openViews = new Map();
    this.recentAppOpen = new Map(); // uid -> ts
    this.dirtyOpen = false;
    this.prunedSinceCompact = 0;
    this.startedAt = Date.now();
  }

  /* ------------------------------------------------------------------ paths */

  get eventsFile() {
    return path.join(this.dataDir, "events.ndjson");
  }

  get usersFile() {
    return path.join(this.dataDir, "users.json");
  }

  get openFile() {
    return path.join(this.dataDir, "open-sessions.json");
  }

  get tz() {
    return this.cfg.timezone || "Asia/Shanghai";
  }

  /* ------------------------------------------------------------------- init */

  init() {
    config.ensureDir(this.dataDir);
    this.loadUsers();
    this.recoverOpenSessions();
    this.loadEvents();
    this.compactEvents();
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

  recoverOpenSessions() {
    try {
      const raw = fs.existsSync(this.openFile) ? fs.readFileSync(this.openFile, "utf8") : "";
      const list = util.safeJsonParse(raw, []) || [];
      for (const s of list) {
        if (!s || !s.id) continue;
        // 进程退出前没有正常 end 的会话，按最后一次心跳结算
        const seconds = Math.max(0, Math.round(s.seconds || 0));
        if (seconds > 0) {
          this.pushEvent(this.buildViewEvent(s, seconds, s.lastHeartbeat || s.startedAt || Date.now()));
        }
      }
      if (list.length) this.compactEvents();
    } catch (e) {
      console.error("[store] recoverOpenSessions failed:", e.message);
    }
    try {
      fs.rmSync(this.openFile, { force: true });
    } catch (e) {
      /* ignore */
    }
  }

  loadEvents() {
    this.events = [];
    this.byDay = new Map();
    if (!fs.existsSync(this.eventsFile)) return;

    let lines = [];
    try {
      lines = fs.readFileSync(this.eventsFile, "utf8").split("\n");
    } catch (e) {
      console.error("[store] loadEvents failed:", e.message);
      return;
    }

    const cutoffDay = util.addDays(util.dayKey(Date.now(), this.tz), -this.cfg.retentionDays);
    let dropped = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const evt = util.safeJsonParse(trimmed, null);
      if (!evt || !evt.day) continue;
      if (evt.day < cutoffDay) {
        dropped += 1;
        continue;
      }
      this.indexEvent(evt);
    }
    if (dropped) this.prunedSinceCompact += dropped;
    if (this.events.length > MAX_EVENTS_IN_MEMORY) {
      const overflow = this.events.length - MAX_EVENTS_IN_MEMORY;
      this.events = this.events.slice(overflow);
      this.prunedSinceCompact += overflow;
      this.rebuildIndex();
      console.warn(`[store] events exceed ${MAX_EVENTS_IN_MEMORY}, dropped ${overflow} oldest`);
    }
  }

  rebuildIndex() {
    this.byDay = new Map();
    for (const evt of this.events) this.indexEvent(evt, true);
    this.events.sort((a, b) => a.ts - b.ts);
  }

  indexEvent(evt, skipPush) {
    if (!skipPush) this.events.push(evt);
    let bucket = this.byDay.get(evt.day);
    if (!bucket) {
      bucket = [];
      this.byDay.set(evt.day, bucket);
    }
    bucket.push(evt);
  }

  /* ------------------------------------------------------------------ events */

  appendLine(evt) {
    try {
      fs.appendFileSync(this.eventsFile, JSON.stringify(evt) + "\n", { mode: 0o600 });
    } catch (e) {
      console.error("[store] append event failed:", e.message);
    }
  }

  pushEvent(evt) {
    this.indexEvent(evt);
    this.appendLine(evt);
    return evt;
  }

  /** 定时压缩日志：把已裁剪的内容从文件中真正移除 */
  compactEvents() {
    if (this.prunedSinceCompact <= 0) return;
    try {
      const cutoffDay = util.addDays(util.dayKey(Date.now(), this.tz), -this.cfg.retentionDays);
      const kept = this.events.filter((e) => e.day >= cutoffDay);
      this.events = kept;
      this.rebuildIndex();
      const tmp = `${this.eventsFile}.tmp`;
      const body = kept.map((e) => JSON.stringify(e)).join("\n");
      fs.writeFileSync(tmp, body ? body + "\n" : "", { mode: 0o600 });
      fs.renameSync(tmp, this.eventsFile);
      this.prunedSinceCompact = 0;
    } catch (e) {
      console.error("[store] compact failed:", e.message);
    }
  }

  purgeExpired() {
    const cutoffDay = util.addDays(util.dayKey(Date.now(), this.tz), -this.cfg.retentionDays);
    const before = this.events.length;
    this.events = this.events.filter((e) => e.day >= cutoffDay);
    if (this.events.length !== before) {
      this.prunedSinceCompact += before - this.events.length;
      this.rebuildIndex();
      this.compactEvents();
    }
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

  /* ------------------------------------------------------------------ 埋点 */

  recordLogin(user, agent) {
    const now = Date.now();
    user.loginCount = (user.loginCount || 0) + 1;
    user.lastLoginAt = now;
    this.users.set(String(user.uid), user);
    this.saveUsers();
    return this.pushEvent({
      id: newId("evt"),
      ts: now,
      day: util.dayKey(now, this.tz),
      type: EVENT_LOGIN,
      uid: user.uid,
      fnosUser: user.fnosUsername || "",
      githubLogin: user.github ? user.github.login : "",
      agent: util.safeString(agent, 200)
    });
  }

  /** 打开应用（30 分钟内重复打开只记一次） */
  recordAppOpen(user, agent) {
    const now = Date.now();
    const key = String(user.uid);
    const last = this.recentAppOpen.get(key) || 0;
    if (now - last < APP_OPEN_DEDUPE_MS) return null;
    this.recentAppOpen.set(key, now);
    return this.pushEvent({
      id: newId("evt"),
      ts: now,
      day: util.dayKey(now, this.tz),
      type: EVENT_APP_OPEN,
      uid: user.uid,
      fnosUser: user.fnosUsername || "",
      githubLogin: user.github ? user.github.login : "",
      agent: util.safeString(agent, 200)
    });
  }

  /* -------------------------------------------------------------- 浏览会话 */

  startView({ user, kind, target, title, url, agent }) {
    const now = Date.now();
    const id = newId("view");
    const session = {
      id,
      uid: String(user.uid),
      fnosUser: user.fnosUsername || "",
      githubLogin: user.github ? user.github.login : "",
      kind: util.safeString(kind, 32) || "page",
      target: util.safeString(target, 200) || "unknown",
      title: util.safeString(title, 200),
      url: util.safeString(url, 500),
      startedAt: now,
      lastHeartbeat: now,
      seconds: 0,
      agent: util.safeString(agent, 200)
    };
    this.openViews.set(id, session);
    this.dirtyOpen = true;
    this.persistOpenSessions();
    return session;
  }

  heartbeat(viewId, extra) {
    const session = this.openViews.get(String(viewId));
    if (!session) return null;
    const now = Date.now();
    // 单次心跳最多累计 120 秒，避免挂起页面把时长算高
    const delta = Math.min(Math.max(0, Math.round((now - session.lastHeartbeat) / 1000)), 120);
    session.seconds = Math.min(this.cfg.maxViewSeconds, session.seconds + delta);
    session.lastHeartbeat = now;
    if (extra && extra.title) session.title = util.safeString(extra.title, 200);
    if (extra && extra.target) session.target = util.safeString(extra.target, 200);
    this.dirtyOpen = true;
    return session;
  }

  buildViewEvent(session, seconds, endedAt) {
    const ts = session.startedAt || endedAt;
    return {
      id: newId("evt"),
      ts,
      day: util.dayKey(ts, this.tz),
      type: EVENT_VIEW,
      uid: session.uid,
      fnosUser: session.fnosUser || "",
      githubLogin: session.githubLogin || "",
      kind: session.kind || "page",
      target: session.target || "unknown",
      title: session.title || session.target || "",
      url: session.url || "",
      seconds: Math.round(seconds || 0),
      startedAt: session.startedAt,
      endedAt,
      agent: session.agent || ""
    };
  }

  endView(viewId) {
    const key = String(viewId);
    const session = this.openViews.get(key);
    if (!session) return null;
    this.openViews.delete(key);
    this.dirtyOpen = true;
    // 结算时把最后一次心跳到现在的空档也算进去（上限 120 秒）
    const now = Date.now();
    const tail = Math.min(Math.max(0, Math.round((now - session.lastHeartbeat) / 1000)), 120);
    const seconds = Math.min(this.cfg.maxViewSeconds, session.seconds + tail);
    let evt = null;
    if (seconds >= 1) {
      evt = this.pushEvent(this.buildViewEvent(session, seconds, now));
    }
    this.persistOpenSessions();
    return evt;
  }

  sweepIdle() {
    const now = Date.now();
    let changed = false;
    for (const [id, session] of Array.from(this.openViews.entries())) {
      if (now - session.lastHeartbeat > OPEN_SESSION_IDLE_MS) {
        this.endView(id);
        changed = true;
      }
    }
    if (changed) this.persistOpenSessions();
    return changed;
  }

  finalizeAll() {
    for (const id of Array.from(this.openViews.keys())) this.endView(id);
    this.persistOpenSessions();
  }

  persistOpenSessions() {
    if (!this.dirtyOpen) return;
    this.dirtyOpen = false;
    const list = Array.from(this.openViews.values());
    this.writeJsonAtomic(this.openFile, list, 0o600);
  }

  /* ------------------------------------------------------------------ 查询 */

  /** 把进行中的会话折算成临时事件，保证「今日」数据实时 */
  effectiveEvents(from, to, uid) {
    const list = [];
    for (const evt of this.events) {
      if (evt.day < from || evt.day > to) continue;
      if (uid && String(evt.uid) !== String(uid)) continue;
      list.push(evt);
    }
    const now = Date.now();
    for (const session of this.openViews.values()) {
      if (uid && String(session.uid) !== String(uid)) continue;
      const day = util.dayKey(session.startedAt, this.tz);
      if (day < from || day > to) continue;
      const extra = Math.min(Math.max(0, Math.round((now - session.lastHeartbeat) / 1000)), 120);
      list.push(
        this.buildViewEvent(session, Math.min(this.cfg.maxViewSeconds, session.seconds + extra), now)
      );
    }
    return list;
  }

  /**
   * 总览：按天的登录人数、活跃人数、浏览次数、浏览时长。
   *
   * 口径说明：
   *   登录用户   —— 当日打开过 GStats（含完成 GitHub 授权）的去重用户数
   *   活跃用户   —— 当日在 GStats 内真正浏览过至少一个项目的去重用户数
   *   授权登录次数 —— 完成 GitHub 账号授权的次数
   */
  overview(from, to, uid) {
    const days = util.dayRange(from, to).map((day) => ({
      day,
      loginUsers: 0,
      activeUsers: 0,
      authLogins: 0,
      logins: 0,
      appOpens: 0,
      views: 0,
      seconds: 0,
      projects: 0
    }));
    const index = new Map(days.map((d) => [d.day, d]));
    const loginSets = new Map();
    const activeSets = new Map();
    const projectSets = new Map();

    for (const evt of this.effectiveEvents(from, to, uid)) {
      const row = index.get(evt.day);
      if (!row) continue;
      const uidKey = String(evt.uid);

      if (evt.type === EVENT_LOGIN) {
        row.authLogins += 1;
        row.logins += 1;
        if (!loginSets.has(evt.day)) loginSets.set(evt.day, new Set());
        loginSets.get(evt.day).add(uidKey);
      } else if (evt.type === EVENT_APP_OPEN) {
        row.appOpens += 1;
        if (!loginSets.has(evt.day)) loginSets.set(evt.day, new Set());
        loginSets.get(evt.day).add(uidKey);
      } else if (evt.type === EVENT_VIEW) {
        row.views += 1;
        row.seconds += Math.round(evt.seconds || 0);
        if (!activeSets.has(evt.day)) activeSets.set(evt.day, new Set());
        activeSets.get(evt.day).add(uidKey);
        if (!projectSets.has(evt.day)) projectSets.set(evt.day, new Set());
        projectSets.get(evt.day).add(evt.target);
      }
    }

    const totals = {
      loginUsers: 0,
      activeUsers: 0,
      avgDailyLoginUsers: 0,
      authLogins: 0,
      logins: 0,
      appOpens: 0,
      views: 0,
      seconds: 0,
      projects: 0,
      avgSecondsPerView: 0,
      days: days.length
    };
    const allLoginUsers = new Set();
    const allActiveUsers = new Set();
    const allProjects = new Set();
    let loginDaySum = 0;

    for (const row of days) {
      const loginSet = loginSets.get(row.day) || new Set();
      const activeSet = activeSets.get(row.day) || new Set();
      row.loginUsers = loginSet.size;
      row.activeUsers = activeSet.size;
      row.projects = (projectSets.get(row.day) || new Set()).size;

      loginDaySum += row.loginUsers;
      for (const u of loginSet) allLoginUsers.add(u);
      for (const u of activeSet) allActiveUsers.add(u);
      for (const p of projectSets.get(row.day) || []) allProjects.add(p);

      totals.logins += row.logins;
      totals.authLogins += row.authLogins;
      totals.appOpens += row.appOpens;
      totals.views += row.views;
      totals.seconds += row.seconds;
    }

    totals.seconds = Math.round(totals.seconds);
    totals.loginUsers = allLoginUsers.size;
    totals.activeUsers = allActiveUsers.size;
    totals.projects = allProjects.size;
    totals.avgDailyLoginUsers = days.length ? Number((loginDaySum / days.length).toFixed(2)) : 0;
    totals.avgSecondsPerView = totals.views ? Math.round(totals.seconds / totals.views) : 0;
    totals.avgSecondsPerDay = days.length ? Math.round(totals.seconds / days.length) : 0;
    return { days, totals };
  }

  /** 项目维度：哪些项目被看、被谁看、看了多久 */
  projects(from, to, uid) {
    const map = new Map();
    for (const evt of this.effectiveEvents(from, to, uid)) {
      if (evt.type !== EVENT_VIEW) continue;
      const key = evt.target || "unknown";
      let item = map.get(key);
      if (!item) {
        item = {
          target: key,
          kind: evt.kind || "repo",
          title: evt.title || key,
          users: new Set(),
          userList: new Set(),
          views: 0,
          seconds: 0,
          firstAt: evt.ts,
          lastAt: evt.ts
        };
        map.set(key, item);
      }
      item.users.add(String(evt.uid));
      if (evt.githubLogin) item.userList.add(evt.githubLogin);
      item.views += 1;
      item.seconds += Math.round(evt.seconds || 0);
      if (evt.ts < item.firstAt) item.firstAt = evt.ts;
      if (evt.ts > item.lastAt) {
        item.lastAt = evt.ts;
        if (evt.title) item.title = evt.title;
      }
    }
    return Array.from(map.values())
      .map((item) => ({
        target: item.target,
        kind: item.kind,
        title: item.title,
        users: item.users.size,
        userList: setToArray(item.userList),
        views: item.views,
        seconds: Math.round(item.seconds),
        avgSeconds: item.views ? Math.round(item.seconds / item.views) : 0,
        firstAt: item.firstAt,
        lastAt: item.lastAt
      }))
      .sort((a, b) => b.seconds - a.seconds || b.views - a.views);
  }

  /** 用户维度明细 */
  users(from, to) {
    const map = new Map();
    for (const evt of this.effectiveEvents(from, to, null)) {
      const key = String(evt.uid);
      let item = map.get(key);
      if (!item) {
        const known = this.users.get(key);
        item = {
          uid: key,
          fnosUser: evt.fnosUser || (known ? known.fnosUsername : ""),
          githubLogin:
            evt.githubLogin || (known && known.github ? known.github.login : ""),
          avatarUrl: known && known.github ? known.github.avatarUrl : "",
          days: new Set(),
          logins: 0,
          appOpens: 0,
          views: 0,
          seconds: 0,
          projects: new Set(),
          firstAt: evt.ts,
          lastAt: evt.ts
        };
        map.set(key, item);
      }
      item.days.add(evt.day);
      if (evt.type === EVENT_LOGIN) item.logins += 1;
      if (evt.type === EVENT_APP_OPEN) item.appOpens += 1;
      if (evt.type === EVENT_VIEW) {
        item.views += 1;
        item.seconds += Math.round(evt.seconds || 0);
        item.projects.add(evt.target);
      }
      if (evt.ts < item.firstAt) item.firstAt = evt.ts;
      if (evt.ts > item.lastAt) item.lastAt = evt.ts;
    }
    return Array.from(map.values())
      .map((item) => ({
        uid: item.uid,
        fnosUser: item.fnosUser,
        githubLogin: item.githubLogin,
        avatarUrl: item.avatarUrl,
        activeDays: item.days.size,
        logins: item.logins,
        appOpens: item.appOpens,
        views: item.views,
        seconds: Math.round(item.seconds),
        projectCount: item.projects.size,
        firstAt: item.firstAt,
        lastAt: item.lastAt
      }))
      .sort((a, b) => b.seconds - a.seconds);
  }

  /** 用户 × 项目交叉明细 */
  userProjects(from, to, uid) {
    const map = new Map();
    for (const evt of this.effectiveEvents(from, to, uid)) {
      if (evt.type !== EVENT_VIEW) continue;
      const key = `${evt.uid}::${evt.target}`;
      let item = map.get(key);
      if (!item) {
        const known = this.users.get(String(evt.uid));
        item = {
          uid: String(evt.uid),
          fnosUser: evt.fnosUser || (known ? known.fnosUsername : ""),
          githubLogin: evt.githubLogin || (known && known.github ? known.github.login : ""),
          target: evt.target,
          kind: evt.kind || "repo",
          title: evt.title || evt.target,
          days: new Set(),
          views: 0,
          seconds: 0,
          lastAt: evt.ts
        };
        map.set(key, item);
      }
      item.days.add(evt.day);
      item.views += 1;
      item.seconds += Math.round(evt.seconds || 0);
      if (evt.ts > item.lastAt) item.lastAt = evt.ts;
    }
    return Array.from(map.values())
      .map((item) => ({
        uid: item.uid,
        fnosUser: item.fnosUser,
        githubLogin: item.githubLogin,
        target: item.target,
        kind: item.kind,
        title: item.title,
        activeDays: item.days.size,
        views: item.views,
        seconds: Math.round(item.seconds),
        avgSeconds: item.views ? Math.round(item.seconds / item.views) : 0,
        lastAt: item.lastAt
      }))
      .sort((a, b) => b.seconds - a.seconds);
  }

  rawEvents(from, to, uid, limit = 1000) {
    const list = this.effectiveEvents(from, to, uid)
      .filter((e) => e.type === EVENT_VIEW)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
    return list;
  }

  stats() {
    const users = Array.from(this.users.values());
    return {
      uptimeMs: Date.now() - this.startedAt,
      eventCount: this.events.length,
      dayCount: this.byDay.size,
      userCount: users.length,
      linkedCount: users.filter((u) => u.github).length,
      openViews: this.openViews.size,
      dataDir: this.dataDir
    };
  }
}

module.exports = {
  Store,
  EVENT_LOGIN,
  EVENT_APP_OPEN,
  EVENT_VIEW
};
