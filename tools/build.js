"use strict";

/**
 * 构建脚本：把 fnos/ 目录交给飞牛官方打包工具 fnpack，产出 gstats.fpk。
 *
 * 前置条件：
 *   1. 已安装 Node.js（本工程无 npm 依赖，无需 install）
 *   2. 已下载 fnpack（见 README），默认放在 .tools/fnpack.exe
 *
 * 用法：
 *   node tools/build.js                # 按 manifest 原样打包（platform=all）-> dist/gstats_<版本>_all.fpk
 *   node tools/build.js x86 arm        # 架构专用包 -> dist/gstats_<版本>_x86.fpk / gstats_<版本>_arm.fpk
 *   node tools/build.js all            # 只打通用包
 *
 * 说明：fnpack 的产物文件名固定为 <appname>.fpk，架构与版本变体通过临时暂存目录
 * （.build/<arch>/fnos）改写 manifest 的 platform 字段后打包，再重命名为
 * <appname>_<version>_<arch>.fpk（版本号取自 manifest 的 version 字段）。
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PACK_DIR = path.join(ROOT, "fnos");
const DIST_DIR = path.join(ROOT, "dist");
const STAGE_ROOT = path.join(ROOT, ".build");
const ARCHES = ["all", "x86", "arm"];

/** 从 manifest 读取键值（manifest 为 key = value 文本格式） */
function manifestField(text, key) {
  const m = text.match(new RegExp("^\\s*" + key + "\\s*=\\s*(.*)$", "m"));
  return m ? m[1].trim() : "";
}

/** 应用名与版本号用于产物命名 */
function readIdentity() {
  const text = fs.readFileSync(path.join(PACK_DIR, "manifest"), "utf8");
  const appname = manifestField(text, "appname") || "app";
  const version = manifestField(text, "version") || "0.0.0";
  return { appname, version };
}

const FNPACK_CANDIDATES = [
  process.env.FNPACK,
  path.join(ROOT, ".tools", "fnpack.exe"),
  path.join(ROOT, ".tools", "fnpack"),
  "fnpack"
].filter(Boolean);

function findFnpack() {
  for (const candidate of FNPACK_CANDIDATES) {
    try {
      execFileSync(candidate, ["--help"], { stdio: "ignore" });
      return candidate;
    } catch (e) {
      /* try next */
    }
  }
  return null;
}

function checkPrerequisites() {
  const required = ["manifest", "config/privilege", "config/resource", "app", "cmd", "wizard", "ICON.PNG", "ICON_256.PNG"];
  const missing = required.filter((rel) => !fs.existsSync(path.join(PACK_DIR, rel)));
  if (missing.length) {
    console.error("[build] 缺少必要文件：" + missing.join(", "));
    process.exit(1);
  }
  const uiConfig = path.join(PACK_DIR, "app", "ui", "config");
  const entry = JSON.parse(fs.readFileSync(uiConfig, "utf8"));
  const firstKey = Object.keys(entry[".url"])[0];
  const icons = entry[".url"][firstKey].icon.replace("{0}", "64");
  if (!fs.existsSync(path.join(PACK_DIR, "app", "ui", icons))) {
    console.error("[build] 缺少桌面入口图标：" + icons);
    process.exit(1);
  }
  // 开发数据目录绝不能进入 FPK
  const devData = path.join(PACK_DIR, "app", "server", ".devdata");
  if (fs.existsSync(devData)) {
    console.error("[build] 检测到 " + path.relative(ROOT, devData) + "，请先移出打包目录再构建");
    process.exit(1);
  }
  console.log("[build] 前置检查通过");
}

/** 把 fnos/ 复制为架构专用暂存目录，并改写 manifest 的 platform 字段 */
function stageFor(arch) {
  const stage = path.join(STAGE_ROOT, arch);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const dest = path.join(stage, "fnos");
  fs.cpSync(PACK_DIR, dest, {
    recursive: true,
    filter: (src) => !/(^|[\\/])\.devdata([\\/]|$)/.test(src) && !/(^|[\\/])\.git([\\/]|$)/.test(src)
  });
  const manifestPath = path.join(dest, "manifest");
  const src = fs.readFileSync(manifestPath, "utf8");
  const patched = src.replace(/^platform\s*=.*$/m, "platform = " + arch);
  if (patched === src && !/^platform\s*=/m.test(src)) {
    throw new Error("manifest 缺少 platform 字段");
  }
  fs.writeFileSync(manifestPath, patched, "utf8");
  return dest;
}

/**
 * 打包一个架构变体。
 * arch = "all" 时直接打包 fnos/（不改写 manifest）；
 * 产物统一重命名为 <appname>_<version>_<arch>.fpk。
 */
function buildArch(arch, fnpack, identity) {
  const isDefault = arch === "all";
  const source = isDefault ? PACK_DIR : stageFor(arch);
  const args = ["build", "--directory", source];
  console.log("\n[build] === " + arch + " ===");
  console.log("[build] " + path.basename(fnpack) + " " + args.join(" "));
  execFileSync(fnpack, args, { stdio: "inherit", cwd: DIST_DIR });

  const raw = path.join(DIST_DIR, "gstats.fpk");
  if (!fs.existsSync(raw)) {
    console.error("[build] " + arch + "：未找到生成的 gstats.fpk");
    process.exit(1);
  }
  const out = path.join(DIST_DIR, identity.appname + "_" + identity.version + "_" + arch + ".fpk");
  if (path.resolve(out) !== path.resolve(raw)) {
    fs.rmSync(out, { force: true });
    fs.renameSync(raw, out);
    // 清理旧命名格式的残留产物，避免混淆
    fs.rmSync(path.join(DIST_DIR, "gstats-" + arch + ".fpk"), { force: true });
    fs.rmSync(path.join(DIST_DIR, "gstats-all.fpk"), { force: true });
  }
  console.log("[build] 产物：" + out);
  return out;
}

function main() {
  checkPrerequisites();

  const fnpack = findFnpack();
  if (!fnpack) {
    console.error(
      "[build] 未找到 fnpack。请从 https://developer.fnnas.com/docs/cli/fnpack/ 下载，\n" +
        "        放到 .tools/fnpack.exe，或通过环境变量 FNPACK 指定路径。"
    );
    process.exit(1);
  }
  console.log("[build] 使用打包工具：" + fnpack);

  const identity = readIdentity();
  console.log("[build] 应用：" + identity.appname + " v" + identity.version);

  // 参数：未指定时默认打包 manifest 原样（platform=all） + x86 + arm 三份
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const targets = argv.length ? argv : ARCHES.slice();
  const invalid = targets.filter((a) => !ARCHES.includes(a));
  if (invalid.length) {
    console.error("[build] 不支持的架构：" + invalid.join(", ") + "（可选 " + ARCHES.join(" / ") + "）");
    process.exit(1);
  }
  // 通用包产物名固定为 gstats.fpk，必须最后构建，避免被架构变体重命名时覆盖
  targets.sort((a, b) => (a === "all" ? 1 : 0) - (b === "all" ? 1 : 0));

  fs.mkdirSync(DIST_DIR, { recursive: true });

  const outputs = targets.map((arch) => buildArch(arch, fnpack, identity));

  fs.rmSync(STAGE_ROOT, { recursive: true, force: true });

  console.log("\n[build] 完成，共 " + outputs.length + " 个产物：");
  for (const file of outputs) {
    if (!fs.existsSync(file)) {
      console.error("  " + path.relative(ROOT, file) + "  ✗ 缺失");
      process.exit(1);
    }
    const kb = (fs.statSync(file).size / 1024).toFixed(1);
    console.log("  " + path.relative(ROOT, file) + "  " + kb + " KB");
  }
}

main();
