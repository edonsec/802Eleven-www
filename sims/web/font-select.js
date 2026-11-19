/* ==========================================================================
 * 802Eleven DEMO — Font picker (sim-only, not derived from WebPage.cpp).
 * Adds a "Font" button to the header controls; opens a popover listing
 * offline-safe system-font stacks. Selection is applied immediately to
 * document.body and persisted in localStorage.
 * ========================================================================== */
(function(){
'use strict';

const LS_KEY = '802e-font';

const FONTS = [
  { key:'system',    label:'System UI',   hint:'OS native: SF Pro (macOS/iOS) · Segoe UI (Windows) · Roboto (Android)',
    stack:'system-ui,-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif' },
  { key:'verdana',   label:'Verdana',      hint:'Screen-optimised humanist sans. Very legible at small sizes.',
    stack:'Verdana,Geneva,Tahoma,sans-serif' },
  { key:'helvetica', label:'Helvetica',    hint:'Neo-grotesque: neutral, professional.',
    stack:'\'Helvetica Neue\',Helvetica,Arial,sans-serif' },
  { key:'trebuchet', label:'Trebuchet MS', hint:'Humanist sans: friendly with a slightly technical edge.',
    stack:'\'Trebuchet MS\',\'Lucida Grande\',\'Lucida Sans Unicode\',sans-serif' },
  { key:'optima',    label:'Optima',       hint:'Elegant humanist with subtle flared stroke ends. macOS/iOS only; falls back to Candara (Windows).',
    stack:'Optima,Candara,\'Noto Sans\',sans-serif' },
  { key:'calibri',   label:'Calibri',      hint:'Rounded humanist sans. Common on Windows; falls back gracefully.',
    stack:'Calibri,Carlito,\'Gill Sans\',sans-serif' },
  { key:'georgia',   label:'Georgia',      hint:'Screen-designed serif — readable body text at any size.',
    stack:'Georgia,\'Times New Roman\',serif' },
  { key:'palatino',  label:'Palatino',     hint:'Old-style serif with a typographic feel.',
    stack:'Palatino,\'Book Antiqua\',\'Palatino Linotype\',serif' },
  { key:'mono',      label:'Mono (original)', hint:'Terminal / hacker aesthetic — the original 802Eleven font.',
    stack:'ui-monospace,Menlo,Consolas,monospace' },
  { key:'courier',   label:'Courier New',  hint:'Classic typewriter mono.',
    stack:'\'Courier New\',Courier,monospace' },
];

let activePop = null;

function currentKey(){
  return localStorage.getItem(LS_KEY) || 'system';
}

function applyFont(key){
  const f = FONTS.find(x=>x.key===key) || FONTS[0];
  document.body.style.fontFamily = f.stack;
  try{ localStorage.setItem(LS_KEY, key); }catch(e){}
  paintRows();
  updateBtnLabel(key);
}

function updateBtnLabel(key){
  const btn = document.getElementById('fontBtn'); if(!btn) return;
  const f = FONTS.find(x=>x.key===key);
  btn.textContent = f ? f.label : 'Font';
}

function paintRows(){
  const key = currentKey();
  FONTS.forEach(f=>{
    const row = document.getElementById('fontrow_'+f.key); if(!row) return;
    row.classList.toggle('on', f.key===key);
  });
}

function buildPopover(){
  const pop = document.createElement('div');
  pop.id = 'fontPop';
  pop.className = 'cappop';
  pop.style.cssText = 'width:240px;right:0;top:calc(100% + 8px)';

  const hd = document.createElement('div');
  hd.className = 'cappop-hd';
  hd.textContent = 'Font (sim only)';
  pop.appendChild(hd);

  FONTS.forEach(f=>{
    const row = document.createElement('button');
    row.className = 'tgl';
    row.id = 'fontrow_'+f.key;
    row.title = f.hint;
    row.style.cssText = 'width:100%;text-align:left;margin-bottom:4px;display:flex;flex-direction:column;height:auto;padding:6px 10px;gap:1px';

    const name = document.createElement('span');
    name.style.cssText = 'font-family:'+f.stack+';font-size:13px';
    name.textContent = f.label;

    const hint = document.createElement('span');
    hint.className = 'muted';
    hint.style.cssText = 'font-size:10px;font-family:inherit;white-space:normal;line-height:1.3';
    hint.textContent = f.hint;

    row.appendChild(name); row.appendChild(hint);
    row.onclick = ()=>{ applyFont(f.key); };
    pop.appendChild(row);
  });

  return pop;
}

function togglePop(){
  const pop = document.getElementById('fontPop');
  if(!pop) return;
  pop.classList.toggle('on');
  if(pop.classList.contains('on')) paintRows();
}

document.addEventListener('click', function(e){
  const pop = document.getElementById('fontPop');
  const btn = document.getElementById('fontBtn');
  if(!pop || !pop.classList.contains('on')) return;
  if(pop.contains(e.target) || (btn && btn.contains(e.target))) return;
  pop.classList.remove('on');
});

function ensureButton(){
  let btn = document.getElementById('fontBtn');
  if(btn) return btn;
  const controls = document.querySelector('header .controls');
  if(!controls) return null;
  btn = document.createElement('button');
  btn.id = 'fontBtn';
  btn.className = 'iconbtn';
  btn.title = 'Font picker (sim only — system fonts, no downloads)';
  btn.textContent = 'Font';
  const envBtn = document.getElementById('envBtn');
  controls.insertBefore(btn, envBtn ? envBtn.nextSibling : controls.firstChild);
  return btn;
}

function init(){
  if(/[?&]demoMobilePreview=1(&|$)/.test(location.search)) return;
  const btn = ensureButton(); if(!btn) return;
  const wrap = btn.parentElement;
  wrap.style.position = 'relative';
  wrap.appendChild(buildPopover());
  btn.onclick = togglePop;
  const saved = currentKey();
  applyFont(saved);
}

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
