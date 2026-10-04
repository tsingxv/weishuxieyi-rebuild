# 更新日志（Changelog）

所有显著改动都记录在这里。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 本项目是《明日方舟》「卫戍协议：盟约」的非官方同人复刻，与鹰角网络（Hypergryph）/ Yostar
> 无任何关联。游戏素材不在本项目许可范围内，见 [NOTICE.md](NOTICE.md)。

## [Unreleased]

## [0.2.0] — 基于 sganggs/Stronghold-Protocol v0.1.0 继续开发

在上游 v0.1.0 的基础上继续开发（上游：[sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol)，
代码同样以 GPL-3.0-or-later 发布，上游作者与贡献者保留其著作权）。

### 新增

- **全服大厅**（`server/hall.js` + `public/js/screens/hall.js`）：同一台服务器上的在线博士列表
  （含所在同盟的房间号，一键复制 / 加入）、开放同盟卡片、全服频道聊天、全服最近对局与每人的
  称号（评语）。自愿加入：不发 `hall.enter` 的连接一个大厅帧都收不到。
- **私聊**（`public/js/ui/whispers.js`）：大厅内点对点聊天。服务器只转发、**不保存**，重启后谁都
  看不到历史；本机保留最近 12 个对话 × 60 条。接收方不需要进入大厅；对方离线会被明确提示。
- **本地持久档案与永久战绩**（`ui/profile.js`、`ui/history.js`、`ui/myRecord.js`）：记住代号、
  本机累计场次 / 完成率 / 最佳回合 / 最常获得的称号（最近 50 局），结算页新增「我的战绩」面板。
- **Windows 桌面客户端 exe**（`client/`，Electron）：素材、数据与战斗逻辑全部内置，只有对局数据走
  房主的服务器；服务器地址设置窗口、剪贴板识别房间码 / 邀请链接一键进房（含自动切换服务器）。
- **独立服务器 exe**（`server-app/`，Electron）：内嵌真实 `startServer()`，控制面板直接查看 / 复制
  局域网与 Radmin 地址、房间邀请链接、防火墙命令与在线状态。
- **Release 整合包打包**（`npm run build-release`）：把本机已有的依赖与素材组装成「解压即玩」的
  zip（含 `START-HERE.txt`），并自检完整性。

### 变更

- 协议（`shared/protocol.js`）新增 `hall.enter` / `hall.leave` / `hall.chat` / `hall.whisper`（C2S）
  与 `hall.state` / `hall.roster` / `hall.chat` / `hall.whisper`（S2C）；`PROTOCOL_VERSION` 保持 1
  （纯增量，旧客户端不受影响）。
- `docs/CLIENT.md`、`docs/DEPLOY.md`、`README.md`、`docs/DESIGN.md` 同步新功能与打包流程。

### 测试

- 新增 `test/hall.test.js`（大厅协议与服务端行为，16 项）、`test/hall-whisper-accept.mjs`
  （私聊端到端验收）、`test/client-local-server.test.js`、`test/client-invite.test.js`、
  `test/client-history.test.js`、`test/client-clipboard.test.js`、`scripts/smoke-hall.mjs`
  （真实 Chrome 端到端，38 项）、`scripts/probe-client-ui.mjs`（打包客户端真浏览器验收，29 项）、
  `scripts/smoke-server.mjs` / `scripts/smoke-client.mjs`（打包产物的冒烟测试）。

## [0.1.0] — 上游版本

上游 [sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol) 的 v0.1.0：
完整一局（策略轮选 → 14 回合 → 结算称号，险境及以上含隐秘核心）、1–4 人合作联机、客户端算战斗、
干员调配、官方数据驱动的数值与文案。见上游仓库与其 Release 说明。

[Unreleased]: https://github.com/tsingxv/weishuxieyi-rebuild/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/tsingxv/weishuxieyi-rebuild/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sganggs/Stronghold-Protocol/releases/tag/v0.1.0
