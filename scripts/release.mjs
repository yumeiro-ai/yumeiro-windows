#!/usr/bin/env node
// 一条命令走完发版流程：测试 → （可选）构建客户端 → 整理客户端安装包文件夹 → 生成发布压缩包和校验文件 → 先预览再清理旧版本。
//   node scripts/release.mjs                    跑完整流程；最后“预览要清理的旧版本”，在终端里会问你输入 yes 才删
//   node scripts/release.mjs --yes              清理旧版本不再询问（预览会照常打印出来）
//   node scripts/release.mjs --build-client     先构建 Windows 客户端（clients/windows 里 npm run build）
//   node scripts/release.mjs --skip-tests       跳过测试（不建议）
//   node scripts/release.mjs --apk <文件>       指定要放进客户端文件夹的 APK
//   node scripts/release.mjs --build-android   构建 clients/android-native，并使用刚生成的 APK
//   node scripts/release.mjs --kill             清理时旧文件被占用（比如旧版客户端还开着），结束“从待删文件夹里启动的”进程再删
//   node scripts/release.mjs --keep 2           清理时每类保留最新 2 个版本（默认 1）
//   node scripts/release.mjs --no-clean         不清理旧版本
//   node scripts/release.mjs --dry-run          只打印每一步要做什么，不执行
//   --out <目录>  输出目录（默认和 make-release 一样：项目的上一级目录）
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const sha256File = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export const shaLine = file => sha256File(file) + ' *' + path.basename(file);

// 未指定 APK 时不复用历史发布物；需要 APK 请显式传 --apk，或传 --build-android 自动构建原生 Android 客户端。
export function findApk(outDir, explicit = '') {
  if (explicit) { if (!existsSync(explicit)) throw new Error('找不到指定的 APK：' + explicit); return path.resolve(explicit); }
  return '';
}

// 把客户端安装包整理到 <out>/Yumeiro-Clients-<版本>/：Setup + Portable + APK + SHA256.txt
export function assembleClients({ distDir, outDir, clientVersion, apk, apkTargetName = '' }) {
  const setup = path.join(distDir, `Yumeiro-Setup-${clientVersion}.exe`), portable = path.join(distDir, `Yumeiro-Portable-${clientVersion}.exe`);
  for (const file of [setup, portable]) if (!existsSync(file)) throw new Error(`找不到 ${file}。先构建客户端：node scripts/release.mjs --build-client`);
  const folder = path.join(outDir, `Yumeiro-Clients-${clientVersion}`); mkdirSync(folder, { recursive: true });
  const files = [portable, setup]; if (apk) files.push({ source: apk, name: apkTargetName || path.basename(apk) });
  const copied = files.map(file => { const source = typeof file === 'string' ? file : file.source, name = typeof file === 'string' ? path.basename(file) : file.name; const target = path.join(folder, name); copyFileSync(source, target); return target; });
  const lines = copied.map(shaLine);
  writeFileSync(path.join(folder, 'SHA256.txt'), lines.join('\n') + '\n');
  return { folder, lines };
}

function run(label, command, args, options = {}) {
  console.log('\n=== ' + label + ' ===');
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) { console.error('\n✗ ' + label + ' 失败（退出码 ' + result.status + '），流程已停止；旧版本文件没有动。'); process.exit(result.status || 1); }
}

async function main() {
  const args = process.argv.slice(2), flag = name => args.includes(name), opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
  if (flag('--apk') && flag('--build-android')) throw new Error('--apk 与 --build-android 不能同时使用');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = path.resolve(opt('--out') || path.join(root, '..')), distDir = path.join(root, 'clients', 'windows', 'dist');
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, clientVersion = JSON.parse(readFileSync(path.join(root, 'clients', 'windows', 'package.json'), 'utf8')).version;
  const dry = flag('--dry-run'), npm = process.platform === 'win32' ? 'npm.cmd' : 'npm', node = process.execPath;
  const steps = [];
  if (!flag('--skip-tests')) steps.push(['跑全部测试', () => run('跑全部测试', npm, ['test'], { cwd: root, shell: process.platform === 'win32' })]);
  if (flag('--build-client')) steps.push([`构建 Windows 客户端 ${clientVersion}`, () => run(`构建 Windows 客户端 ${clientVersion}`, npm, ['run', 'build'], { cwd: path.join(root, 'clients', 'windows'), shell: process.platform === 'win32' })]);
  let apk = '';
  if (flag('--build-android')) {
    const androidDir = path.join(root, 'clients', 'android-native');
    steps.push(['构建 Android Native APK', () => {
      const command = process.platform === 'win32' ? path.join(androidDir, 'build-apk.bat') : './gradlew';
      const args = process.platform === 'win32' ? [] : ['assembleDebug'];
      run('构建 Android Native APK', command, args, { cwd: androidDir, shell: process.platform === 'win32' });
      apk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
      if (!existsSync(apk)) throw new Error('Android Native 构建完成但找不到 APK：' + apk);
    }]);
  }
  let folder = '';
  steps.push([`整理客户端安装包文件夹 Yumeiro-Clients-${clientVersion}`, () => {
    console.log('\n=== 整理客户端安装包文件夹 ===');
    const explicitApk = opt('--apk');
    const selectedApk = apk || findApk(outDir, explicitApk);
    if (!selectedApk) console.log('APK：未指定（不会复用旧发布物；如需 APK，请使用 --apk <文件> 或 --build-android）');
    else console.log('APK：' + selectedApk);
    const made = assembleClients({ distDir, outDir, clientVersion, apk: selectedApk, apkTargetName: apk ? 'Yumeiro-android-debug.apk' : '' }); folder = made.folder;
    console.log(made.folder + '\n' + made.lines.join('\n'));
  }]);
  steps.push([`生成发布压缩包 ${version}`, () => run(`生成发布压缩包 ${version}`, node, [path.join(root, 'scripts', 'make-release.mjs'), '--clients', folder, '--out', outDir])]);
  steps.push(['写服务器校验文件', () => {
    const lines = [`Yumeiro-${version}.zip`, `Yumeiro-${version}-with-clients.zip`].map(name => shaLine(path.join(outDir, name)));
    writeFileSync(path.join(outDir, `Yumeiro-${version}-SHA256.txt`), lines.join('\n') + '\n');
    console.log('\n=== 校验值 ===\n' + lines.join('\n'));
  }]);
  if (!flag('--no-clean')) steps.push(['清理旧版本', async () => {
    const base = [path.join(root, 'scripts', 'clean-old-releases.mjs'), '--out', outDir, ...(opt('--keep') ? ['--keep', opt('--keep')] : [])];
    run('清理旧版本：先预览', node, base);                                   // 第一步永远只预览
    let go = flag('--yes');
    if (!go && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      go = (await rl.question('\n确认删除上面“将会删除”的文件？输入 yes 继续，其它任何输入都跳过：')).trim().toLowerCase() === 'yes'; rl.close();
    }
    if (go) run('清理旧版本：删除', node, [...base, '--yes', ...(flag('--kill') ? ['--kill'] : [])]);
    else console.log('\n没有删除。确认清单没问题后执行：node scripts/clean-old-releases.mjs --yes' + (opt('--keep') ? ' --keep ' + opt('--keep') : '') + '  （文件被占用时再加 --kill）');
  }]);
  console.log(`发版 ${version}（客户端 ${clientVersion}），输出目录 ${outDir}${dry ? '（dry-run：只列步骤，不执行）' : ''}`);
  steps.forEach(([label], i) => console.log(`  ${i + 1}. ${label}`));
  if (dry) return;
  for (const [, step] of steps) await step();
  console.log('\n✓ 发版流程完成');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error('✗ ' + error.message); process.exit(1); });
