// Yumeiro 客户端里的“远程被控端”：让这台电脑可以被你自己的手机 / 网页远程查看和操控。
// 用客户端自带的运行环境（ELECTRON_RUN_AS_NODE）跑被控端程序 agent.mjs，不需要另外装 Node.js；
// 配对用客户端已经登录的会话自动完成，不用手敲配对码。被控端只会向服务器发起出站连接。
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

module.exports = function createRemote({ readConfig, patchConfig, serverOrigin, api, onChange }) {
  const dir = path.join(app.getPath('userData'), 'remote');
  const agentFile = path.join(dir, 'agent.mjs'), cfgFile = path.join(dir, 'agent.json');
  let child = null, starting = false, wantStop = false, restartTimer = null, status = 'stopped', note = '';
  const lines = [];

  const loadAgent = () => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { return {}; } };
  const enabled = () => readConfig().remoteEnabled === true;
  const wantControl = () => readConfig().remoteControl === true;   // 默认只许查看，要手动打开“允许手机操作”
  function set(next, text = '') { status = next; note = text; try { onChange && onChange(); } catch { /* 菜单刷新失败不影响运行 */ } }
  function state() {
    const a = loadAgent();
    return { enabled: enabled(), control: wantControl(), status, note, paired: Boolean(a.token), deviceName: a.name || os.hostname(), log: lines.slice(-8) };
  }
  const push = text => { for (const line of String(text).split(/\r?\n/)) { const t = line.trim(); if (t) { lines.push(t.slice(0, 300)); if (lines.length > 60) lines.shift(); } } };
  function killTree(proc) {
    if (!proc || proc.killed) return;
    if (process.platform === 'win32') { try { execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch { /* 进程已经没了 */ } }
    else { try { proc.kill('SIGTERM'); } catch { /* 进程已经没了 */ } }
  }

  function launch(args) {
    const extra = readConfig().ignoreCertErrors === true ? { NODE_TLS_REJECT_UNAUTHORIZED: '0' } : {};   // 只有你对这台服务器勾选过“忽略证书错误”才放行
    if (process.env.YUMEIRO_AGENT_BACKEND) args.push('--backend', process.env.YUMEIRO_AGENT_BACKEND);   // 仅测试用：假后端，不碰真实桌面
    const proc = spawn(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extra }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc; set('starting', '正在启动…');
    const onData = chunk => {
      const text = String(chunk); push(text);
      if (/已连接到/.test(text)) set('online');
      else if (/连接服务器失败/.test(text)) set('reconnecting', '连接服务器失败，正在重试…');
      else if (/配对成功/.test(text)) set('starting', '配对成功，正在连接…');
    };
    proc.stdout.on('data', onData); proc.stderr.on('data', onData);
    proc.on('error', error => { push('启动失败：' + error.message); });
    proc.on('exit', code => {
      if (child === proc) child = null;
      if (wantStop) { set('stopped'); return; }
      const tail = lines.slice(-3).join(' / ');
      if (/取消配对|令牌失效/.test(tail)) { try { fs.unlinkSync(cfgFile); } catch { /* 没有也行 */ } patchConfig({ remoteEnabled: false }); set('stopped', '这台电脑已在网页上被取消配对，被控端已关闭'); return; }
      set('error', '被控端意外退出（' + code + '）' + (tail ? '：' + tail : '') + '，5 秒后自动重试');
      clearTimeout(restartTimer); restartTimer = setTimeout(() => { if (enabled() && !child) start(); }, 5000);
    });
  }

  async function start() {
    if (child || starting) return;
    starting = true; wantStop = false; clearTimeout(restartTimer);
    try {
      const server = serverOrigin();
      if (!server) { set('error', '还没有配置服务器'); return; }
      fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(path.join(__dirname, 'agent', 'agent.mjs'), agentFile);
      let saved = loadAgent();
      if (saved.token && saved.server !== server) { try { fs.unlinkSync(cfgFile); } catch { /* 忽略 */ } saved = {}; }   // 换了服务器：旧的配对作废，重新配对
      const control = wantControl(), args = [agentFile, '--config', cfgFile, control ? '--allow-control' : '--view-only'];
      if (!saved.token) {
        set('pairing', '正在向服务器申请配对…');
        const r = await api('POST', '/api/remote/pair', { name: os.hostname().slice(0, 40), control });
        if (r.status === 401) { set('error', '请先登录 Yumeiro 再开启'); return; }
        if (r.status !== 201 || !r.data || !r.data.code) { set('error', (r.data && r.data.error) || r.error || '申请配对失败（HTTP ' + r.status + '）'); return; }
        args.push('--server', server, '--code', r.data.code);
      }
      if (!enabled() || wantStop) return;
      launch(args);
    } catch (error) { set('error', String((error && error.message) || error)); }
    finally { starting = false; }
  }
  function stop() { wantStop = true; clearTimeout(restartTimer); const proc = child; child = null; killTree(proc); set('stopped'); }

  async function setEnabled(on) {
    patchConfig({ remoteEnabled: Boolean(on) });
    if (on) await start(); else stop();
    return state();
  }
  async function setControl(on) {
    patchConfig({ remoteControl: Boolean(on) });
    const a = loadAgent();
    if (a.deviceId) await api('PATCH', '/api/remote/devices/' + encodeURIComponent(a.deviceId), { allowControl: Boolean(on) }).catch(() => {});   // 网页那边也同步成“可控制 / 仅查看”
    if (child) { stop(); await new Promise(r => setTimeout(r, 600)); await start(); }
    return state();
  }
  async function unpair() {
    const a = loadAgent();
    stop(); patchConfig({ remoteEnabled: false });
    if (a.deviceId) await api('DELETE', '/api/remote/devices/' + encodeURIComponent(a.deviceId)).catch(() => {});
    try { fs.unlinkSync(cfgFile); } catch { /* 本来就没有 */ }
    lines.length = 0; set('stopped');
    return state();
  }
  return { state, setEnabled, setControl, unpair, start, stop, enabled };
};
