#!/usr/bin/env node
// 数据库维护命令（需先停止应用：它会占用数据库的单实例锁）。
//   node scripts/db.mjs status              查看当前存储配置与数据量
//   node scripts/db.mjs migrate [--force]   JSON → PostgreSQL（库非空时需要 --force，会先清空库）
//   node scripts/db.mjs export-json [--force]  PostgreSQL → store.json（已有 store.json 时需要 --force，会先备份）
// 读取与服务端相同的环境变量（DATABASE_URL / PG*、STORE_ENCRYPTION_KEY_FILE、DATA_DIR）。
import path from 'node:path';
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JsonStorage, PgStorage, poolConfig, readSecretKey, storageMode } from '../storage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const [command = 'status', ...flags] = process.argv.slice(2);
const force = flags.includes('--force');
const log = message => console.log(message);

async function openPg(key) {
  if (storageMode() !== 'postgres' && !process.env.DATABASE_URL && !process.env.PGHOST) throw new Error('未配置 PostgreSQL：请设置 DATABASE_URL（或 PGHOST 等）。');
  const { default: pg } = await import('pg');
  const store = new PgStorage({ pool: new pg.Pool(await poolConfig()), key, log });
  await store.init();
  return store;
}
const countOf = db => ({ users: Object.keys(db.users || {}).length, conversations: Object.keys(db.conversations || {}).length, agents: Object.keys(db.agents || {}).length, tokens: Object.keys(db.tokens || {}).length, usage: (db.usage || []).length });

async function main() {
  const key = await readSecretKey();
  const json = new JsonStorage({ dir: dataDir, key, log });
  if (command === 'status') {
    log('配置的存储：' + storageMode());
    const hasJson = await json.exists();
    log('JSON 文件：' + json.file + (hasJson ? '（存在）' : '（不存在）'));
    if (hasJson) log('  数据量：' + JSON.stringify(countOf((await json.load()).db)));
    if (process.env.DATABASE_URL || process.env.PGHOST) {
      const store = await openPg(key);
      try {
        const { db } = await store.load();
        log('PostgreSQL：已连接');
        log('  数据量：' + JSON.stringify(countOf(db)));
        log('  迁移时间：' + ((await store.meta('imported_at')) || '（没有从 JSON 迁移过）'));
      } finally { await store.close(); }
    }
    return;
  }
  if (command === 'migrate') {
    if (!(await json.exists())) throw new Error('没有找到 ' + json.file + '，无需迁移。');
    const store = await openPg(key);
    try {
      if (!(await store.isEmpty())) {
        if (!force) throw new Error('PostgreSQL 里已经有数据。确认要用 JSON 覆盖它请加 --force（会先清空数据库中的 Yumeiro数据）。');
        await store.pool.query('DELETE FROM cindy_entities');
      }
      const { db } = await json.load();
      log(`已导入 ${await store.importDb(db)} 条记录。数据量：${JSON.stringify(countOf(db))}`);
      await copyFile(json.file, json.file + '.pre-postgres.bak');
      log('原 store.json 保持不动，并备份为 store.json.pre-postgres.bak。');
    } finally { await store.close(); }
    return;
  }
  if (command === 'export-json') {
    const store = await openPg(key);
    try {
      if (await json.exists()) {
        if (!force) throw new Error(json.file + ' 已存在。确认要用 PostgreSQL 的数据覆盖它请加 --force（会先备份为 .before-export.bak）。');
        await copyFile(json.file, json.file + '.before-export.bak');
      }
      const { db } = await store.load();
      await json.save(db);
      await json.close();
      log('已导出到 ' + json.file + '。数据量：' + JSON.stringify(countOf(db)) + '\n回退方法：设置 STORAGE=json 后重启应用。');
    } finally { await store.close(); }
    return;
  }
  throw new Error('未知命令：' + command + '（可用：status | migrate | export-json）');
}
main().catch(error => { console.error('失败：' + error.message); process.exit(1); });
