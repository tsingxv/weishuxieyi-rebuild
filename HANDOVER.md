# 快速上手 · 移交文档（HANDOVER）

> 写给接下来接手这个项目的人。10 分钟能跑起来，20 分钟能看懂结构。
> 本文档只讲"怎么接手"；功能怎么玩见 [PLAYING.md](docs/PLAYING.md)，架构见 [DESIGN.md](docs/DESIGN.md)。

---

## 1. 这是什么

《明日方舟》「卫戍协议：盟约」的**非官方同人复刻**：浏览器自走棋塔防，单人或 1–4 人联机合作。
战斗在各玩家的浏览器里模拟，服务器只做回合/经济与校验（DESIGN §14）。

**本仓库不是从零写的**：基于上游 [sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol)
继续开发，新增了大厅、本地持久档案与永久战绩、Windows 桌面客户端 exe、独立服务器 exe。详见 [NOTICE.md](NOTICE.md) 第 0 节。

**版权（务必先读）**：代码 GPL-3.0-or-later；游戏素材（美术 / 音乐 / 音效 / 文本 / 数据）归
上海鹰角网络科技有限公司（Hypergryph）及其许可方所有，Yostar 为海外发行方，**不在 GPL 范围内**。
仅限非商业使用，严禁任何形式盈利。仓库里**不含**游戏美术与音频（已 gitignore），完整声明见 [NOTICE.md](NOTICE.md)。

---

## 2. 三分钟跑起来（Windows）

```powershell
cd <本仓库目录>
npm ci                    # 安装依赖（postinstall 会把 pixi/preact/three 复制到 public/vendor）
npm run setup             # 下载约 250 MB 美术/音频（可中断续传）
npm start                 # 启动 → 浏览器自动打开 http://localhost:3000
```

也可以双击 `scripts\start-windows.bat`（自动完成上述检查）。终端会打印局域网地址（如
`http://192.168.x.x:3000`），发给同一路由器下的朋友即可联机。

要求：**Node.js 22 或 24**（LTS）。诊断用 `npm run doctor`。

---

## 3. 目录结构（本仓库相对上游新增了什么）

| 目录 / 文件 | 作用 | 来源 |
|---|---|---|
| `server/` | Node HTTP 静态服务 + WebSocket（`/ws`）、同盟房间（`lobby.js`）、对局引擎（`match/`）、战斗模拟（`sim/`） | 上游 |
| `server/hall.js` | **新增**：全服大厅（在线博士 / 房间码分享 / 频道聊天 / 全服最近战绩） | 本仓库 |
| `public/js/screens/hall.js` + `public/css/screens/hall.css` | **新增**：大厅界面（三栏：在线名单 / 房间+聊天 / 最近战绩） | 本仓库 |
| `public/js/ui/profile.js` | **新增**：本地持久档案（`profileId`、代号、访问次数） | 本仓库 |
| `public/js/ui/history.js` + `ui/myRecord.js` | **新增**：本地永久战绩（最近 50 局）与结算页「我的战绩」面板 | 本仓库 |
| `public/js/ui/clipboard.js` + `ui/inviteBanner.js` | **新增**：网页版剪贴板房间码识别与提示横幅 | 本仓库 |
| `client/` | **新增**：Windows 桌面客户端外壳（Electron）：本地静态服务 + `/ws` 隧道 + 服务器设置 + 剪贴板一键进房 | 本仓库 |
| `server-app/` | **新增**：独立服务器外壳（Electron）：内嵌 `startServer()`，控制面板直接复制 IP / 邀请链接 | 本仓库 |
| `shared/protocol.js`、`shared/constants.js` | 修改：新增 `hall.*` 协议（C2S `hall.enter/leave/chat`，S2C `hall.state/roster/chat`） | 本仓库 |
| `data/` | 由官方数据表生成的游戏数据（`npm run build-data` 再生成，勿手改） | 上游 |
| `docs/`、`test/`、`tools/`、`scripts/` | 文档、测试、工具、打包与启动脚本 | 上游 + 本仓库 |

wire 协议的权威说明在 `shared/protocol.js` 的注释块（搜「hall / 大厅」），DESIGN §8.1 也已同步。

---

## 4. 三个交付物及其打包命令

| 产物 | 命令 | 输出 | 给谁 |
|---|---|---|---|
| **Release 整合包**（解压即玩） | `npm run build-release -- --zip` | `dist/Stronghold-Protocol-v0.1.0.zip`（约 435 MB，解压后约 811 MB） | 只想开服 + 浏览器玩的人 |
| **桌面客户端 exe** | `npm run build-client` | `dist/Stronghold-Protocol-win64/`（697 MB） | 朋友：不想开浏览器、想本地加载素材 |
| **独立服务器 exe** | `npm run build-server` | `dist/Stronghold-Protocol-Server-win64/`（697 MB） | 房主：不想在终端里 `npm start` |

三个脚本都**只复制本机已有的内容，不联网下载**，结束前自检（素材/依赖缺失会报错返回非 0）。
所以打包前必须先在一个**完整可跑**的 checkout 上执行过 `npm ci` + `npm run setup`。

- 整合包里有 `START-HERE.txt`（解压后第一眼说明）；`LICENSE` / `NOTICE.md` / `THIRD-PARTY-NOTICES.md` 必须随包分发，别删。
- 客户端 exe 文件夹里有 `启动游戏.cmd` + `使用说明.txt`；服务器 exe 有 `启动服务器.cmd`。
- 三个产物都输出到 `dist/`（已 gitignore，不进仓库）。

---

## 5. 验证（改完代码跑什么）

| 命令 | 验证什么 |
|---|---|
| `npm test` | 全量单元 + 集成测试（约 2998 项，约 3 分钟） |
| `npm run smoke-hall` | 大厅浏览器端到端：3 个真实 Chrome，38 项检查 |
| `npm run smoke-client -- --run-from=E:\_sp-client-run` | 打包后的客户端 exe（见下方"沙箱"） |
| `npm run probe-client-ui -- --app=E:\_sp-client-run` | 打包客户端跑真浏览器：大厅/战绩/档案/剪贴板 29 项 |
| `npm run smoke-server -- --run-from=E:\_sp-server-run` | 打包后的服务器 exe |
| `node scripts/probe-hall.mjs <port>` | 对已运行的服务器发一遍大厅协议 |

> ⚠️ **性能断言与 CI**：`test/sim/robustness.test.js` 的 0.5 ms/tick 断言在本地全量并发跑时偶发超阈值
> （CPU 争用，非回归；空闲机器单独运行会通过）。CI 上预算自动放宽到 1.0 ms/tick，避免共享 runner 噪声。

---

## 6. ⚠️ 最重要的坑：Electron 在本工作区跑不起来

**这台机器的 `E:\tools\workingspace\` 被 DSH 加了低完整性 ACL，Chromium 的沙箱在里面无法初始化。**
表现为：双击任何 Electron 程序，窗口一闪即退，进程立即死亡（STATUS_BREAKPOINT，0x80000003），
**JS 一行都不会执行**。

- 构建可以照常在工作区里做（复制文件不受影响）。
- **运行必须先拷到工作区外面**，例如 `E:\` 根目录、`C:\`、桌面。
- 所以打包脚本和冒烟脚本都支持 `--run-from=<dir>`：先拷出去再运行。
  ```powershell
  npm run build-client
  npm run smoke-client -- --run-from=E:\_sp-client-run
  ```
- 这个限制只影响**这台装了 DSH 的机器**；普通用户在自己的电脑上双击 exe 不会遇到。
- 相同症状也可能在别的机器上出现（少数系统沙箱无法初始化）。所以每个 exe 文件夹都带了一个
  启动器（`启动游戏.cmd` / `启动服务器.cmd`）：先用 `--sandbox-probe` 探测，失败则带
  `ELECTRON_DISABLE_SANDBOX=1` 重启。详见 [CLIENT.md](docs/CLIENT.md) §5。

---

## 7. 版本与依赖（改之前必读）

| 项 | 值 | 说明 |
|---|---|---|
| Electron | **44.0.0**（已锁定在本机 `node_modules/electron/`） | **44.5.1 在 Windows 11 26H1 (build 28000) 上启动即崩**（沙箱路径），别升级。见 `node_modules/electron/dist/version` |
| Node.js | 22 / 24（LTS） | CI 在 Ubuntu + Windows、22 + 24 上跑 |
| 下载镜像 | `ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/` | GitHub 直连超时；重装 Electron 时用它 |

安装/重装 Electron 的可靠方式：

```powershell
$env:ELECTRON_MIRROR='https://cdn.npmmirror.com/binaries/electron/'
npm.cmd install electron@44.0.0 --no-save --no-package-lock
# 若 npm 只装了包没下 dist：
cd node_modules\electron ; node install.js ; cd ..\..
```

---

## 8. Git 状态

- 分支 `main`，6 个提交，520 个跟踪文件，工作区干净（截至本文档更新时）。
- 远程 `origin` = <https://github.com/tsingxv/weishuxieyi-rebuild>，已推送；**v0.1.0 整合包已发布到 Releases**。
- 提交身份是仓库级配置：`tsingxv <262500451+tsingxv@users.noreply.github.com>`（换人维护时改 `user.name` / `user.email` 再提交即可）。
- 仓库不含美术/音频素材（gitignore）；重打整合包用 `build-release --zip`（脚本强制用 Windows 自带 `System32\tar.exe` 出真 zip，并做 PK 头自检防 GNU tar 假 zip）。
- **本机 git 直连 GitHub 的坑**（DSH 网络环境）：schannel 报 `CRYPT_E_NO_REVOCATION_CHECK`、openssl 后端缺根证书。解法是把 Windows 证书库导出成 PEM 后：
  ```powershell
  git config http.sslBackend openssl
  git config http.sslCAInfo "C:\path\to\win-ca.pem"
  ```
  （本仓库已配置好；普通网络环境的机器不需要。）

---

## 9. 常见问题排查

| 症状 | 原因 / 处理 |
|---|---|
| 朋友连不上服务器 | 防火墙没放行 3000 端口（专用网络）；访问 Wi-Fi 有 AP 隔离 → 换路由器或用 Radmin VPN |
| 客户端"测试连接"失败 | 地址填错（要填房主电脑的地址，不是自己的）；服务器没开；端口没放行 |
| 客户端窗口一闪即退 | 沙箱无法初始化（本工作区 / 少数系统）→ 用随附的启动器 `启动游戏.cmd` |
| 大厅看不到人 | 大厅是自愿加入的，别的玩家也点了「大厅」才会出现；连接断开的人会从名单消失 |
| 聊天提示"发言太快" | 服务端限速 1 秒 1 条，稍等即可 |
| 断线后回不到原座位 | 同盟 10 分钟内重开页面可回到座位；独立模拟 24 小时；服务器重启会结束所有对局（无存档） |
| 中文在控制台是乱码 | 只是控制台代码页（GBK）显示问题，文件本身是 UTF-8，游戏内正常。别据此判断文件坏了 |

---

## 10. 相关文档索引

| 文档 | 内容 |
|---|---|
| [NOTICE.md](NOTICE.md) | 版权声明：代码 GPL、素材归属、非商业限制、代码来源（上游） |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) | 第三方组件许可 + 游戏内容权利归属表 |
| [README.md](README.md) | 面向玩家的介绍与三种获取方式 |
| [docs/CLIENT.md](docs/CLIENT.md) | 桌面客户端 / 独立服务器 exe / 整合包：构建、分发、换素材、排错 |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 开服：Windows 逐步、防火墙、开机自启、反向代理、Docker |
| [docs/PLAYING.md](docs/PLAYING.md) | 玩法说明 |
| [docs/DESIGN.md](docs/DESIGN.md) | 架构与协议（含 §8.1 大厅协议、§14 客户端算战斗） |
| [docs/DATA.md](docs/DATA.md) | `data/*.json` 的生成与字段 |
