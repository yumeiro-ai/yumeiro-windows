// 把客户端安装包（Windows 安装版 / 便携版、Android APK）放进数据目录的 downloads/，网页里的“下载客户端”引导就会出现对应按钮。
// 安装包不打进 Docker 镜像，也不随程序部署（体积大，且每次升级都会重复占用）。
//
// 用法：node scripts/install-clients.mjs <存放安装包的文件夹> [--prune]
//   --prune   同时删掉 downloads/ 里更旧版本的安装版 / 便携版（APK 只保留同名的最新一个）
// 数据目录取环境变量 DATA_DIR（默认 ./data）。会重新生成 SHA256.txt，网页会提示用户校验。
//
// Docker 版：docker compose cp ./Yumeiro-Clients/. yumeiro:/tmp/clients && docker compose exec yumeiro node scripts/install-clients.mjs /tmp/clients --prune
// 直装版：  sudo DATA_DIR=/var/lib/yumeiro node scripts/install-clients.mjs ./Yumeiro-Clients --prune && sudo chown -R yumeiro:yumeiro /var/lib/yumeiro/downloads
import { mkdir, readdir, copyFile, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), prune = args.includes('--prune'), sourceDir = args.find(a => !a.startsWith('--'));
if (!sourceDir) { console.error('用法：node scripts/install-clients.mjs <存放安装包的文件夹> [--prune]'); process.exit(1); }
const target = path.join(process.env.DATA_DIR || path.join(root, 'data'), 'downloads');
const PACKAGE = /^(Yumeiro-(?:Setup|Portable)-\d[0-9A-Za-z.-]*\.exe|Yumeiro-[A-Za-z0-9.-]+\.apk)$/;
const versionOf = name => ((/(\d+(?:\.\d+)*)/.exec(name) || ['', '0'])[1]).split('.').map(Number);
const compare = (a, b) => { const x = versionOf(a), y = versionOf(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');
await mkdir(target, { recursive: true });
const found = (await readdir(sourceDir)).filter(name => PACKAGE.test(name));
if (!found.length) { console.error('在 ' + sourceDir + ' 里没有找到 Yumeiro-Setup-*.exe / Yumeiro-Portable-*.exe / Yumeiro-*.apk'); process.exit(1); }
for (const name of found) {
  const from = path.join(sourceDir, name), to = path.join(target, name);
  const same = await stat(to).then(info => info.size === 0 ? false : stat(from).then(f => f.size === info.size), () => false);
  if (same && await sha(from) === await sha(to)) { console.log('已是最新，跳过', name); continue; }
  await copyFile(from, to); console.log('已复制', name);
}
if (prune) {
  for (const kind of [/^Yumeiro-Setup-/, /^Yumeiro-Portable-/]) {
    const all = (await readdir(target)).filter(name => PACKAGE.test(name) && kind.test(name)).sort(compare);
    for (const old of all.slice(0, -1)) { await rm(path.join(target, old)); console.log('已删除旧版本', old); }
  }
}
const present = (await readdir(target)).filter(name => PACKAGE.test(name)).sort();
await writeFile(path.join(target, 'SHA256.txt'), (await Promise.all(present.map(async name => (await sha(path.join(target, name))) + ' *' + name))).join('\n') + '\n');
console.log('已更新 SHA256.txt（' + present.length + ' 个文件）→ ' + target);
