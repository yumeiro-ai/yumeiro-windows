// 极简 zip 读写（不依赖第三方包）：只支持 store / deflate，不支持 zip64、加密。
// 读取时对解压后的大小、文件数、路径做严格限制，防止 zip 炸弹和 "../" 路径穿越。
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
export function crc32(buffer) { let c = 0xffffffff; for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function dosDateTime(date) {
  const d = new Date(date), year = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

// entries: [{ name: 'a/b.txt', data: Buffer, mtime?: number }] → Buffer
export function createZip(entries, { now = Date.now() } = {}) {
  const locals = [], centrals = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8'), data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data), packed = data.length > 64 ? deflateRawSync(data, { level: 6 }) : data;
    const deflated = packed !== data && packed.length < data.length, body = deflated ? packed : data, method = deflated ? 8 : 0;
    const { time, date } = dosDateTime(entry.mtime || now);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(method, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((entry.mode || 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body); centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// 把压缩包里的路径变成安全的相对路径；不安全返回 null
export function safeEntryName(raw) {
  let name = String(raw).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.includes('\0')) return null;
  const parts = name.split('/').filter(part => part !== '');
  if (!parts.length || parts.some(part => part === '..' || part === '.')) return null;
  if (parts.length > 24 || parts.some(part => part.length > 200)) return null;
  return parts.join('/');
}

// 返回 { entries: [{name, data}], skipped: [{name, reason}] }；超限直接抛错
export function readZip(buffer, { maxFiles = 3000, maxEntryBytes = 25 * 1048576, maxTotalBytes = 300 * 1048576 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('这不是有效的 zip 文件');
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('这不是有效的 zip 文件（找不到目录结构）');
  const count = buffer.readUInt16LE(eocd + 10), centralSize = buffer.readUInt32LE(eocd + 12), centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralOffset === 0xffffffff) throw new Error('不支持 zip64 大包，请拆小后再导入');
  if (centralOffset + centralSize > buffer.length) throw new Error('zip 文件已损坏');
  if (count > maxFiles + 2000) throw new Error('压缩包里的文件太多（上限 ' + maxFiles + '）');
  const entries = [], skipped = []; let position = centralOffset, total = 0;
  for (let n = 0; n < count; n++) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== 0x02014b50) throw new Error('zip 文件已损坏');
    const flags = buffer.readUInt16LE(position + 8), method = buffer.readUInt16LE(position + 10), crc = buffer.readUInt32LE(position + 16), csize = buffer.readUInt32LE(position + 20), usize = buffer.readUInt32LE(position + 24);
    const nameLen = buffer.readUInt16LE(position + 28), extraLen = buffer.readUInt16LE(position + 30), commentLen = buffer.readUInt16LE(position + 32), localOffset = buffer.readUInt32LE(position + 42);
    const rawName = buffer.toString('utf8', position + 46, position + 46 + nameLen);
    position += 46 + nameLen + extraLen + commentLen;
    if (rawName.endsWith('/')) continue; // 目录
    const name = safeEntryName(rawName);
    if (!name) { skipped.push({ name: rawName, reason: '路径不安全' }); continue; }
    if (flags & 1) { skipped.push({ name, reason: '已加密，无法读取' }); continue; }
    if (usize > maxEntryBytes) { skipped.push({ name, reason: '单个文件超过 ' + Math.floor(maxEntryBytes / 1048576) + ' MB' }); continue; }
    total += usize;
    if (total > maxTotalBytes) throw new Error('压缩包解压后超过 ' + Math.floor(maxTotalBytes / 1048576) + ' MB，请拆小后再导入');
    if (entries.length >= maxFiles) throw new Error('压缩包里的文件太多（上限 ' + maxFiles + '）');
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip 文件已损坏');
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (start + csize > buffer.length) throw new Error('zip 文件已损坏');
    const slice = buffer.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(slice);
    else if (method === 8) { try { data = inflateRawSync(slice, { maxOutputLength: Math.max(1, usize) + 1 }); } catch { throw new Error('zip 文件已损坏或解压后大小与声明不符：' + name); } }
    else { skipped.push({ name, reason: '不支持的压缩方式' }); continue; }
    if (data.length !== usize || crc32(data) !== crc) throw new Error('zip 文件校验失败：' + name);
    entries.push({ name, data });
  }
  return { entries, skipped };
}
