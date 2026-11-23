// 存储层：JSON 文件（默认/回退）与 PostgreSQL。两者都是 AES-256-GCM 静态加密，
// 应用层仍把全部数据放在内存里（单实例），存储层只负责加载与持久化。
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, copyFile, access } from 'node:fs/promises';
import path from 'node:path';

export const storeFormat = 'cindy-store-aes-256-gcm-v1';
const ADVISORY_LOCK_ID = 727274; // 防止两个应用实例同时写同一个库

// ---------- 配置 ----------
export async function readSecretKey(env = process.env) {
  const raw = env.STORE_ENCRYPTION_KEY_FILE
    ? (await readFile(env.STORE_ENCRYPTION_KEY_FILE, 'utf8')).trim()
    : (env.STORE_ENCRYPTION_KEY || '').trim();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== raw.replace(/=+$/, '')) {
    throw new Error('STORE_ENCRYPTION_KEY_FILE must contain a base64-encoded 32-byte key (or set STORE_ENCRYPTION_KEY).');
  }
  return key;
}

// STORAGE=json|postgres|auto（默认 auto：配置了 DATABASE_URL 或 PGHOST 就用 PostgreSQL）
export function storageMode(env = process.env) {
  const wanted = (env.STORAGE || 'auto').toLowerCase();
  if (!['json', 'postgres', 'auto'].includes(wanted)) throw new Error('STORAGE 只能是 json、postgres 或 auto');
  if (wanted === 'auto') return env.DATABASE_URL || env.PGHOST ? 'postgres' : 'json';
  return wanted;
}

export async function poolConfig(env = process.env) {
  const config = { max: Number(env.PG_POOL_MAX) || 5, connectionTimeoutMillis: Number(env.PG_CONNECT_TIMEOUT_MS) || 10000 };
  if (env.DATABASE_URL) config.connectionString = env.DATABASE_URL;
  if (env.PGPASSWORD_FILE) config.password = (await readFile(env.PGPASSWORD_FILE, 'utf8')).trim();
  const ssl = (env.PGSSLMODE || '').toLowerCase();
  if (ssl && ssl !== 'disable') config.ssl = { rejectUnauthorized: env.PG_SSL_REJECT_UNAUTHORIZED !== 'false' };
  return config;
}

// ---------- 数据模型 ↔ 行 ----------
const COLLECTIONS = { users: 'user', sessions: 'session', conversations: 'conversation', tokens: 'token', agents: 'agent', stats: 'stats', providers: 'provider', workspaces: 'workspace', runs: 'run', skills: 'skill', bots: 'bot', memories: 'memory', images: 'image', groups: 'group' };

// 把内存数据展开成 Map<"kind\u0000id", {kind,id,owner,json}>；usage 明细每条一行。
export function flatten(db) {
  const rows = new Map();
  const add = (kind, id, value) => rows.set(kind + '\u0000' + id, { kind, id, owner: value?.userId || value?.ownerId || null, json: JSON.stringify(value) });
  for (const [collection, kind] of Object.entries(COLLECTIONS)) {
    for (const [id, value] of Object.entries(db[collection] || {})) add(kind, id, value);
  }
  for (const item of db.usage || []) { item.id ||= randomUUID(); add('usage', item.id, item); }
  for (const item of db.audit || []) { item.id ||= randomUUID(); add('audit', item.id, item); }
  add('meta', 'security', db.security || {});
  add('meta', 'settings', db.settings || {});
  return rows;
}

export function assemble(rows) {
  const db = { users: {}, sessions: {}, conversations: {}, tokens: {}, agents: {}, providers: {}, workspaces: {}, runs: {}, skills: {}, bots: {}, memories: {}, images: {}, groups: {}, usage: [], audit: [], security: {}, settings: {} };
  const byKind = Object.fromEntries(Object.entries(COLLECTIONS).map(([collection, kind]) => [kind, collection]));
  for (const { kind, id, value } of rows) {
    if (byKind[kind]) {
      if (byKind[kind] === 'stats') db.stats ||= {};
      db[byKind[kind]][id] = value;
    } else if (kind === 'usage') db.usage.push(value);
    else if (kind === 'audit') db.audit.push(value);
    else if (kind === 'meta' && id === 'security') db.security = value;
    else if (kind === 'meta' && id === 'settings') db.settings = value;
  }
  db.usage.sort((a, b) => a.at - b.at);
  db.audit.sort((a, b) => a.at - b.at);
  return db;
}

// ---------- 加解密 ----------
function seal(key, aad, text) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
function open(key, aad, data) {
  const raw = Buffer.from(data, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// ---------- JSON 文件存储 ----------
export class JsonStorage {
  constructor({ dir, key, log = console.log }) {
    this.kind = 'json'; this.key = key; this.log = log;
    this.dir = dir; this.file = path.join(dir, 'store.json'); this.queue = Promise.resolve();
  }
  async exists() { try { await access(this.file); return true; } catch { return false; } }
  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved?.format === storeFormat && saved.version === 1) {
        const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(saved.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
        const db = JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
        return { db, fresh: false, legacyPlaintext: false };
      }
      if (typeof saved?.format === 'string' && saved.format.startsWith('cindy-store-')) throw new Error('Unsupported encrypted data format.');
      return { db: saved, fresh: false, legacyPlaintext: true };
    } catch (e) {
      if (e.code === 'ENOENT') return { db: { users: {}, sessions: {}, conversations: {} }, fresh: true, legacyPlaintext: false };
      throw e;
    }
  }
  save(db) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(db), 'utf8'), cipher.final()]);
    const contents = JSON.stringify({ format: storeFormat, version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') });
    const job = this.queue.then(async () => {
      const temp = this.file + '.tmp';
      await writeFile(temp, contents, { mode: 0o600 });
      // 保留上一版密文作为备份，写入中断或误操作时可手动恢复。
      await copyFile(this.file, this.file + '.bak').catch(() => {});
      await rename(temp, this.file);
    });
    this.queue = job.catch(error => this.log('数据写入失败：' + error.message));
    return job;
  }
  async close() { await this.queue; }
}

// ---------- PostgreSQL 存储 ----------
// 每个实体（用户、会话、对话、令牌……）一行，内容用 AES-256-GCM 加密（AAD 绑定 kind:id，行不能被互换）；
// 保存时只写与上次快照有差异的行，在一个事务里完成。
export class PgStorage {
  constructor({ pool, key, log = console.log }) {
    this.kind = 'postgres'; this.pool = pool; this.key = key; this.log = log;
    this.last = new Map(); this.queue = Promise.resolve(); this.lockClient = null;
  }
  async init() {
    try { await this.#init(); }
    catch (error) {
      // 失败时必须归还占用连接，否则 pool.end() 会一直等待。
      if (this.lockClient) { this.lockClient.release(); this.lockClient = null; }
      throw error;
    }
  }
  async #init() {
    // 独占咨询锁：同一个库同一时间只允许一个应用实例（数据缓存在进程内存里）。
    this.lockClient = await this.pool.connect();
    const lock = await this.lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [ADVISORY_LOCK_ID]);
    if (!lock.rows[0].ok) throw new Error('这个数据库已被另一个 Yumeiro实例占用。当前版本只支持单实例，请先停止另一个实例。');
    await this.pool.query(`CREATE TABLE IF NOT EXISTS cindy_entities(
      kind text NOT NULL, id text NOT NULL, owner text, data text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(kind,id))`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS cindy_entities_owner ON cindy_entities(kind,owner)');
    await this.pool.query('CREATE TABLE IF NOT EXISTS cindy_meta(key text PRIMARY KEY, value text NOT NULL)');
    // 用密钥校验行确认密钥正确：换错密钥会在这里明确失败，而不是读出一堆乱码。
    const canary = await this.pool.query("SELECT value FROM cindy_meta WHERE key='canary'");
    if (canary.rowCount) {
      try { if (open(this.key, 'meta:canary', canary.rows[0].value) !== 'cindy-ok') throw new Error('bad'); }
      catch { throw new Error('STORE_ENCRYPTION_KEY 与这个数据库里的数据不匹配（密钥错误或数据库来自别的部署）。'); }
    } else {
      await this.pool.query("INSERT INTO cindy_meta(key,value) VALUES('canary',$1)", [seal(this.key, 'meta:canary', 'cindy-ok')]);
    }
  }
  async isEmpty() { return (await this.pool.query('SELECT 1 FROM cindy_entities LIMIT 1')).rowCount === 0; }
  async load() {
    const result = await this.pool.query('SELECT kind,id,data FROM cindy_entities');
    const rows = result.rows.map(row => ({ kind: row.kind, id: row.id, value: JSON.parse(open(this.key, row.kind + ':' + row.id, row.data)) }));
    const db = assemble(rows);
    this.last = new Map([...flatten(db)].map(([k, v]) => [k, v.json]));
    return { db, fresh: rows.length === 0, legacyPlaintext: false };
  }
  async meta(key) { const r = await this.pool.query('SELECT value FROM cindy_meta WHERE key=$1', [key]); return r.rowCount ? r.rows[0].value : null; }
  async setMeta(key, value) { await this.pool.query('INSERT INTO cindy_meta(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, value]); }

  save(db) {
    const next = flatten(db); // 同步取快照，保证后续请求的修改不会混进这一次写入
    const job = this.queue.then(() => this.#write(next));
    this.queue = job.catch(error => this.log('PostgreSQL 写入失败（下次保存会自动补写）：' + error.message));
    return job;
  }
  async #write(next) {
    const upserts = [], deletes = [];
    for (const [k, row] of next) if (this.last.get(k) !== row.json) upserts.push(row);
    for (const k of this.last.keys()) if (!next.has(k)) { const [kind, id] = k.split('\u0000'); deletes.push({ kind, id }); }
    if (!upserts.length && !deletes.length) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < upserts.length; i += 300) {
        const part = upserts.slice(i, i + 300);
        await client.query(
          `INSERT INTO cindy_entities(kind,id,owner,data) SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[])
           ON CONFLICT (kind,id) DO UPDATE SET owner=EXCLUDED.owner, data=EXCLUDED.data, updated_at=now()`,
          [part.map(r => r.kind), part.map(r => r.id), part.map(r => r.owner), part.map(r => seal(this.key, r.kind + ':' + r.id, r.json))]);
      }
      for (let i = 0; i < deletes.length; i += 300) {
        const part = deletes.slice(i, i + 300);
        await client.query('DELETE FROM cindy_entities WHERE (kind,id) IN (SELECT * FROM unnest($1::text[],$2::text[]))', [part.map(r => r.kind), part.map(r => r.id)]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
    for (const row of upserts) this.last.set(row.kind + '\u0000' + row.id, row.json);
    for (const { kind, id } of deletes) this.last.delete(kind + '\u0000' + id);
  }
  // 一次性导入（JSON → PostgreSQL）：整体在一个事务里，失败不会留下半份数据。
  async importDb(db) {
    const rows = [...flatten(db).values()];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < rows.length; i += 300) {
        const part = rows.slice(i, i + 300);
        await client.query('INSERT INTO cindy_entities(kind,id,owner,data) SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[])',
          [part.map(r => r.kind), part.map(r => r.id), part.map(r => r.owner), part.map(r => seal(this.key, r.kind + ':' + r.id, r.json))]);
      }
      await client.query("INSERT INTO cindy_meta(key,value) VALUES('imported_at',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [new Date().toISOString()]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
    this.last = new Map(rows.map(r => [r.kind + '\u0000' + r.id, r.json]));
    return rows.length;
  }
  async close() {
    await this.queue;
    if (this.lockClient) { await this.lockClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => {}); this.lockClient.release(); this.lockClient = null; }
    await this.pool.end();
  }
}

// ---------- 入口 ----------
// 返回 {kind, db, fresh, legacyPlaintext, save(db), close(), describe}
export async function openStorage({ env = process.env, key, dataDir, log = console.log, createPool } = {}) {
  const json = new JsonStorage({ dir: dataDir, key, log });
  if (storageMode(env) === 'json') {
    const loaded = await json.load();
    return { kind: 'json', ...loaded, save: db => json.save(db), close: () => json.close(), describe: 'JSON 文件 ' + json.file };
  }
  const pool = createPool ? await createPool() : new (await import('pg')).default.Pool(await poolConfig(env));
  const pg = new PgStorage({ pool, key, log });
  try { await pg.init(); }
  catch (error) { await pool.end().catch(() => {}); throw new Error('无法使用 PostgreSQL：' + error.message + '\n如需临时改回 JSON 文件存储，请设置 STORAGE=json（确认 store.json 是最新的，见 README“回退”）。'); }

  let migrated = 0;
  if (await pg.isEmpty() && await json.exists()) {
    const { db } = await json.load();
    migrated = await pg.importDb(db);
    await copyFile(json.file, json.file + '.pre-postgres.bak').catch(() => {});
    log(`已把 JSON 存储迁移到 PostgreSQL（${migrated} 条记录）。原 store.json 保留不动，并备份为 store.json.pre-postgres.bak。`);
  }
  const loaded = await pg.load();
  const mirror = env.JSON_MIRROR !== 'false';
  if (mirror && !migrated && await json.exists()) await copyFile(json.file, json.file + '.pre-postgres.bak').catch(() => {});
  return {
    kind: 'postgres', ...loaded, migrated,
    save: async db => {
      await pg.save(db);
      // 镜像：同时写一份加密 JSON，作为随时可切回的回退。镜像失败只记日志，不影响主存储。
      if (mirror) json.save(db).catch(error => log('JSON 镜像写入失败：' + error.message));
    },
    close: async () => { await json.close(); await pg.close(); },
    describe: 'PostgreSQL' + (mirror ? '（并镜像到 JSON 文件作为回退）' : '（未开启 JSON 镜像）'),
    pg, json
  };
}
