#!/usr/bin/env node
"use strict";

/**
 * 开发用：生成一批演示数据（用户 + 近 30 天的登录与浏览记录），
 * 方便在本地预览看板、报表与各种图表效果。
 *
 * 用法：
 *   node tools/seed-demo.js                 # 写入 fnos/app/server/.devdata/var/data
 *   node tools/seed-demo.js <dataDir>       # 指定数据目录
 *
 * 注意：会覆盖目标目录下已有的 users.json 与 events.ndjson。
 */

const fs = require("fs");
const path = require("path");

const targetDir =
  process.argv[2] || path.join(__dirname, "..", "fnos", "app", "server", ".devdata", "var", "data");

const TIMEZONE = "Asia/Shanghai";
const DAYS = 30;

const USERS = [
  {
    uid: "1000",
    fnosUsername: "qixingkun",
    isAdmin: true,
    github: {
      id: 1,
      login: "qixingkun",
      name: "Misite 齊",
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      htmlUrl: "https://github.com/qixingkun",
      publicRepos: 42,
      followers: 128,
      following: 66,
      bio: "自建 NAS 爱好者",
      company: "",
      location: "Shenzhen",
      createdAt: "2019-03-02T00:00:00Z"
    }
  },
  {
    uid: "1001",
    fnosUsername: "zhangwei",
    isAdmin: false,
    github: {
      id: 2,
      login: "octocat",
      name: "Zhang Wei",
      avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4",
      htmlUrl: "https://github.com/octocat",
      publicRepos: 18,
      followers: 45,
      following: 30,
      bio: "",
      company: "",
      location: "Hangzhou",
      createdAt: "2020-06-11T00:00:00Z"
    }
  },
  {
    uid: "1002",
    fnosUsername: "liyan",
    isAdmin: false,
    github: {
      id: 3,
      login: "torvalds",
      name: "Li Yan",
      avatarUrl: "https://avatars.githubusercontent.com/u/3?v=4",
      htmlUrl: "https://github.com/torvalds",
      publicRepos: 7,
      followers: 12,
      following: 24,
      bio: "",
      company: "",
      location: "",
      createdAt: "2021-01-20T00:00:00Z"
    }
  },
  {
    uid: "1003",
    fnosUsername: "wangfang",
    isAdmin: false,
    github: {
      id: 4,
      login: "gaearon",
      name: "Wang Fang",
      avatarUrl: "https://avatars.githubusercontent.com/u/4?v=4",
      htmlUrl: "https://github.com/gaearon",
      publicRepos: 25,
      followers: 88,
      following: 51,
      bio: "",
      company: "",
      location: "Chengdu",
      createdAt: "2018-09-05T00:00:00Z"
    }
  }
];

const REPOS = [
  { target: "microsoft/vscode", kind: "repo", title: "Visual Studio Code", weight: 14 },
  { target: "facebook/react", kind: "repo", title: "The library for web UIs", weight: 11 },
  { target: "torvalds/linux", kind: "repo", title: "Linux kernel source tree", weight: 8 },
  { target: "nodejs/node", kind: "repo", title: "Node.js JavaScript runtime", weight: 9 },
  { target: "golang/go", kind: "repo", title: "The Go programming language", weight: 6 },
  { target: "jellyfin/jellyfin", kind: "repo", title: "The Free Software Media System", weight: 7 },
  { target: "NginxProxyManager/nginx-proxy-manager", kind: "repo", title: "Docker container for Nginx Proxy Manager", weight: 5 },
  { target: "immich-app/immich", kind: "repo", title: "High performance self-hosted photo backup", weight: 6 },
  { target: "home-assistant/core", kind: "repo", title: "Open source home automation", weight: 4 },
  { target: "qdrant/qdrant", kind: "repo", title: "High-performance vector database", weight: 3 },
  { target: "tailscale/tailscale", kind: "repo", title: "The easiest, most secure way to use WireGuard", weight: 5 },
  { target: "@torvalds", kind: "profile", title: "torvalds 的个人主页", weight: 2 }
];

function dayKeyFor(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  return `${m.year}-${m.month}-${m.day}`;
}

/** 用固定种子的伪随机数，保证每次生成的数据一致 */
let seed = 20260923;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function pick(list) {
  const total = list.reduce((s, i) => s + (i.weight || 1), 0);
  let r = rnd() * total;
  for (const item of list) {
    r -= item.weight || 1;
    if (r <= 0) return item;
  }
  return list[list.length - 1];
}
function randInt(min, max) {
  return Math.floor(rnd() * (max - min + 1)) + min;
}

function newId(prefix, ts) {
  return `${prefix}_${ts.toString(36)}${Math.floor(rnd() * 1e8).toString(36)}`;
}

function main() {
  fs.mkdirSync(targetDir, { recursive: true });

  const now = Date.now();
  const events = [];
  const users = {};
  const recentAppOpen = {};

  for (const u of USERS) {
    users[u.uid] = {
      uid: u.uid,
      fnosUsername: u.fnosUsername,
      isAdmin: u.isAdmin,
      github: u.github,
      token: "",
      authMethod: "oauth",
      linkedAt: now - 40 * 86400000,
      lastLoginAt: 0,
      lastSeenAt: 0,
      loginCount: 0
    };
  }

  // 每位用户每天的使用强度略有差异，让图表更真实
  const activity = { "1000": 0.92, "1001": 0.62, "1002": 0.45, "1003": 0.78 };

  for (let d = DAYS - 1; d >= 0; d--) {
    const dayStart = new Date(now - d * 86400000);
    const dayKey = dayKeyFor(dayStart);
    const isWeekend = [0, 6].includes(new Date(dayKey + "T12:00:00").getDay());

    for (const u of USERS) {
      let chance = activity[u.uid] * (isWeekend ? 0.55 : 1);
      if (d === 0) chance = Math.min(1, chance + 0.1);
      if (rnd() > chance) continue;

      const hour = randInt(9, 22);
      const minute = randInt(0, 59);
      const openTs = Date.parse(`${dayKey}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`);
      if (openTs > now) continue;

      // 登录 / 打开应用
      const isNewLogin = rnd() < 0.28;
      events.push({
        id: newId("evt", openTs),
        ts: openTs,
        day: dayKey,
        type: "app_open",
        uid: u.uid,
        fnosUser: u.fnosUsername,
        githubLogin: u.github.login,
        agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
      });
      if (isNewLogin) {
        users[u.uid].loginCount += 1;
        users[u.uid].lastLoginAt = Math.max(users[u.uid].lastLoginAt, openTs);
        events.push({
          id: newId("evt", openTs + 1000),
          ts: openTs + 1000,
          day: dayKey,
          type: "login",
          uid: u.uid,
          fnosUser: u.fnosUsername,
          githubLogin: u.github.login,
          agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
        });
      }
      recentAppOpen[u.uid] = openTs;

      // 浏览若干项目
      const viewCount = randInt(1, 4);
      let cursor = openTs + randInt(30, 200) * 1000;
      for (let v = 0; v < viewCount; v++) {
        const repo = pick(REPOS);
        const seconds = Math.min(3600, Math.max(12, Math.round(90 + rnd() * 900)));
        if (cursor + seconds * 1000 > now) break;
        events.push({
          id: newId("evt", cursor),
          ts: cursor,
          day: dayKey,
          type: "view",
          uid: u.uid,
          fnosUser: u.fnosUsername,
          githubLogin: u.github.login,
          kind: repo.kind,
          target: repo.target,
          title: repo.title,
          url: repo.kind === "repo" ? `https://github.com/${repo.target}` : `https://github.com/${repo.target.slice(1)}`,
          seconds,
          startedAt: cursor,
          endedAt: cursor + seconds * 1000,
          agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
        });
        cursor += seconds * 1000 + randInt(20, 300) * 1000;
      }
    }
  }

  for (const u of USERS) {
    const list = events.filter((e) => e.uid === u.uid);
    if (list.length) {
      users[u.uid].lastSeenAt = Math.max(...list.map((e) => e.ts));
    }
    if (!users[u.uid].lastLoginAt) {
      users[u.uid].lastLoginAt = users[u.uid].linkedAt;
    }
  }

  events.sort((a, b) => a.ts - b.ts);

  fs.writeFileSync(path.join(targetDir, "users.json"), JSON.stringify(users, null, 2));
  fs.writeFileSync(path.join(targetDir, "events.ndjson"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const viewCount = events.filter((e) => e.type === "view").length;
  const seconds = events.filter((e) => e.type === "view").reduce((s, e) => s + e.seconds, 0);
  console.log(`已生成演示数据 -> ${targetDir}`);
  console.log(`  用户 ${USERS.length} 位，事件 ${events.length} 条（其中浏览记录 ${viewCount} 条）`);
  console.log(`  累计浏览时长 ${Math.round(seconds / 3600)} 小时，覆盖 ${DAYS} 天`);
}

main();
