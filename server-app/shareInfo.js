// server-app/shareInfo.js — "what do I send my friends?" — the connection info the control panel shows.
//
// Pure module: no Electron, no I/O beyond `os.networkInterfaces()` (the caller passes the port in), so the
// Electron main process, the panel and a plain `node -e` check can all use the same numbers.
//
// Address classification mirrors `tools/doctor.mjs` → `classifyAddresses()` — the code that already decides
// "which address can a friend actually type" — with one intentional addition: an interface whose name
// contains "Radmin" gets its own `radmin` kind. That matters here because
//   192.168.1.2     (WLAN, DHCP)
//   26.100.222.17   (Radmin VPN)
// is exactly the pair docs/DEPLOY.md §2 and docs/CLIENT.md §5 tell players to exchange, while doctor.mjs
// files 26.100.222.17 under "公网 IP" (it neither matches VPN_IF nor 100.64/10) — which would make the
// invitation text tell the host to hand out a public address that is really a private VPN address.
//
// `virtualInterface` and `linkLocal` entries are listed last (and labelled "朋友一般连不上") instead of being
// hidden: hiding them would leave the host with an empty panel on a machine whose only adapter is Hyper-V/WSL.

import os from 'node:os';

/** Interface names that are virtual adapters — usually not reachable from another computer. */
const VIRTUAL_IF = /(vethernet|virtualbox|vmware|vmnet|docker|^br-|^veth|wsl|hyper-v|vboxnet|bridge\d|utun|awdl|llw|parallels|loopback)/i;
/** Interface names of the usual "virtual LAN" tools. */
const VPN_IF = /(tailscale|zerotier|^zt|wireguard|^wg\d|tun\d|tap)/i;
/** Radmin VPN — this project's most common way of playing with friends who are not on the same router. */
const RADMIN_IF = /radmin/i;

/** `kind` → the Chinese label shown next to the address (and in the copied text). */
export const KIND_LABEL = Object.freeze({
  lan: '局域网（同一路由器）',
  radmin: 'Radmin VPN',
  vpn: 'VPN（Tailscale / ZeroTier）',
  public: '公网 IP',
  virtual: '虚拟网卡（朋友一般连不上）',
  linklocal: '无效地址（没拿到 IP）',
});

/** Best first: what a friend is most likely to be able to open. */
const RANK = { lan: 0, radmin: 1, vpn: 2, public: 3, virtual: 4, linklocal: 5 };

/** `kind` → short label for the clipboard text (the panel shows the long one). */
const SHORT_LABEL = {
  lan: '同一路由器',
  radmin: 'Radmin VPN',
  vpn: 'VPN',
  public: '公网',
  virtual: '虚拟网卡',
  linklocal: '无效',
};

function ipv4ToInt(ip) { return ip.split('.').reduce((n, x) => (n << 8) + Number(x), 0) >>> 0; }

function inCidr(ip, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

/**
 * Every non-internal IPv4 address of this machine, classified and sorted.
 * @param {ReturnType<typeof os.networkInterfaces>} [ifaces]
 * @returns {{ name: string, address: string, kind: keyof KIND_LABEL, label: string }[]}
 */
export function classifyAddresses(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    for (const a of addrs || []) {
      if (!(a.family === 'IPv4' || a.family === 4) || a.internal) continue;
      const ip = a.address;
      let kind;
      if (inCidr(ip, '169.254.0.0', 16)) kind = 'linklocal';
      else if (RADMIN_IF.test(name)) kind = 'radmin';
      else if (VPN_IF.test(name) || inCidr(ip, '100.64.0.0', 10)) kind = 'vpn';
      else if (VIRTUAL_IF.test(name)) kind = 'virtual';
      else if (inCidr(ip, '10.0.0.0', 8) || inCidr(ip, '172.16.0.0', 12) || inCidr(ip, '192.168.0.0', 16)) kind = 'lan';
      else kind = 'public';
      out.push({ name, address: ip, kind, label: KIND_LABEL[kind] });
    }
  }
  return out.sort((x, y) => RANK[x.kind] - RANK[y.kind] || x.name.localeCompare(y.name) || x.address.localeCompare(y.address));
}

/**
 * The addresses to hand out, already turned into URLs.
 * @param {number} port
 * @param {ReturnType<typeof os.networkInterfaces>} [ifaces]
 * @returns {{ address: string, iface: string, kind: string, label: string, url: string }[]}
 */
export function shareTargets(port, ifaces) {
  return classifyAddresses(ifaces).map((a) => ({ ...a, iface: a.name, url: `http://${a.address}:${port}` }));
}

/** `http://<address>:<port>/?room=CODE` — the link the game itself copies (public/js/screens/room.js). */
export function inviteUrl(base, code) {
  const origin = String(base || '').replace(/\/+$/, '');
  const room = String(code || '').trim().toUpperCase();
  return room ? `${origin}/?room=${encodeURIComponent(room)}` : origin;
}

/** The administrator one-liner from docs/DEPLOY.md §1.2, with the port filled in. */
export function firewallCommand(port) {
  return `netsh advfirewall firewall add rule name="Stronghold Protocol" dir=in action=allow protocol=TCP localport=${port} profile=private,domain`;
}

/**
 * The "一键复制全部" block: plain text, one link per line, written to be pasted into a chat app.
 * @param {{ port: number, targets: {label: string, kind: string, address: string, url: string}[], invite?: string|null, roomCode?: string|null, version?: string }} info
 * @returns {string}
 */
export function formatShareText({ port, targets = [], invite = null, roomCode = null, version = '' } = {}) {
  const lines = [`卫戍协议：盟约 · 联机邀请${version ? `（服务器 v${version}）` : ''}`];
  if (targets.length) {
    lines.push('用浏览器打开下面任意一条（能打开哪条就用哪条）：');
    targets.forEach((t, i) => lines.push(`  ${i + 1}) ${SHORT_LABEL[t.kind] ?? t.kind}：${t.url}`));
  } else {
    lines.push('没有检测到可分享的地址：这台电脑似乎没有局域网 / VPN 网卡，朋友暂时连不上。');
  }
  if (invite && roomCode) lines.push(`房间邀请链接（打开即加入）：${invite}`);
  else lines.push('房间邀请链接：建房后把 4 位密钥填进面板的「房间邀请链接」，点“生成链接”再复制。');
  lines.push(`端口：${port}（房主防火墙要放行 TCP ${port}，Windows 首次启动弹窗请勾「专用网络」→「允许访问」）`);
  lines.push('不在同一个路由器下：双方都装 Radmin VPN 并加入同一个网络，用上面带 Radmin 的那条地址。');
  return lines.join('\r\n');
}
