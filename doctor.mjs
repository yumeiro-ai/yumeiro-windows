// 服务器体检：把“采集到的现状快照”变成逐项检查结果（纯函数，便于测试）。
// level：ok 正常 / warn 注意 / fail 需要处理 / info 仅供参考
const GB = 1024 ** 3, MB = 1024 ** 2;
const fmtBytes = n => n >= GB ? (n / GB).toFixed(1) + ' GB' : (n / MB).toFixed(0) + ' MB';
const fmtDur = sec => { const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60); return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : `${m} 分钟`; };

export function buildChecks(s) {
  const out = [];
  const add = (group, title, level, detail, hint = '') => out.push({ group, title, level, detail, hint });

  // ---- 系统与运行环境 ----
  const major = Number(String(s.node || '').replace(/^v/, '').split('.')[0]) || 0;
  add('系统', 'Node.js 版本', major >= 22 ? 'ok' : major >= 20 ? 'warn' : 'fail', `${s.node}（${s.platform}/${s.arch}）`, major >= 22 ? '' : '建议使用 Node.js 22 或更高版本。');
  add('系统', '已运行时长', 'info', fmtDur(s.uptimeSec || 0));
  if (s.memTotal) {
    const free = s.memFree / s.memTotal, lvl = free < 0.05 ? 'fail' : free < 0.12 ? 'warn' : 'ok';
    add('系统', '内存', lvl, `可用 ${fmtBytes(s.memFree)} / 共 ${fmtBytes(s.memTotal)}；本服务占用 ${fmtBytes(s.rss || 0)}`, lvl === 'ok' ? '' : '可用内存偏低，运行器和多个智能体同时工作时可能被系统杀掉。考虑加内存或开启 swap。');
  }
  if (s.cpus) {
    const per = (s.load1 || 0) / s.cpus, lvl = per > 1.5 ? 'fail' : per > 0.9 ? 'warn' : 'ok';
    add('系统', 'CPU 负载', s.load1 ? lvl : 'info', `${s.cpus} 核；1 分钟平均负载 ${(s.load1 || 0).toFixed(2)}${s.load1 ? '' : '（Windows 不提供）'}`, lvl === 'ok' || !s.load1 ? '' : '负载偏高，响应可能变慢。');
  }
  if (s.disk) {
    const ratio = s.disk.free / s.disk.total, lvl = s.disk.free < 500 * MB || ratio < 0.03 ? 'fail' : s.disk.free < 2 * GB || ratio < 0.1 ? 'warn' : 'ok';
    add('系统', '数据盘空间', lvl, `剩余 ${fmtBytes(s.disk.free)} / 共 ${fmtBytes(s.disk.total)}`, lvl === 'ok' ? '' : '数据盘快满了：数据库、备份、上传文件和安装包都在这里。请清理或扩容。');
  } else add('系统', '数据盘空间', 'info', '当前系统无法读取磁盘信息');
  add('系统', '数据目录可写', s.writable?.ok ? 'ok' : 'fail', s.writable?.ok ? '写入、删除测试文件成功' : '写入失败：' + (s.writable?.error || '未知错误'), s.writable?.ok ? '' : '检查数据目录权限（Docker 版检查卷挂载，直装版检查 yumeiro 用户的目录权限）。');
  add('系统', '监听端口', 'info', `${s.port}`);

  // ---- 存储与安全 ----
  add('存储与安全', '数据存储', 'info', s.storage || '未知');
  add('存储与安全', '数据加密密钥', s.hasStoreKey ? 'ok' : 'fail', s.hasStoreKey ? '已配置 STORE_ENCRYPTION_KEY' : '没有配置 STORE_ENCRYPTION_KEY', s.hasStoreKey ? '请确认已经另外备份这个密钥，丢失后数据无法解密。' : '');
  add('存储与安全', '当前连接', s.https ? 'ok' : 'warn', s.https ? '通过 HTTPS 访问' : '通过 HTTP 访问（账号密码和对话内容不加密）', s.https ? '' : '公网使用请放到 HTTPS 反向代理后面（直装版安装时加 --domain，Docker 版用 install.sh 的域名模式）。仅局域网或本机使用可忽略。');
  if (s.forwardedSeen && !s.trustProxy) add('存储与安全', '反向代理与 IP 记录', 'warn', '检测到反向代理头，但 TRUST_PROXY=false', '审计日志和登录限流记录的会是代理地址。有反向代理时请取消 TRUST_PROXY=false。');
  else if (!s.forwardedSeen && s.trustProxy && !s.local) add('存储与安全', '反向代理与 IP 记录', 'warn', '没有检测到反向代理，但 TRUST_PROXY 未关闭', '直接暴露端口时，访问者可以伪造 X-Forwarded-For 绕过限流和 IP 白名单。直连请设置 TRUST_PROXY=false。');
  else add('存储与安全', '反向代理与 IP 记录', 'ok', s.forwardedSeen ? '反向代理头正常，按代理传来的真实 IP 记录' : '本机直连');
  if (s.https && !s.cookieSecure) add('存储与安全', 'Cookie 安全标记', 'warn', 'HTTPS 访问但 COOKIE_SECURE=false', '建议开启 Secure Cookie。');
  else add('存储与安全', 'Cookie 安全标记', 'ok', s.cookieSecure ? 'Secure Cookie 已开启' : 'HTTP 环境，Secure Cookie 关闭');
  if (s.passwordFile?.configured) add('存储与安全', '初始管理员密码', s.passwordFile.exists ? 'warn' : 'ok', s.passwordFile.exists ? '初始密码文件还在磁盘上' : '初始密码文件已清理', s.passwordFile.exists ? '登录并修改密码后，运行 scrub-admin 删除它（Docker：bash install.sh scrub-admin；直装：sudo bash deploy/yumeiro-native.sh scrub-admin）。' : '');
  add('存储与安全', '主账号 IP 限制', s.adminIpRestricted ? 'ok' : 'info', s.adminIpRestricted ? '已限制主账号登录来源' : '未限制（可在“账号安全”里设置主账号登录 IP 白名单）');

  // ---- 模型与服务 ----
  const p = s.providers || {};
  add('模型与服务', 'AI 接入', p.enabled ? 'ok' : 'fail', p.enabled ? `已启用 ${p.enabled} 个服务商` : '还没有启用任何服务商', p.enabled ? '' : '到“AI 接入”添加至少一个服务商，聊天才能使用。');
  add('模型与服务', '默认模型', p.resolved ? 'ok' : p.enabled ? 'warn' : 'info', p.defaultModel ? (p.resolved ? p.defaultModel : p.defaultModel + '（无法解析）') : '未设置', p.resolved || !p.enabled ? '' : '到“站点设置”重新选择默认模型。');
  for (const probe of p.probes || []) add('模型与服务', `服务商连通：${probe.name}`, probe.ok ? (probe.ms > 3000 ? 'warn' : 'ok') : 'fail', probe.ok ? `${probe.ms} ms` : '连不上：' + probe.error, probe.ok ? (probe.ms > 3000 ? '延迟较高，长任务可能超时。' : '') : '检查服务商地址、服务器网络、DNS 和防火墙。');
  if (!p.probes) add('模型与服务', '服务商连通', 'info', '未做（勾选“深度检测”后会逐个测试服务商地址）');
  if (s.runner?.enabled) {
    const h = s.runner.health, engines = h?.engines ? Object.entries(h.engines).filter(([, v]) => v?.installed).map(([k]) => k) : [];
    add('模型与服务', '智能体运行器', h?.ok ? 'ok' : 'fail', h?.ok ? `正常；已安装引擎：${engines.join('、') || '无'}` : (h?.error || '无法连接运行器'), h?.ok ? (engines.length ? '' : '运行器正常但没有安装任何引擎（Claude Code / Codex / Pi）。') : '检查运行器进程是否启动、RUNNER_URL 和 RUNNER_TOKEN 是否一致。');
  } else add('模型与服务', '智能体运行器', 'info', '未启用（工作区、智能体引擎不可用）', '需要时：直装版安装时加 --with-runner；Docker 版见部署说明。');
  const feats = Object.entries({ voice: '语音识别', tts: '语音朗读', vision: '图片理解', imagegen: '绘画模型' }).map(([k, n]) => `${n}${s.features?.[k] ? '✓' : '✗'}`);
  add('模型与服务', '可选能力', 'info', feats.join('　'));

  // ---- 网络 ----
  for (const d of s.dns || []) add('网络', `DNS 解析：${d.host}`, d.ok ? (d.ms > 1500 ? 'warn' : 'ok') : 'fail', d.ok ? `${d.ms} ms` : '解析失败：' + d.error, d.ok ? (d.ms > 1500 ? '解析偏慢。' : '') : '检查服务器的 DNS 设置。');
  if (s.clock) {
    const drift = Math.abs(s.clock.driftMs), lvl = drift > 5 * 60000 ? 'fail' : drift > 60000 ? 'warn' : 'ok';
    add('网络', '服务器时间', lvl, `与网络时间相差约 ${(drift / 1000).toFixed(1)} 秒`, lvl === 'ok' ? '' : '时间不准会导致登录令牌、HTTPS 证书和审计时间异常。请启用时间同步（chrony / systemd-timesyncd / w32time）。');
  } else add('网络', '服务器时间', 'info', '没能取得网络时间做对比');
  // ---- 内容与客户端 ----
  const dl = s.downloads || [];
  add('客户端与内容', '客户端安装包', dl.length ? 'ok' : 'info', dl.length ? '可下载：' + dl.join('、') : '下载目录里还没有安装包', dl.length ? '' : '想让成员在网页里下载客户端：bash install.sh clients <文件夹>（见《客户端安装包上传说明.md》）。');
  add('客户端与内容', '预置壁纸', 'info', `${s.wallpapers || 0} 张`);
  const c = s.counts || {};
  add('客户端与内容', '数据规模', 'info', `账号 ${c.users ?? 0}　对话 ${c.conversations ?? 0}　审计记录 ${c.audit ?? 0}`);
  return out;
}

export function summarize(checks) {
  const sum = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const c of checks) sum[c.level] = (sum[c.level] || 0) + 1;
  return { ...sum, level: sum.fail ? 'fail' : sum.warn ? 'warn' : 'ok' };
}

export function reportText(result, siteName = 'Yumeiro') {
  const mark = { ok: '[正常]', warn: '[注意]', fail: '[处理]', info: '[信息]' };
  const lines = [`${siteName} 服务器体检　${new Date(result.at).toLocaleString('zh-CN')}`, `结论：${{ ok: '一切正常', warn: '有需要注意的项目', fail: '有需要处理的问题' }[result.summary.level]}（正常 ${result.summary.ok} / 注意 ${result.summary.warn} / 处理 ${result.summary.fail}）`, ''];
  let group = '';
  for (const c of result.checks) {
    if (c.group !== group) { group = c.group; lines.push('■ ' + group); }
    lines.push(`${mark[c.level]} ${c.title}：${c.detail}`);
    if (c.hint && c.level !== 'ok') lines.push('      建议：' + c.hint);
  }
  return lines.join('\n');
}
