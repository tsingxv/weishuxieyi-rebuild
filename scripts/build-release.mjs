// scripts/build-release.mjs — assemble the all-in-one Release bundle (the zip the README promises).
//
// A fresh clone is NOT runnable: `node_modules/`, `public/vendor/`, `public/assets/`, `public/fonts/` and the
// per-machine `data/local-assets.json` are all git-ignored (they are third-party builds or
// Hypergryph/Yostar art, see .gitignore and NOTICE.md). The bundle exists so a friend can unzip and
// double-click `scripts\start-windows.bat` with no npm, no downloads and no terminal.
//
// Everything the bundle carries is already on this machine in a working checkout — this script only
// COPIES it (nothing is downloaded), verifies the result, and optionally zips it.
//
// Layout inside the zip (what the README tells the user to expect):
//
//   Stronghold-Protocol-v<version>/
//     README.md  LICENSE  NOTICE.md  THIRD-PARTY-NOTICES.md
//     package.json  node_modules/          ← dependencies (npm ci output, incl. each package's own licence)
//     public/{assets,fonts,vendor}/        ← art/audio/fonts/client libs
//     data/ (+ local-assets.json)          ← official-derived data and the local-art manifest
//     server/ shared/ client/ server-app/ scripts/ tools/ test/ docs/
//     START-HERE.txt                       ← what to double-click
//
// Usage:
//   node scripts/build-release.mjs                 # dist/Stronghold-Protocol-v0.1.0/ (+ --zip)
//   node scripts/build-release.mjs --zip           # also write the .zip next to it
//   node scripts/build-release.mjs --no-node-modules   # tiny bundle; the user runs `npm ci` themselves
//   node scripts/build-release.mjs --out=D:\rel --name=Stronghold-Protocol
//
// `--no-node-modules` is for people who would rather not ship a 460 MB dependency tree; the bundle then
// carries a START-HERE.txt that tells the user to run `npm ci` once.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n, d = '') => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const NAME = value('name', `Stronghold-Protocol-v${VERSION}`);
const outRoot = path.resolve(ROOT, value('out', 'dist'));
const target = path.join(outRoot, NAME);
const withZip = flag('zip');
const withNodeModules = !flag('no-node-modules');

/** Copied as-is (code, docs, small committed data). */
const PAYLOAD = ['server', 'shared', 'public', 'data', 'client', 'server-app', 'scripts', 'tools', 'test', 'docs'];
/** Top-level files worth carrying (the legal ones are mandatory — see NOTICE.md §3: "再分发完整包时请保留本声明"). */
const ROOT_FILES = ['README.md', 'LICENSE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md', 'package.json', 'package-lock.json', '.gitignore'];
/** Directories under public/ that are git-ignored but required to run. */
const PUBLIC_EXTRA = ['assets', 'fonts', 'vendor'];
/** Git-ignored but needed for the optional official 3D board. */
const OPTIONAL = ['data/local-assets.json'];

let failures = 0;
const log = (m) => console.log(`  ${m}`);
const bad = (m) => { failures++; console.error(`  ✗ ${m}`); };
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

function sizeOf(p) {
  let bytes = 0;
  let files = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = fs.statSync(cur); } catch { continue; }
    if (st.isDirectory()) {
      let entries = [];
      try { entries = fs.readdirSync(cur); } catch { continue; }
      for (const e of entries) stack.push(path.join(cur, e));
    } else { bytes += st.size; files++; }
  }
  return { bytes, files };
}

function copyDir(from, to, label, { skip = null } = {}) {
  if (!fs.existsSync(from)) { bad(`missing ${label}: ${path.relative(ROOT, from)}`); return { bytes: 0, files: 0 }; }
  // `skip` keeps the big git-ignored trees (assets/fonts/vendor) out of the first pass: they are copied
  // explicitly afterwards, so filtering here avoids copying ~315 MB twice.
  const filter = skip ? (src) => !skip.has(path.basename(src)) || src === from : undefined;
  fs.cpSync(from, to, { recursive: true, ...(filter ? { filter } : {}) });
  const s = sizeOf(to);
  log(`copy ${label.padEnd(22)} ${String(s.files).padStart(6)} files  ${mb(s.bytes)}`);
  return s;
}

console.log(`\n  卫戍协议：盟约 · Release 整合包打包 v${VERSION}`);
console.log(`  目标: ${path.relative(ROOT, target)}${withNodeModules ? '' : '  (不含 node_modules)'}\n`);

if (fs.existsSync(target)) {
  log(`clean ${path.relative(ROOT, target)}`);
  fs.rmSync(target, { recursive: true, force: true });
}
fs.mkdirSync(target, { recursive: true });

// 1. code + docs + committed data -------------------------------------------------------------
let total = { bytes: 0, files: 0 };
const add = (s) => { total.bytes += s.bytes; total.files += s.files; };
const SKIP_IN_PUBLIC = new Set(PUBLIC_EXTRA);
for (const dir of PAYLOAD) {
  const opts = dir === 'public' ? { skip: SKIP_IN_PUBLIC } : {};
  add(copyDir(path.join(ROOT, dir), path.join(target, dir), `${dir}/`, opts));
}
for (const f of ROOT_FILES) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) continue;
  fs.copyFileSync(src, path.join(target, f));
}

// 2. the git-ignored runtime pieces ----------------------------------------------------------
//    `public/` was copied above without these subtrees, so they are added here.
for (const sub of PUBLIC_EXTRA) {
  const from = path.join(ROOT, 'public', sub);
  const to = path.join(target, 'public', sub);
  if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
  add(copyDir(from, to, `public/${sub}/`));
}
for (const rel of OPTIONAL) {
  const from = path.join(ROOT, rel);
  if (!fs.existsSync(from)) { log(`skip ${rel} (not present on this machine — the 3D board stays unavailable)`); continue; }
  const to = path.join(target, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  add({ bytes: fs.statSync(to).size, files: 1 });
  log(`copy ${rel.padEnd(22)} (local extracted art manifest)`);
}
if (withNodeModules) add(copyDir(path.join(ROOT, 'node_modules'), path.join(target, 'node_modules'), 'node_modules/'));

// 3. START-HERE.txt --------------------------------------------------------------------------
const startHere = [
  `卫戍协议：盟约 · Stronghold Protocol v${VERSION}   —— 开箱即玩整合包`,
  '',
  '【怎么开始】',
  '  1. 安装 Node.js 22 或 24（必装，游戏服务器需要它）：',
  '     Windows：PowerShell 里运行  winget install OpenJS.NodeJS.LTS',
  '              或到 https://nodejs.org/zh-cn/download 下载安装包',
  '     macOS：  brew install node@22    Linux：用发行版的包管理器',
  '  2. 启动：',
  '     Windows：双击  scripts\\start-windows.bat',
  '     macOS / Linux：在解压出的文件夹里运行  ./scripts/start.sh',
  '     首次启动若弹出「安全警告」，点「运行」；Windows 防火墙弹窗请勾选「专用网络」并允许。',
  '  3. 浏览器会自动打开 http://localhost:3000 。',
  '     终端里会列出局域网地址（形如 http://192.168.x.x:3000），把它发给同一网络的朋友即可联机。',
  '     关闭那个窗口（或按 Ctrl+C）就是停止服务器。',
  '',
  withNodeModules
    ? '【说明】本整合包已附带依赖（node_modules），无需联网安装。'
    : '【说明】本整合包未附带依赖。请先在文件夹里执行一次：npm ci   （或 npm install）',
  '【快捷键】进游戏后：R 刷新 · F 冻结 · D 升级 · Space 准备就绪 · Esc 取消/关闭',
  '',
  '【不要删除】LICENSE / NOTICE.md / THIRD-PARTY-NOTICES.md —— 再分发时必须保留。',
  '',
  '【版权】本项目是《明日方舟》「卫戍协议：盟约」的非官方同人复刻，与上海鹰角网络科技有限公司',
  '        （Hypergryph）、Yostar 及其关联方无任何关联，未获授权或认可。',
  '        游戏素材（美术 / 音乐 / 音效 / 文本 / 数据）版权归鹰角网络及其许可方所有，',
  '        不在本项目 GPL-3.0 许可范围内。',
  '        仅供学习交流与个人非商业使用，严禁任何形式盈利（禁止售卖、付费分发、收费开服、广告等）。',
  '        完整条款见 NOTICE.md。权利人若认为不妥，可通过 Issue 联系，我们会立即删除。',
  '',
  `【代码来源】本项目基于上游 sganggs/Stronghold-Protocol 继续开发，代码同样以 GPL-3.0-or-later 发布。`,
  '            详见 NOTICE.md 第 0 节。',
  '',
].join('\r\n');
fs.writeFileSync(path.join(target, 'START-HERE.txt'), startHere, 'utf8');
log('write START-HERE.txt');

// 4. verify the bundle actually runs ------------------------------------------------------------
//    Check the essentials exist and are non-trivial: the point of the bundle is that the user does not
//    have to fetch anything, so a missing public/assets or an empty vendor dir must fail the build.
console.log('');
fs.mkdirSync(outRoot, { recursive: true });
const mustExist = [
  ['package.json'], ['server/index.js'], ['public/index.html'], ['public/vendor/preact.module.js'],
  ['public/vendor/pixi.min.js'], ['data/config.json'], ['data/chess.json'], ['scripts/start-windows.bat'],
  ['NOTICE.md'], ['LICENSE'], ['START-HERE.txt'],
];
for (const [rel] of mustExist) if (!fs.existsSync(path.join(target, rel))) bad(`bundle is missing ${rel}`);

for (const [rel, minFiles] of [['public/assets', 100], ['public/fonts', 1], ['public/vendor', 4]]) {
  const p = path.join(target, rel);
  const s = sizeOf(p);
  if (s.files < minFiles) bad(`${rel} has only ${s.files} files (expected ≥ ${minFiles}) — did fetching/vendoring run?`);
}
if (withNodeModules && sizeOf(path.join(target, 'node_modules')).files < 100) bad('node_modules looks empty — run npm ci first?');

// The bundle must not carry the two exe build outputs (separate deliverables, ~1.4 GB).
if (fs.existsSync(path.join(target, 'dist'))) bad('bundle contains dist/ (the exe builds are separate deliverables)');

const zipPath = path.join(outRoot, `${NAME}.zip`);
if (withZip) {
  console.log('');
  log(`zip → ${path.relative(ROOT, zipPath)} (several minutes for ~800 MB)…`);
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  const r = spawnSync('tar.exe', ['-a', '-c', '-f', zipPath, '-C', outRoot, NAME], { stdio: 'inherit' });
  if (r.error || r.status !== 0) bad(`zip failed: ${r.error?.message || `exit ${r.status}`}`);
  else log(`✓ ${path.relative(ROOT, zipPath)}  (${mb(fs.statSync(zipPath).size)})`);
}

console.log('');
if (failures) {
  console.error(`  ✗ ${failures} 项检查未通过 — 整合包不完整，不要发布\n`);
  process.exitCode = 1;
} else {
  console.log(`  ✓ ${path.relative(ROOT, target)}  (${total.files} files, ${mb(total.bytes)})`);
  console.log(`  ✓ 自检通过：解压后双击 scripts\\start-windows.bat 即可开玩`);
  if (!withZip) console.log(`  提示：加 --zip 可直接生成可上传的 ${NAME}.zip\n`);
  else console.log('');
}
