// scripts/build-client.mjs — assemble the portable Windows desktop client (client/).
//
// The client is the same web game plus an Electron shell (see client/main.js), and it deliberately keeps
// the repository layout inside `resources/app`:
//
//   dist/weishuxieyi-client/
//     StrongholdProtocol.exe          (renamed electron.exe)
//     <electron runtime files>
//     resources/app/
//       package.json                  (main = client/main.js — generated here)
//       client/                       (shell: main, preload, settings UI, build-info.json)
//       public/  data/  shared/  server/   (payload served over loopback)
//       node_modules/ws/              (the only runtime dependency)
//
// Nothing is packed into an asar: the static handler stats/streams every asset, so real files on disk
// keep it identical to the server (and let a player swap `public/assets` without rebuilding the shell).
//
// Usage:
//   node scripts/build-client.mjs [--default-server=192.168.1.2:3000] [--out=dist] [--zip] [--no-clean]
//
// ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR are NOT needed here: the already-installed
// node_modules/electron/dist is reused as-is.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT = 'StrongholdProtocol';
const APP_NAME = 'weishuxieyi-client';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const outRoot = path.resolve(ROOT, value('out', 'dist'));
const target = path.join(outRoot, APP_NAME);
const defaultServer = value('default-server', process.env.SP_DEFAULT_SERVER || '');
const wantZip = flag('zip');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
const electronPkg = path.join(ROOT, 'node_modules', 'electron', 'package.json');

/** Directories copied into resources/app, in the repository layout the shell expects. */
const PAYLOAD = ['client', 'public', 'data', 'shared', 'server'];
/** The only runtime npm dependency of the shell (server/index.js imports it for the WS server). */
const RUNTIME_DEPS = ['ws'];

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

if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
  fail(`electron runtime not found at ${electronDist}\n    install it first: ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/ npm.cmd install --no-save electron@44.5.1`);
}
if (!fs.existsSync(electronPkg)) fail('node_modules/electron/package.json is missing');

const electronVersion = JSON.parse(fs.readFileSync(electronPkg, 'utf8')).version;
console.log(`\n  卫戍协议：盟约 · 桌面客户端打包 (Electron ${electronVersion})`);
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
// The default-app bundle would only ever be used if resources/app went missing; drop it so a broken
// install fails loudly instead of silently launching Electron's demo app.
const defaultApp = path.join(target, 'resources', 'default_app.asar');
if (fs.existsSync(defaultApp)) fs.rmSync(defaultApp);

// 2. the app directory --------------------------------------------------------
const appDir = path.join(target, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
for (const dir of PAYLOAD) {
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
  name: 'weishuxieyi-client',
  version: pkg.version,
  private: true,
  description: '卫戍协议：盟约 桌面客户端（非官方同人作品）',
  type: 'module',
  main: 'client/main.js',
  license: pkg.license,
};fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(appPkg, null, 2)}\n`, 'utf8');

fs.writeFileSync(path.join(appDir, 'client', 'build-info.json'), `${JSON.stringify({
  name: appPkg.name,
  version: pkg.version,
  electron: electronVersion,
  builtAt: new Date().toISOString(),
  defaultServer,
}, null, 2)}\n`, 'utf8');

// 3b. launcher ----------------------------------------------------------------
// On a few Windows builds (and in any folder carrying low-integrity ACLs, such as a sandboxed DSH
// workspace) Chromium's sandbox cannot initialise and the process dies before any of our code runs,
// with STATUS_BREAKPOINT (-2147483645). Electron's documented opt-out is the ELECTRON_DISABLE_SANDBOX
// environment variable, which can only be set by whatever starts the process — hence this launcher.
// The probe is the client's own `--sandbox-probe`: it reaches `app.whenReady()` and exits 0 when the
// sandbox works, and dies with a non-zero status when it does not (a packaged Electron app ignores
// `--version`, so that cannot be used). ASCII-only: a .cmd is read in the console's OEM codepage, so
// Chinese text here would print as mojibake (the Chinese instructions live in 使用说明.txt instead).
const launcher = path.join(target, '启动游戏.cmd');
fs.writeFileSync(launcher, [
  '@echo off',
  'rem Stronghold Protocol - desktop client launcher.',
  'rem Double-click this file to play. If Chromium\'s sandbox cannot start on this machine',
  'rem (the window flashes and closes), the launcher retries with ELECTRON_DISABLE_SANDBOX=1.',
  'setlocal',
  `set "EXE=%~dp0${PRODUCT}.exe"`,
  'if not exist "%EXE%" (',
  `  echo [ERROR] ${PRODUCT}.exe not found next to this file.`,
  '  pause',
  '  exit /b 1',
  ')',
  'start /wait "" "%EXE%" --sandbox-probe >nul 2>&1',
  'if not "%ERRORLEVEL%"=="0" (',
  '  echo [INFO] Browser sandbox unavailable here - starting with ELECTRON_DISABLE_SANDBOX=1.',
  '  set "ELECTRON_DISABLE_SANDBOX=1"',
  ')',
  'start "" "%EXE%" %*',
  'exit /b 0',
  '',
].join('\r\n'), 'utf8');

fs.writeFileSync(path.join(target, '使用说明.txt'), `\ufeff${[
  `卫戍协议：盟约 · 桌面客户端 v${pkg.version}`,
  '',
  '【怎么开】双击 启动游戏.cmd （推荐）。',
  `         也可以直接双击 ${PRODUCT}.exe；只有在极少见的系统上它才会一闪即退，`,
  '         那种情况下请改用 启动游戏.cmd，它会自动切换模式。',
  '',
  '【第一次运行】会弹出“服务器设置”，填写开服那台电脑的地址：',
  '         同一路由器：房主的局域网地址，例如 192.168.1.2:3000',
  '         Radmin VPN ：房主的 Radmin 地址，例如 26.100.222.17:3000',
  '         端口默认 3000，可以省略。填好后点“测试连接”，成功后“保存并连接”。',
  '',
  '【换服务器】游戏窗口菜单：游戏 → 服务器设置…（快捷键 Ctrl+,）。',
  '',
  '【连不上怎么办】',
  '         1. 确认房主那边已经开着服务器（npm start / 启动脚本）。',
  '         2. 用“测试连接”看提示：超时=网络不通，HTTP 404=地址不是游戏服务器。',
  '         3. 房主电脑的防火墙要放行 3000 端口（专用网络）。',
  '         4. 日志：%APPDATA%\\weishuxieyi-client\\client.log（菜单“帮助→打开日志文件夹”）。',
  '',
  '【素材与数据】贴图、音频、游戏数据、战斗逻辑全部打包在本文件夹内（resources\\app），',
  '         离线也能进标题界面，只有与房主的对局数据通过 3000 端口的 WebSocket 同步。',
  '         游戏内所有其它外部网络请求（含 Google 字体）都会被客户端拦截，不会外联。',
  '',
  '非官方同人作品，仅供个人非商业联机游玩；素材版权归鹰角网络所有。',
  '',
].join('\r\n')}`, 'utf8');

// 4. report -------------------------------------------------------------------
const total = dirSize(target);
console.log(`  default server: ${defaultServer || '(none — the settings window asks on first run)'}`);
console.log(`  ✓ ${path.relative(ROOT, renamed)}  (whole folder ${mb(total.bytes)}, ${total.files} files)`);

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

console.log('\n  run: ' + path.relative(ROOT, renamed) + '\n');
