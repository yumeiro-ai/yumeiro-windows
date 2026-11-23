// 选出最新的 Cindy 桌面端 Linux 安装包（.deb）。纯函数，方便测试；update.sh 通过命令行调用。
// 命令行：node pick-release.mjs <已安装版本|0> [cn|global] [x64|arm64] < release.json
// 输出一行（用 | 分隔；sha256 可能为空）：update|current  版本  下载地址  sha256  文件名
export function parseVersion(value) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(value || ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
export function compareVersions(a, b) {
  const x = parseVersion(a) || [0, 0, 0], y = parseVersion(b) || [0, 0, 0];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
export function pickRelease(release, { flavor = 'cn', arch = 'x64' } = {}) {
  if (!release || release.draft || release.prerelease || !Array.isArray(release.assets)) return null;
  const pattern = new RegExp(`^cindy-(\\d+\\.\\d+\\.\\d+)-linux-${arch}-${flavor}\\.deb$`);
  for (const asset of release.assets) {
    const match = pattern.exec(String(asset?.name || ''));
    if (!match || typeof asset.browser_download_url !== 'string' || !asset.browser_download_url.startsWith('https://')) continue;
    const digest = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''));
    return { version: match[1], url: asset.browser_download_url, name: asset.name, sha256: digest ? digest[1].toLowerCase() : '', size: Number(asset.size) || 0 };
  }
  return null;
}
// 最近发布过的版本（每个版本里有没有国际版 / 国内版的安装包），给“选择版本”下拉框用
export function listVersions(releases, { arch = 'x64', limit = 12 } = {}) {
  const out = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft || release.prerelease) continue;
    const global = pickRelease(release, { flavor: 'global', arch }), cn = pickRelease(release, { flavor: 'cn', arch });
    const version = (global || cn)?.version;
    if (!version) continue;
    out.push({ version, date: String(release.published_at || '').slice(0, 10), global: Boolean(global), cn: Boolean(cn) });
    if (out.length >= limit) break;
  }
  return out;
}
export const validVersion = value => /^\d+\.\d+\.\d+$/.test(String(value || ''));

export function decide(installed, release, options) {
  const best = pickRelease(release, options);
  if (!best) return { action: 'none', reason: '最新发布里没有适合的安装包（' + (options?.flavor || 'cn') + ' / ' + (options?.arch || 'x64') + '）' };
  return compareVersions(best.version, installed) > 0 ? { action: 'update', ...best } : { action: 'current', ...best };
}

if (process.argv[1]?.endsWith('pick-release.mjs')) {
  const [installed = '0', flavor = 'cn', arch = 'x64'] = process.argv.slice(2);
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  let release = null; try { release = JSON.parse(text); } catch { /* 下面按无结果处理 */ }
  const result = decide(installed, release, { flavor, arch });
  if (result.action === 'none') { console.error(result.reason); process.exit(2); }
  console.log([result.action, result.version, result.url, result.sha256, result.name].join('|'));
}
