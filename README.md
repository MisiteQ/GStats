> 本项目使用AI开发，初次开发，数据的测试自己不能完成，希望大家安装之后有什么问题及时反馈，我好使用AI工具调整。

# GStats — 飞牛 fnOS GitHub 仓库流量统计平台

GStats 是一个原生飞牛 NAS（fnOS）fpk 应用。安装后在 fnOS 桌面以窗口化 Web 应用打开，
用户无需登录即可搜索、浏览 GitHub 公开仓库；绑定自己的 GitHub 账号后，系统通过
**GitHub 官方 Repo Traffic API** 自动统计仓库的**外部访客**数据：

- **浏览量（PV）与独立访客（UV）**：仓库页面每天被多少外部访客浏览
- **克隆数据**：git clone / 下载的次数与去重克隆者数
- **来源网站 / 热门路径**：外部访客从哪些网站跳转、访问了哪些页面
- GitHub 官方只保留近 14 天数据，GStats 每 6 小时自动抓取并在本地**每日快照存档**，长期可回溯
- 一键导出 **CSV / JSON / HTML** 三种报表

> 统计口径为「访问你 GitHub 仓库的外部访客」，**不记录任何 NAS 用户在应用内的浏览行为**。

内置 **8 套主题色**（4 浅 4 深），可全局指定默认主题，用户也可自行切换并本地记忆。

---

## 目录结构

```
GStats/
├── fnos/                  # FPK 打包源目录（核心交付物）
│   ├── manifest           # 应用元信息
│   ├── ICON.PNG / ICON_256.PNG
│   ├── LICENSE
│   ├── config/
│   │   ├── privilege      # 权限声明（nodejs_v22 运行时）
│   │   └── resource       # 资源声明
│   ├── app/
│   │   ├── server/        # 零依赖 Node.js 后端（node:http + Unix Socket）
│   │   │   ├── server.js  # 入口：静态资源 + REST API
│   │   │   ├── lib/       # config / store / github / auth / report / util
│   │   │   ├── public/    # 原生 JS 单页前端（8 主题）
│   │   │   └── tools/apply-wizard.js
│   │   └── ui/
│   │       ├── config     # 桌面入口（url 型，窗口化打开）
│   │       └── images/    # 桌面入口图标
│   ├── cmd/               # 9 个生命周期脚本（main / install / upgrade / uninstall / config）
│   └── wizard/            # 安装向导 + 配置向导（GitHub OAuth 凭据等）
├── tools/                 # 构建与开发辅助脚本
├── dist/                  # 打包产物
│   ├── gstats_1.2.2_x86.fpk   # x86 专用包（platform=x86）
│   └── gstats_1.2.2_arm.fpk   # ARM 专用包（platform=arm）
└── .ref/ALL_DOCS.md       # 飞牛官方开发文档合集（参考用）
```

## 技术特点

- **零 npm 依赖**：后端仅用 Node.js 内置模块（`http` / `crypto` / `zlib` 等），
  通过 fnOS 统一网关的 Unix Socket 对外服务，无端口冲突问题。
- **原生 fpk**：遵循飞牛官方规范，`fnpack` 直接打包，无 Docker。
- **数据落盘**：流量快照存储于 `traffic.json`（每日 PV/UV/克隆 + 近 14 天来源/路径滚动快照），位于应用 var 目录（`TRIM_PKGVAR`），升级保留。
- **Token 加密存储**：GitHub OAuth token 使用机器绑定密钥 AES 加密后落盘。

## 安装

1. 打开飞牛 fnOS 的 **App Center（应用中心）→ 手动安装**，上传 `dist/gstats_1.2.2_x86.fpk`（x86 设备）或 `dist/gstats_1.2.2_arm.fpk`（ARM 设备）。
2. 安装向导会依次要求：
   - **GitHub 应用凭据**：在 [GitHub → Settings → Developer settings → OAuth Apps → New OAuth App](https://github.com/settings/developers) 创建应用，
     - Homepage URL：`http://你的NAS地址/app/gstats/`
     - Authorization callback URL：`http://你的NAS地址/app/gstats/api/auth/github/callback`
     - 把生成的 **Client ID / Client Secret** 填入向导。
   - **统计与数据**：时区（默认 Asia/Shanghai）、明细保留天数、是否允许读取私有仓库。
   - **外观**：默认主题色。
3. 安装完成后在 fnOS 桌面点击 GStats 图标，窗口化打开。

> 没有创建 OAuth App 也可以使用：在「我的 GitHub」页改用 **Personal Access Token** 登录
> （Token 只用于读取 GitHub API 与 Traffic 流量数据）。

## 功能说明

| 页面 | 功能 |
| --- | --- |
| 概览 | 今日/区间 PV、UV、克隆、仓库数卡片，每日 PV/UV 双系列柱状图，仓库浏览 TOP10，来源网站 TOP10，同步状态与手动立即同步 |
| 我的 GitHub | OAuth / PAT 登录，浏览自己的仓库与仓库详情；登录后自动触发一次流量同步 |
| 发现项目 | 免登录搜索、浏览任意 GitHub 公开仓库 |
| 统计明细 | 仓库流量 / 每日流量 / 来源网站 / 热门路径四个维度的明细表 |
| 报表导出 | `daily` / `repos` / `referrers` / `paths` 四类报表，`CSV` / `JSON` / `HTML` 三种格式，可保存到 NAS 共享目录 |
| 设置 | 管理员修改 OAuth 凭据 / 时区 / 保留天数 / 默认主题，并查看数据量与同步状态 |

### 统计口径

- **浏览量（PV）**：GitHub 官方统计的仓库页面浏览次数（外部访客）。
- **独立访客（UV）**：GitHub 按「单仓库 + 单日」去重；跨仓库/跨天只能累加，界面中均标注为「每日 UV 累计」。
- **克隆**：仓库被 `git clone` 或下载 ZIP 的次数与去重克隆者数。
- **来源网站 / 热门路径**：GitHub 仅提供近 14 天滚动快照，不支持自定义时间区间。
- **权限**：Traffic API 只对调用者拥有 **push（推送）权限**的仓库返回数据，无权限仓库自动跳过（GitHub 返回 404）。
- **同步**：账号绑定 3 秒后自动同步一次，服务启动 45 秒后、之后每 6 小时全量同步一次，也可在概览页手动触发。

## 主题

8 套主题：明月（浅·天青）、青竹（浅·翠绿）、紫藤（浅·紫罗兰）、暖阳（浅·琥珀）、
深空（深·靛蓝）、青碧（深·湖蓝）、夜幕（深·玫瑰）、石墨（深·中性）。
右上角调色板即时切换，选择保存在浏览器本地；管理员可在向导/设置中指定默认值。

## 开发调试

```bash
# 本地起服务（不依赖 fnOS，数据写入 .devdata/）
cd fnos/app/server
GSTATS_PORT=8899 node server.js
# 浏览器打开 http://127.0.0.1:8899/app/gstats/

# 打包：产出 x86 + ARM 两份到 dist/
node tools/build.js x86 arm
# 也可只打指定架构
node tools/build.js x86
node tools/build.js arm
```

> `fnpack` 的产物名固定为 `gstats.fpk`，架构变体通过暂存目录 `.build/<arch>/fnos`
> 改写 manifest 的 `platform` 字段后打包，最终统一重命名为
> **`<应用名>_<版本>_<架构>.fpk`**（版本号自动取自 `manifest` 的 `version` 字段），
> 例如 `gstats_1.2.2_x86.fpk`。发版时只需改 manifest 的 `version`，包名自动跟随。

## 架构说明

飞牛 fnOS 的 `platform` 字段取值为 `x86`（x86 设备）/ `arm`（ARM 设备）。

GStats 的后端是纯 JavaScript（运行在 fnOS 提供的 `nodejs_v22` 运行时上），
脚本也均为 `bash`，**不含任何架构相关二进制**，x86 与 ARM 包内容一致，仅 `platform` 声明不同：

- x86 设备安装 `dist/gstats_1.2.2_x86.fpk`
- ARM 设备安装 `dist/gstats_1.2.2_arm.fpk`

## 网络受限环境（无法访问 api.github.com）

OAuth 登录走 `github.com`，而资料 / 仓库等数据走 `api.github.com`——部分网络环境下
后者不可达，会表现为「登录成功但页面一直加载」。v1.2.0 起：

- 加载失败会在 **15 秒内给出明确的错误卡片和重试按钮**，不再无限转圈；
- 管理员可在「设置 → GitHub OAuth」中填写 **GitHub API 地址（镜像 / 反代）**，
  例如自建反代 `https://gh-api.example.com`，填写后所有 GitHub API 请求改走该地址
  （需完整兼容 GitHub REST API v3，`/user`、`/user/repos`、`/repos/*` 等端点）。

## 版本约定

- 版本号定义在 `fnos/manifest` 的 `version` 字段，应用内「设置 → 关于」与 health 接口
  会自动读取展示，无需另行修改。
- **每次代码修改按升级类型递增版本号**：缺陷修复 → patch（1.0.x），
  新功能 → minor（1.x.0），破坏性变更 → major（x.0.0）。
  打包脚本自动把版本号写进产物文件名 `gstats_<版本>_<架构>.fpk`。

### 生命周期脚本约定

- `cmd/main`：`start / stop / status`，PID 与日志写在 `${TRIM_PKGVAR}`。
- `cmd/install_callback`：把向导环境变量经 `tools/apply-wizard.js` 合并进
  `${TRIM_PKGETC}/config.json`，然后启动服务。
- `cmd/config_callback`：设置向导提交后同样合并配置并重启服务。

### 已知注意事项

- fnpack 1.2.3 对 `wizard` 文件的 `switch` 类型不接受布尔 `initValue`，
  需写成字符串 `"true"` / `"false"`（本项目已处理）。
- OAuth callback 地址必须与 GitHub OAuth App 中配置的完全一致，含端口与路径前缀 `/app/gstats/`。
- 对外反代（HTTPS / 域名）场景请在向导中填写「对外访问地址」，否则按请求 Host 自动推导。

## 开发者

- **开发者**：Misite齊
- **GitHub**：<https://github.com/MisiteQ>
- **问题反馈 / 功能建议**：欢迎到 GitHub 提交 Issue 或 PR。

## License

MIT © Misite齊 (<https://github.com/MisiteQ>)
