#!/usr/bin/env node
"use strict";

/**
 * 开发用：生成一批演示数据（用户 + GitHub 仓库流量快照），
 * 方便在本地预览概览看板、统计明细、报表与各种图表效果。
 *
 * 数据模型与 lib/store.js 的 traffic.json 一致：
 *   users.json    用户与 GitHub 绑定关系
 *   traffic.json  每日 PV/UV/克隆快照 + 来源网站/热门路径滚动快照 + 同步状态
 *
 * 用法：
 *   node tools/seed-demo.js                 # 写入 fnos/app/server/.devdata/var/data
 *   node tools/seed-demo.js <dataDir>       # 指定数据目录
 *
 * 注意：会覆盖目标目录下已有的 users.json 与 traffic.json。
 */

const fs = require("fs");
const path = require("path");

const targetDir =
  process.argv[2] || path.join(__dirname, "..", "fnos", "app", "server", ".devdata", "var", "data");

const TIMEZONE = "Asia/Shanghai";
const DAYS = 90; // 生成 90 天的每日流量数据

// --- 演示用户 ---
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
  }
];

// --- 每位用户的仓库列表 ---
const USER_REPOS = {
  "1000": [
    "qixingkun/fnmonitor",
    "qixingkun/gstats",
    "qixingkun/dotfiles",
    "qixingkun/homelab"
  ],
  "1001": [
    "octocat/hello-world",
    "octocat/awesome-project"
  ]
};

// --- 来源网站候选 ---
const REFERRER_POOL = [
  { referrer: "github.com", weight: 30 },
  { referrer: "google.com", weight: 20 },
  { referrer: "stackoverflow.com", weight: 12 },
  { referrer: "reddit.com", weight: 8 },
  { referrer: "twitter.com", weight: 6 },
  { referrer: "dev.to", weight: 5 },
  { referrer: "juejin.cn", weight: 4 },
  { referrer: "zhihu.com", weight: 3 },
  { referrer: "Direct / None", weight: 10 }
];

// --- 热门路径候选 ---
const PATH_POOL = [
  { path: "/", title: "Home", weight: 25 },
  { path: "/README.md", title: "README", weight: 15 },
  { path: "/issues", title: "Issues", weight: 10 },
  { path: "/pulls", title: "Pull Requests", weight: 8 },
  { path: "/wiki", title: "Wiki", weight: 5 },
  { path: "/releases", title: "Releases", weight: 7 },
  { path: "/actions", title: "Actions", weight: 4 },
  { path: "/blob/main/README.md", title: "README.md", weight: 6 }
];

// --- 伪随机 ---
let seed = 20260923;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function randInt(min, max) {
  return Math.floor(rnd() * (max - min + 1)) + min;
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

function main() {
  fs.mkdirSync(targetDir, { recursive: true });

  const now = Date.now();
  const users = {};
  const daily = [];
  const refs = [];
  const sync = {};

  for (const u of USERS) {
    users[u.uid] = {
      uid: u.uid,
      fnosUsername: u.fnosUsername,
      isAdmin: u.isAdmin,
      github: u.github,
      token: "",
      authMethod: "oauth",
      linkedAt: now - 90 * 86400000,
      lastLoginAt: now - 2 * 86400000,
      loginCount: randInt(15, 40)
    };
  }

  for (const u of USERS) {
    const repos = USER_REPOS[u.uid] || [];
    const baseViews = u.uid === "1000" ? 35 : 15; // 活跃用户基线更高

    for (const repo of repos) {
      // 每天生成 views + clones 数据
      for (let d = DAYS - 1; d >= 0; d--) {
        const dayStart = new Date(now - d * 86400000);
        const dayKey = dayKeyFor(dayStart);
        const dow = new Date(dayKey + "T12:00:00").getDay();
        const isWeekend = dow === 0 || dow === 6;

        // PV 有波动，周末略低
        const views = Math.max(0, Math.round(baseViews * (isWeekend ? 0.6 : 1) * (0.5 + rnd())));
        const viewUniques = Math.max(1, Math.round(views * (0.4 + rnd() * 0.3)));
        const updatedAt = now - d * 86400000 + randInt(3600, 7200) * 1000;

        daily.push({
          uid: u.uid,
          repo,
          kind: "view",
          day: dayKey,
          count: views,
          uniques: viewUniques,
          updatedAt
        });

        // 克隆量约为浏览量的 15%-30%
        const clones = Math.max(0, Math.round(views * (0.15 + rnd() * 0.15)));
        const cloneUniques = Math.max(0, Math.round(clones * (0.5 + rnd() * 0.3)));
        daily.push({
          uid: u.uid,
          repo,
          kind: "clone",
          day: dayKey,
          count: clones,
          uniques: cloneUniques,
          updatedAt
        });
      }

      // 生成来源网站快照（近 14 天滚动）
      const referrers = [];
      const refCount = randInt(5, 8);
      for (let i = 0; i < refCount; i++) {
        const r = pick(REFERRER_POOL);
        referrers.push({
          referrer: r.referrer,
          count: randInt(5, 80),
          uniques: randInt(2, 25)
        });
      }
      // 去重（同名合并）
      const refMap = {};
      for (const r of referrers) {
        if (!refMap[r.referrer]) refMap[r.referrer] = { referrer: r.referrer, count: 0, uniques: 0 };
        refMap[r.referrer].count += r.count;
        refMap[r.referrer].uniques += r.uniques;
      }

      // 生成热门路径快照
      const paths = [];
      const pathCount = randInt(5, 7);
      for (let i = 0; i < pathCount; i++) {
        const p = pick(PATH_POOL);
        paths.push({
          path: p.path,
          title: p.title,
          count: randInt(3, 60),
          uniques: randInt(1, 20)
        });
      }
      const pathMap = {};
      for (const p of paths) {
        if (!pathMap[p.path]) pathMap[p.path] = { path: p.path, title: p.title, count: 0, uniques: 0 };
        pathMap[p.path].count += p.count;
        pathMap[p.path].uniques += p.uniques;
      }

      refs.push({
        uid: u.uid,
        repo,
        updatedAt: now - randInt(600, 3600) * 1000,
        referrers: Object.values(refMap).sort((a, b) => b.count - a.count).slice(0, 10),
        paths: Object.values(pathMap).sort((a, b) => b.count - a.count).slice(0, 10)
      });
    }

    // 同步状态
    sync[u.uid] = {
      status: "ok",
      startedAt: now - 300000,
      finishedAt: now - 240000,
      repoCount: repos.length,
      okRepos: repos.length,
      failedRepos: 0,
      rateLimit: { remaining: 4900, limit: 5000, resetAt: now + 1800000 }
    };
  }

  fs.writeFileSync(path.join(targetDir, "users.json"), JSON.stringify(users, null, 2));

  const trafficPayload = {
    version: 1,
    savedAt: now,
    daily,
    refs,
    sync
  };
  fs.writeFileSync(path.join(targetDir, "traffic.json"), JSON.stringify(trafficPayload, null, 2));

  const totalPV = daily.filter((d) => d.kind === "view").reduce((s, d) => s + d.count, 0);
  const totalClones = daily.filter((d) => d.kind === "clone").reduce((s, d) => s + d.count, 0);
  console.log(`已生成演示数据 -> ${targetDir}`);
  console.log(`  用户 ${USERS.length} 位，仓库 ${Object.values(USER_REPOS).flat().length} 个`);
  console.log(`  每日流量记录 ${daily.length} 条，来源/路径快照 ${refs.length} 条`);
  console.log(`  累计 PV ${totalPV}，累计克隆 ${totalClones}，覆盖 ${DAYS} 天`);
}

main();
