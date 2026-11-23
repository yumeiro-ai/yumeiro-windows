#!/usr/bin/env node
// Yumeiro 远程控制 · 被控端代理（Windows / macOS）
// 在要被远程查看/控制的电脑上运行；只做“出站”连接，不需要开放端口、不需要公网 IP。
//
//   首次配对：  node agent.mjs --server https://你的站点 --code ABCD-1234 [--allow-control | --view-only]
//   以后运行：  node agent.mjs
//   开机自启：  node agent.mjs --install-autostart      （取消：--uninstall-autostart）
//   自检截图：  node agent.mjs --self-test              （不联网，只测试本机能否截屏）
//
// 安全说明：
//   · 只有用 --allow-control 启动（或配对时选了“允许控制”并在本机确认过），才会执行鼠标键盘操作；默认只查看。
//   · 随时按 Ctrl+C 退出即停止一切；在网页里“取消配对”后，本代理下次联网会自动退出。
//   · 只有配对这台电脑的账号才能看到画面；服务器上会记录谁在什么时候查看 / 操作（不记录输入的文字内容）。
//   · Windows 的锁屏、UAC 弹窗界面属于系统保护桌面，普通程序截不到也点不了，这是系统限制。
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { homedir, hostname, platform, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0';
const here = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2), next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--') && ['server', 'code', 'name', 'config', 'backend', 'fps'].includes(key)) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const configFile = args.config ? path.resolve(String(args.config)) : path.join(homedir(), '.yumeiro-agent.json');
const loadConfig = () => { try { return JSON.parse(readFileSync(configFile, 'utf8')); } catch { return {}; } };
const saveConfig = value => { mkdirSync(path.dirname(configFile), { recursive: true }); writeFileSync(configFile, JSON.stringify(value, null, 2), { mode: 0o600 }); try { chmodSync(configFile, 0o600); } catch { /* Windows 不支持 */ } };

// ---------- 按键表 ----------
const VK = { enter: 0x0d, escape: 0x1b, tab: 0x09, backspace: 0x08, delete: 0x2e, space: 0x20, up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, insert: 0x2d, capslock: 0x14, meta: 0x5b, ctrl: 0x11, alt: 0x12, shift: 0x10 };
for (let i = 1; i <= 12; i++) VK['f' + i] = 0x6f + i;
const OEM = { '-': 0xbd, '=': 0xbb, '[': 0xdb, ']': 0xdd, ';': 0xba, "'": 0xde, ',': 0xbc, '.': 0xbe, '/': 0xbf, '\\': 0xdc, '`': 0xc0 };
const vkOf = key => VK[key] ?? (/^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : OEM[key] ?? null);

// ---------- Windows：常驻 PowerShell，通过 user32 截屏 / 注入输入 ----------
const PS_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class YM {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public static void Mouse(uint flags, uint data) { INPUT[] a = new INPUT[1]; a[0].type = 0; a[0].u.mi.dwFlags = flags; a[0].u.mi.mouseData = data; SendInput(1, a, Marshal.SizeOf(typeof(INPUT))); }
  public static void Key(ushort vk, bool up) { INPUT[] a = new INPUT[1]; a[0].type = 1; a[0].u.ki.wVk = vk; bool ext = (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B || vk == 0x5C; a[0].u.ki.dwFlags = (uint)((up ? 2 : 0) | (ext ? 1 : 0)); SendInput(1, a, Marshal.SizeOf(typeof(INPUT))); }
  public static void Uni(char c) { INPUT[] a = new INPUT[2]; a[0].type = 1; a[0].u.ki.wScan = c; a[0].u.ki.dwFlags = 4; a[1].type = 1; a[1].u.ki.wScan = c; a[1].u.ki.dwFlags = 6; SendInput(2, a, Marshal.SizeOf(typeof(INPUT))); }
}
'@
[void][YM]::SetProcessDPIAware()
$jpeg = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
function Cap([int]$maxW, [int]$q) {
  $b = [Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object Drawing.Bitmap($b.Width, $b.Height)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  try { $p = [Windows.Forms.Cursor]::Position; [Windows.Forms.Cursors]::Default.Draw($g, (New-Object Drawing.Rectangle(($p.X - $b.X), ($p.Y - $b.Y), 32, 32))) } catch { }
  $g.Dispose()
  $out = $bmp
  if ($b.Width -gt $maxW) {
    $nh = [int]($b.Height * $maxW / $b.Width)
    $out = New-Object Drawing.Bitmap($maxW, $nh)
    $g2 = [Drawing.Graphics]::FromImage($out)
    $g2.InterpolationMode = 'HighQualityBilinear'
    $g2.DrawImage($bmp, 0, 0, $maxW, $nh)
    $g2.Dispose(); $bmp.Dispose()
  }
  $ep = New-Object Drawing.Imaging.EncoderParameters(1)
  $ep.Param[0] = New-Object Drawing.Imaging.EncoderParameter([Drawing.Imaging.Encoder]::Quality, [long]$q)
  $ms = New-Object IO.MemoryStream
  $out.Save($ms, $jpeg, $ep)
  $res = "$($out.Width) $($out.Height) $($b.Width) $($b.Height) " + [Convert]::ToBase64String($ms.ToArray())
  $ms.Dispose(); $out.Dispose()
  return $res
}
function Neg([int]$v) { return [BitConverter]::ToUInt32([BitConverter]::GetBytes($v), 0) }
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $t = $line.Split(' ')
  $id = $t[0]
  try {
    switch ($t[1]) {
      'PING' { $r = 'OK' }
      'INFO' { $b = [Windows.Forms.Screen]::PrimaryScreen.Bounds; $r = "OK $($b.Width) $($b.Height)" }
      'CAP' { $r = 'OK ' + (Cap ([int]$t[2]) ([int]$t[3])) }
      'MOVE' { [void][YM]::SetCursorPos([int]$t[2], [int]$t[3]); $r = 'OK' }
      'BTN' {
        $f = 0
        if ($t[2] -eq 'left') { if ($t[3] -eq 'down') { $f = 2 } else { $f = 4 } }
        elseif ($t[2] -eq 'right') { if ($t[3] -eq 'down') { $f = 8 } else { $f = 16 } }
        else { if ($t[3] -eq 'down') { $f = 32 } else { $f = 64 } }
        [YM]::Mouse([uint32]$f, 0); $r = 'OK'
      }
      'WHEEL' {
        $dx = [int]$t[2]; $dy = [int]$t[3]
        if ($dy -ne 0) { [YM]::Mouse(0x800, (Neg (-1 * $dy * 120))) }
        if ($dx -ne 0) { [YM]::Mouse(0x1000, (Neg ($dx * 120))) }
        $r = 'OK'
      }
      'KEY' { [YM]::Key([uint16]$t[2], ($t[3] -eq 'up')); $r = 'OK' }
      'TEXT' { $s = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($t[2])); foreach ($c in $s.ToCharArray()) { [YM]::Uni($c) }; $r = 'OK' }
      default { $r = 'ERR unknown' }
    }
  } catch { $r = 'ERR ' + ($_.Exception.Message -replace '\s+', ' ') }
  [Console]::Out.WriteLine("$id $r")
  [Console]::Out.Flush()
}
`;

class WindowsBackend {
  name = 'windows'; canControl = true;
  async start() {
    this.file = path.join(tmpdir(), 'yumeiro-agent-' + process.pid + '.ps1');
    writeFileSync(this.file, '\ufeff' + PS_SCRIPT, 'utf8');
    this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.file], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.pending = new Map(); this.nextId = 1; this.buffer = ''; this.errors = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, ''); this.buffer = this.buffer.slice(index + 1);
        const space = line.indexOf(' '), id = line.slice(0, space), waiter = this.pending.get(id);
        if (waiter) { this.pending.delete(id); line.slice(space + 1).startsWith('OK') ? waiter.resolve(line.slice(space + 4)) : waiter.reject(new Error(line.slice(space + 5) || '失败')); }
      }
    });
    this.child.stderr.setEncoding('utf8'); this.child.stderr.on('data', chunk => { this.errors += chunk; });
    this.child.on('exit', code => { for (const waiter of this.pending.values()) waiter.reject(new Error('PowerShell 已退出（' + code + '）' + this.errors.trim().slice(0, 300))); this.pending.clear(); this.dead = true; });
    await this.send('PING', 30000);
    const info = (await this.send('INFO')).trim().split(' ').map(Number);
    this.sw = info[0]; this.sh = info[1];
  }
  send(command, timeoutMs = 15000) {
    if (this.dead) return Promise.reject(new Error('PowerShell 已退出'));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('操作超时')); }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.child.stdin.write(id + ' ' + command + '\n');
    });
  }
  async capture(maxWidth, quality) {
    const parts = (await this.send('CAP ' + maxWidth + ' ' + quality, 30000)).split(' ');
    return { w: Number(parts[0]), h: Number(parts[1]), sw: Number(parts[2]), sh: Number(parts[3]), jpeg: Buffer.from(parts[4], 'base64') };
  }
  move(x, y) { return this.send(`MOVE ${Math.round(x * (this.sw - 1))} ${Math.round(y * (this.sh - 1))}`); }
  button(button, action) { return this.send(`BTN ${button} ${action}`); }
  wheel(dx, dy) { return this.send(`WHEEL ${dx} ${dy}`); }
  key(name, action) { const vk = vkOf(name); return vk === null ? Promise.resolve() : this.send(`KEY ${vk} ${action}`); }
  text(value) { return this.send('TEXT ' + Buffer.from(value, 'utf8').toString('base64')); }
  async stop() { try { this.child?.kill(); } catch { /* 已退出 */ } try { if (this.file) await rm(this.file, { force: true }); } catch { /* 忽略 */ } }
}

// ---------- macOS：screencapture + sips 截屏；cliclick + osascript 输入 ----------
const run = (cmd, argv, opts = {}) => new Promise((resolve, reject) => execFile(cmd, argv, { timeout: 20000, maxBuffer: 64 * 1048576, ...opts }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(stdout)));
const MAC_KEYCODES = { enter: 36, escape: 53, tab: 48, backspace: 51, delete: 117, space: 49, left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 };
class MacBackend {
  name = 'macos';
  async start() {
    this.file = path.join(tmpdir(), 'yumeiro-agent-' + process.pid + '.jpg');
    try { await run('screencapture', ['-x', '-t', 'jpg', this.file]); } catch (e) { throw new Error('无法截屏：请在“系统设置 → 隐私与安全性 → 屏幕录制”里允许“终端”（或你运行本程序的应用），然后重新运行。' + (e.stderr ? ' ' + String(e.stderr).slice(0, 120) : '')); }
    try { const out = await run('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop']); const b = out.trim().split(/,\s*/).map(Number); this.pw = b[2] - b[0]; this.ph = b[3] - b[1]; } catch { this.pw = 0; this.ph = 0; }
    try { this.cliclick = (await run('which', ['cliclick'])).trim(); } catch { this.cliclick = ''; }
    this.canControl = Boolean(this.cliclick && this.pw);
    if (!this.canControl) log('提示：没有找到 cliclick，只能查看，不能控制。安装：brew install cliclick，并在“隐私与安全性 → 辅助功能”里允许终端。');
  }
  async capture(maxWidth, quality) {
    await run('screencapture', ['-x', '-t', 'jpg', '-C', this.file]);
    const dims = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', this.file]);
    const sw = Number(/pixelWidth: (\d+)/.exec(dims)?.[1]), sh = Number(/pixelHeight: (\d+)/.exec(dims)?.[1]);
    if (sw > maxWidth) await run('sips', ['-Z', String(maxWidth), '--setProperty', 'formatOptions', String(quality), this.file]);
    const jpeg = await readFile(this.file), w = Math.min(sw, maxWidth), h = Math.round(sh * w / sw);
    return { w, h, sw, sh, jpeg };
  }
  async cc(...commands) { await run(this.cliclick, commands); }
  pos(x, y) { return `${Math.round(x * (this.pw - 1))},${Math.round(y * (this.ph - 1))}`; }
  move(x, y) { this.last = this.pos(x, y); return this.cc('m:' + this.last); }
  async button(button, action) {
    const here = this.last || '0,0';
    if (button === 'left') return this.cc((action === 'down' ? 'dd:' : 'du:') + here);
    if (action === 'down') return this.cc((button === 'right' ? 'rc:' : 'c:') + here); // 右键 / 中键只支持“点一下”
  }
  async wheel(dx, dy) { const code = dy > 0 ? 125 : 126; for (let i = 0; i < Math.min(5, Math.abs(dy) * 2); i++) await run('osascript', ['-e', `tell application "System Events" to key code ${code}`]); }
  async key(name, action, mods = []) {
    if (action === 'up') return;
    const using = mods.length ? ' using {' + mods.map(m => ({ ctrl: 'control', alt: 'option', shift: 'shift', meta: 'command' })[m] + ' down').join(', ') + '}' : '';
    const code = MAC_KEYCODES[name];
    const script = code !== undefined ? `tell application "System Events" to key code ${code}${using}` : `tell application "System Events" to keystroke "${String(name).replace(/[\\"]/g, '\\$&')}"${using}`;
    await run('osascript', ['-e', script]);
  }
  async text(value) { await run('osascript', ['-e', `tell application "System Events" to keystroke "${value.replace(/[\\"]/g, '\\$&')}"`]); }
  async stop() { try { await rm(this.file, { force: true }); } catch { /* 忽略 */ } }
}

// ---------- 测试用假后端（不碰真实桌面）----------
const FAKE_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
class FakeBackend {
  name = 'fake'; canControl = true; sw = 1920; sh = 1080;
  async start() {}
  async capture() { return { w: 640, h: 360, sw: 1920, sh: 1080, jpeg: FAKE_JPEG }; }
  note(op, ...rest) { console.log('FAKE ' + JSON.stringify([op, ...rest])); }
  async move(x, y) { this.note('move', x, y); } async button(b, a) { this.note('button', b, a); } async wheel(dx, dy) { this.note('wheel', dx, dy); }
  async key(k, a, m) { this.note('key', k, a, m); } async text(t) { this.note('text', t.length); } async stop() {}
}
function makeBackend(kind) {
  if (kind === 'fake') return new FakeBackend();
  const os = platform();
  if (os === 'win32') return new WindowsBackend();
  if (os === 'darwin') return new MacBackend();
  throw new Error('暂不支持这个系统（' + os + '）。目前支持 Windows 和 macOS。');
}

// ---------- 把网页发来的操作变成本机动作 ----------
const MOD_KEYS = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'meta' };
async function perform(backend, event) {
  switch (event.type) {
    case 'move': return backend.move(event.x, event.y);
    case 'click': {
      await backend.move(event.x, event.y);
      for (let i = 0; i < (event.count === 2 ? 2 : 1); i++) { await backend.button(event.button, 'down'); if (backend.name !== 'macos' || event.button === 'left') await backend.button(event.button, 'up'); }
      return;
    }
    case 'down': case 'up': if (event.x !== undefined) await backend.move(event.x, event.y); return backend.button(event.button, event.type);
    case 'wheel': return backend.wheel(event.dx || 0, event.dy || 0);
    case 'key': {
      if (backend.name === 'windows' || backend.name === 'fake') {
        const mods = event.mods || [];
        if (event.action === 'press') { for (const m of mods) await backend.key(MOD_KEYS[m], 'down'); await backend.key(event.key, 'down'); await backend.key(event.key, 'up'); for (const m of [...mods].reverse()) await backend.key(MOD_KEYS[m], 'up'); }
        else await backend.key(event.key, event.action);
        return;
      }
      return backend.key(event.key, event.action, event.mods || []);
    }
    case 'text': { const parts = event.text.split('\n'); for (let i = 0; i < parts.length; i++) { if (parts[i]) await backend.text(parts[i]); if (i < parts.length - 1) { await backend.key('enter', 'down', []); await backend.key('enter', 'up', []); } } return; }
  }
}

// ---------- 开机自启 ----------
async function autostart(install) {
  const node = process.execPath, os = platform(), dry = Boolean(args['dry-run']);
  if (os === 'win32') {
    const argv = install ? ['/Create', '/F', '/SC', 'ONLOGON', '/TN', 'Yumeiro Agent', '/TR', `"${node}" "${here}"`, '/RL', 'LIMITED'] : ['/Delete', '/F', '/TN', 'Yumeiro Agent'];
    console.log('schtasks ' + argv.join(' ')); if (!dry) console.log((await run('schtasks', argv)).trim());
    console.log(install ? '已设置：登录 Windows 后自动运行（会打开一个命令行窗口，请不要关闭；最小化即可）。' : '已取消开机自启。');
  } else if (os === 'darwin') {
    const plist = path.join(homedir(), 'Library', 'LaunchAgents', 'com.yumeiro.agent.plist');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.yumeiro.agent</string><key>ProgramArguments</key><array><string>${node}</string><string>${here}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n`;
    if (install) { console.log('写入 ' + plist); if (!dry) { mkdirSync(path.dirname(plist), { recursive: true }); writeFileSync(plist, xml); await run('launchctl', ['load', '-w', plist]); } console.log('已设置：登录后自动运行。'); }
    else { console.log('launchctl unload ' + plist); if (!dry && existsSync(plist)) { await run('launchctl', ['unload', '-w', plist]).catch(() => {}); unlinkSync(plist); } console.log('已取消开机自启。'); }
  } else console.log('这个系统暂不支持自动设置开机自启。');
}

// ---------- 主程序 ----------
async function api(config, pathname, init = {}) {
  const response = await fetch(config.server + pathname, { ...init, headers: { Authorization: 'Bearer ' + config.token, ...(init.headers || {}) }, signal: init.signal || AbortSignal.timeout(40000) });
  if (response.status === 401) { const error = new Error('这台电脑已被取消配对（或令牌失效）。如需继续使用，请在网页上重新生成配对码。'); error.fatal = true; throw error; }
  return response;
}
async function main() {
  if (args.help || args.h) { console.log(readFileSync(here, 'utf8').split('\n').slice(1, 12).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  if (args['install-autostart'] || args['uninstall-autostart']) return autostart(Boolean(args['install-autostart']));
  if (args['self-test']) {
    const backend = makeBackend(args.backend); await backend.start();
    const frame = await backend.capture(1280, 55); await backend.stop();
    const ok = frame.jpeg[0] === 0xff && frame.jpeg[1] === 0xd8;
    console.log(`自检${ok ? '通过' : '失败'}：${backend.name} 屏幕 ${frame.sw}x${frame.sh}，截图 ${frame.w}x${frame.h}，${frame.jpeg.length} 字节；控制能力：${backend.canControl ? '可用' : '不可用'}`);
    process.exit(ok ? 0 : 1);
  }
  let config = loadConfig();
  if (args.forget) { try { unlinkSync(configFile); } catch { /* 本来就没有 */ } console.log('已清除本机保存的配对信息。请到网页里删除这台设备。'); return; }
  const wantControl = args['allow-control'] ? true : args['view-only'] ? false : undefined;
  if (args.code) {
    const server = String(args.server || config.server || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(server)) { console.error('请用 --server 指定站点地址，例如 --server https://example.com'); process.exit(1); }
    const name = String(args.name || hostname()).slice(0, 40);
    const response = await fetch(server + '/remote/agent/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: args.code, name, hostname: hostname(), os: platform(), caps: { control: wantControl === true } }), signal: AbortSignal.timeout(20000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { console.error('配对失败：' + (data.error || 'HTTP ' + response.status)); process.exit(1); }
    config = { server, token: data.token, deviceId: data.deviceId, name: data.name, control: wantControl === true };
    saveConfig(config); log(`配对成功：${data.name}（${data.allowControl ? '网页端允许控制' : '网页端设置为仅查看'}）`);
  }
  if (!config.token) { console.error('还没有配对。请先在网页（/remote）生成配对码，然后运行：node agent.mjs --server 站点地址 --code 配对码'); process.exit(1); }
  if (wantControl !== undefined && wantControl !== config.control) { config.control = wantControl; saveConfig(config); }

  const backend = makeBackend(args.backend);
  log('正在启动（' + backend.name + '）…'); await backend.start();
  const control = Boolean(config.control && backend.canControl);
  log(`已连接到 ${config.server} · 本机${control ? '允许被控制' : '只允许被查看'} · 按 Ctrl+C 退出`);
  let want = { watching: false, fps: 3, quality: 55, maxWidth: 1280 }, running = true, queue = Promise.resolve(), lastHash = '', lastSent = 0;
  const fpsCap = Math.max(1, Math.min(15, Number(args.fps) || 10)); // 实际帧率由服务器按网络情况自动调整，这里只是上限
  let lastUpMs = 0;
  const stop = async () => { running = false; await backend.stop(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);

  const captureLoop = async () => {
    while (running) {
      if (!want.watching) { await sleep(250); continue; }
      const started = Date.now();
      try {
        const frame = await backend.capture(want.maxWidth, want.quality), hash = createHash('md5').update(frame.jpeg).digest('hex');
        if (hash !== lastHash || Date.now() - lastSent > 4000) {
          lastHash = hash; lastSent = Date.now();
          const response = await api(config, '/remote/agent/frame', { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Width': String(frame.w), 'X-Height': String(frame.h), 'X-Screen-Width': String(frame.sw), 'X-Screen-Height': String(frame.sh), 'X-Up-Ms': String(lastUpMs) }, body: frame.jpeg });
          lastUpMs = Date.now() - lastSent;
          const result = await response.json().catch(() => ({})); if (result.watching === false) want.watching = false;
        }
      } catch (error) { if (error.fatal) { console.error(error.message); await stop(); } log('截图/上传出错：' + error.message); await sleep(1500); }
      await sleep(Math.max(30, 1000 / Math.min(fpsCap, want.fps || 3) - (Date.now() - started)));
    }
  };
  captureLoop();

  let failures = 0;
  while (running) {
    try {
      const response = await api(config, `/remote/agent/poll?wait=25&control=${control ? 1 : 0}`, { signal: AbortSignal.timeout(40000) });
      if (!response.ok) throw new Error('服务器返回 HTTP ' + response.status);
      const data = await response.json(); failures = 0;
      want = { watching: Boolean(data.watching), fps: data.fps || 3, quality: data.quality || 55, maxWidth: data.maxWidth || 1280 };
      if (control && data.allowControl && Array.isArray(data.commands)) {
        for (const event of data.commands) queue = queue.then(() => perform(backend, event)).catch(error => log('操作失败：' + error.message));
      }
    } catch (error) {
      if (error.fatal) { console.error(error.message); await stop(); }
      failures++; if (failures === 1 || failures % 10 === 0) log('连接服务器失败，稍后重试：' + (error.cause?.code || error.message));
      await sleep(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)));
    }
  }
}
main().catch(error => { console.error('出错了：' + error.message); process.exit(1); });
