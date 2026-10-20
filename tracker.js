(function() {
  var page = location.pathname === '/' ? 'home' : location.pathname.replace('.html', '').replace('/', '');
  var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  var device = isMobile ? 'mobile' : 'desktop';
  var seconds = 0;
  var active = false;
  var timer = null;
  var lastActivity = Date.now();
  var IDLE_LIMIT = 3 * 60 * 1000;

  function isActive() {
    if (document.visibilityState !== 'visible') return false;
    if (!document.hasFocus()) return false;
    if (!isMobile && Date.now() - lastActivity > IDLE_LIMIT) return false;
    return true;
  }

  function recordActivity() {
    lastActivity = Date.now();
    if (!active && isActive()) {
      active = true;
      start();
      window.dispatchEvent(new CustomEvent('ftc-reactivate'));
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(function() { seconds++; }, 1000);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function check() {
    var nowActive = isActive();
    if (nowActive && !active) {
      active = true;
      start();
      window.dispatchEvent(new CustomEvent('ftc-reactivate'));
    } else if (!nowActive && active) {
      active = false;
      stop();
      flush();
    }
  }

  function flush() {
    if (seconds <= 0) return;
    var data = JSON.stringify({ page: page, seconds: seconds, device: device });
    seconds = 0;
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/time', new Blob([data], { type: 'application/json' }));
    } else {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/time', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(data);
    }
  }

  if (!isMobile) {
    ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'wheel'].forEach(function(evt) {
      document.addEventListener(evt, recordActivity, { passive: true });
    });
    setInterval(function() { if (active && !isActive()) { active = false; stop(); flush(); } }, 5000);
  }

  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', function() { recordActivity(); check(); });
  window.addEventListener('blur', function() { active = false; stop(); flush(); });
  window.addEventListener('beforeunload', flush);

  setInterval(flush, 30000);

  if (isActive()) { active = true; start(); }

  window.__ftcTracker = { isActive: isActive };
})();
