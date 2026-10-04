// scripts/build-server.mjs — assemble the portable Windows game server (server-app/): 开服面板 + 内嵌服务器.
//
// This is the mirror image of scripts/build-client.mjs. Where the client is a shell that CONNECTS to somebody
// else's server, this one IS the server: one double-click starts the real game server (server/index.js, the
// same code `npm start` runs, see docs/DEPLOY.md) in-process and opens a small panel that shows every address
// to send to friends.
//
// The repository layout is kept inside `resources/app` for the same reason as the client — and one more:
// server-app/main.js does `import { startServer } from '../server/index.js'`, which must resolve to
// `resources/app/server/index.js`, and server/index.js itself imports `../shared/*.js` and reads `data/`
// and `public/` relatively.
//
//   dist/weishuxieyi-server/
//     StrongholdProtocolServer.exe    (renamed electron.exe)
//     <electron runtime files>
//     启动服务器.cmd                   (sandbox probe + ELECTRON_DISABLE_SANDBOX fallback)
//     使用说明.txt                     (Chinese quick start — read this one)
//     resources/app/
//       package.json                  (main = server-app/main.js — generated here)
//       server-app/                   (main, preload, panel.html, shareInfo)
//       server/  shared/  data/  public/
//       node_modules/ws/              (the only runtime dependency)
//
// Nothing is packed into an asar (same reasoning as the client build: the static handler stats and streams
// real files, and a host can swap `public/assets` without rebuilding the shell).
//
// Usage:
//   node scripts/build-server.mjs [--port=3000] [--out=dist] [--zip] [--no-clean]
//
// ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR are NOT needed: the already-installed
// node_modules/electron/dist is reused as-is.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT = 'StrongholdProtocolServer';
const APP_NAME = 'weishuxieyi-server';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const outRoot = path.resolve(ROOT, value('out', 'dist'));
const target = path.join(outRoot, APP_NAME);
const wantZip = flag('zip');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
const electronPkg = path.join(ROOT, 'node_modules', 'electron', 'package.json');

/** Directories copied into resources/app, in the repository layout server-app/main.js expects. */
const PAYLOAD = ['server-app', 'server', 'shared', 'data', 'public'];
/** The only runtime npm dependency (server/index.js imports it for the WebSocket server). */
const RUNTIME_DEPS = ['ws'];

/** Files the shell needs; anything else in server-app/ (notes, tests) is not shipped. */
const SERVER_APP_FILES = ['main.js', 'shareInfo.js', 'panel-preload.cjs', 'panel.html'];

function fail(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { files++; try { bytes += fs.statSync(p).size; } catch { /* ignore */ } }
    }
  }
  return { bytes, files };
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** The port baked into the generated 使用说明.txt and the panel's default. */
function defaultPort() {
  const raw = value('port', process.env.PORT || '3000');
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000;
}
const PORT = defaultPort();

if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
  fail(`electron runtime not found at ${electronDist}\n    install it first: ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/ npm.cmd install --no-save electron@44.0.0`);
}
if (!fs.existsSync(electronPkg)) fail('node_modules/electron/package.json is missing');
for (const file of SERVER_APP_FILES) {
  if (!fs.existsSync(path.join(ROOT, 'server-app', file))) fail(`missing server-app/${file}`);
}

const electronVersion = JSON.parse(fs.readFileSync(electronPkg, 'utf8')).version;
console.log(`\n  卫戍协议：盟约 · 独立服务器打包 (Electron ${electronVersion}, 默认端口 ${PORT})`);
console.log(`  payload: ${PAYLOAD.join(', ')} + node_modules/{${RUNTIME_DEPS.join(',')}}`);

if (flag('no-clean') === false && fs.existsSync(target)) {
  console.log(`  clean ${path.relative(ROOT, target)}`);
  fs.rmSync(target, { recursive: true, force: true });
}
fs.mkdirSync(target, { recursive: true });

// 1. the Electron runtime -----------------------------------------------------
console.log('  copy electron runtime…');
fs.cpSync(electronDist, target, { recursive: true });
const renamed = path.join(target, `${PRODUCT}.exe`);
fs.renameSync(path.join(target, 'electron.exe'), renamed);
// The default-app bundle would only ever be used if resources/app went missing; drop it so a broken install
// fails loudly instead of silently launching Electron's demo app.
const defaultApp = path.join(target, 'resources', 'default_app.asar');
if (fs.existsSync(defaultApp)) fs.rmSync(defaultApp);

// 2. the app directory --------------------------------------------------------
const appDir = path.join(target, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });

// server-app/ ships file by file: everything a host must not double-click lives outside this list.
process.stdout.write('  copy server-app/ … ');
fs.mkdirSync(path.join(appDir, 'server-app'), { recursive: true });
for (const file of SERVER_APP_FILES) {
  fs.copyFileSync(path.join(ROOT, 'server-app', file), path.join(appDir, 'server-app', file));
}
console.log(`${SERVER_APP_FILES.length} files`);

for (const dir of PAYLOAD.filter((d) => d !== 'server-app')) {
  const from = path.join(ROOT, dir);
  if (!fs.existsSync(from)) fail(`missing payload directory ${dir}/`);
  process.stdout.write(`  copy ${dir}/ … `);
  fs.cpSync(from, path.join(appDir, dir), { recursive: true });
  const s = dirSize(path.join(appDir, dir));
  console.log(`${s.files} files, ${mb(s.bytes)}`);
}
for (const dep of RUNTIME_DEPS) {
  const from = path.join(ROOT, 'node_modules', dep);
  if (!fs.existsSync(from)) fail(`missing runtime dependency node_modules/${dep}`);
  fs.cpSync(from, path.join(appDir, 'node_modules', dep), { recursive: true });
}

// 3. manifests ----------------------------------------------------------------
// No `productName`: Electron derives `app.getPath('userData')` from it, and an ASCII directory name is
// friendlier than %APPDATA%\卫戍协议：盟约. The window title carries the Chinese name instead.
const appPkg = {
  name: 'weishuxieyi-server',
  version: pkg.version,
  private: true,
  description: '卫戍协议：盟约 独立服务器（非官方同人作品）',
  type: 'module',
  main: 'server-app/main.js',
  license: pkg.license,
};
fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(appPkg, null, 2)}\n`, 'utf8');

fs.writeFileSync(path.join(appDir, 'server-app', 'build-info.json'), `${JSON.stringify({
  name: appPkg.name,
  version: pkg.version,
  electron: electronVersion,
  defaultPort: PORT,
  builtAt: new Date().toISOString(),
}, null, 2)}\n`, 'utf8');

// 3b. launcher ----------------------------------------------------------------
// Same sandbox story as the client (scripts/build-client.mjs): on a few Windows builds — and in any folder
// carrying low-integrity ACLs, such as a sandboxed DSH workspace — Chromium's sandbox cannot initialise and
// the process dies before any of our code runs, with STATUS_BREAKPOINT (-2147483645). Electron's documented
// opt-out is ELECTRON_DISABLE_SANDBOX, which only whatever starts the process can set — hence this launcher.
// The probe is the app's own `--sandbox-probe`: it reaches `app.whenReady()` and exits 0 when the sandbox
// works and dies non-zero when it does not (a packaged Electron app ignores `--version`, so that cannot be
// used).
//
// Every line here is ASCII on purpose: a .cmd is parsed in the console's OEM codepage, so a Chinese comment
// (even in a `rem`) or a Chinese path in an argument turns into mojibake. The Chinese instructions live in
// 使用说明.txt, whose name is fine because it is read by Explorer/Notepad as UTF-8, not by cmd.
const launcher = path.join(target, '启动服务器.cmd');
fs.writeFileSync(launcher, [
  '@echo off',
  'rem Stronghold Protocol - standalone game server launcher.',
  'rem Double-click this file to host a game.',
  'rem If Chromium\'s sandbox cannot start on this machine (the window flashes and closes),',
  'rem this launcher detects it and retries with ELECTRON_DISABLE_SANDBOX=1.',
  'rem Extra arguments are passed through, for example:  <this file> --port 3001',
  'setlocal',
  `set "EXE=%~dp0${PRODUCT}.exe"`,
  'if not exist "%EXE%" (',
  `  echo [ERROR] ${PRODUCT}.exe was not found next to this file.`,
  '  echo         Keep the whole folder together when moving or unzipping it.',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'rem The probe starts no server: it only asks whether the browser sandbox can initialise here.',
  'start /wait "" "%EXE%" --sandbox-probe >nul 2>&1',
  'if not "%ERRORLEVEL%"=="0" (',
  '  echo [INFO] The browser sandbox is unavailable on this machine.',
  '  echo [INFO] Starting with ELECTRON_DISABLE_SANDBOX=1 instead.',
  '  set "ELECTRON_DISABLE_SANDBOX=1"',
  ')',
  '',
  'rem Default port, only when the caller did not set one (--port= wins over PORT).',
  'if not defined PORT set "PORT=' + PORT + '"',
  '',
  'rem Not "start /wait": the panel window is the server, so this file may close right away.',
  'start "" "%EXE%" %*',
  'exit /b 0',
  '',
].join('\r\n'), 'utf8');

fs.writeFileSync(path.join(target, '使用说明.txt'), `\ufeff${[
  `卫戍协议：盟约 · 独立服务器 v${pkg.version}`,
  '',
  '【怎么开服】双击 启动服务器.cmd （推荐）。',
  `         也可以直接双击 ${PRODUCT}.exe；只有在极少见的系统上它才会一闪即退，`,
  '         那种情况下请改用 启动服务器.cmd，它会自动切换模式。',
  '',
  '【开服后做什么】窗口里就是“开服面板”，它已经帮你把该发的都准备好了：',
  `         1. 「发给朋友的地址」里点“复制”，把地址发到群里（默认端口 ${PORT}）。`,
  '         2. 朋友用浏览器打开那个地址（手机、平板都行），下载/进入游戏。',
  '         3. 你建房后会得到一个 4 位房间密钥：填进面板的「房间邀请链接」框，',
  '            点“生成链接”→“复制链接”，发出去朋友点开就直接进房间。',
  '         4. 懒得分条发？点「一键复制全部」，把整段贴到聊天里即可。',
  '',
  '【关掉窗口 = 停止开服】面板窗口就是服务器本体：窗口开着朋友才连得上，最小化没问题，别关。',
  '        想让服务器在后台长期运行 / 开机自启：用 npm start + scripts\\install-service-windows.ps1，',
  '        见 docs\\DEPLOY.md 第 1.4 节。',
  '',
  '【换端口】启动服务器.cmd --port 3001   （或设置环境变量 PORT；参数优先）',
  '         也可以改监听地址：--host=127.0.0.1（只允许本机，别人连不上）',
  '',
  '【朋友连不上怎么办】',
  `         1. 第一次开服 Windows 会弹“安全中心警报”：勾“专用网络”→“允许访问”。`,
  '            没弹或点错了，用【管理员】PowerShell 执行（面板上也有“复制防火墙命令”）：',
  `            netsh advfirewall firewall add rule name="Stronghold Protocol" dir=in action=allow protocol=TCP localport=${PORT} profile=private,domain`,
  '         2. 网络被识别成“公用网络”时 Windows 会拦截入站，管理员 PowerShell：',
  '            Set-NetConnectionProfile -InterfaceAlias "以太网" -NetworkCategory Private',
  '         3. 同一路由器下用“局域网”那条地址；不在同一网络就用 Radmin VPN：',
  '            双方都装 Radmin VPN 并加入同一个网络，用面板上带 Radmin 的那条地址，',
  '            例如 26.100.222.17:3000。注意：那个 26.x 是虚拟地址，不是公网 IP。',
  '         4. 访客 Wi-Fi 常开“AP 隔离”，同一个 Wi-Fi 也连不上——换路由器或用 Radmin VPN。',
  '         5. 主机 IP 变了地址就失效：在路由器里给这台电脑绑定固定 IP（DHCP 地址保留）。',
  '         6. 让朋友确认地址填对了：不能填 localhost（那是他自己那台机器）。',
  '         7. 更多排错：docs\\DEPLOY.md 第 5 节（端口占用 / AP 隔离 / 专用网络）。',
  '',
  '【日志】菜单「帮助 → 打开日志文件夹」，或直接看 %APPDATA%\\weishuxieyi-server\\server.log',
  '         （启动失败、端口被占用等都会写在这里；反馈问题时请附上这个文件。）',
  '',
  '【数据与存档】服务器不保存对局进度：关掉窗口/重启会结束进行中的对局，玩家等级、',
  '        收藏等数据存在各自的浏览器里，不会丢。素材全部打包在本文件夹内，离线可用。',
  '',
  '【安全提醒】端口开放给谁、发给谁，请自己把握：只发给信任的人。做端口转发到公网前，',
  '        请先想清楚风险（本项目没有账号系统，也没有反作弊）。',
  '',
  '非官方同人作品，仅供个人非商业联机游玩；素材版权归鹰角网络所有。',
  '',
].join('\r\n')}`, 'utf8');

// 4. report -------------------------------------------------------------------
const total = dirSize(target);
console.log(`  ✓ ${path.relative(ROOT, renamed)}  (whole folder ${mb(total.bytes)}, ${total.files} files)`);
console.log(`  ✓ ${path.relative(ROOT, launcher)}`);

if (wantZip) {
  const zip = path.join(outRoot, `${APP_NAME}.zip`);
  if (fs.existsSync(zip)) fs.rmSync(zip);
  console.log(`  zip → ${path.relative(ROOT, zip)} (this takes a few minutes for ~600 MB)…`);
  // Same rule as build-release.mjs: Windows' own tar.exe (bsdtar) writes a real .zip; a Git-bash PATH may
  // shadow it with GNU tar (plain tar under a .zip name — caught by the PK check below).
  const tarBin = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const r = spawnSync(tarBin, ['-a', '-c', '-f', zip, '-C', outRoot, APP_NAME], { stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error(`  ! zip failed (${r.error?.message || `exit ${r.status}`}) — the folder above is still usable`);
    process.exitCode = 1;
  } else {
    const fd = fs.openSync(zip, 'r');
    const magic = Buffer.alloc(2);
    fs.readSync(fd, magic, 0, 2, 0);
    fs.closeSync(fd);
    if (magic.toString('latin1') !== 'PK') {
      console.error(`  ! ${path.basename(tarBin)} did not write a real zip — the folder above is still usable`);
      process.exitCode = 1;
    } else {
      console.log(`  ✓ ${path.relative(ROOT, zip)}  (${mb(fs.statSync(zip).size)})`);
    }
  }
}

console.log('\n  smoke: node scripts/smoke-server.mjs --run-from=E:\\_sp-server-run\n');
