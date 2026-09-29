"use strict";

/**
 * GitHub 仓库流量（Traffic）同步任务。
 *
 * GitHub 的 Repo Traffic API 只返回最近 14 天数据，且要求调用者对仓库有
 * 推送权限。本模块每 6 小时（以及用户刚完成绑定后）抓取一次快照，按
 * (用户, 仓库, 日期) 落盘存档，长期历史由此积累。
 */

const github = require("./github");
const util = require("./util");

const REPO_CONCURRENCY = 4; // 同时处理多少个仓库（每个仓库 4 个请求）
const BATCH_PAUSE_MS = 80;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dayOf(timestamp, tz) {
  const ts = Date.parse(timestamp);
  return Number.isFinite(ts) ? util.dayKey(ts, tz) : "";
}

/**
 * 同步单个用户名下所有可统计仓库的流量数据。
 * @returns {Promise<object>} 最终的同步状态
 */
async function syncUser(store, uid) {
  try {
    return await _syncUser(store, uid);
  } catch (e) {
    console.error(`[traffic] syncUser ${uid} uncaught:`, e.message);
    store.setSyncStatus(uid, {
      status: "failed",
      finishedAt: Date.now(),
      message: `同步异常：${e.message || e}`
    });
    store.persistTraffic();
    return store.getSyncStatus(uid);
  }
}

async function _syncUser(store, uid) {
  const user = store.getUser(uid);
  if (!user || !user.github) {
    store.setSyncStatus(uid, {
      status: "failed",
      finishedAt: Date.now(),
      message: "尚未绑定 GitHub 账号"
    });
    store.persistTraffic();
    return store.getSyncStatus(uid);
  }
  if (store.isSyncing(uid)) return store.getSyncStatus(uid);

  const token = store.getToken(uid);
  if (!token) {
    store.setSyncStatus(uid, {
      status: "failed",
      finishedAt: Date.now(),
      message: "读取不到 GitHub Token，请在「我的 GitHub」中重新登录"
    });
    store.persistTraffic();
    return store.getSyncStatus(uid);
  }

  const startedAt = Date.now();
  store.setSyncStatus(uid, {
    status: "syncing",
    startedAt,
    finishedAt: 0,
    githubLogin: user.github.login,
    repos: 0,
    okRepos: 0,
    deniedRepos: 0,
    failedRepos: 0,
    daysWritten: 0,
    message: "正在获取可统计仓库列表…",
    rateLimitRemaining: null
  });
  store.persistTraffic();

  console.log(`[traffic] syncUser ${uid} (@${user.github.login}): 获取仓库列表中…`);
  const list = await github.listEditableRepos(token, { perPage: 100, maxPages: 3 });
  console.log(`[traffic] syncUser ${uid}: 仓库列表返回 ok=${list.ok} count=${list.items ? list.items.length : 0}${list.ok ? "" : " status=" + list.status + " msg=" + list.message}`);
  if (!list.ok) {
    store.setSyncStatus(uid, {
      status: "failed",
      finishedAt: Date.now(),
      message: `获取仓库列表失败：${list.message || list.status}`
    });
    store.persistTraffic();
    return store.getSyncStatus(uid);
  }

  const repos = list.items;
  // fork 且自己没有推送活跃度的仓库 Traffic 多半为空，仍尝试一次；404 会自动跳过
  const result = {
    okRepos: 0,
    deniedRepos: 0,
    failedRepos: 0,
    daysWritten: 0,
    rateLimitRemaining: null,
    aborted: false,
    abortMessage: ""
  };

  const updateProgress = () => {
    const done = result.okRepos + result.deniedRepos + result.failedRepos;
    store.setSyncStatus(uid, {
      repos: repos.length,
      okRepos: result.okRepos,
      deniedRepos: result.deniedRepos,
      failedRepos: result.failedRepos,
      daysWritten: result.daysWritten,
      rateLimitRemaining: result.rateLimitRemaining,
      message: `同步中 ${done}/${repos.length}…`
    });
  };

  for (let i = 0; i < repos.length && !result.aborted; i += REPO_CONCURRENCY) {
    const batch = repos.slice(i, i + REPO_CONCURRENCY);
    await Promise.all(batch.map((repo) => syncRepo(store, String(uid), token, repo, result)));
    updateProgress();
    store.persistTraffic(); // 边抓边存，长任务中断也能保留已完成部分
    await sleep(BATCH_PAUSE_MS);
  }

  const finishedAt = Date.now();
  let status = "ok";
  let message = "";
  if (result.aborted) {
    status = result.okRepos > 0 ? "partial" : "failed";
    message = result.abortMessage;
  } else if (result.failedRepos > 0) {
    status = "partial";
    message = `${result.failedRepos} 个仓库获取失败，已部分完成`;
  } else if (result.deniedRepos > 0 && result.okRepos === 0) {
    status = "failed";
    message = "当前 Token 对这些仓库没有推送权限，无法读取流量数据（Traffic 数据仅仓库管理员可见）";
  }

  store.setSyncStatus(uid, {
    status,
    startedAt,
    finishedAt,
    repos: repos.length,
    okRepos: result.okRepos,
    deniedRepos: result.deniedRepos,
    failedRepos: result.failedRepos,
    daysWritten: result.daysWritten,
    rateLimitRemaining: result.rateLimitRemaining,
    message
  });
  store.persistTraffic();
  return store.getSyncStatus(uid);
}

async function syncRepo(store, uid, token, repo, result) {
  const fullName = repo.fullName || repo.full_name || "";
  if (!fullName) {
    result.failedRepos += 1;
    return;
  }
  const [owner, name] = fullName.split("/");

  const [viewsRes, clonesRes, refsRes, pathsRes] = await Promise.all([
    github.getTrafficViews(token, owner, name),
    github.getTrafficClones(token, owner, name),
    github.getTrafficReferrers(token, owner, name),
    github.getTrafficPaths(token, owner, name)
  ]);

  console.log(`[traffic]   ${fullName}: views=${viewsRes.status} clones=${clonesRes.status} refs=${refsRes.status} paths=${pathsRes.status}`);

  for (const r of [viewsRes, clonesRes, refsRes, pathsRes]) {
    if (r.rateLimit && r.rateLimit.remaining !== undefined) {
      result.rateLimitRemaining = r.rateLimit.remaining;
    }
    // 限流耗尽：中止整个同步任务
    if (!r.ok && r.status === 403 && r.rateLimit && r.rateLimit.remaining === 0) {
      const resetTs = r.rateLimit.reset;
      const resetAt = resetTs
        ? new Date(resetTs * 1000).toLocaleTimeString()
        : "稍后";
      result.aborted = true;
      result.abortMessage = `GitHub API 限流已耗尽，请在 ${resetAt} 之后重试`;
      return;
    }
  }

  // 没有推送权限时四个接口均为 404
  if (!viewsRes.ok && viewsRes.status === 404) {
    result.deniedRepos += 1;
    return;
  }
  if (!viewsRes.ok && !clonesRes.ok) {
    result.failedRepos += 1;
    return;
  }

  const now = Date.now();
  if (viewsRes.ok && Array.isArray(viewsRes.data.views)) {
    for (const e of viewsRes.data.views) {
      const day = dayOf(e.timestamp, store.tz);
      if (day) {
        store.upsertTrafficDay(uid, fullName, "view", day, e.count, e.uniques, now);
        result.daysWritten += 1;
      }
    }
  }
  if (clonesRes.ok && Array.isArray(clonesRes.data.clones)) {
    for (const e of clonesRes.data.clones) {
      const day = dayOf(e.timestamp, store.tz);
      if (day) {
        store.upsertTrafficDay(uid, fullName, "clone", day, e.count, e.uniques, now);
        result.daysWritten += 1;
      }
    }
  }
  if (refsRes.ok || pathsRes.ok) {
    store.replaceTrafficRefs(
      uid,
      fullName,
      refsRes.ok ? refsRes.data : [],
      pathsRes.ok ? pathsRes.data : [],
      now
    );
  }
  result.okRepos += 1;
}

/** 顺序同步所有已绑定 GitHub 的用户（每个用户使用各自的限流额度） */
async function syncAll(store, { waitMs = 1500 } = {}) {
  const linked = store.listUsers().filter((u) => u.github && !store.isSyncing(u.uid));
  for (const user of linked) {
    try {
      await syncUser(store, user.uid);
    } catch (e) {
      console.error(`[traffic] sync user ${user.uid} failed:`, e.message);
      store.setSyncStatus(user.uid, { status: "failed", finishedAt: Date.now(), message: e.message });
      store.persistTraffic();
    }
    if (waitMs) await sleep(waitMs);
  }
}

module.exports = {
  syncUser,
  syncAll
};
