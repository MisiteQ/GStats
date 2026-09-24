"use strict";

/**
 * 报表生成：CSV（带 BOM，Excel 可直接打开）、JSON 与可打印的 HTML 报告。
 */

const fs = require("fs");
const path = require("path");
const util = require("./util");
const config = require("./config");

const REPORT_TYPES = {
  daily: { label: "每日汇总报表", slug: "daily" },
  users: { label: "用户明细报表", slug: "users" },
  projects: { label: "项目热度报表", slug: "projects" },
  user_projects: { label: "用户项目交叉报表", slug: "user-projects" },
  raw: { label: "原始访问记录", slug: "raw" }
};

function ensureType(type) {
  return REPORT_TYPES[type] ? type : "daily";
}

function humanSeconds(s) {
  return util.humanDuration(s);
}

function formatTs(ts, tz) {
  if (!ts) return "";
  return util.formatDateTime(ts, tz);
}

/* --------------------------------------------------------------------- 数据源 */

function collect(type, { store, from, to, uid, tz }) {
  switch (ensureType(type)) {
    case "users":
      return { rows: store.users(from, to) };
    case "projects":
      return { rows: store.projects(from, to, uid) };
    case "user_projects":
      return { rows: store.userProjects(from, to, uid) };
    case "raw":
      return { rows: store.rawEvents(from, to, uid, 5000) };
    case "daily":
    default: {
      const overview = store.overview(from, to, uid);
      return { rows: overview.days, totals: overview.totals };
    }
  }
}

/* ------------------------------------------------------------------------ CSV */

function buildCsv(type, ctx) {
  const tz = ctx.tz;
  const type2 = ensureType(type);
  if (type2 === "daily") {
    const { rows, totals } = ctx.data;
    const headers = [
      "日期",
      "登录用户数",
      "活跃用户数",
      "授权登录次数",
      "打开应用次数",
      "浏览次数",
      "涉及项目数",
      "总停留时长(秒)",
      "总停留时长"
    ];
    const body = rows.map((r) => [
      r.day,
      r.loginUsers,
      r.activeUsers,
      r.authLogins,
      r.appOpens,
      r.views,
      r.projects,
      r.seconds,
      humanSeconds(r.seconds)
    ]);
    body.push([
      "合计（去重/日均）",
      totals.loginUsers,
      totals.activeUsers,
      totals.authLogins,
      totals.appOpens,
      totals.views,
      totals.projects,
      totals.seconds,
      humanSeconds(totals.seconds)
    ]);
    body.push(["日均登录用户数", totals.avgDailyLoginUsers, "", "", "", "", "", "", ""]);
    return util.toCsv(headers, body);
  }

  if (type2 === "users") {
    const headers = [
      "飞牛用户",
      "用户ID",
      "GitHub 账号",
      "活跃天数",
      "登录次数",
      "打开应用次数",
      "浏览次数",
      "浏览项目数",
      "总停留时长(秒)",
      "总停留时长",
      "首次活动",
      "最后活动"
    ];
    const rows = ctx.data.rows.map((r) => [
      r.fnosUser || r.uid,
      r.uid,
      r.githubLogin ? "@" + r.githubLogin : "未绑定",
      r.activeDays,
      r.logins,
      r.appOpens,
      r.views,
      r.projectCount,
      r.seconds,
      humanSeconds(r.seconds),
      formatTs(r.firstAt, tz),
      formatTs(r.lastAt, tz)
    ]);
    return util.toCsv(headers, rows);
  }

  if (type2 === "projects") {
    const headers = [
      "项目",
      "类型",
      "显示名称",
      "访问人数",
      "浏览次数",
      "总停留时长(秒)",
      "平均停留时长(秒)",
      "平均停留时长",
      "访问者",
      "首次访问",
      "最后访问"
    ];
    const rows = ctx.data.rows.map((r) => [
      r.target,
      r.kind,
      r.title,
      r.users,
      r.views,
      r.seconds,
      r.avgSeconds,
      humanSeconds(r.avgSeconds),
      (r.userList || []).join(" / "),
      formatTs(r.firstAt, tz),
      formatTs(r.lastAt, tz)
    ]);
    return util.toCsv(headers, rows);
  }

  if (type2 === "user_projects") {
    const headers = [
      "飞牛用户",
      "GitHub 账号",
      "项目",
      "访问天数",
      "浏览次数",
      "总停留时长(秒)",
      "总停留时长",
      "平均停留时长(秒)",
      "最后访问"
    ];
    const rows = ctx.data.rows.map((r) => [
      r.fnosUser || r.uid,
      r.githubLogin ? "@" + r.githubLogin : "",
      r.target,
      r.activeDays,
      r.views,
      r.seconds,
      humanSeconds(r.seconds),
      r.avgSeconds,
      formatTs(r.lastAt, tz)
    ]);
    return util.toCsv(headers, rows);
  }

  const headers = [
    "时间",
    "日期",
    "飞牛用户",
    "GitHub 账号",
    "类型",
    "项目",
    "标题",
    "停留时长(秒)",
    "开始时间",
    "结束时间"
  ];
  const rows = ctx.data.rows.map((r) => [
    formatTs(r.ts, tz),
    r.day,
    r.fnosUser || r.uid,
    r.githubLogin ? "@" + r.githubLogin : "",
    r.kind,
    r.target,
    r.title,
    r.seconds,
    formatTs(r.startedAt, tz),
    formatTs(r.endedAt, tz)
  ]);
  return util.toCsv(headers, rows);
}

/* ----------------------------------------------------------------------- HTML */

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function barChart(rows, valueKey, labelKey, maxItems = 14) {
  const list = rows.slice(0, maxItems);
  if (!list.length) return '<p class="empty">暂无数据</p>';
  const max = Math.max(...list.map((r) => Number(r[valueKey]) || 0), 1);
  return `<div class="bars">${list
    .map((r) => {
      const value = Number(r[valueKey]) || 0;
      const pct = Math.max(1, Math.round((value / max) * 100));
      return `<div class="bar-row"><span class="bar-label" title="${escapeHtml(
        r[labelKey]
      )}">${escapeHtml(r[labelKey])}</span><span class="bar-track"><i style="width:${pct}%"></i></span><span class="bar-value">${escapeHtml(
        humanSeconds(value)
      )}</span></div>`;
    })
    .join("")}</div>`;
}

function trendChart(days) {
  if (!days.length) return '<p class="empty">暂无数据</p>';
  const max = Math.max(...days.map((d) => d.seconds), 1);
  const width = Math.max(560, days.length * 34);
  const height = 160;
  const pad = 24;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const step = days.length > 1 ? innerW / (days.length - 1) : innerW;
  const points = days.map((d, i) => {
    const x = pad + i * step;
    const y = pad + innerH - (d.seconds / max) * innerH;
    return [x, y, d];
  });
  const line = points.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${pad},${pad + innerH} ${line} ${(pad + (days.length - 1) * step).toFixed(1)},${pad + innerH}`;
  return `<svg class="trend" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img">
  <polygon points="${area}" fill="rgba(37,99,235,0.14)"/>
  <polyline points="${line}" fill="none" stroke="#2563eb" stroke-width="2"/>
  ${points
    .map(
      (p) =>
        `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.6" fill="#2563eb"><title>${escapeHtml(
          p[2].day
        )}：${escapeHtml(humanSeconds(p[2].seconds))}</title></circle>`
    )
    .join("")}
  <text x="${pad}" y="${height - 6}" font-size="10" fill="#64748b">${escapeHtml(days[0].day)}</text>
  <text x="${width - pad}" y="${height - 6}" font-size="10" fill="#64748b" text-anchor="end">${escapeHtml(
    days[days.length - 1].day
  )}</text>
</svg>`;
}

function buildHtml(ctx) {
  const { type, from, to, tz, generatedAt, scopeLabel, store } = ctx;
  const type2 = ensureType(type);
  const overview = store.overview(from, to, ctx.uid);
  const projects = store.projects(from, to, ctx.uid).slice(0, 15);
  const users = store.users(from, to).slice(0, 30);

  const cards = [
    { label: "登录用户数", value: overview.totals.loginUsers, unit: "人" },
    { label: "活跃用户数", value: overview.totals.activeUsers, unit: "人" },
    { label: "日均登录用户", value: overview.totals.avgDailyLoginUsers, unit: "人/天" },
    { label: "授权登录次数", value: overview.totals.authLogins, unit: "次" },
    { label: "浏览次数", value: overview.totals.views, unit: "次" },
    { label: "涉及项目", value: overview.totals.projects, unit: "个" },
    { label: "总停留时长", value: humanSeconds(overview.totals.seconds), unit: "" },
    { label: "平均单次停留", value: humanSeconds(overview.totals.avgSecondsPerView), unit: "" }
  ];

  const tableOf = () => {
    const data = ctx.data;
    if (type2 === "daily") {
      return `<table><thead><tr><th>日期</th><th>登录用户</th><th>活跃用户</th><th>授权登录次数</th><th>浏览次数</th><th>项目数</th><th>停留时长</th></tr></thead><tbody>${data.rows
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.day)}</td><td>${r.loginUsers}</td><td>${r.activeUsers}</td><td>${r.authLogins}</td><td>${r.views}</td><td>${r.projects}</td><td>${escapeHtml(
              humanSeconds(r.seconds)
            )}</td></tr>`
        )
        .join("")}</tbody></table>`;
    }
    if (type2 === "users") {
      return `<table><thead><tr><th>用户</th><th>GitHub</th><th>活跃天数</th><th>登录次数</th><th>浏览次数</th><th>项目数</th><th>停留时长</th><th>最后活动</th></tr></thead><tbody>${data.rows
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.fnosUser || r.uid)}</td><td>${
              r.githubLogin ? "@" + escapeHtml(r.githubLogin) : "未绑定"
            }</td><td>${r.activeDays}</td><td>${r.logins}</td><td>${r.views}</td><td>${
              r.projectCount
            }</td><td>${escapeHtml(humanSeconds(r.seconds))}</td><td>${escapeHtml(
              formatTs(r.lastAt, tz)
            )}</td></tr>`
        )
        .join("")}</tbody></table>`;
    }
    if (type2 === "projects") {
      return `<table><thead><tr><th>项目</th><th>访问人数</th><th>浏览次数</th><th>总时长</th><th>平均时长</th><th>最后访问</th></tr></thead><tbody>${data.rows
        .map(
          (r) =>
            `<tr><td><code>${escapeHtml(r.target)}</code></td><td>${r.users}</td><td>${r.views}</td><td>${escapeHtml(
              humanSeconds(r.seconds)
            )}</td><td>${escapeHtml(humanSeconds(r.avgSeconds))}</td><td>${escapeHtml(
              formatTs(r.lastAt, tz)
            )}</td></tr>`
        )
        .join("")}</tbody></table>`;
    }
    if (type2 === "user_projects") {
      return `<table><thead><tr><th>用户</th><th>GitHub</th><th>项目</th><th>访问天数</th><th>浏览次数</th><th>总时长</th><th>平均时长</th></tr></thead><tbody>${data.rows
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.fnosUser || r.uid)}</td><td>${
              r.githubLogin ? "@" + escapeHtml(r.githubLogin) : ""
            }</td><td><code>${escapeHtml(r.target)}</code></td><td>${r.activeDays}</td><td>${
              r.views
            }</td><td>${escapeHtml(humanSeconds(r.seconds))}</td><td>${escapeHtml(
              humanSeconds(r.avgSeconds)
            )}</td></tr>`
        )
        .join("")}</tbody></table>`;
    }
    return `<table><thead><tr><th>时间</th><th>用户</th><th>GitHub</th><th>项目</th><th>停留时长</th></tr></thead><tbody>${data.rows
      .map(
        (r) =>
          `<tr><td>${escapeHtml(formatTs(r.ts, tz))}</td><td>${escapeHtml(
            r.fnosUser || r.uid
          )}</td><td>${r.githubLogin ? "@" + escapeHtml(r.githubLogin) : ""}</td><td><code>${escapeHtml(
            r.target
          )}</code></td><td>${escapeHtml(humanSeconds(r.seconds))}</td></tr>`
      )
      .join("")}</tbody></table>`;
  };

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>GStats ${escapeHtml(REPORT_TYPES[type2].label)} ${escapeHtml(from)} ~ ${escapeHtml(to)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; background: #f6f8fb; color: #0f172a;
         font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .wrap { max-width: 1180px; margin: 0 auto; }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  h2 { font-size: 15px; margin: 30px 0 12px; color: #334155; }
  .meta { color: #64748b; font-size: 13px; line-height: 1.7; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 20px; }
  .card { background: #fff; border: 1px solid #e5e9f0; border-radius: 12px; padding: 14px 16px; }
  .card .k { font-size: 12px; color: #64748b; }
  .card .v { font-size: 22px; font-weight: 600; margin-top: 6px; }
  .card .u { font-size: 12px; color: #94a3b8; margin-left: 3px; font-weight: 400; }
  .panel { background: #fff; border: 1px solid #e5e9f0; border-radius: 12px; padding: 16px; margin-top: 12px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eef2f7; white-space: nowrap; }
  th { color: #475569; font-weight: 600; background: #f8fafc; }
  tbody tr:hover { background: #f8fafc; }
  code { background: #f1f5f9; padding: 2px 6px; border-radius: 5px; font-size: 12px; }
  .trend { width: 100%; height: auto; }
  .bars { display: flex; flex-direction: column; gap: 8px; }
  .bar-row { display: grid; grid-template-columns: minmax(140px, 240px) 1fr 96px; align-items: center; gap: 10px; font-size: 13px; }
  .bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { background: #eef2f7; border-radius: 99px; height: 10px; overflow: hidden; }
  .bar-track i { display: block; height: 100%; background: linear-gradient(90deg, #2563eb, #38bdf8); border-radius: 99px; }
  .bar-value { text-align: right; color: #475569; }
  .empty { color: #94a3b8; font-size: 13px; }
  footer { margin-top: 28px; color: #94a3b8; font-size: 12px; text-align: center; }
  @media print { body { background: #fff; padding: 0; } .panel, .card { break-inside: avoid; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>GStats · ${escapeHtml(REPORT_TYPES[type2].label)}</h1>
      <div class="meta">
        统计区间：${escapeHtml(from)} ~ ${escapeHtml(to)}（时区 ${escapeHtml(tz)}）<br/>
        统计范围：${escapeHtml(scopeLabel)}<br/>
        生成时间：${escapeHtml(formatTs(generatedAt, tz))} · 由 GStats 自动生成
      </div>
    </div>
  </header>

  <div class="cards">
    ${cards
      .map(
        (c) =>
          `<div class="card"><div class="k">${escapeHtml(c.label)}</div><div class="v">${escapeHtml(
            c.value
          )}<span class="u">${escapeHtml(c.unit)}</span></div></div>`
      )
      .join("")}
  </div>

  <h2>每日停留时长趋势</h2>
  <div class="panel">${trendChart(overview.days)}</div>

  <h2>项目停留时长排行</h2>
  <div class="panel">${barChart(projects, "seconds", "target")}</div>

  <h2>用户停留时长排行</h2>
  <div class="panel">${barChart(users, "seconds", "fnosUser")}</div>

  <h2>${escapeHtml(REPORT_TYPES[type2].label)}明细</h2>
  <div class="panel">${tableOf()}</div>

  <footer>GStats · 飞牛 fnOS 应用 · 本报表由本地服务生成，数据未离开你的 NAS<br/>
  开发者 Misite齊 · <a href="https://github.com/MisiteQ" target="_blank" rel="noopener">https://github.com/MisiteQ</a></footer>
</div>
</body>
</html>`;
}

/* ---------------------------------------------------------------------- 导出 */

function build({ type, store, from, to, uid, format, scopeLabel }) {
  const tz = store.tz;
  const type2 = ensureType(type);
  const data = collect(type2, { store, from, to, uid, tz });
  const ctx = {
    type: type2,
    from,
    to,
    tz,
    uid,
    data,
    store,
    scopeLabel: scopeLabel || "全部用户",
    generatedAt: Date.now()
  };
  const stamp = `${from}_${to}`;

  if (format === "json") {
    return {
      filename: `gstats-${REPORT_TYPES[type2].slug}-${stamp}.json`,
      contentType: "application/json; charset=utf-8",
      content: JSON.stringify(
        {
          app: "GStats",
          type: type2,
          label: REPORT_TYPES[type2].label,
          range: { from, to, timezone: tz },
          scope: ctx.scopeLabel,
          generatedAt: util.isoDate(ctx.generatedAt),
          summary: store.overview(from, to, uid).totals,
          rows: data.rows
        },
        null,
        2
      )
    };
  }

  if (format === "html") {
    return {
      filename: `gstats-${REPORT_TYPES[type2].slug}-${stamp}.html`,
      contentType: "text/html; charset=utf-8",
      content: buildHtml(ctx)
    };
  }

  return {
    filename: `gstats-${REPORT_TYPES[type2].slug}-${stamp}.csv`,
    contentType: "text/csv; charset=utf-8",
    content: buildCsv(type2, ctx)
  };
}

/** 把报表同时写入用户可见的共享目录，方便在文件管理器里取走 */
function writeToShare(result) {
  try {
    const dir = path.join(config.SHARE_DIR, "reports");
    config.ensureDir(dir);
    const target = path.join(dir, result.filename);
    fs.writeFileSync(target, result.content);
    return target;
  } catch (e) {
    return null;
  }
}

module.exports = {
  REPORT_TYPES,
  build,
  writeToShare
};
