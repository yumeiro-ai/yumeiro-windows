#!/usr/bin/env node
// 服务器上的“最后手段”：恢复密钥和手机确认都用不了时，在服务器上直接重置管理员密码。
// 用法（先停掉 Yumeiro 服务，环境变量要和服务一致：DATA_DIR / STORE_ENCRYPTION_KEY_FILE / DATABASE_URL 等）：
//   node scripts/reset-admin.mjs --email admin@example.com --password-file /path/to/new-password.txt [--clear-recovery]
// 新密码至少 16 个字符；会让该账号所有已登录的会话立即失效，并写一条审计记录。
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStorage, readSecretKey } from '../storage.mjs';
import { addAudit } from '../audit.mjs';

const scrypt = promisify(scryptCallback);
const args = process.argv.slice(2), arg = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
const email = String(arg('email') || '').trim().toLowerCase(), passwordFile = arg('password-file');
if (!email || !passwordFile) { console.error('用法：node scripts/reset-admin.mjs --email 管理员邮箱 --password-file 新密码文件 [--clear-recovery]'); process.exit(1); }
const password = (await readFile(passwordFile, 'utf8')).replace(/[\r\n]+$/g, '');
if (password.length < 16) { console.error('新密码至少需要 16 个字符'); process.exit(1); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const storage = await openStorage({ key: await readSecretKey(), dataDir });
try {
  const db = storage.db, user = Object.values(db.users || {}).find(item => item.email === email && item.role === 'admin' && item.passwordHash);
  if (!user) { console.error('找不到这个管理员账号：' + email); process.exitCode = 1; }
  else {
    const salt = randomBytes(16);
    user.passwordHash = salt.toString('hex') + ':' + Buffer.from(await scrypt(password, salt, 64)).toString('hex');
    if (process.argv.includes('--clear-recovery')) delete user.recovery;
    for (const [key, value] of Object.entries(db.sessions || {})) if (value.userId === user.id) delete db.sessions[key];
    addAudit(db, { userId: user.id, action: 'admin_password_reset_cli', target: email, detail: '在服务器上用命令行重置' });
    await storage.save(db);
    console.log('已重置 ' + email + ' 的密码，并让它所有已登录的会话失效。现在可以重启服务并用新密码登录。');
  }
} finally { await storage.close(); }
