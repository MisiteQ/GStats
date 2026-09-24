// 开发用：模拟 GitHub API 网络中断，验证「我的 GitHub」页面显示错误卡片而非无限加载
const { chromium } = require("playwright-core");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = "http://127.0.0.1:8899/app/gstats/";
const OUT = path.join(__dirname, "..", "shots");

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push("[pageerror] " + err.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("[console] " + m.text()); });

  // 正常的 /api/me：已关联 GitHub
  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: {
        ok: true,
        identity: { uid: "1000", fnosUsername: "MisiteQ", isAdmin: true, viaGateway: true },
        github: { login: "MisiteQ", name: "Misite 齊", avatarUrl: "" },
        linked: true, authMethod: "oauth", lastLoginAt: Date.now(), loginCount: 12,
        system: { appName: "gstats", version: "1.0.1", timezone: "Asia/Shanghai", retentionDays: 365,
          allowPrivateRepos: true, defaultTheme: "moonlight", exportToShare: true,
          themes: [{ id: "moonlight", name: "明月", mode: "light", accent: "#2563eb" }],
          oauthConfigured: true, oauthClientId: "Ov23liExample", publicBaseUrl: "", gatewayPrefix: "/app/gstats",
          shareDir: "/vol1/@appdata/gstats/share", isDev: true }
      }
    })
  );
  // 关键：GitHub 接口全部网络中断（route.abort 模拟 fetch reject）
  await page.route("**/api/github/**", (route) => route.abort("connectionrefused"));
  // 其余统计接口给空数据兜底
  await page.route("**/api/stats/**", (route) => route.fulfill({ json: { ok: true, days: [], totals: {}, items: [] } }));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { window.location.hash = "#/github"; });
  await page.waitForTimeout(2500);
  const hasErrorCard = await page.$("#retryRoute");
  const stillLoading = await page.$(".loading-row");
  console.log("错误卡片出现:", Boolean(hasErrorCard) ? "是 ✅" : "否 ❌");
  console.log("仍在加载态:", stillLoading ? "是 ❌" : "否 ✅");
  await page.screenshot({ path: path.join(OUT, "19-github-error-card.png") });

  // 点击重试仍然在错误态（网络仍断），但不应抛未处理异常
  if (hasErrorCard) {
    await hasErrorCard.click();
    await page.waitForTimeout(1200);
    console.log("重试后仍稳定:", (await page.$("#retryRoute")) ? "是 ✅" : "否 ❌");
  }
  console.log("JS 错误:", errors.length ? errors.join("\n") : "无 ✅");
  await browser.close();
})();
