# 版权与使用声明（NOTICE）

**卫戍协议：盟约 · Stronghold Protocol** 是《明日方舟》限时玩法「卫戍协议：盟约」的**非官方同人复刻**，与上海鹰角网络科技有限公司（Hypergryph，以下称「鹰角网络」）、上海悠星网络科技有限公司（Yostar）及其关联方**没有任何关联**，也未获得其授权、赞助或认可。

> 权利人识别：本作所复刻的《明日方舟》（Arknights）由**上海鹰角网络科技有限公司**开发并享有权利（其《鹰角网络游戏使用许可及服务协议》第 1.3 条将「鹰角网络」定义为上海鹰角网络科技有限公司及其关联公司，包括但不限于上海鹰角塔罗斯网络科技有限公司）；**Yostar（上海悠星网络科技有限公司）**为其海外发行 / 运营方。该协议第 9.1 条约定：游戏软件、服务及「鹰角网络游戏内容」（名称、标题、标志、形象、图片、地图、道具、场景、**音乐**、台词、配音、动画、影音片段等）的**全部所有权与知识产权归鹰角网络完整享有**。第 4.1 条授予玩家的许可为**个人的、非商业性质的、可撤销的、非排他性的、不可转让的、不可转授权的**，第 4.2 条明确禁止未经书面同意复制、发行、传播、出售、出租、改编、出版游戏软件或游戏内容。本声明即是基于上述事实作出的**未经授权的非商业同人使用声明**，本项目不主张任何与游戏内容有关的权利。
> 权利依据（公开页面）：<https://user.hypergryph.com/protocol/plain/endfield/service> · 官方客服邮箱：cs@hypergryph.com

## 0. 代码来源：基于上游项目开发

本仓库的代码**不是从零编写的**，而是基于上游项目 **[sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol)**
（同样为《明日方舟》「卫戍协议：盟约」的非官方同人复刻）继续开发的版本：

| | 上游 | 本仓库 |
|---|---|---|
| 仓库 | [sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol) | 本仓库 |
| 关系 | 原始项目 | 在上游代码基础上的继续开发（derivative work） |
| 新增 | — | 大厅（在线/房间码/频道/全服战绩）、本地持久档案与永久战绩、Windows 桌面客户端 exe、独立服务器 exe 及其控制面板 |

- **著作权归属**：上游项目自身代码的著作权归**上游作者及其贡献者**所有。本仓库在上游代码基础上修改与新增的部分，著作权归本仓库的贡献者所有。
- **许可继承**：上游以 GPL-3.0-or-later 发布本项目代码时，本仓库作为其衍生作品**必须**继续以 GPL-3.0-or-later 发布，并保留上游的版权声明与许可证全文 —— 本仓库的 [LICENSE](LICENSE) 与本节即为此目的。任何人都可以按 GPL 的条件获取、修改并再分发本仓库的代码（含上游部分）。
- **获取上游源码**：<https://github.com/sganggs/Stronghold-Protocol>。若你只需要上游原版功能，请直接使用上游仓库或其 Release，无需使用本仓库。
- 本节只涉及**代码**。游戏素材与官方派生数据的权利归属见下方第 2 节，与上游 / 本仓库的代码许可无关。

## 1. 代码许可证：GPL-3.0-or-later

Copyright (C) 2026 Stronghold-Protocol contributors（含上游作者与贡献者）

本项目自己编写的源代码与文档文字（`server/`、`shared/`、`public/` 下的 JS / CSS / HTML、`tools/`、`scripts/`、`test/`、`docs/` 等）以 **GNU 通用公共许可证第 3 版或（由你选择）任何更新版本**（GPL-3.0-or-later）发布，全文见 [LICENSE](LICENSE)。你可以在该许可证的条件下使用、修改和再分发这些代码 —— 其中包含来自上游的部分（见上一节）。

例外：

- `tools/local-extract/aklz4.py` 来自 [isHarryh/Ark-Unpacker](https://github.com/isHarryh/Ark-Unpacker)，保持 BSD-3-Clause 许可（见 `tools/local-extract/LICENSE-Ark-Unpacker.txt`）。
- 通过 npm 安装的第三方库（PixiJS、pixi-spine、Preact、htm、three.js、ws 等）和字体各自保留原许可证，见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

**附加许可（GPL-3.0 第 7 条）** — Additional permission under GNU GPL version 3 section 7:

> If you modify this Program, or any covered work, by linking or combining it with the Spine Runtimes (as shipped in
> pixi-spine, or a modified version of them), containing parts covered by the terms of the Spine Runtimes License
> Agreement, the licensors of this Program grant you additional permission to convey the resulting work.
> Corresponding Source for a non-source form of such a combination shall include the source code for the parts of
> the Spine Runtimes used as well as that of the covered work.

（大意：允许把本项目与 pixi-spine 中的 Spine Runtimes 组合后再分发；Spine Runtimes 本身仍受其自己的许可证约束。）

## 2. 不属于本项目、不受 GPL 约束的内容

《明日方舟》及「卫戍协议」相关的全部**名称、角色、美术、Spine 模型、界面图、音乐音效、文本与游戏数据**，版权归上海鹰角网络科技有限公司及其授权方（Yostar 等）所有。具体包括：

- Release 完整包中的 `public/assets/**`（含从官方客户端本地提取的 3D 棋盘模型与贴图 `public/assets/local/**`）和 `public/fonts/**`（字体归各自作者）；
- 由官方数据表生成的 `data/*.json`，以及含有或派生自游戏数据的 `docs/research/*.json`、`test/fixtures/official-waves.json`、`public/dev/recordings/*.json`；
- `docs/img/` 中的游戏截图；
- `docs/` 中引用的 PRTS、BWIKI、NGA、巴哈姆特等社区页面的文字（仍按其来源的许可，维基文本为 CC BY-NC-SA）。

这些内容**不在 GPL-3.0 授权范围内**，本项目也无权就它们向任何人授予任何权利。

## 3. 仅限非商业用途

- 本项目仅供**学习、研究和个人非商业娱乐**。
- 游戏素材与数据的权利人没有授权本项目或其使用者进行任何商业使用，因此包含或依赖这些素材的一切内容——Release 完整包、架设的服务器、截图、录像与直播等——都**不得用于任何形式的盈利**。包括但不限于：
  - 出售或付费分发；
  - 收费开服、付费房间或会员；
  - 植入广告；
  - 与本项目挂钩的打赏、赞助或众筹；
  - 打包进任何收费产品或服务。
- 再分发完整包时，请保留本声明、[LICENSE](LICENSE) 和 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)，并同样注明非官方、非商业。
- GPL 本身允许商业使用**代码**，上述限制针对的是不属于本项目的游戏素材与数据。

## 4. 权利人通知与删除

如果你是相关权利人，认为本项目的任何内容不妥，请在本仓库提交 Issue（或通过 GitHub 联系仓库所有者），我们会尽快删除相关内容，或下架完整包乃至整个仓库。

## 5. 免责声明

- 本项目按「原样」提供，**不附带任何明示或暗示的担保**（见 LICENSE 第 15、16 条）。
- 使用、架设或公开本项目的风险，包括网络安全、第三方联机工具与服务、当地法律法规，由使用者自行承担。
- 本项目不需要也不会索取任何游戏账号；可选的本地提取只读取你本机已安装的客户端文件。

---

**English summary.** Unofficial, non-commercial fan remake; not affiliated with or endorsed by Hypergryph or Yostar.
The project's own code is GPL-3.0-or-later (with the Spine Runtimes linking permission above). All Arknights names,
art, models, audio and data — including everything under `public/assets/` in the release bundle — are © Hypergryph /
Yostar and their licensors, are **not** covered by the GPL, and may be used for study and personal non-commercial
purposes only: no selling, paid distribution, paid hosting, ads, donations or any other monetisation. Rights holders
can request removal through a GitHub issue and the content will be taken down. No warranty of any kind.
