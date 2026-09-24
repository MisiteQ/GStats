// 开发用：模拟 GitHub 接口，验证「我的 GitHub」与仓库详情页的完整渲染
const { chromium } = require("playwright-core");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = "http://127.0.0.1:8899/app/gstats/";
const OUT = path.join(__dirname, "..", "shots");

const REPO = {
  id: 1, name: "vscode", full_name: "microsoft/vscode", private: false, fork: false, archived: false,
  owner: { login: "microsoft", avatar_url: "https://avatars.githubusercontent.com/u/6154722?v=4" },
  description: "Visual Studio Code. Open source under the MIT license.",
  html_url: "https://github.com/microsoft/vscode", homepage: "https://code.visualstudio.com",
  language: "TypeScript", stargazers_count: 165000, forks_count: 30100, open_issues_count: 9200,
  size: 1200000, default_branch: "main", topics: ["editor", "typescript", "electron"],
  updated_at: "2026-09-23T10:00:00Z", pushed_at: "2026-09-23T09:00:00Z", created_at: "2015-09-03T00:00:00Z"
};

const README = `# Visual Studio Code

> 轻量但强大的源代码编辑器，支持 **Windows**、*macOS* 与 Linux。

## 快速开始

1. 克隆仓库 \`git clone https://github.com/microsoft/vscode\`
2. 安装依赖 \`npm install\`
3. 启动 \`npm run watch\`

- [x] 已支持中文
- [ ] 待办：性能分析

| 特性 | 说明 |
| --- | --- |
| 智能补全 | 基于 Language Server |
| 调试 | 内置 Node / Chrome |

\`\`\`js
const a = 1;
console.log(a + 1);
\`\`\`

[文档](https://code.visualstudio.com/docs) · [参与贡献](CONTRIBUTING.md)`;

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push("[pageerror] " + err.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("[console] " + m.text()); });

  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: {
        ok: true,
        identity: { uid: "1000", fnosUsername: "qixingkun", isAdmin: true, viaGateway: true },
        github: { login: "qixingkun", name: "Misite 齊", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" },
        linked: true, authMethod: "oauth", lastLoginAt: Date.now(), loginCount: 12,
        system: {
          appName: "gstats", version: "1.0.0", timezone: "Asia/Shanghai", retentionDays: 365,
          allowPrivateRepos: true, defaultTheme: "moonlight", exportToShare: true,
          themes: [{ id: "moonlight", name: "明月", mode: "light", accent: "#2563eb" }],
          oauthConfigured: true, oauthClientId: "Ov23liExample", publicBaseUrl: "", gatewayPrefix: "/app/gstats",
          shareDir: "/vol1/@appdata/gstats/share", isDev: true
        }
      }
    })
  );
  await page.route("**/api/github/profile", (route) =>
    route.fulfill({
      json: { ok: true, data: { login: "qixingkun", name: "Misite 齊", avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
        html_url: "https://github.com/qixingkun", bio: "自建 NAS 爱好者 · 喜欢折腾", public_repos: 42, followers: 128, following: 66, location: "Shenzhen" } }
    })
  );
  await page.route("**/api/github/repos?*", (route) =>
    route.fulfill({
      json: { ok: true, total: 42, page: 1, perPage: 30, hasMore: true, items: [
        { id: 1, name: "gstats", fullName: "qixingkun/gstats", owner: "qixingkun", ownerAvatar: "", description: "GitHub 使用统计平台", htmlUrl: "", homepage: "", language: "JavaScript", private: false, fork: false, archived: false, stars: 128, forks: 12, watchers: 128, openIssues: 2, size: 1024, defaultBranch: "main", topics: [], updatedAt: "2026-09-23T00:00:00Z", pushedAt: "2026-09-23T00:00:00Z", createdAt: "" },
        { id: 2, name: "home-lab", fullName: "qixingkun/home-lab", owner: "qixingkun", ownerAvatar: "", description: "家庭实验室配置与自动化脚本", htmlUrl: "", homepage: "", language: "Shell", private: true, fork: false, archived: false, stars: 0, forks: 0, watchers: 1, openIssues: 0, size: 512, defaultBranch: "main", topics: [], updatedAt: "2026-09-20T00:00:00Z", pushedAt: "2026-09-20T00:00:00Z", createdAt: "" },
        { id: 3, name: "dotfiles", fullName: "qixingkun/dotfiles", owner: "qixingkun", ownerAvatar: "", description: "我的开发环境配置", htmlUrl: "", homepage: "", language: "Vim Script", private: false, fork: true, archived: false, stars: 3, forks: 1, watchers: 3, openIssues: 0, size: 64, defaultBranch: "main", topics: [], updatedAt: "2026-08-01T00:00:00Z", pushedAt: "2026-08-01T00:00:00Z", createdAt: "" }
      ] }
    })
  );
  await page.route("**/api/github/repos/microsoft/vscode", (route) =>
    route.fulfill({ json: { ok: true, repo: {
      id: 1, name: "vscode", fullName: "microsoft/vscode", owner: "microsoft", ownerAvatar: REPO.owner.avatar_url,
      description: REPO.description, htmlUrl: REPO.html_url, homepage: REPO.homepage, language: "TypeScript",
      private: false, fork: false, archived: false, stars: REPO.stargazers_count, forks: REPO.forks_count,
      watchers: REPO.stargazers_count, openIssues: REPO.open_issues_count, size: REPO.size,
      defaultBranch: "main", topics: REPO.topics, updatedAt: REPO.updated_at, pushedAt: REPO.pushed_at, createdAt: REPO.created_at
    }, languages: { TypeScript: 72, JavaScript: 18, CSS: 6, HTML: 4 } } })
  );
  await page.route("**/api/github/repos/microsoft/vscode/readme", (route) =>
    route.fulfill({ json: { ok: true, readme: { name: "README.md", content: README, htmlUrl: "" } } })
  );
  await page.route("**/api/github/repos/microsoft/vscode/issues", (route) =>
    route.fulfill({ json: { ok: true, items: [
      { number: 240001, title: "Editor hangs when opening large file", state: "open", user: "someone", comments: 5, createdAt: "", updatedAt: "2026-09-22T00:00:00Z", htmlUrl: "", labels: ["bug", "performance"] },
      { number: 239987, title: "支持在终端中使用 IME 输入中文", state: "open", user: "another", comments: 2, createdAt: "", updatedAt: "2026-09-21T00:00:00Z", htmlUrl: "", labels: ["i18n"] }
    ] } })
  );
  await page.route("**/api/github/repos/microsoft/vscode/commits", (route) =>
    route.fulfill({ json: { ok: true, items: [
      { sha: "a1b2c3d", message: "fix: improve search performance", author: "someone", date: "2026-09-23T08:00:00Z", htmlUrl: "" },
      { sha: "e4f5g6h", message: "feat: add new color theme API", author: "other", date: "2026-09-22T08:00:00Z", htmlUrl: "" }
    ] } })
  );

  async function shot(name, hash, wait) {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    if (hash) await page.evaluate((h) => { window.location.hash = h; }, hash);
    await page.waitForTimeout(wait || 1600);
    await page.screenshot({ path: path.join(OUT, name + ".png") });
    console.log(`✔ ${name}.png`);
  }

  await shot("11-github-linked", "#/github");
  await shot("12-repo-detail", "#/repo/microsoft/vscode", 2200);
  await page.evaluate(() => document.querySelectorAll("#repoTabs button")[1].click());
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, "13-repo-issues.png") });
  console.log("✔ 13-repo-issues.png");

  console.log("\n--- 错误 ---");
  const real = errors.filter((e) => !e.includes("428") && !e.includes("Failed to load resource"));
  console.log(real.length ? real.slice(0, 15).join("\n") : "无");
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
