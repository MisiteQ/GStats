#!/usr/bin/env node
"use strict";

/**
 * 安装 / 升级 / 设置向导参数落盘工具。
 *
 * 飞牛 fnOS 会把向导中收集的字段以环境变量形式传给生命周期脚本，
 * 本脚本负责把它们合并进 ${TRIM_PKGETC}/config.json，
 * 这样应用服务重启后仍能读到配置（向导变量本身不保证长期存在）。
 */

const fs = require("fs");
const config = require("../lib/config");

function envValue(...names) {
  for (const name of names) {
    const v = process.env[name];
    if (v !== undefined && v !== null && String(v).length > 0) return String(v);
  }
  return "";
}

function truthy(value) {
  const s = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on", "是"].includes(s);
}

function main() {
  config.initDirs();

  const current = (function readRaw() {
    try {
      const raw = fs.existsSync(config.PKGETC + "/config.json")
        ? fs.readFileSync(config.PKGETC + "/config.json", "utf8")
        : "";
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  })();

  const next = {
    ...config.DEFAULT_CONFIG,
    ...current,
    oauth: { ...config.DEFAULT_CONFIG.oauth, ...(current.oauth || {}) }
  };

  const clientId = envValue("wizard_oauth_client_id", "GSTATS_OAUTH_CLIENT_ID");
  const clientSecret = envValue("wizard_oauth_client_secret", "GSTATS_OAUTH_CLIENT_SECRET");
  const baseUrl = envValue("wizard_public_base_url", "GSTATS_PUBLIC_BASE_URL");
  const timezone = envValue("wizard_timezone", "GSTATS_TIMEZONE");
  const retention = envValue("wizard_retention_days", "GSTATS_RETENTION_DAYS");
  const privateRepos = envValue("wizard_allow_private_repos", "GSTATS_ALLOW_PRIVATE_REPOS");
  const theme = envValue("wizard_default_theme", "GSTATS_DEFAULT_THEME");

  if (clientId) next.oauth.clientId = clientId;
  if (clientSecret) next.oauth.clientSecret = clientSecret;
  if (baseUrl !== undefined) next.oauth.publicBaseUrl = baseUrl.replace(/\/+$/, "");

  if (timezone) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
      next.timezone = timezone;
    } catch (e) {
      console.error(`[apply-wizard] 忽略无效时区：${timezone}`);
    }
  }

  if (retention) {
    const n = Number.parseInt(retention, 10);
    if (Number.isFinite(n) && n >= 7) next.retentionDays = n;
  }

  if (privateRepos) next.allowPrivateRepos = truthy(privateRepos);

  if (theme && (theme === "auto" || config.THEMES.some((t) => t.id === theme))) {
    next.defaultTheme = theme;
  }

  config.writeConfig(next);
  console.log(
    `[apply-wizard] config written: oauth=${next.oauth.clientId ? "yes" : "no"}, tz=${next.timezone}, retention=${next.retentionDays}d, theme=${next.defaultTheme}`
  );
}

main();
