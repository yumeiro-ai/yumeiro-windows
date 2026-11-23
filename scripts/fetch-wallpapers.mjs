#!/usr/bin/env node
// 从 Cindy 官方开源客户端仓库下载桌面端的内置壁纸到 DATA_DIR/wallpapers，供网页版“壁纸”面板使用。
//   node scripts/fetch-wallpapers.mjs --accept-terms               下载 16 张静态壁纸（webp，合计约 10 MB）
//   node scripts/fetch-wallpapers.mjs --accept-terms --with-video  再下载 3 个动态壁纸（mp4，合计约 16 MB）
// Docker：docker compose run --rm --no-deps yumeiro node scripts/fetch-wallpapers.mjs --accept-terms
// 镜像：GITHUB_RAW_BASE=https://你的镜像/makecindy/cindy/main  可替换下载源（服务器访问不了 GitHub 时）
//
// 授权说明：Cindy 仓库的代码是 Apache-2.0，但壁纸这类美术素材（Cindy 角色插画）的授权范围仓库里没有单独写明。
// 本脚本只在你运行时把文件下载到你自己的服务器，项目本身不再分发这些图片；为避免误用，必须带 --accept-terms
// 表示你已经自行确认过授权（用于公开站点或商用之前，请先向 Cindy 官方确认）。
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const target = path.join(dataDir, 'wallpapers');
const base = (process.env.GITHUB_RAW_BASE || 'https://raw.githubusercontent.com/makecindy/cindy/main').replace(/\/+$/, '') + '/apps/desktop/src/renderer/assets/wallpapers/';
const images = ['cindy-neon', 'cindy-night-glance', 'cindy-prism', 'cindy-scarlet-stroll', 'cindy-whisper', 'cindy-dream', 'cindy-studio', 'cindy-window', 'dune-dawn', 'dune-sphere', 'indigo-folds', 'night-launch', 'ocean-clouds', 'planet-dawn', 'rose-quartz', 'silent-orbits'].map(n => n + '.webp');
const videos = ['cindy-dream', 'cindy-studio', 'cindy-window'].map(n => n + '.mp4');
const list = [...images, ...(process.argv.includes('--with-video') ? videos : [])];

if (!process.argv.includes('--accept-terms') && process.env.FETCH_WALLPAPERS_ACCEPT !== '1') {
  console.error('这些壁纸是 Cindy 官方仓库里的美术素材，授权范围没有单独写明（代码是 Apache-2.0，插画不一定）。\n已经自行确认可以使用的话，请加上 --accept-terms（或设置 FETCH_WALLPAPERS_ACCEPT=1）再运行。');
  process.exit(2);
}

await mkdir(target, { recursive: true });
console.log(`下载到 ${target}\n来源：${base}\n`);
let ok = 0, failed = 0;
for (const name of list) {
  const file = path.join(target, name);
  try { await access(file); console.log('  已存在，跳过 ' + name); ok++; continue; } catch { /* 需要下载 */ }
  try {
    const response = await fetch(base + name, { signal: AbortSignal.timeout(120000), redirect: 'follow' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length) throw new Error('空文件');
    await writeFile(file, data);
    console.log(`  ✓ ${name}（${(data.length / 1024).toFixed(0)} KB）`); ok++;
  } catch (error) { console.log(`  ✗ ${name}：${error.cause?.code || error.message}`); failed++; }
}
console.log(`\n完成：${ok} 个成功，${failed} 个失败。${failed ? '失败的可以重试，或设置 GITHUB_RAW_BASE 使用镜像。' : '到网页 ⌘ →“壁纸”里选择。'}`);
console.log('提醒：这些素材的授权请向 Cindy 官方确认后再用于公开站点。');
process.exitCode = failed && !ok ? 1 : 0;
