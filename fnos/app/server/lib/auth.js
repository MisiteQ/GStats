"use strict";

/**
 * 身份识别与授权流程。
 *
 * 身份来源：飞牛 fnOS 统一网关在转发请求时注入的 Header
 *   X-Trim-Userid / X-Trim-Username / X-Trim-Isadmin
 * 应用侧不信任客户端自行传入的用户 ID。
 */

const crypto = require("crypto");
const config = require("./config");

const STATE_TTL_MS = 10 * 60 * 1000;
const states = new Map();

function resolveIdentity(req) {
  const h = req.headers || {};
  const rawUid = h["x-trim-userid"];
  const username = h["x-trim-username"] || "";
  const isAdmin = String(h["x-trim-isadmin"] || "").toLowerCase() === "true";

  if (rawUid !== undefined && rawUid !== null && String(rawUid).length > 0) {
    return {
      uid: String(rawUid),
      username: String(username),
      isAdmin,
      viaGateway: true
    };
  }

  // 开发调试：本机直接访问时视为管理员
  return {
    uid: "local",
    username: username ? String(username) : "dev",
    isAdmin: true,
    viaGateway: false
  };
}

function createState(uid) {
  const token = crypto.randomBytes(24).toString("hex");
  states.set(token, { uid: String(uid), createdAt: Date.now() });
  pruneStates();
  return token;
}

function consumeState(token) {
  if (!token) return null;
  const item = states.get(String(token));
  if (!item) return null;
  states.delete(String(token));
  if (Date.now() - item.createdAt > STATE_TTL_MS) return null;
  return item;
}

function pruneStates() {
  const now = Date.now();
  for (const [key, item] of states.entries()) {
    if (now - item.createdAt > STATE_TTL_MS) states.delete(key);
  }
}

function requestOrigin(req) {
  const h = req.headers || {};
  const proto = String(h["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  const host = String(h["x-forwarded-host"] || h.host || "").split(",")[0].trim();
  return host ? `${proto}://${host}` : "";
}

/** OAuth 回调地址：优先使用显式配置的对外地址，否则根据当前请求推断 */
function buildRedirectUri(req, cfg) {
  const base = (cfg.oauth.publicBaseUrl || requestOrigin(req) || "").replace(/\/+$/, "");
  return `${base}${config.GATEWAY_PREFIX}/api/auth/github/callback`;
}

/** 根据是否允许访问私有仓库决定申请的权限范围 */
function buildScope(cfg) {
  const base = ["read:user", "user:email"];
  if (cfg.allowPrivateRepos) base.push("repo");
  return Array.from(new Set(base)).join(",");
}

module.exports = {
  resolveIdentity,
  createState,
  consumeState,
  buildRedirectUri,
  buildScope,
  requestOrigin
};
