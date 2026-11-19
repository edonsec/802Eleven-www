/* ==========================================================================
 * 802Eleven DEMO — Environment popover (new, demo-only, like theme-select.js).
 *
 * Real firmware's board capabilities (SD card mounted, dual-band radio, a
 * linked scout, GPS module...) are baked in at flash time -- there's no
 * runtime "which hardware am I" toggle on a device. This panel exists only
 * so the demo can preview how the dashboard reacts to each combination
 * without needing five different physical boards on hand. Not derived from
 * WebPage.cpp -- do not feed through the reverse-translation skill.
 *
 * Mutates mock-api.js's `state` (exposed as window.__mockState) directly.
 * capdual/dband already flow into buildDataJson() -> app.js's
 * syncCapBand/syncScoutBand, and scoutLinked already gates every
 * .scout-only element + the scout capture tab, so those three reflect on
 * the very next /ws push (~1s). SD (state.sdBoard) is read on-demand by the
 * Authorisations tab's handshake list (see loadHandshakes) and the
 * Settings > Data tab's saved-session list, so it takes effect next time
 * either is opened, same as a real board doing an SD probe on view-open.
 * dongle (state.dongle) is read on-demand by openSetModal's /api/sysinfo
 * fetch (setDongleVisible, mirrors the real firmware's "tdongle" field) --
 * gates the Settings > Dongle tab, takes effect next time Settings is
 * opened. GPS (state.gps) gates mock-api.js's per-AP lat/lon fabrication
 * (buildDataJson()'s wifi[] entries) -- rendered by the real MAC-info-card
 * Location row (app.js::showMacInfo), same field a GPS session-log import
 * already feeds; takes effect next time that card is opened.
 * ========================================================================== */
(function(){
'use strict';

const FLAGS = [
  {key:'sdBoard', label:'SD card present',
    hint:'Gates the Authorisations tab’s CAPTURES (SD) list + Settings → Data saved sessions.'},
  {key:'capdual', label:'Dual-band radio (this board)', mirror:'dband',
    hint:'Shows the 2.4/5GHz tabs in the Capture popover + Scout popover (mirrors both, like a T-Dongle-C5).'},
  {key:'dongle', label:'Standalone dongle (no scout)', forces:{capdual:true, dband:true, scoutLinked:false},
    hint:'A T-Dongle-C5 board: own dual-band radio, no companion scout link, adds the Settings → Dongle tab (LED/screen/orientation/Sentinel-boot prefs). Takes effect next time Settings is opened.'},
  {key:'gps', label:'GPS module',
    hint:'Tags AP wifi[] records with lat/lon (mock-api.js), same field the real MAC-info-card Location row already renders for GPS session-log imports.'},
  {key:'scoutLinked', label:'Scout companion linked',
    hint:'Shows every .scout-only view (Scout Feed, Frames) + the capture popover’s Scout tab.'},
];

function state(){ return window.__mockState; }

function buildPopover(){
  const pop = document.createElement('div');
  pop.id = 'envPop';
  pop.className = 'cappop';
  const hd = document.createElement('div');
  hd.className = 'cappop-hd';
  hd.textContent = 'Simulated board environment';
  pop.appendChild(hd);
  FLAGS.forEach(f=>{
    const row = document.createElement('div');
    row.className = 'caprow';
    row.style.cssText = 'flex-direction:column;align-items:flex-start;gap:2px;margin-bottom:8px';
    const btn = document.createElement('button');
    btn.className = 'tgl';
    btn.id = 'env_'+f.key;
    btn.textContent = f.label;
    btn.style.width = '100%';
    btn.title = f.hint;
    btn.onclick = ()=>onToggle(f);
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.style.cssText = 'font-size:10px;line-height:1.3';
    hint.textContent = f.hint;
    row.appendChild(btn); row.appendChild(hint);
    pop.appendChild(row);
  });
  return pop;
}

function onToggle(f){
  const s = state(); if(!s) return;
  const on = !s[f.key];
  s[f.key] = on;
  if(on && f.forces) Object.assign(s, f.forces);
  if(f.mirror) s[f.mirror] = on;
  syncButtons();
  forceRefresh();
}

/**
 * Applies a toggled flag to the dashboard immediately instead of waiting for
 * the next natural refresh point. capdual/dband/scoutLinked flow through
 * /api/data, so a manual tick() picks them up on the spot rather than up to
 * ~1s later on the next WS push. sdBoard/dongle are read on-demand by
 * specific views (see the FLAGS comment above) -- if that view happens to be
 * open right now, re-run its loader so the toggle is visible without having
 * to close and reopen it.
 */
function forceRefresh(){
  syncDongleVis();
  if(typeof tick === 'function') tick();
  if(typeof setOpen !== 'undefined' && setOpen && typeof setSettingsTab === 'function') setSettingsTab(setTab);
  if(typeof curView !== 'undefined' && curView === 'deauth'
     && typeof loadHsFiles === 'function' && typeof loadHsRam === 'function') loadHsFiles().then(loadHsRam);
}

function syncButtons(){
  const s = state(); if(!s) return;
  FLAGS.forEach(f=>{
    const btn = document.getElementById('env_'+f.key);
    if(btn) btn.classList.toggle('on', !!s[f.key]);
  });
}

function syncDongleVis(){
  const s = state(); if(!s) return;
  const on = !!s.dongle;
  const dBtn = document.getElementById('dongleBtn');
  if(dBtn){ const wrap = dBtn.closest('.segwrap'); if(wrap) wrap.style.display = on ? '' : 'none'; }
  const indefWrap = document.getElementById('capIndefWrap');
  if(indefWrap) indefWrap.style.display = on ? '' : 'none';
}

function toggleEnvPop(){
  const pop = document.getElementById('envPop');
  if(!pop) return;
  pop.classList.toggle('on');
  if(pop.classList.contains('on')) syncButtons();
}

document.addEventListener('click', function(e){
  const pop = document.getElementById('envPop');
  const btn = document.getElementById('envBtn');
  if(!pop || !pop.classList.contains('on')) return;
  if(pop.contains(e.target) || (btn && btn.contains(e.target))) return;
  pop.classList.remove('on');
});

function ensureButton(){
  let btn = document.getElementById('envBtn');
  if(btn) return btn;
  const controls = document.querySelector('header .controls');
  if(!controls) return null;
  btn = document.createElement('button');
  btn.id = 'envBtn';
  btn.className = 'iconbtn';
  btn.title = 'demo-only: simulate board environment/capabilities';
  btn.textContent = 'Env';
  const themeSel = document.getElementById('themeSelBtn');
  const gear = document.getElementById('gearBtn');
  controls.insertBefore(btn, themeSel ? themeSel.nextSibling : gear);
  return btn;
}

function init(){
  if(/[?&]demoMobilePreview=1(&|$)/.test(location.search)) return;
  const btn = ensureButton();
  if(!btn || !window.__mockState) return;
  btn.parentElement.style.position = 'relative';
  btn.parentElement.appendChild(buildPopover());
  btn.onclick = toggleEnvPop;
  syncButtons();
  syncDongleVis();
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
