#!/usr/bin/env node
// 清理旧版本的发布文件：只保留每一类最新的 N 个版本（默认 1 个），其余的删掉。默认只预览，加 --yes 才真的删。
//   node scripts/clean-old-releases.mjs                 预览：列出会删哪些、保留哪些
//   node scripts/clean-old-releases.mjs --yes           真的删除
//   node scripts/clean-old-releases.mjs --yes --keep 2  每类保留最新 2 个版本
//   node scripts/clean-old-releases.mjs --yes --kill    文件被占用（比如旧版客户端还开着）时，结束“从待删文件夹里启动的”进程再删（仅 Windows）
//   选项：--out <目录>  发布包所在目录（默认和 make-release 一样：项目的上一级目录）；--no-dist  不清理 clients/windows/dist 里的旧安装包
// 只会动这几种名字（版本号必须是 x.y.z），别的文件一律不碰：
//   Yumeiro-x.y.z.zip、Yumeiro-x.y.z-with-clients.zip、Yumeiro-x.y.z-SHA256.txt        服务器发布包与校验文件
//   Yumeiro-Clients-x.y.z/                                                              客户端安装包文件夹
//   clients/windows/dist/ 里的 Yumeiro-Setup-x.y.z.exe、Yumeiro-Portable-x.y.z.exe、Yumeiro-Setup-x.y.z.exe.blockmap
import { readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VER = '([0-9]+[.][0-9]+[.][0-9]+)';
const PATTERNS = [
  { family: '服务器发布包', dir: false, re: new RegExp('^Yumeiro-' + VER + '(?:-with-clients[.]zip|[.]zip|-SHA256[.]txt)$') },
  { family: '客户端安装包文件夹', dir: true, re: new RegExp('^Yumeiro-Clients-' + VER + '$') },
  { family: '构建产物（dist）', dir: false, scope: 'dist', re: new RegExp('^Yumeiro-(?:Setup|Portable)-' + VER + '[.]exe(?:[.]blockmap)?$') }
];

export const compareVersions = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

// 把一个目录里的条目归类：返回 [{ family, version, name, full, dir }]
export function scan(directory, scope = 'out') {
  if (!existsSync(directory)) return [];
  const found = [];
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    let isDir = false; try { isDir = statSync(full).isDirectory(); } catch { continue; }
    for (const pattern of PATTERNS) {
      if ((pattern.scope || 'out') !== scope || pattern.dir !== isDir) continue;
      const match = pattern.re.exec(name);
      if (match) { found.push({ family: pattern.family, version: match[1], name, full, dir: isDir }); break; }
    }
  }
  return found;
}

// 每一类保留最新 keep 个版本，其余的进入 remove
export function plan(entries, keep = 1) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep 至少是 1（不能把所有版本都删掉）');
  const keepList = [], remove = [];
  for (const family of [...new Set(entries.map(entry => entry.family))]) {
    const items = entries.filter(entry => entry.family === family);
    const versions = [...new Set(items.map(entry => entry.version))].sort(compareVersions).reverse();
    const kept = new Set(versions.slice(0, keep));
    for (const item of items) (kept.has(item.version) ? keepList : remove).push(item);
  }
  return { keep: keepList, remove };
}

// Windows：找出“可执行文件就在这个文件夹里”的进程（它们占着文件，删不掉）
export function processesUnder(directory, run = execFileSync) {
  if (process.platform !== 'win32') return [];
  try {
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:YM_DIR, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { \"$($_.ProcessId)|$($_.Name)|$($_.ExecutablePath)\" }";
    const output = run('powershell', ['-NoProfile', '-Command', script], { env: { ...process.env, YM_DIR: directory.endsWith(path.sep) ? directory : directory + path.sep }, encoding: 'utf8', timeout: 20000 });
    return String(output).split(/\r?\n/).filter(Boolean).map(line => { const [pid, name, exe] = line.split('|'); return { pid: Number(pid), name, exe }; }).filter(item => item.pid > 0);
  } catch { return []; }
}

const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
export function removeEntry(entry, { kill = false, remover = rmSync, finder = processesUnder, killer = pid => execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } = {}) {
  const attempt = () => remover(entry.full, { recursive: entry.dir, force: true, maxRetries: 2, retryDelay: 300 });
  try { attempt(); return { ok: true }; }
  catch (error) {
    if (!BUSY.has(error.code)) return { ok: false, error: error.message };
    const holders = finder(entry.dir ? entry.full : path.dirname(entry.full)).filter(item => entry.dir || item.exe.toLowerCase() === entry.full.toLowerCase());
    if (!kill) return { ok: false, busy: true, holders, error: '文件被占用' };
    for (const holder of holders) { try { killer(holder.pid); } catch { /* 可能已经退出 */ } }
    try { attempt(); return { ok: true, killed: holders }; } catch (second) { return { ok: false, busy: true, holders, error: second.message }; }
  }
}

function main() {
  const args = process.argv.slice(2), flag = name => args.includes(name), opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = path.resolve(opt('--out') || path.join(root, '..')), distDir = path.join(root, 'clients', 'windows', 'dist');
  const keepCount = opt('--keep') ? Number(opt('--keep')) : 1, yes = flag('--yes'), kill = flag('--kill');
  const entries = [...scan(outDir, 'out'), ...(flag('--no-dist') ? [] : scan(distDir, 'dist'))];
  let result; try { result = plan(entries, keepCount); } catch (error) { console.error(error.message); process.exit(2); }
  const show = list => list.sort((a, b) => a.family.localeCompare(b.family) || compareVersions(a.version, b.version) || a.name.localeCompare(b.name));
  console.log('扫描目录：' + outDir + (flag('--no-dist') ? '' : '，' + distDir));
  console.log('\n保留（每类最新 ' + keepCount + ' 个版本）：'); for (const item of show(result.keep)) console.log('  ' + item.full + (item.dir ? '\\' : ''));
  console.log('\n' + (yes ? '删除' : '将会删除（预览，没有删任何东西）') + '：'); if (!result.remove.length) console.log('  （没有旧版本需要清理）');
  for (const item of show(result.remove)) console.log('  ' + item.full + (item.dir ? '\\' : ''));
  if (!yes) { if (result.remove.length) console.log('\n确认没问题后加 --yes 真的删除；文件被占用时可再加 --kill。'); return; }
  let failed = 0;
  for (const item of result.remove) {
    const r = removeEntry(item, { kill });
    if (r.ok) console.log('已删除 ' + item.name + (r.killed && r.killed.length ? '（先结束了占用它的进程：' + r.killed.map(p => p.name + ' #' + p.pid).join('、') + '）' : ''));
    else { failed++; console.log('没删掉 ' + item.name + '：' + (r.busy ? '被占用' + (r.holders && r.holders.length ? '（' + r.holders.map(p => p.name + ' #' + p.pid).join('、') + '）' : '') + '，先关掉对应程序，或加 --kill' : r.error)); }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
