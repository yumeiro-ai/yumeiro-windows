// 工作区文件的版本备份与清理（零依赖，只做文件操作；路径安全由调用方的 resolveInWorkspace 保证）。
// 备份目录：<root>/.versions/<工作区>/<sha256(路径)前 32 位>/{path.txt, <毫秒时间>-<内容哈希前 12 位>}
// 规则：任何覆盖、删除、智能体运行前后，旧内容都会先存一份；相同内容不重复存；备份永远不随文件删除而删除。
import { mkdir, readdir, readFile, writeFile, rm, stat, lstat, copyFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const IGNORED = new Set(['node_modules', '.git']); // 依赖和 git 内部文件体量大且可重建，不进清单和备份
export const VERSION_DIR = '.versions';
export const LIMITS = { maxVersionsPerFile: 30, maxFileBytes: 20 * 1024 * 1024, maxFiles: 20000 };
const sha = value => createHash('sha256').update(value).digest('hex');

export const versionRoot = (root, id) => path.join(root, VERSION_DIR, id);
const fileDir = (root, id, rel) => path.join(versionRoot(root, id), sha(rel).slice(0, 32));

async function hashFile(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }

// 递归列出普通文件（不跟随符号链接）
export async function walkFiles(real, { max = LIMITS.maxFiles } = {}) {
  const files = []; let truncated = false;
  async function walk(dir, prefix) {
    for (const name of (await readdir(dir)).sort()) {
      if (files.length >= max) { truncated = true; return; }
      const full = path.join(dir, name), info = await lstat(full).catch(() => null);
      if (!info) continue;
      const rel = prefix ? prefix + '/' + name : name;
      if (info.isDirectory()) { if (!IGNORED.has(name)) await walk(full, rel); }
      else if (info.isFile()) files.push({ path: rel, size: info.size, mtime: Math.floor(info.mtimeMs) });
    }
  }
  await walk(real, '');
  return { files, truncated };
}

export async function listVersions(root, id, rel) {
  const dir = fileDir(root, id, rel);
  let names; try { names = await readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const match = name.match(/^(\d{10,})-([0-9a-f]{12})$/);
    if (!match) continue;
    const info = await stat(path.join(dir, name)).catch(() => null);
    if (info) out.push({ id: name, at: Number(match[1]), size: info.size });
  }
  return out.sort((a, b) => b.at - a.at);
}

async function prune(root, id, rel) {
  const versions = await listVersions(root, id, rel);
  for (const old of versions.slice(LIMITS.maxVersionsPerFile)) await rm(path.join(fileDir(root, id, rel), old.id), { force: true });
}

// 备份一个文件的当前内容。返回 'saved' | 'same' | 'missing' | 'skipped'
export async function snapshotFile(root, id, real, rel, { force = false, now = Date.now() } = {}) {
  const source = path.join(real, rel), info = await lstat(source).catch(() => null);
  if (!info || !info.isFile()) return 'missing';
  if (info.size > LIMITS.maxFileBytes && !force) return 'skipped';
  const digest = (await hashFile(source)).slice(0, 12), dir = fileDir(root, id, rel);
  const existing = await listVersions(root, id, rel);
  if (existing[0]?.id.endsWith('-' + digest)) return 'same';
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'path.txt'), rel);
  let at = now; while (existing.some(v => v.at === at)) at++;
  await copyFile(source, path.join(dir, `${at}-${digest}`));
  await prune(root, id, rel);
  return 'saved';
}

// 备份整个工作区里自上次以来有变化的文件
export async function snapshotWorkspace(root, id, real) {
  const { files, truncated } = await walkFiles(real);
  const result = { saved: 0, same: 0, skipped: 0, truncated };
  for (const file of files) { const r = await snapshotFile(root, id, real, file.path); if (r in result) result[r]++; }
  return result;
}

// 所有有过备份的路径（包括已被删除的）
export async function history(root, id, real) {
  let dirs; try { dirs = await readdir(versionRoot(root, id)); } catch { return []; }
  const out = [];
  for (const name of dirs) {
    const dir = path.join(versionRoot(root, id), name);
    const rel = await readFile(path.join(dir, 'path.txt'), 'utf8').catch(() => null);
    if (!rel) continue;
    const versions = await listVersions(root, id, rel);
    if (!versions.length) continue;
    const exists = Boolean(await lstat(path.join(real, rel)).then(i => i.isFile()).catch(() => false));
    out.push({ path: rel, versions: versions.length, latestAt: versions[0].at, size: versions[0].size, exists });
  }
  return out.sort((a, b) => b.latestAt - a.latestAt);
}

export async function readVersion(root, id, rel, versionId, limit = 262144) {
  if (!/^\d{10,}-[0-9a-f]{12}$/.test(versionId)) throw Object.assign(new Error('版本无效'), { status: 400 });
  const file = path.join(fileDir(root, id, rel), versionId);
  const data = await readFile(file).catch(() => null);
  if (!data) throw Object.assign(new Error('版本不存在'), { status: 404 });
  const slice = data.subarray(0, limit);
  if (slice.includes(0)) return { type: 'binary', size: data.length };
  return { type: 'file', size: data.length, truncated: data.length > slice.length, content: slice.toString('utf8') };
}

// 还原：先把现有内容备份，再把选中的版本写回
export async function restoreVersion(root, id, real, target, rel, versionId) {
  if (!/^\d{10,}-[0-9a-f]{12}$/.test(versionId)) throw Object.assign(new Error('版本无效'), { status: 400 });
  const source = path.join(fileDir(root, id, rel), versionId);
  if (!await stat(source).catch(() => null)) throw Object.assign(new Error('版本不存在'), { status: 404 });
  await snapshotFile(root, id, real, rel, { force: true });
  await mkdir(path.dirname(target), { recursive: true });
  const temp = target + '.restore-' + process.pid;
  await copyFile(source, temp); await rename(temp, target);
}

// 删除一批文件：逐个先备份再删除；mtime 与审核时不一致（审核后又被改过）的跳过。
export async function deleteWithBackup(root, id, real, items, { now = Date.now() } = {}) {
  const deleted = [], skipped = [];
  for (const item of items) {
    const target = path.join(real, item.path), info = await lstat(target).catch(() => null);
    if (!info || !info.isFile()) { skipped.push({ path: item.path, reason: '文件已不存在' }); continue; }
    if (item.mtime !== undefined && Math.floor(info.mtimeMs) !== item.mtime) { skipped.push({ path: item.path, reason: '审核后又被修改过' }); continue; }
    const backup = await snapshotFile(root, id, real, item.path, { force: true, now });
    if (backup === 'missing') { skipped.push({ path: item.path, reason: '备份失败，未删除' }); continue; }
    await rm(target, { force: true });
    deleted.push(item.path);
  }
  return { deleted, skipped };
}
