import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readZip } from '../ziputil.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('发布包：包含部署需要的文件、不含 node_modules / data / secrets / .env / 构建产物；.sh 带可执行权限；可附带客户端安装包', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'ym-release-')), clients = await mkdtemp(path.join(tmpdir(), 'ym-clients-'));
  try {
    await writeFile(path.join(clients, 'Yumeiro-Setup-9.9.9.exe'), 'fake-exe'); await writeFile(path.join(clients, 'notes.txt'), '不该被打进去');
    const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'make-release.mjs'), '--out', out, '--clients', clients], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
    const lean = readZip(await readFile(path.join(out, `Yumeiro-${version}.zip`))), full = readZip(await readFile(path.join(out, `Yumeiro-${version}-with-clients.zip`)));
    const names = lean.entries.map(e => e.name);
    for (const must of ['Yumeiro/server.mjs', 'Yumeiro/Dockerfile', 'Yumeiro/install.sh', 'Yumeiro/deploy/yumeiro-native.sh', 'Yumeiro/public/index.html', 'Yumeiro/public/side.js', 'Yumeiro/public/seed/wallpapers/rooftop-night.png', 'Yumeiro/scripts/install-clients.mjs', 'Yumeiro/.env.example', 'Yumeiro/安装说明.md', 'Yumeiro/客户端安装包上传说明.md', 'Yumeiro/runner/runner.mjs', 'Yumeiro/runner/winproc.mjs', 'Yumeiro/demo.mjs', 'Yumeiro/deploy/yumeiro-windows.ps1', 'Yumeiro/deploy/windows/run-service.mjs', 'Yumeiro/deploy/windows/updater.mjs', 'Yumeiro/deploy/windows/installer.nsi', 'Yumeiro/deploy/windows/docker-plan.mjs', 'Yumeiro/deploy/windows/docker-desktop.yml', 'Yumeiro/scripts/make-windows-installer.mjs', 'Yumeiro/docker/updater/updater.mjs', 'Yumeiro/Windows服务器安装说明.md']) assert.ok(names.includes(must), '发布包缺少 ' + must);
    for (const bad of [/(^|\/)node_modules\//, /^Yumeiro\/data\//, /(^|\/)secrets\//, /^Yumeiro\/\.env$/, /^Yumeiro\/\.git(\/|$)/, /^Yumeiro\/\.cindy-worktrees\//, /^Yumeiro\/\.cloudbase-demo\//, /\/dist\//, /clients\/android\/android\//, /\.zip$/, /\.cshare$/, /^Yumeiro\/_/, /^Yumeiro\/logs\//, /brand\/wallpapers\//, /^Yumeiro\/public\/downloads\//])
      assert.ok(!names.some(n => bad.test(n)), '发布包里不该有：' + bad + ' → ' + names.filter(n => bad.test(n)).slice(0, 3));
    assert.ok(names.includes('Yumeiro/clients/android-native/app/src/main/java/org/yumeiro/app/data/Api.kt'), '安卓源码包 data/ 里的 Api.kt 必须在发布包里（只有项目根目录的 data/ 才是运行数据）');
    assert.deepEqual(lean.skipped, []);
    const fullNames = full.entries.map(e => e.name);
    assert.ok(fullNames.includes('Yumeiro/Yumeiro-Clients/Yumeiro-Setup-9.9.9.exe')); assert.ok(!fullNames.some(n => n.endsWith('notes.txt')), '只收符合命名格式的安装包');
    assert.equal(fullNames.length, names.length + 1);
    // .sh 的可执行权限：zip 中央目录的外部属性高 16 位是 Unix mode
    const buf = await readFile(path.join(out, `Yumeiro-${version}.zip`)), modeOf = name => {
      let i = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])), at = buf.readUInt32LE(i + 16);
      while (buf.readUInt32LE(at) === 0x02014b50) {
        const nameLen = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32);
        if (buf.toString('utf8', at + 46, at + 46 + nameLen) === name) return buf.readUInt32LE(at + 38) >>> 16;
        at += 46 + nameLen + extra + comment;
      }
      return null;
    };
    assert.equal(modeOf('Yumeiro/install.sh') & 0o111, 0o111, 'install.sh 可执行'); assert.equal(modeOf('Yumeiro/deploy/yumeiro-native.sh') & 0o111, 0o111);
    assert.equal(modeOf('Yumeiro/server.mjs') & 0o111, 0, '普通文件不可执行');
  } finally { await rm(out, { recursive: true, force: true }); await rm(clients, { recursive: true, force: true }); }
});
