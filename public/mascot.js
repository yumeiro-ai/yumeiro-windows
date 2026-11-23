// 吉祥物「梦色」：登录页、欢迎页、侧栏品牌图标、助手头像换成她的形象。纯展示，不影响功能。
(() => {
  const style = document.createElement('style');
  style.textContent = `
    .ym-mascot{display:block;margin:-6px auto 8px;width:72px;height:72px;object-fit:cover;border-radius:18px;box-shadow:0 10px 30px #b04bff55,0 0 0 1px #ffffff1f;animation:ymFloat 5s ease-in-out infinite}
    .ym-mascot.big{width:96px;height:96px;border-radius:24px}
    @keyframes ymFloat{50%{transform:translateY(-5px)}}
    @media (prefers-reduced-motion:reduce){.ym-mascot{animation:none}}
    .brand-mark.ym-face{background:url(/icon.svg) center/cover no-repeat!important;color:transparent!important;font-size:0!important;box-shadow:0 2px 10px #e9516466}
    .message.assistant .mavatar{background:url(/icon.svg) center/cover no-repeat!important;color:transparent!important;font-size:0!important;border:1px solid #e9516455}`;
  document.head.append(style);
  function apply() {
    for (const mark of document.querySelectorAll('.brand-mark:not(.ym-face)')) mark.classList.add('ym-face');
    const card = document.querySelector('.login-card');
    if (card && !card.querySelector('.ym-mascot')) { const img = Object.assign(document.createElement('img'), { src: '/mascot.png', alt: '梦色', className: 'ym-mascot', draggable: false }); card.prepend(img); }
    const spark = document.querySelector('#welcome .spark');
    if (spark && !spark.classList.contains('ym-done')) { spark.classList.add('ym-done'); spark.replaceChildren(Object.assign(document.createElement('img'), { src: '/mascot.png', alt: '梦色', className: 'ym-mascot big', draggable: false })); spark.style.cssText += ';background:none!important;box-shadow:none!important;width:auto!important;height:auto!important'; }
  }
  apply();
  new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true });
})();
