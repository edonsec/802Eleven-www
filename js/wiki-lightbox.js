(function () {
  const lb  = document.createElement('div');
  lb.className = 'wiki-lightbox';
  lb.innerHTML = '<button class="wiki-lightbox-close" aria-label="Close">&times;</button><img alt="">';
  document.body.appendChild(lb);

  const img   = lb.querySelector('img');
  const close = lb.querySelector('.wiki-lightbox-close');

  function open(src, alt) {
    img.src = src;
    img.alt = alt || '';
    lb.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function dismiss() {
    lb.classList.remove('open');
    document.body.style.overflow = '';
    img.src = '';
  }

  close.addEventListener('click', dismiss);
  lb.addEventListener('click', function (e) { if (e.target === lb) dismiss(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && lb.classList.contains('open')) dismiss();
  });

  document.querySelectorAll('.screen-shot-frame img').forEach(function (el) {
    el.addEventListener('click', function () { open(el.src, el.alt); });
  });
})();
