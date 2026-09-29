"use strict";

/**
 * 报表生成：CSV（带 BOM，Excel 可直接打开）、JSON 与可打印的 HTML 报告。
 * 数据均来自 GitHub 官方 Repo Traffic API 的本地快照（外部访客统计）。
 */

const fs = require("fs");
const path = require("path");
const util = require("./util");
const config = require("./config");

const REPORT_TYPES = {
  daily: { label: "每日流量报表", slug: "daily" },
  repos: { label: "仓库流量报表", slug: "repos" },
  referrers: { label: "来源网站报表", slug: "referrers" },
  paths: { label: "热门路径报表", slug: "paths" }
};

// 来源/路径只有近 14 天滚动快照，不按区间过滤
const SNAPSHOT_TYPES = new Set(["referrers", "paths"]);

function ensureType(type) {
  return REPORT_TYPES[type] ? type : "daily";
}

function formatTs(ts, tz) {
  if (!ts) return "";
  return util.formatDateTime(ts, tz);
}

/* --------------------------------------------------------------------- 数据源 */

function collect(type, { store, from, to, uid }) {
  switch (ensureType(type)) {
    case "repos":
      return { rows: store.repos(from, to, uid), window: `${from} ~ ${to}` };
    case "referrers": {
      const data = store.referrers(uid);
      return { rows: data.rows, updatedAt: data.updatedAt, window: "近14天" };
    }
    case "paths": {
      const data = store.paths(uid);
      return { rows: data.rows, updatedAt: data.updatedAt, window: "近14天" };
    }
    case "daily":
    default: {
      const overview = store.overview(from, to, uid);
      return { rows: overview.days, totals: overview.totals, window: `${from} ~ ${to}` };
    }
  }
}

/* ------------------------------------------------------------------------ CSV */

function buildCsv(type, ctx) {
  const type2 = ensureType(type);

  if (type2 === "daily") {
    const { rows, totals } = ctx.data;
    const headers = ["日期", "浏览量(PV)", "独立访客(UV,每日)", "克隆次数", "克隆者数(每日)", "有访问的仓库数"];
    const body = rows.map((r) => [r.day, r.views, r.uniques, r.clones, r.cloneUniques, r.repos]);
    body.push(["合计", totals.views, totals.uniques, totals.clones, totals.cloneUniques, totals.repos]);
    body.push(["日均", totals.avgDailyViews, totals.avgDailyUniques, "", "", ""]);
    return util.toCsv(headers, body);
  }

  if (type2 === "repos") {
    const headers = [
      "仓库",
      "所有者",
      "浏览量(PV)",
      "独立访客(UV,每日累计)",
      "克隆次数",
      "克隆者数",
      "有访问天数",
      "日均浏览量",
      "首次有数据",
      "最后有数据"
    ];
    const rows = ctx.data.rows.map((r) => [
      r.repo,
      r.owner,
      r.views,
      r.uniques,
      r.clones,
      r.cloneUniques,
      r.activeDays,
      r.avgDailyViews,
      r.firstDay,
      r.lastDay
    ]);
    return util.toCsv(headers, rows);
  }

  if (type2 === "referrers") {
    const headers = ["来源网站", "访问量", "独立访客(跨仓库累计)", "覆盖仓库数"];
    const rows = ctx.data.rows.map((r) => [r.referrer, r.count, r.uniques, r.repoCount]);
    return util.toCsv(headers, rows);
  }

  // paths
  const headers = ["访问路径", "页面标题", "访问量", "独立访客(跨仓库累计)", "覆盖仓库数"];
  const rows = ctx.data.rows.map((r) => [r.path, r.title, r.count, r.uniques, r.repoCount]);
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

function barChart(rows, valueKey, labelKey, maxItems = 15) {
  const list = rows.slice(0, maxItems);
  if (!list.length) return '<p class="empty">暂无数据</p>';
  const max = Math.max(...list.map((r) => Number(r[valueKey]) || 0), 1);
  return `<div class="bars">${list
    .map((r) => {
      const value = Number(r[valueKey]) || 0;
      const pct = Math.max(1, Math.round((value / max) * 100));
      return `<div class="bar-row"><span class="bar-label" title="${escapeHtml(
        r[labelKey]
      )}">${escapeHtml(r[labelKey])}</span><span class="bar-track"><i style="width:${pct}%"></i></span><span class="bar-value">${value}</span></div>`;
    })
    .join("")}</div>`;
}

function trendChart(days) {
  if (!days.length) return '<p class="empty">暂无数据</p>';
  const max = Math.max(...days.map((d) => Math.max(d.views, d.uniques)), 1);
  const width = Math.max(560, days.length * 34);
  const height = 170;
  const pad = 24;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const step = days.length > 1 ? innerW / (days.length - 1) : innerW;
  const lineOf = (key) =>
    days
      .map((d, i) => {
        const x = pad + i * step;
        const y = pad + innerH - (Math.max(0, d[key]) / max) * innerH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  const pointsOf = (key, color, label) =>
    days
      .map((d, i) => {
        const x = pad + i * step;
        const y = pad + innerH - (Math.max(0, d[key]) / max) * innerH;
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="${color}"><title>${escapeHtml(
          d.day
        )} ${label}：${d[key]}</title></circle>`;
      })
      .join("");
  return `<svg class="trend" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img">
  <polyline points="${lineOf("views")}" fill="none" stroke="#2563eb" stroke-width="2"/>
  <polyline points="${lineOf("uniques")}" fill="none" stroke="#10b981" stroke-width="2" stroke-dasharray="5 3"/>
  ${pointsOf("views", "#2563eb", "浏览量")}
  ${pointsOf("uniques", "#10b981", "独立访客")}
  <text x="${pad}" y="${height - 6}" font-size="10" fill="#64748b">${escapeHtml(days[0].day)}</text>
  <text x="${width - pad}" y="${height - 6}" font-size="10" fill="#64748b" text-anchor="end">${escapeHtml(
    days[days.length - 1].day
  )}</text>
</svg>`;
}

function buildHtml(ctx) {
  const { type, from, to, tz, generatedAt, scopeLabel, store, uid } = ctx;
  const type2 = ensureType(type);
  const overview = store.overview(from, to, uid);
  const repos = store.repos(from, to, uid).slice(0, 15);

  const cards = [
    { label: "总浏览量(PV)", value: overview.totals.views, unit: "次" },
    { label: "独立访客(每日UV累计)", value: overview.totals.uniques, unit: "人" },
    { label: "日均浏览量", value: overview.totals.avgDailyViews, unit: "次/天" },
    { label: "克隆次数", value: overview.totals.clones, unit: "次" },
    { label: "有访问的仓库", value: overview.totals.repos, unit: "个" },
    { label: "平均每仓浏览量", value: overview.totals.avgViewsPerRepo, unit: "次" }
  ];

  const tableOf = () => {
    const data = ctx.data;
    if (type2 === "daily") {
      return `<table><thead><tr><th>日期</th><th>浏览量(PV)</th><th>独立访客</th><th>克隆次数</th><th>克隆者数</th><th>仓库数</th></tr></thead><tbody>${data.rows
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.day)}</td><td>${r.views}</td><td>${r.uniques}</td><td>${r.clones}</td><td>${r.cloneUniques}</td><td>${r.repos}</td></tr>`
        )
        .join("")}</tbody></table>`;
    }
    if (type2 === "repos") {
      return `<table><thead><tr><th>仓库</th><th>浏览量</th><th>独立访客(每日累计)</th><th>克隆次数</th><th>有访问天数</th><th>日均浏览</th></tr></thead><tbody>${data.rows
        .map(
          (r) =>
            `<tr><td><code>${escapeHtml(r.repo)}</code></td><td>${r.views}</td><td>${r.uniques}</td><td>${r.clones}</td><td>${r.activeDays}</td><td>${r.avgDailyViews}</td></tr>`
        )
        .join("")}</tbody></table>`;
    }
    if (type2 === "referrers") {
      return `<table><thead><tr><th>来源网站</th><th>访问量</th><th>独立访客</th><th>覆盖仓库数</th></tr></thead><tbody>${data.rows
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.referrer)}</td><td>${r.count}</td><td>${r.uniques}</td><td>${r.repoCount}</td></tr>`
        )
        .join("")}</tbody></table>`;
    }
    return `<table><thead><tr><th>访问路径</th><th>页面标题</th><th>访问量</th><th>独立访客</th><th>覆盖仓库数</th></tr></thead><tbody>${data.rows
      .map(
        (r) =>
          `<tr><td><code>${escapeHtml(r.path)}</code></td><td>${escapeHtml(r.title)}</td><td>${r.count}</td><td>${r.uniques}</td><td>${r.repoCount}</td></tr>`
      )
      .join("")}</tbody></table>`;
  };

  const windowNote = SNAPSHOT_TYPES.has(type2)
    ? "<b>数据窗口：近 14 天</b>（GitHub 官方仅提供滚动快照，不支持自定义区间）<br/>"
    : "";

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
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-top: 20px; }
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
  .bar-row { display: grid; grid-template-columns: minmax(180px, 320px) 1fr 72px; align-items: center; gap: 10px; font-size: 13px; }
  .bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { background: #eef2f7; border-radius: 99px; height: 10px; overflow: hidden; }
  .bar-track i { display: block; height: 100%; background: linear-gradient(90deg, #2563eb, #38bdf8); border-radius: 99px; }
  .bar-value { text-align: right; color: #475569; }
  .empty { color: #94a3b8; font-size: 13px; }
  .legend { font-size: 12px; color: #64748b; margin-top: 8px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 5px 0 10px; }
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
        ${windowNote}
        生成时间：${escapeHtml(formatTs(generatedAt, tz))} · 数据来源：GitHub Repo Traffic API
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

  ${
    SNAPSHOT_TYPES.has(type2)
      ? ""
      : `<h2>每日流量趋势</h2>
  <div class="panel">${trendChart(overview.days)}
    <div class="legend"><span><i style="background:#2563eb"></i>浏览量(PV)</span><span><i style="background:#10b981"></i>独立访客(每日UV)</span></div>
  </div>

  <h2>仓库浏览量排行</h2>
  <div class="panel">${barChart(repos, "views", "repo")}</div>`
  }

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
  const data = collect(type2, { store, from, to, uid });
  const ctx = {
    type: type2,
    from,
    to,
    tz,
    uid,
    data,
    store,
    scopeLabel: scopeLabel || "全部账号",
    generatedAt: Date.now()
  };
  const stamp = SNAPSHOT_TYPES.has(type2) ? "last14d" : `${from}_${to}`;

  if (format === "json") {
    return {
      filename: `gstats-${REPORT_TYPES[type2].slug}-${stamp}.json`,
      contentType: "application/json; charset=utf-8",
      content: JSON.stringify(
        {
          app: "GStats",
          type: type2,
          label: REPORT_TYPES[type2].label,
          source: "GitHub Repo Traffic API",
          range: { from, to, timezone: tz, window: data.window },
          scope: ctx.scopeLabel,
          generatedAt: util.isoDate(ctx.generatedAt),
          snapshotUpdatedAt: data.updatedAt || null,
          summary: SNAPSHOT_TYPES.has(type2) ? undefined : store.overview(from, to, uid).totals,
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
