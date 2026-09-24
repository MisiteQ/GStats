"use strict";

/**
 * 通用工具函数：时区日期处理、CSV 转义、参数校验等。
 * 全部使用 Node.js 内置能力，无第三方依赖。
 */

const formatterCache = new Map();

function dateTimeFormatter(timeZone) {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

function dateFormatter(timeZone) {
  const key = timeZone + "#date";
  let fmt = formatterCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    formatterCache.set(key, fmt);
  }
  return fmt;
}

/** 把时间戳转换为指定时区下的 YYYY-MM-DD */
function dayKey(ts, timeZone) {
  const parts = dateFormatter(timeZone).formatToParts(new Date(ts));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

/** 把时间戳转换为指定时区下的 YYYY-MM-DD HH:mm:ss */
function formatDateTime(ts, timeZone) {
  const parts = dateTimeFormatter(timeZone).formatToParts(new Date(ts));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

/** 判断字符串是否符合 YYYY-MM-DD */
function isDayString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** 在日期字符串上加减天数（按 UTC 计算，避免夏令时干扰） */
function addDays(day, delta) {
  const [y, m, d] = day.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  const next = new Date(base + delta * 86400000);
  const yy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** 生成 [from, to] 区间内所有日期（含首尾），最多 limit 天 */
function dayRange(from, to, limit = 400) {
  const out = [];
  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard < limit) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return out;
}

/** 两个日期字符串之间的天数差 */
function dayDiff(from, to) {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** 生成 CSV 文本，自动添加 UTF-8 BOM，方便 Excel 直接打开 */
function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(","));
  }
  return "\ufeff" + lines.join("\r\n") + "\r\n";
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function safeString(value, maxLen = 512) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function safeJsonParse(text, fallback) {
  try {
    const parsed = JSON.parse(text);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (e) {
    return fallback;
  }
}

/** 只保留安全的文件名字符 */
function safeFileToken(value, fallback = "unknown") {
  const s = String(value === null || value === undefined ? "" : value)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || fallback;
}

function isoDate(ts) {
  return new Date(ts).toISOString();
}

/** 把秒数格式化为「1小时23分」的中文可读文本 */
function humanDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

module.exports = {
  dayKey,
  formatDateTime,
  isDayString,
  addDays,
  dayRange,
  dayDiff,
  csvEscape,
  toCsv,
  clampInt,
  clampNumber,
  safeString,
  safeJsonParse,
  safeFileToken,
  isoDate,
  humanDuration
};
