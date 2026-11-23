// 把桌宠精灵图去掉白底、对齐并切成透明 PNG，输出到 public/pet/：
//   brand/pet-sheet-original.png      2x2：idle 待机 / blink 眨眼 / happy 开心 / sleepy 犯困
//   brand/pet-walk-sheet-original.png 3x2：walk1~walk4 侧身行走 / peek 贴边探头 / sit 坐着
// 需要本机有 Chrome / Edge。运行：node scripts/build-pet.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'pet');
const browser = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const sheets = [
  { file: path.join(root, 'brand', 'pet-sheet-original.png'), cols: 2, rows: 2, names: ['idle', 'blink', 'happy', 'sleepy'], groups: [[0, 1, 2, 3]] },
  { file: path.join(root, 'brand', 'pet-walk-sheet-original.png'), cols: 3, rows: 2, names: ['walk1', 'walk2', 'walk3', 'walk4', 'peek', 'sit'], groups: [[0, 1, 2, 3], [4], [5]], wall: [4] },
  { file: path.join(root, 'brand', 'pet-emotion-sheet1-original.png'), cols: 2, rows: 2, names: ['angry1', 'angry2', 'sad1', 'sad2'], groups: [[0, 1, 2, 3]] },
  { file: path.join(root, 'brand', 'pet-emotion-sheet2-original.png'), cols: 2, rows: 2, names: ['laugh1', 'laugh2', 'surprised', 'shy'], groups: [[0, 1, 2, 3]] }
];
if (!browser || sheets.some(s => !existsSync(s.file))) { console.error('缺少 Chrome / Edge 或原图'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = 9600 + Math.floor(Math.random() * 300), profile = path.join(tmpdir(), 'ym-pet-' + process.pid);
const chrome = spawn(browser, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
// 在浏览器里做图像处理：背景（连通的近白色）→ 透明，吃掉白色描边，边缘半透明去白边；同组帧用同一个裁切框
const pageFn = `async (dataUrl, cols, rows, groups, wall) => {
  const img = new Image(); img.src = dataUrl; await img.decode();
  const cw = img.naturalWidth / cols, ch = img.naturalHeight / rows, cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const w = Math.round(cw), h = Math.round(ch), canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const g = canvas.getContext('2d', { willReadFrequently: true }); g.drawImage(img, c * cw, r * ch, w, h, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h), px = d.data, bg = new Uint8Array(w * h), stack = [];
    const near = i => Math.min(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) >= 236;
    for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const i = y * w + x; if (near(i) && !bg[i]) { bg[i] = 1; stack.push(i); } }
    for (let y = 0; y < h; y++) for (const x of [0, w - 1]) { const i = y * w + x; if (near(i) && !bg[i]) { bg[i] = 1; stack.push(i); } }
    while (stack.length) { const i = stack.pop(), x = i % w, y = (i / w) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const j = ny * w + nx; if (!bg[j] && near(j)) { bg[j] = 1; stack.push(j); } } }
    for (let round = 0; round < 5; round++) { const add = []; for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (bg[i]) continue; if (!(bg[i - 1] || bg[i + 1] || bg[i - w] || bg[i + w])) continue; if (Math.min(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) >= 214) add.push(i); } for (const i of add) bg[i] = 1; }
    // 头发缝隙里被头发包住的白底（包括呆毛圈里面的）：近白色连通块，若它的边界几乎全是饱和的粉 / 紫 / 青色（头发），就当成背景
    {
      const light = i => { const r = px[i * 4], g2 = px[i * 4 + 1], bl = px[i * 4 + 2], mn = Math.min(r, g2, bl); return mn >= 205 && Math.max(r, g2, bl) - mn < 28; };
      let top = h, bottom = 0; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!bg[y * w + x]) { if (y < top) top = y; if (y > bottom) bottom = y; }
      const seen = new Uint8Array(w * h);
      for (let start = 0; start < w * h; start++) {
        if (seen[start] || bg[start] || !light(start)) continue;
        const comp = [start], queue = [start]; seen[start] = 1; let touching = 0, hairy = 0;
        while (queue.length) {
          const i = queue.pop(), x = i % w, y = (i / w) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const j = ny * w + nx;
            if (light(j) && !bg[j]) { if (!seen[j]) { seen[j] = 1; comp.push(j); queue.push(j); } }
            else if (!bg[j]) { touching++; const r = px[j * 4], g2 = px[j * 4 + 1], bl = px[j * 4 + 2], mx = Math.max(r, g2, bl), mn = Math.min(r, g2, bl); if (mx - mn > 38 && mx > 150) hairy++; }
          }
        }
        let minY = h; for (const i of comp) { const yy = (i / w) | 0; if (yy < minY) minY = yy; }
        const nearTop = minY < top + (bottom - top) * 0.16;
        if (comp.length > 120 && comp.length < 12000 && touching > 20 && (hairy / touching > 0.62 || (nearTop && comp.length > 500))) for (const i of comp) bg[i] = 1;
      }
    }
    const dist = new Uint8Array(w * h).fill(9); for (let i = 0; i < w * h; i++) if (bg[i]) dist[i] = 0;
    for (let pass = 1; pass <= 2; pass++) for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (dist[i] === 9 && (dist[i - 1] === pass - 1 || dist[i + 1] === pass - 1 || dist[i - w] === pass - 1 || dist[i + w] === pass - 1)) dist[i] = pass; }
    for (let i = 0; i < w * h; i++) {
      if (bg[i]) { px[i * 4 + 3] = 0; continue; }
      if (dist[i] <= 2) { const m = Math.min(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]); if (m > 190) { const a = Math.max(0.12, 1 - (m - 190) / 66); px[i * 4 + 3] = Math.round(a * 255); for (let k = 0; k < 3; k++) px[i * 4 + k] = Math.max(0, Math.min(255, Math.round((px[i * 4 + k] - 255 * (1 - a)) / a))); } }
    }
    const index = cells.length;
    // 探头那一格带一条竖直的“墙线”：找到它并把它和它右边的内容都切掉，人物右边缘正好贴着墙
    let cutX = w;
    if (wall.includes(index)) {
      let best = 0, bestX = -1;
      for (let x = Math.floor(w * 0.45); x < w - 2; x++) { let run = 0, maxRun = 0; for (let y = 0; y < h; y++) { const i = y * w + x; if (px[i * 4 + 3] > 200 && Math.max(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) < 90) { run++; if (run > maxRun) maxRun = run; } else run = 0; } if (maxRun > best) { best = maxRun; bestX = x; } }
      if (best > h * 0.4) { cutX = bestX - 1; for (let y = 0; y < h; y++) for (let x = cutX; x < w; x++) px[(y * w + x) * 4 + 3] = 0; }
    }
    g.putImageData(d, 0, 0);
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < cutX; x++) if (px[(y * w + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    cells.push({ canvas, box: [x0, y0, x1, y1], cutX });
  }
  const out = new Array(cells.length), sizes = {};
  for (const group of groups) {
    const X0 = Math.min(...group.map(i => cells[i].box[0])) - 4, Y0 = Math.min(...group.map(i => cells[i].box[1])) - 4;
    let X1 = Math.max(...group.map(i => cells[i].box[2])) + 4, Y1 = Math.max(...group.map(i => cells[i].box[3])) + 4;
    for (const i of group) { const w2 = (wall.includes(i) ? Math.min(X1, cells[i].cutX) : X1) - X0, o = document.createElement('canvas'); o.width = Math.max(1, w2); o.height = Y1 - Y0; o.getContext('2d').drawImage(cells[i].canvas, X0, Y0, o.width, o.height, 0, 0, o.width, o.height); out[i] = { url: o.toDataURL('image/png'), w: o.width, h: o.height }; }
  }
  return JSON.stringify(out);
}`;
try {
  let targets; for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some(t => t.type === 'page')) break; } catch { /* 等待 */ } await sleep(300); }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
  let seq = 0; const pending = new Map(); ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  mkdirSync(outDir, { recursive: true }); const meta = {};
  for (const sheet of sheets) {
    const dataUrl = 'data:image/png;base64,' + readFileSync(sheet.file).toString('base64');
    const result = await send('Runtime.evaluate', { expression: `(${pageFn})(${JSON.stringify(dataUrl)}, ${sheet.cols}, ${sheet.rows}, ${JSON.stringify(sheet.groups)}, ${JSON.stringify(sheet.wall || [])})`, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 400));
    const frames = JSON.parse(result.result.result.value);
    sheet.names.forEach((name, i) => { writeFileSync(path.join(outDir, name + '.png'), Buffer.from(frames[i].url.split(',')[1], 'base64')); meta[name] = { width: frames[i].w, height: frames[i].h }; });
  }
  writeFileSync(path.join(outDir, 'size.json'), JSON.stringify(meta));
  console.log('桌宠素材已生成：', Object.entries(meta).map(([k, v]) => `${k} ${v.width}x${v.height}`).join('，'));
  ws.close();
} finally { chrome.kill(); await sleep(300); try { rmSync(profile, { recursive: true, force: true }); } catch { /* 浏览器还没完全退出 */ } }
