import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assembleClients, findApk, shaLine } from '../scripts/release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = text => createHash('sha256').update(text).digest('hex');

test('findApk：只接受显式指定的 APK，不复用输出目录中的历史 APK', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'ym-rel-'));
  try {
    assert.equal(findApk(out), '');
    mkdirSync(path.join(out, 'Yumeiro-Clients-1.0.0')); writeFileSync(path.join(out, 'Yumeiro-Clients-1.0.0', 'Yumeiro-android-debug.apk'), 'old apk');
    assert.equal(findApk(out), '');
    const mine = path.join(out, 'my.apk'); writeFileSync(mine, 'x');
    assert.equal(findApk(out, mine), mine);
    assert.throws(() => findApk(out, path.join(out, 'nope.apk')), /找不到指定的 APK/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('assembleClients：复制 Setup / Portable / APK，写 SHA256.txt（校验值正确）；缺安装包时给出明确提示', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'ym-rel-')), dist = path.join(base, 'dist'), out = path.join(base, 'out'); mkdirSync(dist); mkdirSync(out);
  try {
    assert.throws(() => assembleClients({ distDir: dist, outDir: out, clientVersion: '1.2.3', apk: '' }), /找不到.*--build-client/);
    writeFileSync(path.join(dist, 'Yumeiro-Setup-1.2.3.exe'), 'setup'); writeFileSync(path.join(dist, 'Yumeiro-Portable-1.2.3.exe'), 'portable'); writeFileSync(path.join(base, 'a.apk'), 'apk');
    const made = assembleClients({ distDir: dist, outDir: out, clientVersion: '1.2.3', apk: path.join(base, 'a.apk') });
    assert.equal(path.basename(made.folder), 'Yumeiro-Clients-1.2.3');
    for (const name of ['Yumeiro-Setup-1.2.3.exe', 'Yumeiro-Portable-1.2.3.exe', 'a.apk', 'SHA256.txt']) assert.ok(existsSync(path.join(made.folder, name)), name);
    const lines = readFileSync(path.join(made.folder, 'SHA256.txt'), 'utf8').trim().split('\n');
    assert.deepEqual(lines, ['portable', 'setup', 'apk'].map((text, i) => sha(text) + ' *' + ['Yumeiro-Portable-1.2.3.exe', 'Yumeiro-Setup-1.2.3.exe', 'a.apk'][i]));
    assert.equal(shaLine(path.join(made.folder, 'a.apk')), sha('apk') + ' *a.apk');
    const noApk = assembleClients({ distDir: dist, outDir: out, clientVersion: '1.2.3', apk: '' }); assert.equal(noApk.lines.length, 2);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('release.mjs --dry-run：只列步骤不执行；--no-clean 去掉清理，--skip-tests / --build-client 增减对应步骤', () => {
  const run = args => spawnSync(process.execPath, [path.join(root, 'scripts', 'release.mjs'), '--dry-run', ...args], { encoding: 'utf8' }).stdout;
  const all = run(['--build-client']);
  for (const label of ['跑全部测试', '构建 Windows 客户端', '整理客户端安装包文件夹', '生成发布压缩包', '写服务器校验文件', '清理旧版本']) assert.ok(all.includes(label), label);
  assert.ok(!run([]).includes('构建 Windows 客户端'));
  assert.ok(!run(['--no-clean']).includes('清理旧版本'));
  assert.ok(!run(['--skip-tests']).includes('跑全部测试'));
});

test('发版流程里的清理：先预览，确认（输入 yes 或 --yes）后才真删；失败时不动旧文件', () => {
  const text = readFileSync(path.join(root, 'scripts', 'release.mjs'), 'utf8');
  const preview = text.indexOf("run('清理旧版本：先预览'"), del = text.indexOf("run('清理旧版本：删除'");
  assert.ok(preview > 0 && del > preview, '预览必须在删除之前');
  assert.ok(text.includes("flag('--yes')") && text.includes("=== 'yes'") && text.includes('process.stdin.isTTY'));
  assert.ok(text.includes("'--yes', ...(flag('--kill')"), '删除这一步才带 --yes（--kill 要用户自己加）');
  assert.ok(!text.slice(0, del).includes("[...base, '--yes'"), '预览那一步不能带 --yes');
  assert.ok(text.includes('旧版本文件没有动') || text.includes('旧版本文件没有动。'), '前面的步骤失败要停下，不碰旧版本');
  const makeRelease = readFileSync(path.join(root, 'scripts', 'make-release.mjs'), 'utf8');
  assert.ok(makeRelease.includes('clean-old-releases.mjs'));
});

test('发版流程文档和 npm 脚本', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')), doc = readFileSync(path.join(root, '发版流程.md'), 'utf8');
  assert.equal(pkg.scripts.release, 'node scripts/release.mjs'); assert.equal(pkg.scripts['release:clean'], 'node scripts/clean-old-releases.mjs');
  for (const s of ['先预览', '输入 `yes`', '--yes', '--kill', '--dry-run', '旧版本文件不会被动']) assert.ok(doc.includes(s), s);
});
