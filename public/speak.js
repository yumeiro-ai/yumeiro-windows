// 语音朗读与语音通话：
//  1) 每条助手回复旁边有“🔊 朗读”按钮（服务器把回复转成语音，代码块和链接地址不会念）；
//  2) 顶栏 🔊 面板：选音色 / 语速，可选“自动朗读新回复”；
//  3) “语音通话”：免手动按钮——你说话（自动判断说完）→ 识别成文字 → 发给助手 → 助手回复 → 朗读 → 继续听。
// 需要管理员先在“管理设置 → 语音朗读”接入语音合成模型；语音通话还需要“语音识别”已开启。
(() => {
  const KEY = 'yumeiro.speak', ASR_LANG_KEY = 'yumeiro.asr.lang';
  const $ = selector => document.querySelector(selector);
  const el = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'on') for (const [e, f] of Object.entries(v)) node.addEventListener(e, f); else if (k === 'style') node.style.cssText = v; else if (k in node) node[k] = v; else node.setAttribute(k, v); }
    node.append(...kids.flat().filter(x => x != null && x !== false));
    return node;
  };
  let csrf = '', tts = null, asr = null, panel = null, current = null, wasBusy = false, assistantCountAtSend = 0, call = null;
  const prefs = () => { try { return { auto: false, voice: '', speed: 1, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { auto: false, voice: '', speed: 1 }; } };
  const savePrefs = patch => localStorage.setItem(KEY, JSON.stringify({ ...prefs(), ...patch }));
  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.body && !(options.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(options.headers || {}) };
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    if (!response.ok) { let data = {}; try { data = await response.json(); } catch { /* 无正文 */ } throw new Error(data.error || '请求失败：' + response.status); }
    return response;
  }
  const json = async (path, options) => (await api(path, options)).json();

  const style = el('style', {}, `
    .spk-btn{align-self:flex-end;border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:8px;font-size:12px;padding:2px 8px;cursor:pointer;margin-left:6px}
    .spk-btn:hover{color:var(--ink);border-color:var(--muted)} .spk-btn.on{color:var(--accent,#e95164);border-color:var(--accent,#e95164)}
    .ym-speak{width:min(460px,100%)!important} .ym-speak .ym-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}
    .ym-speak select{height:34px;border:1px solid var(--line);border-radius:9px;padding:0 8px;background:var(--ym-card,#fff);color:var(--ink)}
    .ym-note{font-size:12px;color:var(--muted)}
    .ym-call{position:fixed;inset:0;z-index:80;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;color:#fff;background:radial-gradient(circle at 50% 35%,#3a2260 0,#120d2b 70%)}
    .ym-orb{width:150px;height:150px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#ffd1e6,#e95164 60%,#7a1f45);box-shadow:0 0 60px #e9516466;transition:transform .12s}
    .ym-orb.thinking{animation:ym-think 1.4s ease-in-out infinite} .ym-orb.speaking{animation:ym-speak 0.9s ease-in-out infinite;background:radial-gradient(circle at 35% 30%,#d9f0ff,#5ab0ff 60%,#1f4a7a);box-shadow:0 0 60px #5ab0ff66}
    @keyframes ym-think{50%{transform:scale(.92);opacity:.7}} @keyframes ym-speak{50%{transform:scale(1.08)}}
    .ym-call h2{margin:0;font-size:20px;font-weight:600} .ym-call .ym-line{max-width:min(680px,90vw);text-align:center;line-height:1.6;opacity:.9;min-height:3.2em}
    .ym-call button{border:1px solid #fff6;background:#0004;color:#fff;border-radius:22px;padding:8px 20px;cursor:pointer;font-size:14px}
    @media(prefers-reduced-motion:reduce){.ym-orb{animation:none!important}}`);
  document.head.append(style);

  // ---------- 播放 ----------
  function stopPlayback() { if (current) { current.audio.pause(); URL.revokeObjectURL(current.url); current.done(); current = null; } }
  async function fetchSpeech(text) {
    const p = prefs();
    const response = await api('/api/tts', { method: 'POST', body: JSON.stringify({ text, ...(p.voice ? { voice: p.voice } : {}), speed: p.speed }) });
    return URL.createObjectURL(await response.blob());
  }
  // 播放一段文字；返回 Promise（播完/被停止时 resolve）
  async function speak(text, onState = () => {}) {
    stopPlayback(); onState('loading');
    const url = await fetchSpeech(text), audio = new Audio(url);
    return new Promise((resolve, reject) => {
      const done = () => { onState('idle'); resolve(); };
      current = { audio, url, done };
      audio.addEventListener('ended', () => { URL.revokeObjectURL(url); current = null; done(); });
      audio.addEventListener('error', () => { URL.revokeObjectURL(url); current = null; onState('idle'); reject(new Error('音频无法播放')); });
      audio.play().then(() => onState('playing')).catch(error => { URL.revokeObjectURL(url); current = null; onState('idle'); reject(error); });
    });
  }

  // ---------- 每条回复的朗读按钮 ----------
  const busy = () => Boolean($('#send')?.classList.contains('stop'));
  const bubbleText = bubble => (bubble.innerText || bubble.textContent || '').trim();
  function addButtons() {
    if (!tts?.enabled || busy()) return;
    for (const item of document.querySelectorAll('#messages .message.assistant:not([data-spk])')) {
      const bubble = item.querySelector('.bubble');
      if (!bubble || bubble.classList.contains('error') || !bubbleText(bubble)) continue;
      item.setAttribute('data-spk', '1');
      const button = el('button', { type: 'button', class: 'spk-btn', textContent: '🔊 朗读', title: '朗读这条回复' });
      button.addEventListener('click', async () => {
        if (button.classList.contains('on')) { stopPlayback(); return; }
        document.querySelectorAll('.spk-btn.on').forEach(b => { b.classList.remove('on'); b.textContent = '🔊 朗读'; });
        try { await speak(bubbleText(bubble), state => { button.classList.toggle('on', state !== 'idle'); button.textContent = state === 'loading' ? '⏳ 合成中…' : state === 'playing' ? '⏹ 停止' : '🔊 朗读'; }); }
        catch (e) { button.classList.remove('on'); button.textContent = '🔊 朗读'; button.title = e.message; ymAlert(e.message); }
      });
      item.append(button);
    }
  }
  const assistantCount = () => document.querySelectorAll('#messages .message.assistant').length;
  const lastAssistant = () => { const all = document.querySelectorAll('#messages .message.assistant'); return all[all.length - 1] || null; };

  // 发送结束（stop → 非 stop）：加按钮；开了自动朗读就读最新一条
  function onBusyChange() {
    const now = busy();
    if (wasBusy && !now) {
      addButtons();
      const item = lastAssistant();
      if (prefs().auto && !call && item && assistantCount() > assistantCountAtSend && !item.querySelector('.bubble.error')) item.querySelector('.spk-btn')?.click();
    }
    if (!wasBusy && now) assistantCountAtSend = assistantCount();
    wasBusy = now;
  }

  // ---------- 语音通话 ----------
  const TARGET_RATE = 16000;
  async function decode(blob) {
    const Ctx = window.AudioContext || window.webkitAudioContext, context = new Ctx(), bytes = await blob.arrayBuffer();
    try { return await new Promise((resolve, reject) => { const p = context.decodeAudioData(bytes, resolve, reject); if (p && p.then) p.then(resolve, reject); }); } finally { context.close?.(); }
  }
  async function toMono16k(audioBuffer) {
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(audioBuffer.duration * TARGET_RATE)), TARGET_RATE), source = offline.createBufferSource();
    source.buffer = audioBuffer; source.connect(offline.destination); source.start();
    return (await offline.startRendering()).getChannelData(0);
  }
  function encodeWav(samples) {
    const view = new DataView(new ArrayBuffer(44 + samples.length * 2)), text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, TARGET_RATE, true); view.setUint32(28, TARGET_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) { const v = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true); }
    return new Blob([view], { type: 'audio/wav' });
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitIdle = async (timeoutMs = 180000) => { const end = Date.now() + timeoutMs; while (busy() && Date.now() < end) await sleep(150); };

  // 听一句：等你开口，停顿约 1.2 秒就算说完；返回 WAV（或 null 表示被结束）
  function listenOnce(session, setState) {
    return new Promise(async (resolve, reject) => {
      let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); } catch (e) { return reject(new Error(e.name === 'NotAllowedError' ? '麦克风权限被拒绝' : '无法使用麦克风：' + (e.message || e.name))); }
      session.stream = stream;
      const ctx = new (window.AudioContext || window.webkitAudioContext)(), analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Float32Array(analyser.fftSize), chunks = [], recorder = new MediaRecorder(stream);
      recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
      let spoke = false, speechMs = 0, silenceMs = 0, elapsed = 0, finished = false;
      const finish = async (result) => { if (finished) return; finished = true; clearInterval(timer); stream.getTracks().forEach(t => t.stop()); ctx.close?.(); session.stream = null; resolve(result); };
      recorder.onstop = async () => {
        if (!session.alive || !spoke) return finish(null);
        try { const samples = await toMono16k(await decode(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))); finish(samples.length < TARGET_RATE * 0.4 ? 'empty' : encodeWav(samples)); } catch (e) { reject(e); }
      };
      const maxMs = Math.min((asr?.maxSeconds || 60), 55) * 1000;
      const timer = setInterval(() => {
        if (!session.alive) { recorder.state !== 'inactive' && recorder.stop(); return; }
        analyser.getFloatTimeDomainData(data);
        let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length), loud = rms > 0.02;
        elapsed += 60;
        if (loud) { speechMs += 60; silenceMs = 0; if (!spoke && speechMs >= 180) { spoke = true; setState('hearing'); } } else { silenceMs += 60; if (!spoke) speechMs = 0; }
        session.level = rms;
        if ((spoke && silenceMs >= 1200) || (spoke && elapsed >= maxMs)) { clearInterval(timer); recorder.state !== 'inactive' && recorder.stop(); }
      }, 60);
      recorder.start(250); setState('listening');
    });
  }

  async function startCall() {
    if (call) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { ymAlert('语音通话需要 HTTPS（或 localhost）和支持录音的新版浏览器。'); return; }
    if (busy()) { ymAlert('请等当前回复结束后再开始语音通话。'); return; }
    const orb = el('div', { class: 'ym-orb' }), title = el('h2', { textContent: '准备中…' }), line = el('div', { class: 'ym-line' });
    const interrupt = el('button', { type: 'button', textContent: '打断并继续听', hidden: true, on: { click: () => stopPlayback() } });
    const end = el('button', { type: 'button', textContent: '结束通话', on: { click: () => close() } });
    const layer = el('div', { class: 'ym-call', role: 'dialog', 'aria-label': '语音通话' }, orb, title, line, interrupt, end);
    document.body.append(layer);
    const session = { alive: true, stream: null, level: 0 };
    call = session;
    const setUi = (state, text, detail) => { orb.className = 'ym-orb' + (state === 'thinking' ? ' thinking' : state === 'speaking' ? ' speaking' : ''); title.textContent = text; if (detail !== undefined) line.textContent = detail; interrupt.hidden = state !== 'speaking'; };
    const levelTimer = setInterval(() => { if (call === session && !orb.className.includes('thinking') && !orb.className.includes('speaking')) orb.style.transform = 'scale(' + (1 + Math.min(0.25, session.level * 4)) + ')'; else orb.style.transform = ''; }, 80);
    function close() { session.alive = false; call = null; clearInterval(levelTimer); stopPlayback(); session.stream?.getTracks().forEach(t => t.stop()); layer.remove(); }
    const onKey = event => { if (event.key === 'Escape' && call === session) { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    const lang = localStorage.getItem(ASR_LANG_KEY) || asr?.defaultLang || 'auto';
    try {
      while (session.alive) {
        const wav = await listenOnce(session, state => setUi('listening', state === 'hearing' ? '正在听你说…' : '请说话', state === 'hearing' ? '' : '说完停顿一下，我会自动开始回答'));
        if (!session.alive) break;
        if (!wav || wav === 'empty') continue;
        setUi('thinking', '识别中…');
        let text = '';
        try { text = (await json('/api/asr?lang=' + encodeURIComponent(lang), { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav })).text || ''; } catch (e) { setUi('listening', '没听清', e.message); await sleep(800); continue; }
        if (!text.trim()) continue;
        if (!session.alive) break;
        const prompt = $('#prompt'), composer = $('#composer');
        prompt.value = text; prompt.dispatchEvent(new Event('input', { bubbles: true }));
        setUi('thinking', '思考中…', '你：' + text);
        assistantCountAtSend = assistantCount(); composer.requestSubmit();
        await sleep(250); await waitIdle();
        if (!session.alive) break;
        const item = lastAssistant(), bubble = item?.querySelector('.bubble');
        if (!bubble || item.querySelector('.bubble.error') || assistantCount() <= assistantCountAtSend) { setUi('listening', '这次没有得到回复', bubble ? bubbleText(bubble) : ''); await sleep(1500); continue; }
        const reply = bubbleText(bubble);
        setUi('speaking', '正在回答…', reply.length > 160 ? reply.slice(0, 160) + '…' : reply);
        try { await speak(reply); } catch (e) { setUi('listening', '朗读失败', e.message); await sleep(1500); }
      }
    } catch (error) {
      if (session.alive) { ymAlert(error.message); }
    } finally { if (call === session) close(); document.removeEventListener('keydown', onKey); }
  }

  // ---------- 设置面板 ----------
  function openPanel() {
    if (!panel) {
      panel = el('div', { class: 'modal-backdrop', hidden: true, on: { click: e => { if (e.target === panel) panel.hidden = true; } } },
        el('div', { class: 'modal ym-speak' }, el('div', { class: 'modal-head' }, el('h2', { textContent: '语音' }), el('button', { type: 'button', class: 'secondary', textContent: '关闭', on: { click: () => { panel.hidden = true; } } })), el('div', { 'data-body': '' })));
      document.body.append(panel);
    }
    panel.hidden = false;
    const body = panel.querySelector('[data-body]'), p = prefs();
    if (!tts?.enabled) { body.replaceChildren(el('p', { textContent: '管理员还没有开启语音朗读。' }), el('p', { class: 'ym-note', textContent: '管理员可以在“管理设置 → 语音朗读”里接入语音合成模型（OpenAI 兼容的 /audio/speech）。' })); return; }
    const voice = el('select', {}, el('option', { value: '', textContent: '默认音色（' + tts.defaultVoice + '）' }), tts.voices.map(v => el('option', { value: v, textContent: v })));
    voice.value = tts.voices.includes(p.voice) ? p.voice : '';
    const speed = el('select', {}, [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75].map(v => el('option', { value: v, textContent: v + ' 倍速' })));
    speed.value = String(p.speed);
    const auto = el('input', { type: 'checkbox', checked: Boolean(p.auto) });
    voice.addEventListener('change', () => savePrefs({ voice: voice.value })); speed.addEventListener('change', () => savePrefs({ speed: Number(speed.value) })); auto.addEventListener('change', () => savePrefs({ auto: auto.checked }));
    const status = el('span', { class: 'ym-note', textContent: tts.dailyChars > 0 ? `今天已朗读 ${tts.usedToday} / ${tts.dailyChars} 字` : `今天已朗读 ${tts.usedToday} 字` });
    const test = el('button', { type: 'button', class: 'secondary', textContent: '试听', on: { click: async () => { test.disabled = true; try { await speak('你好，我是 Yumeiro，这是当前的音色和语速。'); } catch (e) { status.textContent = e.message; } finally { test.disabled = false; } } } });
    const callBtn = el('button', { type: 'button', class: 'primary', textContent: '开始语音通话', disabled: !asr?.enabled, title: asr?.enabled ? '' : '需要管理员先开启“语音识别”', on: { click: () => { panel.hidden = true; startCall(); } } });
    body.replaceChildren(
      el('div', { class: 'ym-row' }, el('label', {}, '音色 ', voice), el('label', {}, '语速 ', speed), test),
      el('label', { style: 'display:flex;gap:8px;align-items:center' }, auto, '自动朗读新的回复'),
      el('p', { class: 'ym-note', textContent: '每条回复旁也有“🔊 朗读”按钮。代码块和链接地址不会被念出来。' }),
      el('div', { class: 'ym-row' }, callBtn, status),
      el('p', { class: 'ym-note', textContent: asr?.enabled ? '语音通话：打开后直接说话，说完停顿一下就会自动回答并朗读；按 Esc 或“结束通话”退出。需要 HTTPS 和麦克风权限。' : '语音通话需要同时开启“语音识别”。'}));
  }

  // 同一时间只允许一个 boot 在等接口，避免定时器重复进入、把按钮插入多次
  let booting = null;
  function boot() { return booting || (booting = bootOnce().finally(() => { booting = null; })); }
  async function bootOnce() {
    try { const session = await json('/api/auth/session'); if (!session.authenticated) return false; csrf = session.csrfToken || ''; } catch { return false; }
    const anchor = document.getElementById('drawButton') || document.getElementById('historyButton') || document.getElementById('memoryButton') || document.getElementById('settings');
    if (!anchor) return false;
    if (document.getElementById('speakButton')) return true;
    try { tts = await json('/api/tts/config'); } catch { tts = { enabled: false }; }
    try { asr = await json('/api/asr/config'); } catch { asr = { enabled: false }; }
    if (!tts.enabled && !asr.enabled) return true; // 两样都没开：不显示入口
    anchor.before(el('button', { class: 'icon-button', id: 'speakButton', type: 'button', title: '语音（朗读 / 通话）', 'aria-label': '语音', textContent: '🔊', on: { click: async () => { try { tts = await json('/api/tts/config'); } catch { /* 沿用旧配置 */ } openPanel(); } } }));
    const send = $('#send'), messages = $('#messages');
    if (send) new MutationObserver(onBusyChange).observe(send, { attributes: true, attributeFilter: ['class'] });
    if (messages) new MutationObserver(() => addButtons()).observe(messages, { childList: true });
    addButtons();
    return true;
  }
  let tries = 0;
  const timer = setInterval(async () => { if (await boot() || ++tries > 200) clearInterval(timer); }, 1500);
  setTimeout(() => boot().then(ok => { if (ok) clearInterval(timer); }), 1000);
})();
