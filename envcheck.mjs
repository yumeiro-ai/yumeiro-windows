// 环境检测：只做“检测、提示”；所在地区不被官方支持时，如实告知“此处暂不可用”，并拒绝发出请求。
// 纯函数 + 可注入 fetch，便于测试。
export const TARGETS = [
  { id: 'anthropic-api', vendor: 'claude', label: 'Claude API', url: 'https://api.anthropic.com/' },
  { id: 'claude-web', vendor: 'claude', label: 'claude.ai', url: 'https://claude.ai/' },
  { id: 'openai-api', vendor: 'codex', label: 'OpenAI API', url: 'https://api.openai.com/v1/models' },
  { id: 'chatgpt-web', vendor: 'codex', label: 'ChatGPT / Codex', url: 'https://chatgpt.com/' },
  { id: 'gemini-api', vendor: 'gemini', label: 'Gemini API', url: 'https://generativelanguage.googleapis.com/' },
  { id: 'gemini-web', vendor: 'gemini', label: 'Gemini 网页', url: 'https://gemini.google.com/' },
  { id: 'deepseek-api', vendor: 'deepseek', label: 'DeepSeek API', url: 'https://api.deepseek.com/' },
  { id: 'deepseek-web', vendor: 'deepseek', label: 'DeepSeek 网页', url: 'https://chat.deepseek.com/' }
];
// 每家服务商的检测规则：
//   regions  出口所在地区要在官方“支持的国家和地区”里（受限地区清单对它生效）
//   rate     订阅账号型引擎（Claude Code / Codex）：按小时调用量和并发限频，并提示多人共用账号的风险
//   account  出口是数据中心 IP 时给出“订阅账号登录可能被风控”的提醒
//   proxy    发往它的请求可以走“出口代理”。DeepSeek 是国内服务，不走代理（直连探测才反映真实可达性）
export const VENDORS = {
  claude: { name: 'Claude', regions: true, rate: true, account: true, proxy: true },
  codex: { name: 'Codex / ChatGPT', regions: true, rate: true, account: true, proxy: true },
  gemini: { name: 'Gemini', regions: true, rate: false, account: false, proxy: true },
  deepseek: { name: 'DeepSeek', regions: false, rate: false, account: false, proxy: false }
};
export const VENDOR_NAMES = Object.fromEntries(Object.entries(VENDORS).map(([id, v]) => [id, v.name]));
export const VENDOR_HOSTS = {
  claude: ['anthropic.com', 'claude.ai', 'claude.com'], codex: ['openai.com', 'chatgpt.com'],
  gemini: ['generativelanguage.googleapis.com', 'gemini.google.com', 'aistudio.google.com'], deepseek: ['deepseek.com']
};
export const usesProxy = vendor => Boolean(vendor && VENDORS[vendor]?.proxy);
// 参考清单（以各家官方“支持的国家和地区”页面为准，管理员可在页面里修改）
export const DEFAULT_RESTRICTED = ['CN', 'HK', 'MO', 'RU', 'BY', 'IR', 'KP', 'SY', 'CU'];
export const DEFAULT_GUARD = { enabled: true, restricted: DEFAULT_RESTRICTED, hourlyLimit: 40, maxConcurrent: 3, proxyUrl: '', cleanipKey: '', cleanipEnabled: false };

export const vendorOfUrl = url => {
  let host = ''; try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  for (const [vendor, hosts] of Object.entries(VENDOR_HOSTS)) if (hosts.some(h => host === h || host.endsWith('.' + h))) return vendor;
  return null;
};
export const vendorOfEngine = engine => engine === 'claude' ? 'claude' : engine === 'codex' ? 'codex' : null;

export function normalizeGuard(input = {}) {
  const base = { ...DEFAULT_GUARD, ...input };
  const restricted = (Array.isArray(base.restricted) ? base.restricted : String(base.restricted || '').split(/[,\s，]+/))
    .map(code => String(code).trim().toUpperCase()).filter(code => /^[A-Z]{2}$/.test(code)).slice(0, 60);
  return {
    enabled: base.enabled !== false, restricted,
    hourlyLimit: Math.min(10000, Math.max(1, Math.floor(Number(base.hourlyLimit)) || DEFAULT_GUARD.hourlyLimit)),
    maxConcurrent: Math.min(50, Math.max(1, Math.floor(Number(base.maxConcurrent)) || DEFAULT_GUARD.maxConcurrent)),
    proxyUrl: validProxyUrl(base.proxyUrl) ? String(base.proxyUrl).trim() : '',
    cleanipKey: validCleanipKey(base.cleanipKey) ? String(base.cleanipKey).trim() : '',
    cleanipEnabled: [true, 'true', 1, '1'].includes(base.cleanipEnabled)
  };
}
// CleanIP（https://cleanip.io）的密钥以 cip_ 开头，在 cleanip.io/account 免费创建
export const validCleanipKey = value => /^cip_[A-Za-z0-9_-]{8,128}$/.test(String(value || '').trim());
export const maskCleanipKey = value => validCleanipKey(value) ? String(value).slice(0, 4) + '••••' + String(value).slice(-4) : '';
export function validProxyUrl(value) {
  if (!value) return false;
  try { const url = new URL(String(value).trim()); return url.protocol === 'http:' || url.protocol === 'https:'; } catch { return false; }
}
export const maskProxy = value => { try { const url = new URL(value); if (url.username || url.password) { url.username = '***'; url.password = ''; } return url.toString(); } catch { return ''; } };

export function parseTrace(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) { const i = line.indexOf('='); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { ip: out.ip || '', country: (out.loc || '').toUpperCase(), colo: out.colo || '' };
}

// 单个目标探测。任何 HTTP 响应都说明网络是通的；403/429 带拦截特征视为“被挑战/限流”。
export async function probeTarget(target, { fetchFn = fetch, timeoutMs = 8000 } = {}) {
  const started = Date.now();
  try {
    const response = await fetchFn(target.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0 (yumeiro-env-check)', Accept: '*/*' } });
    const ms = Date.now() - started, status = response.status;
    try { await response.body?.cancel(); } catch { /* 忽略 */ }
    const challenged = (status === 403 || status === 429) && (response.headers.get('cf-mitigated') === 'challenge' || /cloudflare/i.test(response.headers.get('server') || ''));
    return { id: target.id, vendor: target.vendor, label: target.label, reachable: true, status, ms, challenged: status === 429 || challenged, error: '' };
  } catch (error) {
    return { id: target.id, vendor: target.vendor, label: target.label, reachable: false, status: 0, ms: Date.now() - started, challenged: false, error: error?.cause?.code || error?.name === 'TimeoutError' ? (error?.cause?.code || '连接超时') : (error?.message || '失败') };
  }
}

export async function detectEgress({ fetchFn = fetch, timeoutMs = 6000, extended = true } = {}) {
  const result = { ip: '', country: '', colo: '', isp: '', hosting: null, proxy: null, error: '' };
  try {
    const response = await fetchFn('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(timeoutMs) });
    Object.assign(result, parseTrace(await response.text()));
  } catch (error) { result.error = error?.message || '无法获取出口信息'; }
  if (extended) try { // 补充运营商/是否数据中心（第三方免费接口 ip-api.com，会把服务器出口 IP 发给它；ENV_CHECK_EXTENDED=false 可关闭）
    const response = await fetchFn('http://ip-api.com/json/' + (result.ip || '') + '?fields=status,countryCode,isp,hosting,proxy', { signal: AbortSignal.timeout(timeoutMs) });
    const data = await response.json();
    if (data.status === 'success') { result.isp = data.isp || ''; result.hosting = Boolean(data.hosting); result.proxy = Boolean(data.proxy); if (!result.country) result.country = String(data.countryCode || '').toUpperCase(); }
  } catch { /* 忽略 */ }
  return result;
}

// ---- CleanIP：IP 纯净度（0–100，越高越干净，等级 A+ 到 F）、IP 类型、VPN / 代理 / 机房 / Tor 标记 ----
// CleanIP 只提供 MCP（Streamable HTTP）接口：POST https://cleanip.io/mcp，Authorization: Bearer cip_xxx，调用工具 check_ip。
// 免费账号每天 20 个不同 IP，同一个 IP 当天重复查不另算（服务端对同一出口 IP 还会缓存几小时）。没有密钥时只返回地区和 ASN。
const asArray = value => Array.isArray(value) ? value : value == null ? [] : [value];
const pickText = item => typeof item === 'string' ? item : item && typeof item === 'object' ? String(item.label || item.name || item.text || item.flag || item.key || item.reason || '') : '';
const num = value => { const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
// 容错解析：字段名以官方返回为准，这里同时接受几种常见写法，认不出的字段忽略（不会因此报错）
export function parseCleanIp(data) {
  const d = data && typeof data === 'object' ? data : {};
  const cip = d.cleanip && typeof d.cleanip === 'object' ? d.cleanip : {};
  const score = [d.cleanip_score, cip.score, d.score, d.clean_score].map(num).find(v => v !== null) ?? null;
  const grade = String(d.cleanip_grade ?? d.grade ?? cip.grade ?? '').trim();
  const typeRaw = d.ip_type ?? d.type ?? cip.ip_type ?? cip.type ?? d.network?.type;
  const type = pickText(typeRaw);
  const flagBox = [d, d.flags, d.risk, d.risks, d.risk_flags].filter(x => x && typeof x === 'object' && !Array.isArray(x));
  const truthy = (...names) => flagBox.some(box => names.some(name => box[name] === true));
  const flagList = [d.risk_flags, d.flags, d.risks, d.risk].flatMap(asArray).map(pickText).filter(Boolean);
  const hasFlag = re => flagList.some(text => re.test(text));
  const vpn = truthy('vpn', 'is_vpn') || hasFlag(/vpn/i);
  const proxy = truthy('proxy', 'is_proxy') || hasFlag(/proxy|代理/i);
  const tor = truthy('tor', 'is_tor') || hasFlag(/\btor\b/i);
  const hosting = truthy('hosting', 'is_hosting', 'datacenter', 'is_datacenter') || hasFlag(/hosting|datacenter|data center|idc|机房|数据中心/i) || /hosting|datacenter|机房|数据中心/i.test(type);
  const nativeRaw = d.native ?? d.is_native ?? cip.native;
  const scenarios = d.scenario_scores ?? d.scenarios ?? cip.scenarios;
  return {
    ok: true, keyless: score === null && !type && !flagList.length && !vpn && !proxy && !tor,
    score, grade, type, vpn, proxy, tor, hosting, native: typeof nativeRaw === 'boolean' ? nativeRaw : null,
    flags: [...new Set(flagList)].slice(0, 12),
    deductions: asArray(d.deductions ?? d.score_deductions ?? cip.deductions).map(pickText).filter(Boolean).slice(0, 8),
    scenarios: scenarios && typeof scenarios === 'object' && !Array.isArray(scenarios) ? Object.fromEntries(Object.entries(scenarios).map(([k, v]) => [k, num(v)]).filter(([, v]) => v !== null).slice(0, 8)) : null,
    country: String(d.location?.country_code || '').toUpperCase(), asn: d.network?.asn ?? null, asName: String(d.network?.as_name || ''), isp: String(d.network?.isp || ''),
    reportUrl: String(d.report_url || ''), error: ''
  };
}
export async function detectCleanIp({ ip, key, fetchFn = fetch, timeoutMs = 10000 } = {}) {
  const fail = error => ({ ok: false, score: null, grade: '', type: '', vpn: false, proxy: false, tor: false, hosting: false, native: null, flags: [], deductions: [], scenarios: null, country: '', asn: null, asName: '', isp: '', reportUrl: '', keyless: false, error });
  if (!ip) return fail('还没有拿到出口 IP');
  if (!validCleanipKey(key)) return fail('CleanIP 密钥格式不对（应以 cip_ 开头）');
  try {
    const response = await fetchFn('https://cleanip.io/mcp', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + String(key).trim() },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_ip', arguments: { ip } } })
    });
    if (response.status === 401 || response.status === 403) return fail('CleanIP 密钥无效或已被停用');
    if (response.status === 429) return fail('CleanIP 额度已用完（免费账号每天 20 个不同 IP）');
    if (!response.ok) return fail('CleanIP 返回 HTTP ' + response.status);
    let text = await response.text();
    if (/^\s*(event|data):/m.test(text)) text = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean).pop() || '';
    const rpc = JSON.parse(text);
    if (rpc.error) return fail('CleanIP：' + String(rpc.error.message || rpc.error.code || '出错').slice(0, 120));
    const result = rpc.result || {};
    let data = result.structuredContent;
    if (!data) { const raw = asArray(result.content).map(c => c?.text).find(Boolean); try { data = JSON.parse(raw); } catch { data = null; } }
    if (result.isError || !data) return fail('CleanIP：' + String(asArray(result.content).map(c => c?.text).find(Boolean) || '没有返回数据').slice(0, 120));
    const parsed = parseCleanIp(data);
    if (parsed.keyless) return { ...parsed, ok: false, error: 'CleanIP 没有返回纯净度数据（密钥可能未生效）' };
    return parsed;
  } catch (error) { return fail('无法连接 CleanIP：' + (error?.name === 'TimeoutError' ? '超时' : String(error?.cause?.code || error?.message || '').slice(0, 80))); }
}

const rank = { ok: 0, warn: 1, danger: 2 };
const worst = (a, b) => rank[b] > rank[a] ? b : a;

// 综合评估。input: {egress, probes, guard, usage:{claude:{lastHour,concurrent,users24h}, codex:{...}}, regionHistory:[country...]}
export function evaluate({ egress, probes, guard, usage = {}, regionHistory = [], cleanip = null }) {
  const ci = cleanip && cleanip.ok ? cleanip : null;
  const vendors = {};
  for (const vendor of Object.keys(VENDORS)) {
    const cfg = VENDORS[vendor], reasons = [], advice = []; let level = 'ok', block = false;
    const add = (lvl, reason, tip, blocking = false) => { level = worst(level, lvl); reasons.push({ level: lvl, text: reason }); if (tip) advice.push(tip); if (blocking) block = true; };
    const mine = probes.filter(p => p.vendor === vendor);
    const country = egress?.country || '';
    if (!cfg.regions) { /* 不受地区限制（如 DeepSeek） */ } else if (!country) add('warn', '无法确定出口所在地区', '检查服务器是否能访问 www.cloudflare.com；无法确认地区时请自行核对出口 IP。');
    else if (guard.restricted.includes(country)) add('danger', `服务器所在地区（${country}）暂不支持使用 ${VENDOR_NAMES[vendor]}`, `${VENDOR_NAMES[vendor]} 官方没有在该地区提供服务，因此这里暂时无法使用。受限地区清单仅供参考，以官方公布的“支持的国家和地区”为准。`, true);
    if (mine.length && mine.every(p => !p.reachable)) add('warn', `${VENDOR_NAMES[vendor]} 的所有端点都连不上（${mine[0].error || '超时'}）`, '先检查服务器网络、DNS 和防火墙；如果配置了出口代理，确认代理可用。');
    else for (const p of mine) {
      if (p.reachable && p.challenged) add('warn', `${p.label} 返回了验证/限流响应（HTTP ${p.status}）`, '对方暂时限制了访问，请降低调用频率，稍后再试。');
      else if (p.reachable && p.ms > 2500) add('warn', `${p.label} 延迟较高（${p.ms} ms）`, '延迟高会让长任务超时，可考虑更近的服务器节点。');
    }
    if (cfg.account && egress?.hosting === true) add('warn', `出口是数据中心/托管 IP（${egress.isp || '未知运营商'}）`, '使用 API Key 通常没问题；订阅账号登录在这类网络下，官方可能要求额外验证。');
    if (cfg.regions && egress?.proxy === true) add('warn', '出口被识别为代理/VPN', '部分服务商对这类网络会要求额外验证，仅供参考。');
    if (ci && (cfg.regions || cfg.account)) {
      if (ci.score !== null) {
        const label = `CleanIP 纯净度 ${ci.score}${ci.grade ? '（' + ci.grade + '）' : ''}${ci.type ? ' · ' + ci.type : ''}`;
        if (ci.score < 40) add('danger', label + '，很低', '这个出口 IP 的信誉较低，官方服务可能要求额外验证或限流。这条只提示，不会单独拦截请求。');
        else if (ci.score < 60) add('warn', label + '，偏低', '出口 IP 信誉偏低，官方服务可能要求额外验证或限流。');
        else if (ci.score < 80 && cfg.account) add('warn', label + '，一般', '订阅账号登录时官方偶尔会要求额外验证，仅供参考。');
        else reasons.push({ level: 'ok', text: label });
      }
      if ((ci.tor || ci.vpn || ci.proxy) && egress?.proxy !== true) add('warn', 'CleanIP 把出口标记为 ' + [ci.tor && 'Tor', ci.vpn && 'VPN', ci.proxy && '代理'].filter(Boolean).join(' / '), '部分服务商对这类网络会要求额外验证，仅供参考。');
      if (cfg.account && ci.hosting && egress?.hosting !== true) add('warn', 'CleanIP 把出口识别为数据中心/托管 IP' + (ci.asName ? '（' + ci.asName + '）' : ''), '使用 API Key 通常没问题；订阅账号登录在这类网络下，官方可能要求额外验证。');
      if (cfg.regions && ci.country && country && ci.country !== country) add('warn', `多个来源对出口地区的判断不一致（Cloudflare：${country}；CleanIP：${ci.country}）`, 'IP 库可能有延迟，请以官方“支持的国家和地区”为准人工核对。');
    }
    const distinct = new Set(regionHistory.filter(Boolean));
    if (cfg.regions && distinct.size >= 3) add('warn', `过去 24 小时出口地区变化了 ${distinct.size} 个（${[...distinct].join('、')}）`, '出口地区近期有变化，仅供参考。');
    const u = usage[vendor] || {};
    if (cfg.rate && u.users24h >= 2) add('warn', `过去 24 小时有 ${u.users24h} 个账号通过本站使用 ${VENDOR_NAMES[vendor]} 引擎`, '多人共用同一个个人订阅账号通常不符合服务条款。建议每人使用自己的账号，团队使用请改用官方 API Key。');
    const limit = guard.hourlyLimit;
    if (!cfg.rate) { /* 只有订阅账号型引擎才按小时限频 */ } else if (u.lastHour >= limit) add('danger', `最近 1 小时已调用 ${u.lastHour} 次，达到上限 ${limit}`, '短时间大量调用容易触发官方限流。已暂时拒绝新请求，调用量回落后自动恢复；也可在“环境检测”里调高上限。', true);
    else if (u.lastHour >= limit * 0.7) add('warn', `最近 1 小时已调用 ${u.lastHour} 次，接近上限 ${limit}`, '放慢节奏，或把批量任务错开。');
    if (cfg.rate && u.concurrent >= guard.maxConcurrent) add('warn', `当前并发 ${u.concurrent}，已达并发上限 ${guard.maxConcurrent}`, '并发过高容易触发限流，超出的请求会排队/被拒绝。');
    if (level === 'ok') reasons.push({ level: 'ok', text: '未发现风险信号' });
    vendors[vendor] = { name: VENDOR_NAMES[vendor], engine: cfg.rate, level, block: guard.enabled && block, reasons, advice: [...new Set(advice)], probes: mine };
  }
  const level = Object.values(vendors).reduce((acc, v) => worst(acc, v.level), 'ok');
  const verdict = judge({ egress, probes, guard, usage, regionHistory, cleanip: ci, vendorsLevel: level });
  return { at: Date.now(), level, egress, vendors, cleanip: cleanip ? { ...cleanip } : null, verdict };
}

// ---- 系统综合研判：把多个来源的信号合成一个 0–100 的分数和一份可解释的依据 ----
// 来源：Cloudflare（出口 IP、地区）、ip-api（运营商、机房/代理）、CleanIP（纯净度、类型、标记）、连通性探测、用量与出口地区变化。
// 做法：先按本地信号从 100 分扣分；有 CleanIP 时与它的纯净度各占一半；多个来源互相矛盾（如地区不一致）再扣分。
// 它只给出判断和理由，真正“拒绝请求”仍只由受限地区、调用频率、并发这三条硬规则决定。
export function judge({ egress, probes = [], guard, usage = {}, regionHistory = [], cleanip = null, vendorsLevel = 'ok' }) {
  const factors = []; let local = 100;
  const hit = (source, text, delta) => { local += delta; factors.push({ source, text, delta }); };
  const country = egress?.country || '';
  if (!country) hit('Cloudflare', '无法确定出口所在地区', -10);
  else if (guard.restricted.includes(country)) hit('Cloudflare', `出口在受限地区 ${country}`, -50);
  const hosting = egress?.hosting === true || cleanip?.hosting === true, anonymous = egress?.proxy === true || cleanip?.vpn === true || cleanip?.proxy === true || cleanip?.tor === true;
  if (hosting) hit(egress?.hosting === true ? 'ip-api' : 'CleanIP', '出口是数据中心 / 托管 IP', -8);
  if (anonymous) hit(egress?.proxy === true ? 'ip-api' : 'CleanIP', '出口被识别为代理 / VPN / Tor', -15);
  const guarded = probes.filter(p => VENDORS[p.vendor]?.regions);
  const down = [...new Set(guarded.filter(p => !p.reachable).map(p => p.vendor))];
  if (down.length) hit('连通性探测', `${down.map(v => VENDOR_NAMES[v]).join('、')} 的端点连不上`, -Math.min(25, 10 * down.length));
  const challenged = guarded.filter(p => p.reachable && p.challenged);
  if (challenged.length) hit('连通性探测', `${challenged.length} 个端点返回风控挑战 / 限流`, -Math.min(20, 8 * challenged.length));
  const regions = new Set(regionHistory.filter(Boolean));
  if (regions.size >= 3) hit('出口地区记录', `24 小时内出口地区变了 ${regions.size} 个`, -10);
  const shared = Object.entries(VENDORS).some(([id, cfg]) => cfg.rate && (usage[id]?.users24h || 0) >= 2);
  if (shared) hit('用量统计', '多个账号共用同一引擎', -10);
  if (cleanip?.country && country && cleanip.country !== country) hit('多源对比', `Cloudflare 与 CleanIP 对出口地区的判断不一致（${country} / ${cleanip.country}）`, -10);
  local = Math.max(0, Math.min(100, local));
  let score = local;
  const sources = ['Cloudflare', ...(egress?.isp || egress?.hosting != null ? ['ip-api'] : []), '连通性探测', '用量统计'];
  if (cleanip && cleanip.score !== null) {
    score = Math.round(local * 0.5 + cleanip.score * 0.5);
    factors.unshift({ source: 'CleanIP', text: `IP 纯净度 ${cleanip.score}${cleanip.grade ? '（' + cleanip.grade + '）' : ''}，与本地信号各占一半`, delta: null });
    sources.splice(1, 0, 'CleanIP');
  }
  const scoreLevel = score >= 75 ? 'ok' : score >= 50 ? 'warn' : 'danger';
  const level = rank[vendorsLevel] > rank[scoreLevel] ? vendorsLevel : scoreLevel;
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'F';
  const summary = level === 'ok' ? '出口环境良好，未发现明显风险' : level === 'warn' ? '出口环境存在需要关注的风险信号' : '出口环境风险较高，建议先处理再使用官方服务';
  return { score, localScore: local, grade, level, summary, sources, factors };
}
