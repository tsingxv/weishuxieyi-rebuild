# 快速上手 · 交接文档（HANDOVER）

> 写给接手这个项目的人。**10 分钟跑起来，20 分钟看懂结构，30 分钟知道还差什么。**
>
> - 玩法说明 → [docs/PLAYING.md](docs/PLAYING.md)
> - 架构与协议 → [docs/DESIGN.md](docs/DESIGN.md)
> - 版权与来源 → [NOTICE.md](NOTICE.md)、[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
>
> **状态快照（写本文档时）**：版本 `0.2.0` · 分支 `main` · 10 个提交 · 523 个跟踪文件 ·
> 工作区干净 · tag `v0.2.0` 指向 HEAD · 代码已推送 GitHub。
> **唯一未完成的动作**：v0.2.0 的 Release 附件尚未上传（原因与两种解法见 §6）。

---

## 1. 这是什么

《明日方舟》「卫戍协议：盟约」的**非官方同人复刻**：浏览器自走棋塔防，单人或 1–4 人联机合作。
战斗在各玩家的浏览器里模拟，服务器只做回合/经济与校验（[DESIGN.md](docs/DESIGN.md) §14）。

**本仓库不是从零写的**：基于上游 [sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol)
继续开发。上游 = v0.1.0 的全部基础玩法；本仓库在其上新增了大厅、私聊、本地战绩、两个 exe 外壳。
代码同样以 **GPL-3.0-or-later** 发布（GPL 要求保留上游版权声明），详见 [NOTICE.md](NOTICE.md) 第 0 节。

**版权（务必先读）**：游戏素材（美术 / 音乐 / 音效 / 文本 / 数据）归**上海鹰角网络科技有限公司**
（Hypergryph）及其许可方所有，**Yostar** 为海外发行方，**不在 GPL 范围内**，本项目亦无权授权。
仅限学习交流与个人非商业使用，**严禁任何形式盈利**。仓库里**不含**游戏美术与音频（已 gitignore）。

---

## 2. 三分钟跑起来（Windows）

```powershell
cd <本仓库目录>
npm ci                    # 安装依赖（postinstall 会把 pixi/preact/three 复制到 public/vendor）
npm run setup             # 下载约 250 MB 美术/音频（可中断续传）
npm start                 # 启动 → 浏览器打开 http://localhost:3000
```

也可以直接双击 `scripts\start-windows.bat`（自动完成上述步骤）。终端会打印局域网地址
（如 `http://192.168.x.x:3000`），发给同一路由器下的朋友即可联机。

要求 **Node.js 22 或 24（LTS）**。出问题先跑 `npm run doctor`（只读诊断）。

> 全新 clone **不能直接跑**：`public/assets`、`public/fonts`、`public/vendor`、`node_modules`
> 都是 git-ignored 的。`npm run setup` 会把缺的补齐。要给别人一个「解压就玩」的包，用 §4 的整合包。

---

## 3. 目录结构（相对上游新增了什么）

| 目录 / 文件 | 作用 | 来源 |
|---|---|---|
| `server/` | HTTP 静态服务 + WebSocket（`/ws`）、同盟房间（`lobby.js`）、对局引擎（`match/`）、战斗模拟（`sim/`） | 上游 |
| `server/hall.js` | **新增**：全服大厅（在线博士 / 房间码 / 频道聊天 / 私聊中继 / 全服最近战绩） | 本仓库 |
| `public/js/screens/hall.js` + `public/css/screens/hall.css` | **新增**：大厅界面（在线名单 / 房间+频道 / 最近战绩；频道与私聊切换） | 本仓库 |
| `public/js/ui/whispers.js` | **新增**：私聊线程（localStorage，≤12 对话 × 60 条；服务器不留存） | 本仓库 |
| `public/js/ui/profile.js` | **新增**：本地持久档案（`profileId`、代号、访问次数、"记住代号"） | 本仓库 |
| `public/js/ui/history.js` + `ui/myRecord.js` | **新增**：本地永久战绩（最近 50 局）与结算页「我的战绩」面板 | 本仓库 |
| `public/js/ui/clipboard.js` + `ui/inviteBanner.js` | **新增**：网页版剪贴板房间码识别与提示横幅 | 本仓库 |
| `client/` | **新增**：Windows 桌面客户端外壳（Electron）：本地静态服务 + `/ws` 隧道 + 服务器设置 + 剪贴板一键进房 | 本仓库 |
| `server-app/` | **新增**：独立服务器外壳（Electron）：内嵌 `startServer()`，控制面板复制 IP / 邀请链接 | 本仓库 |
| `shared/protocol.js`、`shared/constants.js` | 修改：新增 `hall.*` 协议（见下） | 本仓库 |
| `data/` | 由官方数据表生成的游戏数据（`npm run build-data` 重新生成，**勿手改**） | 上游 |
| `docs/`、`test/`、`tools/`、`scripts/` | 文档、测试、工具、打包与启动脚本 | 上游 + 本仓库 |

**大厅协议**（权威注释在 `shared/protocol.js`，搜「hall / 大厅」；[DESIGN.md](docs/DESIGN.md) §8.1 同步）：

- C2S：`hall.enter {}` · `hall.leave {}` · `hall.chat {text}` · `hall.whisper {to, text}`
- S2C：`hall.state {...}`（全量快照）· `hall.roster {...}`（在线/房间变化）· `hall.chat {line}` ·
  `hall.whisper {line}`（**只投递给收发双方**）
- 大厅是**自愿加入**的：不发 `hall.enter` 的连接一个大厅帧都收不到（标题页零开销）
- 私聊**服务器不保存**：只转发给两人后丢弃，重启或重新 `hall.enter` 都不会重放；
  历史只存在双方本机（`ui/whispers.js`）

---

## 4. 三个交付物及其打包命令

| 产物 | 命令 | 输出（v0.2.0 实测） | 给谁 |
|---|---|---|---|
| **Release 整合包**（解压即玩） | `npm run build-release -- --zip` | `dist/Stronghold-Protocol-v0.2.0.zip`（435 MB，解压后 811 MB） | 只想开服 + 浏览器玩 |
| **桌面客户端 exe** | `npm run build-client` | `dist/weishuxieyi-client/`（697 MB，5781 文件） | 朋友：不装浏览器、素材内置 |
| **独立服务器 exe** | `npm run build-server` | `dist/weishuxieyi-server/`（697 MB，5775 文件） | 房主：不想在终端 `npm start` |

三个脚本都**只复制本机已有内容，不联网下载**，并在结束前自检（素材/依赖缺失 → 报错并返回非 0）。
所以打包前必须先在一个**完整可跑**的 checkout 上执行过 `npm ci` + `npm run setup`。

- 整合包内有 `START-HERE.txt`（解压后第一眼说明）；`LICENSE` / `NOTICE.md` / `THIRD-PARTY-NOTICES.md`
  **必须随包分发**（GPL 与素材声明都要求保留）。
- 客户端 exe 文件夹里有 `启动游戏.cmd` + `使用说明.txt`；服务器 exe 有 `启动服务器.cmd`。
- 三个产物都输出到 `dist/`（已 gitignore，不进仓库）。
- 给外人的 zip 用**Windows 自带** `System32\tar.exe` 打（脚本已强制），并对结果做 `PK` 头自检 —— 
  某些 GNU tar 会生成扩展名是 `.zip` 但格式不是 zip 的假包。

---

## 5. 验证（改完代码跑什么）

| 命令 | 验证什么 |
|---|---|
| `npm test` | 全量单元 + 集成测试（约 3000 项） |
| `npm run smoke-hall` | 大厅浏览器端到端：真实 Chrome × 3 客户端，38 项检查 |
| `npm run smoke-client -- --run-from=E:\_sp-client-run` | 打包后的客户端 exe（沙箱见 §7） |
| `npm run probe-client-ui -- --app=E:\_sp-client-run` | 打包客户端跑真浏览器：大厅/战绩/档案/剪贴板 29 项 |
| `npm run smoke-server -- --run-from=E:\_sp-server-run` | 打包后的服务器 exe |
| `node scripts/probe-hall.mjs <port>` | 对已运行的服务器发一遍大厅协议 |
| `node --test test/hall.test.js` | 大厅 + 私聊的服务端行为（16 项） |
| `node --test test/hall-whisper-accept.mjs` | 私聊端到端：两人互发、旁观者零收到、离线被拒、公共频道未被污染 |

> ⚠️ **已知非回归**：`test/sim/robustness.test.js` 的 `0.5 ms/tick` 性能断言在本地全量并发跑时
> 偶发超阈值（CPU 争用）。它只依赖未改动的 `server/sim/*`，空闲机器单独运行必过；CI 上预算放宽到
> `1.0 ms/tick`。看到这一条失败不要当成功能回归。

---

## 6. 当前唯一未完成的事：v0.2.0 Release 附件未上传

**现状**：代码与 tag 都已推送 GitHub；但 **Releases 页面上还没有 v0.2.0 的安装包**
（v0.1.0 的三个包已发布，是更早的版本，不含大厅私聊）。

**要上传的三个文件**（`dist/` 下，共 1.23 GB）：

| 文件 | 大小 | 说明文案 |
|---|---|---|
| `Stronghold-Protocol-v0.2.0.zip` | 435 MB | 开箱即玩整合包：解压 → 装 Node.js 22+ → 双击 `scripts\start-windows.bat` |
| `weishuxieyi-client-v0.2.0.zip` | 399 MB | 桌面客户端 exe：素材与战斗逻辑内置，剪贴板识别房间码一键进房 |
| `weishuxieyi-server-v0.2.0.zip` | 398 MB | 独立服务器 exe：控制面板复制 IP / 邀请链接 / 防火墙命令 |

**解法 A（推荐，最省事）——网页上传**：
1. 打开 <https://github.com/tsingxv/weishuxieyi-rebuild/releases/new?tag=v0.2.0>
2. 标题填 `v0.2.0 — 大厅 / 私聊 / 本地战绩 / 客户端与服务器 exe`
3. 描述粘 [CHANGELOG.md](CHANGELOG.md) 里 `## [0.2.0]` 那一整段
4. 把上面三个 zip 拖进附件区，Publish release

**解法 B——用 API 上传**：需要一个**有 `Contents: Read and write` 的 token**。
注意：先前试过 fine-grained token，`GET` 全部正常但 `POST /releases` 返回
`403 Resource not accessible by personal access token`，而同一 token 发空 body 却返回 `422`（缺字段），
即**写入被权限拦下**。改用 **classic token 勾 `repo`** 可绕开这类细粒度权限坑：

```powershell
# 1) https://github.com/settings/tokens/new  → 只勾 repo → 生成 ghp_...
# 2) 用 API 建 release 并上传附件（本机已确认 api.github.com 可达）
#    注意本机 Node 需要 CA 证书，见 §7
```

---

## 7. ⚠️ 本机（DSH 环境）三个坑，接手前必读

### 7.1 Electron 在工作区内跑不起来（最重要）

`E:\tools\workingspace\` 带 DSH 低完整性 ACL，**Chromium 沙箱在里面无法初始化**。
症状：双击任何 Electron 程序，窗口一闪即退，进程秒死（`STATUS_BREAKPOINT`，`0x80000003`），
**JS 一行都不会执行**。

- 构建照常（复制文件不受影响）；**运行必须先拷到工作区外**（`E:\`、`C:\`、桌面…）。
- 因此打包与冒烟脚本都支持 `--run-from=<dir>`：
  ```powershell
  npm run build-client
  npm run smoke-client -- --run-from=E:\_sp-client-run
  ```
- 只影响这台装了 DSH 的机器；普通用户双击 exe 不受影响。
- 为防少数机器也遇沙箱初始化失败，每个 exe 文件夹带启动器（`启动游戏.cmd` / `启动服务器.cmd`）：
  先 `--sandbox-probe` 探测，失败则带 `ELECTRON_DISABLE_SANDBOX=1` 重启。见 [CLIENT.md](docs/CLIENT.md) §5。

### 7.2 Node / git 连 GitHub 需要证书与替代线路

本机对 GitHub 的直连有**两个独立问题**，别把它们混为一谈：

1. **证书链**：Node 用自带证书库时对 `api.github.com` 报
   `unable to verify the first certificate`；git 的 openssl 后端则报缺根证书。
   **解法**是把 Windows 证书库导出成 PEM 后复用（本仓库的 git 已配好）：
   ```powershell
   git config http.sslCAInfo "C:/Users/Administrator/.config/git/win-ca.pem"
   # Node 脚本要在**进程启动前**设置（运行中设置无效）：
   $env:NODE_EXTRA_CA_CERTS = 'C:/Users/Administrator/.config/git/win-ca.pem'
   ```
2. **`github.com:443` 被阻断**（DNS 解析到不可达 IP）。可用线路是
   **`ssh.github.com:22`（SSH over 22）+ 专用密钥**，`~/.ssh/config` 已配置：
   ```
   Host github.com
     HostName ssh.github.com
     Port 22
     User git
     IdentityFile ~/.ssh/sp_github
     IdentitiesOnly yes
   ```
   本仓库 `origin` 已改用 SSH 地址（`git@github.com:...`），所以 `git push` 直接用即可。
   > **注意**：这条 SSH 线路**时好时坏**（写本文档时就出现过
   > `ssh: connect to host ssh.github.com port 22: Connection refused`）。
   > 遇到连不上：先重试；仍不行就临时走网页操作，或换网络环境。
   > `api.github.com:443` 也可能是通的（本机实测有时可直连）——两个线路互相独立。

### 7.3 中文与编码

- 控制台代码页是 GBK，`pwsh` 里打印的中文常显示成乱码 —— **只是显示问题**，文件本身是 UTF-8。
  判断「文件是否被写坏」要**用 Node 读内容比对**，不要看控制台输出。
- **不要用 PowerShell 的 `Set-Content` / `Out-File` 改带中文的源码**：实测会把 CJK 字符串
  写成乱码（`'私密'` → `'绉佸瘑'`），轻则断言互不相等、重则语法错误。
  改中文文件用编辑器工具，或用 Node 脚本读写。
- `test/hall.test.js` 里的中文测试字符串**刻意写成 `\uXXXX` 转义**，就是为了不再被这类往返破坏。

---

## 8. 版本与依赖（改之前必读）

| 项 | 值 | 说明 |
|---|---|---|
| 版本 | `0.2.0` | `package.json` 与 README 徽章一致；[CHANGELOG.md](CHANGELOG.md) 有完整记录 |
| Electron | **44.0.0**（已锁定在 `node_modules/electron/`） | **44.5.1 在 Windows 11 26H1 (build 28000) 上启动即崩**，别升级 |
| Node.js | 22 / 24（LTS） | CI 在 Ubuntu + Windows、22 + 24 上跑 |
| Electron 下载镜像 | `ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/` | GitHub 直连超时；重装时用它 |

```powershell
$env:ELECTRON_MIRROR='https://cdn.npmmirror.com/binaries/electron/'
npm.cmd install electron@44.0.0 --no-save --no-package-lock
# 若 npm 只装了包没下 dist：
cd node_modules\electron ; node install.js ; cd ..\..
```

---

## 9. Git 状态与发布流程

- 分支 `main`，远程 `origin` = `git@github.com:tsingxv/weishuxieyi-rebuild.git`（SSH 地址）。
- 提交身份是**仓库级**配置：`tsingxv <262500451+tsingxv@users.noreply.github.com>`
  （换人维护时改 `user.name` / `user.email` 再提交即可）。
- 已存在的 tag：`v0.2.0`（指向当前 HEAD）。此前还有上游的 `v0.1.0`。
- 仓库不含美术/音频素材（gitignore）；整合包靠 Release 分发。
- 发布新版本的标准动作：
  ```powershell
  # 1. 改版本号 + 写 CHANGELOG
  # 2. 提交
  git add -A ; git commit -m "版本 x.y.z：..."
  # 3. 打 tag 并推送
  git tag -a vx.y.z -m "vx.y.z 摘要"
  git push origin main ; git push origin vx.y.z
  # 4. 打包三个产物（§4），到 Releases 页面创建 release 并上传附件（§6）
  ```

---

## 10. 常见问题排查

| 症状 | 原因 / 处理 |
|---|---|
| 朋友连不上服务器 | 防火墙没放行 3000 端口（专用网络）；Wi-Fi 有 AP 隔离 → 换路由器或用 Radmin VPN |
| 客户端「测试连接」失败 | 地址要填**房主的**地址（不是自己的）；服务器没开；端口没放行 |
| 客户端窗口一闪即退 | 沙箱无法初始化（本工作区 / 少数系统）→ 用随附启动器 `启动游戏.cmd`；见 §7.1 |
| 大厅看不到人 | 大厅自愿加入，别人也点了「大厅」才出现；断线的人会从名单消失 |
| 私聊发不出去，提示「该玩家已不在线」 | 对方已断开；私聊不落库，离线无法补发 |
| 私聊提示「发得太快」 | 限流：10 秒内 20 条（约 2/s 持续），与公共频道额度独立 |
| 频道聊天提示「发言太快」 | 公共频道限速 1 秒 1 条 |
| 换台机器看不到历史私聊 | 私聊存在**本机** localStorage，不跟随账号（本项目无账号体系） |
| 断线后回不到原座位 | 同盟 10 分钟内重开页面可回座位；独立模拟 24 小时；服务器重启结束所有对局（无存档） |
| 中文在控制台是乱码 | 代码页问题，文件是 UTF-8；见 §7.3 |
| `npm test` 里性能断言偶发失败 | 已知非回归，见 §5 |

---

## 11. 相关文档索引

| 文档 | 内容 |
|---|---|
| [NOTICE.md](NOTICE.md) | 版权声明：代码 GPL、素材归属、非商业限制、代码来源（上游） |
| [CHANGELOG.md](CHANGELOG.md) | 版本历史（0.2.0 相对上游 v0.1.0 的全部新增） |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) | 第三方组件许可 + 游戏内容权利归属表 |
| [README.md](README.md) | 面向玩家的介绍与三种获取方式 |
| [docs/CLIENT.md](docs/CLIENT.md) | 桌面客户端 / 独立服务器 exe / 整合包：构建、分发、换素材、排错 |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 开服：Windows 逐步、防火墙、开机自启、反向代理、Docker |
| [docs/PLAYING.md](docs/PLAYING.md) | 玩法说明 |
| [docs/DESIGN.md](docs/DESIGN.md) | 架构与协议（§8.1 大厅与私聊、§14 客户端算战斗） |
| [docs/DATA.md](docs/DATA.md) | `data/*.json` 的生成与字段 |
