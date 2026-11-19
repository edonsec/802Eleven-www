(function () {
  var side = document.querySelector('.wiki-page .wiki-side');
  var toc = side && side.querySelector('.wiki-toc');
  if (!side || !toc) return;

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'wiki-burger';
  btn.setAttribute('aria-label', 'Toggle navigation');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round"><line x1="3" y1="5" x2="17" y2="5"/><line x1="3" y1="10" x2="17" y2="10"/>' +
    '<line x1="3" y1="15" x2="17" y2="15"/></svg>';
  side.insertBefore(btn, toc);

  btn.addEventListener('click', function () {
    var open = side.classList.toggle('nav-open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  toc.addEventListener('click', function (e) {
    if (e.target.closest('a')) {
      side.classList.remove('nav-open');
      btn.setAttribute('aria-expanded', 'false');
    }
  });
})();

(function () {
  var container = document.getElementById('gsTabs');
  if (!container) return;
  container.addEventListener('click', function (e) {
    var tab = e.target.closest('.gs-tab');
    if (!tab) return;
    var key = tab.getAttribute('data-gstab');
    container.querySelectorAll('.gs-tab').forEach(function (t) {
      t.classList.toggle('active', t === tab);
    });
    document.querySelectorAll('[data-gstabpanel]').forEach(function (panel) {
      var show = panel.getAttribute('data-gstabpanel') === key;
      panel.style.display = show ? '' : 'none';
      if (show) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    });
  });
})();
