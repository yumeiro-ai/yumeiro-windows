// 把发布包打成 Windows 服务器版的 exe 安装程序（NSIS）。
// 用法：node scripts/make-windows-installer.mjs [--zip <发布包.zip>] [--out <输出目录>] [--makensis <makensis.exe>] [--user-level]
//   默认用 ../Yumeiro-<版本>.zip（先运行 node scripts/make-release.mjs 生成）；带 -with-clients 的包会生成 ...-with-clients.exe。
//   makensis 的查找顺序：--makensis → 环境变量 MAKENSIS → PATH → 本机 electron-builder 缓存（客户端打包时下载的 NSIS）→ C:\Program Files (x86)\NSIS。
//   --user-level 只用于自动化测试：编译成不要求管理员的安装程序（真正发布不要加）。
// 安装程序本身不含任何逻辑上的“另一套安装”：它把发布包解开，调用包里的 deploy\yumeiro-windows.ps1，所以和命令行安装完全一致。
import { readFile, writeFile, readdir, mkdir, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from '../ziputil.mjs';
import { templates } from '../providers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
const exists = p => access(p).then(() => true, () => false);

export async function findMakensis(explicit = '') {
  const list = [];
  if (explicit) list.push(explicit);
  if (process.env.MAKENSIS) list.push(process.env.MAKENSIS);
  const probe = spawnSync('makensis', ['/VERSION'], { encoding: 'utf8' });
  if (!probe.error && probe.status === 0) return 'makensis';
  const cache = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache', 'nsis');
  try { for (const dir of (await readdir(cache)).filter(n => /^nsis-\d/.test(n)).sort().reverse()) list.push(path.join(cache, dir, 'Bin', 'makensis.exe')); } catch { /* 没有缓存 */ }
  list.push('C:\\Program Files (x86)\\NSIS\\makensis.exe', 'C:\\Program Files\\NSIS\\makensis.exe');
  for (const p of list) if (await exists(p)) return p;
  return '';
}

const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const zipPath = path.resolve(opt('--zip') || path.join(root, '..', `Yumeiro-${version}.zip`));
const outDir = path.resolve(opt('--out') || path.join(root, '..'));
if (!await exists(zipPath)) { console.error('找不到发布包：' + zipPath + '\n先运行：node scripts/make-release.mjs'); process.exit(1); }
const makensis = await findMakensis(opt('--makensis'));
if (!makensis) { console.error('找不到 makensis。安装 NSIS（https://nsis.sourceforge.io），或用 --makensis / MAKENSIS 指定路径。'); process.exit(1); }

// 解开发布包到临时目录（顶层目录 Yumeiro/ 去掉，里面的内容直接作为安装程序的载荷）
const stageRoot = await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'ymsetup-'));
const stage = path.join(stageRoot, 'Yumeiro');
try {
  const { entries } = readZip(await readFile(zipPath), { maxFiles: 20000, maxEntryBytes: 600 * 1048576, maxTotalBytes: 2 * 1024 * 1048576 });
  let count = 0;
  for (const entry of entries) {
    if (!entry.name || entry.name.endsWith('/')) continue;
    const rel = entry.name.replace(/^Yumeiro\//, '');
    const target = path.join(stage, ...rel.split('/'));
    if (path.relative(stage, target).startsWith('..')) throw new Error('压缩包里有不安全的路径：' + entry.name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.data);
    count++;
  }
  for (const must of ['deploy/yumeiro-windows.ps1', 'deploy/windows/run-service.mjs', 'deploy/windows/updater.mjs', 'server.mjs', 'package.json']) if (!await exists(path.join(stage, ...must.split('/')))) throw new Error('发布包里缺少 ' + must + '：这个包不是 Windows 服务器版支持的版本');
  const withClients = /with-clients/.test(path.basename(zipPath));
  const hasClients = await exists(path.join(stage, 'Yumeiro-Clients'));
  // 模型服务商预设：直接取服务端自己的模板（和 Linux 安装向导里的下拉一致），生成 NSIS 包含文件
  const esc = s => String(s).replace(/\$/g, '$$$$').replace(/"/g, '$\\"');
  const presets = ['﻿; 由 make-windows-installer.mjs 生成，不要手改',
    '!macro ADD_PRESETS CTRL', '  ${NSD_CB_AddString} ${CTRL} "不预设（以后在管理设置里添加）"',
    ...templates.map(t => `  \${NSD_CB_AddString} \${CTRL} "${esc(t.name)}"`), '!macroend',
    'Function ApplyPreset', '  ${Switch} $R0',
    ...templates.flatMap((t, i) => [`    \${Case} ${i + 1}`, `      StrCpy $ModelUrl "${esc(t.baseUrl)}"`, '      ${Break}']),
    '  ${EndSwitch}', 'FunctionEnd', ''].join('\r\n');
  const presetsFile = path.join(stageRoot, 'presets.nsh');
  await writeFile(presetsFile, presets);
  const outFile = path.join(outDir, `Yumeiro-Server-Setup-${version}${withClients ? '-with-clients' : ''}.exe`);
  if (!await exists(outDir)) await mkdir(outDir, { recursive: true });   // 输出目录是盘符根目录（E:\）时 mkdir 会报 EPERM，已存在就不用建
  console.log(`载荷 ${count} 个文件，${templates.length} 个模型服务商预设${hasClients ? '，含客户端安装包' : ''}，正在用 NSIS 编译 → ${outFile}`);
  const r = spawnSync(makensis, ['-V2', `-DVERSION=${version}`, `-DSTAGE=${stage}`, `-DPRESETS=${presetsFile}`, ...(hasClients ? ['-DHAS_CLIENTS=1'] : []), `-DOUTFILE=${outFile}`, `-DLEVEL=${args.includes('--user-level') ? 'user' : 'admin'}`, path.join(root, 'deploy', 'windows', 'installer.nsi')], { stdio: 'inherit' });
  if (r.error || r.status !== 0) { console.error('NSIS 编译失败'); process.exit(r.status || 1); }
  const sha = createHash('sha256').update(await readFile(outFile)).digest('hex');
  console.log(`完成：${outFile}\nSHA256 ${sha}`);
} finally { await rm(stageRoot, { recursive: true, force: true }).catch(() => {}); }
