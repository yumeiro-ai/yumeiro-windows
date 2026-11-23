// 演示模式（DEMO_MODE=1）：登录页显示演示账号；自动建一个“成员”演示账号；管理员可以在网页里从 GitHub 更新。
// 演示站跑在 CloudBase 云函数里：只有 /tmp 可写、没有 root 更新助手，所以更新由本文件在进程内完成——
// 验签 → 解压到 /tmp/yumeiro-app → 退出，由 scf_bootstrap 的循环用新代码重新启动。实例被回收后会回到打包时的版本。
import { readFile, mkdir, rm, symlink, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { verifySignedUpdateZip, extractUpdateZip, sha256OfFile, sameHash, compareVersions } from './updatepkg.mjs';

export const demoMode = () => process.env.DEMO_MODE === '1';
const text = (value, fallback) => String(value || fallback || '').trim();

// 演示账号是公开的（显示在登录页上），只用于体验；不要给它们配置真实的密钥
export function demoAccounts() {
  return {
    admin: { label: '管理员', email: text(process.env.ADMIN_EMAIL, 'admin@demo.local').toLowerCase(), password: text(process.env.ADMIN_PASSWORD, 'Yumeiro-Demo-Admin-2026') },
    member: { label: '成员', email: text(process.env.DEMO_MEMBER_EMAIL, 'member@demo.local').toLowerCase(), password: text(process.env.DEMO_MEMBER_PASSWORD, 'Yumeiro-Demo-Member-2026') }
  };
}

// 保证成员演示账号存在。返回 true 表示改动了数据库
export async function ensureDemoMember(db, hashPassword, randomUUID) {
  const { member } = demoAccounts();
  if (Object.values(db.users).some(user => user.email === member.email)) return false;
  const id = randomUUID();
  db.users[id] = { id, email: member.email, passwordHash: await hashPassword(member.password), role: 'member', authType: 'local', createdAt: Date.now() };
  return true;
}

export function createDemoUpdater({ root, modulesDir, appDir, dataDir, version, exit = () => setTimeout(() => process.exit(0), 1500) }) {
  const uploadDir = path.join(dataDir, 'updates');
  let status = { state: 'idle' };
  const currentVersion = async () => version;
  const bad = message => Object.assign(new Error(message), { expose: true });

  async function perform(zip, info) {
    const work = appDir + '.next';
    await rm(work, { recursive: true, force: true }); await mkdir(work, { recursive: true });
    const { dir } = await extractUpdateZip(zip, work, info.root); await rm(zip, { force: true });
    // 新版本必须自带演示模式，否则装上去登录页账号和网页更新就没了；这种包不装，保持当前版本
    if (!await access(path.join(dir, 'demo.mjs')).then(() => true, () => false)) throw new Error('这个版本的安装包不含演示模式（demo.mjs），为避免演示站失效没有安装');
    // 依赖沿用打包时的 node_modules（演示站不能联网安装依赖）；新版本改了依赖就拒绝，避免起不来
    const oldPkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')), newPkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    if (JSON.stringify(oldPkg.dependencies || {}) !== JSON.stringify(newPkg.dependencies || {})) throw new Error('新版本更换了依赖包，演示站无法在线安装；请重新打包发布演示站');
    await symlink(modulesDir, path.join(dir, 'node_modules'), 'dir');
    await rm(appDir, { recursive: true, force: true });
    await rename(dir, appDir);
    await rm(work, { recursive: true, force: true });
  }

  async function handle(body) {
    const { action, options = {} } = body;
    if (action === 'update_status') return { message: 'ok', details: status };
    if (action !== 'apply_update') throw bad('不支持的操作');
    const u = options.update || {};
    if (!/^incoming-[0-9a-f-]{36}\.zip$/.test(String(u.file || '')) || !/^[0-9a-f]{64}$/.test(String(u.sha256 || ''))) throw bad('更新请求无效');
    if (status.state === 'running') throw bad('已有更新在进行');
    const zip = path.join(uploadDir, u.file);
    if (!sameHash(await sha256OfFile(zip).catch(() => ''), u.sha256)) throw bad('文件在上传后被改动过，已拒绝');
    let info; try { info = await verifySignedUpdateZip(zip); } catch (error) { throw bad(error.message); }
    if (info.withClients) throw bad('演示站只能安装服务端安装包（Yumeiro-x.y.z.zip），请不要选含客户端的包');
    const from = await currentVersion();
    // 降级 / 重装只是演示：不真的换代码、不重启，当前版本保持不变；只有更新的版本才会真正安装
    if (compareVersions(info.version, from) <= 0) {
      await rm(zip, { force: true });
      status = { state: 'ok', from, version: from, finishedAt: Date.now(), log: '演示站不会真的降级：已模拟「' + from + ' → ' + info.version + '」，实际仍是 ' + from + '。' };
      return { message: '已模拟降级', details: { version: from, from, simulated: true } };
    }
    status = { state: 'running', from, version: info.version, startedAt: Date.now() };
    perform(zip, info).then(() => {
      status = { state: 'ok', from, version: info.version, finishedAt: Date.now(), log: '已安装 ' + info.version + '，演示站正在重启（约几秒）。实例被云函数回收后会回到打包时的版本。' };
      exit();
    }).catch(error => { status = { state: 'failed', from, version: info.version, finishedAt: Date.now(), log: '出错：' + error.message }; });
    return { message: '更新已开始', details: { version: info.version, from } };
  }
  return { handle };
}
