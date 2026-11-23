import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(root, file), 'utf8');

// server.mjs 直接或间接 import 的根目录 .mjs 模块（Docker 镜像和直装版都必须带上，否则一启动就报找不到模块）
function rootModules(entry = 'server.mjs', seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const m of read(entry).matchAll(/from\s+'\.\/([A-Za-z0-9_-]+\.mjs)'/g)) rootModules(m[1], seen);
  return seen;
}
const dockerList = () => new Set((/COPY --chown=node:node (server\.mjs[^\n]*) \.\/\n/.exec(read('Dockerfile')) || [, ''])[1].split(/\s+/).filter(Boolean));
const nativeList = () => new Set((/for item in ([^;]*); do/.exec(read('deploy/yumeiro-native.sh')) || [, ''])[1].split(/\s+/).filter(x => x.endsWith('.mjs')));

test('部署清单：Docker 与直装版复制的 .mjs 一致，且覆盖 server.mjs 依赖的全部根目录模块', () => {
  const needed = rootModules(), docker = dockerList(), native = nativeList();
  assert.ok(needed.size > 5, '应该解析出一批模块');
  for (const name of needed) {
    assert.ok(docker.has(name), 'Dockerfile 没有复制 ' + name);
    assert.ok(native.has(name), 'deploy/yumeiro-native.sh 没有复制 ' + name);
    assert.ok(existsSync(path.join(root, name)), name + ' 不存在');
  }
  assert.deepEqual([...docker].sort(), [...native].sort(), '两份清单应当完全一致');
});

test('部署：server.mjs 静态引用的子目录模块（setup/）Docker 镜像和直装版也都要带上，否则启动即退出、网页 502', () => {
  const dirs = [...new Set([...read('server.mjs').matchAll(/from\s+'\.\/([A-Za-z0-9_-]+)\/[A-Za-z0-9_.-]+\.mjs'/g)].map(m => m[1]))];
  assert.ok(dirs.includes('setup'), '应该解析出 setup 目录');
  for (const dir of dirs) {
    assert.match(read('Dockerfile'), new RegExp('^COPY --chown=node:node ' + dir + ' \./' + dir + '$', 'm'), 'Dockerfile 没有复制 ' + dir + '/');
    assert.ok(read('deploy/yumeiro-native.sh').includes('"$SRC"/' + dir + '/*.mjs'), 'deploy/yumeiro-native.sh 没有复制 ' + dir + '/');
  }
});

test('部署：安装包不进镜像也不随程序部署；壁纸首次启动自动初始化；备份不带安装包', () => {
  assert.match(read('.dockerignore'), /^public\/downloads$/m, '.dockerignore 要排除 public/downloads');
  assert.match(read('Dockerfile'), /CMD .*seed-wallpapers\.mjs.*exec node server\.mjs/, 'Docker 启动前要先初始化壁纸');
  const native = read('deploy/yumeiro-native.sh');
  assert.match(native, /rm -rf "\$APP_DIR\/public\/downloads"/, '直装版部署时不带 public/downloads');
  assert.match(native, /ExecStartPre=-\$node scripts\/seed-wallpapers\.mjs/);
  assert.match(native, /--exclude="\$DATA_DIR\/downloads"/, '每日备份不打包安装包');
  assert.ok(readdirSync(path.join(root, 'public', 'seed', 'wallpapers')).some(f => /\.(png|jpe?g|webp)$/i.test(f)), '内置壁纸应在 public/seed/wallpapers');
  assert.ok(existsSync(path.join(root, 'scripts', 'install-clients.mjs')));
});

test('网页：index.html 引用的每个脚本，在 server.mjs 的静态白名单里都有对应路由，文件也存在', () => {
  const html = read('public/index.html'), server = read('server.mjs');
  const scripts = [...html.matchAll(/<script src="(\/[A-Za-z0-9_.-]+\.js)"/g)].map(m => m[1]);
  assert.ok(scripts.length > 10);
  for (const src of scripts) {
    assert.ok(server.includes("'" + src + "':"), 'server.mjs 的静态白名单缺少 ' + src);
    assert.ok(existsSync(path.join(root, 'public', src.slice(1))), 'public' + src + ' 不存在');
  }
});

test('部署脚本：直装版与 Docker 版都有“上传客户端安装包”的命令、安装/升级后的提示或自动上传，并有说明文档', async () => {
  const native = read('deploy/yumeiro-native.sh'), docker = read('install.sh'), doc = read('客户端安装包上传说明.md');
  assert.match(native, /^clients\)/m, '直装版要有 clients 子命令');
  assert.match(native, /--clients\) CLIENTS_DIR=/, '直装版 install/update 支持 --clients');
  assert.match(native, /\$SRC\/Yumeiro-Clients/, '解压目录里有 Yumeiro-Clients 时自动上传');
  assert.ok((native.match(/maybe_upload_clients/g) || []).length >= 3, 'install 和 update 都要调用自动上传');
  assert.ok((native.match(/hint_clients/g) || []).length >= 3, 'install 和 update 结束时要给提示');
  assert.match(docker, /^upload_clients\(\)/m); assert.match(docker, /CMD=clients/); assert.match(docker, /--clients=\*\)/);
  assert.match(docker, /install-clients\.mjs/, 'Docker 版通过容器里的脚本上传');
  for (const needle of ['./install.sh clients', 'yumeiro-native.sh clients', 'SHA256', 'Yumeiro-Setup-', 'downloads']) assert.ok(doc.includes(needle), '文档缺少：' + needle);
  const { spawnSync } = await import('node:child_process');
  for (const file of ['deploy/yumeiro-native.sh', 'install.sh']) {
    const r = spawnSync('bash', ['-n', path.join(root, file)], { encoding: 'utf8' });
    if (r.error) return;                                           // 没有 bash（比如纯 Windows 环境）：跳过语法检查
    assert.equal(r.status, 0, file + ' 语法错误：' + r.stderr);
  }
});
