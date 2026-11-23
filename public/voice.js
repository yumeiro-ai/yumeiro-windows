// 语音输入：聊天输入框旁的麦克风按钮。录音 → 在浏览器里转成 16kHz 单声道 WAV → 发给服务器识别 → 文字填进输入框。
// 语言 / 方言选择会一起发给服务器；服务器没有开启语音识别时，这个文件什么都不做。
(() => {
  const TARGET_RATE = 16000, LANG_KEY = 'yumeiro.asr.lang';
  const $ = selector => document.querySelector(selector);
  let ready = false;

  const css = document.createElement('style');
  css.textContent = `.voice-box{display:flex;align-items:center;gap:6px;margin-left:auto;margin-right:8px;min-width:0}
.voice-lang{width:88px;max-width:88px;height:34px;border:1px solid var(--line,#dedfe4);border-radius:10px;background:transparent;color:var(--ink,inherit);font:inherit;font-size:12px;padding:0 6px}
.voice-btn{width:34px;height:34px;flex:none;border:1px solid var(--line,#dedfe4);border-radius:10px;background:transparent;color:var(--ink,inherit);display:grid;place-items:center;cursor:pointer;padding:0}
.voice-btn:hover{border-color:var(--accent,#e95164);color:var(--accent,#e95164)}
.voice-btn.rec{background:var(--accent,#e95164);border-color:var(--accent,#e95164);color:white;animation:voice-pulse 1.2s ease-in-out infinite}
.voice-btn.busy{opacity:.6;cursor:progress}
/* 提示文字单独占一行（原来挤在“Enter 发送”旁边被截成省略号），能完整看到；没有内容时不占位 */
.composer-bottom{flex-wrap:wrap}
.voice-box{display:contents}
.voice-status{order:-1;flex:1 0 100%;margin:0 0 6px;font-size:12.5px;line-height:1.5;color:var(--muted,#777b86);white-space:normal;overflow-wrap:anywhere}
.voice-status:empty{display:none}
.voice-status.err{color:#e5626f}
@keyframes voice-pulse{0%,100%{box-shadow:0 0 0 0 #e9516455}50%{box-shadow:0 0 0 7px #e9516400}}
@media(max-width:640px){.voice-lang{width:74px;max-width:74px}}
@media(prefers-reduced-motion:reduce){.voice-btn.rec{animation:none}}`;
  document.head.append(css);

  const api = async (path, options = {}) => {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '请求失败：' + response.status);
    return data;
  };

  // —— 音频处理 ——
  async function decode(blob) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('当前浏览器不支持音频处理');
    const context = new Ctx(), bytes = await blob.arrayBuffer();
    try {
      return await new Promise((resolve, reject) => { const p = context.decodeAudioData(bytes, resolve, reject); if (p && p.then) p.then(resolve, reject); });
    } finally { context.close?.(); }
  }
  async function toMono16k(audioBuffer) {
    const length = Math.max(1, Math.ceil(audioBuffer.duration * TARGET_RATE));
    const offline = new OfflineAudioContext(1, length, TARGET_RATE);
    const source = offline.createBufferSource();
    source.buffer = audioBuffer; source.connect(offline.destination); source.start();
    return (await offline.startRendering()).getChannelData(0);
  }
  function encodeWav(samples) {
    const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
    const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, TARGET_RATE, true); view.setUint32(28, TARGET_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) { const v = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true); }
    return new Blob([view], { type: 'audio/wav' });
  }

  function mount(config) {
    const bottom = $('#composer .composer-bottom'), send = $('#send'), prompt = $('#prompt');
    if (!bottom || !send || !prompt || ready) return;
    ready = true;

    const select = document.createElement('select');
    select.className = 'voice-lang'; select.title = '说话的语言 / 方言'; select.setAttribute('aria-label', '语音识别的语言或方言');
    for (const group of [...new Set(config.languages.map(item => item.group))]) {
      const og = document.createElement('optgroup'); og.label = group;
      for (const item of config.languages.filter(x => x.group === group)) og.append(new Option(item.label, item.id));
      select.append(og);
    }
    const saved = localStorage.getItem(LANG_KEY);
    select.value = config.languages.some(item => item.id === saved) ? saved : config.defaultLang;
    select.addEventListener('change', () => localStorage.setItem(LANG_KEY, select.value));

    const button = document.createElement('button');
    button.type = 'button'; button.className = 'voice-btn'; button.setAttribute('aria-pressed', 'false');
    const icon = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
    const stopIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
    const status = document.createElement('span');
    status.className = 'voice-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const box = document.createElement('span');
    box.className = 'voice-box'; box.append(status, select, button);
    bottom.insertBefore(box, send);

    let state = 'idle', recorder = null, stream = null, chunks = [], timer = 0, tick = 0, startedAt = 0;
    let sayTimer = 0;
    const say = (message, error) => { clearTimeout(sayTimer); status.textContent = message || ''; status.title = message || ''; status.classList.toggle('err', Boolean(error)); if (message && error) sayTimer = setTimeout(() => { status.textContent = ''; status.classList.remove('err'); }, 10000); };
    const paint = () => {
      button.innerHTML = state === 'rec' ? stopIcon : icon;
      button.classList.toggle('rec', state === 'rec'); button.classList.toggle('busy', state === 'busy');
      button.setAttribute('aria-pressed', String(state === 'rec'));
      button.setAttribute('aria-label', state === 'rec' ? '停止录音并识别' : state === 'busy' ? '正在识别' : '语音输入');
      button.title = state === 'rec' ? '点击结束录音' : '语音输入（点击开始说话）';
    };
    const release = () => { clearTimeout(timer); clearInterval(tick); stream?.getTracks().forEach(track => track.stop()); stream = null; };

    function insert(text) {
      const start = prompt.selectionStart ?? prompt.value.length, end = prompt.selectionEnd ?? start;
      const before = prompt.value.slice(0, start), after = prompt.value.slice(end);
      const glue = before && !/\s$/.test(before) && /^[A-Za-z0-9]/.test(text) && /[A-Za-z0-9]$/.test(before) ? ' ' : '';
      prompt.value = before + glue + text + after;
      const caret = (before + glue + text).length;
      prompt.setSelectionRange(caret, caret);
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      prompt.focus();
    }

    async function finish(blob) {
      try {
        const samples = await toMono16k(await decode(blob));
        let peak = 0; for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
        if (samples.length < TARGET_RATE * 0.4 || peak < 0.01) { say('没有听到声音，请靠近麦克风再试', true); return; }
        const { csrfToken } = await api('/api/auth/session');
        const result = await api('/api/asr?lang=' + encodeURIComponent(select.value), { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-CSRF-Token': csrfToken || '' }, body: encodeWav(samples) });
        if (!result.text) { say('没有识别出文字，请再说一次', true); return; }
        insert(result.text); say('');
      } catch (error) { say(error.message || '识别失败', true); }
    }

    async function start() {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { say('浏览器只允许在 HTTPS 或 localhost 下使用麦克风', true); return; }
      if (typeof MediaRecorder === 'undefined') { say('当前浏览器不支持录音，请换用新版 Chrome / Edge / Safari', true); return; }
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
      catch (error) { say(error.name === 'NotAllowedError' ? '麦克风权限被拒绝，请在浏览器地址栏允许后重试' : '无法使用麦克风：' + (error.message || error.name), true); return; }
      chunks = []; recorder = new MediaRecorder(stream);
      recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        const type = recorder.mimeType || 'audio/webm', cancelled = state !== 'busy';
        release();
        if (cancelled) { state = 'idle'; paint(); return; }
        await finish(new Blob(chunks, { type }));
        state = 'idle'; paint();
      };
      recorder.start(); state = 'rec'; startedAt = Date.now(); paint();
      const limit = config.maxSeconds || 60;
      tick = setInterval(() => say('录音中 ' + Math.floor((Date.now() - startedAt) / 1000) + ' / ' + limit + ' 秒'), 250); say('录音中 0 / ' + limit + ' 秒');
      timer = setTimeout(stop, limit * 1000);
    }
    function stop() {
      if (state !== 'rec' || !recorder) return;
      clearTimeout(timer); clearInterval(tick); state = 'busy'; paint(); say('识别中…'); recorder.stop();
    }
    function cancel() { if (state === 'rec' && recorder) { state = 'idle'; say('已取消'); paint(); recorder.stop(); } }

    button.addEventListener('click', () => { if (state === 'idle') { say(''); start(); } else if (state === 'rec') stop(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && state === 'rec') cancel(); });
    window.addEventListener('pagehide', release);
    paint();
  }

  async function init() {
    if (ready || $('#app')?.hidden) return;
    try {
      const config = await api('/api/asr/config');
      if (config.enabled) mount(config);
    } catch { /* 未登录或服务器没有这个接口：不显示麦克风 */ }
  }
  const app = $('#app');
  if (app) new MutationObserver(init).observe(app, { attributes: true, attributeFilter: ['hidden'] });
  init();
})();
