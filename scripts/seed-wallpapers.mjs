// 首次启动时把内置的几张静态壁纸（public/seed/wallpapers）复制到 DATA_DIR/wallpapers。
// 只做一次：复制完写下标记文件 .seeded，之后管理员删掉某张壁纸也不会在重启时又冒出来；已存在的同名文件不会覆盖。
// Docker 镜像和直装版都会在启动前自动运行它（Dockerfile 的 CMD / systemd 的 ExecStartPre）；也可以手动运行：
//   DATA_DIR=/var/lib/yumeiro node scripts/seed-wallpapers.mjs
import { mkdir, readdir, copyFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'public', 'seed', 'wallpapers');
const target = path.join(process.env.DATA_DIR || path.join(root, 'data'), 'wallpapers');
const exists = file => stat(file).then(() => true, () => false);
await mkdir(target, { recursive: true });
if (await exists(path.join(target, '.seeded'))) { console.log('壁纸已初始化过，跳过'); process.exit(0); }
let names = [];
try { names = (await readdir(source)).filter(name => /^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|webp)$/i.test(name)); } catch { /* 没有内置壁纸 */ }
for (const name of names) {
  const dest = path.join(target, name);
  if (await exists(dest)) { console.log('已存在，跳过', name); continue; }
  await copyFile(path.join(source, name), dest); console.log('已复制', name);
}
await writeFile(path.join(target, '.seeded'), new Date().toISOString() + '\n');
