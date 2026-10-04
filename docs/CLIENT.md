# 桌面客户端（Windows exe）

给不方便开浏览器的朋友用的 Windows 客户端。它是**同一套网页游戏**外面套了一层 Electron 外壳：
贴图、音频、数据、战斗逻辑全部随客户端打包在本地，只有对局数据通过 WebSocket 和房主的服务器同步。
房主那边仍然照旧运行服务器（`npm start` 或启动脚本），客户端**不会**再起一个服务器。

- 外壳代码：[client/](../client/)（`main.js` / `localServer.js` / `config.js` / `serverAddress.js` / `settings.html` / `preload.cjs` / `prompt.html` / `invite.js` / `clipboardWatcher.js`）
- 打包脚本：[scripts/build-client.mjs](../scripts/build-client.mjs)
- 冒烟测试：[scripts/smoke-client.mjs](../scripts/smoke-client.mjs)
- 浏览器端验收：[scripts/probe-client-ui.mjs](../scripts/probe-client-ui.mjs)

**本机保存的用户信息**：代号（`sp.name`）、本地档案（`profileId` / 访问次数，见 `sp.pref.profile`）、
以及**本地永久战绩**（最近 50 局，`sp.history.v1`）。这些都在浏览器存储里，跟同一个本地源
（固定回环端口）绑定，所以重启客户端不丢；清除浏览器数据或换设备才会丢。大厅里的「我的战绩」
与结算页的「我的战绩」面板读的就是它。

**剪贴板一键进房**：客户端主进程监听剪贴板（`clipboardWatcher.js`），识别出 4–6 位房间码或
`?room=CODE` 邀请链接后弹出一个不抢焦点的提示窗（`prompt.html`），点「进入房间」即进入；如果链接里
带了别的服务器地址（例如 `http://26.100.222.17:3000/?room=AB12`），客户端会先切换到那台服务器再进。
可以在设置里关闭「自动识别剪贴板中的房间码」。纯 HTTP 局域网网页版没有剪贴板读取权限，所以这条
只在桌面客户端（或 HTTPS / localhost 网页版）生效。

---

## 1. 它是怎么工作的

游戏本身已经是「客户端算战斗」的架构（见 [DESIGN.md](DESIGN.md) §14）：每场战斗由服务器下发一份
`BattleSpec`，浏览器在本地跑完整模拟，只把每轮结果（`b.progress` / `b.result`）和共享的 Boss 血池
（`b.pool`）回传。也就是说，**慢的是素材下载和战斗计算，而这两件事本来就可以完全放在客户端**。

客户端做的就是补齐这两件事：

```
StrongholdProtocol.exe
└── 主进程 (client/main.js)
    ├── 本地静态服务  http://127.0.0.1:<port>/       ← 复用服务器的 createStaticHandler
    │     /            → resources/app/public        （index.html、js、css、vendor、assets、fonts）
    │     /data/       → resources/app/data          （game data JSON、素材清单）
    │     /shared/     → resources/app/shared        （协议、常量，浏览器端 ES 模块）
    │     /sim/        → resources/app/server/sim    （战斗模拟，只暴露 .js）
    │     /data.js     → 服务器同一份浏览器替身（shim）
    └── /ws 隧道      ws://127.0.0.1:<port>/ws  ⇄  ws://<房主地址>:3000/ws
```

两个关键点：

1. **页面里的所有资源地址都是根路径**（`/assets/...`、`/js/...`、`/sim/...`），所以不能用 `file://`
   打开。客户端在 127.0.0.1 上起一个静态服务，**直接复用 `server/index.js` 的 `createStaticHandler`**，
   因此 MIME、gzip、ETag/304、Range（`<audio>` 要用）、目录穿越防护、`/sim/` 只给 `.js`、
   `/data.js` 替身这些东西和服务器的行为完全一致，只有一份实现。
2. **渲染层完全不知道自己在 exe 里**。`public/js/net.js` 用 `location` 推出 `ws://127.0.0.1:<port>/ws`，
   主进程把这个 socket 透明地接到房主那边。这样：
   - 不用改一行游戏代码；浏览器版和 exe 版是同一份 `public/`；
   - 页面和素材同源，没有 CORS、`file://` 之类的特例；
   - 换服务器地址 = 换隧道的目标，页面重载一下就连上新的。

其余时候客户端是**离线**的：除本地回环地址以外，所有 `http(s)://` / `ws(s)://` 请求都会被
`session.webRequest` 拦掉（`public/index.html` 里的 Google 字体也在其中），所以断网也能进标题界面，
也不会有额外的外联。

## 2. 目录与产物

构建产物（默认 `dist/Stronghold-Protocol-win64/`）：

```
StrongholdProtocol.exe          重命名后的 electron.exe
启动游戏.cmd                     推荐入口，见 §5
使用说明.txt                     给朋友看的说明
<Electron 运行时>                locales/、*.dll、*.pak、resources.pak …
resources/app/
  package.json                  main = client/main.js
  client/                       外壳（含 build-info.json，记录构建时间与默认服务器）
  public/  data/  shared/  server/   被本地服务托管的载荷（约 350 MB）
  node_modules/ws/              外壳唯一的运行时依赖（server/index.js 需要它）
```

没有用 asar 打包：静态服务要对每个素材 `stat` / `createReadStream`，散文件让它和服务器的行为
一模一样，也方便单独替换素材（见 §6）。

## 3. 构建

前置：

- Node.js 22+；
- `node_modules/electron`（**44.0.0**，已验证的版本）。本机网络访问 GitHub 会超时，用 npmmirror 镜像：

  ```powershell
  $env:ELECTRON_MIRROR='https://cdn.npmmirror.com/binaries/electron/'
  npm.cmd install electron@44.0.0 --no-save --no-package-lock
  # 若 npm 只装了包没下 dist，再补一次：
  cd node_modules\electron; node install.js; cd ..\..
  ```

  验证：`node_modules\electron\dist\version` 应为 `44.0.0`。

构建：

```powershell
node scripts/build-client.mjs                                  # 产物在 dist/，首次运行让玩家自己填地址
node scripts/build-client.mjs --default-server=26.100.222.17:3000   # 预填房主地址（设置窗口仍可改）
node scripts/build-client.mjs --zip                            # 额外打一个 zip 方便分发
node scripts/build-client.mjs --out=E:\sp-build                # 换输出目录
```

| 选项 | 说明 |
|---|---|
| `--default-server=host:port` | 写进 `client/build-info.json`，第一次运行时预填并加进候选列表；不填则让玩家手输 |
| `--zip` | 用 `tar.exe` 打 `Stronghold-Protocol-win64.zip`（约 600 MB，需要几分钟） |
| `--out=<dir>` | 输出根目录，默认 `dist/`。**本机要直接把产物打到能运行的位置时用它**，例如 `--out=E:\Stronghold-Protocol-Client`（原因见 §7） |
| `--no-clean` | 不删除已有产物目录（增量覆盖，慎用） |

冒烟测试（会真的起一个服务器 + 客户端，跑完自动收掉）：

```powershell
node scripts/smoke-client.mjs --run-from=E:\_sp-client-run
```

它检查：客户端本地服务的 `/`、`/sim/*.js`、`/data.js` 是否正确；`/sim/nodeData.js` 是否 404；
渲染层是否真的连到了服务器（读房主的 `/healthz` 看 socket 数）；外壳日志里是否出现隧道记录。

`--run-from=<dir>` 会把产物拷到那个目录再运行。**在本机（DSH 工作区）必须加这个参数**，原因见 §7。

可用的验证入口（`package.json` 里都有同名 npm script）：

| 命令 | 验证内容 |
|---|---|
| `node scripts/smoke-client.mjs --run-from=<dir>` | 客户端 exe：本地服务、载荷挂载、`/ws` 隧道真的连上房主 |
| `node scripts/probe-client-ui.mjs --app=<dir>` | **打包客户端跑真浏览器**：大厅三栏挂载、大厅订阅生效、聊天往返、本地战绩记录、标题页「记住代号」（29 项检查） |
| `node scripts/smoke-hall.mjs` | 大厅的浏览器端到端：3 个真实 Chrome 客户端、在线名单、房间号共享、聊天、最近战绩与称号（38 项检查） |
| `node scripts/smoke-server.mjs --run-from=<dir>` | 服务端 exe：`/healthz`、游戏页面、载荷挂载、大厅握手 |
| `node scripts/probe-hall.mjs <port>` | 对**已运行的**服务器 exe 发一遍大厅协议（在线名单 / 聊天投递 / 房间号同步） |

## 3.5 独立服务器 exe（房主可选）

不想在终端里 `npm start` 的房主可以打一个**独立服务器 exe**：它内嵌同一份服务器代码
（`server/index.js` 的 `startServer()` 在主进程里直接跑），打开一个控制面板窗口。

```powershell
node scripts/build-server.mjs        # → dist/Stronghold-Protocol-Server-win64/
node scripts/smoke-server.mjs --run-from=E:\_sp-server-run
```

产物：`StrongholdProtocolServer.exe` + `启动服务器.cmd` + `使用说明.txt`（约 697 MB）。双击后：

- 面板直接列出**可分享的地址**：本机、局域网（标注网卡）、Radmin VPN，每条都有「复制 / 打开」按钮；
  还有「一键复制全部」生成一段可以直接粘到 QQ/微信里的邀请文字（含端口、防火墙命令、Radmin 提示）。
- **房间邀请链接**：填入 4 位密钥 → 「生成链接」→ 复制 `http://<地址>:<端口>/?room=密钥`，朋友粘到
  客户端就能一键进房（见 §剪贴板一键进房）。
- 实时状态：在线连接数、房间数、对局数、大厅人数、运行时长；「打开浏览器」在本机玩；
  「停止服务器 / 退出」会关掉整个服务。
- 提示条明确写着：**关掉这个窗口 = 停止开服**；窗口最小化没关系，别关。
  要长期后台运行、开机自启，仍然用 `npm start` + `scripts/install-service-windows.ps1`（见
  [DEPLOY.md](DEPLOY.md) §1.4），面板里也写了这条。
- 端口被占用（EADDRINUSE）时面板不会消失，而是提示 `启动服务器.cmd --port 3001` 换端口。
- 日志：`%APPDATA%\stronghold-protocol-server\server.log`。

服务端 exe 与客户端 exe 打的是**同一份游戏载荷**（public/data/shared/server + ws），所以代码更新后
两个都要重新打包；只换素材时同样直接覆盖各自 `resources/app/public/assets`。

## 4. 和朋友一起玩

1. 房主照旧开服务器（`npm start`，或 `scripts\start-windows.bat`），跑着的窗口别关。
2. 房主把整个 `Stronghold-Protocol-win64` 文件夹压缩后发给朋友（QQ / 网盘均可，约 600 MB）。
3. 朋友解压到**任意普通目录**（例如 `D:\Games\`、桌面），双击 `启动游戏.cmd`。
4. 第一次运行会弹出「服务器设置」：
   - 同一路由器：填房主的局域网地址，如 `192.168.1.2:3000`；
   - Radmin VPN：填房主的 Radmin 地址，如 `26.100.222.17:3000`；
   - 端口默认 3000，可以省略。点「测试连接」，看到「连接成功」再「保存并连接」。
5. 之后换服务器：游戏窗口菜单 **游戏 → 服务器设置…**（快捷键 <kbd>Ctrl</kbd>+<kbd>,</kbd>）。

客户端只连房主那一台机器，**没有大厅、没有账号**，知道地址的人都能进——所以地址只发给朋友。

## 4.5 大厅、本地战绩与剪贴板进房（游戏内功能）

这三个功能在**网页版和桌面客户端里都有**，服务器端是同一个实现（`server/hall.js`，协议见
[DESIGN.md](DESIGN.md) §8.1）。

**大厅**（选模式界面右上角「大厅」按钮进入）：

- **在线博士**：本服务器上所有已连接的人，标注谁在哪个同盟（点密钥可复制）、谁正在模拟中；
- **开放同盟**：房间号 + 模式/难度 + 人数/占位 + 创建者，可「复制密钥」或直接「加入」
  （正在模拟 / 独立模拟 / 已满的房间会给出原因，不会发出无效请求）；
- **频道**：全服聊天，回车发送，同一人 1 秒一条（太快会提示「发言太快了」），服务器保留最近 50 条，
  新进大厅的人能看到最近发言；
- **最近战绩**：全服最近完成的对局——完成/失败、难度、通过回合、耗时，以及**每个玩家的评语（称号）**。

大厅是**自愿加入**的：不发 `hall.enter` 的连接一个大厅帧都收不到，挂在标题页零开销。

**我的战绩（本地永久）**：结算页底部新增「我的战绩」面板——本局的完成/失败、通过回合、耗时和
**本局评语**，下面是这台设备上的累计数据（总场次 / 完成 / 失败 / 完成率 / 最佳回合 / 隐秘核心次数 /
最常获得的评语）。它存在浏览器本地（最近 50 局，`sp.history.v1`），**服务器重启也不会丢**；
服务器内存里那份全服最近战绩（`hall.results`）只保留 20 局。两者互补：一个永久但只属于自己，
一个全服可见但随重启清空。

**记住代号**：标题页「开始」按钮下有「记住代号」勾选，勾上后代号存进本地档案
（`sp.pref.profile`），下次打开标题页会自动填好，直接点「开始」即可——不用每次重建一个"用户"。

**剪贴板进房**：见本章开头的「剪贴板一键进房」。网页版（HTTPS / localhost）会在标题页弹出
「检测到房间码 XXXX · 点击进入」横幅（可在设置里关掉）；桌面客户端则由外壳读剪贴板并弹出独立提示窗，
支持从邀请链接里同时切换服务器。

## 5. 启动器（`启动游戏.cmd`）

先探测再启动：它先跑一次 `StrongholdProtocol.exe --sandbox-probe`（客户端自带的探针，能在 `app`
就绪后立即退出），如果这个进程异常退出（少数机器上 Chromium 的沙箱无法初始化，表现为窗口一闪即退），
就带上 `ELECTRON_DISABLE_SANDBOX=1` 重新启动。正常机器上探测瞬间通过，沙箱保持开启，多花不到一秒。

直接双击 `StrongholdProtocol.exe` 也可以；只有在极少见的系统上才需要走启动器。启动器内容全是
ASCII：`.cmd` 按控制台 OEM 代码页解析，写中文会变成乱码（中文说明放在 `使用说明.txt`）。

## 6. 更新

- **改代码 / 改外壳** → 重新构建，把新的 `StrongholdProtocol.exe` + `resources/app/` 覆盖过去。
- **只换素材**（`public/assets`、`public/fonts`）→ 直接替换 `resources/app/public/assets`、
  `resources/app/public/fonts`，不用重新打包。服务端整合包的更新方式（见 [DEPLOY.md](DEPLOY.md)）
  同理适用于这里。
- 客户端版本记在 `resources/app/client/build-info.json`，菜单「帮助 → 关于」里能看到。

## 7. 排错

| 症状 | 原因 / 处理 |
|---|---|
| 双击 exe 窗口一闪即退 | Chromium 沙箱无法初始化。改用 `启动游戏.cmd`（会自动免沙箱启动）。 |
| 在 `E:\tools\workingspace\...` 里运行就闪退 | **DSH 给这个工作区加了低完整性 ACL，Chromium 的沙箱在里面起不来**；同一个 exe 放到 `C:\`、`D:\`、桌面都能正常跑。把客户端文件夹拷出工作区再运行，或者直接 `node scripts/build-client.mjs --out=E:\Stronghold-Protocol-Client` 生成到工作区之外。 |
| 设置窗口「测试连接」超时 | 网络不通：确认房主开着服务器、地址正确、房主防火墙放行 3000 端口（专用网络）、Radmin 双方在同一网络组。 |
| 「测试连接」报 HTTP 404 | 地址不是游戏服务器（比如填成了别的服务 / 反向代理没转发根路径）。 |
| 能连上但卡在标题页 | 看 `%APPDATA%\stronghold-protocol-client\client.log`（菜单「帮助 → 打开日志文件夹」）；房主那边 `healthz` 的 `sockets` 数应该 ≥1。 |
| 字体和网页版略有差异 | 客户端离线，Google 字体请求被拦截，中文回退到系统字体（`public/fonts` 里的 Bender / Novecento 仍然生效）。 |
| 端口 41888 被占用 | 客户端会自动换到下一个空闲端口，并把结果记进配置文件（换端口会让页面来源变化，曾经的昵称/会话令牌作废，需重输昵称）。 |

配置文件：`%APPDATA%\stronghold-protocol-client\client-config.json`（服务器地址、本地端口、窗口位置、
历史地址）。删掉它等于恢复出厂设置。

## 8. 边界与合规

- 客户端不是服务器：它不会监听 0.0.0.0，也不会托管对局；房主必须那边开着服务器。
- 本地服务只绑定 `127.0.0.1`，并且校验 `Host` 头（防 DNS rebinding）。
- 渲染进程没有 Node、没有 preload 桥，和浏览器版权限一致；设置窗口才有 `contextBridge` 暴露的
  读写配置接口。
- 防作弊仍在服务端：`server/match/fields.js` 的 `validateClientResult` 做结构与合理性校验，
  `SP_VERIFY=all|sample|off` 可以要求服务器完整重算（见 DESIGN §14）。
- 非官方同人作品，仅供个人非商业联机游玩，请勿公开传播或用于任何商业用途；素材版权归鹰角网络所有。
