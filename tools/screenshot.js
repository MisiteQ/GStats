// 开发用：用 Playwright 驱动本机 Edge 截图，检查界面渲染效果
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.env.BASE || "http://127.0.0.1:8899/app/gstats/";
const OUT = process.env.OUT || path.join(__dirname, "..", "shots");

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });

  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push("[console] " + msg.text());
  });
  page.on("pageerror", (err) => errors.push("[pageerror] " + err.message));

  async function shot(name, hash, waitMs) {
    await page.goto(BASE + (hash || ""), { waitUntil: "networkidle" });
    if (hash) {
      await page.evaluate((h) => { window.location.hash = h; }, hash);
    }
    await page.waitForTimeout(waitMs || 1500);
    const file = path.join(OUT, name + ".png");
    await page.screenshot({ path: file, fullPage: false });
    const title = await page.evaluate(() => (document.querySelector(".topbar h1") || {}).textContent || "");
    console.log(`✔ ${name}.png  (页面标题: ${title})`);
  }

  await shot("01-overview-light", "", 1800);
  await page.waitForTimeout(300);

  // 深色主题
  await page.evaluate(() => localStorage.setItem("gstats.theme", "deepspace"));
  await shot("02-overview-dark", "", 1800);

  await page.evaluate(() => localStorage.setItem("gstats.theme", "bamboo"));
  await shot("03-overview-bamboo", "", 1600);

  await page.evaluate(() => localStorage.setItem("gstats.theme", "moonlight"));
  await shot("04-stats", "#/stats", 1800);
  await shot("05-reports", "#/reports", 1800);
  await shot("06-settings", "#/settings", 1800);
  await shot("07-github-login", "#/github", 1600);
  await shot("08-explore", "#/explore", 1600);
  await shot("09-repo-tracked", "#/repo/microsoft/vscode", 2500);

  // 回到概览确认刚才的浏览已被统计
  await shot("10-overview-after-view", "", 2000);

  console.log("\n--- 控制台错误 ---");
  if (!errors.length) console.log("无");
  else errors.slice(0, 20).forEach((e) => console.log(e));

  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
