import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('0.2 数据（没有 stats）启动时从用量明细生成月度统计', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cindy-migrate-'));
  const key = randomBytes(32), now = Date.now();
  const old = {
    users: { u1: { id: 'u1', email: 'owner@example.com', role: 'admin', authType: 'local', passwordHash: 'x:y', createdAt: now } },
    sessions: {}, conversations: {},
    usage: [
      { userId: 'u1', at: now, model: 'm', inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      { userId: 'u1', at: now, model: 'm', inputTokens: null, outputTokens: null, totalTokens: null }
    ]
  };
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(old), 'utf8'), cipher.final()]);
  await writeFile(path.join(dir, 'store.json'), JSON.stringify({ format: 'cindy-store-aes-256-gcm-v1', version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root, stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, PORT: String(41000 + Math.floor(Math.random() * 2000)), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', STORE_ENCRYPTION_KEY: key.toString('base64') }
  });
  try {
    await new Promise((resolve, reject) => {
      child.on('exit', code => reject(new Error('exit ' + code)));
      child.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); });
    });
    const saved = JSON.parse(await readFile(path.join(dir, 'store.json'), 'utf8'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(saved.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
    const db = JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    const d = new Date(now), month = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const stat = db.stats.u1.months[month];
    assert.equal(stat.calls, 2);
    assert.equal(stat.totalTokens, 5);
    assert.equal(stat.unreportedCalls, 1);
  } finally {
    child.removeAllListeners('exit'); child.kill();
    await new Promise(r => setTimeout(r, 200));
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
