// 生成发布压缩包：node scripts/make-release.mjs [--clients <装有 Yumeiro-Setup-*.exe / Yumeiro-*.apk 的文件夹>] [--out <输出目录>] [--clean]
//   加 --clean：生成完以后先预览要清理的旧版本，再加 --yes 才真删（每类只保留最新版本；文件被占用时会提示，不强行结束进程）。更省事的是直接用 scripts/release.mjs 走完整发版流程。也可以单独运行 scripts/clean-old-releases.mjs。
//   默认输出 ../Yumeiro-<版本>.zip（项目源码，解压后顶层目录是 Yumeiro/；.sh 带可执行权限）。
//   加 --clients 会再额外生成 ../Yumeiro-<版本>-with-clients.zip：同样的内容 + Yumeiro/Yumeiro-Clients/（安装包），
//   直装版 install / update 时会自动把这个文件夹里的安装包传进 downloads/（见《客户端安装包上传说明.md》）。
// 不会打进去：node_modules、data、secrets、.env、.git、日志、构建产物（dist）、客户端的 node_modules / 生成的 android 工程、临时文件、*.zip / *.cshare。
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { createZip } from '../ziputil.mjs';
import { signRelease } from '../updatepkg.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
const outDir = path.resolve(opt('--out') || path.join(root, '..')), clientsDir = opt('--clients');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;

// 注意：`data` 只跳过项目根目录的运行数据；安卓客户端的源码包 org/yumeiro/app/data（里面有 Api.kt）必须打进去。
const SKIP_DIRS = new Set(['node_modules', 'secrets', '.git', 'logs', 'dist', 'build-tmp', '.gradle', '.kotlin', '.cindy-worktrees', '.cloudbase-demo']);
const SKIP_PATHS = new Set(['data', 'clients/android/android', 'clients/android-native/app/build', 'brand/wallpapers']);                      // 运行数据；生成的 android 工程；原始壁纸（成品已在 public/seed/wallpapers）
const SKIP_FILES = /^(local\.properties|\.env|\.git|_.*\.mjs|.*\.zip|.*\.cshare|.*\.bak|.*\.log)$/;
const EXEC = /\.sh$/;

async function collect(dir, prefix = '') {
  const out = [];
  for (const name of (await readdir(dir)).sort()) {
    const rel = prefix ? prefix + '/' + name : name, full = path.join(dir, name), info = await stat(full);
    if (info.isDirectory()) { if (!SKIP_DIRS.has(name) && !SKIP_PATHS.has(rel)) out.push(...await collect(full, rel)); }
    else if (info.isFile() && (!SKIP_FILES.test(name) || name === '.env.example')) out.push({ name: 'Yumeiro/' + rel, data: await readFile(full), mtime: info.mtimeMs, mode: EXEC.test(name) ? 0o100755 : 0o100644 });
  }
  return out;
}
const entries = await collect(root);
// 官方签名：用私钥给文件清单签名，签名放进包里；服务器内置公钥，网页上传更新时自己核实。私钥不在仓库里（默认 ~/.yumeiro/release-signing.pem，也可用 --sign-key 或 YUMEIRO_SIGNING_KEY_FILE 指定）。
const keyFile = opt('--sign-key') || process.env.YUMEIRO_SIGNING_KEY_FILE || path.join(os.homedir(), '.yumeiro', 'release-signing.pem');
let signingKey = ''; try { signingKey = await readFile(keyFile, 'utf8'); } catch { /* 没有私钥：打出未签名的包 */ }
if (!signingKey) console.log('⚠ 没有找到签名私钥（' + keyFile + '），这次打出的包没有官方签名，不能在网页里更新（命令行更新不受影响）。');
const signed = list => signingKey ? [...list, ...signRelease(list, version, signingKey)] : list;
if (entries.some(e => /(^|\/)(\.env|secrets|node_modules)(\/|$)/.test(e.name.replace('.env.example', '')))) throw new Error('发布包里混进了不该有的文件');
const lean = path.join(outDir, `Yumeiro-${version}.zip`);
await writeFile(lean, createZip(signed(entries)));
const size = async file => ((await stat(file)).size / 1048576).toFixed(1) + ' MB';
console.log(`已生成 ${lean}（${entries.length} 个文件，${await size(lean)}）`);

if (clientsDir) {
  const packages = (await readdir(clientsDir)).filter(n => /^(Yumeiro-(?:Setup|Portable)-\d[0-9A-Za-z.-]*\.exe|Yumeiro-[A-Za-z0-9.-]+\.apk|SHA256\.txt)$/.test(n));
  if (!packages.length) throw new Error(`${clientsDir} 里没有安装包`);
  const extra = [];
  for (const n of packages) extra.push({ name: 'Yumeiro/Yumeiro-Clients/' + n, data: await readFile(path.join(clientsDir, n)), mode: 0o100644 });
  const full = path.join(outDir, `Yumeiro-${version}-with-clients.zip`);
  await writeFile(full, createZip(signed([...entries, ...extra])));
  console.log(`已生成 ${full}（含 ${packages.length} 个客户端文件，${await size(full)}）`);
}

if (args.includes('--clean')) {
  console.log(String.fromCharCode(10) + '清理旧版本……');
  const cleaner = [path.join(root, 'scripts', 'clean-old-releases.mjs'), '--out', outDir];
  const preview = spawnSync(process.execPath, cleaner, { stdio: 'inherit' });   // 先预览，不删
  if (args.includes('--yes')) {
    const run = spawnSync(process.execPath, [...cleaner, '--yes'], { stdio: 'inherit' });
    if (run.status !== 0) console.log('有旧文件没清理掉（多半被占用），关掉对应程序后可单独运行：node scripts/clean-old-releases.mjs --yes [--kill]');
  } else if (preview.status === 0) console.log('没有删除。确认上面的清单没问题后，再加 --yes 重新打包或单独运行：node scripts/clean-old-releases.mjs --yes');
} else console.log(String.fromCharCode(10) + '提示：旧版本文件可以用 node scripts/clean-old-releases.mjs 预览清理（加 --yes 才真删）；或下次打包时加 --clean。');
