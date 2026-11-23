import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, rm, utimes, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// 直装脚本里的“安装 / 升级后自动清理”：把 cleanup_after 这一段单独拿出来，在一棵临时目录树上跑，看删的和留的都对
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(path.join(root, 'deploy', 'yumeiro-native.sh'), 'utf8').replace(/\r\n/g, '\n');
const block = script.slice(script.indexOf('# >>> cleanup_after'), script.indexOf('# <<< cleanup_after'));
const px = p => String(p).split(String.fromCharCode(92)).join('/');   // Windows 上用 git-bash 跑时统一成 / 分隔，路径比较才和 Linux 一致
const exists = p => access(p).then(() => true, () => false);

async function world() {
  const base = await mkdtemp(path.join(tmpdir(), 'ym-clean-')), d = n => path.join(base, n);
  const dirs = { APP_DIR: d('app'), DATA_DIR: d('data'), WORK_DIR: d('work'), CONF_DIR: d('conf'), BACKUP_DIR: d('backup'), SRC: d('new/Yumeiro') };
  for (const p of [...Object.values(dirs), path.join(dirs.APP_DIR, 'node_modules/x'), path.join(dirs.SRC, 'deploy'), path.join(dirs.DATA_DIR, 'downloads')]) await mkdir(p, { recursive: true });
  for (const f of ['server.mjs', 'storage.mjs']) { await writeFile(path.join(dirs.APP_DIR, f), 'x'); await writeFile(path.join(dirs.SRC, f), 'x'); }
  await writeFile(path.join(dirs.APP_DIR, 'old-module.mjs'), 'old');                       // 新版本已经没有的旧模块
  await writeFile(path.join(dirs.SRC, 'package.json'), '{}'); await writeFile(path.join(dirs.SRC, 'deploy/yumeiro-native.sh'), '#');
  await writeFile(path.join(dirs.DATA_DIR, 'downloads/Yumeiro-Setup-1.exe'), 'exe'); await writeFile(path.join(dirs.DATA_DIR, 'store.json'), '{}');
  for (let i = 1; i <= 6; i++) { const f = path.join(dirs.BACKUP_DIR, `pre-update-2026010${i}-000000.tar.gz`); await writeFile(f, 'b'.repeat(1000)); const t = new Date(2026, 0, i); await utimes(f, t, t); }
  await writeFile(path.join(dirs.BACKUP_DIR, 'yumeiro-20260101-033000.tar.gz'), 'daily');   // 每日备份由别的逻辑管，这里不能动
  return { base, ...dirs };
}
function run(w, { env = {}, cwd, src } = {}) {
  const code = `say(){ printf '%s\\n' "$*"; }; ok(){ printf 'OK %s\\n' "$*"; }; warn(){ printf 'WARN %s\\n' "$*"; }
set -euo pipefail
APP_DIR='${px(w.APP_DIR)}'; DATA_DIR='${px(w.DATA_DIR)}'; WORK_DIR='${px(w.WORK_DIR)}'; CONF_DIR='${px(w.CONF_DIR)}'; BACKUP_DIR='${px(w.BACKUP_DIR)}'; SRC='${px(src || w.SRC)}'
NO_CLEAN=\${NO_CLEAN:-0}; CLEAN_NPM_CACHE=0
${block}
cleanup_after`;
  return spawnSync('bash', ['-c', code], { cwd: cwd || w.SRC, encoding: 'utf8', env: { ...process.env, HOME: px(path.join(w.base, 'home')), ...env } });
}

test('自动清理：旧的升级前备份只留 3 份，旧模块、解压目录被删，数据 / 配置 / node_modules / 客户端安装包 / 每日备份不动', async () => {
  const w = await world();
  const r = run(w); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual((await readdir(w.BACKUP_DIR)).filter(n => n.startsWith('pre-update')).sort(), ['pre-update-20260104-000000.tar.gz', 'pre-update-20260105-000000.tar.gz', 'pre-update-20260106-000000.tar.gz'], '留最近 3 份');
  assert.ok(await exists(path.join(w.BACKUP_DIR, 'yumeiro-20260101-033000.tar.gz')), '每日备份不动');
  assert.equal(await exists(path.join(w.APP_DIR, 'old-module.mjs')), false, '旧模块被删'); assert.ok(await exists(path.join(w.APP_DIR, 'server.mjs')) && await exists(path.join(w.APP_DIR, 'storage.mjs')));
  assert.ok(await exists(path.join(w.APP_DIR, 'node_modules/x')), 'node_modules 不动');
  assert.ok(await exists(path.join(w.DATA_DIR, 'store.json')) && await exists(path.join(w.DATA_DIR, 'downloads/Yumeiro-Setup-1.exe')), '数据和客户端安装包不动');
  assert.equal(await exists(w.SRC), false, '解压目录被删'); assert.equal(await exists(path.dirname(w.SRC)), false, '空的上层文件夹也删');
  assert.match(r.stdout, /解压目录：已删除/); assert.match(r.stdout, /清理完成/);
  await rm(w.base, { recursive: true, force: true });
});

test('自动清理的安全边界：--no-clean 什么都不做；SRC 就是安装目录、或里面装着数据目录时不删', async () => {
  let w = await world(); let r = run(w, { env: { NO_CLEAN: '1' } }); assert.equal(r.status, 0);
  assert.equal((await readdir(w.BACKUP_DIR)).filter(n => n.startsWith('pre-update')).length, 6); assert.ok(await exists(w.SRC) && await exists(path.join(w.APP_DIR, 'old-module.mjs'))); await rm(w.base, { recursive: true, force: true });

  w = await world(); await writeFile(path.join(w.APP_DIR, 'package.json'), '{}'); await mkdir(path.join(w.APP_DIR, 'deploy'), { recursive: true }); await writeFile(path.join(w.APP_DIR, 'deploy/yumeiro-native.sh'), '#');
  r = run(w, { src: w.APP_DIR, cwd: w.APP_DIR }); assert.equal(r.status, 0, r.stderr); assert.ok(await exists(w.APP_DIR) && await exists(path.join(w.APP_DIR, 'server.mjs')), '在安装目录里运行（SRC=APP_DIR）不能把自己删了'); await rm(w.base, { recursive: true, force: true });

  w = await world(); r = run(w, { cwd: w.base }); assert.equal(await exists(w.SRC), false, '从别的目录运行也一样会删解压目录'); await rm(w.base, { recursive: true, force: true });

  w = await world(); // 数据目录放进了解压目录里面：绝不能删
  const inside = path.join(w.SRC, 'var-lib'); await mkdir(inside, { recursive: true }); await writeFile(path.join(inside, 'store.json'), '{}');
  const code = `say(){ echo "$*"; }; ok(){ echo "OK $*"; }; warn(){ echo "WARN $*"; }; set -euo pipefail
APP_DIR='${px(w.APP_DIR)}'; DATA_DIR='${px(inside)}'; WORK_DIR='${px(w.WORK_DIR)}'; CONF_DIR='${px(w.CONF_DIR)}'; BACKUP_DIR='${px(w.BACKUP_DIR)}'; SRC='${px(w.SRC)}'; NO_CLEAN=0; CLEAN_NPM_CACHE=0
${block}
cleanup_after`;
  r = spawnSync('bash', ['-c', code], { cwd: w.base, encoding: 'utf8', env: { ...process.env, HOME: px(path.join(w.base, 'home')) } });
  assert.equal(r.status, 0, r.stderr); assert.ok(await exists(path.join(inside, 'store.json')), '数据目录在解压目录里面时不能删：' + r.stdout); assert.match(r.stdout, /没有自动删除/);
  await rm(w.base, { recursive: true, force: true });
});

test('升级（update）会给旧安装补上网页更新助手：令牌、环境变量、启动', () => {
  const update = script.slice(script.indexOf('\nupdate)'), script.indexOf('\nengines)'));
  assert.match(update, /setup_helper_token/); assert.match(update, /SETUP_HELPER_TOKEN_FILE=/); assert.match(update, /SETUP_HELPER_SOCKET=/);
  assert.match(update, /enable --now yumeiro-setup-helper/);
  // 网页更新是助手拉起来的：升级脚本里不能直接重启助手（会把自己杀掉，主服务停在已停止 → 502），只能升级成功后用 systemd-run 延迟重启
  assert.doesNotMatch(update.replace(/^\s*#.*$/gm, '').replace(/systemd-run[^\n]*/g, ''), /systemctl restart yumeiro-setup-helper/);
  assert.match(update, /systemd-run [^\n]*systemctl restart yumeiro-setup-helper/);
  assert.ok(update.indexOf('enable --now yumeiro-setup-helper') < update.indexOf('systemctl start yumeiro.service'), '要在启动主服务之前把环境变量备好');
});
