// 由吉祥物原图（brand/mascot-original.png）生成站点、PWA、Windows、安卓用到的全部尺寸的图片。
// 需要本机装有 Chrome / Edge（用无头浏览器裁剪缩放，不依赖任何 npm 包）。运行：node scripts/build-icons.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'brand', 'mascot-original.png');
const browser = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
if (!browser) { console.error('没有找到 Chrome / Edge，请设置环境变量 CHROME 指向浏览器程序'); process.exit(1); }
if (!existsSync(source)) { console.error('缺少原图：' + source); process.exit(1); }
const FACE = [210, 215, 620]; // 头像裁切区域：x, y, 边长（原图 1024x1024）
const work = path.join(tmpdir(), 'ym-icons-' + process.pid); mkdirSync(work, { recursive: true });

function render(outFile, size, { round = false, crop = FACE } = {}) {
  const [cx, cy, cs] = crop, k = size / cs, html = path.join(work, 'r.html');
  writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}div{width:${size}px;height:${size}px;overflow:hidden;${round ? 'border-radius:50%;' : ''}}img{display:block;width:${1024 * k}px;height:${1024 * k}px;margin:${-cy * k}px 0 0 ${-cx * k}px}</style><div><img src="${pathToFileURL(source).href}"></div>`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  const r = spawnSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', '--force-device-scale-factor=1', `--window-size=${size},${size}`, `--screenshot=${outFile}`, pathToFileURL(html).href], { stdio: 'ignore' });
  if (r.status !== 0 || !existsSync(outFile)) throw new Error('渲染失败：' + outFile);
}
const pub = f => path.join(root, 'public', f);
render(pub('icon-192.png'), 192); render(pub('icon-512.png'), 512);
render(pub('mascot.png'), 640, { crop: [0, 0, 1024] });
const tmp256 = path.join(work, 'icon-256.png'); render(tmp256, 256);
const png = readFileSync(tmp256);
writeFileSync(pub('icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="512" height="512"><image href="data:image/png;base64,${png.toString('base64')}" width="256" height="256"/></svg>\n`);
// Windows：png + ico（ICO 里直接放 256x256 的 PNG）
const win = path.join(root, 'clients', 'windows', 'build'); mkdirSync(win, { recursive: true }); copyFileSync(tmp256, path.join(win, 'icon.png'));
const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16); entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12);
writeFileSync(path.join(win, 'icon.ico'), Buffer.concat([head, entry, png]));
// 安卓：各密度的方形和圆形图标 + 入口页用的立绘
for (const [dir, size] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
  const base = path.join(root, 'clients', 'android', 'assets', 'mipmap-' + dir);
  render(path.join(base, 'ic_launcher.png'), size); render(path.join(base, 'ic_launcher_round.png'), size, { round: true });
}
mkdirSync(path.join(root, 'clients', 'android', 'www'), { recursive: true }); copyFileSync(pub('mascot.png'), path.join(root, 'clients', 'android', 'www', 'mascot.png'));
rmSync(work, { recursive: true, force: true });
console.log('图标已生成');
