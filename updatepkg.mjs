// 网页更新用的压缩包工具：上传后的校验与解压。服务端（检查版本）和 root 更新助手（解压安装）共用。
// 只读 zip 目录、按条目解压：不把整个大包读进内存；拒绝加密条目、zip64、不安全路径。
import { open, mkdir, writeFile, chmod } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, timingSafeEqual, createPublicKey, createPrivateKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { safeEntryName, crc32 } from './ziputil.mjs';

export const UPDATE_MAX_BYTES = 400 * 1048576;           // 上传上限（含客户端安装包的完整包约 200 MB）
const LIMITS = { files: 6000, entry: 256 * 1048576, total: 1024 * 1048576 };

export function sha256OfFile(file) {
  return new Promise((resolve, reject) => { const hash = createHash('sha256'); createReadStream(file).on('data', c => hash.update(c)).on('error', reject).on('end', () => resolve(hash.digest('hex'))); });
}
// 从用户粘贴的文字里取出校验值：可以是单独的 64 位十六进制，也可以是 SHA256.txt 里的整行/整份（优先取文件名对得上的那一行）
export function parseSha256(text, fileName = '') {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean), pick = line => (line.match(/\b[0-9a-fA-F]{64}\b/) || [''])[0].toLowerCase();
  if (fileName) { const hit = lines.find(line => line.toLowerCase().includes(String(fileName).toLowerCase()) && pick(line)); if (hit) return pick(hit); }
  return lines.length === 1 || !fileName ? pick(lines[0] || '') : '';
}
export const sameHash = (a, b) => { const x = Buffer.from(String(a || ''), 'utf8'), y = Buffer.from(String(b || ''), 'utf8'); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };
export function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split(/[.-]/).map(Number), pb = String(b || '').replace(/^v/i, '').split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

async function readDirectory(handle, size) {
  const tailLen = Math.min(size, 22 + 65535), tail = Buffer.alloc(tailLen);
  await handle.read(tail, 0, tailLen, size - tailLen);
  let eocd = -1; for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('这不是有效的 zip 文件');
  const count = tail.readUInt16LE(eocd + 10), cSize = tail.readUInt32LE(eocd + 12), cOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cOffset === 0xffffffff) throw new Error('不支持 zip64 大包');
  if (count > LIMITS.files) throw new Error('压缩包里的文件太多');
  if (cOffset + cSize > size) throw new Error('zip 文件已损坏');
  const central = Buffer.alloc(cSize); await handle.read(central, 0, cSize, cOffset);
  const entries = []; let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > central.length || central.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 文件已损坏');
    const flags = central.readUInt16LE(p + 8), method = central.readUInt16LE(p + 10), crc = central.readUInt32LE(p + 16), csize = central.readUInt32LE(p + 20), usize = central.readUInt32LE(p + 24);
    const nl = central.readUInt16LE(p + 28), el = central.readUInt16LE(p + 30), cl = central.readUInt16LE(p + 32), mode = central.readUInt32LE(p + 38) >>> 16, offset = central.readUInt32LE(p + 42);
    entries.push({ raw: central.toString('utf8', p + 46, p + 46 + nl), flags, method, crc, csize, usize, mode, offset });
    p += 46 + nl + el + cl;
  }
  return entries;
}
async function readEntry(handle, entry) {
  if (entry.flags & 1) throw new Error('不支持加密的压缩包');
  if (entry.usize > LIMITS.entry) throw new Error('压缩包里有过大的文件：' + entry.raw);
  const head = Buffer.alloc(30); await handle.read(head, 0, 30, entry.offset);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('zip 文件已损坏');
  const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28), packed = Buffer.alloc(entry.csize);
  if (entry.csize) await handle.read(packed, 0, entry.csize, start);
  const data = entry.method === 0 ? packed : entry.method === 8 ? inflateRawSync(packed, { maxOutputLength: entry.usize + 1 }) : (() => { throw new Error('不支持的压缩方式'); })();
  if (data.length !== entry.usize || crc32(data) !== entry.crc) throw new Error('压缩包内容校验失败：' + entry.raw);
  return data;
}
async function withZip(file, fn) {
  const handle = await open(file, 'r');
  try { const { size } = await handle.stat(); return await fn(handle, await readDirectory(handle, size)); } finally { await handle.close(); }
}
// 找出顶层目录（发布包是 Yumeiro/），确认是 Yumeiro 的发布包，返回版本号
export async function inspectUpdateZip(file) {
  return withZip(file, async (handle, entries) => {
    const names = entries.map(e => ({ ...e, name: safeEntryName(e.raw) })).filter(e => e.name && !e.raw.endsWith('/'));
    if (!names.length) throw new Error('压缩包是空的');
    const roots = new Set(names.map(e => e.name.split('/')[0]));
    const pkgEntry = names.find(e => /^[^/]+\/package\.json$/.test(e.name));
    if (roots.size !== 1 || !pkgEntry) throw new Error('这不是 Yumeiro 的发布包（找不到顶层目录里的 package.json）');
    const root = pkgEntry.name.split('/')[0], has = n => names.some(e => e.name === root + '/' + n);
    let pkg; try { pkg = JSON.parse((await readEntry(handle, pkgEntry)).toString('utf8')); } catch { throw new Error('压缩包里的 package.json 无法读取'); }
    if (pkg.name !== 'yumeiro-web') throw new Error('这不是 Yumeiro 的发布包（程序名不匹配）');
    if (!/^\d+\.\d+\.\d+/.test(String(pkg.version || ''))) throw new Error('压缩包里的版本号无效');
    if (!has('server.mjs') || !has('deploy/yumeiro-native.sh') || !has('public/index.html')) throw new Error('发布包不完整：缺少 server.mjs、public 或 deploy/yumeiro-native.sh');
    return { version: String(pkg.version), root, fileCount: names.length, withClients: names.some(e => e.name.startsWith(root + '/Yumeiro-Clients/')) };
  });
}
// 解压到 destDir/<root>/…；只写普通文件，.sh 加可执行权限
export async function extractUpdateZip(file, destDir, root) {
  return withZip(file, async (handle, entries) => {
    let total = 0, written = 0;
    for (const entry of entries) {
      const name = safeEntryName(entry.raw);
      if (!name || entry.raw.endsWith('/')) continue;
      if (name.split('/')[0] !== root) throw new Error('压缩包结构异常：' + entry.raw);
      total += entry.usize; if (total > LIMITS.total) throw new Error('压缩包解压后过大');
      const target = path.join(destDir, name);
      if (path.relative(destDir, target).startsWith('..')) throw new Error('不安全的路径：' + entry.raw);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readEntry(handle, entry), { mode: 0o644 });
      if (/\.sh$/.test(name)) await chmod(target, 0o755);
      written++;
    }
    return { files: written, dir: path.join(destDir, root) };
  });
}

// ---- 官方签名：发布时用私钥给“文件清单”签名，程序内置公钥，上传后自己核实，不依赖任何人手填的校验值 ----
// 包里带两个文件：<根目录>/RELEASE.json（版本 + 每个文件的 SHA256 和大小）和 <根目录>/RELEASE.sig（Ed25519 签名，base64）。
// 验证：签名对得上内置公钥 → 清单可信 → 包里每个文件都和清单一致、没有多出或缺少的文件。
export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEADyIddBH6T5rBaNnbF8r8xc40zF21z796tj2t0+s5QIk=
-----END PUBLIC KEY-----
`;
export const MANIFEST_NAME = 'RELEASE.json', SIGNATURE_NAME = 'RELEASE.sig';
const publicKeyPem = () => { const file = process.env.YUMEIRO_RELEASE_PUBKEY_FILE; if (file) { try { return readFileSync(file, 'utf8'); } catch { /* 读不到就不信任任何签名 */ return ''; } } return RELEASE_PUBLIC_KEY; };
const sha256Buffer = data => createHash('sha256').update(data).digest('hex');
// 打包时用：entries 是 [{name:'Yumeiro/x', data}]，返回要追加到包里的两个条目
export function signRelease(entries, version, privateKeyPem, root = 'Yumeiro') {
  const files = entries.filter(e => e.name !== root + '/' + MANIFEST_NAME && e.name !== root + '/' + SIGNATURE_NAME)
    .map(e => ({ path: e.name.slice(root.length + 1), sha256: sha256Buffer(e.data), size: Buffer.byteLength(e.data) })).sort((a, b) => a.path < b.path ? -1 : 1);
  const manifest = Buffer.from(JSON.stringify({ name: 'yumeiro-web', version, files }, null, 1), 'utf8');
  const signature = cryptoSign(null, manifest, createPrivateKey(privateKeyPem)).toString('base64');
  return [{ name: root + '/' + MANIFEST_NAME, data: manifest }, { name: root + '/' + SIGNATURE_NAME, data: Buffer.from(signature + String.fromCharCode(10)) }];
}
// 验证并返回信息；任何不对都抛错（错误信息给管理员看）
export async function verifySignedUpdateZip(file) {
  const info = await inspectUpdateZip(file);
  return withZip(file, async (handle, entries) => {
    const named = entries.map(e => ({ ...e, name: safeEntryName(e.raw) })).filter(e => e.name && !e.raw.endsWith('/'));
    const get = n => named.find(e => e.name === info.root + '/' + n);
    const man = get(MANIFEST_NAME), sig = get(SIGNATURE_NAME);
    if (!man || !sig) throw new Error('这个压缩包没有官方签名（缺少 ' + MANIFEST_NAME + ' / ' + SIGNATURE_NAME + '），不能在网页里更新。请用官方发布的包，或在服务器上用命令更新。');
    const pem = publicKeyPem(); if (!pem) throw new Error('服务器没有可用的发布公钥');
    const manifest = await readEntry(handle, man), signature = Buffer.from((await readEntry(handle, sig)).toString('utf8').trim(), 'base64');
    let ok = false; try { ok = cryptoVerify(null, manifest, createPublicKey(pem), signature); } catch { ok = false; }
    if (!ok) throw new Error('官方签名验证失败：这个压缩包不是官方发布的，或签名已损坏，已拒绝。');
    let parsed; try { parsed = JSON.parse(manifest.toString('utf8')); } catch { throw new Error('签名清单无法读取'); }
    if (parsed.name !== 'yumeiro-web' || parsed.version !== info.version) throw new Error('签名清单与压缩包的版本不一致');
    const want = new Map((parsed.files || []).map(f => [String(f.path), f]));
    const body = named.filter(e => e !== man && e !== sig);
    if (body.length !== want.size) throw new Error('压缩包里的文件和签名清单不一致（文件数量不同），已拒绝。');
    for (const e of body) {
      const item = want.get(e.name.slice(info.root.length + 1));
      if (!item) throw new Error('压缩包里有签名清单之外的文件：' + e.name);
      const data = await readEntry(handle, e);
      if (data.length !== item.size || !sameHash(sha256Buffer(data), item.sha256)) throw new Error('文件内容与签名清单不符，压缩包可能被改动过：' + e.name);
    }
    return { ...info, signed: true, fileCount: body.length };
  });
}

// ---- 发布订阅源（releases.atom）解析 ----
// GitHub 接口不带登录信息时每个出口 IP 每小时只有 60 次，云服务器常被限流（HTTP 403 / 429）。
// 订阅源不限流：能拿到版本号、发布时间和说明；安装包没法从里面知道大小，按固定包名拼出下载地址，下载后仍用内置公钥验签。
export function feedText(html) {
  return String(html || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&') // 先还原 XML 转义，得到 HTML
    .replace(/<li>/g, '- ').replace(/<[/](li|p|h[1-6]|ul|ol|pre)>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&') // 再还原 HTML 转义
    .replace(/\n{3,}/g, '\n\n').trim();
}
export function parseReleaseFeed(xml, base, limit = 12) {
  return String(xml || '').split('<entry>').slice(1, limit + 1).map(block => {
    const tag = (block.match(/releases[/]tag[/]v?([0-9]+[.][0-9]+[.][0-9]+)"/) || [])[1];
    if (!tag) return null;
    const when = (block.match(/<updated>([^<]+)<[/]updated>/) || [])[1] || null;
    const content = (block.match(/<content[^>]*>([^<]*)<[/]content>/) || [])[1] || '';
    const file = name => ({ name, size: 0, url: base + '/releases/download/v' + tag + '/' + name });
    return { version: tag, publishedAt: when, notes: feedText(content).slice(0, 1500), releaseUrl: base + '/releases/tag/v' + tag, server: file('Yumeiro-' + tag + '.zip'), clients: file('Yumeiro-' + tag + '-with-clients.zip'), viaFeed: true };
  }).filter(Boolean);
}
