(function() {
  var overlay = document.createElement('div');
  overlay.id = 'pageLoader';
  overlay.innerHTML = '<div class="loader-spinner"></div>';
  var style = document.createElement('style');
  style.textContent = '#pageLoader{display:none;position:fixed;inset:0;background:rgba(240,242,245,0.9);z-index:99999;align-items:center;justify-content:center;pointer-events:none}#pageLoader.show{display:flex}.loader-spinner{width:32px;height:32px;border:3px solid #e5e7eb;border-top-color:#6366f1;border-radius:50%;animation:spin 0.7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);
  (document.body || document.documentElement).appendChild(overlay);

  var timer = null;
  var navigating = false;

  function startTimer() {
    if (navigating) return;
    navigating = true;
    timer = setTimeout(function() { overlay.classList.add('show'); }, 400);
  }

  function cancelTimer() {
    navigating = false;
    if (timer) { clearTimeout(timer); timer = null; }
    overlay.classList.remove('show');
  }

  document.addEventListener('click', function(e) {
    var el = e.target;
    while (el && el !== document) {
      if (el.tagName === 'A' && el.getAttribute('href')) break;
      el = el.parentElement;
    }
    if (!el || el === document || el.tagName !== 'A') return;
    var href = el.getAttribute('href');
    if (!href || href.charAt(0) === '#' || href.indexOf('javascript') === 0) return;
    if (el.hasAttribute('download') || el.target === '_blank') return;
    if (href.indexOf('http') === 0 && href.indexOf(location.origin) !== 0) return;
    var path = href.replace(location.origin, '');
    if (path === location.pathname || path === '/' && location.pathname === '/index.html') return;
    startTimer();
  }, true);

  window.addEventListener('pageshow', cancelTimer);
  window.addEventListener('beforeunload', function() {
    overlay.classList.add('show');
  });
})();
