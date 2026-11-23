import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scan, plan, compareVersions, removeEntry } from '../scripts/clean-old-releases.mjs';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'clean-old-releases.mjs');
function fixture() {
  const out = mkdtempSync(path.join(tmpdir(), 'ym-clean-'));
  for (const v of ['0.39.2', '0.39.3', '0.39.4', '0.9.0']) for (const suffix of ['.zip', '-with-clients.zip', '-SHA256.txt']) writeFileSync(path.join(out, 'Yumeiro-' + v + suffix), 'x');
  for (const v of ['0.10.0', '0.11.0', '0.12.0']) { mkdirSync(path.join(out, 'Yumeiro-Clients-' + v)); writeFileSync(path.join(out, 'Yumeiro-Clients-' + v, 'Yumeiro-Setup-' + v + '.exe'), 'x'); }
  // 不该碰的东西
  for (const keep of ['Yumeiro-notes.txt', 'Yumeiro-0.39.2.zip.bak', 'readme.md', 'Yumeiro-latest.zip']) writeFileSync(path.join(out, keep), 'x');
  mkdirSync(path.join(out, 'Yumeiro-Clients-backup')); mkdirSync(path.join(out, 'Yumeiro-0.30.0'));   // 名字像但不是发布产物（后者是文件夹，不匹配 zip 规则）
  return out;
}

test('版本比较按数字：0.9.0 < 0.10.0 < 0.39.4', () => {
  assert.ok(compareVersions('0.9.0', '0.10.0') < 0 && compareVersions('0.10.0', '0.39.4') < 0 && compareVersions('1.0.0', '0.99.99') > 0 && compareVersions('0.1.1', '0.1.1') === 0);
});

test('只认发布产物的名字，别的文件和文件夹一律不碰', () => {
  const out = fixture();
  try {
    const names = scan(out).map(entry => entry.name);
    assert.ok(names.includes('Yumeiro-0.39.4.zip') && names.includes('Yumeiro-Clients-0.12.0'));
    for (const bad of ['Yumeiro-notes.txt', 'Yumeiro-0.39.2.zip.bak', 'readme.md', 'Yumeiro-latest.zip', 'Yumeiro-Clients-backup', 'Yumeiro-0.30.0']) assert.ok(!names.includes(bad), bad);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('每一类只保留最新的 N 个版本；N 不能小于 1', () => {
  const out = fixture();
  try {
    const entries = scan(out);
    const one = plan(entries, 1);
    assert.deepEqual(one.keep.map(e => e.name).sort(), ['Yumeiro-0.39.4-SHA256.txt', 'Yumeiro-0.39.4-with-clients.zip', 'Yumeiro-0.39.4.zip', 'Yumeiro-Clients-0.12.0']);
    assert.equal(one.remove.length, 9 + 2);   // 3 个旧服务器版本 ×3 个文件 + 2 个旧客户端文件夹
    const two = plan(entries, 2);
    assert.ok(two.keep.some(e => e.name === 'Yumeiro-0.39.3.zip') && two.keep.some(e => e.name === 'Yumeiro-Clients-0.11.0') && !two.keep.some(e => e.name === 'Yumeiro-0.39.2.zip'));
    assert.throws(() => plan(entries, 0), /至少是 1/); assert.throws(() => plan(entries, 1.5)); assert.throws(() => plan(entries, NaN));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('命令行：默认只预览不删；加 --yes 才删旧版本，保留新版本和无关文件', () => {
  const out = fixture();
  try {
    const run = args => spawnSync(process.execPath, [script, '--out', out, '--no-dist', ...args], { encoding: 'utf8' });
    const preview = run([]); assert.equal(preview.status, 0); assert.match(preview.stdout, /预览，没有删任何东西/); assert.ok(existsSync(path.join(out, 'Yumeiro-0.39.2.zip')) && existsSync(path.join(out, 'Yumeiro-Clients-0.10.0')));
    const real = run(['--yes']); assert.equal(real.status, 0, real.stdout + real.stderr);
    const left = readdirSync(out).sort();
    assert.deepEqual(left, ['Yumeiro-0.30.0', 'Yumeiro-0.39.2.zip.bak', 'Yumeiro-0.39.4-SHA256.txt', 'Yumeiro-0.39.4-with-clients.zip', 'Yumeiro-0.39.4.zip', 'Yumeiro-Clients-0.12.0', 'Yumeiro-Clients-backup', 'Yumeiro-latest.zip', 'Yumeiro-notes.txt', 'readme.md'].sort());
    assert.match(run(['--yes']).stdout, /没有旧版本需要清理/);
    assert.equal(run(['--keep', '0']).status, 2);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('文件被占用时：不加 --kill 只提示占用者，加 --kill 先结束占用进程再重试', () => {
  const entry = { full: 'E:/x/Yumeiro-Clients-0.1.0', name: 'Yumeiro-Clients-0.1.0', dir: true };
  const busy = Object.assign(new Error('busy'), { code: 'EBUSY' });
  let removed = 0; const killed = [];
  const remover = () => { if (!killed.length) throw busy; removed++; };
  const finder = () => [{ pid: 4242, name: 'Yumeiro-Portable-0.1.0.exe', exe: 'E:/x/Yumeiro-Clients-0.1.0/Yumeiro-Portable-0.1.0.exe' }];
  const plain = removeEntry(entry, { remover, finder, killer: pid => killed.push(pid) });
  assert.equal(plain.ok, false); assert.equal(plain.busy, true); assert.equal(plain.holders[0].pid, 4242); assert.equal(killed.length, 0);
  const forced = removeEntry(entry, { kill: true, remover, finder, killer: pid => killed.push(pid) });
  assert.equal(forced.ok, true); assert.deepEqual(killed, [4242]); assert.equal(removed, 1);
  assert.equal(removeEntry(entry, { remover: () => { throw Object.assign(new Error('nope'), { code: 'EINVAL' }); }, finder }).ok, false);
});

test('make-release 支持 --clean，并提示可以单独清理', () => {
  const text = readFileSync(new URL('../scripts/make-release.mjs', import.meta.url), 'utf8');
  assert.ok(text.includes("args.includes('--clean')") && text.includes('clean-old-releases.mjs') && text.includes("'--yes'"));
});
import { readFileSync } from 'node:fs';
