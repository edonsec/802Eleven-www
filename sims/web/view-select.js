/* ==========================================================================
 * 802Eleven DEMO — Viewport toggle (new, demo-only, like theme-select.js).
 *
 * The dashboard itself is responsive (phone -> desktop) with no server-side
 * concept of "layout mode" -- a real board just serves the same page to
 * whatever browser asks. This control exists purely so the demo can be
 * previewed at both breakpoints without resizing the actual browser window.
 *
 * "Mobile" loads the SAME page fresh inside a phone-sized <iframe>. An
 * iframe has its own layout viewport independent of the parent tab's window
 * width, so CSS @media breakpoints inside it evaluate against the iframe's
 * own size and the page genuinely reflows like it would on a phone -- a
 * plain CSS-transform/zoom of the existing DOM does NOT do this (window/
 * matchMedia width never changes, so @media rules never re-fire; you just
 * get the desktop layout squeezed into a box).
 *
 * The iframe is inserted as a normal block AFTER the real <header> and every
 * other top-level body child is hidden (not covered by an overlay) -- so
 * the header, and this toggle button in it, stay in normal page flow and
 * visible/clickable in both modes. An earlier version used a
 * position:fixed full-viewport overlay, which buried the header underneath
 * it the moment mobile mode was on (and reloading with "mobile" already
 * saved in localStorage meant the button was never reachable at all).
 *
 * Self-injected (same ensureButton() pattern as theme-select.js/
 * env-select.js) since index.html's body is mechanically overwritten by
 * tools/extract_demo.py. Not derived from WebPage.cpp -- do not feed
 * through the reverse-translation skill.
 * ========================================================================== */
(function () {
  'use strict';

  var KEY = '802eleven-demo-view';
  var MOBILE_WIDTH = 390;
  var MOBILE_HEIGHT = 844;

  function injectStyle() {
    if (document.getElementById('demoViewStyle')) return;
    var style = document.createElement('style');
    style.id = 'demoViewStyle';
    style.textContent =
      '#demoMobileWrap{display:flex;justify-content:center;padding:24px 12px;background:#05070c}' +
      '#demoMobileWrap iframe{width:' + MOBILE_WIDTH + 'px;height:' + MOBILE_HEIGHT + 'px;' +
      'border:8px solid #1a1f2b;border-radius:34px;box-shadow:0 0 0 2px #000,0 20px 60px -10px #000c;background:#fff}' +
      // A real phone-width browser already IS the mobile view -- "Full" would just squeeze the
      // desktop layout into the same narrow viewport, nothing to toggle to. Same breakpoint the
      // dashboard's own CSS uses to switch layouts (see style.css's @media(max-width:560px)).
      '@media(max-width:560px){#viewSelBtn{display:none}}';
    document.head.appendChild(style);
  }

  function wrapEl() {
    return document.getElementById('demoMobileWrap');
  }

  function bodyContentEls() {
    return Array.prototype.filter.call(document.body.children, function (el) {
      return el.tagName !== 'HEADER' && el.id !== 'demoMobileWrap';
    });
  }

  function apply(mode) {
    var mobile = mode === 'mobile';
    var wrap = wrapEl();
    if (mobile && !wrap) {
      wrap = document.createElement('div');
      wrap.id = 'demoMobileWrap';
      var frame = document.createElement('iframe');
      var qs = location.search ? location.search + '&demoMobilePreview=1' : '?demoMobilePreview=1';
      frame.src = location.pathname + qs;
      wrap.appendChild(frame);
      var header = document.querySelector('header');
      if (header && header.nextSibling) document.body.insertBefore(wrap, header.nextSibling);
      else document.body.appendChild(wrap);
    }
    if (wrap) wrap.style.display = mobile ? '' : 'none';
    bodyContentEls().forEach(function (el) { el.style.display = mobile ? 'none' : ''; });
    document.documentElement.classList.toggle('demo-mobile', mobile);
    var btn = document.getElementById('viewSelBtn');
    if (btn) {
      btn.textContent = mobile ? 'View: Mobile' : 'View: Full';
      btn.classList.toggle('on', mobile);
    }
    notifyParentSize(mobile);
  }

  function notifyParentSize(mobile) {
    if (window.parent === window) return;
    requestAnimationFrame(function () {
      window.parent.postMessage(mobile
        ? { type: 'simSize', w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }
        : { type: 'simSize', w: 1200, h: 800 },
        '*');
    });
  }

  window.setDemoView = function (mode) {
    if (mode !== 'mobile' && mode !== 'full') mode = 'full';
    localStorage.setItem(KEY, mode);
    apply(mode);
  };

  function current() {
    var v = localStorage.getItem(KEY);
    return v === 'mobile' ? 'mobile' : 'full';
  }

  function ensureButton() {
    var btn = document.getElementById('viewSelBtn');
    if (btn) return btn;
    var controls = document.querySelector('header .controls');
    if (!controls) return null;
    btn = document.createElement('button');
    btn.id = 'viewSelBtn';
    btn.className = 'iconbtn';
    btn.title = 'demo-only: preview the dashboard in a phone-width frame vs. full page';
    btn.onclick = function () {
      window.setDemoView(current() === 'mobile' ? 'full' : 'mobile');
    };
    var gear = document.getElementById('gearBtn');
    controls.insertBefore(btn, gear || null);
    return btn;
  }

  function init() {
    if (/[?&]demoMobilePreview=1(&|$)/.test(location.search)) return;
    injectStyle();
    ensureButton();
    apply(current());
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
