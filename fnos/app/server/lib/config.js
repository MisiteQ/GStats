"use strict";

/**
 * 运行环境与配置管理。
 *
 * 路径全部来自飞牛 fnOS 提供的 TRIM_* 环境变量；
 * 在开发机上直接用 node 运行时，会退化到本地 .devdata 目录，方便调试。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { safeJsonParse } = require("./util");

const SERVER_DIR = path.resolve(__dirname, "..");
/**
 * 开发（未安装到飞牛）时的兜底数据目录，放在工程根目录的 .devdata 下，
 * 避免混进 fnpack 打包目录。
 */
const DEV_ROOT = process.env.GSTATS_DEV_ROOT
  ? path.resolve(process.env.GSTATS_DEV_ROOT)
  : path.resolve(SERVER_DIR, "..", "..", "..", ".devdata");

const APPDEST = process.env.TRIM_APPDEST || path.join(DEV_ROOT, "appdest");
const PKGVAR = process.env.TRIM_PKGVAR || path.join(DEV_ROOT, "var");
const PKGETC = process.env.TRIM_PKGETC || path.join(DEV_ROOT, "etc");
const PKGTMP = process.env.TRIM_PKGTMP || path.join(DEV_ROOT, "tmp");
const PKGHOME = process.env.TRIM_PKGHOME || path.join(DEV_ROOT, "home");

const APP_NAME = process.env.TRIM_APPNAME || "gstats";
/** 版本号优先取环境变量（fnOS 注入），否则从打包目录的 manifest 读取，最后兜底 */
function resolveAppVersion() {
  if (process.env.TRIM_APPVER) return process.env.TRIM_APPVER;
  try {
    const manifestPath = path.join(SERVER_DIR, "..", "..", "manifest");
    if (fs.existsSync(manifestPath)) {
      const m = fs.readFileSync(manifestPath, "utf8").match(/^\s*version\s*=\s*(.*)$/m);
      if (m) return m[1].trim();
    }
  } catch (e) {
    /* fallthrough */
  }
  return "0.0.0";
}
const APP_VERSION = resolveAppVersion();
const RUNTIME_USER = process.env.TRIM_USERNAME || "";
const IS_DEV = !process.env.TRIM_APPDEST;

const GATEWAY_PREFIX = process.env.GSTATS_GATEWAY_PREFIX || "/app/gstats";
const SOCKET_PATH = process.env.GSTATS_SOCKET_PATH || path.join(APPDEST, "app.sock");
const HTTP_PORT = Number.parseInt(process.env.GSTATS_PORT || "0", 10);

const DATA_DIR = path.join(PKGVAR, "data");
const PUBLIC_DIR = path.join(SERVER_DIR, "public");
const CONFIG_FILE = path.join(PKGETC, "config.json");
const SECRET_KEY_FILE = path.join(PKGETC, "secret.key");

/** 共享目录：用户可在文件管理器里取走导出的报表 */
const SHARE_DIR = (function resolveShareDir() {
  const raw = process.env.TRIM_DATA_SHARE_PATHS || "";
  const list = raw.split(":").map((s) => s.trim()).filter(Boolean);
  if (list.length > 1) {
    const reports = list.find((p) => /reports?$/i.test(p));
    if (reports) return reports;
  }
  return list[0] || path.join(DEV_ROOT, "share");
})();

const DEFAULT_THEME = "auto";

const THEMES = [
  { id: "moonlight", name: "明月", mode: "light", accent: "#2563eb" },
  { id: "bamboo", name: "青竹", mode: "light", accent: "#059669" },
  { id: "wisteria", name: "紫藤", mode: "light", accent: "#7c3aed" },
  { id: "sunrise", name: "暖阳", mode: "light", accent: "#d97706" },
  { id: "deepspace", name: "深空", mode: "dark", accent: "#6366f1" },
  { id: "abyss", name: "青碧", mode: "dark", accent: "#06b6d4" },
  { id: "nightfall", name: "夜幕", mode: "dark", accent: "#f43f5e" },
  { id: "graphite", name: "石墨", mode: "dark", accent: "#94a3b8" }
];

const DEFAULT_CONFIG = {
  oauth: {
    clientId: "",
    clientSecret: "",
    publicBaseUrl: ""
  },
  /** GitHub API 地址：默认官方，网络受限的 NAS 可改为镜像 / 反代地址 */
  githubApiBase: "",
  timezone: "Asia/Shanghai",
  retentionDays: 365,
  allowPrivateRepos: false,
  defaultTheme: DEFAULT_THEME,
  /** 导出报表时是否同时落一份到共享目录 */
  exportToShare: true,
  /** 单条浏览记录的时长上限（秒），防止异常数据把统计拉高 */
  maxViewSeconds: 7200,
  updatedAt: 0
};

function wizardValue(...names) {
  for (const name of names) {
    const v = process.env[name];
    if (v !== undefined && v !== null && String(v).length > 0) return String(v);
  }
  return "";
}

function truthy(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "是"].includes(s)) return true;
  if (["0", "false", "no", "off", "否", ""].includes(s)) return false;
  return null;
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    /* ignore */
  }
}

function initDirs() {
  for (const dir of [APPDEST, PKGVAR, PKGETC, PKGTMP, PKGHOME, DATA_DIR]) {
    ensureDir(dir);
  }
}

function readConfig() {
  const raw = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, "utf8") : "";
  const parsed = safeJsonParse(raw, {}) || {};
  const merged = {
    ...DEFAULT_CONFIG,
    ...parsed,
    oauth: { ...DEFAULT_CONFIG.oauth, ...(parsed.oauth || {}) }
  };

  // 环境变量（含安装向导写入的 wizard_* ）作为兜底
  const envClientId = wizardValue("GSTATS_OAUTH_CLIENT_ID", "wizard_oauth_client_id");
  const envClientSecret = wizardValue("GSTATS_OAUTH_CLIENT_SECRET", "wizard_oauth_client_secret");
  const envBaseUrl = wizardValue("GSTATS_PUBLIC_BASE_URL", "wizard_public_base_url");
  const envTz = wizardValue("GSTATS_TIMEZONE", "wizard_timezone");
  const envRetention = wizardValue("GSTATS_RETENTION_DAYS", "wizard_retention_days");
  const envPrivate = truthy(wizardValue("GSTATS_ALLOW_PRIVATE_REPOS", "wizard_allow_private_repos"));
  const envTheme = wizardValue("GSTATS_DEFAULT_THEME", "wizard_default_theme");

  if (!merged.oauth.clientId && envClientId) merged.oauth.clientId = envClientId;
  if (!merged.oauth.clientSecret && envClientSecret) merged.oauth.clientSecret = envClientSecret;
  if (!merged.oauth.publicBaseUrl && envBaseUrl) merged.oauth.publicBaseUrl = envBaseUrl;
  if (!parsed.timezone && envTz) merged.timezone = envTz;
  if (!parsed.retentionDays && envRetention) {
    const n = Number.parseInt(envRetention, 10);
    if (Number.isFinite(n) && n > 0) merged.retentionDays = n;
  }
  if (parsed.allowPrivateRepos === undefined && envPrivate !== null) {
    merged.allowPrivateRepos = envPrivate;
  }
  if (!parsed.defaultTheme && envTheme) merged.defaultTheme = envTheme;

  // GitHub API 地址：配置文件优先，其次环境变量；必须是 http(s) 地址，否则回退官方
  const rawApiBase = String(merged.githubApiBase || "").trim() || wizardValue("GSTATS_GITHUB_API_BASE");
  if (/^https?:\/\/.+/i.test(rawApiBase)) {
    merged.githubApiBase = rawApiBase.replace(/\/+$/, "");
  } else {
    merged.githubApiBase = "";
  }

  if (!THEMES.some((t) => t.id === merged.defaultTheme)) {
    merged.defaultTheme = DEFAULT_THEME;
  }
  if (typeof merged.oauth.publicBaseUrl === "string") {
    merged.oauth.publicBaseUrl = merged.oauth.publicBaseUrl.replace(/\/+$/, "");
  }
  return merged;
}

function writeConfig(config) {
  const next = {
    ...DEFAULT_CONFIG,
    ...config,
    oauth: { ...DEFAULT_CONFIG.oauth, ...(config.oauth || {}) },
    updatedAt: Date.now()
  };
  ensureDir(PKGETC);
  const tmp = CONFIG_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  return next;
}

/** 敏感字段是否已配置（不下发具体值给前端） */
function publicConfig(config) {
  return {
    appName: APP_NAME,
    version: APP_VERSION,
    timezone: config.timezone,
    retentionDays: config.retentionDays,
    allowPrivateRepos: config.allowPrivateRepos,
    defaultTheme: config.defaultTheme,
    exportToShare: config.exportToShare,
    githubApiBase: config.githubApiBase || "",
    themes: THEMES,
    oauthConfigured: Boolean(config.oauth.clientId && config.oauth.clientSecret),
    oauthClientId: config.oauth.clientId ? maskSecret(config.oauth.clientId, 6) : "",
    publicBaseUrl: config.oauth.publicBaseUrl || "",
    gatewayPrefix: GATEWAY_PREFIX,
    shareDir: SHARE_DIR,
    isDev: IS_DEV
  };
}

function maskSecret(value, keep) {
  const s = String(value || "");
  if (s.length <= keep * 2) return "*".repeat(s.length);
  return s.slice(0, keep) + "…" + s.slice(-keep);
}

/** 获取（必要时生成）用于加密 GitHub Token 的本地密钥 */
function getSecretKey() {
  try {
    if (fs.existsSync(SECRET_KEY_FILE)) {
      const hex = fs.readFileSync(SECRET_KEY_FILE, "utf8").trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, "hex");
    }
  } catch (e) {
    /* fallthrough */
  }
  const key = crypto.randomBytes(32);
  try {
    ensureDir(PKGETC);
    fs.writeFileSync(SECRET_KEY_FILE, key.toString("hex"), { mode: 0o600 });
  } catch (e) {
    /* 无法落盘时使用内存密钥，进程重启后需要用户重新授权 */
  }
  return key;
}

const SECRET_KEY = getSecretKey();

/** AES-256-GCM 加密，用于存放 GitHub access token */
function encryptSecret(plain) {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", SECRET_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decryptSecret(payload) {
  if (!payload || typeof payload !== "string") return "";
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return "";
  try {
    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const data = Buffer.from(parts[3], "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", SECRET_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch (e) {
    return "";
  }
}

module.exports = {
  APP_NAME,
  APP_VERSION,
  RUNTIME_USER,
  IS_DEV,
  SERVER_DIR,
  APPDEST,
  PKGVAR,
  PKGETC,
  PKGTMP,
  PKGHOME,
  DATA_DIR,
  PUBLIC_DIR,
  SHARE_DIR,
  GATEWAY_PREFIX,
  SOCKET_PATH,
  HTTP_PORT,
  THEMES,
  DEFAULT_CONFIG,
  initDirs,
  ensureDir,
  readConfig,
  writeConfig,
  publicConfig,
  encryptSecret,
  decryptSecret
};
