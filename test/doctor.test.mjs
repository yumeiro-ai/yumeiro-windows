import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChecks, summarize, reportText } from '../doctor.mjs';

const GB = 1024 ** 3;
const healthy = () => ({
  node: 'v24.14.0', platform: 'linux', arch: 'x64', uptimeSec: 90000, cpus: 4, load1: 0.4, memTotal: 8 * GB, memFree: 4 * GB, rss: 200 * 1048576,
  disk: { total: 100 * GB, free: 60 * GB }, writable: { ok: true }, port: 8787, storage: 'JSON 文件 x', hasStoreKey: true, https: true, forwardedSeen: true,
  local: false, trustProxy: true, cookieSecure: true, passwordFile: { configured: true, exists: false }, adminIpRestricted: false,
  providers: { enabled: 2, defaultModel: 'a/b', resolved: true, probes: null }, runner: { enabled: true, health: { ok: true, engines: { claude: { installed: true } } } },
  features: { voice: true, tts: false, vision: true, imagegen: false }, dns: [{ host: 'a', ok: true, ms: 20 }], clock: { driftMs: 800 },
  downloads: ['Yumeiro-Setup-0.4.0.exe'], wallpapers: 3, counts: { users: 2, conversations: 5, audit: 9 }
});
const level = (checks, title) => checks.find(c => c.title === title)?.level;

test('服务器体检：健康服务器没有注意/处理项', () => {
  const checks = buildChecks(healthy()), sum = summarize(checks);
  assert.equal(sum.warn + sum.fail, 0, JSON.stringify(checks.filter(c => c.level === 'warn' || c.level === 'fail')));
  assert.equal(sum.level, 'ok');
  assert.deepEqual([...new Set(checks.map(c => c.group))], ['系统', '存储与安全', '模型与服务', '网络', '客户端与内容']);
});

test('服务器体检：各类问题分别给出级别与建议', () => {
  const s = healthy();
  Object.assign(s, {
    node: 'v18.0.0', memFree: 0.2 * GB, disk: { total: 100 * GB, free: 0.3 * GB }, writable: { ok: false, error: 'EACCES' }, hasStoreKey: false, https: false,
    passwordFile: { configured: true, exists: true }, providers: { enabled: 0, defaultModel: '', resolved: false, probes: [{ name: 'p1', ok: false, error: 'ETIMEDOUT' }] },
    runner: { enabled: true, health: { ok: false, error: '无法连接运行器' } }, dns: [{ host: 'x', ok: false, error: 'ENOTFOUND' }], clock: { driftMs: 10 * 60000 }, downloads: []
  });
  const checks = buildChecks(s);
  assert.equal(level(checks, 'Node.js 版本'), 'fail'); assert.equal(level(checks, '内存'), 'fail'); assert.equal(level(checks, '数据盘空间'), 'fail');
  assert.equal(level(checks, '数据目录可写'), 'fail'); assert.equal(level(checks, '数据加密密钥'), 'fail'); assert.equal(level(checks, '当前连接'), 'warn');
  assert.equal(level(checks, '初始管理员密码'), 'warn'); assert.equal(level(checks, 'AI 接入'), 'fail'); assert.equal(level(checks, '服务商连通：p1'), 'fail');
  assert.equal(level(checks, '智能体运行器'), 'fail'); assert.equal(level(checks, 'DNS 解析：x'), 'fail'); assert.equal(level(checks, '服务器时间'), 'fail');
  assert.equal(level(checks, '客户端安装包'), 'info');
  assert.match(checks.find(c => c.title === '数据目录可写').detail, /EACCES/);
  assert.match(checks.find(c => c.title === '初始管理员密码').hint, /scrub-admin/);
  assert.equal(summarize(checks).level, 'fail');
});

test('服务器体检：反向代理配置不一致会提示；官方端点结果带入；报告可复制', () => {
  const s = healthy(); s.forwardedSeen = true; s.trustProxy = false;
  assert.equal(level(buildChecks(s), '反向代理与 IP 记录'), 'warn');
  s.forwardedSeen = false; s.trustProxy = true; s.local = false;
  assert.equal(level(buildChecks(s), '反向代理与 IP 记录'), 'warn', '直接暴露端口却信任 X-Forwarded-For');
  s.local = true; assert.equal(level(buildChecks(s), '反向代理与 IP 记录'), 'ok');
  const checks = buildChecks(s);
  assert.ok(!checks.some(c => c.title === '出口 IP' || /可达性/.test(c.title)), '体检里不再包含环境检测的内容');
  const result = { at: Date.now(), summary: summarize(checks), checks };
  const text = reportText(result, '测试站');
  assert.match(text, /测试站 服务器体检/); assert.doesNotMatch(text, /出口 IP|可达性/);
  assert.doesNotMatch(text, /建议：.*\n.*\[正常\]\s*$/);
});
