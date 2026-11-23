import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareVersions, pickRelease, decide } from '../desktop/pick-release.mjs';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const release = {
  tag_name: 'v0.1.136', draft: false, prerelease: false,
  assets: [
    { name: 'cindy-0.1.136-linux-x64-global.deb', browser_download_url: 'https://github.com/x/global.deb', digest: 'sha256:' + 'a'.repeat(64), size: 1 },
    { name: 'cindy-0.1.136-linux-x64-cn.deb', browser_download_url: 'https://github.com/x/cn.deb', digest: 'sha256:' + 'B'.repeat(64), size: 2 },
    { name: 'cindy-0.1.136-win32-x64-cn.exe', browser_download_url: 'https://github.com/x/win.exe' }
  ]
};

test('桌面端自动更新：版本比较按数字而不是字符串', () => {
  assert.equal(compareVersions('0.1.136', '0.1.121'), 1);
  assert.equal(compareVersions('0.1.9', '0.1.10'), -1);
  assert.equal(compareVersions('0.1.121', '0.1.121'), 0);
  assert.equal(compareVersions('1.0.0', '0'), 1);
});

test('桌面端自动更新：按 cn / global 和架构选安装包，sha256 取发布页给出的摘要', () => {
  const cn = pickRelease(release, { flavor: 'cn', arch: 'x64' });
  assert.equal(cn.name, 'cindy-0.1.136-linux-x64-cn.deb'); assert.equal(cn.sha256, 'b'.repeat(64));
  assert.equal(pickRelease(release, { flavor: 'global', arch: 'x64' }).url, 'https://github.com/x/global.deb');
  assert.equal(pickRelease(release, { flavor: 'cn', arch: 'arm64' }), null);
  assert.equal(pickRelease({ ...release, prerelease: true }), null);
  assert.equal(pickRelease({ ...release, assets: [{ ...release.assets[1], browser_download_url: 'http://insecure/x.deb' }] }), null);
  assert.equal(pickRelease({ ...release, assets: [{ ...release.assets[1], digest: undefined }] }).sha256, '');
});

test('桌面端自动更新：有新版才更新，已是最新或没有合适安装包都不动', () => {
  assert.equal(decide('0.1.121', release, { flavor: 'cn' }).action, 'update');
  assert.equal(decide('0.1.136', release, { flavor: 'cn' }).action, 'current');
  assert.equal(decide('0.1.200', release, { flavor: 'cn' }).action, 'current');
  assert.equal(decide('0.1.121', release, { flavor: 'cn', arch: 'arm64' }).action, 'none');
});

test('桌面端自动更新：入口脚本默认开启检查、用更新后的程序、连续失败自动回退；脚本能被容器取到', () => {
  const entry = read('desktop/entrypoint.sh'), update = read('desktop/update.sh'), compose = read('docker-compose.desktop.yml');
  for (const s of ['CINDY_AUTO_UPDATE:-1', 'current-bin', 'rollback', 'CINDY_UPDATE_INTERVAL_HOURS', 'FAST']) assert.ok(entry.includes(s), s);
  for (const s of ['sha256sum -c', 'dpkg-deb -x', 'ldd', 'exit 10', 'skip-version']) assert.ok(update.includes(s), s);
  assert.ok(compose.includes('./desktop:/opt/desktop:ro'));
  assert.ok(!entry.includes(String.fromCharCode(13)) && !update.includes(String.fromCharCode(13)), '脚本不能带回车符');
  assert.ok(entry.includes("tr -d '\\r' < /opt/desktop/update.sh"), 'update.sh 要去掉 Windows 回车符再用');
});

test('手动更新脚本：安装包文件名是 cindy-（改名时被误改成 yumeiro- 会导致永远找不到新版）', () => {
  const script = read('scripts/desktop-update.sh');
  assert.ok(script.includes('`cindy-${ver}-linux-x64-${region}.deb`'));
  assert.ok(!script.includes('yumeiro-${') && !script.includes("sed -n 's#.*/yumeiro-"));
});

test('直装版：--with-runner 会装 Claude Code / Codex / Pi，并提供 engines 子命令升级', () => {
  const sh = read('deploy/yumeiro-native.sh'), docker = read('runner/Dockerfile');
  for (const s of ['@anthropic-ai/claude-code', '@openai/codex', '@mariozechner/pi-coding-agent', 'install_engines', 'engines)', 'ENGINES_PREFIX/bin']) assert.ok(sh.includes(s), s);
  assert.match(docker, /for c in claude codex pi/);
  assert.match(docker, /mcp\.mjs/);
});

test('服务器下发模型支持的引擎；客户端聊天里选引擎后改走工作区运行', () => {
  const server = read('server.mjs'), app = read('clients/windows/app.js'), html = read('clients/windows/app.html');
  assert.ok(server.includes('engines:cindyEngines(model)')); assert.ok(server.includes('function gatewayFor('));
  for (const s of ['function sendViaEngine', 'chatEngine', "'engine:' + e.engine", "/runs'"]) assert.ok(app.includes(s), s);
  for (const id of ['wsSelect', 'modeSelect', 'wsPill']) assert.ok(html.includes('id="' + id + '"'), id);
  assert.match(app, /if \(chatTarget\.kind === 'model' && chatEngine\) \{[^}]*\} return sendViaEngine\(text\); \}/);
});

test('更新状态服务：必须带 desktop_key，GET /status 汇总版本与最近一次检查结果', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'ym-desktop-')); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'current-version'), '0.1.136\n');
  writeFileSync(join(root, 'status.json'), JSON.stringify({ installed: '0.1.136', latest: '0.1.140', result: 'failed', message: '下载失败', checkedAt: '2026-11-13T00:00:00.000Z' }));
  process.env.CINDY_APP_ROOT = root; process.env.BRIDGE_API_KEY = 'k'.repeat(24); process.env.CINDY_FLAVOR = 'global'; process.env.HOME = root;
  const { createStatusServer, startCheck } = await import('../desktop/status-server.mjs?t=' + Date.now());
  const server = createStatusServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    assert.equal((await fetch(base + '/status')).status, 401);
    assert.equal((await fetch(base + '/status', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const ok = await (await fetch(base + '/status', { headers: { Authorization: 'Bearer ' + 'k'.repeat(24) } })).json();
    assert.equal(ok.flavor, 'global'); assert.equal(ok.installed, '0.1.136'); assert.equal(ok.latest, '0.1.140'); assert.equal(ok.result, 'failed');
    assert.equal(ok.autoUpdate, true); assert.equal(ok.checking, false);
    const auth = { Authorization: 'Bearer ' + 'k'.repeat(24) };
    assert.equal((await fetch(base + '/switch?flavor=evil', { method: 'POST', headers: auth })).status, 400);
    assert.equal((await fetch(base + '/switch', { method: 'POST', headers: auth })).status, 400);
    assert.equal((await fetch(base + '/nope', { headers: { Authorization: 'Bearer ' + 'k'.repeat(24) } })).status, 404);
  } finally { server.close(); }
  // 同一时间只允许一个检查在跑
  const { EventEmitter } = await import('node:events');
  const child = new EventEmitter(); let spawned = 0;
  assert.equal(startCheck(() => { spawned++; return child; }), true);
  assert.equal(startCheck(() => { spawned++; return child; }), false);
  assert.equal(spawned, 1);
  child.emit('exit', 0);
  assert.equal(startCheck(() => { spawned++; return new EventEmitter(); }), true);
});

test('软件更新引导：国际版默认、更新结果写 status.json、服务器和页面都接上了', () => {
  const update = read('desktop/update.sh'), compose = read('docker-compose.desktop.yml'), server = read('server.mjs'), team = read('public/team.js'), entry = read('desktop/entrypoint.sh'), setup = read('scripts/desktop-setup.sh'), docker = read('desktop/Dockerfile');
  assert.ok(update.includes('CINDY_FLAVOR:-global') && compose.includes('CINDY_FLAVOR: ${CINDY_FLAVOR:-global}') && setup.includes('REGION="${1:-}"') && setup.includes('  REGION=global'));
  assert.ok(!compose.includes('linux-x64-') && !docker.includes('releases/download/v'), '安装包地址不再写死');
  assert.ok(compose.includes('CINDY_VERSION: ${CINDY_VERSION:-latest}') && docker.includes('ARG CINDY_VERSION=latest') && docker.includes('pick-release.mjs 0 "$CINDY_FLAVOR" x64'));
  for (const s of ['write_status', 'status.json', 'restart_app', 'CINDY_RESTART_ON_UPDATE']) assert.ok(update.includes(s), s);
  assert.ok(entry.includes('status-server.mjs'));
  assert.ok(compose.includes('DESKTOP_STATUS_URL: http://desktop:8789') && compose.includes('DESKTOP_KEY_FILE'));
  assert.ok(setup.includes('CINDY_FLAVOR=${REGION}'));
  assert.ok(server.includes("/api/admin/desktop/update") && server.includes('validCsrf(req,viewer)'));
  for (const s of ['renderDesktopUpdate', '检查并更新', '怎么更新', '安装并切换到', '第 1 步（可选）：选择 Cindy 版本', '固定在这个版本', '/api/admin/desktop/versions']) assert.ok(team.includes(s), s);
});

test('选择 Cindy 版本：页面选国际版 / 国内版 → 服务器校验 → 容器里直接下载安装（不重建镜像）', () => {
  const update = read('desktop/update.sh'), server = read('server.mjs'), status = read('desktop/status-server.mjs');
  for (const s of ['switch)', 'CINDY_FORCE', '$ROOT/flavor', 'switch global|cn']) assert.ok(update.includes(s), s);
  assert.ok(status.includes("pathname === '/switch'") && status.includes("flavor !== 'global' && flavor !== 'cn'"));
  assert.ok(server.includes("target='/switch?flavor='+picked") && server.includes("body.flavor!=='global'&&body.flavor!=='cn'"));
});

test('命令行安装时也有安装 / 更新引导：install.sh 问装哪个 Cindy 版本，desktop-setup.sh 不带参数时询问并默认国际版', () => {
  const install = read('install.sh'), setup = read('scripts/desktop-setup.sh');
  for (const s of ['1) 国际版 Cindy（Global）', '2) 国内版 Cindy（CN）', '3) 暂不安装', 'YUMEIRO_DESKTOP', 'DESKTOP_REGION', './scripts/desktop-setup.sh "$DESKTOP_REGION"', '软件更新']) assert.ok(install.includes(s), s);
  for (const s of ['read -r -p "选择 [1/2]: "', 'REGION=global', '管理设置 → 桌面端 → 软件更新', 'CINDY_FLAVOR']) assert.ok(setup.includes(s), s);
});

test('版本可选、安装包不写死：已安装就更新，也能切换区域和版本号（含固定 / 回退）', async () => {
  const { listVersions, validVersion } = await import('../desktop/pick-release.mjs');
  const releases = [release, { ...release, tag_name: 'v0.1.135', published_at: '2026-10-30T00:00:00Z', assets: [{ name: 'cindy-0.1.135-linux-x64-cn.deb', browser_download_url: 'https://github.com/x/old-cn.deb' }] }, { ...release, draft: true }];
  const list = listVersions(releases);
  assert.deepEqual(list.map(v => v.version), ['0.1.136', '0.1.135']);
  assert.equal(list[0].global && list[0].cn, true); assert.equal(list[1].global, false); assert.equal(list[1].cn, true);
  assert.equal(validVersion('0.1.136'), true); assert.equal(validVersion('latest'), false); assert.equal(validVersion('0.1.136; rm'), false);

  const update = read('desktop/update.sh'), setup = read('scripts/desktop-setup.sh'), server = read('server.mjs'), status = read('desktop/status-server.mjs');
  for (const s of ['switch global|cn [latest|x.y.z]', '$ROOT/pin', 'CINDY_TARGET_VERSION', 'releases/tags', '已固定在版本']) assert.ok(update.includes(s) || update.includes(s.replace('releases/tags', '/tags/v')), s);
  assert.ok(status.includes("pathname === '/versions'") && status.includes('validVersion(version)') && status.includes("'switch', flavor, version"));
  assert.ok(server.includes("pathname==='/api/admin/desktop/versions'") && server.includes('版本号格式不对'));
  // 命令行：已装过默认是“更新”，也可以选“切换版本”；不再把安装包地址写进 .env
  for (const s of ['1) 更新到最新版', '2) 切换版本', 'desktop-update.sh check', 'desktop-update.sh switch "$REGION" "$VER"', "sed -i '/^CINDY_DEB_URL=/d;/^CINDY_DEB_SHA256=/d' .env"]) assert.ok(setup.includes(s), s);
});
