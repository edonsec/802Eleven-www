(function(){try{var t=localStorage.getItem('websTheme');
  if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();
/*LITE0*/let LITE_MODE=false;/*LITE1*/
(function(){const _f=window.fetch;
  /* sscsrf is only refreshed by GET / (per-boot token). After a device reboot or
     login the open page holds a stale token -> 403 csrf. Refetch / to re-issue
     the cookie and retry the rejected request once (a 403 csrf never ran it). */
  const withCsrf=(u,o)=>{const h=new Headers(o.headers||{});
    const m=document.cookie.match(/(?:^|; )sscsrf=([^;]+)/);
    if(m)h.set('X-CSRF-Token',decodeURIComponent(m[1]));
    return Object.assign({},o,{headers:h});};
  /* Retry wrapper: a request with no response (network error / timeout) is retried
     up to REQ_MAX_RETRIES times. After that the AP-rejoin QR overlay (#aplost) is shown
     and further requests stop retrying (one attempt each) until one succeeds. HTTP
     status replies are never retried. Skipped entirely in offline/imported viewing. */
  let reqFailStreak=0, reqLostTripped=false;
  const REQ_MAX_RETRIES=5, REQ_RETRY_MS=400, REQ_TIMEOUT_MS=5000;
  const sendOnce=(u,o)=>{ if(o.signal)return _f(u,o);
    const c=new AbortController(); const t=setTimeout(()=>c.abort(),REQ_TIMEOUT_MS);
    return _f(u,Object.assign({},o,{signal:c.signal})).finally(()=>clearTimeout(t)); };
  const offlineView=()=>{try{return !liveOn||!!importedSnap;}catch(e){return false;}};
  const sendRetry=async(u,o)=>{
    if(offlineView())return _f(u,o);
    const max=reqLostTripped?1:REQ_MAX_RETRIES;
    let lastErr=null;
    for(let i=0;i<max;i++){
      if(i)await new Promise(res=>setTimeout(res,REQ_RETRY_MS*i));
      try{
        const r=await sendOnce(u,o);
        reqFailStreak=0;
        if(reqLostTripped){reqLostTripped=false; hideApLost();}
        return r;
      }catch(e){lastErr=e; reqFailStreak++;}
    }
    if(!reqLostTripped&&reqFailStreak>=REQ_MAX_RETRIES){reqLostTripped=true; showApLost();}
    throw lastErr;
  };
  window.fetch=async function(u,o){o=o||{};
    let r=await sendRetry(u,withCsrf(u,o));
    if(r.status===403&&!o._csrfRetry){
      try{await _f('/',{cache:'no-store'});}catch(e){return r;}
      const n=Object.assign({},o,{_csrfRetry:true});
      r=await sendRetry(u,withCsrf(u,n));
    }
    return r;};})();
let dSort={k:'rssi',dir:-1};
let seenD={};
let selMac=null, devRowOrder=[];
let devView='table';
let refMac=localStorage.getItem('refMac')||null, lastDevs=[];
let lastWifi=[], lastDeauth=[], lastHandshake=[], pmkOnly=false;
let rogueByMac=new Map();
let preCaptureMacs=null, newWifiMacs=new Set();
let preCaptureStationMacs=null, newStationMacs=new Set();
let importedSnap=null;
let onlyNear=!!refMac;
let gpsFocus=null, gpsCoordsAvailable=false;
/**
 * Great-circle distance between two lat/lon pairs (haversine formula),
 * mirroring the firmware's GnssModule::distanceM.
 * @returns Distance in metres.
 */
function haversineM(lat1,lon1,lat2,lon2){
  const R=6371000, toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
/**
 * Sets or clears the GPS focus point used by the 'gps' band-filter mode.
 * Only meaningful for data carrying GPS coordinates (GPS session log replay).
 * @param mac MAC of a device whose lat/lon becomes the focus point; toggling the
 * current focus MAC clears it.
 */
function setGpsFocus(mac){
  const w=(lastWifi||[]).find(x=>x.mac===mac);
  if(gpsFocus && gpsFocus.mac===mac){ gpsFocus=null; }
  else if(w && w.lat!==undefined){ gpsFocus={mac,lat:w.lat,lon:w.lon}; setBandMode('gps'); }
  else return;
  const mg=document.getElementById('macModalGps'); if(mg)mg.classList.toggle('on',!!gpsFocus&&gpsFocus.mac===macModalMac_);
  drawRadar(lastDevs);
}
/**
 * Recomputes whether the currently loaded wifi[] data carries any GPS
 * coordinates and shows/hides the GPS band-filter mode accordingly. Clears
 * a stale focus/mode when the new data has no coordinates.
 */
function syncGpsFocusUI(){
  gpsCoordsAvailable=(lastWifi||[]).some(x=>x.lat!=null&&x.lon!=null);
  document.querySelectorAll('.gps-only').forEach(e=>e.style.display=gpsCoordsAvailable?'':'none');
  if(!gpsCoordsAvailable){
    gpsFocus=null;
    if(bandMode==='gps')setBandMode('sig');
    if(curView==='trail')setView('map');
  } else if(curView==='trail'&&typeof drawTrail==='function')drawTrail();
}
/**
 * Sets or clears the reference MAC used to focus the radar/signal filter on one device.
 * Persists the choice to localStorage, switches the band slider to focus range when set,
 * resets the radar view transform, and syncs the MAC-info-modal reference toggle before refreshing data.
 * @param mac MAC address to set as reference; toggling the current reference MAC clears it.
 */
function setRef(mac){
  refMac=(mac&&mac!==refMac)?mac:null;
  if(refMac)localStorage.setItem('refMac',refMac);else localStorage.removeItem('refMac');
  onlyNear=!!refMac;
  const bi=document.getElementById('band'), bl=document.getElementById('bandL'),
        lbl=document.getElementById('bandLbl');
  if(bi){bi.value=refMac?12:100;
         if(bl)bl.textContent=bi.value;
         if(lbl)lbl.textContent=(refMac?'radar focus range':'signal range')+' ±';}
  if(refMac)view={s:1,cx:null,cy:null};
  const mr=document.getElementById('macModalRef');
  if(mr)mr.classList.toggle('on',!!refMac&&refMac===macModalMac_);
  tick();
}
/**
 * Escapes HTML-special characters for safe interpolation into markup.
 * @param s Input string (falsy treated as empty).
 * @returns The escaped string.
 */
function esc(s){return (s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
let confirmPending=null;
/**
 * Opens the shared confirm modal (#confirmModal) with a body, confirm-button label,
 * optional extra HTML block, and the callback to run if the user confirms.
 * @param bodyHtml HTML for the modal body.
 * @param yesLabel Confirm-button label; defaults to 'Confirm' if falsy.
 * @param onYes Callback invoked by doConfirm() when the user confirms.
 * @param extraHtml Optional extra HTML shown below the body; the extra slot is hidden when omitted.
 */
function openConfirm(bodyHtml,yesLabel,onYes,extraHtml){
  confirmPending=onYes;
  const body=document.getElementById('confirmModalBody'); if(body)body.innerHTML=bodyHtml;
  const extra=document.getElementById('confirmModalExtra');
  if(extra){ if(extraHtml){extra.innerHTML=extraHtml;extra.style.display='';} else {extra.innerHTML='';extra.style.display='none';} }
  const btn=document.getElementById('confirmModalBtn'); if(btn)btn.textContent=yesLabel||'Confirm';
  const m=document.getElementById('confirmModal'); if(m)m.classList.add('on');
}
/**
 * Closes the shared confirm modal and discards any pending confirm callback.
 */
function closeConfirm(){
  confirmPending=null;
  const m=document.getElementById('confirmModal'); if(m)m.classList.remove('on');
}
/**
 * Runs the pending confirm-modal callback, if any, after closing the modal.
 */
async function doConfirm(){
  const fn=confirmPending; closeConfirm();
  if(fn)await fn();
}
/**
 * Converts a hex string into space-separated byte pairs.
 * @param h Hex string.
 * @returns Space-separated hex byte string.
 */
function hexSpaced(h){h=(h||'').trim();let out='';for(let i=0;i+1<h.length;i+=2)out+=(out?' ':'')+h.substr(i,2);return out;}
/**
 * Renders the SSID table-cell markup: an "unprintable" badge with the raw bytes as a
 * hex tooltip when the SSID failed to decode as text, else the escaped SSID or empty string.
 * @param ssid Decoded SSID text.
 * @param ssidbad Whether the SSID element failed to decode as valid text.
 * @param ssidhex Raw SSID bytes as hex, shown in the unprintable tooltip.
 * @returns HTML string for the cell.
 */
function ssidHtml(ssid,ssidbad,ssidhex){
  if(ssidbad) return `<span class="unprint" title="SSID is not valid text — raw bytes: ${esc(hexSpaced(ssidhex))}">&#8249;unprintable&#8250;</span>`;
  return ssid?esc(ssid):'';
}
/**
 * Formats a duration in seconds as a compact string (s, m[s], or h[m]).
 * @param s Duration in seconds.
 * @returns Formatted duration string.
 */
function fmtDur(s){s=s|0;if(s<60)return s+'s';const m=(s/60)|0,ss=s%60;
  if(m<60)return m+'m'+(ss?ss+'s':'');const h=(m/60)|0,mm=m%60;return h+'h'+(mm?mm+'m':'');}
/**
 * Comparator for sorting device rows by a given key and direction.
 * Aliases 'rssiMinMax' to the 'min' field, compares 'clients' by associated-station
 * count via beaconClients(), and does case-insensitive comparison for string fields.
 * @param a First row.
 * @param b Second row.
 * @param k Sort key.
 * @param dir Sort direction multiplier (1 or -1).
 * @returns Negative, zero, or positive per standard comparator contract.
 */
function cmp(a,b,k,dir){
  if(k==='rssiMinMax')k='min';
  let x,y;
  if(k==='clients'){x=beaconClients(a).length; y=beaconClients(b).length;}
  else{x=a[k]; y=b[k];}
  if(typeof x==='string'){x=x.toLowerCase();y=(y||'').toLowerCase();}
  return (x<y?-1:x>y?1:0)*dir;
}
/**
 * Renders the vendor table cell: the resolved vendor name, or an "(unknown OUI)" /
 * "(random addr)" placeholder when no vendor is known.
 * @param r Device/record with vendor/oui fields.
 * @returns HTML string for the cell.
 */
function vendorCell(r){
  if(r.vendor) return esc(r.vendor);
  return r.oui ? '<span class="muted">(unknown OUI)</span>'
               : '<span class="muted">(random addr)</span>';
}
let ouiMap={};
const OUI_DB='ssoui', OUI_STORE='kv', OUI_KEY='ouimap';
/**
 * Opens (creating on first use) the browser's IndexedDB database used to persist
 * the imported OUI vendor map.
 * @returns Promise resolving to the open IDBDatabase.
 */
function ouiDbOpen(){return new Promise((res,rej)=>{
  const r=indexedDB.open(OUI_DB,1);
  r.onupgradeneeded=()=>r.result.createObjectStore(OUI_STORE);
  r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);});}
/**
 * Loads the persisted OUI vendor map from IndexedDB into ouiMap and updates the
 * OUI-count display. Leaves ouiMap unchanged on error.
 */
async function ouiLoad(){try{
  const db=await ouiDbOpen();
  const m=await new Promise((res,rej)=>{const t=db.transaction(OUI_STORE).objectStore(OUI_STORE).get(OUI_KEY);
    t.onsuccess=()=>res(t.result); t.onerror=()=>rej(t.error);});
  if(m&&typeof m==='object')ouiMap=m;
}catch(e){} updateOuiCount();}
/**
 * Persists the in-memory ouiMap to IndexedDB.
 * @returns Promise resolving once the write transaction completes.
 */
async function ouiSave(){const db=await ouiDbOpen();
  return new Promise((res,rej)=>{const t=db.transaction(OUI_STORE,'readwrite');
    t.objectStore(OUI_STORE).put(ouiMap,OUI_KEY); t.oncomplete=()=>res(); t.onerror=()=>rej(t.error);});}
/**
 * Updates the #ouiCount element with the number of loaded OUI prefixes, or a
 * "firmware subset only" message when none are imported.
 */
function updateOuiCount(){const c=document.getElementById('ouiCount'); if(!c)return;
  const n=Object.keys(ouiMap).length;
  c.textContent=n?n.toLocaleString()+' prefixes':'none (firmware subset only)';}
/**
 * Looks up a vendor name for a MAC address in the imported ouiMap, trying /36, /28,
 * then /24 prefix lengths.
 * @param mac MAC address string.
 * @returns Vendor name, or null if mac is falsy, too short, or not found.
 */
function ouiVendor(mac){ if(!mac)return null;
  const h=mac.replace(/[^0-9a-fA-F]/g,'').toUpperCase(); if(h.length<6)return null;
  return ouiMap[h.slice(0,9)]||ouiMap[h.slice(0,7)]||ouiMap[h.slice(0,6)]||null;}
/**
 * Splits one CSV line into fields, honouring double-quoted fields and escaped ("")
 * quotes within them.
 * @param line CSV line text.
 * @returns Array of field strings.
 */
function csvSplit(line){const out=[];let cur='',q=false;
  for(let i=0;i<line.length;i++){const c=line[i];
    if(q){if(c==='"'){if(line[i+1]==='"'){cur+='"';i++;}else q=false;}else cur+=c;}
    else if(c==='"')q=true; else if(c===','){out.push(cur);cur='';} else cur+=c;}
  out.push(cur); return out;}
/**
 * Parses one line of an OUI source file into a [hexPrefix, vendorName] entry.
 * Handles the IEEE MA-L/MA-M/MA-S CSV format, its "registry," header line, and the
 * Wireshark manuf tab/space-delimited format (with optional "/bits" prefix length).
 * @param line Raw line from the imported OUI file.
 * @returns [hexPrefix, vendorName] tuple, or null if the line is unusable (comment,
 * header, malformed, too short a prefix, or no vendor name).
 */
function parseOuiLine(line){
  line=line.replace(/\r$/,''); if(!line||line[0]==='#')return null;
  if(/^MA-[LMS],/i.test(line)){
    const f=csvSplit(line); if(f.length<3)return null;
    const hx=f[1].replace(/[^0-9a-fA-F]/g,'').toUpperCase(), v=(f[2]||'').trim();
    return (hx.length>=6&&v)?[hx,v]:null;}
  if(/^registry\s*,/i.test(line))return null;
  let p=line.split('\t'); if(p.length<2)p=line.trim().split(/\s{2,}/);
  if(p.length<2)p=line.trim().split(/\s+/);
  const addr=(p[0]||'').trim(); if(!addr)return null;
  const mm=addr.split('/'), hxAll=mm[0].replace(/[^0-9a-fA-F]/g,'').toUpperCase();
  if(hxAll.length<6)return null;
  const nib=Math.max(6,Math.ceil((mm[1]?parseInt(mm[1],10):24)/4));
  const v=(p.length>=3?(p[2].trim()||p[1].trim()):p.slice(1).join(' ').trim());
  return v?[hxAll.slice(0,nib),v]:null;}
/**
 * Reads a user-selected OUI source file, parses it in chunks (yielding to the event
 * loop periodically to avoid blocking), replaces ouiMap with the parsed entries,
 * persists it to IndexedDB, and refreshes the OUI-count display and data view.
 * @param inp File input element holding the selected file.
 */
async function importOui(inp){
  const file=inp.files&&inp.files[0]; inp.value=''; if(!file)return;
  const st=document.getElementById('ouiStatus');
  if(st)st.textContent='Reading '+file.name+' …';
  let text; try{text=await file.text();}catch(e){if(st)st.textContent='Read failed: '+e;return;}
  const lines=text.split('\n'), map={}; let added=0;
  for(let i=0;i<lines.length;i++){
    const r=parseOuiLine(lines[i]); if(r){map[r[0]]=r[1];added++;}
    if((i&8191)===0){ if(st)st.textContent='Parsing… '+added.toLocaleString()+' entries';
      await new Promise(r=>setTimeout(r)); }
  }
  if(!added){if(st)st.textContent='No OUI rows found — expects an IEEE oui.csv or Wireshark manuf file.';return;}
  ouiMap=map; updateOuiCount();
  try{await ouiSave();}catch(e){if(st){st.textContent='Parsed '+added.toLocaleString()+' but save failed: '+e;return;}}
  if(st)st.textContent='Imported '+added.toLocaleString()+' vendor prefixes.';
  tick();}
/**
 * Clears the in-memory and IndexedDB-persisted OUI vendor map, then refreshes the
 * OUI-count display and data view.
 */
async function clearOui(){ouiMap={};updateOuiCount();
  const s=document.getElementById('ouiStatus'); if(s)s.textContent='Imported DB cleared.';
  try{const db=await ouiDbOpen();
    db.transaction(OUI_STORE,'readwrite').objectStore(OUI_STORE).delete(OUI_KEY);}catch(e){}
  tick();}
/**
 * Builds a compact local-time timestamp (YYYYMMDD-HHMMSS) for use in export filenames.
 * @returns Timestamp string.
 */
function ioStamp(){const d=new Date(),p=n=>String(n).padStart(2,'0');
  return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds());}
/**
 * Fetches the current /api/data snapshot and assembles it into an export/session
 * object, using the scout WiFi aggregate list when active, else the plain wifi[] array.
 * @param wifi Whether to include the WiFi section (wifi/assoc/deauth/handshake) in the output.
 * @returns The assembled export object, or null if the /api/data fetch/parse failed.
 */
async function buildExportBlob(wifi){
  let d; try{d=await(await fetch('/api/data')).json();}catch(e){return null;}
  const wifiRecs=(d.clientAgg&&d.scout&&typeof wifiAggAry==='function')?wifiAggAry():(d.wifi||[]);
  const out={app:'802Eleven',version:1,exported:new Date().toISOString()};
  if(wifi)out.wifi={wifi:wifiRecs,assoc:d.assoc||[],deauth:d.deauth||[],handshake:d.handshake||[]};
  return out;
}
/**
 * Builds an export blob per the #expWifi checkbox and triggers a browser download of
 * it as a timestamped JSON file, reporting the record count in #ioStatus. When
 * #expFormat (if present) is set to a non-'json' value, delegates to that
 * format's own exporter instead (currently just 'wigle', see exportGpsSessionWigle_) --
 * those pull from a different on-SD source, not the live snapshot this builds.
 */
async function exportData(){
  const st=document.getElementById('ioStatus');
  const fmt=document.getElementById('expFormat')?.value||'json';
  if(fmt==='wigle'){await exportGpsSessionWigle_(st);return;}
  const wifi=document.getElementById('expWifi')?.checked??true;

  if(!wifi){if(st)st.textContent='Tick WiFi to export.';return;}
  if(st)st.textContent='Fetching snapshot from device…';
  const out=await buildExportBlob(wifi);
  if(!out){if(st)st.textContent='Export failed.';return;}
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(out)],{type:'application/json'}));
  a.download='802eleven-'+ioStamp()+'.json'; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000);
  const bits=[]; if(out.wifi)bits.push(out.wifi.wifi.length+' WiFi');
  if(st)st.textContent='Exported '+bits.join(' + ')+' records.';
}
/**
 * Builds an export blob and POSTs it to /api/session/save to persist a session file
 * on the device's SD card.
 * @param label Optional label appended as a query parameter to the save request.
 * @returns True on success, false on failure/exception, or 401 if unauthenticated.
 */
async function archiveSession(label){
  try{
    const out=await buildExportBlob(true);
    if(!out)return false;
    let url='/api/session/save';
    if(label)url+='?label='+encodeURIComponent(label);
    const r=await fetch(url,{method:'POST',body:JSON.stringify(out)});
    if(r.status===401)return 401;
    const j=await r.json().catch(()=>({ok:false}));
    return !!j.ok;
  }catch(e){return false;}
}
const AUTOSAVE_MS=3*60*1000, AUTOSAVE_KEEP=3;
/**
 * Deletes the oldest "_auto.json" session files beyond AUTOSAVE_KEEP, based on the
 * current /api/session/list contents. No-op if there's no SD card or file list.
 */
async function pruneAutosaves(){
  try{
    const d=await(await fetch('/api/session/list')).json();
    if(!d.sd||!d.files)return;
    const autos=d.files.filter(f=>f.name.indexOf('_auto.json')>=0).sort((a,b)=>a.name<b.name?-1:1);
    while(autos.length>AUTOSAVE_KEEP){
      const f=autos.shift();
      await fetch('/api/session/delete',{method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:'name='+encodeURIComponent(f.name)});
    }
  }catch(e){}
}
/**
 * Periodic autosave tick (driven by setInterval). Skips while live polling is off or
 * a capture is running; otherwise archives an "auto" session and prunes old autosaves
 * on success.
 */
async function autosaveTick(){
  if(!liveOn||capturing)return;
  const ok=await archiveSession('auto');
  if(ok===true)pruneAutosaves();
}
setInterval(autosaveTick,AUTOSAVE_MS);
/**
 * Applies an imported or loaded session/export object as the current live view:
 * rebuilds the WiFi/assoc/deauth/handshake state, re-renders the deauth/handshake and
 * channel-density tabs if active, redraws the radar and devices table, and reports the
 * import result in #ioStatus.
 * @param o Session/export object shaped {wifi:{wifi,assoc,deauth,handshake}, exported}.
 */
function applyImport(o){
  const st=document.getElementById('ioStatus');
  const wifi = !!o.wifi;
  if(wifi){
    lastWifi=o.wifi.wifi||[]; buildAssoc(o.wifi.assoc||[]); lastDeauth=o.wifi.deauth||[];
    lastHandshake=o.wifi.handshake||[];
    lastDevs=wifiToDevs(lastWifi);
    syncGpsFocusUI();
    const hde=document.getElementById('hde'),hde2=document.getElementById('hde2');
    const authN=lastDeauth.length+lastHandshake.length;
    if(hde)hde.textContent=authN; if(hde2)hde2.textContent=authN;
    if(curView==='deauth'){renderDeauth();renderHandshakes();loadHsRam();} if(curView==='chan')drawChanDensity();
  }
  updateRefInfo(lastDevs);
  document.getElementById('hd').textContent=lastDevs.length;
  const hd2=document.getElementById('hd2'); if(hd2)hd2.textContent=lastDevs.length;
  drawRadar(lastDevs); renderDevices();
  const when=o.exported?(' ('+o.exported.replace('T',' ').slice(0,19)+'Z)'):'';
  if(st)st.textContent='Imported '+lastDevs.length+' WiFi records'+when+'. Live paused — toggle Live to resume.';
}
/**
 * Reads a user-selected export JSON file, validates its app/wifi shape, pauses live
 * polling, and applies it via applyImport().
 * @param inp File input element holding the selected file.
 */
async function importData(inp){
  const file=inp.files&&inp.files[0]; inp.value=''; if(!file)return;
  const st=document.getElementById('ioStatus');
  if(st)st.textContent='Reading '+file.name+' …';
  let o; try{o=JSON.parse(await file.text());}
  catch(e){if(st)st.textContent='Not valid JSON: '+e;return;}
  if(!o||o.app!=='802Eleven'||!o.wifi){
    if(st)st.textContent='Unrecognised file — expects a 802Eleven export.';return;}
  if(liveOn)toggleLive();
  importedSnap=o;
  applyImport(o);
}
let lastSessionFiles=[];
/**
 * Derives a display label for a saved session filename, distinguishing WiFi scans
 * from full sessions by their "wscan_" prefix.
 * @param name Session/scan filename.
 * @returns Display label ("Scan: <name>" or "Session: <name>").
 */
function sessionLabel(name){ return (name.startsWith('wscan_')?'Scan: ':'Session: ')+name; }
/**
 * Fetches /api/session/list and repopulates the session dropdown, showing an
 * appropriate empty-state message when there's no SD card or no saved files.
 */
async function refreshSessionList(){
  const box=document.getElementById('sessList'); const sel=document.getElementById('sessSel');
  const row=document.getElementById('sessSelRow'); if(!box||!sel)return;
  closeConfirm();
  try{
    const d=await(await fetch('/api/session/list')).json();
    lastSessionFiles=[];
    if(!d.sd){box.innerHTML='No SD card on this board — sessions need a microSD slot.';if(row)row.style.display='none';return;}
    if(!d.files||!d.files.length){box.innerHTML='No saved sessions yet.';if(row)row.style.display='none';return;}
    lastSessionFiles=d.files;
    sel.innerHTML=d.files.map(f=>`<option value="${esc(f.name)}">${esc(sessionLabel(f.name))} (${fmtBytes(f.size)})</option>`).join('');
    if(row)row.style.display=''; box.innerHTML='';
  }catch(e){box.innerHTML='Error loading session list.';if(row)row.style.display='none';}
}
/**
 * Loads a named saved session (or WiFi scan) from the device, pauses live polling,
 * and applies it as the current view.
 * @param name Session/scan filename to load.
 */
async function loadSession(name){
  const st=document.getElementById('ioStatus'); if(st)st.textContent='Loading '+name+'…';
  try{
    const url=(name.startsWith('wscan_')?'/api/session/wifiscan?name=':'/api/session/load?name=')+encodeURIComponent(name);
    const o=await(await fetch(url)).json();
    if(!o||o.app!=='802Eleven'){if(st)st.textContent='Corrupt session file.';return;}
    if(liveOn)toggleLive();
    importedSnap=o;
    applyImport(o);
    if(st)st.textContent='Loaded session '+name+'.';
  }catch(e){if(st)st.textContent='Error loading session.';}
}
/**
 * Loads whichever session is currently selected in the #sessSel dropdown.
 */
async function loadSelectedSession(){
  const sel=document.getElementById('sessSel'); if(sel&&sel.value)await loadSession(sel.value);
}
/**
 * Opens the confirm modal to delete the currently selected session.
 */
function requestDeleteSession(){
  const sel=document.getElementById('sessSel'); if(!sel||!sel.value)return;
  const name=sel.value;
  openConfirm('Delete "'+esc(name)+'"? This cannot be undone.','Delete',()=>doDeleteSession(name));
}
/**
 * Deletes a named session file via /api/session/delete and refreshes the session list.
 * @param name Session filename to delete.
 */
async function doDeleteSession(name){
  try{await fetch('/api/session/delete',{method:'POST',body:'name='+encodeURIComponent(name)});}catch(e){}
  refreshSessionList();
}
/**
 * Opens the confirm modal to delete every currently listed session file.
 */
function requestDeleteAllSessions(){
  if(!lastSessionFiles.length)return;
  openConfirm('Delete all '+lastSessionFiles.length+' sessions? This cannot be undone.','Delete all',doDeleteAllSessions);
}
/**
 * Deletes every session file currently in lastSessionFiles, then refreshes the
 * session list.
 */
async function doDeleteAllSessions(){
  for(const f of lastSessionFiles.slice()){
    try{await fetch('/api/session/delete',{method:'POST',body:'name='+encodeURIComponent(f.name)});}catch(e){}
  }
  refreshSessionList();
}

/**
 * Merges duplicate-MAC rows from a raw log/scan row array into one row per MAC:
 * sums cnt/life, widens min/max, and keeps the latest rssi/avg/ch/kind/vendor/rnd
 * and (if present) ssid/lat/lon.
 * @param arr Array of raw row objects (possibly containing repeat MACs).
 * @returns Array of merged rows, one per MAC.
 */
function mergeWifiLogRows(arr){
  const m=new Map();
  for(const x of arr){
    const p=m.get(x.mac);
    if(!p){m.set(x.mac,Object.assign({},x));continue;}
    p.cnt=(p.cnt||0)+(x.cnt||0);
    p.life=(p.life||0)+(x.life||0);
    if(x.min<p.min)p.min=x.min;
    if(x.max>p.max)p.max=x.max;
    p.rssi=x.rssi; p.avg=x.avg; p.ch=x.ch; p.kind=x.kind;
    p.vendor=x.vendor; p.rnd=x.rnd;
    if(x.ssid||x.ssidbad){p.ssid=x.ssid;p.ssidbad=x.ssidbad;p.ssidhex=x.ssidhex;}
    if(x.lat!==undefined&&x.lon!==undefined){p.lat=x.lat;p.lon=x.lon;}
  }
  return Array.from(m.values());
}
/**
 * Loads the SD-backed evicted-WiFi-record log (/api/session/wifilog), merges
 * duplicate MACs, pauses live polling, and applies it as the current view.
 */
async function loadWifiLog(){
  const st=document.getElementById('wlogStatus'); if(st)st.textContent='Loading log…';
  try{
    const r=await fetch('/api/session/wifilog');
    if(r.status===404){if(st)st.textContent='No log on this card yet (or no SD card).';return;}
    const o=await r.json();
    if(!o||o.app!=='802Eleven'){if(st)st.textContent='Corrupt log.';return;}
    if(o.wifi&&o.wifi.wifi)o.wifi.wifi=mergeWifiLogRows(o.wifi.wifi);
    if(liveOn)toggleLive();
    importedSnap=o;
    applyImport(o);
    if(st)st.textContent='Loaded '+((o.wifi&&o.wifi.wifi)?o.wifi.wifi.length:0)+
      ' evicted records. RSSI shown is last-seen, not avg; age/life are approximate. Live paused.';
  }catch(e){if(st)st.textContent='Error loading log.';}
}
/**
 * Clears the SD-backed evicted-WiFi-record log via /api/session/wifilog/clear.
 */
async function clearWifiLog(){
  const st=document.getElementById('wlogStatus');
  try{
    const r=await(await fetch('/api/session/wifilog/clear',{method:'POST'})).json();
    if(st)st.textContent=r.ok?'Log cleared.':('Clear failed: '+(r.err||'?'));
  }catch(e){if(st)st.textContent='Error clearing log.';}
}

/**
 * Loads the raw SD scout-capture stream (/api/session/wifisync), re-ingests it line
 * by line into the client-side WiFi aggregate maps, pauses live polling, and applies
 * the result as the current view.
 */
async function loadSdWifiCapture(){
  const st=document.getElementById('ioStatus');
  if(st)st.textContent='Loading SD capture…';
  try{
    const txt=await(await fetch('/api/session/wifisync')).text();
    wifiClientAgg.clear();
    wifiAggAssoc.clear();
    if(txt) txt.split('\n').forEach(l=>{ if(l) ingestRawWifiLine(l); });
    if(!wifiClientAgg.size){ if(st)st.textContent='No SD capture found (no card, or nothing captured yet).'; return; }
    const o={app:'802Eleven', wifi:{wifi:wifiAggAry(), assoc:wifiAggAssocAry(), deauth:[]}};
    if(liveOn)toggleLive();
    importedSnap=o;
    wifiAggActive=true;
    applyImport(o);
  }catch(e){ if(st)st.textContent='Error loading SD capture.'; }
}

/**
 * Sorts (unless presorted) and renders rows into the tbody of table #id, flashing
 * newly-seen rows, marking the selected/client rows, and (for the devices table)
 * recording the resulting row MAC order into devRowOrder.
 * @param id Table element id.
 * @param rows Row data to render.
 * @param sort {k,dir} sort spec, used only when presorted is falsy.
 * @param key A field name, or a function(row) returning the dedupe/"seen" key.
 * @param cols Function(row) returning the row's inner `<td>` markup.
 * @param seen Map of previously-seen keys; mutated to mark rows as seen (drives the flash animation).
 * @param presorted Whether rows are already sorted (skips re-sorting).
 */
function render(id,rows,sort,key,cols,seen,presorted){
  if(!presorted) rows.sort((a,b)=>cmp(a,b,sort.k,sort.dir));
  const tb=document.querySelector('#'+id+' tbody');
  tb.innerHTML=rows.map(r=>{
    const k=(typeof key==='function')?key(r):r[key], fresh=!seen[k]; seen[k]=1;
    const sel=id==='dt'&&r.mac&&r.mac===selMac?' krow':'';
    const cli=(r.kind==='client'||r._child)?' trCli':'';
    return `<tr class="${fresh?'flash':''}${sel}${cli}"${r.mac?` data-mac="${esc(r.mac)}"`:''}${r._netGroup?` data-net="${esc(r.ssid)}"`:''}>`+cols(r)+`</tr>`;
  }).join('');
  if(id==='dt') devRowOrder=rows.map(r=>r.mac).filter(Boolean);
}
/**
 * Checks whether an element carries the 'on' class.
 * @param id Element id.
 * @returns True if the element exists and has class 'on'.
 */
function on(id){const b=document.getElementById(id);return !!(b&&b.classList.contains('on'));}
/**
 * Toggles an element's 'on' class and redraws the radar.
 * @param id Element id.
 */
function tgl(id){const b=document.getElementById(id);if(!b)return;b.classList.toggle('on');drawRadar(lastDevs);}
/**
 * Checks whether a device type string denotes a randomised (locally-administered) MAC.
 * @param t Device type string.
 * @returns True for 'RND' or 'RID'.
 */
function isRnd(t){return t==='RND'||t==='RID';}
/**
 * Always false — this radar/table view is a live capture, not an aging store, so
 * there is no idle/inactive concept.
 * @returns false.
 */
function isInactive(){return false;}
/**
 * Merges randomised-MAC WiFi clients probing for the same named SSID into one
 * representative row (RSSI-averaged, min/max widened, count summed); every other
 * device row is passed through unchanged.
 * @param devs Device rows to collapse.
 * @returns New array with same-SSID WiFi-client rows merged.
 */
function collapseDevs(devs){
  const g={}, out=[];
  devs.forEach(d=>{
    let key,kind;
    if(d._wifi && d.type==='RND' && d.kind==='probe' && d.ssid){
      key='wifissid:'+d.ssid;
      kind='WiFi client';
    }else{ out.push(d); return; }
    (g[key]=g[key]||{m:[],kind:kind})&&g[key].m.push(d);
  });
  Object.keys(g).forEach(k=>{
    const m=g[k].m, rep=m.reduce((a,b)=>a.rssi>b.rssi?a:b);
    if(m.length===1){out.push(Object.assign({_key:k,_kind:g[k].kind},m[0]));return;}
    let cnt=0,sum=0,mn=127,mx=-128,age=1e9,life=0,name='';
    m.forEach(d=>{cnt+=d.cnt;sum+=d.avg;mn=Math.min(mn,d.min);mx=Math.max(mx,d.max);
                  age=Math.min(age,d.age);life=Math.max(life,d.life||0);name=name||d.name;});
    out.push({mac:rep.mac,type:rep.type,rssi:rep.rssi,avg:Math.round(sum/m.length),
              min:mn,max:mx,cnt,age,life,oui:rep.oui,vendor:rep.vendor,
              name,_grp:m.length,_key:k,_kind:g[k].kind,
              _wifi:rep._wifi,kind:rep.kind,ssid:rep.ssid,hid:rep.hid,ch:rep.ch,rnd:rep.rnd,
              sec:rep.sec,cip:rep.cip,pmf:rep.pmf,secie:rep.secie,sta:rep.sta});
  });
  return out;
}
let expandedNetworks=new Set();
/**
 * Groups beacon rows sharing the same SSID (multi-BSSID networks) into a single
 * `_netGroup` summary row (aggregated station count, count, age/life, min/max RSSI,
 * and channel set); rows whose SSID has only one AP pass through unchanged.
 * @param rows Device rows (post-collapseDevs) to group.
 * @returns New array with multi-AP networks replaced by their group row; the input
 * array itself if no SSID has more than one AP.
 */
function groupNetworks(rows){
  const bySsid={};
  rows.forEach(r=>{
    if(r.kind!=='beacon'||!r.ssid) return;
    (bySsid[r.ssid]=bySsid[r.ssid]||[]).push(r);
  });
  const grouped=new Set();
  Object.keys(bySsid).forEach(ssid=>{ if(bySsid[ssid].length>1) bySsid[ssid].forEach(m=>grouped.add(m)); });
  if(!grouped.size) return rows;
  const out=[];
  Object.keys(bySsid).forEach(ssid=>{
    const members=bySsid[ssid]; if(members.length<2) return;
    const rep=members.reduce((a,b)=>a.rssi>b.rssi?a:b);
    let sta=0,cnt=0,age=1e9,life=0,mn=127,mx=-128; const chans=new Set();
    members.forEach(m=>{sta+=m.sta||0;cnt+=m.cnt;age=Math.min(age,m.age);life=Math.max(life,m.life||0);
      mn=Math.min(mn,m.min);mx=Math.max(mx,m.max); if(m.ch)chans.add(m.ch);});
    out.push({_netGroup:true,_key:'net:'+ssid,mac:'',name:ssid,ssid,kind:'beacon',
      rssi:rep.rssi,avg:rep.avg,min:mn,max:mx,cnt,age,life,sta,
      _chans:[...chans].sort((a,b)=>a-b),ch:'',hid:members.some(m=>m.hid),
      sec:rep.sec,cip:rep.cip,pmf:rep.pmf,secie:rep.secie,rnd:false,oui:false,vendor:'',
      _members:members.slice().sort((a,b)=>b.rssi-a.rssi)});
  });
  rows.forEach(r=>{ if(!grouped.has(r)) out.push(r); });
  return out;
}
/**
 * Filters device rows by signal strength: within ±band of a reference RSSI when a
 * reference device is focused (onlyNear), else by an absolute RSSI floor.
 * @param rows Device rows to filter.
 * @param refRssi RSSI of the focused reference device, or null/undefined.
 * @param band Allowed deviation from refRssi when focused, or the floor magnitude otherwise.
 * @returns Filtered rows.
 */
function signalFilter(rows,refRssi,band){
  if(refRssi!=null && onlyNear)
    return rows.filter(d=>d.mac===refMac||Math.abs(d.avg-refRssi)<=band);
  return rows.filter(d=>d.avg>=-band);
}
const BAND_MODES={
  sig: {min:0,max:100,step:1,val:100,lbl:'signal range ±',unit:'dB'},
  seen:{min:0,step:5,lbl:'last seen ≤',unit:'s',dyn:'hi',fld:'age'},
  age: {min:0,step:5,lbl:'alive ≥',    unit:'s',dyn:'lo',fld:'life'},
  cnt: {min:1,max:100,step:1,val:1,lbl:'min count',unit:''},
  ch:  {min:0,max:13, step:1,val:0,lbl:'channel',  unit:''},
  gps: {min:0,max:2000,step:25,val:300,lbl:'distance from GPS focus ≤',unit:'m'}
};
let bandMode='sig';
/**
 * Reads the current numeric value of the #band range input.
 * @returns Current slider value.
 */
function bandVal(){return +document.getElementById('band').value;}
/**
 * Maps a band-slider "channel" mode value to a real WiFi channel number, resolving
 * values beyond 13 through the 5GHz channel table (WIFI_5G_CH).
 * @param v Slider value.
 * @returns Channel number, or 0 if out of range.
 */
function chSliderChan(v){ return v<=13 ? v : (WIFI_5G_CH[v-14]||0); }
/**
 * Formats the band slider's readout label for the current mode/value, showing
 * 'all'/'any' for unbounded settings in channel/age/seen modes.
 * @param m Active band mode key.
 * @param v Slider value.
 * @returns Readout text.
 */
function bandReadout(m,v){
  if(m==='gps') return gpsFocus ? ''+v : 'no focus set';
  if(m==='ch')  return v===0 ? 'all' : ''+chSliderChan(v);
  if(m==='age'&&v===0) return 'any';
  if(m==='seen'){const s=document.getElementById('band');
    if(s&&v>=+s.max) return 'any';}
  return ''+v;
}
/**
 * Computes the band slider's max value for channel mode, extended to include the
 * 5GHz channel table when scout dual-band capture is active.
 * @returns Maximum slider value.
 */
function chSliderMax(){ return 13 + (scoutDualBand ? WIFI_5G_CH.length : 0); }
/**
 * Computes a rounded-up ceiling for a dynamic band mode's slider max, based on the
 * largest current value of its backing field (age/life) across lastDevs.
 * @param m Band mode key.
 * @returns Ceiling value (at least 60, rounded up to the mode's step).
 */
function bandCeil(m){
  const c=BAND_MODES[m]; let mx=0;
  (lastDevs||[]).forEach(d=>{mx=Math.max(mx,+d[c.fld]||0);});
  return Math.max(60, Math.ceil(mx/c.step)*c.step);
}
/**
 * Grows the band slider's max for the active dynamic mode when the data now exceeds
 * it, moving the handle to the new max if it was already pinned at the old max.
 */
function growBandMax(){
  const c=BAND_MODES[bandMode]; if(!c||!c.dyn)return;
  const s=document.getElementById('band'), dm=bandCeil(bandMode);
  if(dm>+s.max){
    const wasMax=(+s.value>=+s.max);
    s.max=dm;
    if(wasMax){s.value=dm; c.val=dm; document.getElementById('bandL').textContent=bandReadout(bandMode,dm);}
  }
}
/**
 * Handles the band slider's input event: stores the mode's value, updates the
 * readout label, and redraws the radar.
 */
function onBandInput(){
  const v=bandVal(); BAND_MODES[bandMode].val=v;
  document.getElementById('bandL').textContent=bandReadout(bandMode,v);
  drawRadar(lastDevs);
}
/**
 * Switches the active band-filter mode: reconfigures the slider's min/max/step/value
 * and label/unit for the new mode, updates the mode-picker UI, and redraws the radar.
 * @param m Band mode key to switch to; no-op if unknown or already the active mode.
 */
function setBandMode(m){
  if(!BAND_MODES[m]||m===bandMode){return;}
  BAND_MODES[bandMode].val=bandVal();
  bandMode=m; const c=BAND_MODES[m], s=document.getElementById('band');
  s.min=c.min; s.step=c.step;
  if(c.dyn){
    const mx=bandCeil(m); s.max=mx;
    if(c.val==null) c.val=(c.dyn==='hi')?mx:c.min;
    s.value=Math.min(c.val, mx);
  }else{ s.max=(m==='ch')?chSliderMax():c.max; s.value=c.val; }
  document.getElementById('bandLbl').innerHTML=c.lbl;
  document.getElementById('bandUnit').textContent=c.unit;
  document.getElementById('bandL').textContent=bandReadout(m,+s.value);
  document.querySelectorAll('#bandModes button').forEach(b=>b.classList.toggle('on',b.dataset.bm===m));
  document.getElementById('bandModeCur').textContent=m.toUpperCase();
  document.getElementById('bandModes').classList.remove('open');
  drawRadar(lastDevs);
}
/**
 * Toggles the open/closed state of the band-mode picker dropdown.
 */
function toggleBandModes(){document.getElementById('bandModes').classList.toggle('open');}
const SEARCH_NUM={rssi:'rssi',avg:'avg',cnt:'cnt',age:'age',ch:'ch',min:'min',max:'max',sta:'sta',life:'life'};
const SEARCH_STR={mac:'mac',vendor:'vendor',type:'type',kind:'kind',ssid:'name',name:'name'};
/**
 * Resolves a device's display name.
 * @param d Device row.
 * @returns d.ssid, falling back to d.name, or empty string if neither is set.
 */
function devName(d){return d.ssid||d.name||'';}
/**
 * Builds a case-insensitive substring-match predicate over a field extractor.
 * @param get Function(device) returning the field value to test.
 * @param val Substring to search for.
 * @returns Predicate function(device) -> boolean.
 */
function subPred(get,val){const v=val.toLowerCase();
  return d=>String(get(d)||'').toLowerCase().includes(v);}
/**
 * Builds a numeric comparison predicate (supports >, <, >=, <=, = prefixes, default =)
 * over a device field.
 * @param field Device field name to compare.
 * @param val Comparison expression, e.g. '>-70' or '5'.
 * @returns Predicate function(device) -> boolean, or null if val isn't a valid numeric expression.
 */
function numPred(field,val){
  const m=String(val).match(/^(>=|<=|>|<|=)?\s*(-?\d+)$/); if(!m)return null;
  const op=m[1]||'=', n=+m[2];
  return d=>{const x=+d[field]; if(isNaN(x))return false;
    return op==='>'?x>n:op==='<'?x<n:op==='>='?x>=n:op==='<='?x<=n:x===n;};
}
/**
 * Parses one search-box token into a predicate. Supports 'field:value' syntax for
 * kind (including a special 'station'/'sta' associated-client match), sec/cip
 * (security/cipher label substring match, beacons only), the generic numeric/string
 * field maps, a bare MAC-like token (containing ':'), or a plain name substring match.
 * @param tok Search token, optionally prefixed with 'field:'.
 * @returns Predicate function(device) -> boolean.
 */
function tokPred(tok){
  const i=tok.indexOf(':'), field=i>0?tok.slice(0,i).toLowerCase():'';
  if(i>0 && field==='kind'){
    const val=tok.slice(i+1).toLowerCase();
    if(val==='station'||val==='sta') return d=>d.kind!=='beacon' && !!wifiClientAp[d.mac];
    return subPred(d=>d.kind,val);
  }
  if(i>0 && field==='sec' && typeof SEC_LABEL!=='undefined'){
    const val=tok.slice(i+1).toLowerCase();
    return d=>d.kind==='beacon' && (SEC_LABEL[d.sec||0]||'').toLowerCase().includes(val);
  }
  if(i>0 && field==='cip' && typeof CIP_LABEL!=='undefined'){
    const val=tok.slice(i+1).toLowerCase();
    return d=>d.kind==='beacon' && (CIP_LABEL[d.cip||0]||'').toLowerCase().includes(val);
  }
  if(i>0 && (SEARCH_NUM[field]||SEARCH_STR[field])){
    const val=tok.slice(i+1);
    if(SEARCH_NUM[field]) return numPred(SEARCH_NUM[field],val)||subPred(d=>d[SEARCH_NUM[field]],val);
    const key=SEARCH_STR[field];
    return key==='name'?subPred(devName,val):subPred(d=>d[key],val);
  }
  if(tok.includes(':')) return subPred(d=>d.mac,tok);
  return subPred(devName,tok);
}
/**
 * Splits a search-box query into whitespace-separated tokens and compiles each into
 * a predicate via tokPred().
 * @param q Raw search query string.
 * @returns Array of predicate functions; empty array for a blank query.
 */
function parseSearch(q){q=(q||'').trim(); if(!q)return [];
  return q.split(/\s+/).filter(Boolean).map(tokPred);}
/**
 * Opens or closes the device search popover (#devSearchPop), focusing its input
 * field when opened.
 */
function toggleDevSearch(){
  const pop=document.getElementById('devSearchPop'), btn=document.getElementById('devSearchBtn'),
        open=pop.style.display==='none';
  pop.style.display=open?'flex':'none';
  btn.classList.toggle('on',open);
  if(open)document.getElementById('devSearch').focus();
}
/**
 * Clears the device search box, re-renders the devices table (and radar if search
 * is synced to it), refocuses the search input, and triggers a quick data refresh.
 */
function clearDevSearch(){const el=document.getElementById('devSearch');
  el.value=''; renderDevices(); if(syncSearch)drawRadar(lastDevs); el.focus(); quickTick();}
/**
 * Closes whichever of the device-search or WiFi-filter popovers is currently open.
 * @returns True if a popover was closed, false if neither was open.
 */
function closeDevPopovers(){
  const sp=document.getElementById('devSearchPop');
  if(sp&&sp.style.display!=='none'){sp.style.display='none';
    const b=document.getElementById('devSearchBtn'); if(b)b.classList.remove('on'); return true;}
  const wp=document.getElementById('wifiFilterPop');
  if(wp&&wp.style.display!=='none'){wp.style.display='none';
    const b=document.getElementById('wifiFilterBtn'); if(b)b.classList.remove('on'); return true;}
  return false;
}
/**
 * Clears the radar box-select filter, the radar-sync toggle, and the search box,
 * then re-renders the devices table and radar and triggers a quick data refresh.
 */
function clearDevFilters(){boxSel=null; syncFromRadar=false;
  const el=document.getElementById('devSearch'); if(el)el.value='';
  const sb=document.getElementById('syncDevBtn'); if(sb)sb.classList.remove('on');
  renderDevices(); drawRadar(lastDevs); quickTick();}
/**
 * Builds and renders the current devices view: applies network grouping, client
 * collapsing, box-select/search/radar-sync/kind filters to lastDevs, updates the
 * active-filter status bar (#dfbar), and renders either the table (including
 * expanded network/AP client rows) or the card view depending on devView.
 */
function renderDevices(){
  let rows=groupNetworks(collapseDevs(lastDevs));
  if(boxSel) rows=rows.filter(d=>boxSel.has(d.mac)||(d._members&&d._members.some(m=>boxSel.has(m.mac))));
  const preds=parseSearch((document.getElementById('devSearch')||{}).value);
  if(preds.length) rows=rows.filter(d=>preds.every(p=>p(d)));
  if(syncFromRadar){
    const vis=new Set(radarFilter(lastDevs).map(d=>d.mac));
    rows=rows.filter(d=>vis.has(d.mac)||(d._members&&d._members.some(m=>vis.has(m.mac))));
  }
  const bar=document.getElementById('dfbar');
  if(bar){
    const kindFiltered=radarMode==='wifi'&&Object.values(wifiShow).some(v=>!v);
    const parts=[]; if(boxSel)parts.push('box filter'); if(preds.length)parts.push('search');
    if(syncFromRadar)parts.push('on radar'); if(kindFiltered)parts.push('kind filter');
    if(parts.length){
      bar.style.display='flex';
      bar.innerHTML=`<span>${parts.join(' + ')} &middot; <b>${rows.length}</b> devices</span>`+
        `<button onclick="${kindFiltered?'resetWifiFilters()':'clearDevFilters()'}">Show all</button>`;
    }else bar.style.display='none';
  }
  const tbl=devView==='table';
  document.getElementById('dtWrap').style.display=tbl?'':'none';
  document.getElementById('dcards').style.display=tbl?'none':'';
  if(tbl){
    rows.sort((a,b)=>cmp(a,b,dSort.k,dSort.dir));
    const withCli=[];
    rows.forEach(r=>{
      withCli.push(r);
      if(r._netGroup){
        if(expandedNetworks.has(r.ssid))
          r._members.forEach(m=>{
            withCli.push(Object.assign({_child:true,_key:'m:'+m.mac},m));
            if(expandedTableAPs.has(m.mac))
              beaconClients(m).forEach(cm=>withCli.push(clientRow(cm,m.mac)));
          });
        return;
      }
      if(r.kind==='beacon' && expandedTableAPs.has(r.mac))
        beaconClients(r).forEach(cm=>withCli.push(clientRow(cm,r.mac)));
    });
    render('dt',withCli,dSort,d=>d._key||d.mac,wifiCols,seenD,true);
  }else{
    renderCards(rows);
  }
}
const VIEW_ICON_TABLE='<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="5" x2="17" y2="5"/><line x1="3" y1="10" x2="17" y2="10"/><line x1="3" y1="15" x2="17" y2="15"/></svg>';
const VIEW_ICON_CARD='<svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor"><rect x="3" y="3" width="14" height="6" rx="1.5"/><rect x="3" y="11" width="14" height="6" rx="1.5"/></svg>';
/**
 * Toggles the devices display between table and card view.
 */
function toggleDevView(){ setDevView(devView==='table'?'card':'table'); }
/**
 * Switches between table and card device-list layouts.
 * Updates the `devView` global, the view-toggle button's icon/title, and re-renders the device list.
 * @param v New view mode, 'table' or 'card'.
 */
function setDevView(v){
  devView=v;
  const btn=document.getElementById('vwToggle');
  if(btn){
    const toCard=v==='table';
    btn.title=toCard?'card view - compact tiles that wrap to fit the screen, no horizontal scroll':'table view (scrolling rows)';
    btn.innerHTML=toCard?VIEW_ICON_CARD:VIEW_ICON_TABLE;
  }
  renderDevices();
}
/**
 * Renders the device list as cards into #dcards.
 * Sorts rows by the current device sort, expands grouped networks/beacon clients that are toggled open, and rebuilds `devRowOrder` from the rendered rows.
 * @param rows Device records to render.
 */
function renderCards(rows){
  rows.sort((a,b)=>cmp(a,b,dSort.k,dSort.dir));
  const wifi=radarMode==='wifi', box=document.getElementById('dcards');
  if(wifi){
    const withCli=[];
    rows.forEach(r=>{
      withCli.push(r);
      if(r._netGroup){
        if(expandedNetworks.has(r.ssid))
          r._members.forEach(m=>{
            withCli.push(Object.assign({_child:true,_key:'m:'+m.mac},m));
            if(expandedTableAPs.has(m.mac))
              beaconClients(m).forEach(cm=>withCli.push(clientRow(cm,m.mac)));
          });
        return;
      }
      if(r.kind==='beacon' && expandedTableAPs.has(r.mac))
        beaconClients(r).forEach(cm=>withCli.push(clientRow(cm,r.mac)));
    });
    rows=withCli;
  }
  box.innerHTML=rows.map(r=>{
    const k=r._key||r.mac, fresh=!seenD[k]; seenD[k]=1;
    const sel=r.mac&&r.mac===selMac?' krow':'';
    const cli=(r.kind==='client'||r._child)?' cli':'';
    return `<div class="card ${fresh?'flash':''}${sel}${cli}"${r.mac?` data-mac="${esc(r.mac)}"`:''}${r._netGroup?` data-net="${esc(r.ssid)}"`:''}>`+(wifi?wifiCard(r):devCard(r))+`</div>`;
  }).join('');
  devRowOrder=rows.map(r=>r.mac).filter(Boolean);
}

/**
 * Builds the associated-station expand/collapse button for a card, if the record has any.
 * @param r Device/AP record.
 * @returns Button HTML, or an empty string when there are no associated stations.
 */
function cardExpandBtn(r){
  const n=beaconClients(r).length; if(!n)return '';
  const open=expandedTableAPs.has(r.mac);
  return `<button class="expBtn${open?' on':''}" data-mac="${esc(r.mac)}" onclick="toggleApExpand(this.dataset.mac,event)"
    title="${open?'collapse':'expand'} ${n} associated station(s)">${open?'&#9660;':'&#9654;'} ${n} sta</button>`;
}
/**
 * Builds the card body HTML for a client/station row.
 * @param r Client record.
 * @returns Card inner HTML.
 */
function clientCard(r){
  return `<div class="ch"><span class="cm mac">&#8618; ${esc(r.mac)}</span></div>
    <div class="cbadges">${wifiKindBadge('client')}</div>
    <div class="ch"><span class="crssi">${r.rssi}<small> dBm</small></span></div>
    <div class="cg"><span>count</span><b>${r.cnt}</b><span>age</span><b>${r.age}s</b>
      <span>vendor</span><b>${vendorCell(r)}</b></div>`;
}
/**
 * Builds the card body HTML for a grouped-network row (multiple APs sharing one SSID).
 * @param r Network group record.
 * @returns Card inner HTML.
 */
function netCard(r){
  return `<div class="ch"><span class="cm ssid">${esc(r.ssid)}</span></div>
    <div class="cbadges">${wifiKindBadge(r.kind)}<span class="tag" title="${r._members.length} APs broadcasting this name">${r._members.length} APs</span></div>
    <div class="ch"><span class="crssi">${r.rssi}<small> dBm</small></span><span class="cname">ch ${netChanList(r)}</span></div>
    <div class="cg"><span>min/max</span><b>${r.min}/${r.max}</b>
      <span>count</span><b>${r.cnt}</b><span>age</span><b>${r.age}s</b>
      <span>sta</span><b>${r.sta}</b></div>
    <button class="expBtn${expandedNetworks.has(r.ssid)?' on':''}" data-ssid="${esc(r.ssid)}" onclick="toggleNetExpand(this.dataset.ssid,event)"
      title="${expandedNetworks.has(r.ssid)?'collapse':'expand'} ${r._members.length} APs">${expandedNetworks.has(r.ssid)?'&#9660;':'&#9654;'} ${r._members.length} APs</button>
    <button class="actmenu-item" data-ssid="${esc(r.ssid)}" onclick="showNetworkInfo(this.dataset.ssid)" title="show every AP broadcasting this name">Network info&hellip;</button>`;
}
/**
 * Builds the card body HTML for a WiFi device row, dispatching by kind (client, grouped network, or AP/probe).
 * @param r Device record.
 * @returns Card inner HTML.
 */
function wifiCard(r){
  if(r.kind==='client')return clientCard(r);
  if(r._netGroup)return netCard(r);
  const name=r.ssidbad?ssidHtml(r.ssid,r.ssidbad,r.ssidhex):(r.ssid?esc(r.ssid):(r.hid?'<span class="hidn" title="cloaked AP — SSID withheld from beacons">&#8249;hidden&#8250;</span>':'<span class="muted">(hidden)</span>'));
  const cloak=r.hid&&r.ssid?`<span class="tag hidn" title="AP cloaks its SSID; name recovered from a directed probe-response / association">cloaked</span>`:'';
  return `<div class="ch"><span class="cm ssid">${name}</span><span class="refbtn ${r.mac===refMac?'on':''}" data-mac="${esc(r.mac)}"
       title="${r.mac===refMac?'clear radar focus':'set radar focus'}" onclick="setRef(this.dataset.mac)">&#9678;</span></div>
    <div class="cbadges">${wifiKindBadge(r.kind)}${cloak}${cliBadge(r)}</div>
    <div class="ch"><span class="crssi">${r.rssi}<small> dBm</small></span><span class="cname">ch ${r.ch}</span></div>
    <div class="cg">${secCard(r)}<span>min/max</span><b>${r.min}/${r.max}</b>
      <span>count</span><b>${r.cnt}</b><span>age</span><b>${r.age}s</b>
      <span>mac</span><b class="mac">${macLink(r.mac)}</b><span>vendor</span><b>${vendorCell(r)}</b></div>
    ${cardExpandBtn(r)}`;
}
/**
 * Clears the radar box-selection and re-renders the device list and radar.
 */
function clearBoxSel(){boxSel=null; renderDevices(); drawRadar(lastDevs);}
/**
 * Toggles the collapsed state of a container element and updates its toggle button's glyph.
 * @param id Element id of the collapsible container.
 * @param btn Button element whose caret glyph is flipped.
 */
function toggleCollapse(id,btn){
  const c=document.getElementById(id).classList.toggle('collapsed');
  btn.innerHTML=c?'&#9660;':'&#9650;';
}

const WKIND={beacon:['BEACON','wbcn'],probe:['PROBE','wprb'],client:['STATION','wcli']};
/**
 * Builds the kind badge (beacon/probe/station) for a WiFi row.
 * @param k Row kind key, one of `WKIND`'s keys; falls back to probe if unknown.
 * @returns Badge HTML.
 */
function wifiKindBadge(k){const e=WKIND[k]||WKIND.probe;return `<span class="tag ${e[1]}">${e[0]}</span>`;}
/**
 * Builds the associated-station-count badge for an AP row, clickable to open its MAC info modal.
 * @param r AP record.
 * @returns Badge HTML, or an empty string when it has no associated stations.
 */
function cliBadge(r){const n=beaconClients(r).length;
  return n?`<span class="tag wcli" data-mac="${esc(r.mac)}" onclick="showMacInfo(this.dataset.mac)" title="${n} station(s) associated to this AP — click for the client list + activity">${n} sta</span>`:'';}
/**
 * Builds the STA table cell showing associated-station count and a NEW badge for stations associated since the last capture window.
 * @param r Device record.
 * @returns Table cell HTML; an em-dash cell for non-beacon rows.
 */
function staCell(r){
  if(r.kind!=='beacon') return '<td class="muted">&mdash;</td>';
  const cl=beaconClients(r), nn=cl.filter(m=>newStationMacs.has(m)).length;
  return `<td>${cl.length}${nn?` <span class="tag newmac" title="${nn} station${nn>1?'s':''} newly associated since the last capture window">+${nn}</span>`:''}</td>`;}

const SEC_LABEL=['?','OPEN','WEP','WPA','WPA-Ent','WPA2','WPA/WPA2','WPA2-Ent','WPA3','WPA2/WPA3','WPA3-Ent','OWE'];
const SEC_CLASS=['secu','seco','secw','secw','secw','sec2','sec2','sec2e','sec3','secmix','sec3e','sec2'];
const CIP_LABEL=['','WEP','TKIP','CCMP','TKIP+CCMP','GCMP-128','GCMP-256','?'];
const PMF_LABEL=['','PMF-capable','PMF-required'];
/**
 * Builds the descriptive security text for a record (auth label, pairwise cipher, PMF, and a "(scan)" suffix when the value came from a coarse passive scan rather than a real beacon-IE parse).
 * @param r Record with `sec`/`cip`/`pmf`/`secie` fields.
 * @returns Human-readable security description.
 */
function secText(r){const s=r.sec||0; let t=SEC_LABEL[s]||'?';
  const c=CIP_LABEL[r.cip||0]; if(c&&s>2)t+=' · '+c;
  const p=PMF_LABEL[r.pmf||0]; if(p)t+=' · '+p;
  if(s===9) t+=' · transition mode, WPA2 fallback possible';
  if(s>1 && !r.secie) t+=' (scan)'; return t;}
/**
 * Builds the SEC column badge, flagged as weak for open/WEP networks.
 * @param r Record with a `sec` field.
 * @returns Badge HTML with `secText()` as its tooltip.
 */
function secBadge(r){const s=r.sec||0; const weak=(s===2);
  return `<span class="tag ${SEC_CLASS[s]||'secu'}${weak?' secweak':''}" title="${esc(secText(r))}">${SEC_LABEL[s]||'?'}</span>`;}
/**
 * Builds the SEC table cell for a beacon row.
 * @param r Device record.
 * @returns Table cell HTML; an em-dash cell for non-beacon rows.
 */
function secCell(r){return r.kind==='beacon'?`<td>${secBadge(r)}</td>`:'<td class="muted">&mdash;</td>';}
const SECHDR='<th data-k="sec" title="AP security: auth/key-mgmt + pairwise cipher">SEC</th>';
/**
 * Builds the security label/value pair for the card view.
 * @param r Device record.
 * @returns HTML fragment, or an empty string for non-beacon rows.
 */
function secCard(r){return r.kind==='beacon'?`<span>sec</span><b>${secBadge(r)}</b>`:'';}
/**
 * Builds a signal-strength bar sized and coloured from an RSSI value.
 * @param rssi Signal strength in dBm.
 * @returns Bar HTML.
 */
function sigBar(rssi){const pct=Math.max(4,Math.min(100,Math.round((rssi+95)/65*100)));
  const cls=pct>66?'good':pct>33?'ok':'weak';
  return `<div class="sigbar-wrap" title="signal strength: ${rssi} dBm"><div class="sigbar ${cls}" style="width:${pct}%"></div></div>`;}
/* @GUARD:IF WITH_SECURITYTOOLS */const SECTOOLS=1;
let RECON=0;/* @GUARD:IF WITH_RECON */RECON=1;/* @ENDGUARD */
let hsNotified=new Set(), hsBaselined=false;
/**
 * Detects newly-completed handshakes/PMKID captures and raises a toast + flash notification for each.
 * On the first call it only baselines `hsNotified` from the current list without notifying, so a page load doesn't re-announce already-captured handshakes.
 * @param list Current handshake records (each with `mask`, `pmkid`, `client`, `bssid`).
 */
function notifyHandshakeReady(list){
  if(!hsBaselined){
    hsBaselined=true;
    (list||[]).forEach(h=>{ if((h.mask&0xF)===0xF||h.pmkid) hsNotified.add(h.client+'|'+h.bssid); });
    return;
  }
  (list||[]).forEach(h=>{
    const full=(h.mask&0xF)===0xF;
    if(!full&&!h.pmkid)return;
    const key=h.client+'|'+h.bssid;
    if(hsNotified.has(key))return;
    hsNotified.add(key);
    const hde2=document.getElementById('hde2');
    if(hde2){hde2.classList.remove('flash');void hde2.offsetWidth;hde2.classList.add('flash');}
    hsToast((full?'4-way handshake':'PMKID')+' captured for '+(h.bssid||'unknown BSSID')+' — see Authorisations.');
    if(typeof loadHsFiles==='function') setTimeout(loadHsFiles,1500);
  });
}
/**
 * Shows a transient toast notification, creating the toast element on first use.
 * @param msg Message text to display.
 */
function hsToast(msg){
  let t=document.getElementById('hsToastEl');
  if(!t){ t=document.createElement('div'); t.id='hsToastEl'; t.className='hsToast'; document.body.appendChild(t); }
  t.textContent=msg;
  t.classList.remove('on'); void t.offsetWidth; t.classList.add('on');
  clearTimeout(t._to); t._to=setTimeout(()=>t.classList.remove('on'),6000);
}
/**
 * Builds the 4-way-handshake progress dots (M1-M4) and a "4/4" label when complete.
 * @param mask Bitmask of received handshake messages (bit i = message i+1).
 * @returns Badge HTML.
 */
function hsBadges(mask){let h='<span class="hsdots">';
  for(let i=0;i<4;i++)h+=`<span class="${(mask&(1<<i))?'on':''}" title="M${i+1}"></span>`;
  return h+'</span>'+((mask&0xF)===0xF?' <b>4/4</b>':'');}
/**
 * Copies a PMKID hex string to the clipboard and briefly shows "copied" in the triggering element.
 * @param el Element whose text is temporarily replaced to confirm the copy.
 * @param hex PMKID hex string to copy.
 */
function copyPmkid(el,hex){if(navigator.clipboard)navigator.clipboard.writeText(hex).catch(()=>{});
  const t=el.textContent; el.textContent='copied'; setTimeout(()=>{el.textContent=t;},900);}
/**
 * Copies a MAC address to the clipboard and briefly flags the triggering element as copied.
 * @param el Element to toggle the `copied` class on.
 * @param mac MAC address to copy.
 */
function copyMac(el,mac){if(navigator.clipboard)navigator.clipboard.writeText(mac).catch(()=>{});
  el.classList.add('copied'); setTimeout(()=>el.classList.remove('copied'),900);}
/**
 * Builds the PMKID table cell, clickable to copy the full value when present.
 * @param h Handshake record.
 * @returns Cell HTML.
 */
function pmkCell(h){return h.pmkid
  ?`<span class="pmk" title="click to copy full PMKID" onclick="copyPmkid(this,'${h.pmkid}')">${h.pmkid.slice(0,12)}&hellip;</span>`
  :'<span class="pmk none">&mdash;</span>';}
/** Toggles the "PMKID only" handshake filter, updates the filter button state, and re-renders the handshakes table. */
function togglePmkOnly(){pmkOnly=!pmkOnly;
  const b=document.getElementById('pmkOnlyBtn'); if(b)b.classList.toggle('on',pmkOnly);
  renderHandshakes();}
/**
 * Renders the authorisation summary tiles (full handshakes, PMKID captures, distinct networks) from `lastHandshake` into #authSum.
 */
function renderAuthSummary(){const el=document.getElementById('authSum'); if(!el)return;
  const full=lastHandshake.filter(h=>(h.mask&0xF)===0xF).length;
  const pmk=lastHandshake.filter(h=>h.pmkid).length;
  const nets=new Set(lastHandshake.map(h=>h.bssid)).size;
  const tile=(v,l)=>`<div class="stattile"><span class="v">${v}</span><span class="l">${l}</span></div>`;
  el.innerHTML=tile(full,'Full handshakes')+tile(pmk,'PMKID captures')+tile(nets,'Networks');}
/**
 * Builds the PCAP download cell for a handshake row, sourcing from the SD-backed file list when available, otherwise a RAM-staged capture target.
 * @param h Handshake record.
 * @returns Cell HTML: a download link/button, a "staging" placeholder, or an em-dash when unavailable.
 */
function hsPcapCell(h){
  if(RECON) return '<span class="muted">&mdash;</span>';
  if(hsSdAvail){
    const nm=hsdByBssid.get(h.bssid);
    return nm
      ? `<a class="icobtn" href="/api/security/handshake?name=${encodeURIComponent(nm)}" download title="Download ${esc(nm)}">&darr;</a>`
      : '<span class="muted">&mdash;</span>';
  }
  const t=hsrTargets.get(h.bssid);
  if(!t) return '<span class="muted">&mdash;</span>';
  return t.ready
    ? `<button class="icobtn" data-mac="${esc(h.bssid)}" onclick="downloadRamPcap(this.dataset.mac)" title="Download pcap">&darr;</button>`
    : '<span class="muted">staging&hellip;</span>';
}
/**
 * Renders the handshakes table (#hst) from `lastHandshake`, applying the PMKID-only filter and sorting by age, and refreshes the empty-state and count elements.
 */
function renderHandshakes(){
  const tb=document.querySelector('#hst tbody'); if(!tb){renderAuthSummary();return;}
  const hhs=document.getElementById('hhs'); if(hhs)hhs.textContent=lastHandshake.length;
  const sec=document.getElementById('hsSec'), empty=document.getElementById('hsEmpty');
  if(sec)sec.style.display=lastHandshake.length?'':'none';
  if(empty)empty.style.display=lastHandshake.length?'none':'';
  const rows=(pmkOnly?lastHandshake.filter(h=>h.pmkid):lastHandshake).slice().sort((a,b)=>a.age-b.age);
  tb.innerHTML = rows.length ? rows.map(h=>{
    const full=(h.mask&0xF)===0xF;
    return `<tr class="${full?'hs-full':''}">`+
      `<td data-label="Age">${h.age}s</td>`+
      `<td class="mac" data-label="Client">${macCell(h.client)}</td>`+
      `<td class="mac" data-label="BSSID (SSID)">${bssidCell(h.bssid)}</td>`+
      `<td data-label="Progress">${hsBadges(h.mask)}</td>`+
      `<td data-label="PMKID">${pmkCell(h)}</td>`+
      `<td data-label="RSSI">${h.rssi}</td>`+
      `<td data-label="Cnt"><b>${h.cnt}</b></td>`+
      `<td data-label="PCAP">${hsPcapCell(h)}</td></tr>`;
  }).join('') : (pmkOnly?`<tr><td colspan="8" class="muted" style="padding:14px">No PMKID captures seen.</td></tr>`:'');
  renderAuthSummary();
}
/**
 * Formats a byte count as a human-readable size in B, KB, or MB.
 * @param n Size in bytes.
 * @returns Formatted size string.
 */
function humanSize(n){if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(1)+' MB';}
/**
 * Extracts the BSSID encoded in a handshake pcap filename (`hs_<...>.pcapng`, last 12 hex chars before the extension).
 * @param name File name to parse.
 * @returns Colon-separated uppercase MAC, or null if the name doesn't match the expected pattern.
 */
function hsFileBssid(name){
  if(!name.startsWith('hs_')||!name.endsWith('.pcapng'))return null;
  const mid=name.slice(3,-7);
  if(mid.length<12)return null;
  const hex=mid.slice(-12);
  if(!/^[0-9a-fA-F]{12}$/.test(hex))return null;
  return hex.match(/.{2}/g).join(':').toLowerCase();
}
let hsdByBssid=new Map();
/**
 * Fetches the SD-stored handshake pcap file list from `/api/security/handshakes`, rebuilds `hsdByBssid`, renders the file table (#hsdt), and re-renders the handshakes view.
 * @returns Promise resolved once the fetch and render complete (rejections are swallowed).
 */
function loadHsFiles(){
  if(RECON){
    ['hsdSec','hsdEmpty','hsRamSec','pmkOnlyBtn'].forEach(id=>{
      const e=document.getElementById(id); if(e)e.style.display='none';
    });
    if(!document.getElementById('_reconColStyle')){
      const st=document.createElement('style');
      st.id='_reconColStyle';
      st.textContent='#hst thead th:nth-child(5),#hst tbody td:nth-child(5),#hst thead th:nth-child(8),#hst tbody td:nth-child(8){display:none}';
      document.head.appendChild(st);
    }
    return Promise.resolve();
  }
  return fetch('/api/security/handshakes').then(r=>r.json()).then(d=>{
    hsSdAvail=!!d.sd;
    const ramSec=document.getElementById('hsRamSec');
    if(ramSec)ramSec.style.display=hsSdAvail?'none':'';
    const tb=document.querySelector('#hsdt tbody'), cnt=document.getElementById('hsdc'),
          sec=document.getElementById('hsdSec'), empty=document.getElementById('hsdEmpty');
    if(!tb)return;
    const files=d.files||[];
    if(cnt)cnt.textContent=files.length;
    if(sec)sec.style.display=files.length?'':'none';
    if(empty)empty.style.display=files.length?'none':'';
    hsdByBssid=new Map();
    for(const f of files){ const b=hsFileBssid(f.name); if(b)hsdByBssid.set(b,f.name); }
    tb.innerHTML=files.map(f=>{
      const nm=esc(f.name);
      return `<tr><td class="mac">${nm}<span class="muted" style="margin-left:8px">${humanSize(f.size)}</span></td>`+
        `<td style="text-align:right;white-space:nowrap"><div style="display:inline-flex;gap:6px">`+
        `<a class="icobtn" href="/api/security/handshake?name=${encodeURIComponent(f.name)}" download title="Download ${nm}">&darr;</a>`+
        `<button class="icobtn" onclick="openHsDelModal('${nm}')" title="Delete ${nm}">&times;</button>`+
        `</div></td></tr>`;
    }).join('');
    renderHandshakes();
  }).catch(()=>{});
}
let hsDelPending=null;
/**
 * Opens the handshake-file delete-confirmation modal.
 * @param name File name pending deletion, stored in `hsDelPending`.
 */
function openHsDelModal(name){
  hsDelPending=name;
  const body=document.getElementById('hsDelModalBody');
  if(body)body.textContent='Delete "'+name+'"? This cannot be undone.';
  const err=document.getElementById('hsDelModalErr'); if(err)err.style.display='none';
  document.getElementById('hsDelModal').classList.add('on');
}
/** Clears the pending delete target and hides the handshake-file delete modal. */
function closeHsDelModal(){
  hsDelPending=null;
  document.getElementById('hsDelModal').classList.remove('on');
}
/**
 * Submits the pending handshake-file deletion to `/api/security/handshake`, closing the modal and reloading the file list on success or showing an error in the modal otherwise.
 */
function confirmHsDelete(){
  if(!hsDelPending)return;
  const name=hsDelPending;
  const btn=document.getElementById('hsDelModalBtn'); if(btn)btn.disabled=true;
  const body=new URLSearchParams({name,del:'1'});
  fetch('/api/security/handshake',{method:'POST',body})
    .then(r=>r.json()).then(d=>{
      if(btn)btn.disabled=false;
      if(!d.ok){
        const err=document.getElementById('hsDelModalErr');
        if(err){err.textContent='Delete failed: '+(d.err||'unknown error');err.style.display='';}
        return;
      }
      closeHsDelModal();
      loadHsFiles();
    }).catch(e=>{
      if(btn)btn.disabled=false;
      const err=document.getElementById('hsDelModalErr');
      if(err){err.textContent='Delete failed: '+e;err.style.display='';}
    });
}
let hsrArmed=false, hsSdAvail=false;
let hsrTargets=new Map();
/** Toggles RAM-based handshake capture arming via `/api/security/handshake/capture` and refreshes the armed-state UI on success. */
function toggleHsRamCapture(){
  const want=!hsrArmed;
  fetch('/api/security/handshake/capture',{method:'POST',body:new URLSearchParams({on:want?'1':'0'})})
    .then(r=>r.json()).then(d=>{if(d.ok){hsrArmed=d.armed;renderHsRamArmed();loadHsRam();}})
    .catch(()=>{});
}
/** Updates the RAM-capture armed-status pill and arm/disarm button to reflect `hsrArmed`. */
function renderHsRamArmed(){
  const pill=document.getElementById('hsrArmedPill'), btn=document.getElementById('hsrCapBtn');
  if(pill){pill.className='statuspill '+(hsrArmed?'up':'down');
    pill.innerHTML='<span class="dot"></span>'+(hsrArmed?'Armed':'Off');}
  if(btn){btn.classList.toggle('on',hsrArmed); btn.textContent=hsrArmed?'Disarm':'Arm';}
}
/**
 * Downloads a RAM-staged handshake pcap for a target BSSID and triggers a browser save; toasts an error message on failure.
 * @param bssid Target AP BSSID whose staged capture to download.
 */
async function downloadRamPcap(bssid){
  try{
    const r=await fetch('/api/security/handshake/ram?bssid='+encodeURIComponent(bssid));
    if(!r.ok){
      let msg='HTTP '+r.status;
      try{ const e=await r.json(); if(e&&e.err)msg=e.err; }catch(_){}
      hsToast('Download failed ('+msg+') -- target may have been cleared or not ready yet.');
      return;
    }
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download='hs_ram_'+bssid.replace(/:/g,'')+'.pcapng';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),4000);
  }catch(e){ hsToast('Download failed: '+e); }
}
/**
 * Fetches RAM-staged handshake capture state from `/api/security/handshakes/ram` and re-renders the handshakes view; no-op when SD storage is in use.
 */
function loadHsRam(){
  if(hsSdAvail)return;
  fetch('/api/security/handshakes/ram').then(r=>r.json()).then(d=>{
    hsrArmed=!!d.armed; renderHsRamArmed();
    hsrTargets=new Map((d.targets||[]).map(t=>[t.bssid,t]));
    renderHandshakes();
  }).catch(()=>{});
}
/* @ENDGUARD *//* @GUARD:IF TDONGLE_BUILD */const TDONGLE=1;
/* @ENDGUARD */
/**
 * Builds the table-view associated-station expand/collapse button for a beacon row.
 * @param r Device record.
 * @returns Button HTML, or an empty string for non-beacon rows or rows with no associated stations.
 */
function expandCell(r){
  if(r.kind!=='beacon')return '';
  const n=beaconClients(r).length; if(!n)return '';
  const open=expandedTableAPs.has(r.mac);
  return ` <button class="expBtn${open?' on':''}" data-mac="${esc(r.mac)}" onclick="toggleApExpand(this.dataset.mac,event)"
    title="${open?'collapse':'expand'} ${n} associated station(s)">${open?'&#9660;':'&#9654;'} ${n} sta</button>`;
}
/**
 * Toggles whether a grouped network's member APs are expanded in the device list.
 * @param ssid SSID of the network group to toggle.
 * @param ev Optional triggering event, whose propagation is stopped so the row click isn't also handled.
 */
function toggleNetExpand(ssid,ev){
  if(ev){ev.stopPropagation();}
  if(expandedNetworks.has(ssid))expandedNetworks.delete(ssid); else expandedNetworks.add(ssid);
  renderDevices();
}
/**
 * Builds the expand/collapse button for a grouped-network row.
 * @param r Network group record.
 * @returns Button HTML, or an empty string for non-group rows.
 */
function netExpandCell(r){
  if(!r._netGroup)return '';
  const n=r._members.length, open=expandedNetworks.has(r.ssid);
  return ` <button class="expBtn${open?' on':''}" data-ssid="${esc(r.ssid)}" onclick="toggleNetExpand(this.dataset.ssid,event)"
    title="${open?'collapse':'expand'} ${n} APs broadcasting this name">${open?'&#9660;':'&#9654;'} ${n} APs</button>`;
}
/**
 * Formats a network group's channel list for display.
 * @param r Network group record with a `_chans` array.
 * @returns Comma-separated channel list, or a muted placeholder when empty.
 */
function netChanList(r){
  return r._chans&&r._chans.length ? r._chans.join(', ') : '<span class="muted">-</span>';
}
/**
 * Builds the rotating-MAC group-size badge for a collapsed set of randomised probe MACs.
 * @param r Device record with a `_grp` count.
 * @returns Badge HTML, or an empty string when the group has one member.
 */
function wifiGrpBadge(r){
  if(!(r._grp>1))return '';
  return ` <span class="tag wprb" title="${r._grp} rotating randomised MACs probing for &quot;${esc(r.ssid)}&quot; — one shown, RSSI averaged">&times;${r._grp}</span>`;
}
/**
 * Builds the NEW badge for a device not seen before the most recent capture window.
 * @param r Device record with an `isNew` flag.
 * @returns Badge HTML, or an empty string.
 */
function wifiNewBadge(r){
  return r.isNew?' <span class="tag newmac" title="not seen before the most recent capture window">NEW</span>':'';
}
/**
 * Builds the HOTSPOT heuristic badge for a beacon with a locally-administered (randomised) BSSID.
 * @param r Device record.
 * @returns Badge HTML, or an empty string when not applicable.
 */
function wifiHotspotBadge(r){
  if(r.kind!=='beacon'||!r.rnd)return '';
  return ` <span class="tag hotspot" title="locally-administered BSSID — typical of a phone/PC software hotspot rather than a hardware router (heuristic)">HOTSPOT</span>`;
}
/**
 * Builds the DEVICES table row cells for a WiFi record, branching by row type (client, grouped network, or AP/probe).
 * @param r Device record.
 * @returns Concatenated `<td>` HTML for the row.
 */
function wifiCols(r){
  if(r.kind==='client')return `
  <td class="ssid">${esc(r.mac)}${r.vendor?` <span class="venlbl">(${esc(r.vendor)})</span>`:(r.rnd?' <span class="muted">(random addr)</span>':'')}${wifiNewBadge(r)}</td>
  <td>${wifiKindBadge(r.kind)}</td>${secCell(r)}${staCell(r)}
  <td class="rssi">${r.rssi}</td>
  <td>${r.ch||'<span class="muted">-</span>'}</td><td class="muted">${r.age}s</td>
  <td class="mac">${macLink(r.mac)}</td><td>${r.vendor?esc(r.vendor):(r.rnd?'<span class="muted">(random addr)</span>':'<span class="muted">(unknown OUI)</span>')}</td>`;
  if(r._netGroup)return `
  <td class="ssid"><span class="maclink" data-ssid="${esc(r.ssid)}" onclick="showNetworkInfo(this.dataset.ssid)" title="show every AP broadcasting this name">${esc(r.ssid)}</span>${netExpandCell(r)}</td>
  <td>${wifiKindBadge(r.kind)}</td>${secCell(r)}<td>${r.sta}</td>
  <td class="rssi">${r.rssi}</td>
  <td>${netChanList(r)}</td><td class="muted">${r.age}s</td>
  <td class="mac"><span class="maclink" data-ssid="${esc(r.ssid)}" onclick="showNetworkInfo(this.dataset.ssid)" title="show every AP broadcasting this name">${r._members.length} APs</span></td><td class="muted">&mdash;</td>`;
  return `
  <td class="ssid">${r.ssidbad?ssidHtml(r.ssid,r.ssidbad,r.ssidhex):(r.ssid?esc(r.ssid):(r.hid?'<span class="hidn" title="cloaked AP — SSID withheld from beacons">&#8249;hidden&#8250;</span>':'<span class="muted">-</span>'))}${r.hid&&r.ssid?' <span class="hidn" title="AP cloaks its SSID; name recovered from a directed probe-response / association">cloaked</span>':''}${wifiNewBadge(r)}${wifiHotspotBadge(r)}${wifiGrpBadge(r)}${expandCell(r)}</td>
  <td>${wifiKindBadge(r.kind)}</td>${secCell(r)}${staCell(r)}
  <td class="rssi">${r.rssi}</td>
  <td>${r.kind==='probe'?'<span class="muted">-</span>':r.ch}</td><td class="muted">${r.age}s</td>
  <td class="mac">${macLink(r.mac)}</td><td>${vendorCell(r)}</td>`;}
const DEVHDR_WIFI=`<th data-k="ssid">NAME / SSID</th><th data-k="kind">KIND</th>`+
  SECHDR+
  `<th data-k="clients" title="stations associated to this AP — click to sort, APs with clients first">STA</th>`+
  `<th data-k="rssi">RSSI</th>`+
  `<th data-k="ch">CH</th><th data-k="age">AGE</th>`+
  `<th data-k="mac">MAC</th><th data-k="vendor">VENDOR</th>`;
/**
 * Rebuilds the DEVICES table header for the WiFi view and rewires column-sort click handlers.
 */
function setDevHeader(){
  const tr=document.querySelector('#dt thead tr');
  if(tr){tr.innerHTML=DEVHDR_WIFI; wireSort('dt',dSort);}
}

const rc=document.getElementById('radar'), rx=rc.getContext('2d');
let hist={};
let rhist={};
let spawnAt={};
const SPAWN_MS=420;
/**
 * Overshoot ease-out easing function used for the device spawn animation.
 * @param t Normalised progress, 0-1.
 * @returns Eased value (may briefly exceed 1).
 */
function easeOutBack(t){const c1=1.70158,c3=c1+1;return 1+c3*Math.pow(t-1,3)+c1*Math.pow(t-1,2);}
let spawnAnimOn=false;
/**
 * Drives the spawn-in animation loop, redrawing the radar each frame until no tracked device is still within its spawn window.
 * Guarded by `spawnAnimOn` so only one animation loop runs at a time.
 */
function runSpawnAnim(){
  if(spawnAnimOn)return; spawnAnimOn=true;
  const step=()=>{
    requestAnimationFrame(()=>{
      let live=false;
      try{
        drawRadar(lastDevs);
        const now=Date.now();
        Object.keys(spawnAt).forEach(m=>{if(now-spawnAt[m]<SPAWN_MS)live=true;});
      }finally{
        if(live)step(); else spawnAnimOn=false;
      }
    });
  };
  step();
}
let plots=[];
let deauthPlots=[];
let labelOffsets={}, dragLabel=null, labelPlots=[];
let view={s:1,cx:null,cy:null};
let selRect=null;
let boxSel=null;
let spread=false;
let showAll=true;
let hideGhosts=false;
let syncSearch=false;
let syncFromRadar=false;
let lastW=460,lastH=460;
/** Toggles radar/table expansion sync, updates the sync button state, and redraws the radar. */
function toggleSync(){syncSearch=!syncSearch;
  const b=document.getElementById('syncBtn'); if(b)b.classList.toggle('on',syncSearch);
  if(syncSearch) syncExpandToRadar();
  drawRadar(lastDevs);}
/** Expands on the radar every AP that is currently expanded in the device table. */
function syncExpandToRadar(){
  expandedTableAPs.forEach(mac=>{ if(!expandedAPs.has(mac)) toggleExpand(mac); });
}
let autoExpand=false;
/** Toggles auto-expand mode, syncing all beacon-with-clients APs open or collapsing all expanded ones, then redraws the radar. */
function toggleAutoExpand(){autoExpand=!autoExpand;
  const b=document.getElementById('autoExpandBtn'); if(b)b.classList.toggle('on',autoExpand);
  if(autoExpand) syncAutoExpandToRadar();
  else expandedAPs.forEach(m=>{ if(expandDir[m]!==-1){expandDir[m]=-1; expandAnimStart[m]=performance.now();} runExpandAnim(); });
  drawRadar(lastDevs);}
/** Expands every beacon with associated stations that isn't already expanded, when auto-expand mode is on. */
function syncAutoExpandToRadar(){
  if(!autoExpand) return;
  (lastWifi||[]).forEach(r=>{ if(beaconClients(r).length && !expandedAPs.has(r.mac)) toggleExpand(r.mac); });
}
/** Toggles radar-to-device-table selection sync and re-renders the radar and device list. */
function toggleSyncDev(){syncFromRadar=!syncFromRadar;
  const b=document.getElementById('syncDevBtn'); if(b)b.classList.toggle('on',syncFromRadar);
  drawRadar(lastDevs); renderDevices();}
/** Toggles the radar's node-repulsion spread layout and redraws it. */
function toggleSpread(){spread=!spread;
  const b=document.getElementById('spreadBtn'); if(b)b.classList.toggle('on',spread);
  drawRadar(lastDevs);}
/** Toggles hiding of ghost (stale/inactive) devices on the radar and redraws it. */
function toggleGhosts(){hideGhosts=!hideGhosts;
  const b=document.getElementById('ghostBtn'); if(b)b.classList.toggle('on',hideGhosts);
  drawRadar(lastDevs);}
let sweepOn=false;
let sweepAnimOn=false;
const SWEEP_PERIOD_MS=4000;
const SWEEP_GLOW_MS=650;
let sweepHit={};
let lastSweepAngle=null;
let sweptMacs=new Set();
/** Toggles the radar sweep animation, resetting sweep tracking state and starting the animation loop when turned on. */
function toggleSweep(){sweepOn=!sweepOn;
  const b=document.getElementById('sweepBtn'); if(b)b.classList.toggle('on',sweepOn);
  if(sweepOn){lastSweepAngle=null; sweptMacs=new Set(); runSweepAnim();}
  drawRadar(lastDevs);}
/**
 * Drives the radar sweep animation loop, redrawing each frame while `sweepOn` is true.
 * Guarded by `sweepAnimOn` so only one animation loop runs at a time.
 */
function runSweepAnim(){
  if(sweepAnimOn)return; sweepAnimOn=true;
  const step=()=>{
    requestAnimationFrame(()=>{
      if(!sweepOn){sweepAnimOn=false;return;}
      drawRadar(lastDevs);
      step();
    });
  };
  step();
}
/** Resets the minimum-count filter to 1, enables show-all, and redraws the radar. */
function resetFilters(){
  const mc=document.getElementById('mincnt'); mc.value=1; mincntL.textContent='1';
  showAll=true; drawRadar(lastDevs);}
let settingsOpen=false;
/**
 * Toggles the radar wrapper's zoom-lock class to match whether the settings panel is open.
 */
function syncZoomLock(){const w=document.getElementById('radarWrap');
  if(w)w.classList.toggle('zlock',settingsOpen);}
/** Opens or closes the radar settings panel depending on its current state. */
function toggleSettings(){ settingsOpen?closeSettings():openSettings(); }
/** Toggles visibility of the radar ring legend. */
function toggleRingLegend(){ document.getElementById('ringLegend').classList.toggle('hidden'); }
/** Toggles fullscreen radar mode, updates the fullscreen button state, and redraws the radar on the next frame. */
function toggleFullscreen(){
  const on=document.body.classList.toggle('radar-fs');
  const b=document.getElementById('fsBtn'); if(b){b.classList.toggle('on',on); b.title=on?'exit fullscreen':'fullscreen radar';}
  requestAnimationFrame(()=>drawRadar(lastDevs));
}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('radar-fs'))toggleFullscreen();});
/** Opens the radar settings panel and engages the zoom lock. */
function openSettings(){settingsOpen=true;
  document.getElementById('rmodal').classList.remove('hidden'); syncZoomLock();}
/** Closes the radar settings panel and releases the zoom lock. */
function closeSettings(){settingsOpen=false;
  document.getElementById('rmodal').classList.add('hidden'); syncZoomLock();}
/**
 * Resolves the radar view's pan centre, defaulting to the canvas centre when unset.
 * @param W Canvas width.
 * @param H Canvas height.
 * @returns `[cx, cy]` view centre in base coordinates.
 */
function viewCtr(W,H){return [view.cx==null?W/2:view.cx, view.cy==null?H/2:view.cy];}
/**
 * Converts base (world) coordinates to screen coordinates under the current pan/zoom view.
 * @param bx Base-space x.
 * @param by Base-space y.
 * @param W Canvas width.
 * @param H Canvas height.
 * @returns `[sx, sy]` screen coordinates.
 */
function toScreen(bx,by,W,H){const[vcx,vcy]=viewCtr(W,H);
  return [(bx-vcx)*view.s+W/2, (by-vcy)*view.s+H/2];}
/**
 * Converts screen coordinates back to base (world) coordinates under the current pan/zoom view.
 * @param sx Screen-space x.
 * @param sy Screen-space y.
 * @param W Canvas width.
 * @param H Canvas height.
 * @returns `[bx, by]` base coordinates.
 */
function toBase(sx,sy,W,H){const[vcx,vcy]=viewCtr(W,H);
  return [(sx-W/2)/view.s+vcx, (sy-H/2)/view.s+vcy];}
/**
 * Clamps a radar zoom scale factor to the allowed range.
 * @param s Proposed scale factor.
 * @returns Clamped scale, between 0.25 and 40.
 */
function clampS(s){return Math.max(0.25,Math.min(40,s));}
/**
 * Zooms the radar view by a factor about a screen-space point, keeping that point fixed under the
 * cursor, and redraws. No-op while the settings panel is open.
 * @param sx Screen-space X of the zoom anchor.
 * @param sy Screen-space Y of the zoom anchor.
 * @param f Zoom multiplier applied to the current view scale.
 */
function zoomAtScreen(sx,sy,f){if(settingsOpen)return; const W=lastW,H=lastH;
  const[bx,by]=toBase(sx,sy,W,H), ns=clampS(view.s*f);
  view.cx=bx-(sx-W/2)/ns; view.cy=by-(sy-H/2)/ns; view.s=ns;
  drawRadar(lastDevs);}
/**
 * Fits the radar view scale/centre to a screen-space rectangle (e.g. a drag-selection box) and
 * redraws. No-op while the settings panel is open.
 * @param r Rectangle {x,y,w,h} in screen coordinates.
 */
function zoomToRect(r){if(settingsOpen)return; const W=lastW,H=lastH;
  const[ax,ay]=toBase(r.x,r.y,W,H), [bx,by]=toBase(r.x+r.w,r.y+r.h,W,H);
  const bw=Math.abs(bx-ax)||1, bh=Math.abs(by-ay)||1;
  view.s=clampS(Math.min(W/bw,H/bh)*0.9);
  view.cx=(ax+bx)/2; view.cy=(ay+by)/2; drawRadar(lastDevs);}
/** Resets the radar view to default scale/centre, clears the box selection, and redraws. */
function resetView(){view={s:1,cx:null,cy:null}; clearBoxSel(); drawRadar(lastDevs);}
/**
 * Zooms the radar view about the canvas centre by a factor.
 * @param f Zoom multiplier applied to the current view scale.
 */
function zoomStep(f){zoomAtScreen(lastW/2,lastH/2,f);}
let radScale={hi:-30,lo:-100};
/**
 * Normalises an RSSI value to a 0..1 fraction of the current radar scale (radScale.hi maps to 0,
 * radScale.lo maps to 1), clamped to that range.
 * @param rssi Signal strength in dBm.
 * @returns Fraction in [0,1] used as a radial distance factor.
 */
function rFrac(rssi){const{hi,lo}=radScale;
  return Math.min(1,Math.max(0,(hi-rssi)/((hi-lo)||1)));}
/**
 * Draws a filled 5-point star on the radar canvas.
 * @param x Screen-space centre X.
 * @param y Screen-space centre Y.
 * @param r Outer point radius.
 * @param c Fill colour.
 */
function drawStar(x,y,r,c){rx.fillStyle=c;rx.beginPath();
  for(let i=0;i<10;i++){const a=Math.PI/5*i-Math.PI/2, rr=i%2?r*0.45:r;
    const px=x+rr*Math.cos(a), py=y+rr*Math.sin(a); i?rx.lineTo(px,py):rx.moveTo(px,py);}
  rx.closePath();rx.fill();}
/**
 * Updates the #refinfo element with the current reading for the reference MAC (refMac): a placeholder
 * when no reference is set, "(not seen)" if it isn't present in the given device list, else its MAC
 * suffix and RSSI.
 * @param devs Current device list to look up the reference MAC in.
 */
function updateRefInfo(devs){
  const el=document.getElementById('refinfo');
  if(!el)return;
  if(!refMac){el.innerHTML='none &mdash; click &#9678; in DEVICES table';return;}
  const rd=devs.find(d=>d.mac===refMac);
  if(!rd){el.innerHTML='<b>'+refMac.slice(-8)+'</b> (not seen)';return;}
  el.innerHTML='<b>'+refMac.slice(-8)+'</b> '+rd.avg+' dBm';
}
/**
 * Derives a stable per-MAC angle via an FNV-1a hash of the MAC string, for consistent angular
 * placement of a device on the radar across frames.
 * @param mac MAC address string to hash.
 * @returns Angle in radians in [0, 2*PI).
 */
function angOf(mac){let h=2166136261;for(let i=0;i<mac.length;i++){
  h^=mac.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}return h/4294967295*Math.PI*2;}
/**
 * Resolves the CSS color for a device type.
 * @param t Device type ('PUB'/'PID' for a public/known MAC, else treated as randomised).
 * @returns The computed CSS custom-property value (--pub or --rnd).
 */
function col(t){return (t==='PUB'||t==='PID')?getComputedStyle(document.documentElement)
  .getPropertyValue('--pub'):getComputedStyle(document.documentElement).getPropertyValue('--rnd');}
/**
 * Reads a CSS custom property value off the document root.
 * @param name CSS custom-property name (e.g. '--accent').
 * @returns The trimmed computed value.
 */
function cssVar(name){return getComputedStyle(document.documentElement).getPropertyValue(name).trim();}
let radarHide={};
/**
 * Classifies a device into a radar/legend swatch class for filtering and colouring.
 * @param d Device object.
 * @returns 'whidden' for a cloaked network, 'wbcnCli'/'wbeacon' for a beacon with/without associated
 * clients, else 'wprobe'.
 */
function radarClassOf(d){
  if(d.hid) return 'whidden';
  return d.kind==='beacon' ? (beaconClients(d).length?'wbcnCli':'wbeacon') : 'wprobe';
}
/**
 * Toggles a legend swatch's hidden state (radarHide), reflects it on the swatch element's 'off' class,
 * and redraws the radar.
 * @param k Legend/radar class key to toggle.
 * @param el Legend swatch element whose 'off' class reflects the toggle.
 */
function toggleKey(k,el){
  if(radarHide[k]) delete radarHide[k]; else radarHide[k]=1;
  el.classList.toggle('off',!!radarHide[k]);
  drawRadar(lastDevs);
}
/**
 * Produces the filtered device list to plot on the radar: collapses randomised-MAC probes into named
 * networks, drops probes already absorbed/being absorbed into a beacon, applies the search predicate
 * (when synced to the devices table), the minimum-count filter (unless show-all is on), the
 * ghost/inactive filter, hidden legend-swatch classes, and the active band-mode filter
 * (seen/age/count/channel/signal).
 * @param devs Raw device list to filter.
 * @returns The filtered device list.
 */
function radarFilter(devs){
  devs=collapseDevs(devs||[]);
  const bs=new Set();
  devs.forEach(d=>{if(d.kind==='beacon')bs.add(d.ssid);});
  devs=devs.filter(d=>d.kind!=='probe'||absorbing[d.mac]||!bs.has(d.ssid));
  devs=devs.filter(d=>!(d.kind==='probe'&&absorbed.has(d.mac)));
  if(syncSearch){
    const preds=parseSearch((document.getElementById('devSearch')||{}).value);
    if(preds.length) devs=devs.filter(d=>preds.every(p=>p(d)));
  }
  const minCnt=+document.getElementById('mincnt').value;
  if(!showAll)
    devs=devs.filter(d=>d.cnt>=minCnt);
  if(hideGhosts) devs=devs.filter(d=>!isInactive(d));
  if(Object.keys(radarHide).length) devs=devs.filter(d=>!radarHide[radarClassOf(d)]);
  const v=bandVal();
  if(bandMode==='seen') return devs.filter(d=>(d.age||0)<=v);
  if(bandMode==='age')  return v>0?devs.filter(d=>(d.life||0)>=v):devs;
  if(bandMode==='cnt')  return devs.filter(d=>(d.cnt||0)>=v);
  if(bandMode==='ch')   return v>0?devs.filter(d=>+d.ch===chSliderChan(v)):devs;
  if(bandMode==='gps')
    return gpsFocus ? devs.filter(d=>d.lat==null||haversineM(gpsFocus.lat,gpsFocus.lon,d.lat,d.lon)<=v) : devs;
  const refDev=refMac?devs.find(d=>d.mac===refMac):null;
  const refRssi=refDev?refDev.avg:null;
  return signalFilter(devs,refRssi,v);
}
/**
 * Renders one full radar frame: computes the filtered/collapsed device set, draws range rings and
 * spokes, the reference signal-band overlay, the sweep line and per-device sweep-hit glow, each device
 * node (with spawn/absorb animation, motion trails, and a client-count halo ring for beacons), the
 * expanded-AP client orbit view, deauth event markers, and collision-avoided labels. Updates view
 * state (lastW/lastH), the #hm device-count element and #zlvl zoom readout, re-renders the devices
 * table when synced to the radar, and repositions the pinned node menu if one is open.
 * @param devs Device list to plot (before filtering/collapsing).
 */
function drawRadar(devs){
  growBandMax();
  devs=radarFilter(devs);
  const dpr=window.devicePixelRatio||1, W=rc.clientWidth, H=rc.clientHeight||460;
  if(!W||!H)return;
  lastW=W; lastH=H;
  rc.width=W*dpr; rc.height=H*dpr; rx.setTransform(dpr,0,0,dpr,0,0);
  rx.clearRect(0,0,W,H);
  const S=view.s;
  const zf=Math.max(0.5,Math.min(2.5,S));
  const lzf=Math.max(0.85,Math.min(1.25,S));
  const map=(bx,by)=>toScreen(bx,by,W,H);
  const cx=W/2, cy=H/2, R=Math.min(W,H)/2-28;
  const refDev=refMac?devs.find(d=>d.mac===refMac):null;
  const refRssi=refDev?refDev.avg:null;
  const band=+document.getElementById('band').value;
  let hi=-30, lo=-100; devs.forEach(d=>{hi=Math.max(hi,d.avg);lo=Math.min(lo,d.avg);});
  hi=Math.ceil(hi/5)*5; lo=Math.floor(lo/5)*5;
  if(lo>=hi) lo=hi-10;
  radScale={hi,lo};
  const[scx,scy]=map(cx,cy);
  rx.globalAlpha=selectedMac?0.15:1;
  rx.strokeStyle=cssVar('--line'); rx.fillStyle=cssVar('--muted'); rx.font='11px monospace';
  rx.textAlign='left';
  for(let i=1;i<=4;i++){const r=R*i/4*S;
    const ringFade=1-(i-1)*0.18;
    rx.save();rx.globalAlpha*=ringFade;
    rx.shadowColor=cssVar('--accent');rx.shadowBlur=4*ringFade;
    rx.beginPath();rx.arc(scx,scy,r,0,Math.PI*2);rx.stroke();
    rx.restore();
    rx.fillText(Math.round(hi-(hi-lo)*i/4)+' dBm',scx+3,scy-r+12);}
  for(let k=0;k<8;k++){const a=k*Math.PI/4;
    rx.beginPath();rx.moveTo(scx,scy);
    rx.lineTo(scx+R*S*Math.cos(a),scy+R*S*Math.sin(a));rx.stroke();}
  rx.globalAlpha=1;
  if(bandMode==='sig'){
    if(refRssi!=null){
      const ri=R*rFrac(refRssi+band)*S;
      const ro=R*rFrac(refRssi-band)*S;
      rx.globalAlpha=0.12;rx.fillStyle=cssVar('--accent');
      rx.beginPath();rx.arc(scx,scy,ro,0,Math.PI*2);rx.arc(scx,scy,ri,0,Math.PI*2,true);rx.fill();
      rx.globalAlpha=1;
    }else if(band<100){
      const rc2=R*rFrac(-band)*S;
      rx.strokeStyle=cssVar('--accent');rx.globalAlpha=0.5;rx.setLineDash([4,4]);
      rx.beginPath();rx.arc(scx,scy,rc2,0,Math.PI*2);rx.stroke();
      rx.setLineDash([]);rx.globalAlpha=1;
    }
  }
  const perfNow=performance.now();
  const sweepAngle=sweepOn?(perfNow%SWEEP_PERIOD_MS)/SWEEP_PERIOD_MS*Math.PI*2:null;
  const trail=on('trail');
  const showName=on('lname');
  const showMac=on('lmac');
  let maxCnt=1; devs.forEach(d=>{maxCnt=Math.max(maxCnt,d.cnt);});
  let maxCli=1; if(radarMode==='wifi')devs.forEach(d=>{
    if(d.kind==='beacon')maxCli=Math.max(maxCli,beaconClients(d).length);});
  const hlSet=highlightSet(), selActive=hlSet.size>0;
  const DIM=0.15;
  const present={}; plots=[]; const labels=[];
  const now=Date.now();
  const nodes=devs.map(d=>{
    present[d.mac]=1;
    const a=angOf(d.mac);
    let pending=false;
    if(sweepOn&&!sweptMacs.has(d.mac)){
      const TAU=Math.PI*2;
      const crossed=lastSweepAngle!=null&&
        (((a-lastSweepAngle)%TAU+TAU)%TAU)<=(((sweepAngle-lastSweepAngle)%TAU+TAU)%TAU);
      if(crossed){
        sweptMacs.add(d.mac);
        sweepHit[d.mac]=perfNow;
        spawnAt[d.mac]=now; runSpawnAnim();
      }else pending=true;
    }else if(!spawnAt[d.mac]){spawnAt[d.mac]=now; runSpawnAnim();}
    const r=(d.mac===refMac)?0:R*rFrac(d.avg);
    const dr=(4+8*Math.sqrt(d.cnt/maxCnt))*zf;
    const bx=cx+r*Math.cos(a), by=cy+r*Math.sin(a);
    const[x,y]=map(bx,by);
    let haloDr=dr, ringLw=0;
    if(radarMode==='wifi'&&d.kind==='beacon'){
      const nc=beaconClients(d).length;
      if(nc){ringLw=Math.min(1+Math.sqrt(nc)*1.6,9)*zf; haloDr=dr+ringLw+2;}
    }
    return {d,bx,by,dr,haloDr,ringLw,x,y,ox:x,oy:y,ang:a,pending};
  });
  if(spread) relaxNodes(nodes,W,H); else declutter(nodes);
  const nodeByMac={}; nodes.forEach(n=>nodeByMac[n.d.mac]=n);
  Object.keys(absorbing).forEach(m=>{
    const nd=nodeByMac[m], apNode=nodeByMac[absorbing[m].apMac];
    if(!nd||!apNode)return;
    const t=Math.min(1,(performance.now()-absorbing[m].start)/ABSORB_MS), te=t*t*t;
    nd.dr0=nd.dr;
    nd.x+=(apNode.x-nd.x)*te; nd.y+=(apNode.y-nd.y)*te;
    nd.dr*=(1-te);
    nd.absorbFlash=t>0.7?(t-0.7)/0.3:0;
  });
  const trailOn=trail&&!spread;
  nodes.forEach(nd=>{
    if(nd.pending)return;
    const d=nd.d, x=nd.x, y=nd.y, dr=nd.dr;
    const selDim=selActive&&!hlSet.has(d.mac)?DIM:1;
    nd.selDim=selDim;
    const hasCli=radarMode==='wifi'&&d.kind==='beacon'&&beaconClients(d).length;
    let lblR=dr;
    let c=(d.hid
             ?getComputedStyle(document.documentElement).getPropertyValue('--whid')
             :d.kind==='beacon'&&beaconClients(d).length
               ?getComputedStyle(document.documentElement).getPropertyValue('--cli')
               :col(d.kind==='beacon'?'PUB':'RND')).trim();
    const inact=isInactive(d);
    const h=hist[d.mac]=hist[d.mac]||[];
    const last=h[h.length-1];
    if(!last||Math.abs(last.x-nd.bx)>0.5||Math.abs(last.y-nd.by)>0.5)h.push({x:nd.bx,y:nd.by});
    if(h.length>25)h.shift();
    if(trailOn&&!inact&&h.length>1){
      for(let i=1;i<h.length;i++){
        const[x0,y0]=map(h[i-1].x,h[i-1].y),[x1,y1]=map(h[i].x,h[i].y);
        rx.globalAlpha=i/h.length*0.7*selDim;rx.strokeStyle=c;rx.lineWidth=2;
        rx.beginPath();rx.moveTo(x0,y0);rx.lineTo(x1,y1);rx.stroke();
      }
      rx.globalAlpha=1;rx.lineWidth=1;
    }
    if(Math.abs(x-nd.ox)>1||Math.abs(y-nd.oy)>1){
      rx.globalAlpha=(spread?0.28:0.4)*selDim;rx.strokeStyle=c;rx.setLineDash([2,3]);
      rx.beginPath();rx.moveTo(nd.ox,nd.oy);rx.lineTo(x,y);rx.stroke();
      rx.setLineDash([]);rx.globalAlpha=1;
    }
    plots.push({mac:d.mac,x,y,dr,haloR:dr,d});
    rx.globalAlpha=(inact?0.4:1)*selDim;
    const spawnT=selDim<1?1:Math.min(1,(now-(spawnAt[d.mac]||0))/SPAWN_MS);
    const pop=spawnT<1?easeOutBack(spawnT):1;
    if(d.mac===refMac) drawStar(x,y,dr+4,cssVar('--accent'));
    else if(inact){rx.strokeStyle=c;rx.lineWidth=1.5;
      rx.beginPath();rx.arc(x,y,dr,0,Math.PI*2);rx.stroke();rx.lineWidth=1;}
    else if(radarMode==='wifi'&&d.hid){
      rx.globalAlpha=0.55*selDim;rx.strokeStyle=c;rx.lineWidth=1.5;
      if(!d.ssid)rx.setLineDash([2,2]);
      rx.beginPath();rx.arc(x,y,dr,0,Math.PI*2);rx.stroke();
      rx.setLineDash([]);rx.lineWidth=1;rx.globalAlpha=1;}
    else if(selDim<1){
      rx.fillStyle=c;rx.beginPath();rx.arc(x,y,Math.max(0.1,dr*pop),0,Math.PI*2);rx.fill();
    }else{
      rx.save();rx.shadowColor=c;rx.shadowBlur=(hasCli?12:7)*zf;
      if(spawnT<1)rx.globalAlpha*=Math.min(1,spawnT*1.4+0.15);
      rx.fillStyle=c;rx.beginPath();rx.arc(x,y,Math.max(0.1,dr*pop),0,Math.PI*2);rx.fill();
      rx.restore();
    }
    if(nd.absorbFlash){
      rx.save();rx.globalAlpha=Math.sin(nd.absorbFlash*Math.PI)*selDim;
      rx.fillStyle='#fff';
      rx.beginPath();rx.arc(x,y,(nd.dr0||dr)+8*zf,0,Math.PI*2);rx.fill();
      rx.restore();
    }
    if(d.rogue&&!nd.pending){
      rx.save();rx.globalAlpha=0.85*selDim;
      rx.strokeStyle='#ff4040';rx.lineWidth=1.5*zf;
      rx.shadowColor='#ff4040';rx.shadowBlur=8*zf;
      rx.beginPath();rx.arc(x,y,dr+4*zf,0,Math.PI*2);rx.stroke();
      rx.restore();
    }
    if(sweepOn&&sweepHit[d.mac]!=null){
      const st=1-(perfNow-sweepHit[d.mac])/SWEEP_GLOW_MS;
      if(st>0){
        rx.save();
        rx.globalAlpha=st*0.85*selDim;
        rx.shadowColor=c;rx.shadowBlur=20*zf;
        rx.strokeStyle=c;rx.lineWidth=2*zf;
        rx.beginPath();rx.arc(x,y,dr+(1-st)*12*zf,0,Math.PI*2);rx.stroke();
        rx.restore();
      }else delete sweepHit[d.mac];
    }
    if(radarMode==='wifi'&&d.kind==='beacon'&&!inact&&nd.ringLw){
      const lw=nd.ringLw;
      const nc=beaconClients(d).length;
      const f=nc/maxCli;
      const rc=f>=0.75?'#ff9f40':f>=0.5?'#ffe14d':f>=0.25?'#4dff9e':'#4dd6ff';
      rx.save();rx.shadowColor=rc;rx.shadowBlur=selDim<1?0:6*zf;
      rx.globalAlpha=0.45*selDim;rx.strokeStyle=rc;rx.lineWidth=lw;
      rx.beginPath();rx.arc(x,y,dr+lw/2+2,0,Math.PI*2);rx.stroke();
      rx.restore();rx.lineWidth=1;rx.globalAlpha=1;
      lblR=nd.haloDr;
    }
    nd.haloR=lblR;
    plots[plots.length-1].haloR=nd.haloR;
    rx.globalAlpha=1;
    if(boxSel&&boxSel.has(d.mac)){
      rx.globalAlpha=selDim;rx.strokeStyle=cssVar('--accent');rx.lineWidth=1.5;
      rx.beginPath();rx.arc(x,y,dr+3,0,Math.PI*2);rx.stroke();rx.lineWidth=1;rx.globalAlpha=1;}
    if(radarMode==='wifi'&&d.isNew){
      rx.globalAlpha=selDim;rx.strokeStyle='#4dff9e';rx.lineWidth=1.5;rx.setLineDash([2,2]);
      rx.beginPath();rx.arc(x,y,dr+5,0,Math.PI*2);rx.stroke();
      rx.setLineDash([]);rx.lineWidth=1;rx.globalAlpha=1;}
    const parts=[];
    if(showName){const nm=d.name||d.vendor; if(nm)parts.push(nm);}
    if(showMac)parts.push(d.mac.slice(-8));
    if(parts.length){
      let lbl=parts.join(' '); if(lbl.length>22)lbl=lbl.slice(0,22);
      labels.push({x,y,dr:lblR,text:lbl,dim:selDim<1,mac:d.mac,manual:!!labelOffsets[d.mac],under:!!hasCli&&selActive&&selDim===1});
    }
  });
  if(sweepOn){
    rx.save();
    const tail=Math.PI/7, segs=20;
    for(let i=0;i<segs;i++){
      const t=i/segs, a=sweepAngle-t*tail;
      rx.globalAlpha=(1-t)*0.16;
      rx.strokeStyle=cssVar('--accent');rx.lineWidth=Math.max(1,(R*S)/40);
      rx.beginPath();rx.moveTo(scx,scy);rx.lineTo(scx+R*S*Math.cos(a),scy+R*S*Math.sin(a));rx.stroke();
    }
    rx.globalAlpha=0.9;rx.strokeStyle=cssVar('--accent');rx.lineWidth=1.5;
    rx.beginPath();rx.moveTo(scx,scy);rx.lineTo(scx+R*S*Math.cos(sweepAngle),scy+R*S*Math.sin(sweepAngle));rx.stroke();
    rx.restore();
  }
  lastSweepAngle=sweepAngle;
  const dotObstacles=nodes.filter(n=>!n.pending).map(n=>({x:n.x,y:n.y,dr:n.dr,dim:n.selDim<1}));
  clientPlots=[];
  if(radarMode==='wifi'&&expandedAPs.size){
    const clidot=getComputedStyle(document.documentElement).getPropertyValue('--clidot').trim();
    const now=performance.now();
    const doneCollapsing=[];
    expandedAPs.forEach(apMac=>{
      const apNode=nodeByMac[apMac];
      const dir=expandDir[apMac]||1;
      const t=Math.min(1,(now-(expandAnimStart[apMac]||0))/EXPAND_ANIM_MS);
      const BACK_C1=2.4, BACK_C3=BACK_C1+1;
      const tb=t-1;
      const outBack=1+BACK_C3*tb*tb*tb+BACK_C1*tb*tb;
      const ease=dir===1?outBack:1-t*t*t;
      if(!apNode||(dir===-1&&t>=1)){ if(dir===-1)doneCollapsing.push(apMac); return; }
      const clients=beaconClients({kind:'beacon',mac:apMac});
      const n=clients.length;
      const maxR=Math.min(apNode.dr+(40+Math.max(0,n-4)*8)*S, Math.min(W,H)*0.38);
      const haloR=(apNode.haloR||apNode.dr)+6*S;
      const minR=haloR+10*S;
      const apAvg=apNode.d&&typeof apNode.d.avg==='number'?apNode.d.avg:null;
      const AP_LBL_EXCL=22.5*Math.PI/180;
      const slotArc=Math.PI*2-2*AP_LBL_EXCL;
      clients.forEach((cm,i)=>{
        const cliDim=selActive&&!hlSet.has(cm)&&!hlSet.has(apMac)?DIM:1;
        const ang=AP_LBL_EXCL+((i+0.5)/n)*slotArc;
        const ci=wifiClientAp[cm]||{};
        let frac=1;
        if(apAvg!=null&&typeof ci.rssi==='number')frac=Math.min(1,Math.abs(apAvg-ci.rssi)/40);
        const radius=minR+frac*(maxR-minR);
        let tx=apNode.x+radius*Math.cos(ang), ty=apNode.y+radius*Math.sin(ang);
        const off=clientOffsets[cm];
        if(off){tx+=off.dx; ty+=off.dy;}
        const ddx=tx-apNode.x, ddy=ty-apNode.y, ddist=Math.hypot(ddx,ddy)||1;
        const ux=ddx/ddist, uy=ddy/ddist;
        const sx=apNode.x+ux*haloR, sy=apNode.y+uy*haloR;
        const lx=sx+(tx-sx)*ease, ly=sy+(ty-sy)*ease;
        rx.globalAlpha=0.85*cliDim;rx.strokeStyle=clidot;rx.lineWidth=1.5;
        rx.beginPath();rx.moveTo(sx,sy);rx.lineTo(lx,ly);rx.stroke();
        rx.globalAlpha=1;
        const dr=Math.max(0,6*ease*zf);
        clientPlots.push({mac:cm,x:tx,y:ty,dr:6*zf});
        rx.globalAlpha=Math.max(0,Math.min(1,ease))*cliDim;
        rx.save();rx.shadowColor=clidot;rx.shadowBlur=cliDim<1?0:6*zf;
        rx.fillStyle=clidot;
        rx.beginPath();rx.arc(lx,ly,dr,0,Math.PI*2);rx.fill();
        rx.restore();
        rx.strokeStyle=cssVar('--bg');rx.beginPath();rx.arc(lx,ly,dr,0,Math.PI*2);rx.stroke();
        rx.globalAlpha=1;
        if(dragClient&&dragClient.mac===cm){
          rx.strokeStyle='#fff';rx.lineWidth=1.5;
          rx.beginPath();rx.arc(lx,ly,dr+3,0,Math.PI*2);rx.stroke();rx.lineWidth=1;
        }
        if(newStationMacs.has(cm)){
          rx.globalAlpha=cliDim;rx.strokeStyle='#4dff9e';rx.lineWidth=1.5;rx.setLineDash([2,2]);
          rx.beginPath();rx.arc(lx,ly,dr+4,0,Math.PI*2);rx.stroke();
          rx.setLineDash([]);rx.lineWidth=1;rx.globalAlpha=1;
        }
        if(ease>0.85){
          dotObstacles.push({x:lx,y:ly,dr,dim:cliDim<1});
          const isRnd=(parseInt(cm.slice(0,2),16)&0x02)!==0;
          const ven=isRnd?'':(ouiVendor(cm)||'');
          let lbl=cm.slice(-8)+(ven?` (${ven})`:'');
          if(lbl.length>30)lbl=lbl.slice(0,29)+'…';
          labels.push({x:lx,y:ly,dr,text:lbl,side:lx<apNode.x?'left':'right',dim:cliDim<1,
                       mac:cm,manual:!!labelOffsets[cm]});
        }
      });
    });
    doneCollapsing.forEach(m=>{expandedAPs.delete(m); delete expandDir[m]; delete expandAnimStart[m];});
  }
  deauthPlots=[];
  if(radarMode==='wifi'&&(lastDeauth||[]).length){
    const DEAUTH_MARK_AGE_S=30;
    (lastDeauth||[]).filter(e=>e.age<=DEAUTH_MARK_AGE_S).forEach(e=>{
      const mac=e.bssid||e.src; if(!mac)return;
      const r=R*rFrac(e.rssi), a=angOf(mac);
      const [x,y]=map(cx+r*Math.cos(a), cy+r*Math.sin(a));
      const dr=7*zf;
      deauthPlots.push({x,y,dr,e});
      rx.save();
      rx.strokeStyle='#ff3b3b';rx.fillStyle='#ff3b3b';rx.lineWidth=1.5;
      rx.beginPath();rx.arc(x,y,dr,0,Math.PI*2);rx.stroke();
      rx.beginPath();rx.moveTo(x,y-6*zf);rx.lineTo(x+5*zf,y+4*zf);rx.lineTo(x-5*zf,y+4*zf);rx.closePath();rx.fill();
      rx.fillStyle=cssVar('--bg');rx.font=`bold ${8*zf}px monospace`;rx.textAlign='center';
      rx.fillText('!',x,y+3.5*zf);
      rx.restore();
    });
  }
  Object.keys(hist).forEach(m=>{if(!present[m])delete hist[m];});
  drawLabels(labels,W,H,spread||(radarMode==='wifi'&&expandedAPs.size>0),dotObstacles,lzf);
  if(selRect){
    rx.save();
    rx.strokeStyle=cssVar('--accent');rx.lineWidth=1;rx.setLineDash([5,4]);
    rx.globalAlpha=0.12;rx.fillStyle=cssVar('--accent');
    rx.fillRect(selRect.x,selRect.y,selRect.w,selRect.h);
    rx.globalAlpha=1;
    rx.strokeRect(selRect.x,selRect.y,selRect.w,selRect.h);
    rx.restore();
  }
  document.getElementById('hm').textContent=devs.length;
  const zl=document.getElementById('zlvl'); if(zl)zl.textContent=Math.round(S*100)+'%';
  if(syncFromRadar) renderDevices();
  if(nodeMenuMac){
    const p=plots.find(x=>x.mac===nodeMenuMac);
    p?positionNodeMenu(p):hideNodeMenu();
  }
}
/**
 * Draws device labels on the radar canvas with collision avoidance against previously placed labels
 * and dot obstacles, trying successive vertical/side offsets before giving up (or, in `force` mode,
 * clamping into view and never dropping — used for spread mode or an expanded AP). Manually dragged
 * labels (labelOffsets) are drawn at their saved offset without collision search. Populates
 * labelPlots with each drawn label's hit box for later hit-testing.
 * @param labels Label descriptors ({x,y,dr,text,mac,side,dim,under,manual}) to place.
 * @param W Canvas width.
 * @param H Canvas height.
 * @param force Whether to force-place every label (never drop) and clamp positions into view.
 * @param obstacles Dot circles ({x,y,dr,dim}) labels must avoid overlapping.
 * @param zf Zoom-dependent scale factor applied to font size and spacing.
 */
function drawLabels(labels,W,H,force,obstacles,zf){
  zf=zf||1;
  rx.font=`${Math.round(11*zf)}px monospace`; rx.textAlign='left';
  labelPlots=[];
  const underline=(l,lx,ly,w)=>{ if(!l.under)return;
    rx.beginPath();rx.moveTo(lx,ly+2);rx.lineTo(lx+w,ly+2);rx.stroke(); };
  const manual=labels.filter(l=>l.manual), auto=labels.filter(l=>!l.manual);
  const placed=(obstacles||[]).map(o=>({x:o.x-o.dr,y:o.y-o.dr,w:o.dr*2,h:o.dr*2,dim:!!o.dim}));
  const LH=13*zf, maxTry=force?60:7;
  const GAP=8*zf;
  auto.sort((a,b)=>a.y-b.y);
  const collides=(box,ignoreBg)=>placed.some(p=>(!ignoreBg||!p.dim)&&
                                      box.x<p.x+p.w&&box.x+box.w>p.x&&
                                      box.y<p.y+p.h&&box.y+box.h>p.y);
  auto.forEach(l=>{
    const w=l.text.length*6.6*zf, ly0=l.y+4;
    const ignoreBg=!l.dim;
    if(l.side==='left'||l.side==='right'){
      let side=l.side, lx=side==='left'?l.x-l.dr-GAP-w:l.x+l.dr+GAP, ly=ly0;
      if(side==='left'){ if(lx<2){side='right';lx=l.x+l.dr+GAP;} }
      else if(lx+w>W){ side='left'; lx=l.x-l.dr-GAP-w; }
      let box={x:lx,y:ly-10,w,h:LH}, tries=0;
      while(tries<maxTry && collides(box,ignoreBg)){ ly+=LH; box.y=ly-10; tries++; }
      if(force){
        ly=Math.max(10,Math.min(H-3,ly)); box.y=ly-10;
        lx=Math.max(2,Math.min(W-2-w,lx)); box.x=lx;
      }
      else if(tries>=maxTry || ly<8 || ly>H-2) return;
      if(Math.abs(ly-ly0)>3){
        const anchorX=side==='left'?lx+w:lx;
        rx.save();rx.globalAlpha=(l.dim?0.3:1)*0.5;rx.strokeStyle='#5a6b85';rx.lineWidth=1;
        rx.beginPath();rx.moveTo(l.x,l.y);rx.lineTo(anchorX,ly-3);rx.stroke();
        rx.restore();
      }
      rx.globalAlpha=l.dim?0.3:1;
      rx.fillStyle='#e6ecf5'; rx.fillText(l.text,lx,ly);
      rx.strokeStyle='#e6ecf5'; rx.lineWidth=1; underline(l,lx,ly,w);
      rx.globalAlpha=1;
      box.dim=!!l.dim;
      placed.push(box);
      if(l.mac) labelPlots.push({mac:l.mac,x:box.x-3,y:box.y-1,w:box.w+6,h:box.h+2});
      return;
    }
    let found=null;
    for(let k=0;k<=maxTry&&!found;k++){
      const dy=k===0?0:Math.ceil(k/2)*LH*(k%2===1?1:-1);
      const ly=ly0+dy;
      if(ly<8||ly>H-2) continue;
      for(const side of ['right','left']){
        const lx=side==='left'?l.x-l.dr-GAP-w:l.x+l.dr+GAP;
        if(side==='left'){ if(lx<2) continue; } else if(lx+w>W) continue;
        const box={x:lx,y:ly-10,w,h:LH};
        if(!collides(box,ignoreBg)){ found={box,lx,ly,side}; break; }
      }
    }
    if(!found){
      if(!force) return;
      const ly=Math.max(10,Math.min(H-3,ly0)), lx=Math.max(2,Math.min(W-2-w,l.x+l.dr+GAP));
      found={box:{x:lx,y:ly-10,w,h:LH},lx,ly,side:'right'};
    }
    const {box,lx,ly,side}=found;
    if(Math.abs(ly-ly0)>3){
      const anchorX=side==='left'?lx+w:lx;
      rx.save();rx.globalAlpha=(l.dim?0.3:1)*0.5;rx.strokeStyle='#5a6b85';rx.lineWidth=1;
      rx.beginPath();rx.moveTo(l.x,l.y);rx.lineTo(anchorX,ly-3);rx.stroke();
      rx.restore();
    }
    rx.globalAlpha=l.dim?0.3:1;
    rx.fillStyle='#e6ecf5'; rx.fillText(l.text,lx,ly);
    rx.strokeStyle='#e6ecf5'; rx.lineWidth=1; underline(l,lx,ly,w);
    rx.globalAlpha=1;
    box.dim=!!l.dim;
    placed.push(box);
    if(l.mac) labelPlots.push({mac:l.mac,x:box.x-3,y:box.y-1,w:box.w+6,h:box.h+2});
  });
  manual.forEach(l=>{
    const w=l.text.length*6.6*zf;
    let lx=l.side==='left'?l.x-l.dr-GAP-w:l.x+l.dr+GAP, ly=l.y+4;
    const off=labelOffsets[l.mac]||{dx:0,dy:0};
    lx+=off.dx; ly+=off.dy;
    lx=Math.max(2,Math.min(W-2-w,lx)); ly=Math.max(10,Math.min(H-3,ly));
    if(off.dx||off.dy){
      const anchorX=l.side==='left'?lx+w:lx;
      rx.save();rx.globalAlpha=(l.dim?0.3:1)*0.5;rx.strokeStyle='#5a6b85';rx.lineWidth=1;
      rx.beginPath();rx.moveTo(l.x,l.y);rx.lineTo(anchorX,ly-3);rx.stroke();
      rx.restore();
    }
    rx.globalAlpha=l.dim?0.3:1;
    rx.fillStyle='#e6ecf5'; rx.fillText(l.text,lx,ly);
    rx.strokeStyle='#e6ecf5'; rx.lineWidth=1; underline(l,lx,ly,w);
    rx.globalAlpha=1;
    labelPlots.push({mac:l.mac,x:lx-3,y:ly-11,w:w+6,h:LH+2});
  });
}
/**
 * Nudges overlapping radar nodes apart via iterative pairwise repulsion, bounding how far each node is
 * allowed to drift from its true (radial) position so labels/dots don't overlap without breaking the
 * radial layout.
 * @param nodes Node list (mutated in place) with x/y/ox/oy/haloDr fields.
 */
function declutter(nodes){
  const pad=2;
  for(let it=0; it<10; it++){
    for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
      const a=nodes[i], b=nodes[j];
      let dx=b.x-a.x, dy=b.y-a.y, dist=Math.hypot(dx,dy)||0.01;
      const min=a.haloDr+b.haloDr+pad;
      if(dist>=min)continue;
      const push=(min-dist)/2; dx/=dist; dy/=dist;
      const maxA=a.haloDr*1.8+10, maxB=b.haloDr*1.8+10;
      if(Math.hypot(a.x-a.ox,a.y-a.oy)<maxA){a.x-=dx*push; a.y-=dy*push;}
      if(Math.hypot(b.x-b.ox,b.y-b.oy)<maxB){b.x+=dx*push; b.y+=dy*push;}
    }
  }
}
/**
 * Spreads radar nodes apart via iterative pairwise repulsion (used in spread mode, unconstrained by
 * radial position) and clamps every node's final position within the canvas bounds.
 * @param nodes Node list (mutated in place) with x/y/haloDr fields.
 * @param W Canvas width.
 * @param H Canvas height.
 */
function relaxNodes(nodes,W,H){
  const pad=16;
  for(let it=0; it<80; it++){
    for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
      const a=nodes[i], b=nodes[j];
      let dx=b.x-a.x, dy=b.y-a.y, dist=Math.hypot(dx,dy)||0.01;
      const min=a.haloDr+b.haloDr+pad;
      if(dist<min){const push=(min-dist)/2; dx/=dist; dy/=dist;
        a.x-=dx*push; a.y-=dy*push; b.x+=dx*push; b.y+=dy*push;}
    }
    nodes.forEach(n=>{n.x=Math.max(n.haloDr+2,Math.min(W-n.haloDr-2,n.x));
                      n.y=Math.max(n.haloDr+2,Math.min(H-n.haloDr-2,n.y));});
  }
}
/**
 * Builds an inline SVG sparkline of a MAC's recent RSSI history (rhist) with a summary caption.
 * @param mac MAC address to look up in rhist.
 * @returns SVG+caption HTML markup, or an empty string when fewer than 2 samples are recorded.
 */
function spark(mac){
  const a=rhist[mac]||[]; if(a.length<2) return '';
  const w=200,h=34,mn=Math.min(...a),mx=Math.max(...a),rng=(mx-mn)||1;
  const pts=a.map((v,i)=>`${(i/(a.length-1)*w).toFixed(1)},${(h-2-(v-mn)/rng*(h-4)).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}" style="display:block;margin:4px 0">
    <polyline fill="none" stroke="${cssVar('--accent')||'#4da3ff'}" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${pts}"/></svg>
    <span class="muted">rssi ${mn}..${mx} dBm, last ${a.length} samples</span>`;
}
let tipPinned=false;
let selectedMac=null;
/**
 * Builds the set of MACs to highlight on the radar for the current selection: the selected MAC itself,
 * plus its associated stations if it's a beacon, or its associated AP if it's a client.
 * @returns Set of MAC strings to highlight (empty if nothing is selected).
 */
function highlightSet(){
  const s=new Set(); if(!selectedMac)return s;
  s.add(selectedMac);
  if(radarMode==='wifi'){
    const d=(lastWifi||[]).find(x=>x.mac===selectedMac);
    if(d&&d.kind==='beacon') beaconClients(d).forEach(m=>s.add(m));
    else{ const ap=wifiClientAp[selectedMac]; if(ap) s.add(ap.bssid); }
  }
  return s;
}

/**
 * Builds the WiFi-specific detail lines (kind, channel, associated stations or probe target) for a
 * device's tip/tooltip HTML.
 * @param d Device/WiFi record to describe.
 * @param pin Accepted for signature parity with the caller; unused by this function.
 * @returns HTML fragment to append to the tip content.
 */
function wifiTipDetail(d,pin){
  const kb=(WKIND[d.kind]||WKIND.probe)[0];
  let s=`<br>${kb}`+(d.kind==='probe'?'':` &middot; ch ${d.ch}`);
  if(d.kind==='beacon'){
    const cl=beaconClients(d);
    const line=cm=>{ const isRnd=(parseInt(cm.slice(0,2),16)&0x02)!==0;
      const cw=(lastWifi||[]).find(x=>x.mac===cm);
      const v=isRnd?'':(ouiVendor(cm)||(cw&&cw.vendor)||'');
      return esc(cm)+(v?` <span class="venlbl">(${esc(v)})</span>`:''); };
    s+=`<br><b>${cl.length} station${cl.length===1?'':'s'} associated</b>`+
       (cl.length?`<br><span class="muted">${cl.slice(0,14).map(line).join('<br>')}`+
                  (cl.length>14?`<br>… +${cl.length-14} more`:'')+`</span>`:'');
  }else{
    const ap=wifiClientAp[d.mac];
    if(ap) s+=`<br><span class="muted">associated to ${esc(ap.bssid)}`+
              (ap.ssid?` (${esc(ap.ssid)})`:'')+`</span>`;
    else   s+=`<br><span class="muted">probing for “${esc(d.ssid)}”</span>`;
  }
  return s;
}
/**
 * Renders and shows the device hover/pinned tip: MAC, vendor, kind badge, name, RSSI stats, WiFi
 * detail, sparkline, and (when pinned) an Actions menu (set/clear radar focus, scout/local-radio
 * channel client scan, full details). Positions the tip centred on screen when pinned, else anchored
 * near the pointer (px,py), clamped to stay within the viewport. Updates #tip and tipPinned.
 * @param p Plot entry ({d, ...}) for the device being shown.
 * @param px Screen-space X of the pointer/anchor (ignored when pinned).
 * @param py Screen-space Y of the pointer/anchor (ignored when pinned).
 * @param pin Whether to show the tip pinned (persistent, closable) vs. a transient hover tip.
 */
function showTip(p,px,py,pin){
  const d=p.d, t=document.getElementById('tip'), nm=d.name||d.vendor||'';
  const isRef=d.mac===refMac;
  const isGpsRef=!!gpsFocus&&gpsFocus.mac===d.mac;
  const kindTag=`<span class="tag ${d.kind==='beacon'?'PUB':'RND'}">${d.kind==='beacon'?'BEACON':'PROBE'}</span>`;
  const tipVen=d.oui?(ouiVendor(d.mac)||d.vendor||''):'';
  t.innerHTML=(pin?`<button class="tipx" onclick="hideTip()" title="close">&times;</button>`:'')+
    `<b>${esc(d.mac)}</b>${tipVen?` <span class="venlbl">(${esc(tipVen)})</span>`:''} ${kindTag}`+
    (nm?`<br>${esc(nm)}`:'')+
    `<br>rssi ${d.rssi} &middot; avg ${d.avg} <span class="muted">(min ${d.min} / max ${d.max})</span>`+
    `<br>cnt ${d.cnt} &middot; age ${d.age}s`+wifiTipDetail(d,pin)+
    (isRef?`<br><b style="color:#4da3ff">&#9678; radar focus marker</b>`:'')+
    `<br>${spark(d.mac)}`+
    (pin?`<div class="tipbtns"><div class="actmenu-wrap">
      <button id="tipActBtn" class="scoutTgtBtn actmenu-btn" onclick="toggleTipActions(event)">Actions <span class="car">&#9662;</span></button>
      <div id="tipActMenu" class="actmenu">`+
      `<button class="actmenu-item${isRef?' on':''}" data-mac="${esc(d.mac)}" onclick="closeTipActions();tgtTip(this.dataset.mac)">`+
        `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="1.6" fill="currentColor" stroke="none"/></svg>`+
        (isRef?'Clear radar focus':'Set radar focus')+'</button>'+
      (d.lat!=null?`<button class="actmenu-item${isGpsRef?' on':''}" data-mac="${esc(d.mac)}" onclick="closeTipActions();gpsTgtTip(this.dataset.mac)"
         title="Filter the radar/table to devices within a chosen distance of this device's logged GPS position">`+
         `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 17s6-5.5 6-9.5A6 6 0 0 0 4 7.5C4 11.5 10 17 10 17z"/><circle cx="10" cy="7.5" r="1.8"/></svg>`+
         (isGpsRef?'Clear GPS focus':'Set GPS focus')+'</button>':'')+
      (radarMode==='wifi'&&scoutLinked&&d.kind==='beacon'&&d.ch?
      `<button class="actmenu-item${scoutChanActive(d.ch)?' on':''}" onclick="closeTipActions();targetScoutChannel(this,${d.ch},true)"
         title="Scan for clients via scout on ch ${d.ch} — flushes it + forwards Probe/Assoc/Resp/Deauth+Data for this AP, beacons excluded">`+
         `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 12a10 10 0 0 1 12 0"/><path d="M7 15a5.5 5.6 0 0 1 6 0"/><circle cx="10" cy="17" r="1.1" fill="currentColor" stroke="none"/></svg>`+
         `Scan for clients (ch ${d.ch})</button>`:'')+
      (radarMode==='wifi'&&d.kind==='beacon'&&d.ch&&(!is5gChan(d.ch)||capDualBand)?
      `<button class="actmenu-item${capChanActive(d.ch)?' on':''}" onclick="closeTipActions();captureChannel(${d.ch})"
         title="Scan for clients via this board's own radio, locked to ch ${d.ch} — forwards Probe/Assoc/Deauth+Data, beacons excluded, no scout needed">`+
         `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="2.6" fill="currentColor" stroke="none"/></svg>`+
         `Scan for clients (ch ${d.ch})</button>`:'')+
      (radarMode==='wifi'?`<button class="actmenu-item" data-mac="${esc(d.mac)}" onclick="closeTipActions();hideTip();showMacInfo(this.dataset.mac)" title="Open full details + all actions for this MAC">`+
        `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><path d="M10 13.2v-3.4M10 7v.1"/></svg>`+
        `Full details&hellip;</button>`:'')+
      `</div></div></div>`:'');
  t.style.display='block';
  tipPinned=!!pin; t.style.pointerEvents=pin?'auto':'none';
  t.classList.toggle('pinned',!!pin);
  if(pin){
    const b=t.getBoundingClientRect();
    t.style.left=Math.max(6,(innerWidth-b.width)/2)+'px';
    t.style.top=Math.max(6,(innerHeight-b.height)/2)+'px';
    return;
  }
  const b=t.getBoundingClientRect();
  let x=px+14,y=py+14;
  if(x+b.width>innerWidth) x=px-b.width-14;
  if(y+b.height>innerHeight) y=py-b.height-14;
  t.style.left=x+'px'; t.style.top=y+'px';
}
/**
 * Hides the device tip, resets pin/pointer-events state, closes the actions menu and node menu, and
 * clears the current radar selection (redrawing) if one was set.
 */
function hideTip(){const t=document.getElementById('tip');
  t.style.display='none'; tipPinned=false; t.style.pointerEvents='none';
  hideNodeMenu(); closeTipActions();
  if(selectedMac){selectedMac=null; drawRadar(lastDevs);}}
/**
 * Selects a device and shows its tip pinned, then redraws the radar to reflect the new selection.
 * @param p Plot entry for the device to pin.
 */
function pinTip(p){selectedMac=p.d.mac; showTip(p,0,0,true); drawRadar(lastDevs);}
/**
 * Renders and shows the tip for a deauth/disassoc event: source, target AP (with SSID if known),
 * station, reason, count and age. Positions the tip centred when pinned, else anchored near the
 * pointer, clamped to the viewport. Updates #tip and tipPinned.
 * @param p Deauth plot entry ({e, ...}) for the event being shown.
 * @param px Screen-space X of the pointer/anchor (ignored when pinned).
 * @param py Screen-space Y of the pointer/anchor (ignored when pinned).
 * @param pin Whether to show the tip pinned (persistent, closable) vs. a transient hover tip.
 */
function showDeauthTip(p,px,py,pin){
  const t=document.getElementById('tip'), e=p.e;
  const ap=(lastWifi||[]).find(w=>w.mac===e.bssid);
  const ssid=ap?(ap.ssid||(ap.hid?'‹hidden›':'')):'';
  t.innerHTML=(pin?`<button class="tipx" onclick="hideTip()" title="close">&times;</button>`:'')+
    `<b>${esc(e.src)}</b> <span class="tag wcli">${e.dis?'DISASSOC':'DEAUTH'}</span>`+
    `<br>targeting <b>${esc(e.bssid)}</b>`+(ssid?` <span class="venlbl">(${esc(ssid)})</span>`:'')+
    `<br>station ${esc(e.dst)}`+
    `<br>reason ${reasonTxt(e.reason)} &middot; cnt ${e.cnt} &middot; age ${e.age}s &middot; rssi ${e.rssi}`+
    (pin?`<div class="tipbtns"><button class="scoutTgtBtn" data-mac="${esc(e.src)}" onclick="hideTip();showMacInfo(this.dataset.mac)">Full details&hellip;</button></div>`:'');
  t.style.display='block';
  tipPinned=!!pin; t.style.pointerEvents=pin?'auto':'none';
  t.classList.toggle('pinned',!!pin);
  if(pin){
    const b=t.getBoundingClientRect();
    t.style.left=Math.max(6,(innerWidth-b.width)/2)+'px';
    t.style.top=Math.max(6,(innerHeight-b.height)/2)+'px';
    return;
  }
  const b=t.getBoundingClientRect();
  let x=px+14,y=py+14;
  if(x+b.width>innerWidth) x=px-b.width-14;
  if(y+b.height>innerHeight) y=py-b.height-14;
  t.style.left=x+'px'; t.style.top=y+'px';
}
/**
 * Shows a deauth/disassoc event's tip pinned and redraws the radar.
 * @param p Deauth plot entry to pin.
 */
function pinDeauthTip(p){showDeauthTip(p,0,0,true); drawRadar(lastDevs);}
/**
 * Toggles the pinned tip's Actions dropdown menu open/closed, positioning it under (or above, if it
 * would overflow the viewport) its trigger button and clamping it horizontally within the viewport.
 * @param e Triggering event, if any (its propagation is stopped so the document-level outside-click
 * handler doesn't immediately close the menu it just opened).
 */
function toggleTipActions(e){ if(e)e.stopPropagation();
  const m=document.getElementById('tipActMenu'), b=document.getElementById('tipActBtn');
  if(!m||!b)return;
  if(m.classList.contains('on')){ closeTipActions(); return; }
  const r=b.getBoundingClientRect(), mw=Math.min(260,innerWidth-16);
  m.style.minWidth=mw+'px'; m.classList.add('on'); b.classList.add('on');
  const mh=m.offsetHeight;
  let left=Math.max(8,Math.min(r.left,innerWidth-mw-8));
  let top=r.bottom+6;
  if(top+mh>innerHeight-8) top=Math.max(8,r.top-mh-6);
  m.style.left=left+'px'; m.style.top=top+'px'; }
/** Closes the pinned tip's Actions dropdown menu, if open. */
function closeTipActions(){
  const m=document.getElementById('tipActMenu'), b=document.getElementById('tipActBtn');
  if(m)m.classList.remove('on'); if(b)b.classList.remove('on'); }
document.addEventListener('click',e=>{
  const m=document.getElementById('tipActMenu'); if(!m||!m.classList.contains('on'))return;
  if(!e.target.closest('#tipActMenu')&&!e.target.closest('#tipActBtn')) closeTipActions(); });
(function(){
  const t=document.getElementById('tip');
  let dr=null;
  t.addEventListener('mousedown',e=>{
    if(!tipPinned||e.target.closest('button'))return;
    const b=t.getBoundingClientRect();
    dr={x0:e.clientX,y0:e.clientY,l0:b.left,t0:b.top};
    t.classList.add('dragging'); e.preventDefault();
  });
  window.addEventListener('mousemove',e=>{
    if(!dr)return;
    const b=t.getBoundingClientRect();
    let l=dr.l0+(e.clientX-dr.x0), tp=dr.t0+(e.clientY-dr.y0);
    l=Math.max(2,Math.min(innerWidth-b.width-2,l));
    tp=Math.max(2,Math.min(innerHeight-b.height-2,tp));
    t.style.left=l+'px'; t.style.top=tp+'px';
  });
  window.addEventListener('mouseup',()=>{ if(dr){dr=null; t.classList.remove('dragging');} });
})();
/**
 * Sets the radar reference/focus MAC and hides the current tip.
 * @param mac MAC address to set as the radar reference.
 */
function tgtTip(mac){setRef(mac); hideTip();}
/**
 * Sets (or clears) the radar's GPS focus point from a pinned tip and hides the tip.
 * @param mac MAC address whose GPS position becomes the focus point.
 */
function gpsTgtTip(mac){setGpsFocus(mac); hideTip();}
let drag=null;
/**
 * Converts a mouse event's client coordinates to radar-canvas-local coordinates.
 * @param e Mouse event.
 * @returns [x,y] canvas-local coordinates.
 */
function radarXY(e){const r=rc.getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top];}
let lpTimer=null, lpStart=null;
/**
 * Finds the nearest plotted beacon-with-associated-clients under a canvas point, for long-press
 * expand. Returns null outside WiFi mode or when beaconClients isn't available.
 * @param mx Canvas-local X.
 * @param my Canvas-local Y.
 * @returns The closest matching plot entry within its hit radius, or null.
 */
function lpHitBeacon(mx,my){
  if(radarMode!=='wifi'||typeof beaconClients!=='function')return null;
  let hit=null,best=1e9;
  plots.forEach(p=>{const dd=Math.hypot(p.x-mx,p.y-my);
    if(dd<=p.dr+6&&dd<best&&p.d.kind==='beacon'&&beaconClients(p.d).length){best=dd;hit=p;}});
  return hit;
}
/**
 * Arms a 3-second long-press timer that toggles the expand/collapse state of the beacon under the
 * given point, if any. Clears any previously pending timer first.
 * @param mx Canvas-local X of the press.
 * @param my Canvas-local Y of the press.
 */
function armLongPress(mx,my){
  clearTimeout(lpTimer); lpTimer=null;
  const hit=lpHitBeacon(mx,my);
  if(!hit)return;
  lpStart={x:mx,y:my};
  lpTimer=setTimeout(()=>{lpTimer=null; toggleExpand(hit.d.mac);},3000);
}
/** Cancels any pending long-press timer and clears its tracked start position. */
function cancelLongPress(){clearTimeout(lpTimer); lpTimer=null; lpStart=null;}
/**
 * Finds the nearest plotted expanded-AP client dot under a canvas point.
 * @param mx Canvas-local X.
 * @param my Canvas-local Y.
 * @returns The closest matching client plot entry within its hit radius, or null.
 */
function clientHit(mx,my){
  let hit=null,best=1e9;
  clientPlots.forEach(p=>{const dd=Math.hypot(p.x-mx,p.y-my); if(dd<=p.dr+6&&dd<best){best=dd;hit=p;}});
  return hit;
}
/**
 * Finds a drawn label's hit box under a canvas point, restricted to devices in the current highlight
 * set.
 * @param mx Canvas-local X.
 * @param my Canvas-local Y.
 * @returns The matching label plot entry, or null if none match or nothing is currently selected.
 */
function labelHit(mx,my){
  if(!selectedMac)return null;
  const hl=highlightSet();
  for(const p of labelPlots){
    if(!hl.has(p.mac))continue;
    if(mx>=p.x&&mx<=p.x+p.w&&my>=p.y&&my<=p.y+p.h)return p;
  }
  return null;
}
rc.addEventListener('mousedown',e=>{
  const[mx,my]=radarXY(e);
  const lhit=labelHit(mx,my);
  if(lhit){
    const off=labelOffsets[lhit.mac]||{dx:0,dy:0};
    dragLabel={mac:lhit.mac,x0:mx,y0:my,baseDx:off.dx,baseDy:off.dy};
    return;
  }
  const chit=clientHit(mx,my);
  if(chit){
    const off=clientOffsets[chit.mac]||{dx:0,dy:0};
    dragClient={mac:chit.mac,x0:mx,y0:my,baseDx:off.dx,baseDy:off.dy};
    return;
  }
  const pan=e.shiftKey||e.button===2||e.button===1;
  drag={x0:mx,y0:my,mode:pan?'pan':'box',ox:view.cx,oy:view.cy}; hideTip();
  if(!pan)armLongPress(mx,my);
});
rc.addEventListener('mousemove',e=>{
  const[mx,my]=radarXY(e);
  if(dragLabel){
    labelOffsets[dragLabel.mac]={dx:dragLabel.baseDx+(mx-dragLabel.x0),
                                  dy:dragLabel.baseDy+(my-dragLabel.y0)};
    drawRadar(lastDevs); return;
  }
  if(dragClient){
    clientOffsets[dragClient.mac]={dx:dragClient.baseDx+(mx-dragClient.x0),
                                    dy:dragClient.baseDy+(my-dragClient.y0)};
    drawRadar(lastDevs); return;
  }
  if(lpTimer&&lpStart&&Math.hypot(mx-lpStart.x,my-lpStart.y)>6)cancelLongPress();
  if(drag){
    if(drag.mode==='box'){
      selRect={x:Math.min(drag.x0,mx),y:Math.min(drag.y0,my),
               w:Math.abs(mx-drag.x0),h:Math.abs(my-drag.y0)};
      drawRadar(lastDevs);
    }else{
      const[cx0,cy0]=viewCtr(lastW,lastH);
      view.cx=cx0-(mx-drag.x0)/view.s; view.cy=cy0-(my-drag.y0)/view.s;
      drag.x0=mx; drag.y0=my; drawRadar(lastDevs);
    }
    return;
  }
  if(tipPinned)return;
  if(nodeMenuMac){
    const wrap=document.getElementById('nodeMenu');
    if(wrap&&nodeMenuPlot){
      const dd=Math.hypot(nodeMenuPlot.x-mx,nodeMenuPlot.y-my);
      wrap.classList.toggle('faded',dd>nodeMenuPlot.dr+10);
    }
    return;
  }
  let dhit=null,dbest=1e9;
  deauthPlots.forEach(p=>{const dd=Math.hypot(p.x-mx,p.y-my); if(dd<=p.dr+4&&dd<dbest){dbest=dd;dhit=p;}});
  if(dhit){showDeauthTip(dhit,e.clientX,e.clientY); return;}
  let hit=null,best=1e9;
  plots.forEach(p=>{const dd=Math.hypot(p.x-mx,p.y-my); if(dd<=p.dr+4&&dd<best){best=dd;hit=p;}});
  hit?showTip(hit,e.clientX,e.clientY):hideTip();
});
/**
 * Finalizes the current canvas drag: if it was a box-select drag with a large-enough rectangle,
 * captures the enclosed MACs into boxSel, re-renders the devices table, and zooms the view to fit the
 * rectangle. Clears drag/selRect state and redraws.
 */
function endDrag(){
  if(drag&&drag.mode==='box'&&selRect&&selRect.w>8&&selRect.h>8){
    const sel=new Set();
    plots.forEach(p=>{if(p.x>=selRect.x&&p.x<=selRect.x+selRect.w&&
                        p.y>=selRect.y&&p.y<=selRect.y+selRect.h)sel.add(p.mac);});
    if(sel.size){boxSel=sel; renderDevices();}
    zoomToRect(selRect);
  }
  drag=null; selRect=null; drawRadar(lastDevs);
}
rc.addEventListener('mouseup',e=>{
  if(dragLabel){dragLabel=null; drawRadar(lastDevs); return;}
  if(dragClient){dragClient=null; drawRadar(lastDevs); return;}
  cancelLongPress();
  const click=drag&&drag.mode==='box', sx=drag?drag.x0:0, sy=drag?drag.y0:0;
  endDrag();
  if(click){
    const[mx,my]=radarXY(e);
    if(Math.abs(mx-sx)+Math.abs(my-sy)<6){
      let dhit=null,dbest=1e9;
      deauthPlots.forEach(p=>{const dd=Math.hypot(p.x-mx,p.y-my); if(dd<=p.dr+6&&dd<dbest){dbest=dd;dhit=p;}});
      if(dhit){ hideNodeMenu(); pinDeauthTip(dhit); return; }
      let hit=null,best=1e9;
      plots.forEach(p=>{const dd=Math.hypot(p.x-mx,p.y-my); if(dd<=p.dr+6&&dd<best){best=dd;hit=p;}});
      if(hit&&hit.d.kind==='beacon'&&beaconClients(hit.d).length) showNodeMenu(hit);
      else{ hideNodeMenu(); hit?pinTip(hit):hideTip(); }
    }
  }
});
rc.addEventListener('dblclick',e=>{
  const[mx,my]=radarXY(e);
  let hit=null,best=1e9;
  plots.forEach(p=>{const dd=Math.hypot(p.x-mx,p.y-my); if(dd<=p.dr+6&&dd<best){best=dd;hit=p;}});
  if(!hit||hit.d.kind!=='beacon'||!beaconClients(hit.d).length)return;
  hideNodeMenu(); hideTip();
  selectedMac=hit.d.mac; macInfoOwnsSelect=true; drawRadar(lastDevs);
  showMacInfo(hit.d.mac);
});
rc.addEventListener('mouseleave',()=>{dragLabel=null; dragClient=null; cancelLongPress(); if(!tipPinned&&!nodeMenuMac)hideTip(); if(drag)endDrag();});
rc.addEventListener('contextmenu',e=>e.preventDefault());
let wheelZoom=true;
/**
 * Sets whether the mouse wheel zooms the radar (vs. page-scrolls) and updates the #wheelInd indicator.
 * @param on Whether wheel-zoom mode is enabled.
 */
function setWheelZoom(on){wheelZoom=on;
  const w=document.getElementById('wheelInd');
  if(w)w.textContent='wheel:'+(on?'zoom':'scroll');}
rc.addEventListener('wheel',e=>{
  if(!wheelZoom)return;
  e.preventDefault();
  const[mx,my]=radarXY(e); zoomAtScreen(mx,my,e.deltaY<0?1.15:1/1.15);
},{passive:false});
(function(){const bar=document.getElementById('rband'); if(!bar)return;
  bar.addEventListener('wheel',e=>{
    e.preventDefault(); e.stopPropagation();
    const s=document.getElementById('band'), st=(+s.step)||1;
    let v=(+s.value)+(e.deltaY<0?st:-st);
    v=Math.max(+s.min,Math.min(+s.max,v));
    if(v!==+s.value){s.value=v; onBandInput();}
  },{passive:false});
})();
document.addEventListener('keydown',e=>{
  if(e.key!=='m'&&e.key!=='M')return;
  const t=e.target.tagName; if(t==='INPUT'||t==='TEXTAREA'||t==='SELECT')return;
  setWheelZoom(!wheelZoom);
});
document.addEventListener('keydown',e=>{
  if(e.key!=='/'&&e.key!=='?'&&e.key!=='*')return;
  const t=e.target.tagName; if(t==='INPUT'||t==='TEXTAREA'||t==='SELECT')return;
  if(curView!=='devices')return;
  e.preventDefault();
  if(e.key==='/'){
    const pop=document.getElementById('devSearchPop');
    if(pop.style.display==='none') toggleDevSearch(); else document.getElementById('devSearch').focus();
  }else if(e.key==='?'){
    if(typeof toggleWifiFilters==='function') toggleWifiFilters();
  }else if(e.key==='*'){
    if(typeof resetWifiFilters==='function') resetWifiFilters(); else clearDevFilters();
  }
});
document.addEventListener('keydown',e=>{
  if(e.key!=='ArrowUp'&&e.key!=='ArrowDown'&&e.key!=='Enter')return;
  const t=e.target.tagName; if(t==='INPUT'||t==='TEXTAREA'||t==='SELECT')return;
  if(curView!=='devices'||!devRowOrder.length)return;
  if(e.key==='Enter'){
    if(selMac&&devRowOrder.includes(selMac)){ e.preventDefault(); showMacInfo(selMac); }
    return;
  }
  e.preventDefault();
  let i=devRowOrder.indexOf(selMac);
  i=(e.key==='ArrowDown')?Math.min(i+1,devRowOrder.length-1):Math.max(i-1,0);
  selMac=devRowOrder[i];
  renderDevices();
  const row=document.querySelector(`#dt tbody tr[data-mac="${CSS.escape(selMac)}"], #dcards .card[data-mac="${CSS.escape(selMac)}"]`);
  if(row) row.scrollIntoView({block:'nearest'});
});
document.addEventListener('keydown',e=>{
  if(e.key!=='ArrowRight'&&e.key!=='ArrowLeft')return;
  const t=e.target.tagName; if(t==='INPUT'||t==='TEXTAREA'||t==='SELECT')return;
  if(curView!=='devices'||radarMode!=='wifi'||!selMac)return;
  const rec=(lastWifi||[]).find(x=>x.mac===selMac);
  if(!rec||rec.kind!=='beacon'||!beaconClients(rec).length)return;
  e.preventDefault();
  const want=e.key==='ArrowRight';
  if(expandedTableAPs.has(selMac)===want)return;
  toggleApExpand(selMac);
});
let touch=null;
/**
 * Converts a Touch point's client coordinates to radar-canvas-local coordinates.
 * @param t Touch object.
 * @returns [x,y] canvas-local coordinates.
 */
function touchXY(t){const r=rc.getBoundingClientRect();return [t.clientX-r.left,t.clientY-r.top];}
rc.addEventListener('touchstart',e=>{
  if(e.touches.length===1){const[mx,my]=touchXY(e.touches[0]);
    const chit=clientHit(mx,my);
    if(chit){
      const off=clientOffsets[chit.mac]||{dx:0,dy:0};
      touch={mode:'clientdrag',mac:chit.mac,x0:mx,y0:my,baseDx:off.dx,baseDy:off.dy};
      hideTip(); e.preventDefault(); return;
    }
    touch={mode:'pan',x0:mx,y0:my,sx:mx,sy:my,moved:0};
    armLongPress(mx,my);
  }else if(e.touches.length>=2){
    cancelLongPress();
    const[ax,ay]=touchXY(e.touches[0]),[bx,by]=touchXY(e.touches[1]);
    touch={mode:'pinch',d0:Math.hypot(bx-ax,by-ay)||1}; hideTip();
  }
  e.preventDefault();
},{passive:false});
rc.addEventListener('touchmove',e=>{
  if(!touch)return;
  if(touch.mode==='clientdrag'&&e.touches.length===1){
    const[mx,my]=touchXY(e.touches[0]);
    clientOffsets[touch.mac]={dx:touch.baseDx+(mx-touch.x0),dy:touch.baseDy+(my-touch.y0)};
    drawRadar(lastDevs); e.preventDefault(); return;
  }
  if(touch.mode==='pan'&&e.touches.length===1){
    const[mx,my]=touchXY(e.touches[0]);
    touch.moved+=Math.abs(mx-touch.x0)+Math.abs(my-touch.y0);
    if(touch.moved>8){hideTip();cancelLongPress();}
    const[cx0,cy0]=viewCtr(lastW,lastH);
    view.cx=cx0-(mx-touch.x0)/view.s; view.cy=cy0-(my-touch.y0)/view.s;
    touch.x0=mx; touch.y0=my; drawRadar(lastDevs);
  }else if(touch.mode==='pinch'&&e.touches.length>=2){
    const[ax,ay]=touchXY(e.touches[0]),[bx,by]=touchXY(e.touches[1]);
    const d=Math.hypot(bx-ax,by-ay)||1, mx=(ax+bx)/2, my=(ay+by)/2;
    zoomAtScreen(mx,my,d/touch.d0); touch.d0=d;
  }
  e.preventDefault();
},{passive:false});
rc.addEventListener('touchend',e=>{
  if(touch&&touch.mode==='clientdrag'){touch=null; drawRadar(lastDevs); e.preventDefault(); return;}
  cancelLongPress();
  if(touch&&touch.mode==='pan'&&touch.moved<8){
    let dhit=null,dbest=1e9;
    deauthPlots.forEach(p=>{const dd=Math.hypot(p.x-touch.sx,p.y-touch.sy);
      if(dd<=p.dr+10&&dd<dbest){dbest=dd;dhit=p;}});
    if(dhit){ hideNodeMenu(); pinDeauthTip(dhit); }
    else{
      let hit=null,best=1e9;
      plots.forEach(p=>{const dd=Math.hypot(p.x-touch.sx,p.y-touch.sy);
        if(dd<=p.dr+10&&dd<best){best=dd;hit=p;}});
      if(hit&&hit.d.kind==='beacon'&&beaconClients(hit.d).length) showNodeMenu(hit);
      else{ hideNodeMenu(); hit?pinTip(hit):hideTip(); }
    }
  }
  if(e.touches.length===0){touch=null;}
  else{const[mx,my]=touchXY(e.touches[0]);
    touch={mode:'pan',x0:mx,y0:my,sx:mx,sy:my,moved:99};}
  e.preventDefault();
},{passive:false});
let liveOn=true;
/**
 * Toggles live polling on/off, reflects the state on #liveBtn, and immediately calls tick() when
 * turning live mode back on.
 */
function toggleLive(){liveOn=!liveOn;
  const b=document.getElementById('liveBtn');
  b.classList.toggle('on',liveOn); b.classList.toggle('off',!liveOn);
  if(liveOn)tick();}
let radarMode='wifi';
let capturing=false;
/**
 * Shows the WiFi capture caret and all `.wifi-only` elements, then syncs scout-only UI visibility and
 * the devices table header for the current mode.
 */
function syncModeUI(){
  const wcar=document.getElementById('wifiCaret'); if(wcar)wcar.style.display='';
  document.querySelectorAll('.wifi-only').forEach(e=>e.style.display='');
  syncScoutOnlyUI();
  setDevHeader();
}
/**
 * Shows or hides all `.scout-only` elements based on whether a scout is linked, and switches away
 * from the Scout/Frames view back to the map view if the scout link drops.
 */
function syncScoutOnlyUI(){
  const on=(typeof scoutLinked!=='undefined')&&scoutLinked;
  document.querySelectorAll('.scout-only').forEach(e=>e.style.display=on?'':'none');
  if(!on&&curView==='scout')setView('map');
  const fsr=document.getElementById('fcSecsRow'); if(fsr)fsr.style.display='none';
  document.querySelectorAll('.framesSecsRow').forEach(e=>e.style.display='none');
  const fmd=document.getElementById('framesModeDetail');
  if(fmd){ fmd.disabled=true;
    fmd.title='Detailed mode ran on this board\'s own radio and is no longer offered -- Frame dump is scout-only now.'; }
}


let modeChosen=false;
/** Pauses live polling (if on) and re-shows the splash mode-select gate (#splashGate). */
function reopenSplash(){
  if(liveOn)toggleLive();
  const g=document.getElementById('splashGate'); if(g)g.classList.remove('hide');
}
/**
 * Handles the splash screen's mode choice: hides the splash gate; for 'offline' mode, auto-loads the
 * sole SD session when exactly one exists or otherwise opens the data-settings tab to pick one; for
 * 'wifi' mode, opens the WiFi load-or-new gate when SD session files or a scan snapshot exist and
 * returns without starting a session; otherwise starts a fresh live session.
 * @param m Chosen mode ('offline', 'wifi', or any other value for a fresh live session).
 */
async function splashPick(m){
  modeChosen=true;
  const g=document.getElementById('splashGate'); if(g)g.classList.add('hide');
  if(typeof syncSentinelOnlyUI==='function')syncSentinelOnlyUI();
  if(LITE_MODE)liteRefresh();else tick();
  let sessions=null;
  try{sessions=await(await fetch('/api/session/list')).json();}catch(e){}
  const gpsFiles=(sessions&&sessions.gpsfiles)||[];
  const hasGps=!!(sessions&&(sessions.gpssession>0||gpsFiles.length));
  const hasExtra=!!(sessions&&sessions.sd&&((sessions.files&&sessions.files.length)||sessions.scansnap>0||hasGps));
  if(m==='offline'){
    if(liveOn)toggleLive();
    if(sessions&&sessions.sd&&sessions.files&&sessions.files.length===1&&!sessions.scansnap&&!hasGps){
      await loadSession(sessions.files[0].name);
      return;
    }
    if(hasExtra){openWifiLoadGate(sessions.files||[],sessions.scansnap||0,gpsFiles);return;}
    openSetModal(); setSettingsTab('data');
    return;
  }

  if(m==='wifi'&&hasExtra){
    openWifiLoadGate(sessions.files||[],sessions.scansnap||0,gpsFiles);
    return;
  }

  await startNewSession();
}
/**
 * Attempts to restore the last cached session snapshot from localStorage (`lastSnap`) on page load:
 * hides the splash gate, applies the snapshot, and shows a reconnecting status message.
 * @returns True if a cached snapshot was found and applied, false otherwise.
 */
function tryResumeFromCache(){
  let snap=null;
  try{const raw=localStorage.getItem('lastSnap'); if(raw)snap=JSON.parse(raw);}catch(e){}
  if(!snap||!snap.wifi) return false;
  modeChosen=true;
  const g=document.getElementById('splashGate'); if(g)g.classList.add('hide');
  if(typeof syncSentinelOnlyUI==='function')syncSentinelOnlyUI();
  if(LITE_MODE)liteRefresh();else tick();
  applyImport(snap);
  const st=document.getElementById('ioStatus'); if(st)st.textContent='Restored last session -- reconnecting…';
  return true;
}
queueMicrotask(tryResumeFromCache);

/** Option HTML for each resume-gate source, keyed by source ('session' | 'gps'). */
let wlgOptions={session:'',gps:''};
/** Source the resume gate's list currently shows: 'session' | 'gps'. */
let wlgSource='session';
/**
 * Switches the resume gate to one source: fills the list and highlights its tab.
 * @param src 'session' or 'gps'.
 */
function wlgShow(src){
  wlgSource=src;
  const sel=document.getElementById('wifiLoadSel'); if(sel)sel.innerHTML=wlgOptions[src];
  document.querySelectorAll('#wlgTabs button').forEach(b=>b.classList.toggle('on',b.dataset.src===src));
}
/**
 * Shows the resume gate (#wifiLoadGate) with two sources as tabs: Session (SD session files and
 * the on-device WiFi Scan snapshot) and GPS (GPS session logs). A tab appears only when its
 * source has entries; the tab row is hidden when only one source exists.
 * @param files SD session file descriptors ({name,size}).
 * @param scansnap Byte size of an available Cardputer scan snapshot, or falsy if none.
 * @param gpsFiles SD GPS session logs ({name,size}), newest-first.
 */
function openWifiLoadGate(files,scansnap,gpsFiles){
  let sess=files.map(f=>`<option value="${esc(f.name)}">${esc(sessionLabel(f.name))} (${fmtBytes(f.size)})</option>`);
  if(scansnap>0)sess.unshift(`<option value="__scan__">WiFi Scan (on-device) &mdash; ${fmtBytes(scansnap)}</option>`);
  wlgOptions.session=sess.join('');
  wlgOptions.gps=gpsFiles.map(f=>`<option value="${esc(f.name)}">${esc(f.name)} (${fmtBytes(f.size)})</option>`).join('');
  const tabs=[];
  if(sess.length)tabs.push(['session','Session']);
  if(gpsFiles.length)tabs.push(['gps','GPS']);
  const tabEl=document.getElementById('wlgTabs');
  if(tabEl){
    tabEl.innerHTML=tabs.map(([k,l])=>`<button data-src="${k}" onclick="wlgShow('${k}')">${l}</button>`).join('');
    tabEl.style.display=tabs.length>1?'':'none';
  }
  wlgShow(tabs.length?tabs[0][0]:'session');
  const g=document.getElementById('wifiLoadGate'); if(g)g.classList.add('show');
}
/**
 * Handles the resume gate's choice: hides the gate, then loads the selected item from the active
 * source (GPS log, WiFi Scan snapshot, or SD session file), or starts a fresh session.
 * @param load Whether to load the selected item (true) or start a new session (false).
 */
async function wifiLoadPick(load){
  const g=document.getElementById('wifiLoadGate'); if(g)g.classList.remove('show');
  if(load){
    const sel=document.getElementById('wifiLoadSel');
    const v=sel&&sel.value;
    if(!v)return;
    if(wlgSource==='gps'){await loadGpsSessionLog(v);return;}
    if(v==='__scan__'){await loadSdWifiCapture();return;}
    await loadSession(v);
    return;
  }
  await startNewSession();
}
let capMask=0, scoutMask=0;
const WIFI_5G_CH=[36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140,144,149,153,157,161,165];
let scoutMask5=0, scoutDualBand=false, capMask5=0, capDualBand=false;
/**
 * Counts the number of 5GHz channels set in a channel bitmask.
 * @param m Bitmask indexed by position in WIFI_5G_CH.
 * @returns Number of set bits.
 */
function bitsSet5(m){let n=0;for(let i=0;i<WIFI_5G_CH.length;i++)if(m&(1<<i))n++;return n;}
/**
 * Finds the index of the first set bit in a 5GHz channel bitmask.
 * @param m Bitmask indexed by position in WIFI_5G_CH.
 * @returns The first set bit's index, or 0 if none are set.
 */
function firstBit5Idx(m){for(let i=0;i<WIFI_5G_CH.length;i++)if(m&(1<<i))return i;return 0;}
let capActive=0;
/**
 * Counts the number of 2.4GHz channels (1-13) set in a channel bitmask.
 * @param m Channel bitmask.
 * @returns Number of set bits.
 */
function bitsSet(m){let n=0;for(let c=1;c<=13;c++)if(m&(1<<c))n++;return n;}
/**
 * Finds the first set 2.4GHz channel (1-13) in a channel bitmask.
 * @param m Channel bitmask.
 * @returns The first set channel number, or 0 if none are set.
 */
function firstBit(m){for(let c=1;c<=13;c++)if(m&(1<<c))return c;return 0;}
/**
 * Reads the current channel bitmask for a capture target.
 * @param t Target key ('cap' for local capture, else scout).
 * @returns The target's current channel bitmask.
 */
function tgtMask(t){return t==='cap'?capMask:scoutMask;}
/**
 * Sets the channel bitmask for a capture target.
 * @param t Target key ('cap' for local capture, else scout).
 * @param m Channel bitmask to store.
 */
function setTgtMask(t,m){if(t==='cap')capMask=m;else scoutMask=m;}
/**
 * Resolves the DOM element id of a target's channel-chip container.
 * @param t Target key ('cap' for local capture, else scout).
 * @returns 'capChips' or 'scoutChips'.
 */
function chipBox(t){return t==='cap'?'capChips':'scoutChips';}
/** Clears the single-channel table/radar filter (wifiChanLock). */
function applyChanFilter(){ wifiChanLock=0; }
/**
 * (Re)builds the Auto + channel 1-13 chip buttons inside a target's chip container and paints their
 * on/off state.
 * @param t Target key ('cap' for local capture, else scout).
 */
function renderChips(t){
  const box=document.getElementById(chipBox(t)); if(!box)return;
  if(t==='cap'){
    const cx=110,cy=110,ro=78,rc=19,ra=30,step=360/13;
    let svg=`<svg class="radial-chan" viewBox="0 0 220 220" width="220" height="220">
<defs>
  <radialGradient id="rcAmbient" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.10"/>
    <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
  </radialGradient>
  <filter id="rcGlow" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur"/>
    <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="rcGlowSm" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur"/>
    <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<circle cx="${cx}" cy="${cy}" r="92" fill="url(#rcAmbient)" pointer-events="none"/>
<circle cx="${cx}" cy="${cy}" r="${ro}" fill="none" stroke="var(--accent)" stroke-width="0.8" stroke-dasharray="2.5 5" opacity="0.25" pointer-events="none" class="rcring"/>`;
    for(let c=1;c<=13;c++){
      const ar=((c-1)*step-90)*Math.PI/180;
      const x1=(cx+(ra+4)*Math.cos(ar)).toFixed(1),y1=(cy+(ra+4)*Math.sin(ar)).toFixed(1);
      const x2=(cx+(ro-rc-3)*Math.cos(ar)).toFixed(1),y2=(cy+(ro-rc-3)*Math.sin(ar)).toFixed(1);
      svg+=`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="rcspoke"/>`;
    }
    svg+=`<g data-ch="0" onclick="chanAuto('cap')" class="rcbtn rccenter"><circle cx="${cx}" cy="${cy}" r="${ra}"/><text x="${cx}" y="${cy}">AUTO</text></g>`;
    for(let c=1;c<=13;c++){
      const ar=((c-1)*step-90)*Math.PI/180;
      const x=(cx+ro*Math.cos(ar)).toFixed(1),y=(cy+ro*Math.sin(ar)).toFixed(1);
      svg+=`<g data-ch="${c}" onclick="chanTap('cap',${c})" class="rcbtn"><circle cx="${x}" cy="${y}" r="${rc}"/><text x="${x}" y="${y}">${c}</text></g>`;
    }
    svg+='</svg>';
    box.innerHTML=svg; paintChips(t); return;
  }
  let h='<button class="auto" data-ch="0" onclick="chanAuto(\''+t+'\')">Auto</button>';
  for(let c=1;c<=13;c++)
    h+='<button data-ch="'+c+'" onclick="chanTap(\''+t+'\','+c+')">'+c+'</button>';
  box.innerHTML=h; paintChips(t);
}
/**
 * Updates a target's channel chip buttons' 'on' state to reflect its current channel bitmask (or the
 * Auto chip when the mask is 0).
 * @param t Target key ('cap' for local capture, else scout).
 */
function paintChips(t){
  const box=document.getElementById(chipBox(t)); if(!box)return;
  const mask=tgtMask(t), auto=!mask;
  box.querySelectorAll('[data-ch]').forEach(b=>{
    const c=+b.dataset.ch;
    b.classList.toggle('on', c===0 ? auto : (!auto&&!!(mask&(1<<c))));
  });
}
/**
 * Sets a target's channel selection to Auto (hop all channels) and runs the post-change UI/dirty-flag
 * updates.
 * @param t Target key ('cap' for local capture, else scout).
 */
function chanAuto(t){ setTgtMask(t,0); afterChan(t); }
/**
 * Toggles a single channel bit in the given target's channel mask and re-syncs chip UI.
 * @param t Target key ('cap' or 'scout').
 * @param c Channel number whose bit is flipped.
 */
function chanTap(t,c){ setTgtMask(t, tgtMask(t)^(1<<c)); afterChan(t); }
/**
 * Repaints a target's channel chips after a mask change and flags the scout config as dirty
 * (marking it needing a Send to Scout) when the target isn't the local capture.
 * @param t Target key ('cap' or 'scout').
 */
function afterChan(t){
  paintChips(t);
  if(t==='cap') updateChanAccordPill();
  else { scoutDirty=true; paintScoutSend(); }
}
/**
 * Returns the current 5GHz channel mask for the given target.
 * @param t Target key ('cap' or 'scout').
 * @returns capMask5 for 'cap', scoutMask5 otherwise.
 */
function tgtMask5(t){return t==='cap'?capMask5:scoutMask5;}
/**
 * Sets the 5GHz channel mask for the given target.
 * @param t Target key ('cap' or 'scout').
 * @param m New mask value.
 */
function setTgtMask5(t,m){if(t==='cap')capMask5=m;else scoutMask5=m;}
/**
 * Returns the DOM element id of the 5GHz channel chip container for the given target.
 * @param t Target key ('cap' or 'scout').
 * @returns Element id string.
 */
function chipBox5(t){return t==='cap'?'cap5Chips':'scout5Chips';}
/**
 * Builds and inserts the 5GHz channel chip buttons (Auto + one per WIFI_5G_CH entry)
 * into the target's chip container, then paints their active state.
 * @param t Target key ('cap' or 'scout').
 */
function renderChips5(t){
  const box=document.getElementById(chipBox5(t)); if(!box)return;
  let h='<button class="auto" data-ci="0" onclick="chan5Auto(\''+t+'\')">Auto</button>';
  WIFI_5G_CH.forEach((ch,i)=>{ h+='<button data-ci="'+i+'" onclick="chan5Tap(\''+t+'\','+i+')">'+ch+'</button>'; });
  box.innerHTML=h; paintChips5(t);
}
/**
 * Updates the 'on' class of every 5GHz channel chip button to reflect the target's current mask.
 * @param t Target key ('cap' or 'scout').
 */
function paintChips5(t){
  const box=document.getElementById(chipBox5(t)); if(!box)return;
  const mask=tgtMask5(t), auto=!mask;
  box.querySelectorAll('button').forEach(b=>{
    const i=+b.dataset.ci;
    const isAuto=b.classList.contains('auto');
    b.classList.toggle('on', isAuto ? auto : (!auto&&!!(mask&(1<<i))));
  });
}
/**
 * Clears the 5GHz channel mask for the target (Auto/hop-all) and re-syncs UI.
 * @param t Target key ('cap' or 'scout').
 */
function chan5Auto(t){ setTgtMask5(t,0); afterChan5(t); }
/**
 * Toggles a single 5GHz channel index bit in the target's mask and re-syncs UI.
 * @param t Target key ('cap' or 'scout').
 * @param i Index into WIFI_5G_CH whose bit is flipped.
 */
function chan5Tap(t,i){ setTgtMask5(t, tgtMask5(t)^(1<<i)); afterChan5(t); }
/**
 * Repaints a target's 5GHz channel chips after a mask change and flags the scout config
 * as dirty when the target isn't the local capture.
 * @param t Target key ('cap' or 'scout').
 */
function afterChan5(t){
  paintChips5(t);
  if(t==='cap') updateChanAccordPill();
  else { scoutDirty=true; paintScoutSend(); }
}
function updateChanAccordPill(){
  const pill=document.getElementById('chanAccordPill'); if(!pill)return;
  const pc=m=>{let n=0,x=m>>>0;while(x){n+=x&1;x>>>=1;}return n;};
  const n24=pc(capMask), n5=pc(capMask5);
  if(!capMask&&!capMask5){ pill.textContent='Auto'; pill.className='chanaccord-pill'; return; }
  const parts=[];
  if(capMask){ parts.push(n24===1?'Ch '+firstBit(capMask):n24+' ch'); }
  if(capMask5){ parts.push(n5===1?'5G '+WIFI_5G_CH[firstBit5Idx(capMask5)]:n5+' 5G ch'); }
  pill.textContent=parts.join(' · ');
  pill.className='chanaccord-pill chanaccord-pill--active';
}
function toggleChanCollapse(){
  const body=document.getElementById('chanCollapseBody');
  const btn=document.getElementById('chanCollapseBtn'); if(!body||!btn)return;
  const open=!body.hidden; body.hidden=open;
  btn.setAttribute('aria-expanded',String(!open));
  btn.classList.toggle('chanaccord-hd--open',!open);
}
function openChanCollapse(){
  const body=document.getElementById('chanCollapseBody');
  const btn=document.getElementById('chanCollapseBtn'); if(!body||!btn)return;
  body.hidden=false; btn.setAttribute('aria-expanded','true');
  btn.classList.add('chanaccord-hd--open');
}
let capChipBand='24';
/**
 * Switches the visible capture channel-chip band (2.4GHz vs 5GHz) and updates the tab buttons.
 * No-op if already on the requested band.
 * @param b Band to show ('24' or '5').
 */
function setCapChipBand(b){
  if(b===capChipBand)return;
  capChipBand=b;
  document.getElementById('cbtab24').classList.toggle('on',b==='24');
  document.getElementById('cbtab5').classList.toggle('on',b==='5');
  document.getElementById('capChips').style.display=b==='24'?'':'none';
  document.getElementById('cap5Chips').style.display=b==='5'?'':'none';
}
/**
 * Enables or disables dual-band capture UI (5GHz band tabs/pause control) and falls back
 * to the 2.4GHz chip view if 5GHz support is turned off while it's active. Updates the
 * global capDualBand flag.
 * @param capdual Truthy to enable dual-band capture UI.
 */
function syncCapBand(capdual){
  capdual=!!capdual;
  if(capdual===capDualBand)return;
  capDualBand=capdual;
  const tabs=document.getElementById('capBandTabs'); if(tabs)tabs.style.display=capdual?'':'none';
  const pause=document.getElementById('capBandPause'); if(pause)pause.style.display=capdual?'':'none';
  if(!capdual&&capChipBand==='5')setCapChipBand('24');
}
let scoutChipBand='24';
/**
 * Switches the visible scout channel-chip band (2.4GHz vs 5GHz) and updates the tab buttons.
 * No-op if already on the requested band.
 * @param b Band to show ('24' or '5').
 */
function setScoutChipBand(b){
  if(b===scoutChipBand)return;
  scoutChipBand=b;
  document.getElementById('sbtab24').classList.toggle('on',b==='24');
  document.getElementById('sbtab5').classList.toggle('on',b==='5');
  document.getElementById('scoutChips').style.display=b==='24'?'':'none';
  document.getElementById('scout5Chips').style.display=b==='5'?'':'none';
}
/**
 * Enables or disables dual-band scout UI (5GHz band tabs/pause control, and the shared
 * channel-band-mode tabs), falling back to 2.4GHz views where needed. Also clamps the
 * channel-mode slider's max when in channel mode. Updates the global scoutDualBand flag.
 * @param dband Truthy to enable dual-band scout UI.
 */
function syncScoutBand(dband){
  dband=!!dband;
  if(dband===scoutDualBand)return;
  scoutDualBand=dband;
  const sbt=document.getElementById('scoutBandTabs'); if(sbt)sbt.style.display=dband?'':'none';
  const p5=document.getElementById('scoutPause5Btn'); if(p5)p5.style.display=dband?'':'none';
  if(!dband&&scoutChipBand==='5')setScoutChipBand('24');
  const tabs=document.getElementById('chanBandTabs'); if(tabs)tabs.style.display=dband?'':'none';
  if(!dband&&chanBand==='5')setChanBand('24');
  if(bandMode==='ch'){
    const s=document.getElementById('band'), mx=chSliderMax();
    if(mx>=+s.value) s.max=mx;
    else { s.max=mx; s.value=0; onBandInput(); }
  }
}
let scoutDirty=false, scoutFlash=null;
/**
 * Renders the Send-to-Scout button's label/state from the current scoutDirty/scoutFlash flags.
 * Shows a transient busy/ok/err state when scoutFlash is set, else the dirty "Send to Scout" prompt.
 */
function paintScoutSend(){
  const b=document.getElementById('scoutSend'); if(!b)return;
  b.classList.remove('dirty','busy','ok','err');
  if(scoutFlash){ b.classList.add(scoutFlash);
    b.innerHTML=scoutFlash==='busy'?'Sending&hellip;':scoutFlash==='ok'?'Sent ✓':'Send failed'; return; }
  b.classList.add('dirty');
  b.innerHTML='Send to Scout';
}
let scoutFlashT=null;
/**
 * Drives the Send-to-Scout button's busy/ok/err flash animation around a pending promise,
 * resetting scoutFlash back to idle after a delay.
 * @param p Promise (or promise-like value) representing the in-flight scout config request.
 */
function flashScout(p){
  scoutFlash='busy'; paintScoutSend();
  Promise.resolve(p)
    .then(ok=>{ scoutFlash=ok?'ok':'err'; scoutDirty=(scoutFlash==='err'); })
    .catch(()=>{ scoutFlash='err'; scoutDirty=true; })
    .finally(()=>{
      paintScoutSend();
      clearTimeout(scoutFlashT);
      scoutFlashT=setTimeout(()=>{ scoutFlash=null; paintScoutSend(); },1400);
    });
}
/**
 * Pushes the pending scout channel mask, DATA-frame toggle, and type mask to the device
 * via /api/wifi/chan and /api/wifi/opts, clearing the busy markers on the relevant buttons
 * once both requests confirm the requested values landed. Drives the flashScout animation.
 */
function sendScout(){
  const want=scoutMask, want5=scoutMask5;
  const dataBtn=document.getElementById('scoutDataBtn');
  const dataWant=dataBtn?dataBtn.classList.contains('on'):false;
  const typesWant=scoutTypeMask();
  const p=Promise.all([
    fetch('/api/wifi/chan',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:'scout='+want+(scoutDualBand?'&scout5='+want5:'')})
      .then(r=>r.ok?r.json():Promise.reject())
      .then(j=>j&&j.scout===want&&(!scoutDualBand||j.scout5===want5)),
    fetch('/api/wifi/opts',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:'scoutdata='+(dataWant?1:0)+'&scouttypes='+typesWant})
      .then(r=>r.ok?r.json():Promise.reject())
      .then(j=>j&&j.scoutdata===(dataWant?1:0)&&j.scouttypes===typesWant)
  ]).then(rs=>rs.every(Boolean));
  p.then(ok=>{
    if(!ok)return;
    if(dataBtn)delete dataBtn.dataset.busy;
    for(const id in SCOUT_TYPE_BITS){ const b=document.getElementById(id); if(b)delete b.dataset.busy; }
  });
  flashScout(p);
}
/**
 * Switches the capture popover between the Capture and Scout tabs/panes.
 * @param t Tab key ('cap' selects the Capture pane, anything else selects Scout).
 */
function capTab(t){
  const cap=t==='cap';
  document.getElementById('ctabCap').classList.toggle('on',cap);
  document.getElementById('ctabScout').classList.toggle('on',!cap);
  document.getElementById('capPane').style.display=cap?'':'none';
  document.getElementById('scoutPane').style.display=cap?'none':'';
}
/**
 * Switches the Capture pane between its Scan and Intelli-scan sub-tabs, refreshing the
 * Intelli-scan info panel when it becomes visible.
 * @param t Sub-tab key ('scan' selects the Scan pane, anything else selects Intelli).
 */
function capSubTab(t){
  const scan=t==='scan';
  document.getElementById('csubScan').classList.toggle('on',scan);
  document.getElementById('csubIntelli').classList.toggle('on',!scan);
  document.getElementById('capSubScanPane').style.display=scan?'':'none';
  document.getElementById('capSubIntelliPane').style.display=scan?'none':'';
  if(!scan)refreshIntelliInfo();
}
/**
 * Switches the Scout view between its Feed and Management sub-tabs.
 * @param t Sub-tab key ('feed' selects the live UART feed, anything else selects Management).
 */
function scoutSubTab(t){
  const feed=t==='feed';
  document.getElementById('scoutSubFeed').classList.toggle('on',feed);
  document.getElementById('scoutSubMgmt').classList.toggle('on',!feed);
  document.getElementById('scoutSubFeedPane').style.display=feed?'':'none';
  document.getElementById('scoutSubMgmtPane').style.display=feed?'none':'';
}
const CR_CIRC=326.7;
/**
 * Updates the capture-countdown ring UI: shows/hides it based on capturing/capFinishing
 * state, and sets the remaining-seconds text and arc stroke offset proportionally to
 * time left.
 * @param left Seconds remaining in the capture window.
 * @param total Total seconds the window was armed for.
 */
function updateCapUI(left,total){
  const el=document.getElementById('capruns'),
        num=document.getElementById('crLeft'),
        arc=document.getElementById('crArc');
  if(capturing||capFinishing){
    el.classList.add('on');
    num.textContent=Math.max(0,left);
    const frac=total?Math.max(0,Math.min(1,left/total)):0;
    arc.style.strokeDashoffset=(CR_CIRC*(1-frac)).toFixed(1);
  }else{ el.classList.remove('on'); }
}
let capFinishing=false;
/**
 * Reports whether the capture popover is currently open.
 * @returns True if #capPop has the 'on' class.
 */
function capPopOn(){ return document.getElementById('capPop').classList.contains('on'); }
/**
 * Opens the WiFi capture popover: pulls a fresh /api/data first (Lite mode doesn't auto-poll, so
 * capDualBand/scoutDualBand could still be stale defaults from page load -- without this, a
 * WIFI_BAND_DUAL board's 5GHz tab stays hidden until the user happens to hit Refresh first),
 * resets it to the Scan sub-tab, (re)renders the channel chips for both capture and scout
 * (including 5GHz chips when dual-band is active), clears any pending scout-send state, and
 * clears busy markers on the scout data/type buttons. No-op outside WiFi radar mode or while a
 * capture is already running.
 */
async function openCapPop(){ if(radarMode!=='wifi'||capturing)return;
  try{ const r=await fetch('/api/data'); if(r.ok) processData(await r.json()); }catch(e){}
  capSubTab('scan');
  renderChips('cap'); renderChips('scout');
  if(capDualBand)renderChips5('cap'); if(scoutDualBand)renderChips5('scout');
  updateChanAccordPill();
  scoutDirty=false; scoutFlash=null; clearTimeout(scoutFlashT); paintScoutSend();
  const dataBtn=document.getElementById('scoutDataBtn'); if(dataBtn)delete dataBtn.dataset.busy;
  for(const id in SCOUT_TYPE_BITS){ const b=document.getElementById(id); if(b)delete b.dataset.busy; }
  document.getElementById('capPop').classList.add('on');
  document.getElementById('modeWifi').classList.add('popopen');
  fitPopInViewport('capPop', 'modeWifi'); }
/**
 * Keeps a header popover on-screen: anchors it under its trigger, then shifts it horizontally
 * if it would overflow the viewport (the header wraps on narrow phones, pushing the trigger
 * toward an edge while the popover is right-anchored to it).
 * @param popId Popover element id.
 * @param anchorId Trigger element id the popover hangs under.
 */
function fitPopInViewport(popId, anchorId){
  const pop=document.getElementById(popId), anchor=document.getElementById(anchorId); if(!pop||!anchor)return;
  pop.style.left=''; pop.style.right='0';
  const a=anchor.getBoundingClientRect(), w=pop.offsetWidth, margin=8;
  const want=a.right-w, max=window.innerWidth-w-margin;
  const left=Math.min(Math.max(want,margin),Math.max(max,margin));
  if(Math.abs(left-want)>0.5){ pop.style.right='auto'; pop.style.left=(left-a.left)+'px'; } }
/** Closes the WiFi capture popover and un-highlights the WiFi mode button. */
function closeCapPop(){ document.getElementById('capPop').classList.remove('on');
  document.getElementById('modeWifi').classList.remove('popopen'); }
/** Toggles the capture popover open/closed. */
function onWifiBtn(){ capPopOn()?closeCapPop():openCapPop(); }
/**
 * Sets the capture-duration slider/label to the given seconds value.
 * @param s Duration in seconds.
 */
function setCapDur(s){ const r=document.getElementById('capRange');
  r.value=s; document.getElementById('capLbl').textContent=fmtDur(s); }
/**
 * Reads the capture-duration slider, applies the current channel mask, closes the popover,
 * and starts either an indefinite standalone capture (if the indefinite checkbox is checked)
 * or a timed capture for the chosen duration.
 */
function startCaptureModal(){ const s=+document.getElementById('capRange').value||30;
  capActive=capMask; applyChanFilter();
  const indefChk=document.getElementById('capIndefChk');
  closeCapPop();
  if(indefChk&&indefChk.checked) startStandaloneCapture(); else startCapture(s); }
document.addEventListener('click',e=>{ if(!capPopOn())return;
  if(!e.target.closest('#capPop')&&!e.target.closest('#modeWifi')) closeCapPop(); });
document.addEventListener('click',e=>{
  const pop=document.getElementById('wifiFilterPop'); if(!pop||pop.style.display==='none')return;
  if(!e.target.closest('#wifiFilterPop')&&!e.target.closest('#wifiFilterBtn')) toggleWifiFilters(); });
document.addEventListener('click',e=>{
  const bm=document.getElementById('bandModes'); if(!bm||!bm.classList.contains('open'))return;
  if(!e.target.closest('#bandModes')&&!e.target.closest('#bandModeBtn')) bm.classList.remove('open'); });
document.addEventListener('dblclick',e=>{
  const t=e.target.closest('#dt tbody tr[data-mac], #dcards .card[data-mac]');
  if(t) showMacInfo(t.dataset.mac);
});
/**
 * Builds the HTML for the capture-countdown ring's parameter summary: frame-type tiles
 * (beacon/probe/assoc/deauth, highlighted when included), a DATA tile, and a channel-set
 * label describing the active capture channel mask(s).
 * @returns HTML string of summary tile spans.
 */
function capSummaryHtml(){
  const TYPES=[['BCN',0x06],['PRB',0x01],['ASC',0x08],['DEA',0x10]];
  let h='';
  const tm=capTypeMask();
  for(const t of TYPES) h+='<span class="cr-tile'+((tm&t[1])?' on':'')+'">'+t[0]+'</span>';
  const dataBtn=document.getElementById('capDataBtn');
  h+='<span class="cr-tile'+((dataBtn&&dataBtn.classList.contains('on'))?' on':'')+'">DAT</span>';
  const m=capActive, n=bitsSet(m), m5=capMask5, n5=bitsSet5(m5);
  const chLbl=(m===0&&m5===0)?'Auto 1–13':
    (m&&!m5)?(n===1?('Ch '+firstBit(m)+' locked'):(n+' channels')):
    (m5&&!m)?(n5===1?('Ch '+WIFI_5G_CH[firstBit5Idx(m5)]+' locked'):(n5+' 5GHz channels')):
    ((n+n5)+' channels');
  h+='<span class="cr-tile on">'+chLbl+'</span>';
  return h;
}
/**
 * Arms and drives a timed WiFi capture window: clamps the duration to 5-300s, resets
 * capture state and pre-capture MAC snapshots, updates the countdown-ring UI, POSTs
 * /api/wifi/capture with the channel/type/DATA options, and on success runs a 250ms
 * interval that updates the countdown until the window ends, at which point it flips
 * into the reconnect/QR-scan flow and calls pollReconnect(). Turns on live mode if it
 * was off. Reloads the page (or shows the auth overlay on a 401) if the arm request fails.
 * @param s Requested capture duration in seconds (clamped to 5-300).
 */
async function startCapture(s){
  if(radarMode!=='wifi'||capturing) return;
  if(!liveOn) toggleLive();
  s=Math.max(5,Math.min(300,s|0));
  const total=s+2;
  const dispTotal=s;
  capturing=true;
  capFinishing=false;
  preCaptureMacs=new Set(lastWifi.map(x=>x.mac));
  preCaptureStationMacs=new Set(Object.keys(wifiClientAp));
  hideApLost();
  const endAt=Date.now()+total*1000;
  const ct0=document.getElementById('crTitle'); if(ct0)ct0.textContent='WiFi capture in progress';
  const cp=document.getElementById('crParams'); if(cp)cp.innerHTML=capSummaryHtml();
  const cs=document.getElementById('crSub'); if(cs){cs.style.display='none';cs.innerHTML='';}
  const qw=document.getElementById('capQrWrap'); if(qw)qw.style.display='none';
  const cf0=document.getElementById('capQrFrame'); if(cf0){cf0.classList.remove('revealed');clearTimeout(qrRevealTimers.capQrFrame);}
  updateCapUI(dispTotal,dispTotal);
  armCapQr();
  prefetchApCreds();
  const dataBtn=document.getElementById('capDataBtn'), dataOn=dataBtn&&dataBtn.classList.contains('on');
  const p24=document.getElementById('capPause24Btn'), p5=document.getElementById('capPause5Btn');
  const q='secs='+s+'&cap='+capMask+'&cap5='+capMask5+
    '&cappause24='+((p24&&!p24.classList.contains('on'))?1:0)+
    '&cappause5='+((p5&&!p5.classList.contains('on'))?1:0)+
    '&captypes='+capTypeMask()+'&data='+(dataOn?1:0)+'&frames=0';
  let capRes=null;
  try{capRes=await fetch('/api/wifi/capture',{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},body:q});}catch(e){}
  if(capRes&&!capRes.ok){
    capturing=false; capFinishing=false; updateCapUI(0,0);
    if(capRes.status===401) showAuth(); else location.reload();
    return;
  }
  const iv=setInterval(()=>{
    const left=Math.min(dispTotal,Math.ceil((endAt-Date.now())/1000));
    if(left>0){updateCapUI(left,dispTotal);}
    else{
      clearInterval(iv);
      capturing=false;
      capFinishing=true;
      const ct=document.getElementById('crTitle'); if(ct)ct.textContent='Reconnecting…';
      const cs2=document.getElementById('crSub'); if(cs2){cs2.style.display='';cs2.innerHTML=
        'Window ended -- waiting for this device to rejoin 802Eleven.<br>Scan the code below if it doesn’t reconnect on its own.';}
      const qw2=document.getElementById('capQrWrap'); if(qw2)qw2.style.display='';
      const cq0=document.getElementById('capQrImg');
      if(!(cq0&&cq0.complete&&cq0.naturalWidth>0)) armCapQr(true);
      updateCapUI(0,dispTotal);
      pollReconnect();
    }
  },250);
}

/**
 * Points the AP-join QR image at the server's QR endpoint, retrying with a cache-busting
 * query param on load error while a capture is still in progress or finishing.
 * @param bust Truthy to force a cache-busting reload (appends a timestamp query param).
 */
function armCapQr(bust){
  const cq=document.getElementById('capQrImg'); if(!cq) return;
  cq.onerror=()=>{ if(capturing||capFinishing) setTimeout(()=>armCapQr(true),800); };
  cq.onload=()=>{ cq.onerror=null; };
  cq.src='/api/network/apqr'+(bust?('?_='+Date.now()):'');
}
const QR_REVEAL_MS=8000;
const qrRevealTimers={};
/**
 * Toggles a QR frame's blurred/revealed state, auto-reblurring it after QR_REVEAL_MS.
 * @param frameId Element id of the QR frame to toggle.
 */
function toggleQrBlur(frameId){
  const f=document.getElementById(frameId); if(!f) return;
  clearTimeout(qrRevealTimers[frameId]);
  const revealed=f.classList.toggle('revealed');
  if(revealed) qrRevealTimers[frameId]=setTimeout(()=>f.classList.remove('revealed'),QR_REVEAL_MS);
}
let apCredsCache=null;
/** Fetches and caches the AP SSID/password from /api/network/appass into apCredsCache. */
async function prefetchApCreds(){
  try{ apCredsCache=await (await fetch('/api/network/appass')).json(); }catch(e){}
}
/**
 * Copies the AP's join credential (SSID if the AP is open, else the password) to the
 * clipboard, fetching apCredsCache first if not already cached, and briefly updates the
 * given button's label to reflect success/failure. Falls back to a hidden-textarea
 * execCommand('copy') when the async Clipboard API is unavailable.
 * @param btnId Element id of the button whose label is updated with the copy result.
 */
async function copyApPass(btnId){
  const btn=document.getElementById(btnId);
  if(!apCredsCache) await prefetchApCreds();
  if(!apCredsCache){ if(btn){btn.textContent='Unavailable';setTimeout(()=>btn.textContent='Copy password',1500);} return; }
  const text=apCredsCache.open?apCredsCache.ssid:apCredsCache.pass;
  const label=apCredsCache.open?'Copied SSID (open net)':'Copied';
  try{
    if(navigator.clipboard&&navigator.clipboard.writeText){
      await navigator.clipboard.writeText(text);
    }else{
      const ta=document.createElement('textarea');
      ta.value=text; ta.style.position='fixed'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok=document.execCommand('copy');
      document.body.removeChild(ta);
      if(!ok) throw 0;
    }
    if(btn){btn.textContent=label;setTimeout(()=>btn.textContent='Copy password',1500);}
  }catch(e){ if(btn){btn.textContent='Copy failed';setTimeout(()=>btn.textContent='Copy password',1500);} }
}
const FETCH_TIMEOUT_MS=4000;
/**
 * Fetches a URL with an abort-based timeout.
 * @param url URL to fetch.
 * @param ms Timeout in milliseconds (defaults to FETCH_TIMEOUT_MS).
 * @returns The fetch() promise, aborted if it doesn't settle within the timeout.
 */
function fetchTimeout(url,ms){
  const ac=new AbortController();
  const t=setTimeout(()=>ac.abort(),ms||FETCH_TIMEOUT_MS);
  return fetch(url,{signal:ac.signal}).finally(()=>clearTimeout(t));
}
/**
 * Polls /api/data until this device rejoins the AP after a capture window ends, then
 * clears capFinishing, hides the auth overlay, and processes the fetched data. Shows the
 * auth overlay on a 401 instead of retrying. Re-schedules itself every 800ms while still
 * finishing and unable to reach the server. No-op once capFinishing is false.
 */
function pollReconnect(){
  if(!capFinishing) return;
  fetchTimeout('/api/data').then(r=>{
    if(r.status===401){ capFinishing=false; updateCapUI(0,0); showAuth(); return; }
    if(!r.ok) throw 0;
    return r.json().then(d=>{ capFinishing=false; updateCapUI(0,0); hideAuth(); processData(d); });
  }).catch(()=>{ if(capFinishing) setTimeout(pollReconnect,800); });
}
/**
 * Locks the capture channel mask to a single channel (2.4 or 5GHz, chosen by the channel
 * number), sets a fixed frame-type mask and DATA capture on, and immediately starts a
 * capture on the current duration slider value. No-op outside WiFi radar mode, while
 * already capturing, or for a 5GHz channel when dual-band capture is off. Closes the MAC
 * info modal if open.
 * @param ch Channel number to lock onto (2.4GHz channel number or a 5GHz channel value).
 */
function captureChannel(ch){
  if(radarMode!=='wifi'||capturing) return;
  const is5=is5gChan(ch);
  if(is5&&!capDualBand) return;
  const typesWant=0x1D;
  if(is5){
    const idx=chan5IndexOf(ch);
    if(idx<0) return;
    capMask5=1<<idx; setTgtMask5('cap',capMask5); setCapChipBand('5'); paintChips5('cap');
    capMask=0; setTgtMask('cap',0); paintChips('cap');
    capActive=0;
    syncCapBandPause24(true); syncCapBandPause5(false);
  }else{
    capMask=1<<ch; setTgtMask('cap',capMask); setCapChipBand('24'); paintChips('cap');
    capMask5=0; setTgtMask5('cap',0); paintChips5('cap');
    capActive=capMask;
    syncCapBandPause24(false); syncCapBandPause5(true);
  }
  applyChanFilter();
  syncCapTypes(typesWant); syncCapData(1);
  const r=document.getElementById('capRange');
  startCapture(r?+r.value||30:30);
  updateChanAccordPill(); openChanCollapse();
  if(macModalOpen)closeMacInfo();
}
/**
 * Reports whether the given channel is the currently locked single capture channel
 * (checked against the 5GHz or 2.4GHz active mask depending on the channel's band).
 * @param ch Channel number to check.
 * @returns True if that single channel is the active capture lock.
 */
function capChanActive(ch){
  if(is5gChan(ch)){ const i=chan5IndexOf(ch); return i>=0 && capMask5===(1<<i); }
  return capActive===(1<<ch);
}
/**
 * Builds a 2.4GHz channel bitmask (bits 1-13) of every channel a known beacon has been
 * seen on, from the current lastWifi records.
 * @returns Bitmask of channels 1-13 with at least one beacon.
 */
function knownBeaconMask24(){
  let mask=0;
  (lastWifi||[]).forEach(x=>{ if(x.kind==='beacon'){ const c=+x.ch; if(c>=1&&c<=13)mask|=(1<<c); } });
  return mask;
}
/**
 * Updates the Intelli-scan info panel with the number of known beacon channels and the
 * estimated total capture duration (per-channel seconds times channel count, capped at
 * 300s), and enables/disables the Intelli-scan start button accordingly. Shows a
 * "run a Scan first" message when no beacon channels are known yet.
 */
function refreshIntelliInfo(){
  const info=document.getElementById('intelliInfo'), btn=document.getElementById('intelliStartBtn');
  if(!info)return;
  const mask=knownBeaconMask24(), n=bitsSet(mask);
  if(!n){
    info.innerHTML='No known beacon channels yet — run a Scan first, then come back here.';
    if(btn)btn.disabled=true;
    return;
  }
  if(btn)btn.disabled=false;
  const per=+((document.getElementById('intelliSecsInput')||{}).value)||30;
  const want=per*n, est=Math.min(300,want);
  info.innerHTML='Targets <b>'+n+'</b> known beacon channel'+(n>1?'s':'')+
    ' &mdash; '+(want>300?'capped at <b>5m</b> total (would be '+fmtDur(want)+') &mdash; ~'+fmtDur(Math.floor(300/n))+' each':
      'about <b>'+fmtDur(est)+'</b> total at '+fmtDur(per)+' each')+'.';
}
/**
 * Sets the Intelli-scan per-channel duration slider/label and refreshes the Intelli-scan
 * info panel to reflect the new total estimate.
 * @param s Per-channel duration in seconds.
 */
function setIntelliDur(s){ const r=document.getElementById('intelliSecsInput'); if(!r)return;
  r.value=s; document.getElementById('intelliSecsLbl').textContent=fmtDur(s); refreshIntelliInfo(); }
/**
 * Starts a capture locked to every known beacon channel, with total duration equal to
 * the per-channel slider value times the number of known channels (clamped 5-300s).
 * No-op outside WiFi radar mode, while already capturing, or if no beacon channels are
 * known. Closes the capture popover and MAC info modal before starting.
 */
function startIntelliScan(){
  if(radarMode!=='wifi'||capturing)return;
  const mask=knownBeaconMask24(); if(!mask)return;
  const n=bitsSet(mask), per=+document.getElementById('intelliSecsInput').value||30;
  const s=Math.max(5,Math.min(300,per*n));
  capMask=mask; setTgtMask('cap',mask); paintChips('cap');
  capActive=mask; applyChanFilter();
  syncCapTypes(0x1D); syncCapData(0);
  closeCapPop();
  startCapture(s);
  if(macModalOpen)closeMacInfo();
}
let wifiShow={beacon:true,sta:true,probe:false,hid:false,unc:true};
let wifiChanLock=0;
/**
 * Toggles visibility of a WiFi record kind (beacon/sta/probe/hid/unc) in the table and
 * radar, updates the matching filter-chip elements' 'on' state, and re-renders the
 * currently visible view.
 * @param k Kind key to toggle in the wifiShow filter map.
 */
function toggleWifiKind(k){ wifiShow[k]=!wifiShow[k];
  document.querySelectorAll('[data-wk="'+k+'"]').forEach(el=>el.classList.toggle('on',wifiShow[k]));
  if(curView==='deauth')renderDeauth();
  if(liveOn)quickTick(); else paintCache(); }
/**
 * Opens or closes a WiFi kind-filter popover and syncs the trigger button's 'on' state.
 * @param pop Element id of the popover (defaults to 'wifiFilterPop').
 * @param btn Element id of the trigger button (defaults to 'wifiFilterBtn').
 */
function toggleWifiFilters(pop,btn){
  pop=document.getElementById(pop||'wifiFilterPop'); btn=document.getElementById(btn||'wifiFilterBtn');
  const open=pop.style.display==='none';
  pop.style.display=open?'flex':'none';
  btn.classList.toggle('on',open);
}
/**
 * Resets every wifiShow kind filter to visible, restores the 'on' class on all filter-chip
 * elements, re-renders the Deauth view if active, and clears any device table filters.
 */
function resetWifiFilters(){
  for(const k in wifiShow) wifiShow[k]=true;
  document.querySelectorAll('[data-wk]').forEach(el=>el.classList.add('on'));
  if(curView==='deauth')renderDeauth();
  clearDevFilters();
}
/**
 * Evaluates whether a WiFi record passes the current wifiShow kind filters (probe vs
 * beacon, cloaked/hidden vs uncloaked, beacon-with-clients vs beacon-without).
 * @param d WiFi record (or record-shaped object) to test.
 * @returns True if the record's kind is currently shown.
 */
function wifiKindPass(d){
  if(d.kind!=='beacon') return wifiShow.probe;
  if(d.hid) return d.ssid ? wifiShow.unc : wifiShow.hid;
  return (d.sta>0) ? wifiShow.sta : wifiShow.beacon;
}
/**
 * Evaluates whether a deauth/disassoc event passes the current kind filters, by looking
 * up its BSSID's AP record and delegating to wifiKindPass. Events whose AP is unknown
 * always pass.
 * @param e Deauth/disassoc event record.
 * @returns True if the event's associated AP kind is currently shown.
 */
function deauthKindPass(e){
  const ap=(lastWifi||[]).find(w=>w.mac===e.bssid);
  if(!ap) return true;
  return wifiKindPass({kind:'beacon', hid:ap.hid, ssid:ap.ssid, sta:(wifiClients[ap.mac]||[]).length});
}
let wifiClients={}, wifiClientAp={};
let absorbing={}, absorbed=new Set();
const ABSORB_MS=550;
let absorbLog=[], absorbLogOpen=false;
const ABSORB_LOG_MAX=200;
/**
 * Rebuilds the wifiClients (BSSID -> client MAC list) and wifiClientAp (client MAC ->
 * {bssid,ssid,cnt,rssi,age,rnd,vendor}) maps from the server's assoc[] array. Any client
 * newly seen as associated (not already known, not mid-animation, not already absorbed)
 * is queued into the absorbing set and kicks off the absorb radar animation.
 * @param assoc Array of association records from /api/data's assoc[] field.
 */
function buildAssoc(assoc){
  const bm={}, cm={};
  (assoc||[]).forEach(a=>{
    if(!a.bssid||!a.client)return;
    const l=bm[a.bssid]=bm[a.bssid]||[]; if(l.indexOf(a.client)<0)l.push(a.client);
    cm[a.client]={bssid:a.bssid, ssid:a.ssid||'', cnt:a.cnt||0, rssi:a.rssi, age:a.age, rnd:a.rnd, vendor:a.vendor||''};
  });
  Object.keys(cm).forEach(mac=>{
    if(!wifiClientAp[mac] && !absorbing[mac] && !absorbed.has(mac)){
      absorbing[mac]={start:performance.now(), apMac:cm[mac].bssid, apSsid:cm[mac].ssid||''};
      runAbsorbAnim();
    }
  });
  wifiClients=bm; wifiClientAp=cm;
}
/**
 * Drives the client-absorbed-into-AP radar animation via requestAnimationFrame: redraws
 * the radar each frame, and once an absorbing client's animation has run for ABSORB_MS it
 * is moved from the absorbing set into absorbLog (capped at ABSORB_LOG_MAX) and the
 * absorbed set. Re-schedules itself while any client is still animating; on completion
 * does a final redraw/re-render of the devices table and absorb log if open.
 */
function runAbsorbAnim(){
  requestAnimationFrame(()=>{
    drawRadar(lastDevs);
    const now=performance.now();
    let live=false;
    Object.keys(absorbing).forEach(m=>{
      if(now-absorbing[m].start>=ABSORB_MS){
        const info=absorbing[m];
        absorbLog.push({mac:m, apMac:info.apMac, apSsid:info.apSsid, at:Date.now()});
        if(absorbLog.length>ABSORB_LOG_MAX)absorbLog.shift();
        absorbed.add(m); delete absorbing[m];
      }
      else live=true;
    });
    if(live)runAbsorbAnim();
    else{ drawRadar(lastDevs); renderDevices(); if(absorbLogOpen)renderAbsorbLog(); }
  });
}
/**
 * Toggles visibility of the absorbed-clients log panel and its trigger button state,
 * re-rendering the log contents when opened.
 */
function toggleAbsorbLog(){
  absorbLogOpen=!absorbLogOpen;
  const p=document.getElementById('alog'); if(p)p.classList.toggle('hidden',!absorbLogOpen);
  const b=document.getElementById('alogBtn'); if(b)b.classList.toggle('on',absorbLogOpen);
  if(absorbLogOpen)renderAbsorbLog();
}
/**
 * Resolves a display name for an AP's SSID: the AP's live SSID if known, else the given
 * fallback name (HTML-escaped), else a hidden-network marker or the MAC suffix if the AP
 * is unknown or cloaked with no name.
 * @param apMac BSSID of the access point to look up.
 * @param fallback SSID to use if the AP isn't found in lastWifi or has no current SSID.
 * @returns Escaped SSID string, '‹hidden›', or the MAC's last 8 characters.
 */
function apSsidOf(apMac,fallback){
  const w=(lastWifi||[]).find(x=>x.mac===apMac && x.kind==='beacon');
  const ssid=(w&&w.ssid)||fallback;
  if(ssid) return esc(ssid);
  return (w&&w.hid)?'‹hidden›':apMac.slice(-8);
}
/**
 * Renders the absorbed-clients log list (newest first) into #alist, showing each
 * client-MAC-to-AP absorption with a timestamp and clickable MAC-info links, or a
 * placeholder message when the log is empty. Updates the log count in #nalog.
 */
function renderAbsorbLog(){
  const el=document.getElementById('alist'); if(!el)return;
  const n=document.getElementById('nalog'); if(n)n.textContent=absorbLog.length;
  if(!absorbLog.length){el.innerHTML='<div style="padding:4px 0">No associations absorbed yet.</div>';return;}
  el.innerHTML=absorbLog.slice().reverse().map(e=>{
    const ap=apSsidOf(e.apMac,e.apSsid);
    const t=new Date(e.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    return `<div class="ale"><span class="alt">${t}</span>`+
      `<span class="maclink" data-mac="${esc(e.mac)}" onclick="showMacInfo(this.dataset.mac)" title="show what is known about ${esc(e.mac)}">${e.mac.slice(-8)}</span>`+
      ` &rarr; <span class="maclink" data-mac="${esc(e.apMac)}" onclick="showMacInfo(this.dataset.mac)" title="show what is known about ${esc(e.apMac)}">${ap}</span></div>`;
  }).join('');
}
let alogMax=false, alogSaved=null;
/**
 * Toggles the absorbed-clients log panel between its normal size/position and a
 * maximised full-area layout, saving/restoring the prior inline geometry, and updates the
 * maximise button's icon/title.
 */
function toggleAbsorbLogMax(){
  const p=document.getElementById('alog'); if(!p)return;
  alogMax=!alogMax;
  if(alogMax){
    alogSaved={left:p.style.left,top:p.style.top,bottom:p.style.bottom,width:p.style.width,height:p.style.height};
    p.style.left='2px'; p.style.top='2px'; p.style.bottom=''; p.style.width='calc(100% - 4px)'; p.style.height='calc(100% - 4px)';
  }else if(alogSaved){
    p.style.left=alogSaved.left; p.style.top=alogSaved.top; p.style.bottom=alogSaved.bottom;
    p.style.width=alogSaved.width; p.style.height=alogSaved.height;
  }
  p.classList.toggle('maxed',alogMax);
  const b=document.getElementById('alogMaxBtn');
  if(b){b.innerHTML=alogMax?'&#10529;':'&#10530;'; b.title=alogMax?'restore':'maximise';}
}
(function(){
  const p=document.getElementById('alog'); if(!p)return;
  const hd=p.querySelector('.alhd'), wrap=document.getElementById('radarWrap');
  let dr=null;
  hd.addEventListener('mousedown',e=>{
    if(alogMax||e.target.closest('button'))return;
    dr={x0:e.clientX,y0:e.clientY,l0:p.offsetLeft,t0:p.offsetTop};
    p.style.left=dr.l0+'px'; p.style.top=dr.t0+'px'; p.style.bottom='';
    p.classList.add('dragging'); e.preventDefault();
  });
  window.addEventListener('mousemove',e=>{
    if(!dr)return;
    const maxL=Math.max(0,wrap.clientWidth-p.offsetWidth), maxT=Math.max(0,wrap.clientHeight-p.offsetHeight);
    p.style.left=Math.max(0,Math.min(maxL,dr.l0+(e.clientX-dr.x0)))+'px';
    p.style.top=Math.max(0,Math.min(maxT,dr.t0+(e.clientY-dr.y0)))+'px';
  });
  window.addEventListener('mouseup',()=>{ if(dr){dr=null; p.classList.remove('dragging');} });
})();
/**
 * Returns the client MAC list currently associated to a beacon record's BSSID.
 * @param r WiFi record to look up.
 * @returns Array of client MACs, empty if not a beacon or none associated.
 */
function beaconClients(r){ return (r.kind==='beacon' && wifiClients[r.mac])||[]; }
let expandedTableAPs=new Set();
/**
 * Toggles a beacon row's expanded-stations state in the devices table, mirroring the
 * change to the radar's expandedAPs set when the two views are kept in sync, then
 * re-renders the devices table.
 * @param mac BSSID of the beacon row to toggle.
 * @param ev Optional originating event, whose propagation is stopped if given.
 */
function toggleApExpand(mac,ev){
  if(ev){ev.stopPropagation();}
  if(expandedTableAPs.has(mac))expandedTableAPs.delete(mac); else expandedTableAPs.add(mac);
  if(syncSearch && expandedAPs.has(mac)!==expandedTableAPs.has(mac)) toggleExpand(mac);
  renderDevices();
}
/**
 * Expands or collapses every beacon row that has associated stations in the devices
 * table (and mirrors each to the radar's expandedAPs set when in sync), toggling all of
 * them to the opposite of their current all-open state, then re-renders the table and
 * updates the "expand all" button's icon/title/state.
 */
function toggleExpandAllStations(){
  const apMacs=(lastWifi||[]).filter(r=>beaconClients(r).length).map(r=>r.mac);
  if(!apMacs.length) return;
  const allOpen=apMacs.every(m=>expandedTableAPs.has(m));
  apMacs.forEach(m=>{
    if(allOpen)expandedTableAPs.delete(m); else expandedTableAPs.add(m);
    if(syncSearch && expandedAPs.has(m)!==expandedTableAPs.has(m)) toggleExpand(m);
  });
  const nowOpen=!allOpen;
  const b=document.getElementById('expandAllBtn');
  if(b){
    b.classList.toggle('on',nowOpen);
    b.title=nowOpen?"collapse every AP's associated stations":"expand every AP's associated stations at once";
    const p=b.querySelector('path'); if(p)p.setAttribute('d',nowOpen?'M6 12 L10 8 L14 12':'M6 8 L10 12 L14 8');
  }
  renderDevices();
}
let rowClickTimer=null;
document.getElementById('dt').addEventListener('click',e=>{
  if(e.target.closest('a,button,.refbtn'))return;
  const tr=e.target.closest('tbody tr[data-mac]'); if(!tr)return;
  if(radarMode!=='wifi')return;
  const mac=tr.dataset.mac;
  const rec=(lastWifi||[]).find(x=>x.mac===mac);
  if(!rec||rec.kind!=='beacon'||!beaconClients(rec).length)return;
  if(rowClickTimer){clearTimeout(rowClickTimer);rowClickTimer=null;return;}
  rowClickTimer=setTimeout(()=>{rowClickTimer=null;toggleApExpand(mac);},250);
});
/**
 * Builds a synthetic device-table row object for a client MAC shown under an expanded
 * AP, pulling rssi/min/max/channel/count/age from its wifiClientAp association info,
 * falling back to its own WiFi record when the association value is missing, and
 * resolving randomised-MAC/vendor status.
 * @param clientMac MAC of the associated client/station.
 * @param apMac BSSID of the AP this client is shown under (stashed as _apMac).
 * @returns Row object shaped like a WiFi record with kind:'client'.
 */
function clientRow(clientMac,apMac){
  const ci=wifiClientAp[clientMac]||{}, cw=(lastWifi||[]).find(x=>x.mac===clientMac);
  const rnd = cw ? !!cw.rnd : (parseInt(clientMac.slice(0,2),16)&0x02)!==0;
  const vendor = rnd ? '' : (ouiVendor(clientMac)||(cw&&cw.vendor)||'');
  return {mac:clientMac, kind:'client', ssid:ci.ssid||'', rssi:(ci.rssi!=null?ci.rssi:(cw?cw.rssi:0)),
          min:cw?cw.min:(ci.rssi!=null?ci.rssi:0), max:cw?cw.max:(ci.rssi!=null?ci.rssi:0),
          ch:cw?cw.ch:'', cnt:ci.cnt||(cw?cw.cnt:0), age:ci.age!=null?ci.age:(cw?cw.age:0),
          rnd, vendor, _apMac:apMac};
}
let expandedAPs=new Set(), expandAnimStart={}, expandDir={};
const EXPAND_ANIM_MS=450;
let clientOffsets={}, clientPlots=[], dragClient=null;
/**
 * Toggles a beacon's client-explode view on the radar: expands it (adding to
 * expandedAPs, direction 1) if not already expanded, or reverses it into an implode
 * animation (direction -1, staying in expandedAPs) if already expanded, then starts the
 * expand/implode animation loop and redraws the radar.
 * @param mac BSSID of the beacon to expand/collapse.
 */
function toggleExpand(mac){
  const now=performance.now();
  if(expandedAPs.has(mac)){
    if(expandDir[mac]!==-1){expandDir[mac]=-1; expandAnimStart[mac]=now;}
  }else{
    expandedAPs.add(mac); expandDir[mac]=1; expandAnimStart[mac]=now;
  }
  runExpandAnim();
  drawRadar(lastDevs);
}
let nodeMenuMac=null, nodeMenuPlot=null;
/**
 * Returns the node-menu's expand/collapse button element.
 * @returns The #nmExpand element.
 */
function nmExpandBtn(){return document.getElementById('nmExpand');}
/**
 * Positions the radar node context menu's Info and Expand buttons around a plotted node,
 * sizing them to the node's on-screen radius and clamping their position within the
 * viewport, and syncs the Expand button's on/title state to whether the node is expanded.
 * @param p Plot object for the node the menu is anchored to (device, screen coords, radius).
 */
function positionNodeMenu(p){
  nodeMenuPlot=p;
  const m=document.getElementById('nodeMenu'); if(!m)return;
  const r=rc.getBoundingClientRect(), nx=r.left+p.x, ny=r.top+p.y;
  const nodeD=(p.haloR||p.dr)*2, sz=Math.max(28,Math.min(48,nodeD/2));
  const fs=Math.max(9,Math.round(sz*16/38));
  const off=((p.haloR||p.dr)+sz/2+6)/Math.SQRT2;
  const pad=sz/2+2;
  const cx=v=>Math.max(pad,Math.min(innerWidth-pad,v));
  const cy=v=>Math.max(pad,Math.min(innerHeight-pad,v));
  const info=document.getElementById('nmInfo'), b=nmExpandBtn();
  [info,b].forEach(btn=>{ if(btn){btn.style.width=btn.style.height=sz+'px'; btn.style.fontSize=fs+'px';} });
  if(info){info.style.left=cx(nx-off)+'px'; info.style.top=cy(ny-off)+'px';}
  if(b){b.style.left=cx(nx+off)+'px'; b.style.top=cy(ny-off)+'px';}
  const on=expandedAPs.has(p.d.mac);
  if(b){ b.classList.toggle('on',on); b.title=(on?'Collapse':'Expand')+' stations on radar'; }
}
let nodeMenuFadeTimer=null;
/** Schedules the radar node context menu to fade out after 4s of inactivity. */
function armNodeMenuFade(){
  clearTimeout(nodeMenuFadeTimer);
  nodeMenuFadeTimer=setTimeout(()=>{
    const m=document.getElementById('nodeMenu'); if(m)m.classList.add('faded');
  },4000);
}
/**
 * Opens the radar node context menu for a plotted node: hides any open tip, marks the
 * node selected, positions the menu, shows it, arms its fade timer, and redraws the radar
 * to reflect the selection highlight.
 * @param p Plot object for the node the menu is being opened for.
 */
function showNodeMenu(p){
  hideTip();
  nodeMenuMac=p.d.mac; selectedMac=p.d.mac;
  const m=document.getElementById('nodeMenu'); if(!m)return;
  m.classList.remove('faded');
  positionNodeMenu(p);
  m.style.display='block';
  armNodeMenuFade();
  drawRadar(lastDevs);
}
/**
 * Hides the radar node context menu, clears its fade timer and selected-node state, and
 * redraws the radar if a node was selected.
 */
function hideNodeMenu(){
  clearTimeout(nodeMenuFadeTimer); nodeMenuFadeTimer=null;
  nodeMenuMac=null; nodeMenuPlot=null;
  const m=document.getElementById('nodeMenu');
  if(m){m.style.display='none'; m.classList.remove('faded');}
  if(selectedMac){selectedMac=null; drawRadar(lastDevs);}
}
/**
 * Handles the node menu's Info action: hides the menu and pins the detail tip for the
 * node the menu was opened on.
 */
function nodeMenuInfo(){
  const p=nodeMenuPlot;
  nodeMenuMac=null; nodeMenuPlot=null;
  const m=document.getElementById('nodeMenu'); if(m)m.style.display='none';
  if(p)pinTip(p);
}
/** Handles the node menu's Expand action: toggles expand/collapse on the menu's target node. */
function nodeMenuExpand(){ if(nodeMenuMac)toggleExpand(nodeMenuMac); }
document.addEventListener('click',e=>{
  if(!nodeMenuMac)return;
  const m=document.getElementById('nodeMenu');
  if(m&&!m.contains(e.target)&&e.target.tagName!=='CANVAS')hideNodeMenu();
});
/**
 * Drives the AP expand/implode animation loop via requestAnimationFrame: redraws the
 * radar each frame and keeps re-scheduling itself while any expanded AP's animation is
 * still within EXPAND_ANIM_MS of its start time.
 */
function runExpandAnim(){
  requestAnimationFrame(()=>{
    drawRadar(lastDevs);
    const now=performance.now();
    let live=false;
    expandedAPs.forEach(m=>{if(now-(expandAnimStart[m]||0)<EXPAND_ANIM_MS)live=true;});
    if(live)runExpandAnim();
  });
}

let deSort={k:'age',dir:1};
let trSort={k:'_seq',dir:1};
const DEAUTH_REASONS={0:'',1:'unspecified',2:'prev auth invalid',3:'sta leaving',
  4:'inactivity',5:'AP overloaded',6:'class-2 frame from nonauth',7:'class-3 from nonassoc',
  8:'sta leaving (disassoc)',9:'not authenticated',13:'invalid IE',14:'MIC failure',
  15:'4-way handshake timeout',16:'group-key timeout',23:'802.1X auth failed'};
/**
 * Formats a deauth/disassoc reason code as "code · description", or just the bare code
 * when no known description exists.
 * @param c Numeric reason code.
 * @returns Formatted reason string.
 */
function reasonTxt(c){const t=DEAUTH_REASONS[c]; return (t==null)?(''+c):(t?`${c} · ${t}`:(''+c));}
/**
 * Renders a clickable MAC-address span that opens the MAC-info modal on click.
 * @param mac MAC address string; falsy renders a placeholder, broadcast renders as plain text.
 * @returns HTML span markup for the MAC link, or a muted placeholder.
 */
function macLink(mac){
  if(!mac) return '<span class="muted">?</span>';
  if(mac==='ff:ff:ff:ff:ff:ff') return '<span class="muted">broadcast</span>';
  return `<span class="maclink" data-mac="${esc(mac)}" onclick="showMacInfo(this.dataset.mac)" title="show what is known about ${esc(mac)}">${esc(mac)}</span>`;
}
/**
 * Renders the "network info" modal for a named SSID: aggregate access-point
 * list and per-band scout/local scan actions for every beacon sharing that
 * SSID. Writes into #macModalBody and opens #macModal.
 * @param ssid SSID string to look up among lastWifi beacon records.
 */
function showNetworkInfo(ssid){
  macModalMac_=null;
  const members=(lastWifi||[]).filter(x=>x.kind==='beacon'&&x.ssid===ssid).sort((a,b)=>b.rssi-a.rssi);
  const totalSta=members.reduce((s,m)=>s+((wifiClients[m.mac]||[]).length),0);
  let h=`<div class="macid ap">
    <div class="macid-badge" title="Network">&#9670;</div>
    <div class="macid-main">
      <div class="macid-name">${esc(ssid)}</div>
      <div class="macid-sub">${members.length} access points &middot; ${totalSta} associated station(s)</div>
    </div>
  </div>`;
  h+='<div class="setsec"><div class="setsec-hd">Access points</div><div class="clientlist">';
  members.forEach(m=>{
    const ven=m.rnd?'':(ouiVendor(m.mac)||m.vendor||'');
    const n=(wifiClients[m.mac]||[]).length;
    let scanBtn='';
    if(scoutLinked && m.ch){
      const targeting=scoutChanActive(m.ch);
      scanBtn=`<button class="actmenu-item${targeting?' on':''}" onclick="targetScoutChannel(this,${m.ch})"
        title="Flush the scout and lock it to channel ${m.ch} for this AP — forwards Probe/Assoc/Resp/Deauth+Data, beacons excluded">`+
        (targeting?`Scanning ch ${m.ch} (scout)`:`Scan for clients via scout (ch ${m.ch})`)+'</button>';
    }
    h+=`<div class="clientrow" style="flex-direction:column;align-items:stretch;gap:4px">
      <div class="clientrow" style="padding:0;border:none">
        <span>${macLink(m.mac)}${ven?` <span class="venlbl">(${esc(ven)})</span>`:''}${wifiNewBadge(m)}</span>
        <span class="muted">ch ${m.ch||'&mdash;'} &middot; ${m.rssi} dBm${n?` &middot; ${n} sta`:''}</span>
      </div>
      ${scanBtn}
    </div>`;
  });
  h+='</div></div>';
  {
    const {mask24,mask5}=networkChanMasks(ssid);
    if(mask24||mask5){
      let actions='';
      if(scoutLinked)
        actions+=`<button id="netScanAllBtn" class="actmenu-item" data-ssid="${esc(ssid)}" onclick="scanNetworkViaScout(this.dataset.ssid,this)"
          title="Flush the scout and set its channel set to every channel this name is broadcast on, in one hop set — forwards Probe/Assoc/Resp/Deauth+Data, beacons excluded">Scan all channels via scout</button>`;
      if(mask24)
        actions+=`<button class="actmenu-item"${capturing?' disabled':''} data-ssid="${esc(ssid)}" onclick="scanNetworkLocal(this.dataset.ssid)"
          title="Run this board's own timed WiFi capture across every 2.4GHz channel this name is broadcast on — no scout needed">Scan all channels (local)</button>`;
      if(actions) h+=`<div class="setsec">${actions}</div>`;
    }
  }
  document.getElementById('macModalBody').innerHTML=h;
  macModalOpen=true; document.getElementById('macModal').classList.add('on');
}
let macModalOpen=false, macModalMac_=null;
/**
 * Renders the full per-MAC info modal: role (AP/client), vendor, security
 * badge, signal stats, association context (its AP or associated stations),
 * deauth/handshake involvement, and an Actions menu. Writes into
 * #macModalBody/#macModalMac and opens #macModal.
 * @param mac MAC address to describe.
 */
function showMacInfo(mac){
  macModalMac_=mac;
  const mr=document.getElementById('macModalRef'); if(mr)mr.classList.toggle('on',mac===refMac);
  const mg=document.getElementById('macModalGps'); if(mg)mg.classList.toggle('on',!!gpsFocus&&gpsFocus.mac===mac);
  const w=(lastWifi||[]).find(x=>x.mac===mac);
  const asAp=wifiClientAp[mac];
  const clients=wifiClients[mac]||[];
  const dAs=(lastDeauth||[]).filter(d=>d.src===mac||d.dst===mac);
  const hAs=(lastHandshake||[]).filter(x=>x.client===mac||x.bssid===mac);
  const isRnd = w ? !!w.rnd : (parseInt(mac.slice(0,2),16)&0x02)!==0;
  let role = clients.length ? 'Access point' : (asAp ? 'Client (associated)' : (w? (w.kind==='beacon'?'Access point':'Client'):'Unknown'));
  const roleClass = role==='Access point'?'ap':(role.indexOf('Client')===0?'cli':'unk');
  const roleIcon = roleClass==='ap'?'&#9670;':(roleClass==='cli'?'&#9679;':'&#9675;');
  const row=(k,v)=>v?`<div class="setrow"><span class="k">${k}</span><span class="v">${v}</span></div>`:'';
  const infoVen=isRnd?'':(ouiVendor(mac)||(w&&w.vendor)||(asAp&&asAp.vendor)||'');
  const venTxt=infoVen?esc(infoVen):(isRnd?'randomised MAC':'vendor unknown');
  const dispName = w
    ? (w.ssidbad?ssidHtml(w.ssid,w.ssidbad,w.ssidhex)
       :(w.ssid?esc(w.ssid)+(w.hid?' <span class="hidn" title="cloaked AP; name recovered from a directed probe-response / association">(cloaked)</span>':'')
       :(w.hid?'<span class="hidn">&#8249;hidden&#8250; &mdash; SSID cloaked</span>':`<span class="muted">${role}</span>`)))
    : `<span class="muted">${role}</span>`;
  let h=`<div class="macid ${roleClass}">
    <div class="macid-badge" title="${esc(role)}">${roleIcon}</div>
    <div class="macid-main">
      <div class="macid-name">${dispName}</div>
      <div class="macid-sub">${esc(role)} &middot; ${venTxt}</div>
      <div class="macid-mac" data-mac="${esc(mac)}" onclick="copyMac(this,this.dataset.mac)" title="click to copy MAC">${esc(mac)}<span class="copyhint">&#10697;</span></div>
    </div>
    <div class="macid-tags">
      <span class="tag ${isRnd?'RND':'PUB'}" title="${isRnd?'locally-administered (randomised)':'universally-administered (real)'} MAC">${isRnd?'RND':'REAL'}</span>
      ${(w && w.kind==='beacon')?wifiHotspotBadge(w):''}
      ${(w && w.kind==='beacon')?secBadge(w):''}
    </div>
  </div>`;
  if(w){
    h+='<div class="setsec macsignal"><div class="statgrid">'+
       (w.kind!=='probe'?`<div><span class="k">Channel</span><b>${w.ch||'&mdash;'}</b></div>`:'')+
       `<div><span class="k">RSSI</span><b>${w.rssi} dBm</b></div>`+
       `<div><span class="k">Avg</span><b>${w.avg} dBm</b></div>`+
       `<div><span class="k">Range</span><b>${w.min} / ${w.max}</b></div>`+
       `<div><span class="k">Frames</span><b>${w.cnt}</b></div>`+
       `<div><span class="k">Last seen</span><b>${w.age}s ago</b></div>`+
       '</div>'+(spark(mac)||sigBar(w.rssi));
    if(w.kind==='beacon') h+=`<div class="sethint">${esc(secText(w))}</div>`;
    if(SECTOOLS && w.kind==='beacon' && w.mfr) h+=row('Manufacturer',esc(w.mfr));
    if(SECTOOLS && w.kind==='beacon' && w.modelname) h+=row('Model name',esc(w.modelname));
    if(SECTOOLS && w.kind==='beacon' && w.model) h+=row('Model number',esc(w.model));
    if(w.ssidbad) h+=`<div class="sethint">SSID (hex): <span class="hexdump">${esc(hexSpaced(w.ssidhex))}</span></div>`;
    if(w.lat!==undefined && w.lon!==undefined)
      h+=row('Location',
        `<span class="tag coord">${w.lat.toFixed(6)}</span><span class="tag coord">${w.lon.toFixed(6)}</span>`+
        `<a class="maplink" href="https://www.google.com/maps?q=${w.lat},${w.lon}" target="_blank" rel="noopener" title="Open in Google Maps (needs an internet uplink -- this device is offline)">`+
        `<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.5H4.5A1.5 1.5 0 0 0 3 5v10.5A1.5 1.5 0 0 0 4.5 17H15a1.5 1.5 0 0 0 1.5-1.5V12"/><path d="M12 3.5H16.5V8"/><path d="M16.2 3.8 9.5 10.5"/></svg></a>`);
    h+='</div>';
  }
  {
    const isTgt=mac===refMac;
    let items=`<button id="macModalRef" class="actmenu-item${isTgt?' on':''}" onclick="closeMacActions();setRef(macModalMac_)">`+
       `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="1.6" fill="currentColor" stroke="none"/></svg>`+
       (isTgt?'Clear radar focus':'Set radar focus')+'</button>';
    if(w && w.lat!==undefined){
      const isGpsTgt=!!gpsFocus&&gpsFocus.mac===mac;
      items+=`<button id="macModalGps" class="actmenu-item${isGpsTgt?' on':''}" onclick="closeMacActions();setGpsFocus(macModalMac_)"
            title="Filter the radar/table to devices within a chosen distance of this device's logged GPS position">`+
         `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 17s6-5.5 6-9.5A6 6 0 0 0 4 7.5C4 11.5 10 17 10 17z"/><circle cx="10" cy="7.5" r="1.8"/></svg>`+
         (isGpsTgt?'Clear GPS focus':'Set GPS focus')+'</button>';
    }
    if(w && w.kind==='beacon' && w.ch){
      const is5=is5gChan(w.ch);
      if(scoutLinked){
        const targeting=scoutChanActive(w.ch);
        items+=`<button class="actmenu-item${targeting?' on':''}" onclick="closeMacActions();targetScoutChannel(this,${w.ch})"
              title="Flush the scout and lock it to channel ${w.ch} for this AP — forwards Probe/Assoc/Resp/Deauth+Data, beacons excluded">`+
           `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 12a10 10 0 0 1 12 0"/><path d="M7 15a5.5 5.6 0 0 1 6 0"/><circle cx="10" cy="17" r="1.1" fill="currentColor" stroke="none"/></svg>`+
           (targeting?`Scanning ch ${w.ch} (scout)`:`Scan for clients via scout (ch ${w.ch})`)+'</button>';
      }
      if(!is5||capDualBand)
        items+=`<button class="actmenu-item"${capturing?' disabled':''} onclick="closeMacActions();captureChannel(${w.ch})"
              title="Run this board's own timed WiFi capture locked to channel ${w.ch} — no scout needed. Forwards Probe/Assoc/Deauth+Data, beacons excluded, so already-connected clients get paired.">`+
           `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="2.6" fill="currentColor" stroke="none"/></svg>`+
           `Scan for clients (ch ${w.ch})</button>`;
      if(SECTOOLS&&!RECON)
        items+=`<button class="actmenu-item" data-mac="${esc(w.mac)}" onclick="closeMacActions();openSendFrame(this.dataset.mac,${w.ch})"
              title="Send a raw-frame preset (deauth/disassoc/probe-req/PMKID) at this AP — via a linked Scout's own radio, or this board's own radio (dashboard briefly offline) with no scout">`+
           `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l13 6-13 6 3-6-3-6z"/></svg>`+
           `Send frame&hellip;</button>`;
    }
    if(SECTOOLS&&!RECON)
      items+=`<button class="actmenu-item" data-mac="${esc(mac)}" onclick="closeMacActions();openSimilarMac(this.dataset.mac)"
            title="Clone this MAC's OUI into the dashboard AP or uplink STA MAC override">`+
         `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="6" width="14" height="9" rx="1.5"/><path d="M7 6V4.5a3 3 0 0 1 6 0V6"/></svg>`+
         `Use similar MAC&hellip;</button>`;
    if(SECTOOLS&&!RECON&&asAp){
      const apw=(lastWifi||[]).find(x=>x.mac===asAp.bssid);
      if(apw && apw.ch && !is5gChan(apw.ch))
        items+=`<button class="actmenu-item" data-mac="${esc(asAp.bssid)}" data-mac2="${esc(mac)}" onclick="closeMacActions();openSendFrame(this.dataset.mac,${apw.ch},this.dataset.mac2)"
              title="Send a raw-frame preset (deauth/disassoc/probe-req/PMKID) targeting this device via its AP">`+
           `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l13 6-13 6 3-6-3-6z"/></svg>`+
           `Send frame&hellip;</button>`;
    }
    if(SECTOOLS && w && w.kind==='probe' && w.ssid && !asAp)
      items+=`<button class="actmenu-item" data-ssid="${esc(w.ssid)}" onclick="closeMacActions();useProbeSsidForLocalAp(this.dataset.ssid)"
            title="Open the Local AP view with this SSID prefilled — evil-twin the network this client is hunting for">`+
         `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="9" width="12" height="8" rx="1.5"/><path d="M7 9V6a3 3 0 0 1 6 0v3"/></svg>`+
         `Use as Local AP name&hellip;</button>`;
    h+='<div class="setsec"><div class="actmenu-wrap">'+
       `<button id="macActBtn" class="scoutTgtBtn actmenu-btn" onclick="toggleMacActions(event)">Actions <span class="car">&#9662;</span></button>`+
       `<div id="macActMenu" class="actmenu">${items}</div>`+
       '</div></div>';
  }
  const isUnassocProbe = w && w.kind==='probe' && w.ssid && !asAp;
  if(asAp||clients.length||isUnassocProbe){
    const clientsIcon=`<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><circle cx="7" cy="7" r="2.5"/><path d="M2.3 16c0-3 2.1-4.8 4.7-4.8s4.7 1.8 4.7 4.8"/><circle cx="14.2" cy="6" r="2.1"/><path d="M11.3 15.2c.3-2.5 1.8-3.9 3.4-3.9c1.9 0 3.4 1.5 3.7 3.9"/></svg>`;
    h+=`<div class="setsec"><div class="setsec-hd">${clients.length?clientsIcon:''}Association${clients.length?` <span class="cnt">${clients.length}</span>`:''}</div>`;
    if(asAp){ const av=ouiVendor(asAp.bssid)||asAp.vendor||'';
      h+=row('Associated to', macLink(asAp.bssid)+(asAp.ssid?` (${esc(asAp.ssid)})`:'')+(av?` <span class="venlbl" title="AP vendor (OUI)">(${esc(av)})</span>`:''));
    } else if(w && w.kind==='probe' && w.ssid) {
      h+=row('Probing for', esc(w.ssid)+' <span class="muted">(not associated)</span>');
    }
    if(clients.length){
      const rows=clients.map(cm=>{
        const ci=wifiClientAp[cm]||{}, cw=(lastWifi||[]).find(x=>x.mac===cm);
        const rnd = cw ? !!cw.rnd : (parseInt(cm.slice(0,2),16)&0x02)!==0;
        const ven = rnd ? '' : (ouiVendor(cm)||(cw&&cw.vendor)||'');
        return {mac:cm, act:ci.cnt||0, rssi:(ci.rssi!=null?ci.rssi:(cw?cw.rssi:null)),
                age:(ci.age!=null?ci.age:(cw?cw.age:null)), frames:cw?cw.cnt:null, rnd:rnd, ven:ven};
      }).sort((a,b)=>b.act-a.act);
      h+='<div class="clitbl-wrap"><table class="clitbl"><thead><tr>'+
         '<th>MAC</th><th>TYPE</th><th>RSSI</th><th>FR</th><th>ASSOC</th><th>AGE</th><th>VENDOR</th>'+
         '</tr></thead><tbody>'+rows.map(c=>{
        const badge=c.rnd?'<span class="tag wprb" title="locally-administered (randomised) MAC">RND</span>'
                         :'<span class="tag wcli" title="universally-administered (real) MAC">REAL</span>';
        return `<tr><td class="mac">${macLink(c.mac)}${wifiNewBadge({isNew:newStationMacs.has(c.mac)})}</td><td>${badge}</td>`+
               `<td class="rssi">${c.rssi!=null?c.rssi:'<span class="muted">—</span>'}</td>`+
               `<td>${c.frames!=null?c.frames:'<span class="muted">—</span>'}</td>`+
               `<td>${c.act||0}</td>`+
               `<td class="muted">${c.age!=null?c.age+'s':'—'}</td>`+
               `<td>${c.ven?esc(c.ven):'<span class="muted">—</span>'}</td></tr>`;
      }).join('')+'</tbody></table></div>';
    }
    h+='</div>';
  }
  if(dAs.length){
    h+=`<div class="setsec"><div class="setsec-hd">Deauth / disassoc <span class="cnt">${dAs.length}</span></div>`;
    dAs.slice(0,8).forEach(d=>{
      const dir=d.src===mac?('→ '+ (d.dst==='ff:ff:ff:ff:ff:ff'?'broadcast':esc(d.dst)))
                           :('â† '+esc(d.src));
      h+=row((d.dis?'disassoc ':'deauth ')+dir, `×${d.cnt} · r${d.reason} · ${d.age}s`);
    });
    h+='</div>';
  }
  if(SECTOOLS && hAs.length){
    h+=`<div class="setsec"><div class="setsec-hd">Handshake / PMKID <span class="cnt">${hAs.length}</span></div>`;
    hAs.slice(0,8).forEach(x=>{
      const dir=x.client===mac?('→ '+esc(x.bssid)):('client '+esc(x.client));
      const full=(x.mask&0xF)===0xF;
      h+=row(dir, `${full?'<b>4/4 captured</b>':hsBadges(x.mask)}${x.pmkid?' · PMKID':''} · ${x.age}s`);
    });
    h+='</div>';
  }
  if(!w&&!asAp&&!clients.length&&!dAs.length&&!hAs.length)
    h+='<div class="setsec"><span class="muted">Only seen in a deauth/disassoc frame — no other data captured for this MAC yet. Run a capture on its channel to learn more.</span></div>';
  document.getElementById('macModalMac').textContent=(w&&w.ssid)?w.ssid:mac;
  document.getElementById('macModalBody').innerHTML=h;
  document.getElementById('macModal').classList.add('on');
  macModalOpen=true;
}
/**
 * Opens the MAC-info Actions dropdown (#macActMenu), positioning it under
 * #macActBtn and clamping to the viewport, or closes it if already open.
 * @param e Triggering event; propagation is stopped if present.
 */
function toggleMacActions(e){ if(e)e.stopPropagation();
  const m=document.getElementById('macActMenu'), b=document.getElementById('macActBtn');
  if(!m||!b)return;
  if(m.classList.contains('on')){ closeMacActions(); return; }
  const r=b.getBoundingClientRect(), mw=Math.min(260,innerWidth-16);
  m.style.minWidth=mw+'px'; m.classList.add('on'); b.classList.add('on');
  const mh=m.offsetHeight;
  let left=Math.max(8,Math.min(r.left,innerWidth-mw-8));
  let top=r.bottom+6;
  if(top+mh>innerHeight-8) top=Math.max(8,r.top-mh-6);
  m.style.left=left+'px'; m.style.top=top+'px'; }
/** Hides the MAC-info Actions dropdown (#macActMenu) and its trigger button's active state. */
function closeMacActions(){
  const m=document.getElementById('macActMenu'), b=document.getElementById('macActBtn');
  if(m)m.classList.remove('on'); if(b)b.classList.remove('on'); }
document.addEventListener('click',e=>{
  const m=document.getElementById('macActMenu'); if(!m||!m.classList.contains('on'))return;
  if(!e.target.closest('#macActMenu')&&!e.target.closest('#macActBtn')) closeMacActions(); });
document.getElementById('macModal').addEventListener('scroll',()=>closeMacActions());
let macInfoOwnsSelect=false;
/**
 * Closes the MAC-info modal (#macModal) and its Actions dropdown, clearing
 * the radar's selected-MAC highlight if this modal set it.
 */
function closeMacInfo(){ macModalOpen=false; document.getElementById('macModal').classList.remove('on');
  closeMacActions();
  if(macInfoOwnsSelect){macInfoOwnsSelect=false; if(selectedMac){selectedMac=null; drawRadar(lastDevs);}} }
let sfSending=false, sfFinishing=false, laSending=false, laFinishing=false;
/* @GUARD:IF TDONGLE_BUILD */
/**
 * Arms an unbounded (indefinite) WiFi capture for the T-Dongle build: resets pre-capture
 * MAC snapshots, shows the "stop via BOOT button" reconnect UI immediately (capFinishing=true
 * from the start, since there's no countdown), and POSTs /api/wifi/capture with
 * indefinite=1 and the current channel/type/DATA options. Reloads the page (or shows the
 * auth overlay on a 401) if the arm request fails; otherwise starts pollReconnect().
 */
async function startStandaloneCapture(){
  if(radarMode!=='wifi'||capturing||capFinishing) return;
  if(!liveOn) toggleLive();
  preCaptureMacs=new Set(lastWifi.map(x=>x.mac));
  preCaptureStationMacs=new Set(Object.keys(wifiClientAp));
  hideApLost();
  const ct0=document.getElementById('crTitle'); if(ct0)ct0.textContent='Standalone Capture';
  const cp=document.getElementById('crParams'); if(cp)cp.innerHTML=capSummaryHtml();
  const cs=document.getElementById('crSub'); if(cs){cs.style.display='';cs.innerHTML=
    'No time limit -- press the T-Dongle\'s BOOT button once to stop.<br>Scan the code below to rejoin once you do.';}
  const qw=document.getElementById('capQrWrap'); if(qw)qw.style.display='';
  const cf0=document.getElementById('capQrFrame'); if(cf0){cf0.classList.remove('revealed');clearTimeout(qrRevealTimers.capQrFrame);}
  armCapQr();
  prefetchApCreds();
  capFinishing=true;
  updateCapUI(0,0);
  const dataBtn=document.getElementById('capDataBtn'), dataOn=dataBtn&&dataBtn.classList.contains('on');
  const p24=document.getElementById('capPause24Btn'), p5=document.getElementById('capPause5Btn');
  const q='secs=300&indefinite=1&cap='+capMask+'&cap5='+capMask5+
    '&cappause24='+((p24&&!p24.classList.contains('on'))?1:0)+
    '&cappause5='+((p5&&!p5.classList.contains('on'))?1:0)+
    '&captypes='+capTypeMask()+'&data='+(dataOn?1:0)+'&frames=0';
  let capRes=null;
  try{capRes=await fetch('/api/wifi/capture',{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},body:q});}catch(e){}
  if(capRes&&!capRes.ok){
    capFinishing=false; updateCapUI(0,0);
    if(capRes.status===401) showAuth(); else location.reload();
    return;
  }
  pollReconnect();
}
/* @ENDGUARD *//* @GUARD:IF WITH_SECURITYTOOLS */
/**
 * Populates and opens the Send Frame modal (#sendFrameModal) for a target AP:
 * builds the type/target/reason/SSID/interval/duration fields, preselects an
 * optional client, and syncs status against any already-running injection.
 * @param apMac BSSID of the target access point.
 * @param apCh Channel the target AP is on.
 * @param presetTarget Optional client MAC to preselect in the target dropdown.
 */
function openSendFrame(apMac,apCh,presetTarget){
  loadHsFiles();
  const w=(lastWifi||[]).find(x=>x.mac===apMac);
  const clients=wifiClients[apMac]||[];
  const clientList=(presetTarget&&!clients.includes(presetTarget))?[presetTarget,...clients]:clients;
  const opts=clientList.map(cm=>{
    const v=ouiVendor(cm);
    return `<option value="${esc(cm)}"${cm===presetTarget?' selected':''}>${esc(cm.slice(-8))}${v?' - '+esc(v):''}</option>`;
  }).join('');
  document.getElementById('sfBody').innerHTML=`
    <div class="setrow"><span class="k">Target AP</span><span class="v">${esc((w&&w.ssid)||apMac)} (ch ${apCh})</span></div>
    <div class="setrow"><span class="k">Type</span><span class="v">
      <select id="sfType" onchange="onSfTypeChange()">
        <option value="0">Deauth</option>
        <option value="1">Disassoc</option>
        <option value="2">Directed probe-req</option>
        <option value="4">PMKID request</option>
        <option value="5">CSA (channel switch, broadcast)</option>
        <option value="7">CSA (channel switch, unicast)</option>
        <option value="6">QoS Null (spoofed-client power-save)</option>
      </select></span></div>
    <div class="setrow" id="sfTargetRow"><span class="k">Target client</span><span class="v">
      <select id="sfTarget"><option value="ff:ff:ff:ff:ff:ff">Broadcast (all clients)</option>${opts}</select></span></div>
    <div class="setrow" id="sfReasonRow"><span class="k" id="sfReasonLbl">Reason</span><span class="v">
      <select id="sfReasonSel" onchange="onSfReasonSelChange()">${reasonSelectOptions(1)}</select>
      <input type="number" id="sfReason" value="1" min="0" max="65535" style="display:none"></span></div>
    <div class="setrow" id="sfSsidRow" style="display:none"><span class="k">SSID</span><span class="v">
      <input type="text" id="sfSsid" maxlength="32" value="${esc((w&&w.ssid)||'')}"></span></div>
    <div class="setrow"><span class="k">Interval</span><span class="v">
      <input type="number" id="sfInterval" value="200" min="50" max="10000"> ms</span></div>
    <div class="setrow" id="sfSecsRow" style="display:${scoutLinked?'none':''}"><span class="k">Duration</span><span class="v">
      <input type="range" id="sfSecs" min="5" max="60" value="15" step="5"
             oninput="document.getElementById('sfSecsLbl').textContent=fmtDur(+this.value)">
      <b id="sfSecsLbl">15s</b></span></div>
    <div class="setrow"><span class="k">Run</span><span class="v">
      <button id="sfStartBtn" onclick="startSendFrame()">Start</button>
      <button id="sfStopBtn" onclick="stopSendFrame()" disabled>Stop</button></span></div>
    <div class="sethint" id="sfStatus"></div>
    <div class="sethint" id="sfHsStatus"></div>`;
  const m=document.getElementById('sendFrameModal');
  m.dataset.apmac=apMac; m.dataset.apch=apCh;
  m.classList.add('on');
  onSfTypeChange();
  syncSendFrameStatus(lastInject);
  if(macModalOpen)closeMacInfo();
}
/** Closes the Send Frame modal (#sendFrameModal). */
function closeSendFrame(){ document.getElementById('sendFrameModal').classList.remove('on'); }
/**
 * Shows/hides the target-client/reason/SSID rows in the Send Frame modal based on
 * the selected frame type, and repurposes the Reason field's label/range for
 * CSA (new channel, 1-13) and QoS Null (sleep bit, 0-1) -- mirrors the
 * Cardputer's per-type field reuse in WifiSendFrameScreen::buildSpec_.
 */
function onSfTypeChange(){
  const t=+document.getElementById('sfType').value;
  const isDeauth=(t===0||t===1), isCsa=(t===5||t===7), isQos=(t===6);
  document.getElementById('sfTargetRow').style.display=(isDeauth||t===7||isQos)?'':'none';
  document.getElementById('sfReasonRow').style.display=(isDeauth||isCsa||isQos)?'':'none';
  document.getElementById('sfSsidRow').style.display=(t===2||t===4)?'':'none';
  const rl=document.getElementById('sfReasonLbl'), ri=document.getElementById('sfReason'), rs=document.getElementById('sfReasonSel');
  if(isCsa){ rl.textContent='New channel'; rs.style.display='none'; ri.style.display=''; ri.min=1; ri.max=13; if(+ri.value<1||+ri.value>13)ri.value=6; }
  else if(isQos){ rl.textContent='Sleep bit (0=awake, 1=sleep)'; rs.style.display='none'; ri.style.display=''; ri.min=0; ri.max=1; if(+ri.value>1)ri.value=1; }
  else if(isDeauth){ rl.textContent='Reason'; rs.style.display=''; onSfReasonSelChange(); }
}
/**
 * Builds the deauth/disassoc reason-code <option> list from DEAUTH_REASONS,
 * showing each entry as "Name (code)", plus a trailing Custom… option for
 * codes not in the table.
 * @param sel Reason code to preselect, or null to preselect Custom.
 * @returns Option elements HTML.
 */
function reasonSelectOptions(sel){
  return Object.keys(DEAUTH_REASONS).filter(k=>k!=='0').map(k=>{
    const name=DEAUTH_REASONS[k], label=name.charAt(0).toUpperCase()+name.slice(1);
    return `<option value="${k}"${+k===sel?' selected':''}>${esc(label)} (${k})</option>`;
  }).join('')+`<option value="custom"${sel==null?' selected':''}>Custom…</option>`;
}
/**
 * Toggles the custom reason-code number input alongside the Send Frame
 * reason <select>, shown only when "Custom…" is chosen.
 */
function onSfReasonSelChange(){
  const rs=document.getElementById('sfReasonSel'), ri=document.getElementById('sfReason');
  const custom=(rs.value==='custom');
  ri.style.display=custom?'':'none';
  ri.min=0; ri.max=65535; if(custom&&(!ri.value||+ri.value<0))ri.value=1;
}
let sfCrEnd=0, sfCrTimer=null, sfWasActive=false;
/**
 * Updates the Send Frame modal's handshake/PMKID status line (#sfHsStatus).
 * @param row Matching handshake-target row from /api/security/handshakes/ram, or null/undefined if none captured.
 * @param armed Whether handshake capture is currently armed.
 */
function renderSfHsStatus(row,armed){
  const el=document.getElementById('sfHsStatus'); if(!el)return;
  if(!armed){
    el.innerHTML=hsSdAvail
      ?'<span class="muted">Handshake capture starts automatically with this run.</span>'
      :'<span class="muted">Handshake Capture is off — arm it on the Handshakes tab to detect a 4-way/PMKID.</span>';
    return;
  }
  if(!row||!row.mask){ el.innerHTML='<span class="muted">No handshake/PMKID captured.</span>'; return; }
  const full=(row.mask&0xF)===0xF;
  el.innerHTML=(full?'<b style="color:#5ec26a">4-way handshake captured</b> ':(row.pmkid?'<b style="color:#5ec26a">PMKID captured</b> ':'Partial: '))+hsBadges(row.mask)+
    ' <a href="#" onclick="event.preventDefault();closeSendFrame();setView(&quot;deauth&quot;);" title="Jump to Authorisations tab">view in Authorisations →</a>';
}
/**
 * Fetches the RAM handshake-capture table and renders the status for the
 * given AP into the Send Frame modal via renderSfHsStatus.
 * @param apMac BSSID to look up among captured handshake targets; no-op if falsy.
 */
function checkSendFrameHandshake(apMac){
  if(!apMac)return;
  fetch('/api/security/handshakes/ram').then(r=>r.json()).then(d=>{
    const row=(d.targets||[]).find(t=>t.bssid&&t.bssid.toLowerCase()===apMac.toLowerCase());
    renderSfHsStatus(row||null,!!d.armed);
  }).catch(()=>{});
}
/**
 * Updates the Send Frame countdown ring (#sfruns/#sfCrLeft/#sfCrArc) while a
 * send or its post-run reconnect wait is active.
 * @param left Seconds remaining.
 * @param total Total seconds the countdown started from (0 hides the arc fraction).
 */
function updateSfUI(left,total){
  const el=document.getElementById('sfruns'),
        num=document.getElementById('sfCrLeft'),
        arc=document.getElementById('sfCrArc');
  if(!el)return;
  if(sfSending||sfFinishing){
    el.classList.add('on');
    num.textContent=Math.max(0,left);
    const frac=total?Math.max(0,Math.min(1,left/total)):0;
    arc.style.strokeDashoffset=(CR_CIRC*(1-frac)).toFixed(1);
  }else{ el.classList.remove('on'); }
}
/**
 * Loads/reloads the AP-join QR image (#sfQrImg) shown during the post-send
 * reconnect wait, retrying on load failure while the run is still active.
 * @param bust Whether to append a cache-busting query param to the image URL.
 */
function armSfQr(bust){
  const cq=document.getElementById('sfQrImg'); if(!cq) return;
  cq.onerror=()=>{ if(sfSending||sfFinishing) setTimeout(()=>armSfQr(true),800); };
  cq.onload=()=>{ cq.onerror=null; };
  cq.src='/api/network/apqr'+(bust?('?_='+Date.now()):'');
}
/**
 * Polls /api/data until the dashboard AP reconnects after a local Send Frame
 * run, then clears the finishing state, resyncs injection/handshake status,
 * and feeds the response through processData. Reschedules itself on failure
 * while sfFinishing is still true.
 */
function pollSfReconnect(){
  if(!sfFinishing) return;
  fetchTimeout('/api/data').then(r=>{
    if(r.status===401){ sfFinishing=false; updateSfUI(0,0); showAuth(); return; }
    if(!r.ok) throw 0;
    return r.json().then(d=>{
      sfFinishing=false; updateSfUI(0,0); hideAuth();
      lastInject=(d.injact!=null)?{active:!!d.injact,sent:+d.injsent||0,ok:+d.injok||0}:null;
      syncSendFrameStatus(lastInject);
      checkSendFrameHandshake(document.getElementById('sendFrameModal')?.dataset.apmac);
      processData(d);
    });
  }).catch(()=>{ if(sfFinishing) setTimeout(pollSfReconnect,800); });
}
/**
 * Submits the Send Frame form to /api/security/inject/start. On a local
 * (no-scout) run, drives the countdown ring, AP-rejoin QR, and post-run
 * reconnect polling; on a scout-hosted run, just leaves Stop enabled.
 */
async function startSendFrame(){
  const m=document.getElementById('sendFrameModal'); if(!m)return;
  const st=document.getElementById('sfStatus');
  const startBtn=document.getElementById('sfStartBtn'), stopBtn=document.getElementById('sfStopBtn');
  if(sfSending||(startBtn&&startBtn.disabled))return;
  const secsEl=document.getElementById('sfSecs');
  const secsVal=secsEl?secsEl.value:15;
  const body='type='+document.getElementById('sfType').value+
    '&apmac='+encodeURIComponent(m.dataset.apmac)+
    '&targetmac='+encodeURIComponent(document.getElementById('sfTarget').value)+
    '&reason='+encodeURIComponent((()=>{const rs=document.getElementById('sfReasonSel');
      return (rs&&rs.style.display!=='none'&&rs.value!=='custom')?rs.value:document.getElementById('sfReason').value;})())+
    '&ssid='+encodeURIComponent(document.getElementById('sfSsid').value)+
    '&channel='+encodeURIComponent(m.dataset.apch)+
    '&interval='+encodeURIComponent(document.getElementById('sfInterval').value)+
    '&secs='+encodeURIComponent(secsVal);
  if(startBtn)startBtn.disabled=true;
  const hsEl0=document.getElementById('sfHsStatus'); if(hsEl0)hsEl0.innerHTML='';
  sfWasActive=false;
  try{
    const r=await fetch('/api/security/inject/start',{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
    const j=await r.json();
    if(!j.ok){
      if(st)st.textContent=(r.status===409)?'Radio busy (capture/send already running).':'Failed to start (bad target?).';
      if(startBtn)startBtn.disabled=false;
      return;
    }
    if(j.local){
      sfSending=true; sfFinishing=false;
      hideApLost();
      const secsNum=+j.secs||15;
      const total=secsNum+2;
      sfCrEnd=Date.now()+total*1000;
      const ct0=document.getElementById('sfCrTitle'); if(ct0)ct0.textContent='Send Frame in progress';
      const cp=document.getElementById('sfCrParams');
      if(cp)cp.innerHTML=`<span class="cr-tile on">${document.getElementById('sfType').selectedOptions[0].text}</span>`;
      const cs0=document.getElementById('sfCrSub'); if(cs0){cs0.style.display='none';cs0.innerHTML='';}
      const qw0=document.getElementById('sfQrWrap'); if(qw0)qw0.style.display='none';
      const qf0=document.getElementById('sfQrFrame'); if(qf0){qf0.classList.remove('revealed');clearTimeout(qrRevealTimers.sfQrFrame);}
      updateSfUI(secsNum,secsNum);
      armSfQr();
      prefetchApCreds();
      sfCrTimer=setInterval(()=>{
        const left=Math.ceil((sfCrEnd-Date.now())/1000);
        if(left>0){updateSfUI(Math.min(left,secsNum),secsNum);}
        else{
          clearInterval(sfCrTimer); sfCrTimer=null;
          sfSending=false; sfFinishing=true;
          const ct=document.getElementById('sfCrTitle'); if(ct)ct.textContent='Reconnecting…';
          const cs=document.getElementById('sfCrSub'); if(cs){cs.style.display='';cs.innerHTML=
            'Run ended -- waiting for this device to rejoin 802Eleven.<br>Scan or copy the code below if it doesn’t reconnect on its own.';}
          const qw=document.getElementById('sfQrWrap'); if(qw)qw.style.display='';
          const cq0=document.getElementById('sfQrImg');
          if(!(cq0&&cq0.complete&&cq0.naturalWidth>0)) armSfQr(true);
          updateSfUI(0,secsNum);
          pollSfReconnect();
        }
      },250);
    }else if(stopBtn) stopBtn.disabled=false;
  }catch(e){ if(st)st.textContent='Failed to start.'; if(startBtn)startBtn.disabled=false; return; }
}
/** Requests that the current Send Frame injection run stop; no-op while a local run's own countdown is still active. */
async function stopSendFrame(){
  if(sfSending)return;
  try{await fetch('/api/security/inject/stop',{method:'POST'});}catch(e){}
}
/**
 * Shows/hides the header's Send-Frame activity dot (#navSfDot).
 * @param inj Injection status object ({active,sent,ok}) or null.
 */
function syncNavSfDot(inj){
  const dot=document.getElementById('navSfDot'); if(!dot)return;
  dot.style.display=(inj&&inj.active)?'':'none';
}
/**
 * Syncs the Send Frame modal's status text and Start/Stop button state from
 * the server-reported injection status, and re-checks the handshake result
 * once a run transitions from active to inactive.
 * @param inj Injection status object ({active,sent,ok}) or null.
 */
function syncSendFrameStatus(inj){
  syncNavSfDot(inj);
  const st=document.getElementById('sfStatus'); if(!st)return;
  const startBtn=document.getElementById('sfStartBtn'), stopBtn=document.getElementById('sfStopBtn');
  if(sfSending)return;
  if(inj&&inj.active){
    st.textContent='Sending… '+inj.sent+' sent, '+inj.ok+' ok';
    if(startBtn)startBtn.disabled=true; if(stopBtn)stopBtn.disabled=false;
    sfWasActive=true;
  }else{
    st.textContent=(inj&&inj.sent>0)?('Finished: '+inj.sent+' sent, '+inj.ok+' ok.'):'Not running.';
    if(startBtn)startBtn.disabled=false; if(stopBtn)stopBtn.disabled=true;
    if(sfWasActive){ sfWasActive=false; checkSendFrameHandshake(document.getElementById('sendFrameModal')?.dataset.apmac); }
  }
}
let lastInject=null;
let fcSending=false, fcFinishing=false, fcCrEnd=0, fcCrTimer=null, fcWasActive=false, fcPresetIdx=-1;
/** Full 802.11 subtype tables (Mgmt/Ctrl/Data), same labels as the on-device
 * Creator's RawFrameBuilder.cpp (rfSubtypeLabel) -- kept in lockstep so a
 * frame built here reads identically to one built on the Cardputer/CYD. */
const FC_MGMT_SUB=['AssocReq','AssocResp','ReassocReq','ReassocResp','ProbeReq','ProbeResp',
  'TimingAdv','Reserved','Beacon','ATIM','Disassoc','Auth','Deauth','Action','ActionNoAck','Reserved'];
const FC_CTRL_SUB=['Reserved','Reserved','Trigger','TACK','BFRptPoll','NDPAnnounce','CtrlExt',
  'CtrlWrap','BlockAckReq','BlockAck','PS-Poll','RTS','CTS','ACK','CF-End','CF-End+Ack'];
const FC_DATA_SUB=['Data','Data+CFAck','Data+CFPoll','Data+CFAck+Poll','Null','CFAck','CFPoll',
  'CFAck+Poll','QoSData','QoSData+CFAck','QoSData+CFPoll','QoSData+CFAck+Poll','QoSNull','Reserved',
  'QoSCFPoll','QoSCFAck+Poll'];
function fcSubtypeLabels(cat){ return cat===0?FC_MGMT_SUB:cat===1?FC_CTRL_SUB:FC_DATA_SUB; }
function fcCategoryLabel(cat){ return cat===0?'Mgmt':cat===1?'Ctrl':'Data'; }
/** Whether the current category/subtype auto-builds its body from SSID + IE
 * toggles (Beacon/ProbeReq/ProbeResp) -- mirrors RawFrameBuilder::autoSsidMode. */
function fcIsAutoSsid(){
  const cat=+document.getElementById('fcCat').value, sub=+document.getElementById('fcSub').value;
  return cat===0&&(sub===4||sub===5||sub===8);
}
/** Per-IE state, indices matching RfLenId (0 SSID,1 Rates,2 DS Param,3 Country,4 ERP,5 HT Caps,6 Chan Sw) --
 * same 7 IEs + on/off/length-override/preset shape as the Cardputer/CYD Creator's RawFrameBuilder. */
const RFLEN_SSID=0, RFLEN_RATES=1, RFLEN_DS=2, RFLEN_COUNTRY=3, RFLEN_ERP=4, RFLEN_HT=5, RFLEN_CSA=6,
      RFLEN_EXT_RATES=7, RFLEN_TIM=8, RFLEN_HT_OP=9, RFLEN_PWR_CONSTRAINT=10, RFLEN_RSN=11, RFLEN_VENDOR=12,
      RFLEN_COUNT=13;
const RF_LEN_LABELS=['SSID','Rates','DS Param','Country','ERP Info','HT Caps','Chan Sw',
                     'Ext Rates','TIM','HT Oper','Pwr Constr','RSN','Vendor'];
let fcIeOn=[true,true,true,true,true,false,false,false,false,false,false,false,false];
let fcIeLenOv=[false,false,false,false,false,false,false,false,false,false,false,false,false];
let fcIeLenVal=[0,0,0,0,0,0,0,0,0,0,0,0,0];
let fcIeSel=['default','default','default','default','default','default','default','default','default','default','default','default','default'];
let fcIeCustomHex=['','','','','','','','','','','','',''];
let fcAddr3Touched=false;
/** Named preset payloads per RfLenId, same bytes as RawFrameBuilder::presetsForLen (SSID has none --
 * it's free text). */
const FC_IE_PRESETS=[
  null,
  [{label:'802.11b/g',hex:'82848b96243048'+'6c'},{label:'802.11b only',hex:'82848b96'},
   {label:'802.11g only',hex:'0c1218243048606c'}],
  [{label:'Channel 1',hex:'01'},{label:'Channel 6',hex:'06'},{label:'Channel 11',hex:'0b'}],
  [{label:'Generic (XX)',hex:'585820010d14'},{label:'United States',hex:'555320010b1e'},
   {label:'Europe',hex:'455520010d14'}],
  [{label:'None',hex:'00'},{label:'Non-ERP present',hex:'01'},{label:'Use protection',hex:'02'},
   {label:'Barker preamble',hex:'04'}],
  [{label:'Basic 1x1',hex:'2c0003ff'+'00'.repeat(22)},{label:'40MHz enabled',hex:'2e0003ff'+'00'.repeat(22)}],
  /* CSA: byte layout = switch mode (0x00=allow TX, 0x01=no TX), new channel, TBTT count */
  [{label:'To ch 1',hex:'000103'},{label:'To ch 6',hex:'000603'},{label:'To ch 11',hex:'000b03'},
   {label:'To ch 1 (no TX)',hex:'010103'}],
  /* Ext Rates (0x32) */
  [{label:'802.11g OFDM',hex:'0c121824304860'+'6c'},{label:'802.11n extra',hex:'606c8090a0'}],
  /* TIM (0x05) -- DTIM count/period/bitmap-ctrl/partial-map */
  [{label:'DTIM period 1',hex:'00010000'},{label:'DTIM period 2',hex:'00020000'}],
  /* HT Operation (0x3d) -- primary-ch + 4 bytes HT-info + 16 bytes MCS */
  [{label:'CH 1, MCS 0-7',hex:'01000000000'+'0ff'+'00'.repeat(15)},
   {label:'CH 6, MCS 0-7',hex:'06000000000'+'0ff'+'00'.repeat(15)},
   {label:'CH 11, MCS 0-7',hex:'0b000000000'+'0ff'+'00'.repeat(15)}],
  /* Power Constraint (0x20) */
  [{label:'0 dB reduction',hex:'00'},{label:'3 dB reduction',hex:'03'}],
  /* RSN (0x30) */
  [{label:'WPA2-PSK CCMP',   hex:'0100'+'000fac04'+'0100'+'000fac04'+'0100'+'000fac02'+'0c00'},
   {label:'WPA2-Enterprise', hex:'0100'+'000fac04'+'0100'+'000fac04'+'0100'+'000fac01'+'0c00'},
   {label:'WPA3-SAE',        hex:'0100'+'000fac04'+'0100'+'000fac04'+'0100'+'000fac08'+'c000'},
   {label:'WPA2-PSK TKIP',   hex:'0100'+'000fac02'+'0100'+'000fac02'+'0100'+'000fac02'+'0000'}],
  /* Vendor (0xdd) */
  [{label:'WPA1 TKIP-PSK',  hex:'0050f201'+'0100'+'0050f202'+'0100'+'0050f202'+'0100'+'0050f202'},
   {label:'WPA1 CCMP-PSK',  hex:'0050f201'+'0100'+'0050f204'+'0100'+'0050f204'+'0100'+'0050f202'},
   {label:'WPS indicator',  hex:'0050f204'+'104a0001'}],
];
/** Body presets for non-auto-SSID frame types (mirrors RawFrameBuilder::bodyPresetsFor).
 * Key: `${cat}_${sub}` -- each entry has label + hex string. */
const FC_BODY_PRESETS={
  '0_12':[
    {label:'Unspecified (1)',hex:'0100'},{label:'Prev auth invalid (2)',hex:'0200'},
    {label:'Deauth leaving (3)',hex:'0300'},{label:'Inactivity (4)',hex:'0400'},
    {label:'Class3 non-assoc (7)',hex:'0700'},{label:'Disassoc leaving (8)',hex:'0800'},
    {label:'EAPOL timeout (15)',hex:'0f00'},{label:'802.1X fail (23)',hex:'1700'},
  ],
  '0_10':[
    {label:'Unspecified (1)',hex:'0100'},{label:'Prev auth invalid (2)',hex:'0200'},
    {label:'Deauth leaving (3)',hex:'0300'},{label:'Inactivity (4)',hex:'0400'},
    {label:'Class3 non-assoc (7)',hex:'0700'},{label:'Disassoc leaving (8)',hex:'0800'},
    {label:'EAPOL timeout (15)',hex:'0f00'},{label:'802.1X fail (23)',hex:'1700'},
  ],
  '0_11':[
    {label:'Open-sys req (seq1)',hex:'000000000100'},{label:'Open-sys resp (seq2)',hex:'000000000200'},
    {label:'SAE commit (seq1)',hex:'030000000100'},{label:'SAE confirm (seq2)',hex:'030000000200'},
  ],
  '0_13':[
    {label:'CSA to ch 1', hex:'000400'+'01'+'03'},{label:'CSA to ch 6', hex:'000400'+'06'+'03'},
    {label:'CSA to ch 11',hex:'000400'+'0b'+'03'},{label:'Neighbor Rpt Req',hex:'05000100'},
    {label:'SA Query Req',hex:'08000100'},{label:'Add-BA Request',hex:'030001020000002800'},
  ],
  '0_0':[{label:'Basic cap (ESS)',hex:'11040a00'},{label:'HT cap flags',hex:'31040a00'}],
  '0_2':[{label:'Basic cap (ESS)',hex:'11040a00'},{label:'HT cap flags',hex:'31040a00'}],
};
/** Decodes a hex string (non-hex chars skipped) into a byte-value array -- mirrors rfHexDecode. */
function fcHexToBytes(hex){
  hex=(hex||'').replace(/[^0-9a-fA-F]/g,'');
  const out=[];
  for(let i=0;i+2<=hex.length;i+=2) out.push(parseInt(hex.substr(i,2),16));
  return out;
}
function fcBytesToHex(bytes){ return bytes.map(b=>(b&0xff).toString(16).padStart(2,'0')).join(''); }
/** Strips any non-hex char as the user types, keeping the cursor at the same offset in the cleaned string. */
function fcSanitizeBody(el){
  const clean=el.value.replace(/[^0-9a-fA-F]/g,'');
  if(clean===el.value) return;
  const pos=el.selectionStart-(el.value.slice(0,el.selectionStart).length-el.value.slice(0,el.selectionStart).replace(/[^0-9a-fA-F]/g,'').length);
  el.value=clean;
  el.setSelectionRange(pos,pos);
}
/** Populates (or hides) the body preset dropdown for the current cat/sub -- mirrors
 * RawFrameBuilder::bodyPresetsFor. Shows nothing when no presets exist for this frame type. */
function fcRenderBodyPresets(){
  const cat=+(document.getElementById('fcCat')||{value:0}).value||0;
  const sub=+(document.getElementById('fcSub')||{value:0}).value||0;
  const key=cat+'_'+sub;
  const presets=FC_BODY_PRESETS[key]||[];
  const wrap=document.getElementById('fcBodyPresets');
  const sel=document.getElementById('fcBodyPresetSel');
  if(!wrap||!sel)return;
  if(presets.length===0){wrap.style.display='none';return;}
  let html='<option value="">-- body preset --</option>';
  presets.forEach((p,i)=>{html+=`<option value="${i}">${esc(p.label)}</option>`;});
  sel.innerHTML=html;
  wrap.style.display='';
}
/** Copies the selected body preset's hex into #fcBody. */
function fcApplyBodyPreset(selEl){
  const cat=+(document.getElementById('fcCat')||{value:0}).value||0;
  const sub=+(document.getElementById('fcSub')||{value:0}).value||0;
  const key=cat+'_'+sub;
  const presets=FC_BODY_PRESETS[key]||[];
  const idx=+selEl.value;
  if(isNaN(idx)||idx<0||idx>=presets.length)return;
  const body=document.getElementById('fcBody');
  if(body){body.value=presets[idx].hex;fcRenderAnatomy();}
  selEl.value='';
}
/** Reads the chosen file's raw bytes and hex-encodes them into #fcBody, truncated to the 128-byte
 * RAW_FRAME_BODY_MAX (buildRawFrame's own cap) since the rest could never fit the built frame anyway. */
function fcLoadBodyFile(input){
  const f=input.files&&input.files[0]; if(!f)return;
  const reader=new FileReader();
  reader.onload=()=>{
    document.getElementById('fcBody').value=fcBytesToHex(Array.from(new Uint8Array(reader.result).slice(0,128)));
    input.value='';
    fcRenderAnatomy();
  };
  reader.readAsArrayBuffer(f);
}
/** Default (non-overridden) payload for RfLenId `id` -- mirrors RawFrameBuilder::ieActualData's
 * built-in defaults (DS Param tracks the current channel field live). */
function fcIeDefaultBytes(id){
  switch(id){
    case RFLEN_RATES: return [0x82,0x84,0x8b,0x96,0x24,0x30,0x48,0x6c];
    case RFLEN_DS: { const ch=Math.max(1,Math.min(13,+document.getElementById('fcChannel').value||1)); return [ch]; }
    case RFLEN_COUNTRY: return [0x58,0x58,0x20,0x01,0x0d,0x14];
    case RFLEN_ERP: return [0x00];
    case RFLEN_HT: { const a=new Array(26).fill(0); a[0]=0x2c; a[1]=0x00; a[2]=0x03; a[3]=0xff; return a; }
    case RFLEN_CSA: return [0x00,0x06,0x03];
    case RFLEN_EXT_RATES: return [0x0c,0x12,0x18,0x24,0x30,0x48,0x60,0x6c];
    case RFLEN_TIM: return [0x00,0x01,0x00,0x00];
    case RFLEN_HT_OP: { const a=new Array(22).fill(0); a[0]=1; a[6]=0xff; return a; }
    case RFLEN_PWR_CONSTRAINT: return [0x00];
    case RFLEN_RSN: return [0x01,0x00, 0x00,0x0f,0xac,0x04, 0x01,0x00, 0x00,0x0f,0xac,0x04,
                            0x01,0x00, 0x00,0x0f,0xac,0x02, 0x0c,0x00];
    case RFLEN_VENDOR: return [0x00,0x50,0xf2,0x01, 0x01,0x00, 0x00,0x50,0xf2,0x02,
                               0x01,0x00, 0x00,0x50,0xf2,0x02, 0x01,0x00, 0x00,0x50,0xf2,0x02];
    default: return [];
  }
}
/** Current payload bytes for RfLenId `id`, honouring the row's Default/preset/Custom-hex selection. */
function fcIeActualBytes(id){
  const sel=fcIeSel[id];
  if(sel==='custom') return fcHexToBytes(fcIeCustomHex[id]);
  if(sel==='default'||sel==null) return fcIeDefaultBytes(id);
  const presets=FC_IE_PRESETS[id], idx=+sel;
  return (presets&&presets[idx])?fcHexToBytes(presets[idx].hex):fcIeDefaultBytes(id);
}
/** True byte length of RfLenId `id`'s current data -- mirrors RawFrameBuilder::lenActual. */
function fcLenActual(id){
  if(id===RFLEN_SSID){ const s=document.getElementById('fcSsid'); return s?Math.min(32,s.value.length):0; }
  return fcIeActualBytes(id).length;
}
/** Declared length byte to write -- override value if set, else the true length. */
function fcLenDeclared(id){ return fcIeLenOv[id]?(fcIeLenVal[id]&0xff):fcLenActual(id); }
/** Appends one TLV IE (tag + declared-length byte + data, clamped to the 128-byte RAW_FRAME_BODY_MAX)
 * to `bytes` -- mirrors RawFrameBuilder::appendIe_. */
function fcAppendIe(bytes,tag,data,declaredLen,actualLen){
  if(bytes.length+2>128) return;
  let room=128-bytes.length-2;
  if(actualLen>room) actualLen=room;
  bytes.push(tag&0xff,declaredLen&0xff);
  for(let i=0;i<actualLen;i++) bytes.push(data[i]||0);
}
/** Builds the hex payload for a Beacon/ProbeReq/ProbeResp from the SSID field + IE toggle/override
 * state -- mirrors RawFrameBuilder::rebuildAutoBody, so the built frame matches what the Cardputer/CYD
 * Creator would send for the same settings. */
function fcBuildAutoBodyHex(){
  const sub=+document.getElementById('fcSub').value;
  const bytes=[];
  if(sub===8||sub===5){ for(let i=0;i<8;i++)bytes.push(0); bytes.push(0x64,0x00,0x01,0x00); }
  if(fcIeOn[RFLEN_SSID]){
    const s=(document.getElementById('fcSsid')||{}).value||'';
    const data=Array.from(s).slice(0,32).map(c=>c.charCodeAt(0)&0xff);
    fcAppendIe(bytes,0x00,data,fcLenDeclared(RFLEN_SSID),fcLenActual(RFLEN_SSID));
  }
  if(fcIeOn[RFLEN_RATES]) fcAppendIe(bytes,0x01,fcIeActualBytes(RFLEN_RATES),fcLenDeclared(RFLEN_RATES),fcLenActual(RFLEN_RATES));
  if(fcIeOn[RFLEN_DS]) fcAppendIe(bytes,0x03,fcIeActualBytes(RFLEN_DS),fcLenDeclared(RFLEN_DS),fcLenActual(RFLEN_DS));
  if(fcIeOn[RFLEN_TIM]&&sub===8) fcAppendIe(bytes,0x05,fcIeActualBytes(RFLEN_TIM),fcLenDeclared(RFLEN_TIM),fcLenActual(RFLEN_TIM));
  if(fcIeOn[RFLEN_COUNTRY]) fcAppendIe(bytes,0x07,fcIeActualBytes(RFLEN_COUNTRY),fcLenDeclared(RFLEN_COUNTRY),fcLenActual(RFLEN_COUNTRY));
  if(fcIeOn[RFLEN_PWR_CONSTRAINT]) fcAppendIe(bytes,0x20,fcIeActualBytes(RFLEN_PWR_CONSTRAINT),fcLenDeclared(RFLEN_PWR_CONSTRAINT),fcLenActual(RFLEN_PWR_CONSTRAINT));
  if(fcIeOn[RFLEN_CSA]) fcAppendIe(bytes,0x25,fcIeActualBytes(RFLEN_CSA),fcLenDeclared(RFLEN_CSA),fcLenActual(RFLEN_CSA));
  if(fcIeOn[RFLEN_ERP]) fcAppendIe(bytes,0x2a,fcIeActualBytes(RFLEN_ERP),fcLenDeclared(RFLEN_ERP),fcLenActual(RFLEN_ERP));
  if(fcIeOn[RFLEN_HT]) fcAppendIe(bytes,0x2d,fcIeActualBytes(RFLEN_HT),fcLenDeclared(RFLEN_HT),fcLenActual(RFLEN_HT));
  if(fcIeOn[RFLEN_RSN]) fcAppendIe(bytes,0x30,fcIeActualBytes(RFLEN_RSN),fcLenDeclared(RFLEN_RSN),fcLenActual(RFLEN_RSN));
  if(fcIeOn[RFLEN_EXT_RATES]) fcAppendIe(bytes,0x32,fcIeActualBytes(RFLEN_EXT_RATES),fcLenDeclared(RFLEN_EXT_RATES),fcLenActual(RFLEN_EXT_RATES));
  if(fcIeOn[RFLEN_HT_OP]) fcAppendIe(bytes,0x3d,fcIeActualBytes(RFLEN_HT_OP),fcLenDeclared(RFLEN_HT_OP),fcLenActual(RFLEN_HT_OP));
  if(fcIeOn[RFLEN_VENDOR]) fcAppendIe(bytes,0xdd,fcIeActualBytes(RFLEN_VENDOR),fcLenDeclared(RFLEN_VENDOR),fcLenActual(RFLEN_VENDOR));
  return fcBytesToHex(bytes);
}
/** Builds the SSID + IE toggle rows (#fcIeRows) once, on first use -- each row's on/off, Default/
 * preset/Custom-hex select, and declared-length override, matching the Cardputer/CYD IEs sub-screen. */
function renderFcIeRows(){
  const wrap=document.getElementById('fcIeRows'); if(!wrap||wrap.dataset.built)return;
  wrap.dataset.built='1';
  let html='';
  for(let id=0;id<RFLEN_COUNT;id++){
    const onDefault=fcIeOn[id];
    html+=`<div class="setrow fc-ie-row" data-id="${id}">
      <span class="k"><label><input type="checkbox" class="fc-ie-on" ${onDefault?'checked':''} onchange="fcIeOnChange(${id},this)">${esc(RF_LEN_LABELS[id])}</label></span>
      <span class="v">`;
    if(id===RFLEN_SSID){
      html+=`<input type="text" id="fcSsid" maxlength="32" placeholder="network name" oninput="fcSyncAddr3Default();fcRenderAnatomy()">`;
    }else{
      const presets=FC_IE_PRESETS[id]||[];
      html+=`<select class="fc-ie-preset" onchange="fcIePresetChange(${id},this)"><option value="default">Default</option>`+
        presets.map((p,i)=>`<option value="${i}">${esc(p.label)}</option>`).join('')+
        `<option value="custom">Custom hex...</option></select>`+
        `<input type="text" class="fc-ie-hex" placeholder="hex bytes" style="display:none;width:140px;font-family:monospace" oninput="fcIeCustomHex[${id}]=this.value;fcRenderAnatomy()">`;
    }
    html+=`<label class="fc-cap"><input type="checkbox" class="fc-ie-lenov" onchange="fcIeLenOvChange(${id},this)"> len override
        <input type="number" class="fc-ie-lenval" min="0" max="255" style="width:56px" disabled oninput="fcIeLenVal[${id}]=(+this.value)||0;fcRenderAnatomy()"></label>
      </span></div>`;
  }
  wrap.innerHTML=html;
}
function fcIeOnChange(id,cb){ fcIeOn[id]=cb.checked; fcRenderAnatomy(); }
function fcIePresetChange(id,sel){
  fcIeSel[id]=sel.value;
  const hexInput=sel.parentElement.querySelector('.fc-ie-hex');
  if(hexInput)hexInput.style.display=(sel.value==='custom')?'':'none';
  fcRenderAnatomy();
}
function fcIeLenOvChange(id,cb){
  fcIeLenOv[id]=cb.checked;
  const valInput=cb.parentElement.querySelector('.fc-ie-lenval');
  if(valInput)valInput.disabled=!cb.checked;
  fcRenderAnatomy();
}
/** Copies Addr2 into Addr3 while in auto-SSID mode and Addr3 hasn't been manually edited yet --
 * mirrors RawFrameBuilder::syncAddr3Default. */
function fcSyncAddr3Default(){
  if(fcIsAutoSsid()&&!fcAddr3Touched){
    const a2=document.getElementById('fcA2'), a3=document.getElementById('fcA3');
    if(a2&&a3)a3.value=a2.value;
  }
}
/**
 * Shows/hides Addr2-4, Sequence, QoS and the raw-Body/auto-SSID-IE panel to match the current
 * category/subtype/flags -- mirrors RawFrameBuilder::fieldVisible, so the web form only ever shows
 * fields relevant to the frame being built, same as the Cardputer/CYD Creator.
 */
function fcUpdateVisibility(){
  const cat=+document.getElementById('fcCat').value, sub=+document.getElementById('fcSub').value;
  const flag=name=>{ const b=document.querySelector('[data-flag="'+name+'"]'); return !!(b&&b.classList.contains('on')); };
  const tods=flag('fcToDs'), fromds=flag('fcFromDs');
  const mgmt=cat===0, ctrl=cat===1, data=cat===2;
  const ctrlNoAddr2=ctrl&&(sub===12||sub===13||sub===14||sub===15);
  const ctrlHasBody=ctrl&&(sub===8||sub===9);
  const qos=data&&!!(sub&0x8);
  const dataHasBody=data&&!(sub&0x4);
  const autoSsid=fcIsAutoSsid();
  const show=(id,v)=>{ const el=document.getElementById(id); if(el)el.style.display=v?'':'none'; };
  show('fcA2Field',mgmt||data||(ctrl&&!ctrlNoAddr2));
  show('fcA3Field',mgmt||data);
  show('fcA4Field',data&&tods&&fromds);
  show('fcSeqRow',mgmt||data);
  show('fcQosRow',qos);
  show('fcBodyRow',!autoSsid&&(mgmt||(data&&dataHasBody)||ctrlHasBody));
  show('fcIePanel',autoSsid);
  if(autoSsid)renderFcIeRows();
  if(!autoSsid)fcRenderBodyPresets();
  const fb=document.getElementById('fcFlagsByte');
  if(fb)fb.textContent='0x'+fcFlagsByteValue().toString(16).padStart(2,'0');
  fcRenderAnatomy();
}
/** Sums the Frame Control octet-2 value from the current #fcFlags bit buttons (data-bit gives each
 * one's position) -- same bit layout buildRawFrame writes, shown live next to the Flags heading. */
function fcFlagsByteValue(){
  let b=0;
  document.querySelectorAll('#fcFlags .fc-bit.on').forEach(el=>{ b|=1<<(+el.dataset.bit); });
  return b;
}
/** Parses "aa:bb:cc:dd:ee:ff" into a 6-byte array, or null if not a well-formed MAC (a blank or
 * partially-typed field just omits that address, same as the firmware's own length check). */
function fcParseMac(s){
  s=(s||'').trim();
  if(!/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(s))return null;
  return s.split(':').map(h=>parseInt(h,16));
}
/**
 * Assembles the exact byte sequence buildRawFrame() would produce for the current form state, in
 * real 802.11 general-frame-format order -- the single source of truth for both the anatomy strip
 * and the wire-preview hex dump, so the two views (and what Start actually transmits) can never
 * drift from each other.
 * @returns {bytes:number[], segs:{label,start,len,body?}[]}
 */
function fcBuildFrameBytes(){
  const val=id=>{ const e=document.getElementById(id); return e?e.value:''; };
  const cat=(+val('fcCat')||0)&3, sub=(+val('fcSub')||0)&0xF;
  const fc0=(cat<<2)|(sub<<4);
  let fc1=fcFlagsByteValue();
  const dur=Math.max(0,Math.min(65535,+val('fcDur')||0));
  const a1=fcParseMac(val('fcA1'))||[0xff,0xff,0xff,0xff,0xff,0xff];
  const a2=fcParseMac(val('fcA2')), a3=fcParseMac(val('fcA3')), a4=fcParseMac(val('fcA4'));
  const seqTxt=val('fcSeq').trim(), hasSeq=seqTxt!=='';
  const seq=hasSeq?Math.max(0,Math.min(4095,+seqTxt||0)):0;
  const qosTxt=val('fcQos').trim(), hasQos=qosTxt!=='';
  const qos=hasQos?Math.max(0,Math.min(65535,+qosTxt||0)):0;
  const bodyHex=fcIsAutoSsid()?fcBuildAutoBodyHex():val('fcBody').replace(/[^0-9a-fA-F]/g,'');
  const body=fcHexToBytes(bodyHex);
  const bytes=[fc0,fc1,dur&0xff,(dur>>8)&0xff,...a1];
  const segs=[{label:'FC',start:0,len:2},{label:'Dur',start:2,len:2},{label:'Addr1',start:4,len:6}];
  if(a2){ segs.push({label:'Addr2',start:bytes.length,len:6}); bytes.push(...a2); }
  if(a3){ segs.push({label:'Addr3',start:bytes.length,len:6}); bytes.push(...a3); }
  if(hasSeq){ const sc=(seq&0x0fff)<<4; segs.push({label:'Seq',start:bytes.length,len:2}); bytes.push(sc&0xff,(sc>>8)&0xff); }
  if(a4){ segs.push({label:'Addr4',start:bytes.length,len:6}); bytes.push(...a4); }
  if(hasQos){ segs.push({label:'QoS',start:bytes.length,len:2}); bytes.push(qos&0xff,(qos>>8)&0xff); }
  if(body.length){ segs.push({label:'Body',start:bytes.length,len:body.length,body:true}); bytes.push(...body); }
  return {bytes,segs};
}
/**
 * Renders the live frame-anatomy strip (#fcAnatomy, proportional segment widths) and the
 * #fcHexDump wire preview from the same fcBuildFrameBytes() result, so the operator sees both the
 * wire layout and the exact bytes update together as they edit, instead of trusting invisible
 * header math.
 */
function fcRenderAnatomy(){
  const el=document.getElementById('fcAnatomy'), meta=document.getElementById('fcAnatomyMeta');
  const {bytes,segs}=fcBuildFrameBytes();
  if(el){
    el.innerHTML=segs.map(s=>`<div class="fc-anatomy-seg${s.body?' body':''}" style="flex-grow:${Math.max(s.len,1)}" title="${esc(s.label)} -- ${s.len} byte${s.len===1?'':'s'}">${esc(s.label)}</div>`).join('');
  }
  if(meta)meta.textContent=bytes.length+' byte'+(bytes.length===1?'':'s')+' on the wire, '+segs.length+' field'+(segs.length===1?'':'s');
  fcRenderHexDump(bytes);
}
/** Renders a 16-bytes-per-row hex+ASCII dump of `bytes` into #fcHexDump, in the same dark terminal
 * style as the Scout Feed/Frame Dump viewers (--feed-* tokens) -- one visual vocabulary for "raw
 * bytes off the air" across the dashboard. */
function fcRenderHexDump(bytes){
  const el=document.getElementById('fcHexDump'); if(!el)return;
  if(!bytes.length){ el.innerHTML='<span class="hdempty">Nothing to send yet -- pick a destination address and a frame type above.</span>'; return; }
  let html='';
  for(let off=0;off<bytes.length;off+=16){
    const row=bytes.slice(off,off+16);
    const hex=row.map(b=>b.toString(16).padStart(2,'0')).join(' ');
    const asc=row.map(b=>(b>=0x20&&b<0x7f)?String.fromCharCode(b):'.').join('');
    html+=`<div class="hdrow"><span class="hdoff">${off.toString(16).padStart(4,'0')}</span><span class="hdhex">${hex}</span><span class="hdasc">${esc(asc)}</span></div>`;
  }
  el.innerHTML=html;
}
/**
 * Curated one-tap starting points for the most-used frame shapes -- picking
 * one sets category+subtype (the Advanced disclosure's raw fields) without
 * touching addresses/flags/body, which the operator usually wants to keep
 * across a few tries at the same target.
 */
const FC_PRESETS=[
  {label:'Deauth',cat:0,sub:12},{label:'Disassoc',cat:0,sub:10},
  {label:'Beacon',cat:0,sub:8},{label:'Probe req',cat:0,sub:4},
  {label:'Probe resp',cat:0,sub:5},{label:'Auth',cat:0,sub:11},
  {label:'Assoc req',cat:0,sub:0},{label:'RTS',cat:1,sub:11},
  {label:'CTS',cat:1,sub:12},{label:'QoS null',cat:2,sub:12},
  {label:'Data',cat:2,sub:0},
];
/** Builds the Frame type chip row (#fcPresets) from FC_PRESETS and syncs the initial highlight/hint. */
function renderFcPresets(){
  const wrap=document.getElementById('fcPresets'); if(!wrap)return;
  wrap.innerHTML=FC_PRESETS.map((p,i)=>`<button type="button" class="tgl" onclick="selectFcPreset(${i})">${esc(p.label)}</button>`).join('');
  syncFcPresetHighlight();
}
/** (Re)fills #fcSub with the full subtype table for the current category -- mirrors
 * RawFrameBuilder.cpp's MGMT_SUBTYPE/CTRL_SUBTYPE/DATA_SUBTYPE, keeping the prior selection when
 * it's still a valid index. */
function fcRenderSubtypes(){
  const cat=+document.getElementById('fcCat').value;
  const labels=fcSubtypeLabels(cat);
  const sel=document.getElementById('fcSub');
  const cur=+sel.value; const keep=(cur>=0&&cur<=15)?cur:0;
  sel.innerHTML=labels.map((l,i)=>`<option value="${i}">${i} -- ${esc(l)}</option>`).join('');
  sel.value=keep;
}
/** Applies FC_PRESETS[i]'s category/subtype to the Advanced fields and highlights its chip. @param i Index into FC_PRESETS. */
function selectFcPreset(i){
  const p=FC_PRESETS[i]; if(!p)return;
  document.getElementById('fcCat').value=p.cat;
  fcRenderSubtypes();
  document.getElementById('fcSub').value=p.sub;
  fcPresetIdx=i;
  syncFcPresetHighlight();
  fcSyncAddr3Default();
  fcUpdateVisibility();
}
/** Re-derives the active chip + subtype hint from the current raw category/subtype (called after a manual Advanced edit or a preset pick). */
function syncFcPresetHighlight(){
  const cat=+document.getElementById('fcCat').value, sub=+document.getElementById('fcSub').value;
  fcPresetIdx=FC_PRESETS.findIndex(p=>p.cat===cat&&p.sub===sub);
  document.querySelectorAll('#fcPresets .tgl').forEach((b,i)=>b.classList.toggle('on',i===fcPresetIdx));
  const hint=document.getElementById('fcTypeHint');
  if(hint)hint.textContent=fcCategoryLabel(cat)+' / '+fcSubtypeLabels(cat)[sub&0xF]+
    (fcIsAutoSsid()?' -- auto SSID/IE body builder below':'');
}
/** Handles a category change: repopulates the subtype list, then re-syncs chip/hint/Addr3/visibility. */
function onFcCatChange(){
  fcRenderSubtypes();
  syncFcPresetHighlight();
  fcSyncAddr3Default();
  fcUpdateVisibility();
}
/** Handles a manual edit of the Advanced subtype field: re-syncs the chip highlight/hint/Addr3/visibility. */
function onFcRawChange(){
  syncFcPresetHighlight();
  fcSyncAddr3Default();
  fcUpdateVisibility();
}
/** Flips one flag chip's on/off state. @param btn The clicked chip button (data-flag names the field). */
function toggleFcFlag(btn){ btn.classList.toggle('on'); fcUpdateVisibility(); }
fcRenderSubtypes();
document.getElementById('fcSub').value='12';
renderFcPresets();
fcUpdateVisibility();
/**
 * Updates the Frame Crafting countdown ring (#craftruns/#fcCrLeft/#fcCrArc) while a
 * send or its post-run reconnect wait is active.
 * @param left Seconds remaining.
 * @param total Total seconds the countdown started from (0 hides the arc fraction).
 */
function updateFcUI(left,total){
  const el=document.getElementById('craftruns'),
        num=document.getElementById('fcCrLeft'),
        arc=document.getElementById('fcCrArc');
  if(!el)return;
  if(fcSending||fcFinishing){
    el.classList.add('on');
    num.textContent=Math.max(0,left);
    const frac=total?Math.max(0,Math.min(1,left/total)):0;
    arc.style.strokeDashoffset=(CR_CIRC*(1-frac)).toFixed(1);
  }else{ el.classList.remove('on'); }
}
/**
 * Loads/reloads the AP-join QR image (#fcQrImg) shown during the post-send
 * reconnect wait, retrying on load failure while the run is still active.
 * @param bust Whether to append a cache-busting query param to the image URL.
 */
function armFcQr(bust){
  const cq=document.getElementById('fcQrImg'); if(!cq) return;
  cq.onerror=()=>{ if(fcSending||fcFinishing) setTimeout(()=>armFcQr(true),800); };
  cq.onload=()=>{ cq.onerror=null; };
  cq.src='/api/network/apqr'+(bust?('?_='+Date.now()):'');
}
/**
 * Polls /api/data until the dashboard AP reconnects after a local Frame
 * Crafting run, then clears the finishing state and resyncs status/data --
 * same shape as Send Frame's pollSfReconnect.
 */
function pollFcReconnect(){
  if(!fcFinishing) return;
  fetchTimeout('/api/data').then(r=>{
    if(r.status===401){ fcFinishing=false; updateFcUI(0,0); showAuth(); return; }
    if(!r.ok) throw 0;
    return r.json().then(d=>{
      fcFinishing=false; updateFcUI(0,0); hideAuth();
      lastInject=(d.injact!=null)?{active:!!d.injact,sent:+d.injsent||0,ok:+d.injok||0}:null;
      syncFrameCraftStatus(lastInject);
      processData(d);
    });
  }).catch(()=>{ if(fcFinishing) setTimeout(pollFcReconnect,800); });
}
/**
 * Submits the Frame Crafting form to /api/security/inject/raw/start. On a
 * local (no-scout) run, drives the countdown ring, AP-rejoin QR, and
 * post-run reconnect polling -- same flow as Send Frame's startSendFrame;
 * on a scout-hosted run, just leaves Stop enabled.
 */
/**
 * Sets the Frame Crafting status pill's (#fcStatusPill) up/down state and label.
 * @param up Whether a run is currently active.
 * @param label Pill text.
 */
function fcSetPill(up,label){
  const p=document.getElementById('fcStatusPill'); if(!p)return;
  p.innerHTML=`<span class="statuspill ${up?'up':'down'}"><span class="dot"></span>${esc(label)}</span>`;
}
/** Sets the Frame Crafting tally tile (#fcTally). @param sent Frames sent. @param ok Frames the radio confirmed as transmitted. */
function fcSetTally(sent,ok){ const t=document.getElementById('fcTally'); if(t)t.textContent=(sent||0)+' / '+(ok||0); }
/** Play/Stop toggle for #fcGoBtn -- mirrors localApToggle. */
function toggleFrameCraft(){
  const go=document.getElementById('fcGoBtn');
  if(go&&go.classList.contains('on'))stopFrameCraft(); else startFrameCraft();
}
/**
 * Submits the Frame Crafting form to /api/security/inject/raw/start. On a
 * local (no-scout) run, drives the countdown ring, AP-rejoin QR, and
 * post-run reconnect polling -- same flow as Send Frame's startSendFrame;
 * on a scout-hosted run, just leaves the toggle armed (Stop).
 */
async function startFrameCraft(){
  const st=document.getElementById('fcStatus');
  const goBtn=document.getElementById('fcGoBtn');
  if(fcSending||(goBtn&&goBtn.disabled))return;
  const flag=name=>{ const b=document.querySelector('[data-flag="'+name+'"]'); return (b&&b.classList.contains('on'))?'1':'0'; };
  const secsEl=document.getElementById('fcSecs');
  const secsVal=secsEl?secsEl.value:15;
  const body='cat='+document.getElementById('fcCat').value+
    '&sub='+document.getElementById('fcSub').value+
    '&tods='+flag('fcToDs')+'&fromds='+flag('fcFromDs')+'&mfrag='+flag('fcMFrag')+
    '&retry='+flag('fcRetry')+'&pwr='+flag('fcPwr')+'&mdata='+flag('fcMData')+
    '&prot='+flag('fcProt')+'&order='+flag('fcOrder')+
    '&dur='+encodeURIComponent(document.getElementById('fcDur').value)+
    '&a1='+encodeURIComponent(document.getElementById('fcA1').value)+
    '&a2='+encodeURIComponent(document.getElementById('fcA2').value)+
    '&a3='+encodeURIComponent(document.getElementById('fcA3').value)+
    '&a4='+encodeURIComponent(document.getElementById('fcA4').value)+
    '&seq='+encodeURIComponent(document.getElementById('fcSeq').value)+
    '&qos='+encodeURIComponent(document.getElementById('fcQos').value)+
    '&bodyhex='+encodeURIComponent(fcIsAutoSsid()?fcBuildAutoBodyHex():document.getElementById('fcBody').value.replace(/[^0-9a-fA-F]/g,''))+
    '&channel='+encodeURIComponent(document.getElementById('fcChannel').value)+
    '&interval='+encodeURIComponent(document.getElementById('fcInterval').value)+
    '&secs='+encodeURIComponent(secsVal);
  if(goBtn)goBtn.disabled=true;
  fcWasActive=false;
  try{
    const r=await fetch('/api/security/inject/raw/start',{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
    const j=await r.json();
    if(!j.ok){
      if(st)st.textContent=(r.status===409)?'Radio busy (capture/send already running).':'Failed to start (bad frame?).';
      if(goBtn)goBtn.disabled=false;
      return;
    }
    if(j.local){
      fcSending=true; fcFinishing=false;
      if(goBtn){goBtn.disabled=false; goBtn.classList.add('on'); goBtn.title='Stop Frame Crafting';}
      fcSetPill(true,'Sending');
      hideApLost();
      const secsNum=+j.secs||15;
      const total=secsNum+2;
      fcCrEnd=Date.now()+total*1000;
      const ct0=document.getElementById('fcCrTitle'); if(ct0)ct0.textContent='Frame Crafting in progress';
      const cp=document.getElementById('fcCrParams');
      const label=(FC_PRESETS[fcPresetIdx]&&FC_PRESETS[fcPresetIdx].label)||('cat '+document.getElementById('fcCat').value+' / sub '+document.getElementById('fcSub').value);
      if(cp)cp.innerHTML=`<span class="cr-tile on">${esc(label)}</span>`;
      const cs0=document.getElementById('fcCrSub'); if(cs0){cs0.style.display='none';cs0.innerHTML='';}
      const qw0=document.getElementById('fcQrWrap'); if(qw0)qw0.style.display='none';
      const qf0=document.getElementById('fcQrFrame'); if(qf0){qf0.classList.remove('revealed');clearTimeout(qrRevealTimers.fcQrFrame);}
      updateFcUI(secsNum,secsNum);
      armFcQr();
      prefetchApCreds();
      fcCrTimer=setInterval(()=>{
        const left=Math.ceil((fcCrEnd-Date.now())/1000);
        if(left>0){updateFcUI(Math.min(left,secsNum),secsNum);}
        else{
          clearInterval(fcCrTimer); fcCrTimer=null;
          fcSending=false; fcFinishing=true;
          fcSetPill(true,'Reconnecting…');
          const ct=document.getElementById('fcCrTitle'); if(ct)ct.textContent='Reconnecting…';
          const cs=document.getElementById('fcCrSub'); if(cs){cs.style.display='';cs.innerHTML=
            'Run ended -- waiting for this device to rejoin 802Eleven.<br>Scan or copy the code below if it doesn’t reconnect on its own.';}
          const qw=document.getElementById('fcQrWrap'); if(qw)qw.style.display='';
          const cq0=document.getElementById('fcQrImg');
          if(!(cq0&&cq0.complete&&cq0.naturalWidth>0)) armFcQr(true);
          updateFcUI(0,secsNum);
          pollFcReconnect();
        }
      },250);
    }else{
      if(goBtn){goBtn.disabled=false; goBtn.classList.add('on'); goBtn.title='Stop Frame Crafting';}
      fcSetPill(true,'Sending (scout)');
    }
  }catch(e){ if(st)st.textContent='Failed to start.'; if(goBtn)goBtn.disabled=false; return; }
}
/** Requests that the current Frame Crafting injection run stop; no-op while a local run's own countdown is still active. */
async function stopFrameCraft(){
  if(fcSending)return;
  try{await fetch('/api/security/inject/stop',{method:'POST'});}catch(e){}
}
/**
 * Syncs the Frame Crafting view's status pill/tally and #fcGoBtn state from
 * the server-reported injection status -- shares the same lastInject state
 * as Send Frame (the two runs are mutually exclusive on the radio).
 * @param inj Injection status object ({active,sent,ok}) or null.
 */
function syncFrameCraftStatus(inj){
  const st=document.getElementById('fcStatus'); if(!st)return;
  const goBtn=document.getElementById('fcGoBtn');
  fcSetTally(inj&&inj.sent, inj&&inj.ok);
  if(fcSending)return;
  if(inj&&inj.active){
    st.textContent='Sending… '+inj.sent+' sent, '+inj.ok+' ok';
    fcSetPill(true,'Sending');
    if(goBtn){goBtn.disabled=false; goBtn.classList.add('on'); goBtn.title='Stop Frame Crafting';}
    fcWasActive=true;
  }else{
    st.textContent=(inj&&inj.sent>0)?('Finished: '+inj.sent+' sent, '+inj.ok+' ok.'):'Pick a frame type, addresses and a channel, then run.';
    fcSetPill(false,'Idle');
    if(goBtn){goBtn.disabled=false; goBtn.classList.remove('on'); goBtn.title='Start Frame Crafting';}
    fcWasActive=false;
  }
}
/* @ENDGUARD */
/**
 * Toggles a button's 'on' class to reflect a server-reported boolean state,
 * skipped while the button has a pending optimistic update (data-busy set).
 * @param id Element id of the button.
 * @param on Truthy/falsy state to apply.
 */
function syncBtn(id,on){ const b=document.getElementById(id);
  if(b&&!b.dataset.busy) b.classList.toggle('on',!!(+on)); }
/** Syncs the local capture DATA-frame toggle button (#capDataBtn) from a server value. @param v Server-reported state, or null/undefined to skip. */
function syncCapData(v){ if(v!=null)syncBtn('capDataBtn',v); }
/** Syncs the scout DATA-frame toggle button (#scoutDataBtn) from a server value. @param v Server-reported state, or null/undefined to skip. */
function syncScoutData(v){ if(v!=null)syncBtn('scoutDataBtn',v); }
/** Syncs the client-aggregate toggle button (#clientAggBtn) from a server value. @param v Server-reported state, or null/undefined to skip. */
function syncClientAgg(v){ if(v!=null)syncBtn('clientAggBtn',v); }
/**
 * Syncs the TTL-minutes input (#ttlMin) from a server value, skipped while
 * the input has a pending edit (data-busy set).
 * @param v Server-reported TTL in minutes, or null/undefined to skip.
 */
function syncTtl(v){ if(v==null)return; const el=document.getElementById('ttlMin');
  if(el && !el.dataset.busy) el.value=v; }
/**
 * Syncs the poll-interval input (#pollms) and its label from a server value
 * and updates the global pollMs used by the polling loop.
 * @param v Server-reported poll interval in ms; defaults to 1000 if falsy.
 */
function syncPollMs(v){ if(v==null)return; v=+v||1000;
  const el=document.getElementById('pollms');
  if(el && !el.dataset.busy){ el.value=v; const l=document.getElementById('pollmsL'); if(l)l.textContent=v; }
  pollMs=v;
}
/**
 * Optimistically flips a boolean capture-option button and posts the new
 * value to /api/wifi/opts.
 * @param id Element id of the toggle button.
 * @param param Query/body parameter name to send (0/1).
 */
async function toggleDataOpt(id,param){
  const b=document.getElementById(id); if(!b)return;
  const on=!b.classList.contains('on'); b.classList.toggle('on',on); b.dataset.busy='1';
  try{await fetch('/api/wifi/opts',{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},body:param+'='+(on?1:0)});}catch(e){} delete b.dataset.busy;
}
/** Flips the local capture DATA-frame toggle button's (#capDataBtn) visual state without persisting it. */
function toggleCapData(){ const b=document.getElementById('capDataBtn'); if(!b)return;
  b.classList.toggle('on'); }
/**
 * Flips a band-specific capture-pause toggle button's visual state without persisting it.
 * @param band '5' for the 5GHz pause button, else the 2.4GHz one.
 */
function toggleCapBandPause(band){
  const b=document.getElementById(band==='5'?'capPause5Btn':'capPause24Btn'); if(!b)return;
  b.classList.toggle('on');
}
/** Syncs the 2.4GHz capture-pause button (#capPause24Btn), inverted since the button shows "active" not "paused". @param paused Server-reported paused state, or null/undefined to skip. */
function syncCapBandPause24(paused){ if(paused!=null)syncBtn('capPause24Btn',!paused); }
/** Syncs the 5GHz capture-pause button (#capPause5Btn), inverted since the button shows "active" not "paused". @param paused Server-reported paused state, or null/undefined to skip. */
function syncCapBandPause5(paused){ if(paused!=null)syncBtn('capPause5Btn',!paused); }
/** Optimistically flips the captive-portal toggle button (#captiveBtn) and posts the new state to /api/captive. */
async function toggleCaptivePortal(){
  const b=document.getElementById('captiveBtn'); if(!b)return;
  const on=!b.classList.contains('on'); b.classList.toggle('on',on); b.dataset.busy='1';
  try{await fetch('/api/captive',{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'on='+(on?1:0)});}catch(e){} delete b.dataset.busy;
}
/** Optimistically flips the onboard LED toggle button (#ledBtn) and posts the new state to /api/prefs/led. */
async function toggleLed(){
  const b=document.getElementById('ledBtn'); if(!b)return;
  const on=!b.classList.contains('on'); b.classList.toggle('on',on); b.setAttribute('aria-pressed',on); b.dataset.busy='1';
  try{await fetch('/api/prefs/led?on='+(on?1:0),{method:'POST'});}catch(e){} delete b.dataset.busy;
}
/** Posts the selected display orientation (#orientSel) to /api/prefs/orient. @param o Orientation value from the select element. */
async function setOrientation(o){
  const s=document.getElementById('orientSel'); if(!s)return;
  s.dataset.busy='1';
  try{await fetch('/api/prefs/orient?o='+(+o|0),{method:'POST'});}catch(e){} delete s.dataset.busy;
}
/** Flips the memory-view toggle (#memBtn), posts it to /api/prefs/memscreen, and enables/disables the Memory option in #idleViewSel. */
async function toggleMemScreen(){
  const b=document.getElementById('memBtn'); if(!b)return;
  const on=!b.classList.contains('on'); b.classList.toggle('on',on); b.setAttribute('aria-pressed',on); b.dataset.busy='1';
  const o=document.getElementById('memIdleOpt'); if(o)o.disabled=!on;
  try{await fetch('/api/prefs/memscreen?on='+(on?1:0),{method:'POST'});}catch(e){} delete b.dataset.busy;
}
/** Flips the Standalone-mode heartbeat screen's new-SSID/probe flash toast toggle (#flashNewBtn) and posts it to /api/prefs/flashnew. */
async function toggleFlashNew(){
  const b=document.getElementById('flashNewBtn'); if(!b)return;
  const on=!b.classList.contains('on'); b.classList.toggle('on',on); b.setAttribute('aria-pressed',on); b.dataset.busy='1';
  try{await fetch('/api/prefs/flashnew?on='+(on?1:0),{method:'POST'});}catch(e){} delete b.dataset.busy;
}
/** Posts the selected idle-screen view (#idleViewSel) to /api/prefs/idleview. @param v Idle-view value from the select element. */
async function setIdleView(v){
  const s=document.getElementById('idleViewSel'); if(!s)return;
  s.dataset.busy='1';
  try{await fetch('/api/prefs/idleview?v='+(+v|0),{method:'POST'});}catch(e){} delete s.dataset.busy;
}
/** Flips the idle-view lock toggle (#idleLockBtn) and posts it to /api/prefs/idlelock. Locked pins
 * the BOOT button to whichever idle view #idleViewSel currently names (short-press no longer
 * cycles) -- picking Faux USB and locking it is the old dedicated "USB Connected" screen mode. */
async function toggleIdleLock(){
  const b=document.getElementById('idleLockBtn'); if(!b)return;
  const on=!b.classList.contains('on'); b.classList.toggle('on',on); b.dataset.busy='1';
  try{await fetch('/api/prefs/idlelock?on='+(on?1:0),{method:'POST'});}catch(e){} delete b.dataset.busy;
}
/** Posts the selected LCD theme (#themeSel) to /api/prefs/theme. @param v Theme index from the select element. */
async function setTheme(v){
  const s=document.getElementById('themeSel'); if(!s)return;
  s.dataset.busy='1';
  try{await fetch('/api/prefs/theme?v='+(+v|0),{method:'POST'});}catch(e){} delete s.dataset.busy;
}
/** Posts the selected BOOT long-press action (#longPressSel) to /api/prefs/longpress. @param v 0=Standalone, 1=Sentinel. */
async function setLongPress(v){
  const s=document.getElementById('longPressSel'); if(!s)return;
  s.dataset.busy='1';
  try{await fetch('/api/prefs/longpress?v='+(+v|0),{method:'POST'});}catch(e){} delete s.dataset.busy;
}
/** Posts the selected auto-off timeout (#autoOffSel) to /api/prefs/autooff. @param min Timeout in minutes from the select element. */
async function setAutoOff(min){
  const s=document.getElementById('autoOffSel'); if(!s)return;
  s.dataset.busy='1';
  try{await fetch('/api/prefs/autooff?min='+(+min|0),{method:'POST'});}catch(e){} delete s.dataset.busy;
}
/** Updates the brightness slider's live percentage readout (#dimVal) without posting anything --
 * called on every drag frame (oninput); setDim() below posts once the slider is released. */
function dimLive(pct){ const el=document.getElementById('dimVal'); if(el)el.textContent=(+pct|0)+'%'; }
/** Posts the selected screen dim percentage (#dimSel) to /api/prefs/dim. @param pct Dim percentage from the slider. */
async function setDim(pct){
  const s=document.getElementById('dimSel'); if(!s)return;
  s.dataset.busy='1';
  try{await fetch('/api/prefs/dim?pct='+(+pct|0),{method:'POST'});}catch(e){} delete s.dataset.busy;
}
/* @GUARD:IF WITH_SENTINEL */
const BOOT_MASK_BITS={bootMaskDeauth:1,bootMaskKarma:2,bootMaskRogue:4};
/**
 * Computes the boot-sentinel watch mask from the on/off state of the
 * bootMaskDeauth/bootMaskKarma/bootMaskRogue toggle buttons.
 * @returns Bitmask OR of BOOT_MASK_BITS for every button currently 'on'.
 */
function bootMaskValue(){ let m=0; for(const id in BOOT_MASK_BITS){
  const b=document.getElementById(id); if(b&&b.classList.contains('on'))m|=BOOT_MASK_BITS[id]; } return m; }
/** Posts the selected boot-sentinel mode (#bootModeSel) to /api/prefs/bootsentinel. */
async function setBootSentinel(){
  const s=document.getElementById('bootModeSel'); if(!s)return;
  s.dataset.busy='1';
  try{await fetch('/api/prefs/bootsentinel?mode='+(+s.value|0),{method:'POST'});}catch(e){} delete s.dataset.busy;
}
/**
 * Flips one boot-sentinel watch toggle and posts the recomputed mask
 * (bootMaskValue) to /api/prefs/bootsentinel.
 * @param id Element id of the watch toggle button (bootMaskDeauth/Karma/Rogue).
 */
async function toggleBootMask(id){
  const b=document.getElementById(id); if(!b)return;
  b.classList.toggle('on'); b.dataset.busy='1';
  try{await fetch('/api/prefs/bootsentinel?mask='+bootMaskValue(),{method:'POST'});}catch(e){} delete b.dataset.busy;
}
/**
 * Sentinel's own channel-chip state, independent of the capture/scout chip pickers above --
 * sentChanMask (2.4GHz, channels 1-13) + sentChanMask5 (index bitmask into WIFI_5G_CH), both
 * 0 = Auto/hop-all. Persisted via /api/prefs/bootsentinel (chan=/chan5=).
 */
let sentChanMask=0, sentChanMask5=0, sentChanBand='24', sentDualBand=false, sentChanOpen=false;
/** Counts set bits in a bitmask (small masks only -- channel/index sets, never more than ~25 bits). */
function popcount(m){let c=0; while(m){c+=m&1; m>>>=1;} return c;}
/** Short summary text for the Channel row's button: "Auto", "Ch N", or "N channels". */
function sentChanSummaryText(){
  const n24=popcount(sentChanMask), n5=popcount(sentChanMask5), n=n24+n5;
  if(!n)return 'Auto';
  if(n===1){
    if(n24)for(let c=1;c<=13;c++)if(sentChanMask&(1<<c))return 'Ch '+c;
    for(let i=0;i<WIFI_5G_CH.length;i++)if(sentChanMask5&(1<<i))return 'Ch '+WIFI_5G_CH[i];
  }
  return n+' channels';
}
/** Refreshes the Channel row's summary button text from the current masks. */
function paintSentChanSummary(){
  const b=document.getElementById('sentChanSummary'); if(b)b.textContent=sentChanSummaryText();
}
/** Opens/closes the expandable multi-channel chip picker under the Channel row. */
function toggleSentChanExpand(){
  sentChanOpen=!sentChanOpen;
  const el=document.getElementById('sentChanExpand'); if(el)el.style.display=sentChanOpen?'':'none';
}
/** (Re)builds the Auto + channel 1-13 chip buttons for Sentinel's 2.4GHz picker and paints them. */
function renderSentChips(){
  const box=document.getElementById('sentChanChips'); if(!box)return;
  let h='<button class="auto" data-ch="0" onclick="sentChanAuto()">Auto</button>';
  for(let c=1;c<=13;c++)h+='<button data-ch="'+c+'" onclick="sentChanTap('+c+')">'+c+'</button>';
  box.innerHTML=h; paintSentChips();
}
/** Updates Sentinel's 2.4GHz chip buttons' 'on' state to reflect sentChanMask. */
function paintSentChips(){
  const box=document.getElementById('sentChanChips'); if(!box)return;
  const mask=sentChanMask, auto=!mask;
  box.querySelectorAll('button').forEach(b=>{
    const c=+b.dataset.ch;
    b.classList.toggle('on', c===0?auto:(!auto&&!!(mask&(1<<c))));
  });
}
/** (Re)builds the Auto + one-per-WIFI_5G_CH chip buttons for Sentinel's 5GHz picker and paints them. */
function renderSentChips5(){
  const box=document.getElementById('sentChan5Chips'); if(!box)return;
  let h='<button class="auto" data-ci="0" onclick="sentChan5Auto()">Auto</button>';
  WIFI_5G_CH.forEach((ch,i)=>{ h+='<button data-ci="'+i+'" onclick="sentChan5Tap('+i+')">'+ch+'</button>'; });
  box.innerHTML=h; paintSentChips5();
}
/** Updates Sentinel's 5GHz chip buttons' 'on' state to reflect sentChanMask5. */
function paintSentChips5(){
  const box=document.getElementById('sentChan5Chips'); if(!box)return;
  const mask=sentChanMask5, auto=!mask;
  box.querySelectorAll('button').forEach(b=>{
    const i=+b.dataset.ci, isAuto=b.classList.contains('auto');
    b.classList.toggle('on', isAuto?auto:(!auto&&!!(mask&(1<<i))));
  });
}
/** Persists the current sentChanMask/sentChanMask5 pair to /api/prefs/bootsentinel. */
async function saveSentChan(){
  try{await fetch('/api/prefs/bootsentinel?chan='+sentChanMask+'&chan5='+sentChanMask5,{method:'POST'});}catch(e){}
}
function sentChanAuto(){ sentChanMask=0; paintSentChips(); paintSentChanSummary(); saveSentChan(); }
function sentChanTap(c){ sentChanMask^=(1<<c); paintSentChips(); paintSentChanSummary(); saveSentChan(); }
function sentChan5Auto(){ sentChanMask5=0; paintSentChips5(); paintSentChanSummary(); saveSentChan(); }
function sentChan5Tap(i){ sentChanMask5^=(1<<i); paintSentChips5(); paintSentChanSummary(); saveSentChan(); }
/** Switches Sentinel's visible channel-chip band (2.4GHz vs 5GHz). No-op if already shown. */
function setSentChipBand(b){
  if(b===sentChanBand)return;
  sentChanBand=b;
  document.getElementById('sentCbtab24').classList.toggle('on',b==='24');
  document.getElementById('sentCbtab5').classList.toggle('on',b==='5');
  document.getElementById('sentChanChips').style.display=b==='24'?'':'none';
  document.getElementById('sentChan5Chips').style.display=b==='5'?'':'none';
}
/** Shows/hides Sentinel's 5GHz band tab based on whether this board is a WIFI_BAND_DUAL build. */
function syncSentDualBand(dualband){
  dualband=!!dualband;
  if(dualband===sentDualBand)return;
  sentDualBand=dualband;
  const tabs=document.getElementById('sentChanBandTabs'); if(tabs)tabs.style.display=dualband?'':'none';
  if(dualband)renderSentChips5();
  if(!dualband&&sentChanBand==='5')setSentChipBand('24');
}
const ROGUE_CAT_BITS={rogueCatEspressif:1,rogueCatAdapter:2,rogueCatPi:4,rogueCatSpoofed:8,rogueCatCustom:16};
/**
 * Computes the rogue-AP category mask from the on/off state of the
 * rogueCat* toggle buttons.
 * @returns Bitmask OR of ROGUE_CAT_BITS for every button currently 'on'.
 */
function rogueCatValue(){ let m=0; for(const id in ROGUE_CAT_BITS){
  const b=document.getElementById(id); if(b&&b.classList.contains('on'))m|=ROGUE_CAT_BITS[id]; } return m; }
/**
 * Flips one rogue-AP category toggle and posts the recomputed mask
 * (rogueCatValue) to /api/prefs/roguecat.
 * @param id Element id of the rogue-category toggle button.
 */
async function toggleRogueCat(id){
  const b=document.getElementById(id); if(!b)return;
  b.classList.toggle('on'); b.dataset.busy='1';
  try{await fetch('/api/prefs/roguecat?mask='+rogueCatValue(),{method:'POST'});}catch(e){} delete b.dataset.busy;
}
/**
 * Validates that at least one boot-sentinel watch is selected, then opens a
 * confirmation prompt warning that starting Sentinel drops the dashboard AP,
 * before calling doSentinelStart.
 */
function requestSentinelStart(){
  const mask=bootMaskValue();
  if(!mask){ hsToast('Pick at least one watch (Deauth/Karma/Rogue) first.'); return; }
  openConfirm('Start Sentinel now? The dashboard Wi-Fi (802Eleven AP) will drop immediately and stay '+
    'down for the whole session -- press the BOOT button once, or "sentinel stop" over serial, to get it back.',
    'Start now',doSentinelStart);
}
/** Posts the confirmed boot-sentinel start (watch mask + selected channel set(s)) to /api/sentinel/start. */
async function doSentinelStart(){
  try{await fetch('/api/sentinel/start',{method:'POST',
    body:'mask='+bootMaskValue()+'&chan='+sentChanMask+'&chan5='+sentChanMask5});}catch(e){}
}
/* @ENDGUARD */
/**
 * Fetches /api/sysinfo and syncs the device-preference controls (LED,
 * orientation/idle-view/auto-off/dim selects, memory-screen, idle-view lock, and
 * new-SSID/probe-flash toggles, and on a
 * WITH_SENTINEL build the boot-sentinel mode/mask/channel and rogue
 * category toggles) from the response, skipping any control with a pending
 * edit (data-busy set).
 */
async function loadDongleInfo(){
  try{const d=await(await fetch('/api/sysinfo')).json();
    const lb=document.getElementById('ledBtn');
    if(lb&&!lb.dataset.busy){const on=!!d.led; lb.classList.toggle('on',on); lb.setAttribute('aria-pressed',on);}
    const o=document.getElementById('orientSel');
    if(o&&!o.dataset.busy&&d.orient!=null)o.value=d.orient;
    const mb=document.getElementById('memBtn');
    if(mb&&!mb.dataset.busy){const on=!!d.memscreen; mb.classList.toggle('on',on); mb.setAttribute('aria-pressed',on); const mo=document.getElementById('memIdleOpt'); if(mo)mo.disabled=!on;}
    const fnb=document.getElementById('flashNewBtn');
    if(fnb&&!fnb.dataset.busy){const on=!!d.flashnew; fnb.classList.toggle('on',on); fnb.setAttribute('aria-pressed',on);}
    const iv=document.getElementById('idleViewSel');
    if(iv&&!iv.dataset.busy&&d.idleview!=null)iv.value=d.idleview;
    const ilb=document.getElementById('idleLockBtn');
    if(ilb&&!ilb.dataset.busy)ilb.classList.toggle('on',!!d.idlelock);
    const lp=document.getElementById('longPressSel');
    if(lp&&!lp.dataset.busy&&d.longpress!=null)lp.value=d.longpress;
    const th=document.getElementById('themeSel');
    if(th&&!th.dataset.busy&&d.theme!=null)th.value=d.theme;
    const ao=document.getElementById('autoOffSel');
    if(ao&&!ao.dataset.busy&&d.autooff!=null)ao.value=d.autooff;
    const dm=document.getElementById('dimSel');
    if(dm&&!dm.dataset.busy&&d.dim!=null){dm.value=d.dim; dimLive(d.dim);}
/* @GUARD:IF WITH_SENTINEL */
    const bm=document.getElementById('bootModeSel');
    if(bm&&!bm.dataset.busy&&d.bootmode!=null)bm.value=d.bootmode;
    if(d.bootmask!=null) for(const id in BOOT_MASK_BITS){
      const b=document.getElementById(id); if(b&&!b.dataset.busy)
        b.classList.toggle('on',(d.bootmask&BOOT_MASK_BITS[id])!=0); }
    if(typeof syncSentDualBand==='function')syncSentDualBand(d.dualband);
    if(d.bootchan!=null){ sentChanMask=d.bootchan|0; paintSentChips(); }
    if(d.bootchan5!=null){ sentChanMask5=d.bootchan5|0; paintSentChips5(); }
    paintSentChanSummary();
    if(d.roguecat!=null) for(const id in ROGUE_CAT_BITS){
      const b=document.getElementById(id); if(b&&!b.dataset.busy)
        b.classList.toggle('on',(d.roguecat&ROGUE_CAT_BITS[id])!=0); }
/* @ENDGUARD */
  }catch(e){}
}
const CAP_TYPE_BITS={capTBeacon:0x06,capTProbe:0x01,capTAssoc:0x08,capTDeauth:0x10};
const CAP_TYPE_CHECK={capTBeacon:0x02,capTProbe:0x01,capTAssoc:0x08,capTDeauth:0x10};
/**
 * Computes the local-capture frame-type mask from the on/off state of the
 * capT* toggle buttons.
 * @returns Bitmask OR of CAP_TYPE_BITS for every button currently 'on'.
 */
function capTypeMask(){ let m=0; for(const id in CAP_TYPE_BITS){
  const b=document.getElementById(id); if(b&&b.classList.contains('on'))m|=CAP_TYPE_BITS[id]; } return m; }
/** Flips a local-capture frame-type toggle button's visual state without persisting it. @param id Element id of the capT* toggle button. */
function toggleCapType(id){ const b=document.getElementById(id); if(!b)return;
  b.classList.toggle('on'); }
/**
 * Syncs the capT* frame-type toggle buttons from a server-reported mask,
 * skipping any button with a pending edit (data-busy set).
 * @param v Server-reported type mask, or null/undefined to skip.
 */
function syncCapTypes(v){ if(v==null)return; for(const id in CAP_TYPE_CHECK){
  const b=document.getElementById(id); if(b&&!b.dataset.busy)
    b.classList.toggle('on',(v&CAP_TYPE_CHECK[id])!=0); } }
/** Flips the scout DATA-frame toggle button's (#scoutDataBtn) visual state and marks the scout config dirty (repaints the pending-send indicator). */
function toggleScoutData(){
  const b=document.getElementById('scoutDataBtn'); if(!b)return;
  b.classList.toggle('on'); b.dataset.busy='1'; scoutDirty=true; paintScoutSend();
}
/** Optimistically flips a scout pause toggle button and posts the new state to /api/wifi/opts. @param btnId Button id, defaults to the popover's #scoutPauseBtn (also used by the Scout view's Management sub-tab, #scoutMgmtPauseBtn). */
function toggleScoutPause(btnId){
  btnId=btnId||'scoutPauseBtn';
  const b=document.getElementById(btnId); if(!b)return;
  const on=!b.classList.contains('on'); b.classList.toggle('on',on); b.dataset.busy='1';
  flashScout(fetch('/api/wifi/opts',{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'scoutpause='+(on?1:0)})
    .then(r=>r.ok).finally(()=>delete b.dataset.busy));
}
/** Syncs every scout pause toggle button (popover #scoutPauseBtn + Scout-view #scoutMgmtPauseBtn) from a server value. @param v Server-reported paused state, or null/undefined to skip. */
function syncScoutPause(v){ if(v!=null){syncBtn('scoutPauseBtn',v);syncBtn('scoutMgmtPauseBtn',v);} }
/**
 * Optimistically flips a band-specific scout pause toggle button and posts
 * the new state to /api/wifi/opts.
 * @param band '5' for the 5GHz scout pause button, else the 2.4GHz one.
 */
function toggleScoutBandPause(band){
  const b=document.getElementById(band==='5'?'scoutPause5Btn':'scoutPause24Btn'); if(!b)return;
  const on=!b.classList.contains('on'); b.classList.toggle('on',on); b.dataset.busy='1';
  flashScout(fetch('/api/wifi/opts',{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'scoutpause'+band+'='+(on?1:0)})
    .then(r=>r.ok).finally(()=>delete b.dataset.busy));
}
/** Syncs the 2.4GHz scout pause toggle button (#scoutPause24Btn) from a server value. @param v Server-reported paused state, or null/undefined to skip. */
function syncScoutBandPause24(v){ if(v!=null)syncBtn('scoutPause24Btn',v); }
/** Syncs the 5GHz scout pause toggle button (#scoutPause5Btn) from a server value. @param v Server-reported paused state, or null/undefined to skip. */
function syncScoutBandPause5(v){ if(v!=null)syncBtn('scoutPause5Btn',v); }
/** Requests a scout buffer flush via /api/wifi/opts (scoutflush=1), guarded against re-entry while a flush is already pending. @param btnId Button id, defaults to the popover's #scoutFlushBtn (also used by the Scout view's Management sub-tab, #scoutMgmtFlushBtn). */
function flushScout(btnId){
  btnId=btnId||'scoutFlushBtn';
  const b=document.getElementById(btnId); if(!b||b.dataset.busy)return;
  b.dataset.busy='1';
  flashScout(fetch('/api/wifi/opts',{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'scoutflush=1'})
    .then(r=>r.ok).finally(()=>delete b.dataset.busy));
}
/** Validates and posts the TTL-minutes input (#ttlMin) to /api/wifi/opts, clamping negative/NaN values to 0. */
async function setTtl(){ const el=document.getElementById('ttlMin'); if(!el)return;
  let v=parseInt(el.value,10); if(isNaN(v)||v<0)v=0; el.value=v; el.dataset.busy='1';
  try{await fetch('/api/wifi/opts',{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'ttlmin='+v});}catch(e){} delete el.dataset.busy; }
/** @param ch Channel number. @returns Whether the channel is a 5GHz channel (>13). */
function is5gChan(ch){ return ch>13; }
/** @param ch 5GHz channel number. @returns Index of the channel within WIFI_5G_CH, or -1 if not found. */
function chan5IndexOf(ch){ return WIFI_5G_CH.indexOf(ch); }
/**
 * Reports whether the scout's current channel-lock mask is set to exactly
 * the given single channel, on whichever band it belongs to.
 * @param ch Channel number (2.4GHz or 5GHz).
 * @returns True if the scout mask (scoutMask or scoutMask5) is locked to this channel alone.
 */
function scoutChanActive(ch){
  if(is5gChan(ch)){ const i=chan5IndexOf(ch); return i>=0 && scoutMask5===(1<<i); }
  return scoutMask===(1<<ch);
}
/**
 * Flushes the scout, locks its channel set to a single channel, unpauses it,
 * and sets its type mask to probe/assoc/deauth+data (no beacons) via
 * /api/wifi/chan and /api/wifi/opts, then updates local UI state on success.
 * @param ch Channel number (2.4GHz or 5GHz) to lock the scout to.
 * @returns Promise resolving true if the channel/option changes were confirmed by the server, false otherwise.
 */
async function scoutLockChannel(ch){
  const typesWant=0x1D;
  const is5=is5gChan(ch);
  let chMask, chParam;
  if(is5){
    const idx=chan5IndexOf(ch);
    if(idx<0) return false;
    chMask=1<<idx; chParam='scout5='+chMask;
  }else{
    chMask=1<<ch; chParam='scout='+chMask;
  }
  try{
    const [chRes,optRes]=await Promise.all([
      fetch('/api/wifi/chan',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:chParam})
        .then(r=>r.ok?r.json():Promise.reject()),
      fetch('/api/wifi/opts',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:'scoutflush=1&scoutpause=0&scouttypes='+typesWant+'&scoutdata=1'})
        .then(r=>r.ok?r.json():Promise.reject())
    ]);
    const ok=chRes&&(is5?chRes.scout5===chMask:chRes.scout===chMask)&&optRes&&optRes.scoutpause===0
             &&optRes.scouttypes===typesWant&&optRes.scoutdata===1;
    if(ok){
      if(is5){ scoutMask5=chMask; setScoutChipBand('5'); paintChips5(); }
      else   { scoutMask=chMask; setTgtMask('scout',chMask); paintChips('scout'); setScoutChipBand('24'); }
      syncBtn('scoutPauseBtn',0); syncBtn('scoutDataBtn',1); syncScoutTypes(typesWant);
    }
    return ok;
  }catch(e){ return false; }
}
/**
 * Drives a scout-channel-lock button through busy/scanning/result states
 * while calling scoutLockChannel for the given channel.
 * @param btn Button element to update (title or text label, depending on iconOnly).
 * @param ch Channel number to lock the scout to.
 * @param iconOnly Whether the button is icon-only (updates its title attribute instead of text content).
 */
async function targetScoutChannel(btn,ch,iconOnly){
  if(!btn||btn.dataset.busy)return;
  if(is5gChan(ch) && chan5IndexOf(ch)<0){ if(iconOnly) btn.title='Unknown 5GHz channel'; else btn.textContent='Unknown channel'; return; }
  btn.dataset.busy='1'; btn.classList.remove('on');
  if(iconOnly) btn.title='Scanning ch '+ch+'…'; else btn.textContent='Scanning…';
  const ok=await scoutLockChannel(ch);
  btn.classList.toggle('on',ok);
  if(iconOnly) btn.title=ok?('Scanning for clients via scout on ch '+ch+' — tap to retry'):'Scan failed — tap to retry';
  else btn.textContent=ok?('Scanning ch '+ch):'Scan failed — tap to retry';
  delete btn.dataset.busy;
}
/**
 * Computes the 2.4GHz and 5GHz channel bitmasks covering every beacon
 * broadcasting the given SSID.
 * @param ssid SSID string to match among lastWifi beacon records.
 * @returns Object {mask24,mask5} with a bit set per channel in use on each band.
 */
function networkChanMasks(ssid){
  let mask24=0, mask5=0;
  (lastWifi||[]).forEach(x=>{
    if(x.kind!=='beacon'||x.ssid!==ssid||!x.ch) return;
    if(is5gChan(x.ch)){ const i=chan5IndexOf(x.ch); if(i>=0) mask5|=(1<<i); }
    else mask24|=(1<<x.ch);
  });
  return {mask24,mask5};
}
/**
 * Flushes the scout, sets its channel set to every channel a given SSID is
 * broadcast on (both bands in one hop set), unpauses it, and sets its type
 * mask to probe/assoc/deauth+data (no beacons), updating local UI state on
 * success.
 * @param ssid SSID string to scan for.
 * @param btn Button element driven through busy/scanning/result states.
 */
async function scanNetworkViaScout(ssid,btn){
  if(!btn||btn.dataset.busy)return;
  const {mask24,mask5}=networkChanMasks(ssid);
  if(!mask24&&!mask5)return;
  const typesWant=0x1D;
  btn.dataset.busy='1'; btn.classList.remove('on'); btn.textContent='Scanning…';
  try{
    const body=[]; if(mask24)body.push('scout='+mask24); if(mask5)body.push('scout5='+mask5);
    const [chRes,optRes]=await Promise.all([
      fetch('/api/wifi/chan',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body.join('&')})
        .then(r=>r.ok?r.json():Promise.reject()),
      fetch('/api/wifi/opts',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:'scoutflush=1&scoutpause=0&scouttypes='+typesWant+'&scoutdata=1'})
        .then(r=>r.ok?r.json():Promise.reject())
    ]);
    const ok=chRes&&(!mask24||chRes.scout===mask24)&&(!mask5||chRes.scout5===mask5)
             &&optRes&&optRes.scoutpause===0&&optRes.scouttypes===typesWant&&optRes.scoutdata===1;
    if(ok){
      if(mask24){ scoutMask=mask24; setTgtMask('scout',mask24); paintChips('scout'); }
      if(mask5){ scoutMask5=mask5; paintChips5(); }
      setScoutChipBand(mask5&&!mask24?'5':'24');
      syncBtn('scoutPauseBtn',0); syncBtn('scoutDataBtn',1); syncScoutTypes(typesWant);
    }
    btn.classList.toggle('on',ok);
    btn.textContent=ok?'Scanning all channels (scout)':'Scan failed — tap to retry';
  }catch(e){ btn.textContent='Scan failed — tap to retry'; }
  finally{ delete btn.dataset.busy; }
}
/**
 * Arms this board's own timed capture locked to every channel a given SSID
 * is broadcast on (5GHz set only used if it has no 2.4GHz channels and dual-
 * band capture is enabled), sets the probe/assoc/deauth+data type mask, and
 * starts the capture using the current duration-range value.
 * @param ssid SSID string to scan for; no-op if the radar isn't in WiFi mode, a capture is already running, or the SSID has no known channels.
 */
function scanNetworkLocal(ssid){
  if(radarMode!=='wifi'||capturing) return;
  const {mask24,mask5}=networkChanMasks(ssid);
  const mask=(!mask24&&mask5&&capDualBand)?mask5:mask24;
  if(!mask) return;
  const use5=(mask===mask5&&mask24===0);
  const typesWant=0x1D;
  if(use5){
    capMask5=mask; setTgtMask5('cap',mask); setCapChipBand('5'); paintChips5('cap');
    capMask=0; setTgtMask('cap',0); paintChips('cap'); capActive=0;
    syncCapBandPause24(true); syncCapBandPause5(false);
  }else{
    capMask=mask; setTgtMask('cap',mask); setCapChipBand('24'); paintChips('cap');
    capMask5=0; setTgtMask5('cap',0); paintChips5('cap'); capActive=mask;
    syncCapBandPause24(false); syncCapBandPause5(!!mask5);
  }
  applyChanFilter();
  syncCapTypes(typesWant); syncCapData(1);
  const r=document.getElementById('capRange');
  startCapture(r?+r.value||30:30);
  if(macModalOpen)closeMacInfo();
}
const SCOUT_TYPE_BITS={scoutTBeacon:0x06,scoutTProbe:0x01,scoutTAssoc:0x08,scoutTDeauth:0x10};
const SCOUT_TYPE_CHECK={scoutTBeacon:0x02,scoutTProbe:0x01,scoutTAssoc:0x08,scoutTDeauth:0x10};
/**
 * Computes the scout mgmt-frame type bitmask from which SCOUT_TYPE_BITS toggle buttons are currently on.
 * @returns Bitmask OR of the checked type buttons' bit values.
 */
function scoutTypeMask(){ let m=0; for(const id in SCOUT_TYPE_BITS){
  const b=document.getElementById(id); if(b&&b.classList.contains('on'))m|=SCOUT_TYPE_BITS[id]; } return m; }
/**
 * Toggles a scout frame-type button's active state and marks the scout config as dirty pending send.
 * @param id Element id of the type-toggle button.
 */
function toggleScoutType(id){ const b=document.getElementById(id); if(!b)return;
  b.classList.toggle('on'); b.dataset.busy='1'; scoutDirty=true; paintScoutSend(); }
/**
 * Synchronises the scout type-toggle buttons' visual state from a server-reported bitmask, skipping any button with a pending local toggle.
 * @param v Bitmask of active scout frame types, or null/undefined to skip.
 */
function syncScoutTypes(v){ if(v==null)return; for(const id in SCOUT_TYPE_CHECK){
  const b=document.getElementById(id); if(b&&!b.dataset.busy)
    b.classList.toggle('on',(v&SCOUT_TYPE_CHECK[id])!=0); } }
/**
 * Looks up the SSID advertised by a given BSSID from `lastWifi`.
 * @param bssid AP MAC address to look up.
 * @returns The AP's SSID, or an empty string if not found/unnamed.
 */
function bssidSsid(bssid){const w=(lastWifi||[]).find(x=>x.mac===bssid); return w&&w.ssid?w.ssid:'';}
/**
 * Resolves a MAC address's vendor name, skipping locally-administered (randomised) MACs.
 * @param mac MAC address string.
 * @returns Vendor name from `ouiVendor()` or the matching `lastWifi` record, or an empty string.
 */
function macVendor(mac){
  if(!mac||(parseInt(mac.slice(0,2),16)&0x02)!==0) return '';
  const w=(lastWifi||[]).find(x=>x.mac===mac);
  return ouiVendor(mac)||(w&&w.vendor)||'';
}
/**
 * Builds the HTML for a MAC address table cell, including a vendor annotation when known.
 * @param mac MAC address string.
 * @returns HTML string with a MAC link and optional `(vendor)` suffix.
 */
function macCell(mac){
  const v=macVendor(mac);
  return macLink(mac)+(v?` <span class="muted">(${esc(v)})</span>`:'');
}
/**
 * Builds the HTML for a BSSID table cell, including its SSID annotation when known.
 * @param bssid AP MAC address.
 * @returns HTML string with a MAC link and optional `(ssid)` suffix.
 */
function bssidCell(bssid){
  const ssid=bssidSsid(bssid);
  return macLink(bssid)+(ssid?` <span class="muted">(${esc(ssid)})</span>`:'');
}
/* @GUARD:IF WITH_SENTINEL *//**
 * Builds the list of human-readable Sentinel status/alert messages from a sentinel status object.
 * @param s Sentinel status object, with optional `deauth`, `karma`, and `rogue` sub-objects.
 * @returns Array of message objects `{alert, html, type?, mac?}` describing current watch state and any active alerts.
 */
function sentinelBuildMsgs(s){
  const msgs=[];
  if(s.deauth){
    const d=s.deauth;
    if(d.alerting){
      let m=`Deauth flood: ${macCell(d.worstmac)} sent ${d.worstcount}× deauth/disassoc`;
      if(d.worstssid||d.worstbssid){
        m+=' targeting ';
        if(d.worstssid) m+=`<b>${esc(d.worstssid)}</b>`;
        if(d.worstbssid) m+=(d.worstssid?' &mdash; ':'')+macCell(d.worstbssid);
        if(d.worstch) m+=` (ch ${d.worstch})`;
      }
      msgs.push({alert:true,html:m,type:'deauth',mac:d.worstmac});
    } else {
      msgs.push({alert:false,html:`Deauth watch: no flood detected (armed, ${(d.rows||[]).length} attacker MAC(s) seen)`,type:'deauth'});
    }
  }
  if(s.karma){
    const k=s.karma;
    if(k.responded){
      msgs.push({alert:true,html:`Karma: a client associated to fake AP <b>${esc(k.ssid)}</b> `+
        `via ${macCell(k.apmac)} (rssi ${k.rssi}, ch ${k.ch})`,type:'karma'});
    } else {
      msgs.push({alert:false,html:`Karma watch: probing as <b>${esc(k.ssid)}</b>, no bites yet (${k.sends} sent)`,type:'karma'});
    }
  }
  if(s.rogue){
    const r=s.rogue;
    const hits=r.hits||[];
    if(!hits.length){
      msgs.push({alert:false,html:'Rogue watch: no matching hardware/behaviour seen',type:'rogue'});
    } else {
      hits.forEach(h=>{
        const flags=[]; if(h.ssidhop)flags.push('SSID-hopping'); if(h.beaconflood)flags.push('beacon flood');
        if(h.probeflood)flags.push('probe flood');
        let m=`${esc(h.label)}: ${macCell(h.mac)}`+(h.vendor?` <span class="muted">(${esc(h.vendor)})</span>`:'');
        if(h.ssid) m+=` &mdash; SSID <b>${esc(h.ssid)}</b>`;
        m+=` &mdash; rssi ${h.rssi}, ch ${h.ch}, ${h.cnt}×`;
        if(flags.length) m+=` &mdash; <b>${flags.join(', ')}</b>`;
        msgs.push({alert:!!h.attacking,html:m,type:'rogue',mac:h.mac});
      });
    }
  }
  return msgs;
}
/**
 * Whether the floating Sentinel alert popup is enabled -- client-side
 * preference (localStorage), off by default. The Sentinel tab's own status
 * view is unaffected either way.
 */
function sentPopupOn(){ try{return localStorage.getItem('sentPopup')==='1';}catch(e){return false;} }
/**
 * Flips the Sentinel popup preference, persists it, syncs the Settings
 * button, and hides the live panel immediately if turned off.
 */
function toggleSentPopup(){
  const on=!sentPopupOn();
  try{localStorage.setItem('sentPopup',on?'1':'0');}catch(e){}
  syncSentPopupBtn();
  if(!on){const panel=document.getElementById('sentinelPanel'); if(panel)panel.classList.remove('show');}
}
/**
 * Syncs the header popover's "Alert popup" button to the persisted preference.
 */
function syncSentPopupBtn(){
  const b=document.getElementById('sentPopupBtn'); if(!b)return;
  const on=sentPopupOn(); b.classList.toggle('on',on); b.setAttribute('aria-pressed',on);
}
let sentinelDismissed=false, sentinelWasAlerting=false;
/**
 * Dismisses the floating Sentinel alert panel and marks it dismissed until the next alert transition.
 */
function dismissSentinelPanel(){
  sentinelDismissed=true;
  const panel=document.getElementById('sentinelPanel'); if(panel)panel.classList.remove('show');
}
/**
 * Renders the floating Sentinel alert panel from the latest status, showing/hiding it and clearing dismissal on a new alert transition.
 * @param s Sentinel status object, or a falsy value to reset/hide the panel.
 */
function renderSentinelPanel(s){
  const panel=document.getElementById('sentinelPanel'); if(!panel)return;
  if(!s||!sentPopupOn()){panel.classList.remove('show','alerting');sentinelDismissed=false;sentinelWasAlerting=false;return;}
  if(!!s.alerting&&!sentinelWasAlerting)sentinelDismissed=false;
  sentinelWasAlerting=!!s.alerting;
  panel.classList.toggle('alerting',!!s.alerting);
  if(sentinelDismissed){panel.classList.remove('show');return;}
  panel.classList.add('show');
  const msgs=sentinelBuildMsgs(s);
  const box=document.getElementById('sentinelMsgs');
  if(!box)return;
  box.innerHTML = msgs.length
    ? msgs.map(m=>`<div class="sp-msg${m.alert?' alert':''} wt-${m.type||''}">${m.html}</div>`).join('')
    : '<div class="sp-empty">Sentinel armed, watching&hellip;</div>';
}
/**
 * Renders the Sentinel tab's status line and message list from the latest status.
 * @param s Sentinel status object, or a falsy value to show the "no session" placeholder.
 */
function renderSentinelView(s){
  const status=document.getElementById('sentinelViewStatus');
  const box=document.getElementById('sentinelViewMsgs');
  if(!box)return;
  if(!s){
    if(status)status.textContent='';
    box.innerHTML='<div class="sv-empty">No Sentinel session has run yet this boot &mdash; start one from Settings &gt; Dongle.</div>';
    return;
  }
  if(status)status.textContent=s.active?'Live':'Stopped';
  const chip=(t,c)=>`<span class="sv-chip${c?' '+c:''}">${t}</span>`;
  const tchip=(wt,label)=>`<span class="sv-tchip wt-${wt}">${label}</span>`;
  const num=v=>v==null||v===''?'&mdash;':v;
  const row=(wt,typeLabel,status_,statusCls,statusTitle,detail,rssi,ch,cnt,flags,actions,hot)=>
    `<tr class="wt-${wt}${hot?' hot':''}"><td>${tchip(wt,typeLabel)}</td>`+
    `<td>${status_?`<span class="sv-chip${statusCls?' '+statusCls:''}"${statusTitle?` title="${esc(statusTitle)}"`:''}>${status_}</span>`:''}</td>`+
    `<td class="sv-tdetail">${detail}</td><td class="sv-tnum">${num(rssi!=null&&rssi!==''?rssi+' dBm':rssi)}</td>`+
    `<td class="sv-tnum">${num(ch)}</td><td class="sv-tnum">${num(cnt)}</td>`+
    `<td class="sv-tflags">${flags||''}</td><td class="sv-tact">${actions||''}</td></tr>`;
  const xIco='<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="var(--rnd,#f0a43a)" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>';
  const dismissBtn=(type,mac)=>`<button class="icobtn" style="padding:3px 7px" data-mac="${esc(mac||'')}" onclick="dismissSentinelAlert('${type}',this.dataset.mac,this)" `+
    `title="Dismiss — clears this alert state (can reappear on a new sighting)">${xIco}</button>`;
  /* Top bar: one pill per ARMED watch showing its live status -- this is
   * where "nothing detected yet" lives now, so the table below only ever
   * holds real sightings (no placeholder Clear/Waiting/Quiet rows). */
  const watchPill=(wt,label,statusText,alertOn)=>
    `<div class="sv-watch wt-${wt}${alertOn?' alert':''}"><span class="sv-wdot"></span>`+
    `<span class="sv-wlabel">${label}</span><span class="sv-wstat">${statusText}</span></div>`;
  const watchbar=[], rows=[]; let alerts=0, watches=0;
  if(s.deauth){
    watches++;
    const d=s.deauth, drows=(d.rows||[]).slice().sort((a,b)=>b.cnt-a.cnt).slice(0,8);
    if(d.alerting)alerts++;
    watchbar.push(watchPill('deauth','Deauth',d.alerting
      ? `Flood &mdash; ${macCell(d.worstmac)} ${d.worstcount}&times;`
      : `Quiet &mdash; ${drows.length} MAC(s) seen sending deauth/disassoc`,d.alerting));
    drows.forEach(r=>{
      const worst=d.alerting&&r.mac===d.worstmac;
      let detail=macCell(r.mac);
      if(worst&&(d.worstssid||d.worstbssid)){
        detail+=' &rarr; ';
        if(d.worstssid)detail+=`<b>${esc(d.worstssid)}</b>`;
        if(d.worstbssid)detail+=(d.worstssid?' &mdash; ':'')+macCell(d.worstbssid);
      }
      rows.push(row('deauth','Deauth',worst?'Flood source':'','bad',
        worst?'':'',detail,r.rssi,worst?d.worstch:null,r.cnt,'',worst?dismissBtn('deauth',d.worstmac):'',worst));
    });
  }
  if(s.karma){
    watches++;
    const k=s.karma; if(k.responded)alerts++;
    watchbar.push(watchPill('karma','Karma',k.responded
      ? `Bitten &mdash; via ${macCell(k.apmac)}`
      : `Waiting &mdash; probing as <b>${esc(k.ssid)}</b>, ${k.sends} sent`,k.responded));
    if(k.responded){
      const detail=`SSID <b>${esc(k.ssid)}</b> &mdash; answered by ${macCell(k.apmac)}`;
      rows.push(row('karma','Karma','Bitten','bad',
        'An AP answered a probe for a fabricated SSID -- it blindly responds to any probed name.',
        detail,k.rssi,k.ch,k.sends,'',dismissBtn('karma',''),true));
    }
  }
  if(s.rogue){
    watches++;
    const hits=(s.rogue.hits||[]).slice().sort((a,b)=>(b.attacking-a.attacking)||(b.rssi-a.rssi));
    const attackingN=hits.filter(h=>h.attacking).length;
    if(attackingN)alerts+=attackingN;
    watchbar.push(watchPill('rogue','Rogue',!hits.length?'Clear'
      :(attackingN?`${attackingN} deauth-flooding / `:'')+`${hits.length} seen`,!!attackingN));
    hits.forEach(h=>{
      const flagList=[]; if(h.ssidhop)flagList.push('SSID hop'); if(h.beaconflood)flagList.push('Beacon flood');
      if(h.probeflood)flagList.push('Probe flood');
      let detail=`<b>${esc(h.label)}</b> &middot; ${macCell(h.mac)}`+
        (h.vendor?` <span class="muted">(${esc(h.vendor)})</span>`:'')+
        (h.ssid?` &mdash; SSID <b>${esc(h.ssid)}</b>`:'');
      const chkIco='<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="var(--pub,#37d67a)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1.5,6 4.5,9.5 10.5,2.5"/></svg>';
      const actions=`<button class="icobtn" style="padding:3px 7px" data-mac="${esc(h.mac)}" onclick="allowSentinelMac(this.dataset.mac,this)" `+
        `title="Allow — add this MAC to the Rogue watch's SD allowlist (never matches again)">${chkIco}</button>`+
        dismissBtn('rogue',h.mac);
      /* "attacking" = this rogue-hardware-matched MAC is ALSO currently
       * deauth-flooding (same >=10-frame threshold as the Deauth watch) --
       * matching the OUI/behaviour alone only ever shows "Seen". */
      rows.push(row('rogue','Rogue',h.attacking?'Deauth-flooding':'Seen',h.attacking?'bad':'',
        h.attacking?'This device also sent enough deauth/disassoc frames to trip the Deauth watch\'s flood threshold.':'',
        detail,h.rssi,h.ch,h.cnt,
        flagList.map(f=>chip(f,'bad')).join(''),actions,!!h.attacking));
    });
  }
  const tiles='<div class="sv-sum">'+
    `<div class="sv-tile${s.active?' ok':''}"><span class="sv-v">${s.active?'Live':'Stopped'}</span><span class="sv-l">Session</span></div>`+
    `<div class="sv-tile${alerts?' alert':''}"><span class="sv-v">${alerts}</span><span class="sv-l">Alerts</span></div>`+
    `<div class="sv-tile"><span class="sv-v">${watches}</span><span class="sv-l">Watches</span></div></div>`;
  const bar=watchbar.length?`<div class="sv-watchbar">${watchbar.join('')}</div>`:'';
  const table=rows.length?'<div class="scroll"><table class="sv-table"><thead><tr>'+
    '<th>TYPE</th><th>STATUS</th><th>DETECTED</th><th>RSSI</th><th>CH</th><th>CNT</th><th>FLAGS</th><th></th>'+
    '</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>'
    :'<div class="sv-empty">No detections yet &mdash; watches armed, see status above.</div>';
  box.innerHTML=tiles+bar+table;
}
/**
 * Adds a MAC address to the Rogue watch's SD allowlist via the server.
 * @param mac MAC address to allow.
 * @param btn Optional button element to disable and relabel while the request is in flight.
 */
async function allowSentinelMac(mac,btn){
  if(btn){btn.disabled=true;btn.innerHTML='<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="var(--pub,#37d67a)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1.5,6 4.5,9.5 10.5,2.5"/></svg>';}
  try{await fetch('/api/sentinel/allow',{method:'POST',body:'mac='+encodeURIComponent(mac)});}catch(e){}
}
/**
 * Dismisses a specific Sentinel alert type (optionally scoped to a MAC) via the server.
 * @param type Alert type identifier (e.g. 'deauth', 'karma', 'rogue').
 * @param mac Optional MAC address to scope the dismissal to.
 * @param btn Optional button/row element to fade and disable while the request is in flight.
 */
async function dismissSentinelAlert(type,mac,btn){
  if(btn){const row=btn.closest('.sp-msg'); if(row)row.style.opacity='.4'; btn.disabled=true;}
  try{await fetch('/api/sentinel/dismiss',{method:'POST',
    body:'type='+encodeURIComponent(type)+(mac?'&mac='+encodeURIComponent(mac):'')});}catch(e){}
}
/**
 * Opens a confirmation dialog to clear all recorded Sentinel alert data.
 */
function requestSentinelClearAll(){
  openConfirm('Clear all Sentinel alert data? The watch session (if still running) stays armed '+
    '-- this only wipes what it has recorded so far.','Clear all',doSentinelClearAll);
}
/**
 * Sends the request to clear all recorded Sentinel alert data on the server.
 */
async function doSentinelClearAll(){
  try{await fetch('/api/sentinel/clear',{method:'POST'});}catch(e){}
}
let sentinelEverRan=false;
/**
 * Shows or hides all `.sentinel-only` elements based on whether Sentinel has ever run this boot, and redirects off the Sentinel view if not.
 */
function syncSentinelOnlyUI(){
  document.querySelectorAll('.sentinel-only').forEach(e=>e.style.display=sentinelEverRan?'':'none');
  if(!sentinelEverRan&&curView==='sentinel')setView('map');
}
/* @ENDGUARD *//**
 * Renders the Deauth/disassoc events table, applying the current kind filter and sort, and flagging flood rows.
 */
function renderDeauth(){
  const tb=document.querySelector('#det tbody'); if(!tb)return;
  const hdc=document.getElementById('hdc'); if(hdc)hdc.textContent=lastDeauth.length;
  const filtered=lastDeauth.filter(deauthKindPass);
  const sec=document.getElementById('deauthSec'), empty=document.getElementById('deauthEmpty');
  if(sec)sec.style.display=filtered.length?'':'none';
  if(empty)empty.style.display=filtered.length?'none':'';
  if(!filtered.length){tb.innerHTML='';return;}
  const rows=filtered.slice().sort((a,b)=>{
    const k=deSort.k;
    if(k==='src'||k==='dst'||k==='bssid') return deSort.dir*(''+(a[k]||'')).localeCompare(''+(b[k]||''));
    const av=(k==='type')?a.dis:a[k], bv=(k==='type')?b.dis:b[k];
    return deSort.dir*((+av||0)-(+bv||0));
  });
  tb.innerHTML = rows.map(d=>{
    const flood=d.cnt>=10;
    return `<tr class="${flood?'deauth-flood':''}">`+
      `<td data-label="Age">${d.age}s</td>`+
      `<td data-label="Type"><span class="tag wdea">${d.dis?'DISASSOC':'DEAUTH'}</span></td>`+
      `<td class="mac" data-label="Src (tx)">${macCell(d.src)}</td>`+
      `<td class="mac" data-label="Dst (target)">${macCell(d.dst)}</td>`+
      `<td class="mac" data-label="Target AP">${bssidCell(d.bssid)}</td>`+
      `<td class="muted" data-label="Reason">${reasonTxt(d.reason)}</td>`+
      `<td data-label="Cnt"><b>${d.cnt}</b></td>`+
      `<td data-label="RSSI">${d.rssi}</td></tr>`;
  }).join('');
}
/**
 * Maps raw WiFi records into device-shaped objects for the shared radar/table rendering pipeline, synthesizing rows for stations known only via association.
 * @param w Array of raw `wifi[]` records from `/api/data`.
 * @returns Array of device objects, filtered by channel lock and kind visibility.
 */
function wifiToDevs(w){
  const seen=new Set();
  const rows=(w||[])
    .filter(x=>!absorbed.has(x.mac))
    .filter(x=>(x.ssid&&x.ssid.length)||x.ssidbad||x.hid||!!wifiClientAp[x.mac])
    .filter(x=>!wifiChanLock || +x.ch===wifiChanLock)
    .map(x=>{seen.add(x.mac); return {
      mac:x.mac, type:x.rnd?'RND':'PUB', rssi:x.rssi, avg:x.avg, min:x.min, max:x.max,
      cnt:x.cnt, age:x.age, life:x.life||0,
      oui:!x.rnd, vendor:x.vendor||'', name:x.ssidbad?'':(x.ssid||(x.hid?'‹hidden›':'')),
      sta:(x.kind==='beacon' && wifiClients[x.mac]) ? wifiClients[x.mac].length : 0,
      _wifi:1, ch:x.ch, kind:x.kind, ssid:x.ssid, ssidbad:x.ssidbad, ssidhex:x.ssidhex,
      hid:x.hid, sec:x.sec, cip:x.cip, pmf:x.pmf, secie:x.secie, isNew:newWifiMacs.has(x.mac)||newStationMacs.has(x.mac),
      lat:x.lat, lon:x.lon, rogue:rogueByMac.get(x.mac)||null
    };});
  Object.keys(wifiClientAp).forEach(mac=>{
    if(seen.has(mac)||(wifiChanLock)||absorbed.has(mac))return;
    const ci=wifiClientAp[mac], rnd=!!ci.rnd;
    rows.push({mac, type:rnd?'RND':'PUB', rssi:ci.rssi, avg:ci.rssi, min:ci.rssi, max:ci.rssi,
      cnt:ci.cnt, age:ci.age, life:0,
      oui:!rnd, vendor:ci.vendor||'', name:'', sta:0,
      _wifi:1, ch:'', kind:'probe', ssid:'', ssidbad:0, ssidhex:'', hid:0, sec:0, cip:0, pmf:0, secie:0,
      isNew:newWifiMacs.has(mac)||newStationMacs.has(mac), rogue:rogueByMac.get(mac)||null});
  });
  rogueByMac.forEach((h,mac)=>{
    if(seen.has(mac)||absorbed.has(mac)||(wifiChanLock&&+h.ch!==wifiChanLock))return;
    seen.add(mac);
    rows.push({mac, type:'PUB', rssi:h.rssi, avg:h.rssi, min:h.rssi, max:h.rssi,
      cnt:h.cnt, age:0, life:0,
      oui:true, vendor:h.vendor||'', name:h.ssid||'',
      sta:0, _wifi:1, ch:h.ch, kind:'beacon', ssid:h.ssid||'', ssidbad:0, ssidhex:'', hid:0,
      sec:0, cip:0, pmf:0, secie:0, isNew:false, lat:null, lon:null, rogue:h});
  });
  return rows.filter(d=>wifiKindPass(d));
}
const CHAN_LIST24=[1,2,3,4,5,6,7,8,9,10,11,12,13];
let chanBand='24';
/**
 * Returns the channel list for the currently selected density-view band.
 * @returns `WIFI_5G_CH` when `chanBand` is '5', else the 2.4GHz channel list.
 */
function chanList(){ return chanBand==='5' ? WIFI_5G_CH : CHAN_LIST24; }
let chanSel=0, chanHover=0, chanGeo=null;
const cc=document.getElementById('chanCanvas'), cx2d=cc.getContext('2d');
/**
 * Switches the Channel Density view's active band and redraws it.
 * @param b Band identifier, '24' or '5'.
 */
function setChanBand(b){
  if(b===chanBand)return;
  chanBand=b; chanSel=0;
  document.getElementById('cbtab24').classList.toggle('on',b==='24');
  document.getElementById('cbtab5').classList.toggle('on',b==='5');
  drawChanDensity();
}
/**
 * Aggregates beacon sightings per channel for the Channel Density view.
 * @param w Array of `wifi[]` records.
 * @returns Map of channel number to `{ch,total,bcn,prb,ssids}`, `ssids` keyed by SSID with count/best-RSSI/mac.
 */
function chanAgg(w){
  const list=chanList(), m={};
  list.forEach(c=>{ m[c]={ch:c,total:0,bcn:0,prb:0,ssids:{}}; });
  (w||[]).forEach(x=>{
    if(x.kind!=='beacon'||!x.ssid)return;   // hidden/nameless nets don't count toward density
    const c=+x.ch; if(!m[c])return;
    const e=m[c]; e.total++; e.bcn++;
    const s=e.ssids[x.ssid]=e.ssids[x.ssid]||{ssid:x.ssid,kind:'beacon',cnt:0,best:-999,mac:x.mac};
    s.cnt++; if(x.rssi>s.best){s.best=x.rssi; s.mac=x.mac;}
  });
  return m;
}
/**
 * Draws the Channel Density polar-rose canvas: one wedge per channel sized by beacon count, with the selected channel highlighted.
 */
function drawChanDensity(){
  const dpr=window.devicePixelRatio||1, W=cc.clientWidth, H=cc.clientHeight||360;
  if(!W||!H)return;
  cc.width=W*dpr; cc.height=H*dpr; cx2d.setTransform(dpr,0,0,dpr,0,0);
  cx2d.clearRect(0,0,W,H);
  const list=chanList(), n=list.length;
  const cx=W/2, cy=H/2, maxR=Math.min(W,H)/2-30, innerR=Math.max(14,maxR*0.12);
  const agg=chanAgg(lastWifi);
  let maxT=1; list.forEach(c=>{ maxT=Math.max(maxT,agg[c].total); });
  const step=2*Math.PI/n, A0=-Math.PI/2-step/2;
  const css=getComputedStyle(document.documentElement);
  const cBcn=css.getPropertyValue('--pub').trim()||'#37d67a',
        cLine=css.getPropertyValue('--line').trim()||'#25304a',
        cMut=css.getPropertyValue('--muted').trim()||'#8fa0bd',
        cFg =css.getPropertyValue('--fg').trim()||'#e6ecf5';
  const glowA=css.getPropertyValue('--radar-glow-a').trim(), glowB=css.getPropertyValue('--radar-glow-b').trim();
  if(glowA){
    const gr=Math.hypot(W,H)/2;
    const glow=cx2d.createRadialGradient(cx,cy,0,cx,cy,gr);
    glow.addColorStop(0,glowA+'1c'); glow.addColorStop(0.55,(glowB||glowA)+'12');
    glow.addColorStop(1,'transparent');
    cx2d.fillStyle=glow; cx2d.fillRect(0,0,W,H);
  }
  cx2d.strokeStyle=cLine; cx2d.lineWidth=1;
  for(let g=1;g<=3;g++){ const r=innerR+(maxR-innerR)*g/3;
    cx2d.beginPath(); cx2d.arc(cx,cy,r,0,2*Math.PI); cx2d.stroke(); }
  const ring=[];
  for(let i=0;i<n;i++){
    const c=list[i], e=agg[c], a0=A0+i*step, a1=a0+step, mid=(a0+a1)/2;
    const frac=e.total/maxT, r=innerR+(maxR-innerR)*Math.sqrt(frac);
    const sel=(chanSel===c), hov=(chanHover===c&&!sel&&e.total>0);
    const wedge=(rr0,rr1,col,alpha)=>{ if(rr1<=rr0)return;
      cx2d.beginPath(); cx2d.arc(cx,cy,rr1,a0+.012,a1-.012);
      cx2d.arc(cx,cy,rr0,a1-.012,a0+.012,true); cx2d.closePath();
      cx2d.fillStyle=col; cx2d.globalAlpha=alpha; cx2d.fill(); cx2d.globalAlpha=1; };
    wedge(innerR,r,cBcn,sel?.95:(hov?.9:.72));
    if(sel||hov){ cx2d.beginPath(); cx2d.arc(cx,cy,r,a0+.012,a1-.012);
      cx2d.arc(cx,cy,innerR,a1-.012,a0+.012,true); cx2d.closePath();
      cx2d.strokeStyle=cFg; cx2d.lineWidth=sel?1.5:1; cx2d.globalAlpha=sel?1:.6; cx2d.stroke(); cx2d.globalAlpha=1; }
    const lr=maxR+14, lx=cx+Math.cos(mid)*lr, ly=cy+Math.sin(mid)*lr;
    cx2d.fillStyle=sel?cFg:cMut; cx2d.font='11px system-ui,sans-serif';
    cx2d.textAlign='center'; cx2d.textBaseline='middle';
    cx2d.fillText(''+c,lx,ly);
    if(e.total){ const rr=Math.max(innerR+11,r-11);
      const tx=cx+Math.cos(mid)*rr, ty=cy+Math.sin(mid)*rr;
      cx2d.fillStyle=cFg; cx2d.font='bold 11px system-ui,sans-serif';
      cx2d.fillText(''+e.total,tx,ty); }
    ring.push({ch:c,a0,a1});
  }
  chanGeo={cx,cy,maxR,step,A0,list};
  cx2d.fillStyle=cMut; cx2d.font='10px system-ui,sans-serif';
  cx2d.textAlign='center'; cx2d.textBaseline='middle';
  cx2d.fillText('CH',cx,cy);
  document.getElementById('hcn').textContent=
    Object.values(agg).filter(e=>e.total>0).length;
  renderChanDetail(agg);
}
/**
 * Resolves a canvas coordinate to the channel wedge it falls within.
 * @param x Canvas-relative X coordinate.
 * @param y Canvas-relative Y coordinate.
 * @returns Channel number, or 0 if outside all wedges.
 */
function chanHitTest(x,y){
  if(!chanGeo)return 0;
  const dx=x-chanGeo.cx, dy=y-chanGeo.cy, d=Math.hypot(dx,dy);
  if(d>chanGeo.maxR+22)return 0;
  let rel=(Math.atan2(dy,dx)-chanGeo.A0)%(2*Math.PI);
  if(rel<0)rel+=2*Math.PI;
  const i=Math.floor(rel/chanGeo.step);
  return (i>=0&&i<chanGeo.list.length)?chanGeo.list[i]:0;
}
/**
 * Renders the selected channel's SSID list panel below the Channel Density canvas.
 * @param agg Optional pre-computed channel aggregation from `chanAgg()`; recomputed from `lastWifi` when omitted.
 */
function renderChanDetail(agg){
  const el=document.getElementById('chanDetail'), c=chanSel;
  if(!c){ el.innerHTML='<span class="cd-hint">No channel selected &mdash; tap a wedge to list its networks.</span>'; return; }
  const e=(agg||chanAgg(lastWifi))[c];
  const rows=Object.values(e.ssids).sort((a,b)=>b.best-a.best);
  let h=`<div class="cd-hd"><b>Channel ${c}</b><span class="cd-hint">${e.bcn} AP</span></div>`;
  if(!rows.length){ h+='<span class="cd-hint">No named APs seen on this channel.</span>'; }
  else rows.forEach(s=>{ h+=`<div class="cd-row cd-click" data-mac="${esc(s.mac)}" onclick="showMacInfo(this.dataset.mac)" title="show what is known about ${esc(s.mac)}">${wifiKindBadge(s.kind)}`+
    `<span class="cd-ssid">${esc(s.ssid)}</span>`+
    `<span class="cd-r">${s.best} dBm</span><span class="cd-n">&times;${s.cnt}</span></div>`; });
  el.innerHTML=h;
}
cc.addEventListener('click',e=>{ const r=cc.getBoundingClientRect();
  const h=chanHitTest(e.clientX-r.left,e.clientY-r.top);
  chanSel=(chanSel===h)?0:h; drawChanDensity(); });
/** Tracks the hovered wedge on the Channel Density canvas, redrawing only when it changes. */
cc.addEventListener('mousemove',e=>{ const r=cc.getBoundingClientRect();
  const h=chanHitTest(e.clientX-r.left,e.clientY-r.top);
  cc.style.cursor=h?'pointer':'default';
  if(h===chanHover)return; chanHover=h; drawChanDensity(); });
cc.addEventListener('mouseleave',()=>{ if(!chanHover)return;
  chanHover=0; cc.style.cursor='default'; drawChanDensity(); });

/* --- GPS Trail: GPS-tagged sightings as a plain time-ordered table --- */
/**
 * Renders the GPS Trail table: every GPS-tagged `wifi[]` sighting from
 * `lastWifi`, time/SSID/coords/RSSI, sorted by `trSort`. Default order is
 * `lastWifi`'s own order (the GPS session log's line order, i.e. the order
 * they were walked past). Click a row to open that MAC's info.
 */
/** Formats a metre distance as "123m" or "1.23km", for the trail's inter-sighting DIST column. */
function fmtDist(m){ return m>=1000 ? (m/1000).toFixed(2)+'km' : Math.round(m)+'m'; }
/** Pin glyph linking a trail row's coordinates out to Google Maps. */
const MAP_PIN_ICON='<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2c-3 0-5.5 2.3-5.5 5.5 0 4 5.5 10.5 5.5 10.5s5.5-6.5 5.5-10.5C15.5 4.3 13 2 10 2z"/><circle cx="10" cy="7.5" r="1.8"/></svg>';
function drawTrail(){
  const empty=document.getElementById('trailEmpty');
  const tb=document.querySelector('#trailTbl tbody');
  const startEl=document.getElementById('trailStart'), endEl=document.getElementById('trailEnd');
  const pts=(lastWifi||[]).filter(x=>x.lat!=null&&x.lon!=null&&(x.lat||x.lon));
  document.getElementById('htr').textContent=pts.length;
  if(!tb)return;
  if(!pts.length){
    tb.innerHTML='';
    if(empty)empty.style.display='';
    if(startEl)startEl.textContent='';
    if(endEl)endEl.textContent='';
    return;
  }
  if(empty)empty.style.display='none';
  // pts is in the GPS session log's own (chronological) order, so the first
  // and last entries bound the whole walk's time span regardless of how the
  // table itself is currently sorted.
  if(startEl)startEl.textContent=pts[0].ts?'Start of trail: '+pts[0].ts:'';
  if(endEl)endEl.textContent=pts[pts.length-1].ts?'End of trail: '+pts[pts.length-1].ts:'';
  // DIST is distance from the PREVIOUS sighting in the log's own
  // (chronological) order -- computed before any display sort, so sorting
  // by another column never changes what each row's distance means.
  let prevLat=null, prevLon=null;
  pts.forEach(p=>{
    p._dist=(prevLat!=null)?haversineM(prevLat,prevLon,+p.lat,+p.lon):null;
    prevLat=+p.lat; prevLon=+p.lon;
  });
  const rows=pts.slice().sort((a,b)=>{
    const k=trSort.k;
    if(k==='_seq')return 0;   // natural (chronological) log order -- no header sorts by this
    if(k==='ssid'||k==='kind'||k==='vendor') return trSort.dir*(''+(a[k]||'')).localeCompare(''+(b[k]||''));
    return trSort.dir*((+a[k]||0)-(+b[k]||0));
  });
  tb.innerHTML = rows.map(p=>
    `<tr${p.mac?` style="cursor:pointer" data-mac="${esc(p.mac)}" onclick="showMacInfo(this.dataset.mac)"`:''}>`+
    `<td class="ssid">${esc(p.ssid||(p.hid?'‹hidden›':''))}</td>`+
    `<td>${wifiKindBadge(p.kind)}</td>`+
    `<td class="rssi">${p.rssi}</td>`+
    `<td>${(+p.lat).toFixed(6)}</td>`+
    `<td>${(+p.lon).toFixed(6)}</td>`+
    `<td><a class="maclink" style="border-bottom:none;display:inline-flex" href="https://www.google.com/maps?q=${+p.lat},${+p.lon}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="open in Google Maps">${MAP_PIN_ICON}</a></td>`+
    `<td class="muted">${p._dist==null?'&mdash;':fmtDist(p._dist)}</td>`+
    `<td>${p.vendor?esc(p.vendor):(p.rnd?'<span class="muted">(random addr)</span>':'<span class="muted">(unknown OUI)</span>')}</td></tr>`
  ).join('');
}

/**
 * Repaints the current view from already-cached data (no network fetch), refreshing devices, radar, channel density, or deauth/handshake tables as appropriate.
 */
function paintCache(){
  if(radarMode==='wifi') lastDevs=wifiToDevs(lastWifi);
  if(curView==='chan'){ drawChanDensity(); return; }
  if(curView==='trail'){ drawTrail(); return; }
  if(curView==='deauth'){ renderDeauth(); renderHandshakes(); return; }
  drawRadar(lastDevs); renderDevices();
}
const CFG_KEYS=['clientAgg','capchan','scoutchan','dband','scoutchan5','capdual','capchan5',
  'capdata','scoutdata','scouttypes','captypes','scoutpause','scoutpause24','scoutpause5',
  'cappause24','cappause5','frames','retain','ttlmin','pollms','logonly'];
let lastCfg={};
/**
 * Merges a subset of persistent config fields (`CFG_KEYS`) between an incoming `/api/data` payload and the cached `lastCfg`, so a field missing from one poll doesn't clear the UI.
 * @param d Data object from `/api/data`, mutated in place with any fallback values filled in.
 */
function mergeCfg(d){
  CFG_KEYS.forEach(k=>{ if(d[k]!==undefined)lastCfg[k]=d[k]; else if(lastCfg[k]!==undefined)d[k]=lastCfg[k]; });
}
let lastSnapSaveTs=0;
/**
 * Saves a throttled (max once per 4s) snapshot of the current WiFi/assoc/deauth/handshake data to `localStorage` for session restore.
 * @param d Data object from `/api/data`, providing `assoc`.
 */
function saveSnapCache(d){
  const now=Date.now();
  if(now-lastSnapSaveTs<4000) return;
  lastSnapSaveTs=now;
  try{
    const snap={app:'802Eleven',version:1,exported:new Date().toISOString(),
      wifi:{wifi:lastWifi||[],assoc:d.assoc||[],deauth:lastDeauth||[],handshake:lastHandshake||[]}};
    localStorage.setItem('lastSnap',JSON.stringify(snap));
  }catch(e){}
}
/**
 * Applies an `/api/data` (or WebSocket) payload to all WiFi UI state: sentinel panels, channel/scan config sync, associations, deauth/handshake lists, device table/radar, and the session snapshot cache. No-op while polling is off or a capture is in progress.
 * @param d Parsed `/api/data` JSON payload.
 */
function processData(d){
  if(typeof sentinelEverRan!=='undefined'){
    sentinelEverRan=!!d.sentinel;
    syncSentinelOnlyUI();
  }
  if(!liveOn||capturing) return;
  if(typeof modeChosen!=='undefined'&&!modeChosen) return;
  hideAuth();
  const _rst=document.getElementById('ioStatus');
  if(_rst&&_rst.textContent==='Restored last session -- reconnecting…') _rst.textContent='';
  mergeCfg(d);
  try{
    syncPollMs(d.pollms);
    if(typeof renderSentinelPanel==='function')renderSentinelPanel(d.sentinel);
    if(typeof renderSentinelView==='function')renderSentinelView(d.sentinel);
    if(d.sentinel&&d.sentinel.rogue&&d.sentinel.rogue.hits){
      rogueByMac=new Map();
      d.sentinel.rogue.hits.forEach(h=>rogueByMac.set(h.mac,h));
    }
    const wifi = true;
    if(d.clientAgg && d.scout){
      if(!wifiClientAgg.size) wifiAggLoad();
      ensureWifiSyncPush();
      d.wifi = wifiAggAry();
      wifiAggActive = true;
    } else if(wifi && wifiAggActive){
      (d.wifi||[]).forEach(mergeWifiRowIntoAgg);
      (d.assoc||[]).forEach(mergeAssocRowIntoAgg);
      d.wifi = wifiAggAry();
      d.assoc = wifiAggAssocAry();
      ensureWifiSyncPush();
    }

    scoutLinked=!!d.scout;
    syncScoutOnlyUI();
    if(scoutLinked&&typeof framesMode!=='undefined'&&framesMode==='detail')setFramesMode('simple');
    const capScoutTabs=document.getElementById('capScoutTabs');
    if(capScoutTabs)capScoutTabs.style.display=scoutLinked?'':'none';
    if(!scoutLinked){
      const ctabScout=document.getElementById('ctabScout');
      if(ctabScout&&ctabScout.classList.contains('on'))capTab('cap');
    }
    if(setOpen)renderScoutStatus();
    if(d.capchan!=null)capActive=+d.capchan||0;
    if(!capPopOn()){
      if(d.capchan!=null)capMask=+d.capchan||0;
      if(d.capchan5!=null)capMask5=+d.capchan5||0;
      if(d.scoutchan!=null)scoutMask=+d.scoutchan||0;
      if(d.scoutchan5!=null)scoutMask5=+d.scoutchan5||0;
    }
    if(typeof syncCapBand==='function')syncCapBand(d.capdual);
    if(typeof syncScoutBand==='function')syncScoutBand(d.dband);
    applyChanFilter();
    if(wifi) buildAssoc(d.assoc);
    newStationMacs = (wifi&&preCaptureStationMacs) ? new Set(Object.keys(wifiClientAp).filter(m=>!preCaptureStationMacs.has(m))) : new Set();
    lastDeauth = wifi ? (d.deauth||[]) : [];
    lastHandshake = wifi ? (d.handshake||[]) : [];
    if(typeof notifyHandshakeReady==='function')notifyHandshakeReady(lastHandshake);
    if(typeof syncSendFrameStatus==='function'){
      lastInject = (wifi&&d.injact!=null) ? {active:!!d.injact, sent:+d.injsent||0, ok:+d.injok||0} : null;
      syncSendFrameStatus(lastInject);
      if(typeof syncFrameCraftStatus==='function')syncFrameCraftStatus(lastInject);
    }
    if(!capPopOn()) syncCapData(d.capdata);
    syncScoutData(d.scoutdata);
    syncClientAgg(d.clientAgg);
    syncScoutTypes(d.scouttypes);
    if(!capPopOn()) syncCapTypes(d.captypes);
    if(!capPopOn()){ syncCapBandPause24(d.cappause24); syncCapBandPause5(d.cappause5); }
    syncScoutPause(d.scoutpause);
    syncScoutBandPause24(d.scoutpause24);
    syncScoutBandPause5(d.scoutpause5);
    syncTtl(d.ttlmin);
/* @GUARD:IF WITH_FRAMES */    if(typeof syncFramesArm==='function')syncFramesArm(d.frames);
/* @ENDGUARD */    const hde=document.getElementById('hde'), hde2=document.getElementById('hde2');
    const authN=lastDeauth.length+lastHandshake.length;
    if(hde)hde.textContent=authN; if(hde2)hde2.textContent=authN;
    if(curView==='deauth'){ renderDeauth(); renderHandshakes(); }
    const devs = wifiToDevs(d.wifi);
    document.getElementById('hd').textContent=devs.length;
    const hd2=document.getElementById('hd2');
    if(hd2)hd2.textContent=devs.length;
    lastWifi = d.wifi||[];
    syncGpsFocusUI();
    if(capPopOn())refreshIntelliInfo();
    newWifiMacs = preCaptureMacs ? new Set(lastWifi.filter(x=>!preCaptureMacs.has(x.mac)).map(x=>x.mac)) : new Set();
    syncAutoExpandToRadar();
    if(Object.keys(ouiMap).length){
      devs.forEach(x=>{ if(x.oui){const v=ouiVendor(x.mac); if(v)x.vendor=v;} });
      lastWifi.forEach(x=>{ if(!x.rnd){const v=ouiVendor(x.mac); if(v)x.vendor=v;} });
    }
    if(curView==='chan') drawChanDensity();
    lastDevs=devs; updateRefInfo(devs);
    const live={};
    devs.forEach(dv=>{live[dv.mac]=1;
      const a=rhist[dv.mac]=rhist[dv.mac]||[]; a.push(dv.rssi); if(a.length>90)a.shift();});
    Object.keys(rhist).forEach(m=>{if(!live[m])delete rhist[m];});
    drawRadar(devs);
    renderDevices();
    saveSnapCache(d);
  }catch(e){console.error('processData',e);}
}
/**
 * Fetches `/api/data` and hands the result to `processData()`; redirects to the auth overlay on 401, retries shortly on 404, and swallows network errors. No-op while polling is off, a capture is running, or a send-frame/local-AP operation is in flight.
 */
/* Lite mode: view/resize/sort re-run tick() for a live view; only an explicit
   Refresh (liteRefresh) may pull from the board, so it isn't hammered. */
let liteAllow=!LITE_MODE;
async function tick(){
  if(!liveOn||capturing||sfSending||laSending) return;
  if(!liteAllow) return;
  if(typeof modeChosen!=='undefined'&&!modeChosen) return;
  try{
    const r=await fetch('/api/data');
    if(r.status===401){showAuth();return;}
    if(r.status===404){setTimeout(tick,500);return;}
    hideAuth();
    wsFailStreak=0; hideApLost();
    processData(await r.json());
  }catch(e){}
}
let curView='map';
/**
 * Switches the active dashboard view, running any per-view initialisation, updating tab/nav highlighting, persisting the choice, and refreshing data.
 * @param v Target view id; falls back to 'map' if unrecognized or unavailable in the current radar mode.
 */
function setView(v){
  if(!['map','devices','adverts','scout','chan','trail','deauth','localap','craft','frames','sentinel'].includes(v))v='map';
  if((v==='scout'||v==='chan'||v==='trail'||v==='deauth'||v==='localap'||v==='craft'||v==='frames')&&radarMode!=='wifi')v='map';
  if(v==='trail'&&!gpsCoordsAvailable)v='map';
  curView=v;
  if(v==='deauth'){renderDeauth();renderHandshakes();loadHsFiles().then(loadHsRam);}
  if(v==='localap'&&typeof loadLocalApInfo==='function')loadLocalApInfo();
  if(v==='sentinel'&&typeof sentinelDismissed!=='undefined')sentinelDismissed=false;
  if(v==='frames'){
    if(document.getElementById('framesTabWrap')&&typeof setFramesTab==='function')setFramesTab(framesSubTab);
    else if(typeof renderFramesFeed==='function')renderFramesFeed();
  }
  document.querySelectorAll('.view').forEach(s=>s.classList.toggle('active',s.id==='view-'+v));
  if(v==='chan')drawChanDensity();
  if(v==='trail')drawTrail();
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',t.dataset.v===v));
  document.querySelectorAll('#sidenav button').forEach(b=>b.classList.toggle('on',b.dataset.v===v));
  const mb=document.getElementById('tabMoreBtn');
  if(mb)mb.classList.toggle('on',v==='chan'||v==='trail'||v==='scout'||v==='deauth'||v==='localap'||v==='craft'||v==='frames'||v==='sentinel');
  const tm=document.getElementById('tabMenu'); if(tm)tm.classList.remove('open');
  try{localStorage.setItem('view',v);}catch(e){}
  requestAnimationFrame(()=>liveOn?tick():paintCache());
}
/**
 * Toggles the "more tabs" overflow menu's open state.
 * @param e Optional event to stop propagation on, preventing the outside-click handler from immediately closing it.
 */
function toggleTabMenu(e){ if(e)e.stopPropagation();
  document.getElementById('tabMenu').classList.toggle('open'); }
document.addEventListener('click',e=>{ const m=document.getElementById('tabMenu');
  if(m&&m.classList.contains('open')&&!e.target.closest('.tabmore-wrap')) m.classList.remove('open'); });
document.querySelectorAll('.tab[data-v],#sidenav button[data-v]').forEach(t=>t.onclick=()=>setView(t.dataset.v));
/**
 * Collapses/expands the desktop sidebar panel (sim-only, #sidenavCard, toggled by
 * #navBurger in the header), persisted to localStorage.
 */
function toggleSidenav(){
  const n=document.getElementById('sidenavCard'); if(!n)return;
  const on=n.classList.toggle('collapsed');
  try{localStorage.setItem('navCollapsed',on?'1':'0');}catch(e){}
}
try{if(localStorage.getItem('navCollapsed')==='1')document.getElementById('sidenavCard')?.classList.add('collapsed');}catch(e){}
window.addEventListener('resize',()=>liveOn?tick():paintCache());
if(window.ResizeObserver){
  new ResizeObserver(()=>{
    if(rc.clientWidth!==lastW||(rc.clientHeight||460)!==lastH)drawRadar(lastDevs);
  }).observe(document.getElementById('radarWrap'));
  let lastChanW=0,lastChanH=0;
  new ResizeObserver(()=>{
    if(curView!=='chan')return;
    if(cc.clientWidth!==lastChanW||cc.clientHeight!==lastChanH){
      lastChanW=cc.clientWidth; lastChanH=cc.clientHeight; drawChanDensity();
    }
  }).observe(document.getElementById('chanWrap'));
}
/**
 * Wires click handlers on a table's header cells to drive sorting, toggling sort direction on repeat clicks of the same column.
 * @param id Table element id.
 * @param st Sort-state object with `k` (column key) and `dir` (1 or -1), mutated in place.
 */
function wireSort(id,st){
  document.querySelectorAll('#'+id+' th').forEach(th=>th.onclick=()=>{
    const k=th.dataset.k; if(!k)return;
    st.dir=(st.k===k)?-st.dir:(k==='clients'?-1:1); st.k=k;
    liveOn?tick():paintCache();
  });
}
/**
 * Clears all server-side WiFi data and resets local UI tracking state (history, selection, aggregation caches), then refreshes.
 */
async function clr(){await fetch('/api/clear',{method:'POST'});seenD={};hist={};rhist={};spawnAt={};boxSel=null;
  preCaptureMacs=null; newWifiMacs=new Set();
  preCaptureStationMacs=null; newStationMacs=new Set();
  wifiClientAgg.clear(); wifiAggAssoc.clear(); wifiAggActive=false;
  tick();}
/**
 * Archives the current session (optionally labelled) to SD, then clears all tracked data and UI state for a fresh session.
 * @param label Optional session label to record with the archive.
 */
async function startNewSession(label){
  const s=document.getElementById('memStatus'); if(s)s.textContent='Archiving…';
  await archiveSession(label);
  await clr();
  setRef(null);
  scoutLastId=0; scoutPrevTotal=0;
  const box=document.getElementById('scoutFeed'); if(box)box.innerHTML='';
  if(s)s.textContent='New session started.';
  refreshSysInfo();
}
/**
 * Opens a confirmation dialog, with an optional label input, to start a new session.
 */
function requestNewSession(){
  openConfirm('Start a new session? Archives the current data to SD (if a card is present), '+
    'then clears all tracked devices, the WiFi sync cache, and the pinned target.',
    'Start new',doNewSession,
    '<input id="sessLabelInput" type="text" maxlength="24" placeholder="Label (optional), e.g. lobby-wifi" style="width:100%">');
}
/**
 * Reads the new-session label input and starts a new session with it.
 */
async function doNewSession(){
  const inp=document.getElementById('sessLabelInput');
  const label=inp?inp.value.trim():'';
  await startNewSession(label);
}
wireSort('dt',dSort);
wireSort('det',deSort);
wireSort('trailTbl',trSort);

if(refMac){
  const bi=document.getElementById('band');
  if(bi){bi.value=12;document.getElementById('bandL').textContent='12';
         document.getElementById('bandLbl').textContent='radar focus range ±';}
}
let setOpen=false;
let scoutLinked=false, scoutFrames=null;
/**
 * Renders the Scout connection status pill and frame counter in the Settings > Scout tab.
 */
function renderScoutStatus(){
  const pill=document.getElementById('setScoutPill');
  if(pill)pill.innerHTML=scoutLinked
    ?'<span class="statuspill up"><span class="dot"></span>Connected</span>'
    :'<span class="statuspill down"><span class="dot"></span>Not detected</span>';
  const fr=document.getElementById('setScoutFrames');
  if(fr)fr.textContent=(scoutFrames!=null)?scoutFrames.toLocaleString():'—';
  const vp=document.getElementById('scoutViewPill');
  if(vp){vp.classList.toggle('up',scoutLinked);vp.classList.toggle('down',!scoutLinked);
    vp.innerHTML='<span class="dot"></span>'+(scoutLinked?'Connected':'Not detected');}
}
/**
 * Fetches the current scout link/frame status and updates `scoutLinked`/`scoutFrames`, then re-renders the status display.
 */
async function refreshScoutFrames(){
  try{const d=await(await fetch('/api/wifi/scout?since=999999999')).json();
      scoutLinked=!!d.linked; scoutFrames=d.total; renderScoutStatus();}catch(e){}
}
/**
 * Formats a byte count as a human-readable B/KB/MB string.
 * @param n Byte count, or null/undefined for unknown.
 * @returns Formatted size string, or an em dash placeholder when `n` is null/undefined.
 */
function fmtBytes(n){ if(n==null)return '—';
  if(n<1024)return n+' B';
  if(n<1048576)return (n/1024).toFixed(1)+' KB';
  return (n/1048576).toFixed(2)+' MB'; }
/**
 * Updates a usage progress bar's fill width and percentage label, applying warn/hot colour thresholds.
 * @param barId Element id of the bar container (its first child is resized).
 * @param pctId Element id of the percentage label.
 * @param used Amount used.
 * @param total Total capacity; a non-positive value yields 0%.
 */
function setBar(barId,pctId,used,total){
  const bar=document.getElementById(barId), lbl=document.getElementById(pctId);
  const pct=(total>0)?Math.min(100,Math.round(used/total*100)):0;
  if(lbl)lbl.textContent=pct+'%';
  if(bar){const f=bar.firstElementChild; if(f)f.style.width=pct+'%';
    bar.classList.toggle('warn',pct>=70&&pct<85);
    bar.classList.toggle('hot',pct>=85);}
}
/**
 * Fetches `/api/sysinfo` and updates the Settings > Memory tab's heap, PSRAM, flash, and record-count readouts and usage bars.
 */
async function refreshSysInfo(){
  try{const d=await(await fetch('/api/sysinfo')).json();
    const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
    set('memHeap', fmtBytes(d.heapFree)+' / '+fmtBytes(d.heapSize));
    set('memHeapMin', fmtBytes(d.heapMin));
    set('memPsram', d.psramSize? (fmtBytes(d.psramFree)+' / '+fmtBytes(d.psramSize)) : 'none');
    set('memSketch', fmtBytes(d.sketchUsed)+' used, '+fmtBytes(d.sketchFree)+' free');
    set('memRecords', d.wifi+' wifi');
    setBar('memHeapBar','memHeapPct', d.heapSize-d.heapFree, d.heapSize);
    setBar('memFlashBar','memFlashPct', d.sketchUsed, d.sketchUsed+d.sketchFree);
    const show=(d.hiddb!==undefined);
    ['hidDbRow','hidDbHint'].forEach(id=>{const e=document.getElementById(id);if(e)e.style.display=show?'':'none';});
    if(show)set('hidDbCount', d.hiddb+(d.hiddb===1?' name saved':' names saved'));
    updateFlushOptions(show);
  }catch(e){}
}
/**
 * Adds or removes the "Hidden network DB" option from the flush-target select, based on whether a hidden-network DB exists.
 * @param show Whether the hidden-DB option should be present.
 */
function updateFlushOptions(show){
  const sel=document.getElementById('flushTarget'); if(!sel)return;
  const has=[...sel.options].some(o=>o.value==='hidden');
  if(show&&!has){const o=document.createElement('option');o.value='hidden';o.textContent='Hidden network DB';sel.appendChild(o);}
  if(!show&&has){[...sel.options].forEach(o=>{if(o.value==='hidden')o.remove();});}
}
/**
 * Opens a confirmation dialog to flush the currently selected data target (all records or the hidden network DB).
 */
function requestFlush(){
  const sel=document.getElementById('flushTarget'); if(!sel)return;
  const t=sel.value, label=t==='hidden'?'hidden network DB':'all records';
  openConfirm('Flush '+label+'? This cannot be undone.','Flush',()=>doFlush(t));
}
/**
 * Performs the flush for the given target.
 * @param t Flush target: 'hidden' for the hidden network DB, otherwise all records.
 */
async function doFlush(t){
  if(t==='hidden')await flushHiddenDb(); else await flushRecords();
}
/**
 * Clears all tracked records via `clr()` and updates the memory status message.
 */
async function flushRecords(){
  const s=document.getElementById('memStatus'); if(s)s.textContent='Flushing…';
  await clr();
  if(s)s.textContent='Flushed.';
  refreshSysInfo();
}
/**
 * Erases the hidden-network name database on the server.
 */
async function flushHiddenDb(){
  const s=document.getElementById('memStatus'); if(s)s.textContent='Flushing hidden DB…';
  try{await fetch('/api/security/hiddb',{method:'POST'});}catch(e){}
  if(s)s.textContent='Hidden network DB erased.';
  refreshSysInfo();
}
let setTab=null;
/**
 * Switches the active Settings modal tab pane and triggers that tab's data refresh.
 * @param name Tab identifier (`stab` dataset value) to activate.
 */
function setSettingsTab(name){
  setTab=name;
  document.querySelectorAll('#setModal .stab-pane').forEach(p=>{p.style.display=(p.dataset.stab===name)?'':'none';});
  let btn=null;
  document.querySelectorAll('#setModal .settab').forEach(b=>{
    const on=b.dataset.stab===name; b.classList.toggle('on',on); if(on)btn=b; });
  const cur=document.getElementById('setTabCur'); if(cur&&btn)cur.textContent=btn.textContent;
  const menu=document.getElementById('setTabMenu'); if(menu)menu.classList.remove('open');
  if(name==='mem')refreshSysInfo();
  if(name==='data')refreshSessionList();
  if(name==='network'){loadSecInfo();loadApInfo();loadStaInfo();loadCaptiveInfo();loadMacInfo();}
  if(name==='scout'&&typeof refreshScoutFrames==='function'){renderScoutStatus();refreshScoutFrames();}
}
/**
 * Toggles the T-Dongle / Sentinel popover from the header icon.
 * Refreshes the dongle controls from /api/sysinfo each time it opens.
 */
function onDongleBtn(){
  const p=document.getElementById('dongPop'), b=document.getElementById('dongleBtn'); if(!p||!b)return;
  const open=p.classList.toggle('on'); b.classList.toggle('popopen',open);
  if(open){
    fitPopInViewport('dongPop','dongleBtn');
    if(typeof renderSentChips==='function')renderSentChips();
    if(typeof sentDualBand!=='undefined'&&sentDualBand&&typeof renderSentChips5==='function')renderSentChips5();
    if(typeof loadDongleInfo==='function')loadDongleInfo();
  }
}
/**
 * Switches the dongle popover's active tab (Display/Power/Device/Sentinel) and shows its pane.
 * @param name Tab key: 'display', 'power', 'device', or 'sentinel'.
 */
function dongTab(name){
  const panes={display:'dongPaneDisplay',device:'dongPaneDevice',sentinel:'dongPaneSentinel'};
  const tabs={display:'dtabDisplay',device:'dtabDevice',sentinel:'dtabSentinel'};
  for(const k in panes){
    const pane=document.getElementById(panes[k]); if(pane)pane.style.display=(k===name)?'':'none';
    const tab=document.getElementById(tabs[k]); if(tab)tab.classList.toggle('on',k===name);
  }
}
document.addEventListener('click',e=>{
  const p=document.getElementById('dongPop'); if(!p||!p.classList.contains('on'))return;
  if(e.target.closest('#dongPop')||e.target.closest('#dongleBtn'))return;
  p.classList.remove('on'); document.getElementById('dongleBtn').classList.remove('popopen'); });
/**
 * Toggles the Settings tab overflow menu, positioning it under its trigger button when opening.
 * @param e Optional event to stop propagation on.
 */
function toggleSetTabMenu(e){
  if(e)e.stopPropagation();
  const m=document.getElementById('setTabMenu'), btn=document.getElementById('setTabMoreBtn');
  if(!m)return;
  const willOpen=!m.classList.contains('open');
  if(willOpen&&btn){
    const r=btn.getBoundingClientRect();
    m.style.position='fixed';
    m.style.top=(r.bottom+4)+'px';
    m.style.left=r.left+'px';
    m.style.right=(window.innerWidth-r.right)+'px';
  }
  m.classList.toggle('open',willOpen);
}
document.addEventListener('click',e=>{ const m=document.getElementById('setTabMenu');
  if(m&&m.classList.contains('open')&&!e.target.closest('.settabs-wrap')) m.classList.remove('open'); });
let secGateOn=false;
/**
 * Fetches `/api/sysinfo` and updates the Security tab's password-gate status text and conditional row visibility.
 */
async function loadSecInfo(){
  const st=document.getElementById('secStatus'),rb=document.getElementById('secReset'),
        or=document.getElementById('secOldRow'),db=document.getElementById('secDisableBtn');
  try{const d=await(await fetch('/api/sysinfo')).json();
    secGateOn=!!d.gate;
    if(st)st.textContent=d.gate?('On'+(d.gatenvs?' (custom)':' (default)')):'Off';
    if(rb)rb.style.display=(d.gatedef&&d.gatenvs)?'':'none';
    if(or)or.style.display=d.gate?'':'none';
    if(db)db.style.display=d.gate?'':'none';
  }catch(e){if(st)st.textContent='—';}
}
/**
 * Reads the current-password input's value.
 * @returns The entered current password, or an empty string if the input is missing.
 */
function secOldVal(){const o=document.getElementById('secOld');return o?o.value:'';}
/**
 * Posts an old-password-prefixed body to a password-gate endpoint, surfacing auth/CSRF/validation errors in the status message.
 * @param url Endpoint to POST to.
 * @param newPw New password value to send (or null for endpoints that don't need one, e.g. reset).
 * @returns The fetch `Response` on success, or null if the request was rejected or blocked.
 */
async function secPost(url,newPw){
  const m=document.getElementById('secStatusMsg');
  if(secGateOn&&!secOldVal()){if(m)m.textContent='Enter your current password.';return null;}
  const body=secOldVal()+'\n'+(newPw==null?'':newPw);
  const r=await fetch(url,{method:'POST',body});
  if(r.status===403){try{const j=await r.json();
    if(m)m.textContent=j.err==='oldpass'?'Current password is incorrect.':'Blocked (CSRF).';}
    catch(e){if(m)m.textContent='Blocked.';}return null;}
  if(!r.ok){if(m)m.textContent='Not authorized — sign in first.';return null;}
  return r;
}
/**
 * Validates and saves a new UI password (or disables the gate), then reloads the gate status.
 * @param force Pass `''` to disable the gate directly, or omit to read/validate the new-password fields.
 */
async function savePass(force){
  const p1=document.getElementById('secPass1'),p2=document.getElementById('secPass2'),
        o=document.getElementById('secOld'),m=document.getElementById('secStatusMsg');
  let pw;
  if(force===''){pw='';}
  else{pw=p1?p1.value:''; const c=p2?p2.value:'';
    if(pw!==c){if(m)m.textContent='New passwords do not match.';return;}}
  if(m)m.textContent='Saving…';
  try{const r=await secPost('/api/auth/setpass',pw);
    if(!r)return;
    if(p1)p1.value='';if(p2)p2.value='';if(o)o.value='';
    if(m)m.textContent=pw?'Password updated. Other browsers signed out.':'Gate disabled.';
    loadSecInfo();
  }catch(e){if(m)m.textContent='Error saving.';}
}
/**
 * Reverts the UI password to the firmware-compiled default, then reloads the gate status.
 */
async function resetPass(){
  const o=document.getElementById('secOld'),m=document.getElementById('secStatusMsg');
  if(m)m.textContent='Reverting…';
  try{const r=await secPost('/api/auth/setpass?reset=1',null);
    if(!r)return;
    if(o)o.value='';
    if(m)m.textContent='Reverted to firmware default.';
    loadSecInfo();
  }catch(e){if(m)m.textContent='Error reverting.';}
}
/**
 * Shows or hides the AP password field based on whether the open/WPA2 radio selection is open.
 */
function apSecChanged(){
  const open=document.querySelector('input[name="apSec"]:checked').value==='open';
  const row=document.getElementById('apPassRow'); if(row)row.style.display=open?'none':'';
}
let apQrOpen=false;
/**
 * Toggles the AP join QR code box, loading the QR image and prefetching AP credentials when opened.
 */
function toggleApQr(){
  apQrOpen=!apQrOpen;
  const box=document.getElementById('apQrBox'), img=document.getElementById('apQrImg'),
        frame=document.getElementById('apQrFrame');
  if(apQrOpen){
    if(img)img.src='/api/network/apqr'; if(box)box.style.display='';
    if(frame){frame.classList.remove('revealed');clearTimeout(qrRevealTimers.apQrFrame);}
    apCredsCache=null; prefetchApCreds();
  }else if(box)box.style.display='none';
}
/**
 * Closes the AP join QR code box.
 */
function closeApQr(){ apQrOpen=false; const box=document.getElementById('apQrBox'); if(box)box.style.display='none'; }
document.addEventListener('click',e=>{ if(!apQrOpen)return;
  if(!e.target.closest('#apQrBox')&&!e.target.closest('#apQrBtn')) closeApQr(); });
/**
 * Fetches the current AP configuration and populates the SSID, security, visibility, and reset-button fields in Settings.
 */
async function loadApInfo(){
  const s=document.getElementById('apSsid'), rb=document.getElementById('apResetBtn'),
        m=document.getElementById('apStatusMsg');
  try{const d=await(await fetch('/api/network/ap')).json();
    if(s)s.value=d.ssid||'';
    const r=document.querySelector('input[name="apSec"][value="'+(d.open?'open':'wpa2')+'"]');
    if(r){r.checked=true;apSecChanged();}
    const rv=document.querySelector('input[name="apVis"][value="'+(d.hidden?'hidden':'visible')+'"]');
    if(rv)rv.checked=true;
    if(rb)rb.style.display=d.custom?'':'none';
    if(m)m.textContent='';
  }catch(e){if(m)m.textContent='—';}
}
/**
 * Validates and applies new AP SSID/security/visibility/password settings, restarting the AP on success.
 */
async function saveApSettings(){
  const s=document.getElementById('apSsid'), p=document.getElementById('apPass'),
        m=document.getElementById('apStatusMsg');
  const ssid=s?s.value.trim():'';
  const open=document.querySelector('input[name="apSec"]:checked').value==='open';
  const hidden=document.querySelector('input[name="apVis"]:checked').value==='hidden';
  const pass=p?p.value:'';
  if(!ssid){if(m)m.textContent='Network name is required.';return;}
  if(!open&&pass&&(pass.length<8||pass.length>63)){if(m)m.textContent='WPA2 password must be 8-63 characters.';return;}
  if(m)m.textContent='Applying… AP will restart, this device will disconnect.';
  const body='ssid='+encodeURIComponent(ssid)+'&sec='+(open?'open':'wpa2')+'&pass='+encodeURIComponent(pass)+'&hidden='+(hidden?'1':'0');
  try{
    const r=await(await fetch('/api/network/ap',{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body})).json();
    if(m)m.textContent=r.ok?('Applied. Rejoin the network as "'+r.ssid+'".'):'Rejected (check name/password length).';
    if(p)p.value='';
    if(r.ok){loadApInfo();closeApQr();}
  }catch(e){if(m)m.textContent='Error applying (AP may already be restarting).';}
}
/**
 * Fetches `/api/sysinfo` and syncs the captive-portal toggle button's active state.
 */
async function loadCaptiveInfo(){
  const b=document.getElementById('captiveBtn'); if(!b||b.dataset.busy)return;
  try{const d=await(await fetch('/api/sysinfo')).json();
    b.classList.toggle('on',!!d.captive);
  }catch(e){}
}
/**
 * Reverts the AP SSID/security/password to firmware defaults, restarting the AP.
 */
async function resetApSettings(){
  const m=document.getElementById('apStatusMsg');
  if(m)m.textContent='Reverting… AP will restart, this device will disconnect.';
  try{
    const r=await(await fetch('/api/network/ap?reset=1',{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body:''})).json();
    if(m)m.textContent=r.ok?('Reverted to "'+r.ssid+'".'):'Error reverting.';
    if(r.ok){loadApInfo();closeApQr();}
  }catch(e){if(m)m.textContent='Error reverting (AP may already be restarting).';}
}
const staStatusLabel=['Off','Connecting…','Connected','Failed'];
let staPollTimer=null;
/**
 * Fetches the current station (client-mode WiFi) status and updates the STA form fields and connection status text.
 * @returns The fetched status object, or null on error.
 */
async function loadStaInfo(){
  const s=document.getElementById('staSsid'), st=document.getElementById('staStatus'),
        eb=document.getElementById('staEnBtn'), fb=document.getElementById('staForgetBtn');
  try{const d=await(await fetch('/api/network/sta')).json();
    if(s&&document.activeElement!==s)s.value=d.ssid||'';
    let label=d.en?staStatusLabel[d.status]:'Off (disabled)';
    if(st)st.textContent=label+(d.status===2&&d.ip?(' — '+d.ip+(d.rssi!=null?' ('+d.rssi+' dBm)':'')):'');
    if(eb){eb.textContent=d.en?'Disable':'Enable';eb.style.display=d.ssid?'':'none';}
    if(fb)fb.style.display=d.ssid?'':'none';
    return d;
  }catch(e){if(st)st.textContent='—';return null;}
}
/**
 * Polls the station connection status every second until it leaves the "connecting" state or an 18s deadline passes, then reports the outcome.
 */
function pollStaUntilResolved(){
  if(staPollTimer)clearInterval(staPollTimer);
  const m=document.getElementById('staStatusMsg');
  const deadline=Date.now()+18000;
  staPollTimer=setInterval(async()=>{
    const d=await loadStaInfo();
    if(!d)return;
    if(d.status===1&&Date.now()<deadline)return;
    clearInterval(staPollTimer);staPollTimer=null;
    if(!m)return;
    if(d.status===2)m.textContent='Connected'+(d.ip?(' — '+d.ip):'')+'.';
    else if(d.status===3)m.textContent='Failed to connect (check name/password).';
    else if(d.status===1)m.textContent='Still connecting… check status above.';
    else m.textContent='';
  },1000);
}
/**
 * Enables or disables station mode based on the enable button's current label, then polls for the outcome.
 */
async function toggleStaEnabled(){
  const eb=document.getElementById('staEnBtn'), m=document.getElementById('staStatusMsg');
  const enable=eb&&eb.textContent==='Enable'?1:0;
  try{
    await fetch('/api/network/sta?enable='+enable,{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body:''});
    if(m)m.textContent=enable?'Enabled — connecting…':'Disabled.';
    if(enable)pollStaUntilResolved();else setTimeout(loadStaInfo,200);
  }catch(e){if(m)m.textContent='Error.';}
}
/**
 * Validates and submits new station-mode SSID/password settings, then polls for the connection outcome.
 */
async function saveStaSettings(){
  const s=document.getElementById('staSsid'), p=document.getElementById('staPass'),
        m=document.getElementById('staStatusMsg');
  const ssid=s?s.value.trim():'';
  const pass=p?p.value:'';
  if(!ssid){if(m)m.textContent='Network name is required.';return;}
  if(pass&&(pass.length<8||pass.length>63)){if(m)m.textContent='Password must be 8-63 characters (or blank for an open network).';return;}
  if(m)m.textContent='Connecting…';
  const body='ssid='+encodeURIComponent(ssid)+'&pass='+encodeURIComponent(pass);
  try{
    const r=await(await fetch('/api/network/sta',{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body})).json();
    if(m)m.textContent=r.ok?'Joining "'+r.ssid+'"…':'Rejected (check name/password length).';
    if(p)p.value='';
    if(r.ok)pollStaUntilResolved();
  }catch(e){if(m)m.textContent='Error applying.';}
}
/**
 * Forgets the saved station-mode network credentials and refreshes STA status.
 */
async function forgetStaSettings(){
  const m=document.getElementById('staStatusMsg');
  if(staPollTimer){clearInterval(staPollTimer);staPollTimer=null;}
  try{
    await fetch('/api/network/sta?forget=1',{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body:''});
    if(m)m.textContent='Forgotten.';
    loadStaInfo();
  }catch(e){if(m)m.textContent='Error.';}
}
let macRandLast_=true, staMacLinked_=false;
/**
 * Fetches the AP and station MAC addresses/settings and populates the MAC settings fields, skipping any field currently focused for editing.
 */
async function loadMacInfo(){
  const am=document.getElementById('apMac'), sm=document.getElementById('staMac'),
        lb=document.getElementById('staMacLinkBtn'), rb=document.getElementById('macRandBtn');
  try{
    const [ap,sta]=await Promise.all([
      (await fetch('/api/network/ap')).json(), (await fetch('/api/network/sta')).json()]);
    if(am&&document.activeElement!==am)am.value=ap.mac||'';
    if(sm&&document.activeElement!==sm)sm.value=sta.mac||'';
    staMacLinked_=!!sta.maclink; if(lb)lb.classList.toggle('on',staMacLinked_);
    if(sm)sm.disabled=staMacLinked_;
    macRandLast_=!!ap.macrand; if(rb)rb.classList.toggle('on',macRandLast_);
  }catch(e){}
}
/**
 * Validates a MAC address string.
 * @param s Candidate MAC string.
 * @returns True if `s` is empty or matches `aa:bb:cc:dd:ee:ff` format.
 */
function macValid_(s){ return s===''||/^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/.test(s); }
/**
 * Validates and applies a custom AP MAC address, restarting the AP on success.
 */
async function saveApMac(){
  const am=document.getElementById('apMac'), m=document.getElementById('macStatusMsg');
  const mac=am?am.value.trim():'';
  if(!macValid_(mac)){if(m)m.textContent='Invalid MAC (aa:bb:cc:dd:ee:ff, or blank).';return;}
  if(m)m.textContent='Applying… AP will restart.';
  try{
    const r=await(await fetch('/api/network/apmac',{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'mac='+encodeURIComponent(mac)})).json();
    if(m)m.textContent=r.ok?'AP MAC applied.':'Rejected (invalid/multicast address).';
    if(r.ok)loadMacInfo();
  }catch(e){if(m)m.textContent='Error applying (AP may already be restarting).';}
}
/**
 * Validates and saves a custom station MAC address, effective on next reboot.
 */
async function saveStaMac(){
  const sm=document.getElementById('staMac'), m=document.getElementById('macStatusMsg');
  const mac=sm?sm.value.trim():'';
  if(!macValid_(mac)){if(m)m.textContent='Invalid MAC (aa:bb:cc:dd:ee:ff, or blank).';return;}
  if(m)m.textContent='Saving… takes effect on next reboot.';
  try{
    const r=await(await fetch('/api/network/stamac',{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'mac='+encodeURIComponent(mac)})).json();
    if(m)m.textContent=r.ok?'STA MAC saved — takes effect on next reboot.':'Rejected (invalid/multicast address).';
    if(r.ok)loadMacInfo();
  }catch(e){if(m)m.textContent='Error saving.';}
}
/**
 * Toggles whether the STA MAC mirrors the AP MAC via /api/network/stamaclink,
 * updates the status message, and reloads MAC info on success.
 */
async function toggleStaMacLink(){
  const on=!staMacLinked_, m=document.getElementById('macStatusMsg');
  try{
    await fetch('/api/network/stamaclink?on='+(on?1:0),{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body:''});
    if(m)m.textContent=on?'STA MAC now mirrors AP MAC.':'STA MAC unlinked.';
    loadMacInfo();
  }catch(e){if(m)m.textContent='Error.';}
}
/**
 * Toggles MAC randomisation via /api/network/macrand and reloads MAC info.
 */
async function toggleMacRand(){
  const on=!macRandLast_;
  try{
    await fetch('/api/network/macrand?on='+(on?1:0),{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body:''});
    loadMacInfo();
  }catch(e){}
}
/* @GUARD:IF WITH_SECURITYTOOLS */
/**
 * Opens the "similar MAC" modal for the given source MAC, offering to clone
 * it into the AP or STA MAC slot; closes the MAC info modal if it is open.
 * @param mac Source MAC address to offer cloning from.
 */
function openSimilarMac(mac){
  document.getElementById('smBody').innerHTML=`
    <div class="setrow"><span class="k">Source MAC</span><span class="v">${esc(mac)}</span></div>
    <div class="setrow"><span class="k">Clone into</span><span class="v">
      <button data-mac="${esc(mac)}" onclick="useSimilarMac(this.dataset.mac,'ap')">AP MAC</button>
      <button data-mac="${esc(mac)}" onclick="useSimilarMac(this.dataset.mac,'sta')">STA MAC</button></span></div>
    <div class="sethint">Settings &gt; Network &gt; Similar-MAC rand controls whether the last 2 octets re-randomise on clone.</div>`;
  document.getElementById('similarMacModal').classList.add('on');
  if(macModalOpen)closeMacInfo();
}
/**
 * Hides the similar-MAC modal.
 */
function closeSimilarMac(){ document.getElementById('similarMacModal').classList.remove('on'); }
/**
 * Clones a MAC into the AP or STA MAC slot (randomising the last two octets
 * when macRandLast_ is set) and POSTs it to /api/network/apmac or
 * /api/network/stamac.
 * @param mac Source MAC to clone.
 * @param target 'ap' or 'sta' — which MAC slot to write.
 */
async function useSimilarMac(mac,target){
  const mb=mac.split(':');
  if(mb.length!==6){hsToast('Not a usable MAC.');return;}
  let out=mb.slice();
  if(macRandLast_){
    out[4]=(Math.random()*256|0).toString(16).padStart(2,'0');
    out[5]=(Math.random()*256|0).toString(16).padStart(2,'0');
  }
  const cloned=out.join(':');
  const url=target==='ap'?'/api/network/apmac':'/api/network/stamac';
  try{
    const r=await(await fetch(url,{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'mac='+encodeURIComponent(cloned)})).json();
    hsToast(r.ok?((target==='ap'?'AP':'STA')+' MAC set to '+cloned+(target==='ap'?' — AP restarted.':' — takes effect on next reboot.')):'Rejected (invalid/multicast address).');
    if(r.ok&&document.getElementById('macRandBtn'))loadMacInfo();
    closeSimilarMac();
  }catch(e){hsToast('Error applying.');}
}
let localApLastId=0, localApFieldsSeen={}, localApSubTab='network', localApWasActive=false;
/**
 * Parses a "key=value; key=value" field string into a plain object.
 * @param s Semicolon-space-delimited key=value string.
 * @returns Object mapping each key to its value.
 */
function localApParseFields(s){
  const o={};
  (s||'').split('; ').forEach(p=>{ if(!p)return;
    const i=p.indexOf('='); if(i<0){o[p]='';return;} o[p.slice(0,i)]=p.slice(i+1); });
  return o;
}
/**
 * Whether a captured Local-AP row is a bare station-join event rather than a
 * real portal-form submission -- both the primary's and the scout's
 * pushStaConnect_ push exactly {event:'connect', mac:<mac>} and nothing
 * else, so that two-key shape is what tells the two apart.
 * @param fields Parsed field object for one captured row.
 */
function localApIsConnectRow(fields){
  const keys=Object.keys(fields);
  return keys.length===2 && fields.event==='connect' && 'mac' in fields;
}
/** Returns the kind of a non-connect captured row: 'dns'|'http'|'fp'|'other'. */
function localApRecordKind(fields){
  if('dns' in fields) return 'dns';
  if('host' in fields) return 'http';
  if('lang' in fields || 'scr' in fields) return 'fp';
  return 'other';
}
/**
 * Builds one captured-Local-AP table's HTML from a list of row ids.
 * @param ids Row ids (into localApFieldsSeen), newest first.
 * @param emptyMsg Text shown in place of a table when ids is empty.
 * @param connOnly True for the Connections table: drops the event/mac keys
 * from the dynamic column set and shows a fixed "mac" column instead, since
 * a connect-only row never has any other field.
 */
function localApFieldsTable(ids,emptyMsg,connOnly){
  if(!ids.length)return emptyMsg;
  const cols=[];
  ids.forEach(id=>Object.keys(localApFieldsSeen[id].fields).forEach(k=>{
    if(connOnly&&(k==='event'||k==='mac'))return;
    if(!cols.includes(k))cols.push(k);
  }));
  if(connOnly)cols.unshift('mac');
  let h='<div class="scroll"><table><tr><th>When</th>'+cols.map(k=>`<th>${esc(k)}</th>`).join('')+'</tr>';
  ids.forEach(id=>{ const c=localApFieldsSeen[id];
    h+='<tr><td>'+esc(fmtDur(c.age))+' ago</td>'
      +cols.map(k=>`<td>${esc(c.fields[k]||'')}</td>`).join('')+'</tr>';
  });
  return h+'</table></div>';
}
/**
 * Builds the Captured tab HTML split into type-specific sections:
 * DNS Queries / HTTP Probes / Device Fingerprints / Form Submissions.
 */
function localApCapturedHtml(dnsIds,httpIds,fpIds,otherIds){
  if(!dnsIds.length&&!httpIds.length&&!fpIds.length&&!otherIds.length)
    return 'Nothing captured yet — start the AP above to begin.';
  let h='';
  if(dnsIds.length){
    h+='<div class="setsec-hd" style="margin-top:8px">DNS Queries <span class="badge">('+dnsIds.length+')</span></div>';
    h+='<div class="scroll"><table><tr><th>When</th><th>Hostname</th></tr>';
    dnsIds.forEach(id=>{const c=localApFieldsSeen[id];
      h+='<tr><td>'+esc(fmtDur(c.age))+' ago</td><td>'+esc(c.fields.dns||'')+'</td></tr>';});
    h+='</table></div>';
  }
  if(httpIds.length){
    h+='<div class="setsec-hd" style="margin-top:8px">HTTP Probes <span class="badge">('+httpIds.length+')</span></div>';
    h+='<div class="scroll"><table><tr><th>When</th><th>Host</th><th>Path</th><th>UA</th></tr>';
    httpIds.forEach(id=>{const c=localApFieldsSeen[id];
      h+='<tr><td>'+esc(fmtDur(c.age))+' ago</td>'
        +'<td>'+esc(c.fields.host||'')+'</td>'
        +'<td>'+esc(c.fields.path||'')+'</td>'
        +'<td>'+esc(c.fields.ua||'')+'</td></tr>';});
    h+='</table></div>';
  }
  if(fpIds.length){
    const fpCols=['lang','tz','scr','touch','mem','cpu','conn','ua'];
    h+='<div class="setsec-hd" style="margin-top:8px">Device Fingerprints <span class="badge">('+fpIds.length+')</span></div>';
    h+='<div class="scroll"><table><tr><th>When</th>'+fpCols.map(k=>'<th>'+esc(k)+'</th>').join('')+'</tr>';
    fpIds.forEach(id=>{const c=localApFieldsSeen[id];
      h+='<tr><td>'+esc(fmtDur(c.age))+' ago</td>'+fpCols.map(k=>'<td>'+esc(c.fields[k]||'')+'</td>').join('')+'</tr>';});
    h+='</table></div>';
  }
  if(otherIds.length){
    h+='<div class="setsec-hd" style="margin-top:8px">Form Submissions <span class="badge">('+otherIds.length+')</span></div>';
    h+=localApFieldsTable(otherIds,'',false);
  }
  return h;
}
/**
 * Renders the two captured Local-AP panels -- probes/fingerprints grouped by
 * type into #localApFieldList, bare station joins into #localApConnList --
 * from localApFieldsSeen, preserving each panel's horizontal scroll position.
 */
function renderLocalApFields(){
  const ids=Object.keys(localApFieldsSeen).map(Number).sort((a,b)=>b-a);
  const connIds=[],dnsIds=[],httpIds=[],fpIds=[],otherIds=[];
  ids.forEach(id=>{
    const f=localApFieldsSeen[id].fields;
    if(localApIsConnectRow(f)) connIds.push(id);
    else { const k=localApRecordKind(f);
      if(k==='dns') dnsIds.push(id);
      else if(k==='http') httpIds.push(id);
      else if(k==='fp') fpIds.push(id);
      else otherIds.push(id);
    }
  });
  const rows=[
    ['localApFieldList', localApCapturedHtml(dnsIds,httpIds,fpIds,otherIds)],
    ['localApConnList', localApFieldsTable(connIds,'No connections yet — start the AP above to begin.',true)],
  ];
  rows.forEach(([id,html])=>{
    const t=document.getElementById(id); if(!t)return;
    const old=t.querySelector('.scroll'), left=old?old.scrollLeft:0;
    t.innerHTML=html;
    const cur=t.querySelector('.scroll'); if(cur)cur.scrollLeft=left;
  });
}
/**
 * Selects Open or WPA2 on the Local-AP security switch: slides its bezel,
 * shows/hides the WPA2 password row, and records the choice in the hidden
 * #localApSecValue field (localApStart reads that, not the switch itself).
 * @param sec 'open' or 'wpa2'.
 */
function localApSetSec(sec){
  document.querySelectorAll('#localApSecSeg .lap-seg-opt').forEach(b=>b.classList.toggle('on',b.dataset.sec===sec));
  document.getElementById('localApSecValue').value=sec;
  const row=document.getElementById('localApSecPassRow'); if(row)row.style.display=(sec==='wpa2')?'':'none';
}
/**
 * Shows or hides the Captive Portal editor pane when its "Customise portal
 * page" switch is flipped. The AP always serves a portal page regardless
 * (LOCALAP_DEFAULT_HTML if never customised) -- this switch only gates
 * whether the editor is in view, it isn't a feature on/off.
 */
function localApPortalToggleChanged(){
  const on=document.getElementById('localApPortalToggle').checked;
  const tab=document.getElementById('localApPortalTab'); if(tab)tab.style.display=on?'':'none';
  setLocalApTab(on?'portal':'network');
}
/**
 * Reads an HTML file selected via the given file input, rewrites its
 * <form> actions to /localap/submit, and loads the result into the
 * portal-HTML textarea.
 * @param input File input element holding the selected HTML file.
 */
function localApImportHtml(input){
  const f=input.files&&input.files[0], st=document.getElementById('localApImportStatus');
  if(!f)return;
  if(st)st.textContent='Reading '+f.name+'…';
  const reader=new FileReader();
  reader.onload=()=>{
    try{
      const doc=new DOMParser().parseFromString(String(reader.result),'text/html');
      const forms=doc.querySelectorAll('form');
      forms.forEach(fm=>fm.setAttribute('action','/localap/submit'));
      const out=(doc.doctype?'<!doctype html>':'')+doc.documentElement.outerHTML;
      const ta=document.getElementById('localApPortalHtml'); if(ta)ta.value=out;
      let msg='Loaded '+f.name+' — '+forms.length+' form'+(forms.length===1?'':'s')+' pointed at /localap/submit.';
      if(out.length>3000)msg+=' Warning: '+out.length+' bytes exceeds the 3000-byte portal-page limit — trim before starting.';
      if(st)st.textContent=msg;
    }catch(e){ if(st)st.textContent='Could not parse '+f.name+' as HTML.'; }
  };
  reader.onerror=()=>{ if(st)st.textContent='Error reading '+f.name+'.'; };
  reader.readAsText(f);
  input.value='';
}
/**
 * Updates the Local-AP tab's scout-link pill, duration-slider ceiling, and
 * standalone hint to reflect the current scoutLinked state.
 */
function localApSyncScoutUi(){
  const pill=document.getElementById('localApScoutPill');
  if(pill)pill.innerHTML=scoutLinked
    ?'<span class="statuspill up"><span class="dot"></span>Linked</span>'
    :'<span class="statuspill down"><span class="dot"></span>Standalone (this board)</span>';
  const sl=document.getElementById('localApSecs');
  if(sl){
    sl.max=localApSecsMax();
    if(+sl.value>+sl.max)sl.value=sl.max;
    localApSecsInput();
  }
  const hint=document.getElementById('localApHint');
  if(hint)hint.style.display=scoutLinked?'none':'';
}
/**
 * Switches the active Local-AP sub-tab, showing the matching pane and
 * highlighting its tab button.
 * @param name Sub-tab identifier to activate.
 */
function setLocalApTab(name){
  localApSubTab=name;
  document.querySelectorAll('#localApSetupWrap .localapsub-pane').forEach(p=>{
    p.style.display=(p.dataset.rtab===name)?'':'none'; });
  document.querySelectorAll('#localApSetupWrap .localaptab').forEach(b=>{
    b.classList.toggle('on',b.dataset.rtab===name); });
}
let framesSubTab='capture';
/**
 * Switches the Frames view's Capture/Craft sub-tab, showing the matching pane, highlighting its
 * tab button, and (for Capture) rendering the buffered feed.
 * @param name Sub-tab identifier to activate ('capture' or 'craft').
 */
function setFramesTab(name){
  framesSubTab=name;
  document.querySelectorAll('#framesTabWrap .localapsub-pane').forEach(p=>{
    p.style.display=(p.dataset.rtab===name)?'':'none'; });
  document.querySelectorAll('#framesTabWrap .localaptab').forEach(b=>{
    b.classList.toggle('on',b.dataset.rtab===name); });
  if(name==='capture'&&typeof renderFramesFeed==='function')renderFramesFeed();
}
/**
 * Flips the SSID-bar Play/Stop toggle between its idle and running faces,
 * and dims Network/Portal while a run is up -- Network/Portal stay visible
 * (see .running in the stylesheet) rather than the whole wizard collapsing
 * down to a bare Stop button.
 * @param active True to show the running (Stop) face, false to show Play.
 */
function localApSyncActiveUi(active){
  const go=document.getElementById('localApGoBtn'), icon=document.getElementById('localApGoIcon');
  if(go){ go.classList.toggle('on',active); go.title=active?'Stop Local AP':'Start Local AP';
    go.setAttribute('aria-label',go.title); }
  if(icon)icon.innerHTML=active?'<rect x="6" y="6" width="12" height="12"/>':'<path d="M8 5v14l11-7z"/>';
  const view=document.getElementById('view-localap');
  if(view)view.classList.toggle('running',active);
}
/**
 * One step past the duration slider's real 30-minute ceiling: dragging all
 * the way to the end reads as "No limit" instead of a 61st time value.
 * Only reachable when a scout is linked -- a standalone/local run can't
 * outlive the primary's own dashboard, so it's always time-boxed.
 */
const LOCALAP_NOLIMIT_SECS=1830;
/**
 * The duration slider's current ceiling: one step further than usual when a
 * scout is linked (unlocks the "No limit" end-stop), else the plain 30min cap.
 */
function localApSecsMax(){ return scoutLinked?LOCALAP_NOLIMIT_SECS:1800; }
/**
 * Duration-slider readout text for a given seconds value: "No limit" at the
 * scout-linked end-stop, else the plain formatted duration.
 * @param v Slider value in seconds.
 */
function localApSecsLabel(v){ return (scoutLinked&&v>=LOCALAP_NOLIMIT_SECS)?'No limit':fmtDur(v); }
/**
 * Duration slider's oninput handler: refreshes its readout label.
 */
function localApSecsInput(){
  const sl=document.getElementById('localApSecs');
  document.getElementById('localApSecsL').textContent=localApSecsLabel(+sl.value);
}
let localApDefaultDurationSet=false;
/**
 * Initialises the Local-AP tab on open: syncs the scout-link UI, restores
 * the last sub-tab, seeds the default portal HTML if empty, defaults the
 * duration slider to "No limit" the first time a scout is linked (a scout
 * run doesn't cost the dashboard anything, so an unbounded run is the more
 * useful default there -- a standalone run keeps the plain 2m default since
 * it can't outlive the dashboard anyway), and starts status polling.
 */
function loadLocalApInfo(){
  localApSyncScoutUi();
  if(!localApDefaultDurationSet){
    localApDefaultDurationSet=true;
    if(scoutLinked){
      const sl=document.getElementById('localApSecs');
      if(sl){ sl.value=LOCALAP_NOLIMIT_SECS; localApSecsInput(); }
    }
  }
  setLocalApTab(localApSubTab);
  const ph=document.getElementById('localApPortalHtml');
  if(ph&&!ph.value)ph.value=LOCALAP_DEFAULT_HTML;
  localApTick();
}
/**
 * Closes the MAC info modal, switches to the Local-AP view, and prefills
 * its SSID field from a probed network name.
 * @param ssid SSID to prefill (truncated to 32 characters).
 */
function useProbeSsidForLocalAp(ssid){
  closeMacInfo();
  setView('localap');
  const si=document.getElementById('localApSsid');
  if(si)si.value=(ssid||'').slice(0,32);
  setLocalApTab('network');
}
/**
 * Polls /api/security/localap for run status and captured submissions,
 * updates the status/counter UI, and reschedules itself every 2s while a
 * run is active or the Local-AP view is open.
 */
async function localApTick(){
  if(laSending||laFinishing)return;
  localApSyncScoutUi();
  try{
    const d=await(await fetch('/api/security/localap?since='+localApLastId)).json();
    localApSyncActiveUi(!!d.active);
    if(localApWasActive&&!d.active)setLocalApTab('captured');
    localApWasActive=!!d.active;
    const statusText=d.active?(d.unlimited?'Running — no limit':('Running — '+fmtDur(d.secsleft)+' left')):'Idle';
    const st=document.getElementById('localApStatus'); if(st)st.textContent=statusText;
    const goBtn=document.getElementById('localApGoBtn'); if(goBtn)goBtn.title=d.active?statusText:'Start Local AP';
    const subtotal=d.subtotal||0, statotal=d.statotal||0;
    const cb2=document.getElementById('localApFieldCount2'); if(cb2)cb2.textContent='('+subtotal+')';
    const sb2=document.getElementById('localApStaCount2'); if(sb2)sb2.textContent='('+statotal+')';
    const fc=document.getElementById('localApFieldCount'); if(fc)fc.textContent='('+subtotal+')';
    const sc=document.getElementById('localApStaCount'); if(sc)sc.textContent='('+statotal+')';
    document.querySelectorAll('#localApSetupWrap [data-rtab="captured"]').forEach(e=>e.classList.toggle('lap-tab-empty',subtotal===0));
    document.querySelectorAll('#localApSetupWrap [data-rtab="connections"]').forEach(e=>e.classList.toggle('lap-tab-empty',statotal===0));
    const capDot=document.getElementById('localApCapturedDot');
    if(capDot)capDot.classList.toggle('live',!!d.active);
    const connDot=document.getElementById('localApConnDot');
    if(connDot)connDot.classList.toggle('live',!!d.active);
    (d.fields||[]).forEach(c=>{localApFieldsSeen[c.id]={age:c.age,fields:localApParseFields(c.fields)};
      if(c.id>localApLastId)localApLastId=c.id;});
    renderLocalApFields();
    if(!LITE_MODE&&(d.active||curView==='localap'))setTimeout(()=>{if(curView==='localap')localApTick();},2000);
  }catch(e){}
}
let laCrEnd=0, laCrTimer=null;
/**
 * Updates the Local-AP countdown ring (remaining count and arc offset);
 * the ring is shown only while a run is sending or finishing.
 * @param left Seconds/count remaining.
 * @param total Total seconds/count for the run.
 */
function updateLaUI(left,total){
  const el=document.getElementById('localapruns'),
        num=document.getElementById('laCrLeft'),
        arc=document.getElementById('laCrArc');
  if(!el)return;
  if(laSending||laFinishing){
    el.classList.add('on');
    num.textContent=Math.max(0,left);
    const frac=total?Math.max(0,Math.min(1,left/total)):0;
    arc.style.strokeDashoffset=(CR_CIRC*(1-frac)).toFixed(1);
  }else{ el.classList.remove('on'); }
}
/**
 * Loads (or reloads) the AP-credentials QR image, retrying on error while
 * a run is sending or finishing.
 * @param bust When truthy, appends a cache-busting query param to force a reload.
 */
function armLaQr(bust){
  const cq=document.getElementById('laQrImg'); if(!cq) return;
  cq.onerror=()=>{ if(laSending||laFinishing) setTimeout(()=>armLaQr(true),800); };
  cq.onload=()=>{ cq.onerror=null; };
  cq.src='/api/network/apqr'+(bust?('?_='+Date.now()):'');
}
/**
 * Polls /api/data until the dashboard is reachable again after a Local-AP
 * run ends, then restores the UI and resumes normal ticking.
 */
function pollLaReconnect(){
  if(!laFinishing) return;
  fetchTimeout('/api/data').then(r=>{
    if(r.status===401){ laFinishing=false; updateLaUI(0,0); showAuth(); return; }
    if(!r.ok) throw 0;
    return r.json().then(d=>{
      laFinishing=false; updateLaUI(0,0); hideAuth(); processData(d);
      localApSyncActiveUi(false);
      setLocalApTab('captured');
      localApWasActive=false;
      const goBtn=document.getElementById('localApGoBtn'); if(goBtn)goBtn.disabled=false;
      localApTick();
    });
  }).catch(()=>{ if(laFinishing) setTimeout(pollLaReconnect,800); });
}
/**
 * Play/Stop toggle for the SSID-bar icon button (#localApGoBtn): dispatches
 * to localApStart()/localApStop() based on the button's own 'on' class,
 * which localApSyncActiveUi keeps in sync with the run's real active state.
 */
function localApToggle(){
  const go=document.getElementById('localApGoBtn');
  if(go&&go.classList.contains('on'))localApStop(); else localApStart();
}
/**
 * Validates the Local-AP form, POSTs /api/security/localap/start, and
 * either drives the local countdown/QR-reconnect flow (run on this board)
 * or falls back to status polling (run on the linked scout).
 */
async function localApStart(){
  const m=document.getElementById('localApMsg');
  const goBtn=document.getElementById('localApGoBtn');
  if(laSending||(goBtn&&goBtn.disabled))return;
  const ssid=document.getElementById('localApSsid').value.trim();
  const wpa2=document.getElementById('localApSecValue').value==='wpa2';
  const pass=document.getElementById('localApSecPass').value;
  const secsVal=+document.getElementById('localApSecs').value;
  const noLimit=scoutLinked&&secsVal>=LOCALAP_NOLIMIT_SECS;
  const secs=noLimit?'0':secsVal;
  const html=document.getElementById('localApPortalHtml').value;
  const hidden=document.getElementById('localApHidden').checked;
  if(!ssid){if(m)m.textContent='Enter an SSID.';return;}
  if(wpa2&&(pass.length<8||pass.length>63)){if(m)m.textContent='WPA2 password must be 8-63 characters.';return;}
  if(!html.trim()){if(m)m.textContent='Enter the portal page HTML.';return;}
  if(goBtn)goBtn.disabled=true;
  if(m)m.textContent=scoutLinked?'Starting on Scout…':'Starting…';
  const body='ssid='+encodeURIComponent(ssid)+'&sec='+(wpa2?'wpa2':'open')
    +'&pass='+encodeURIComponent(pass)+'&secs='+encodeURIComponent(secs)
    +'&hidden='+(hidden?'1':'0')
    +'&html='+encodeURIComponent(html);
  try{
    const r=await fetch('/api/security/localap/start',{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
    const j=await r.json();
    if(!j.ok){
      if(m)m.textContent=(r.status===409)?'Already running.':'Failed to start (check SSID/password/HTML).';
      if(goBtn)goBtn.disabled=false;
      return;
    }
    if(j.local){
      laSending=true; laFinishing=false;
      hideApLost();
      const secsNum=+j.secs||0;
      const total=secsNum+2;
      laCrEnd=Date.now()+total*1000;
      const ct0=document.getElementById('laCrTitle'); if(ct0)ct0.textContent='Local AP in progress';
      const cp=document.getElementById('laCrParams');
      if(cp)cp.innerHTML=`<span class="cr-tile on">${esc(ssid)}</span>`;
      const cs0=document.getElementById('laCrSub'); if(cs0){cs0.style.display='none';cs0.innerHTML='';}
      const qw0=document.getElementById('laQrWrap'); if(qw0)qw0.style.display='none';
      const qf0=document.getElementById('laQrFrame'); if(qf0){qf0.classList.remove('revealed');clearTimeout(qrRevealTimers.laQrFrame);}
      updateLaUI(secsNum,secsNum);
      armLaQr();
      prefetchApCreds();
      if(m)m.textContent='';
      laCrTimer=setInterval(()=>{
        const left=Math.ceil((laCrEnd-Date.now())/1000);
        if(left>0){updateLaUI(Math.min(left,secsNum),secsNum);}
        else{
          clearInterval(laCrTimer); laCrTimer=null;
          laSending=false; laFinishing=true;
          const ct=document.getElementById('laCrTitle'); if(ct)ct.textContent='Reconnecting…';
          const cs=document.getElementById('laCrSub'); if(cs){cs.style.display='';cs.innerHTML=
            'Run ended -- waiting for this device to rejoin 802Eleven.<br>Scan or copy the code below if it doesn’t reconnect on its own.';}
          const qw=document.getElementById('laQrWrap'); if(qw)qw.style.display='';
          const cq0=document.getElementById('laQrImg');
          if(!(cq0&&cq0.complete&&cq0.naturalWidth>0)) armLaQr(true);
          updateLaUI(0,secsNum);
          pollLaReconnect();
        }
      },250);
    }else{
      if(m)m.textContent='Running on Scout.';
      if(goBtn)goBtn.disabled=false;
      setLocalApTab('captured');
      localApTick();
    }
  }catch(e){ if(m)m.textContent='Error starting.'; if(goBtn)goBtn.disabled=false; }
}
/**
 * POSTs /api/security/localap/stop and refreshes the Local-AP status.
 */
async function localApStop(){
  if(laSending)return;
  const m=document.getElementById('localApMsg');
  if(m)m.textContent='Stopping…';
  try{
    await fetch('/api/security/localap/stop',{method:'POST'});
    if(m)m.textContent='Stopped.';
    localApTick();
  }catch(e){if(m)m.textContent='Error stopping.';}
}
const LOCALAP_DEFAULT_HTML=`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Network Diagnostics</title><body style="font-family:sans-serif;max-width:400px;margin:60px auto;padding:0 16px;text-align:center"><p id=s style="color:#888">Checking connection...</p>(function(){var d={lang:navigator.language||'',tz:(typeof Intl!='undefined'?Intl.DateTimeFormat().resolvedOptions().timeZone:''),scr:screen.width+'x'+screen.height,touch:navigator.maxTouchPoints||0,mem:navigator.deviceMemory||'',cpu:navigator.hardwareConcurrency||'',conn:(navigator.connection&&navigator.connection.effectiveType)||''};var b=Object.keys(d).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(d[k])}).join('&');var x=new XMLHttpRequest();x.open('POST','/localap/submit');x.setRequestHeader('Content-Type','application/x-www-form-urlencoded');x.onload=function(){document.getElementById('s').textContent='Connected.'};x.send(b)})();<\/script></body>`;
/* @ENDGUARD */
/**
 * Opens the settings modal on the last-used tab (or the first tab).
 */
function openSetModal(){
  setOpen=true;
  document.getElementById('setModal').classList.add('on');
  const s=document.getElementById('memStatus'); if(s)s.textContent='';
  const first=document.querySelector('#setModal .settab');
  setSettingsTab(setTab||(first?first.dataset.stab:'general'));
/* @GUARD:IF WITH_WEB_THEMES */  syncWebThemeSelect();
/* @ENDGUARD *//* @GUARD:IF WITH_SENTINEL */  syncSentPopupBtn();
/* @ENDGUARD */}
/**
 * Closes the settings modal.
 */
function closeSetModal(){
  setOpen=false;
  document.getElementById('setModal').classList.remove('on');
}
document.addEventListener('keydown',e=>{if(e.key==='Escape'){const sfm=document.getElementById('sendFrameModal');const mam=document.getElementById('macActMenu');const tam=document.getElementById('tipActMenu');if(closeDevPopovers());else if(nodeMenuMac)hideNodeMenu();else if(sfm&&sfm.classList.contains('on'))closeSendFrame();else if(mam&&mam.classList.contains('on'))closeMacActions();else if(tam&&tam.classList.contains('on'))closeTipActions();else if(macModalOpen)closeMacInfo();else if(setOpen)closeSetModal();else if(tipPinned)hideTip();else if(curView==='map')resetView();}});

let scoutLastId=0, scoutAutoScroll=true, scoutPrevTotal=0, scoutPrevT=0;
/**
 * Toggles scout-feed auto-scroll and updates the pause/play button icon
 * and the feed's paused CSS class.
 * @param btn Button element whose icon reflects the new state.
 */
function toggleScoutScroll(btn){
  scoutAutoScroll=!scoutAutoScroll;
  btn.innerHTML=scoutAutoScroll?'&#9208;':'&#9654;';
  document.getElementById('scoutFeed').classList.toggle('paused',!scoutAutoScroll);
}
/**
 * Maps a scout kind bitmask to its display label and CSS class.
 * @param k Kind bitmask (numeric or numeric string).
 * @returns Two-element array [label, cssClass].
 */
function scoutKind(k){k=+k;
  if(k&2)return['beacon','k-beacon']; if(k&4)return['presp','k-presp']; return['probe','k-probe'];}
/**
 * Decodes a hex string to UTF-8 text, returning the input unchanged if it
 * is not valid hex.
 * @param h Hex-encoded string.
 * @returns Decoded text, or the original string if decoding fails.
 */
function hexToStr(h){h=(h||'').trim();
  if(!/^[0-9a-fA-F]*$/.test(h)||h.length%2)return h;
  const b=new Uint8Array(h.length/2);
  for(let i=0;i<b.length;i++)b[i]=parseInt(h.substr(i*2,2),16);
  try{return new TextDecoder().decode(b);}catch(e){return h;}}
/**
 * Parses one raw scout CSV line (assoc / deauth-disassoc / handshake /
 * directed-probe / injected-deauth-status / default beacon-or-probe) and
 * appends its rendered representation as a child of box.
 * @param box Container element to append the rendered line to.
 * @param l Scout feed line record ({id, s}).
 */
function appendScoutLine(box,l){
  const p=(l.s||'').split(',');
  const div=document.createElement('div');div.className='sfl';
  const mk=(cls,txt)=>{const s=document.createElement('span');s.className=cls;s.textContent=txt;return s;};
  const tag=p[0];
  if(tag==='A'){
    const ssid=hexToStr(p[4]||'');
    div.append(mk('sfa','#'+l.id), mk('sfk k-beacon','assoc'), mk('sfm',p[1]||'?'),
               mk('sfc',' → '), mk('sfm',p[2]||'?'), mk('sfr',' '+(p[3]||'')+'dBm'),
               mk('sfs'+(ssid?'':' empty'),ssid?(' '+ssid):' ‹no ssid›'));
  }else if(tag==='D'){
    div.append(mk('sfa','#'+l.id), mk('sfk k-probe',(+p[5]?'disassoc':'deauth')),
               mk('sfm',p[1]||'?'), mk('sfc',' â‡ '), mk('sfm',p[2]||'?'),
               mk('sfr',' r'+(p[4]||'0')), mk('sfr',' '+(p[6]||'')+'dBm'));
  }else if(tag==='K'){
    div.append(mk('sfa','#'+l.id), mk('sfk k-beacon','EAPOL M'+(p[3]||'?')),
               mk('sfm',p[1]||'?'), mk('sfc',' ⇄ '), mk('sfm',p[2]||'?'),
               mk('sfr',' '+(p[5]||'')+'dBm'),
               ...(p[4]?[mk('sfsec',' PMKID')]:[]));
  }else if(tag==='P'){
    const ssid=hexToStr(p[5]||'');
    div.append(mk('sfa','#'+l.id), mk('sfk k-presp','probe→'), mk('sfm',p[1]||'?'),
               mk('sfc',' ⇢ '), mk('sfm',p[2]||'?'), mk('sfr',' '+(p[3]||'')+'dBm'),
               mk('sfc',' ch'+(p[4]||'')), mk('sfs'+(ssid?'':' empty'),ssid?(' '+ssid):' ‹no ssid›'));
  }else if(tag==='N'&&p[1]==='DEAUTH'){
    const sub=p[2];
    if(sub==='start'){
      div.append(mk('sfa','#'+l.id), mk('sfk k-probe','deauth ⚡'), mk('sfc','sending to '),
                 mk('sfm',p[7]||'?'), mk('sfc',' ('), mk('sfm',p[6]||'?'), mk('sfc',')'),
                 mk('sfr',' '+(p[3]||'')+' '+(p[4]||'')), mk('sfc',' ch'+(p[5]||'')));
    }else if(sub==='tx'){
      const mode=+p[5]?'sustained':'count';
      div.append(mk('sfa','#'+l.id), mk('sfk k-probe','deauth ⚡'),
                 mk('sfr',' '+(p[3]||'0')+(mode==='count'?'/'+(p[4]||'?'):'')+' frames sent'));
    }else{
      div.append(mk('sfa','#'+l.id), mk('sfk k-beacon','deauth done'),
                 mk('sfr',' '+(p[3]||'0')+' frames sent'));
    }
  }else{
    const ssid=hexToStr(p[5]||'');
    const [kl,kc]=scoutKind(p[4]);
    div.append(mk('sfa','#'+l.id), mk('sfm',p[1]||'?'), mk('sfr',' '+(p[2]||'')+'dBm'),
               mk('sfc',' ch'+(p[3]||'')), mk('sfk '+kc,kl),
               mk('sfs'+(ssid?'':' empty'),ssid||'‹no ssid›'));
    if(p.length>6) div.append(mk('sfsec',' sec'+p[6]+'/c'+p[7]+'/p'+p[8]));
  }
  box.appendChild(div);
}
let wifiClientAgg=new Map();
let wifiAggAssoc=new Map();
/**
 * Records or updates a client's association in the client-side
 * wifiAggAssoc map.
 * @param client Client MAC address.
 * @param bssid Associated AP's BSSID.
 * @param rssi Signal strength of the association.
 * @param ssid AP's SSID, if known.
 */
function wifiAggIngestAssoc(client,bssid,rssi,ssid){
  if(!client||!bssid)return;
  const now=Date.now();
  let e=wifiAggAssoc.get(client);
  if(!e){ e={bssid,ssid:ssid||'',rssi,cnt:1,firstMs:now,lastMs:now}; wifiAggAssoc.set(client,e); }
  else{ e.bssid=bssid; if(ssid)e.ssid=ssid; e.rssi=rssi; e.cnt++; e.lastMs=now; }
}
/**
 * Builds the assoc[] JSON-shaped array from wifiAggAssoc.
 * @returns Array of {client,bssid,ssid,rssi,cnt,age,rnd,vendor} entries.
 */
function wifiAggAssocAry(){
  const now=Date.now(),out=[];
  wifiAggAssoc.forEach((e,client)=>{
    const rnd=(parseInt(client.slice(0,2),16)&0x02)!==0;
    out.push({client,bssid:e.bssid,ssid:e.ssid,rssi:e.rssi,cnt:e.cnt,
      age:Math.floor((now-e.lastMs)/1000),rnd:rnd?1:0,vendor:ouiVendor(e.bssid)||''});
  });
  return out;
}
let wifiAggActive=false;
/**
 * Merges one server-provided wifi[] record into the client-side
 * wifiClientAgg map, creating or updating the entry (rssi min/max,
 * kind bits, hidden latch, security fields).
 * @param w Wifi record from the server (mac, rssi, min, max, avg, cnt, ch, kind, ssid, ...).
 */
function mergeWifiRowIntoAgg(w){
  if(!w.mac)return;
  const kindBits=(w.kind==='beacon')?0x06:0x01;
  const now=Date.now();
  let e=wifiClientAgg.get(w.mac);
  if(!e){
    e={rssi:w.rssi,min:w.min,max:w.max,sum:w.avg*(w.cnt||1),cnt:w.cnt||1,
       firstMs:now-(w.life||0)*1000,lastMs:now-(w.age||0)*1000,ch:w.ch,kinds:kindBits,
       ssid:w.ssidbad?'':(w.ssid||''),ssidhex:w.ssidbad?(w.ssidhex||''):'',hid:!!w.hid,
       rnd:!!w.rnd,vendor:w.vendor||'',sec:w.sec||0,cip:w.cip||0,pmf:w.pmf||0,model:w.model||'',modelname:w.modelname||'',mfr:w.mfr||''};
    wifiClientAgg.set(w.mac,e);
  }else{
    e.rssi=w.rssi; if(w.min<e.min)e.min=w.min; if(w.max>e.max)e.max=w.max;
    e.sum=w.avg*(w.cnt||e.cnt); e.cnt=w.cnt||e.cnt; e.lastMs=now-(w.age||0)*1000;
    e.ch=w.ch; e.kinds|=kindBits;
    if(w.hid)e.hid=true;
    if(!w.ssidbad&&w.ssid){e.ssid=w.ssid; e.ssidhex=w.ssidhex||'';}
    if(w.sec)e.sec=w.sec; if(w.cip)e.cip=w.cip; if(w.pmf)e.pmf=w.pmf;
    if(w.model)e.model=w.model;
    if(w.modelname)e.modelname=w.modelname;
    if(w.mfr)e.mfr=w.mfr;
  }
}
/**
 * Merges one server-provided assoc[] record into wifiAggAssoc.
 * @param a Assoc record from the server (client, bssid, ssid, rssi, cnt, age).
 */
function mergeAssocRowIntoAgg(a){
  if(!a.client||!a.bssid)return;
  const now=Date.now();
  let e=wifiAggAssoc.get(a.client);
  if(!e){ e={bssid:a.bssid,ssid:a.ssid||'',rssi:a.rssi,cnt:a.cnt||1,firstMs:now-(a.age||0)*1000,lastMs:now-(a.age||0)*1000}; wifiAggAssoc.set(a.client,e); }
  else{ e.bssid=a.bssid; if(a.ssid)e.ssid=a.ssid; e.rssi=a.rssi; e.cnt=a.cnt||e.cnt; e.lastMs=now-(a.age||0)*1000; }
}
/**
 * Detects an SSID containing the Unicode replacement character or a
 * control character.
 * @param s SSID string to check.
 * @returns True if the SSID contains a replacement or control character.
 */
function ssidLooksBad(s){
  if(!s)return false;
  for(const ch of s){const cp=ch.codePointAt(0); if(cp===0xFFFD||cp<0x20||cp===0x7F)return true;}
  return false;
}
/**
 * Detects an SSID that is empty or made up only of NUL/space characters.
 * @param s SSID string to check.
 * @returns True if the SSID is empty or blank-padded.
 */
function ssidIsBlank(s){
  if(!s)return true;
  for(const ch of s) if(ch!=='\0'&&ch!==' ') return false;
  return true;
}
/**
 * Creates or updates a wifiClientAgg entry for mac from a raw scout/local
 * frame; latches hidden state on a blank-SSID AP frame and never
 * overwrites a known SSID with a blank one.
 * @param mac Source MAC address.
 * @param rssi Signal strength.
 * @param ch Channel.
 * @param kind WK_* kind bitmask.
 * @param ssid Decoded SSID text.
 * @param ssidhex Hex-encoded SSID (kept for blank SSIDs).
 * @param sec Security class, if known.
 * @param cip Cipher, if known.
 * @param pmf PMF state, if known.
 * @param model WPS model, if known.
 * @param mfr WPS manufacturer, if known.
 * @param modelname WPS model name, if known.
 * @returns The created or updated aggregate entry.
 */
function wifiAggIngest(mac,rssi,ch,kind,ssid,ssidhex,sec,cip,pmf,model,mfr,modelname){
  if(!mac)return;
  const rnd=(parseInt(mac.slice(0,2),16)&0x02)!==0;
  const now=Date.now();
  const apKind=(kind&0x06)!==0;
  const blank=ssidIsBlank(ssid);
  let e=wifiClientAgg.get(mac);
  if(!e){
    e={rssi,min:rssi,max:rssi,sum:rssi,cnt:1,firstMs:now,lastMs:now,ch,kinds:kind,
       ssid:blank?'':ssid,ssidhex:blank?'':(ssidhex||''),hid:apKind&&blank,
       rnd,vendor:rnd?'':(ouiVendor(mac)||''),sec:sec||0,cip:cip||0,pmf:pmf||0,model:model||'',modelname:modelname||'',mfr:mfr||''};
    wifiClientAgg.set(mac,e);
  }else{
    e.rssi=rssi; if(rssi<e.min)e.min=rssi; if(rssi>e.max)e.max=rssi;
    e.sum+=rssi; e.cnt++; e.lastMs=now; e.ch=ch; e.kinds|=kind;
    if(apKind&&blank)e.hid=true;
    if(!blank){e.ssid=ssid; e.ssidhex=ssidhex||'';}
    if(sec)e.sec=sec; if(cip)e.cip=cip; if(pmf)e.pmf=pmf;
    if(model)e.model=model;
    if(modelname)e.modelname=modelname;
    if(mfr)e.mfr=mfr;
  }
  return e;
}
/**
 * Reveals a previously-hidden AP's name once a non-blank SSID is learned
 * for its BSSID.
 * @param bssid AP BSSID to reveal.
 * @param ssid Recovered SSID text.
 */
function wifiAggReveal(bssid,ssid){
  if(ssidIsBlank(ssid)||!bssid)return;
  const e=wifiClientAgg.get(bssid);
  if(e&&e.hid&&!e.ssid){e.ssid=ssid; e.ssidhex=hexEncodeStr(ssid);}
}
const WIFI_AGG_CAP=900;
const WIFI_AGG_BEACON_PROTECT_MS=120000;
/**
 * Evicts the oldest, non-recently-active entries from wifiClientAgg once
 * it exceeds WIFI_AGG_CAP, protecting recently-seen APs from eviction.
 */
function wifiAggPrune(){
  if(wifiClientAgg.size<=WIFI_AGG_CAP)return;
  const now=Date.now();
  const entries=[...wifiClientAgg.entries()].map(([mac,rec])=>{
    const isAp=(rec.kinds&0x06)!==0;
    const fresh=isAp&&(now-rec.lastMs)<WIFI_AGG_BEACON_PROTECT_MS;
    return {mac,rec,tier:fresh?2:(isAp?1:0)};
  });
  entries.sort((a,b)=>a.tier!==b.tier ? a.tier-b.tier : a.rec.lastMs-b.rec.lastMs);
  for(let i=0;i<entries.length-WIFI_AGG_CAP;i++)wifiClientAgg.delete(entries[i].mac);
}
/**
 * Builds the wifi[] JSON-shaped array from wifiClientAgg.
 * @returns Array of wifi record objects matching the server's wifi[] shape.
 */
function wifiAggAry(){
  const now=Date.now(),out=[];
  wifiClientAgg.forEach((e,mac)=>{
    const bad=ssidLooksBad(e.ssid);
    out.push({mac,rssi:e.rssi,avg:Math.round(e.sum/e.cnt),min:e.min,max:e.max,cnt:e.cnt,
      age:Math.floor((now-e.lastMs)/1000),life:Math.floor((now-e.firstMs)/1000),ch:e.ch,
      kind:(e.kinds&0x06)?'beacon':'probe',rnd:e.rnd?1:0,
      sec:e.sec,cip:e.cip,pmf:e.pmf,secie:e.sec?1:0,hid:e.hid?1:0,model:e.model||'',modelname:e.modelname||'',mfr:e.mfr||'',
      vendor:e.vendor,ssid:bad?'':e.ssid,ssidbad:bad?1:0,ssidhex:bad?e.ssidhex:''});
  });
  return out;
}
/**
 * Parses one raw scout/local CSV line (W/P/A tag) and folds it into the
 * client-side aggregate maps.
 * @param raw Raw CSV line (e.g. "W,mac,rssi,ch,...").
 */
function ingestRawWifiLine(raw){
  const p=(raw||'').split(',');
  if(p[0]==='W'){
    wifiAggIngest(p[1],+p[2],+p[3],+p[4],hexToStr(p[5]||''),p[5]||'',+p[6]||0,+p[7]||0,+p[8]||0,hexToStr(p[9]||''),hexToStr(p[10]||''),hexToStr(p[11]||''));
  }else if(p[0]==='P'){
    const ssid=hexToStr(p[5]||'');
    wifiAggIngest(p[1],+p[3],+p[4],1,ssid,p[5]||'');
    wifiAggReveal(p[2],ssid);
  }else if(p[0]==='A'){
    const ssid=hexToStr(p[4]||'');
    wifiAggReveal(p[2],ssid);
    wifiAggIngestAssoc(p[1],p[2],+p[3],ssid);
  }
}
/**
 * Hex-encodes a UTF-8 string.
 * @param s Text to encode.
 * @returns Lowercase hex string.
 */
function hexEncodeStr(s){
  const b=new TextEncoder().encode(s||'');
  let out='';
  for(let i=0;i<b.length;i++)out+=b[i].toString(16).padStart(2,'0');
  return out;
}
/**
 * Serialises the current wifiClientAgg/wifiAggAssoc maps back into
 * scout-protocol CSV lines (W,/A,).
 * @returns Newline-joined CSV lines representing the current aggregate state.
 */
function wifiAggSerialize(){
  const lines=[];
  wifiClientAgg.forEach((e,mac)=>{
    lines.push('W,'+mac+','+e.rssi+','+e.ch+','+e.kinds+','+hexEncodeStr(e.ssid)+
      (e.sec?(','+e.sec+','+e.cip+','+e.pmf+','+hexEncodeStr(e.model||'')+','+hexEncodeStr(e.mfr||'')+','+hexEncodeStr(e.modelname||'')):''));
  });
  wifiAggAssoc.forEach((e,client)=>{
    lines.push('A,'+client+','+e.bssid+','+e.rssi+','+hexEncodeStr(e.ssid));
  });
  return lines.join('\n');
}
let wifiSyncLoaded=false;
/**
 * Loads and ingests the persisted WiFi sync log from /api/session/wifisync
 * once per session.
 */
async function wifiAggLoad(){
  if(wifiSyncLoaded)return; wifiSyncLoaded=true;
  try{
    const txt=await(await fetch('/api/session/wifisync')).text();
    if(txt)txt.split('\n').forEach(l=>{if(l)ingestRawWifiLine(l);});
  }catch(e){}
}
/**
 * Fire-and-forget POST of the serialised aggregate state to
 * /api/session/wifisync.
 */
function wifiAggPush(){
  if(!wifiClientAgg.size)return;
  fetch('/api/session/wifisync',{method:'POST',body:wifiAggSerialize()}).catch(()=>{});
}
let wifiSyncPushT=null;
/**
 * Starts the periodic (45s) background sync of the WiFi aggregate to SD,
 * unless already running or in Lite mode.
 */
function ensureWifiSyncPush(){
  if(wifiSyncPushT||LITE_MODE)return;
  wifiSyncPushT=setInterval(wifiAggPush,45000);
}
/**
 * Manually triggers an immediate sync of the WiFi aggregate to SD and
 * reports the result in #ioStatus.
 */
async function wifiAggPushNow(){
  const st=document.getElementById('ioStatus');
  if(!wifiClientAgg.size){ if(st)st.textContent='Nothing in the WiFi aggregate to sync yet.'; return; }
  if(st)st.textContent='Syncing to SD…';
  try{
    const r=await fetch('/api/session/wifisync',{method:'POST',body:wifiAggSerialize()});
    const j=await r.json().catch(()=>({ok:false}));
    if(st)st.textContent=j.ok?('Synced '+wifiClientAgg.size+' WiFi records to SD.'):'Sync failed (no SD card on this board?).';
  }catch(e){ if(st)st.textContent='Error syncing to SD.'; }
}
/**
 * Applies a scout feed payload: updates frame count/link state, folds new
 * lines into the client aggregate, and, when the Scout view is active,
 * renders them into the feed and updates the frames/s stat line.
 * @param d Scout payload ({total, linked, lines[]}).
 */
function processScout(d){
  if(!liveOn)return;
  scoutFrames=d.total; scoutLinked=!!d.linked;
  if(setOpen||curView==='scout')renderScoutStatus();
  if(d.lines&&d.lines.length){
    d.lines.forEach(l=>ingestRawWifiLine(l.s));
    wifiAggPrune();
  }
  if(curView!=='scout'||radarMode!=='wifi')return;
  const box=document.getElementById('scoutFeed');
  if(d.total<scoutPrevTotal){scoutLastId=0;box.innerHTML='';}
  if(d.lines&&d.lines.length){
    d.lines.forEach(l=>{if(l.id>scoutLastId)scoutLastId=l.id;appendScoutLine(box,l);});
    while(box.childElementCount>400)box.removeChild(box.firstChild);
    if(scoutAutoScroll)box.scrollTop=box.scrollHeight;
  }
  const now=performance.now();let rate='';
  if(scoutPrevT){const dt=(now-scoutPrevT)/1000;if(dt>0)rate=' · '+((d.total-scoutPrevTotal)/dt).toFixed(1)+'/s';}
  scoutPrevT=now;scoutPrevTotal=d.total;
  document.getElementById('scoutStat').textContent=
    (d.linked?'● live':'○ no link')+' · '+d.total+' frames'+rate;
}
/**
 * Polls /api/wifi/scout for new scout feed lines when the Scout tab is
 * open in WiFi mode.
 */
async function scoutTick(){
  if(curView!=='scout'||radarMode!=='wifi')return;
  try{ processScout(await(await fetch('/api/wifi/scout?since='+scoutLastId)).json()); }catch(e){}
}
if(!LITE_MODE) setInterval(()=>{ if(!wsOpen) scoutTick(); },700);
/* @GUARD:IF WITH_FRAMES */
let framesLastId=0, framesAutoScroll=true, framesPrevTotal=0, framesPrevT=0, framesArmed=false;
let frameShow={beacon:true,probe:true,assoc:true,deauth:true,data:true};
/**
 * Current Frames capture mode: 'simple' (small live ring, pushed
 * continuously) or 'detail' (buffers the whole run -- full raw bytes
 * included -- then is delivered and freed in one drain once the run ends).
 * Detailed mode is local-radio-only; forced back to 'simple' whenever a
 * scout is linked, since the scout feed has no Detailed-mode counterpart.
 */
let framesMode='simple';
let framesDetailBuf=[];
/**
 * Switches the Frames capture mode and updates the Simple/Detailed button
 * states. No-op for 'detail' while a scout is linked (local-radio-only
 * feature).
 * @param m 'simple' or 'detail'.
 */
function setFramesMode(m){
  if(m==='detail'&&scoutLinked)return;
  framesMode=m;
  const bs=document.getElementById('framesModeSimple'), bd=document.getElementById('framesModeDetail');
  if(bs)bs.classList.toggle('on',m==='simple');
  if(bd)bd.classList.toggle('on',m==='detail');
}
const FRAME_KIND_CHECK={ffBeacon:'beacon',ffProbe:'probe',ffAssoc:'assoc',ffDeauth:'deauth',ffData:'data'};
/**
 * Maps a WK_* frame-kind bitmask to its display category.
 * @param kind Frame kind bitmask (numeric or numeric string).
 * @returns One of 'assoc'|'deauth'|'data'|'beacon'|'probe'.
 */
function frameCategory(kind){kind=+kind;
  if(kind&0x08)return'assoc'; if(kind&0x10)return'deauth'; if(kind&0xA0)return'data';
  if(kind&0x02)return'beacon'; return'probe';}
/**
 * Decodes a hex string into a per-byte ASCII dump, replacing
 * non-printable bytes with '.'.
 * @param h Hex-encoded byte string.
 * @returns ASCII dump, or '' if h is not valid hex.
 */
function hexToAsciiDump(h){h=(h||'').trim();
  if(!/^[0-9a-fA-F]*$/.test(h)||h.length%2)return'';
  let out='';
  for(let i=0;i<h.length;i+=2){const b=parseInt(h.substr(i,2),16);
    out+=(b>=0x20&&b<0x7f)?String.fromCharCode(b):'.';}
  return out;
}
/**
 * Toggles a Frames-tab kind filter checkbox and re-renders the feed.
 * @param id DOM id of the toggle button (a key of FRAME_KIND_CHECK).
 */
function toggleFrameKind(id){const b=document.getElementById(id);if(!b)return;
  b.classList.toggle('on'); frameShow[FRAME_KIND_CHECK[id]]=b.classList.contains('on');
  renderFramesFeed();}
let frameSearch='', frameSearchT=null;
/**
 * Debounces the Frames-tab search box input and re-renders the filtered
 * feed.
 * @param v Raw search box value.
 */
function onFrameSearch(v){
  clearTimeout(frameSearchT);
  frameSearchT=setTimeout(()=>{frameSearch=(v||'').trim().toLowerCase();renderFramesFeed();},150);
}
/**
 * Clears the Frames-tab search box and re-renders the feed.
 */
function clearFrameSearch(){
  const el=document.getElementById('framesSearch'); if(el)el.value='';
  frameSearch=''; renderFramesFeed();
}
/**
 * Clears the buffered and rendered Frames-tab rows without resetting the
 * server-side stream position.
 */
function clearFramesFeed(){
  framesBuf=[]; framesDetailBuf=[];
  const box=document.getElementById('framesFeed'); if(box)box.innerHTML='';
}
/**
 * Toggles Frames-tab auto-scroll and updates the pause/play button icon
 * and the feed's paused CSS class.
 * @param btn Button element whose icon reflects the new state.
 */
function toggleFramesScroll(btn){
  framesAutoScroll=!framesAutoScroll;
  btn.innerHTML=framesAutoScroll?'&#9208;':'&#9654;';
  document.getElementById('framesFeed').classList.toggle('paused',!framesAutoScroll);
}
/**
 * Start/stop entry point for the Frames dump. Scout-only: arms/disarms the
 * scout's live dump via /api/wifi/opts?frames= (unbounded, runs until Stop).
 * No local-radio fallback -- running the raw frame dump on this board's own
 * radio forced the dashboard AP+httpd offline for the run and reconnect
 * churn fragmented heap badly enough to crash the web server on repeated
 * runs, so it's scout-only now. Use the Serial console's "watch" command for
 * a standalone (no-scout) raw frame dump instead.
 */
async function toggleFramesArm(){
  if(!scoutLinked){
    const st=document.getElementById('framesStat');
    if(st)st.textContent='Frame dump needs a linked scout board. Standalone: use the Serial console "watch" command.';
    return;
  }
  const b=document.getElementById('framesArmBtn'); if(!b||b.dataset.busy)return;
  const want=!framesArmed; b.dataset.busy='1';
  try{const r=await fetch('/api/wifi/opts',{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'frames='+(want?1:0)});
      if(r.ok){const d=await r.json(); syncFramesArm(d.frames);}}
  catch(e){}
  finally{delete b.dataset.busy;}
}
/**
 * Applies a server-reported frames-armed state to framesArmed and the
 * arm/disarm button label.
 * @param v Armed state (0/1); ignored if null/undefined.
 */
function syncFramesArm(v){ if(v==null)return; framesArmed=!!v;
  const b=document.getElementById('framesArmBtn'); if(b)b.textContent=framesArmed?'Stop':'Start';
}
let fdSending=false, fdFinishing=false, fdCrEnd=0, fdCrTimer=null;
/**
 * Updates the local Frame-dump countdown ring (#fdruns/#fdCrLeft/#fdCrArc)
 * while a local run or its post-run reconnect wait is active.
 * @param left Seconds remaining.
 * @param total Total seconds the countdown started from (0 hides the arc fraction).
 */
function updateFdUI(left,total){
  const el=document.getElementById('fdruns'),
        num=document.getElementById('fdCrLeft'),
        arc=document.getElementById('fdCrArc');
  if(!el)return;
  if(fdSending||fdFinishing){
    el.classList.add('on');
    num.textContent=Math.max(0,left);
    const frac=total?Math.max(0,Math.min(1,left/total)):0;
    arc.style.strokeDashoffset=(CR_CIRC*(1-frac)).toFixed(1);
  }else{ el.classList.remove('on'); }
}
/**
 * Loads/reloads the AP-join QR image (#fdQrImg) shown during the post-run
 * reconnect wait, retrying on load failure while the run is still active.
 * @param bust Whether to append a cache-busting query param to the image URL.
 */
function armFdQr(bust){
  const cq=document.getElementById('fdQrImg'); if(!cq) return;
  cq.onerror=()=>{ if(fdSending||fdFinishing) setTimeout(()=>armFdQr(true),800); };
  cq.onload=()=>{ cq.onerror=null; };
  cq.src='/api/network/apqr'+(bust?('?_='+Date.now()):'');
}
/**
 * Polls /api/data until the dashboard AP reconnects after a local Frame-dump
 * run, then clears the finishing state and resumes ticking -- buffered
 * frames flush over /ws right after, same as the scout path.
 */
function pollFdReconnect(){
  if(!fdFinishing) return;
  fetchTimeout('/api/data').then(r=>{
    if(r.status===401){ fdFinishing=false; updateFdUI(0,0); showAuth(); return; }
    if(!r.ok) throw 0;
    return r.json().then(d=>{ fdFinishing=false; updateFdUI(0,0); hideAuth(); processData(d);
      if(framesMode==='detail') requestFramesDrain(); });
  }).catch(()=>{ if(fdFinishing) setTimeout(pollFdReconnect,800); });
}
/**
 * Sends the "framesdrain" WS request for a Detailed-mode run's buffered
 * frames, retrying shortly if the socket isn't open yet (expected right
 * after a local run's AP/WS reconnect -- the browser's own reconnect can
 * lag a beat behind the HTTP poll that triggers this). The server replies
 * with one or more "framesdetail" WS messages (see processFramesDetail),
 * freeing each buffered line's device-side memory as it's sent.
 */
function requestFramesDrain(){
  if(!ws||!wsOpen){ setTimeout(requestFramesDrain,300); return; }
  try{ ws.send(JSON.stringify({t:'framesdrain'})); }catch(e){}
}
/**
 * Arms a bounded local WiFi capture with the raw frame dump on -- POST
 * /api/wifi/capture?secs=N plus either frames=1 (Simple mode) or
 * framesdetail=1 (Detailed mode, see framesMode) -- the primary's own radio
 * leaves AP mode for the window exactly like a plain Capture, so this drives
 * the same countdown-ring / AP-rejoin-QR / reconnect-poll flow as
 * startCapture(), under its own #fdruns overlay/ids so the two can't collide.
 */
async function startFramesLocal(){
  if(scoutLinked||fdSending||fdFinishing)return;
  const b=document.getElementById('framesArmBtn'); if(!b||b.dataset.busy)return;
  const secsEl=document.getElementById('framesSecs');
  const secsVal=Math.max(5,Math.min(60,(secsEl?+secsEl.value:30)||30));
  b.dataset.busy='1';
  framesDetailBuf=[];
  let r=null;
  try{r=await fetch('/api/wifi/capture',{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:'secs='+secsVal+(framesMode==='detail'?'&framesdetail=1':'&frames=1')});}catch(e){}
  delete b.dataset.busy;
  if(!r||!r.ok){ if(r&&r.status===401)showAuth(); return; }
  const j=await r.json();
  if(j.busy){
    const st=document.getElementById('framesStat'); if(st)st.textContent='Radio busy (capture already running).';
    return;
  }
  const secsNum=+j.secs||secsVal;
  fdSending=true; fdFinishing=false;
  hideApLost();
  const total=secsNum+2;
  fdCrEnd=Date.now()+total*1000;
  const ct0=document.getElementById('fdCrTitle'); if(ct0)ct0.textContent='Frame dump in progress';
  const cp=document.getElementById('fdCrParams'); if(cp)cp.innerHTML='<span class="cr-tile on">local radio, '+secsNum+'s</span>';
  const cs0=document.getElementById('fdCrSub'); if(cs0){cs0.style.display='none';cs0.innerHTML='';}
  const qw0=document.getElementById('fdQrWrap'); if(qw0)qw0.style.display='none';
  const qf0=document.getElementById('fdQrFrame'); if(qf0){qf0.classList.remove('revealed');clearTimeout(qrRevealTimers.fdQrFrame);}
  updateFdUI(secsNum,secsNum);
  armFdQr();
  prefetchApCreds();
  fdCrTimer=setInterval(()=>{
    const left=Math.ceil((fdCrEnd-Date.now())/1000);
    if(left>0){updateFdUI(Math.min(left,secsNum),secsNum);}
    else{
      clearInterval(fdCrTimer); fdCrTimer=null;
      fdSending=false; fdFinishing=true;
      const ct=document.getElementById('fdCrTitle'); if(ct)ct.textContent='Reconnecting…';
      const cs=document.getElementById('fdCrSub'); if(cs){cs.style.display='';cs.innerHTML=
        'Window ended -- waiting for this device to rejoin 802Eleven.<br>Scan the code below if it doesn’t reconnect on its own.';}
      const qw=document.getElementById('fdQrWrap'); if(qw)qw.style.display='';
      const cq0=document.getElementById('fdQrImg');
      if(!(cq0&&cq0.complete&&cq0.naturalWidth>0)) armFdQr(true);
      updateFdUI(0,secsNum);
      pollFdReconnect();
    }
  },250);
}
let framesBuf=[];
const FRAMES_BUF_CAP=800;
/**
 * Parses one raw frame-dump CSV line, applies the kind and search
 * filters, and builds its rendered row element.
 * @param l Frame feed line record ({id, s}).
 * @returns The rendered row element, or null if the line is filtered out.
 */
function appendFrameLine(l){
  const p=(l.s||'').split(',');
  const kind=+p[1]||0, cat=frameCategory(kind);
  if(!frameShow[cat])return null;
  let kl,kc;
  if(cat==='data')        [kl,kc]=['data','k-probe'];
  else if(cat==='assoc')  [kl,kc]=['assoc','k-beacon'];
  else if(cat==='deauth') [kl,kc]=[(+p[9]?'disassoc':'deauth'),'k-probe'];
  else                     [kl,kc]=scoutKind(kind);
  let extraTxt='', eapolTag='';
  if(cat==='beacon'||cat==='probe') extraTxt=hexToStr(p[8]||'');
  else if(cat==='data'){
    const raw=p[8]||'', bar=raw.indexOf('|');
    if(bar>=0 && /^EAPOL/.test(raw)){ eapolTag=raw.slice(0,bar); extraTxt=hexToAsciiDump(raw.slice(bar+1)); }
    else extraTxt=hexToAsciiDump(raw);
  }
  if(frameSearch){
    const hay=(kl+' '+(p[2]||'')+' '+(p[3]||'')+' '+(p[4]||'')+' '+eapolTag+' '+extraTxt).toLowerCase();
    if(!hay.includes(frameSearch))return null;
  }
  const div=document.createElement('div');div.className='ffl';
  const mk=(cls,txt)=>{const s=document.createElement('span');s.className=cls;s.textContent=txt;return s;};
  div.append(mk('sfa','#'+l.id), mk('sfk '+kc,kl), mk('sfm',p[2]||'?'));
  if(p[3])div.append(mk('sfc',' → '), mk('sfm',p[3]));
  if(p[4])div.append(mk('sfc',' bssid '), mk('sfm',p[4]));
  div.append(mk('sfr',' '+(p[5]||'')+'dBm'), mk('sfc',' ch'+(p[6]||'')), mk('sfc',' '+(p[7]||'0')+'B'));
  if(cat==='deauth'){
    div.append(mk('sfr',' r'+(p[8]||'0')));
  }else if(cat==='beacon'||cat==='probe'){
    div.append(mk('sfs'+(extraTxt?'':' empty'),extraTxt?(' '+extraTxt):' ‹no ssid›'));
  }else if(cat==='data'){
    if(eapolTag)div.append(mk('feap',' '+eapolTag));
    if(extraTxt)div.append(mk('ffd',' '+extraTxt));
  }
  return div;
}
/**
 * Re-renders the entire Frames-tab feed from the buffered lines, applying
 * the current kind/search filters.
 */
function renderFramesFeed(){
  if(curView!=='frames'||radarMode!=='wifi')return;
  const box=document.getElementById('framesFeed'); if(!box)return;
  box.innerHTML='';
  const frag=document.createDocumentFragment();
  framesBuf.forEach(l=>{const row=appendFrameLine(l); if(row)frag.appendChild(row);});
  box.appendChild(frag);
  if(framesAutoScroll)box.scrollTop=box.scrollHeight;
}
/**
 * Applies a frame-dump payload: resets the buffer on a stream restart,
 * appends new lines (rendering them live when the Frames tab is open),
 * and updates the frames/s stat line.
 * @param d Frame-dump payload ({total, lines[]}).
 */
function processFrames(d){
  if(!liveOn)return;
  const box=document.getElementById('framesFeed');
  if(d.total<framesPrevTotal){
    framesLastId=0; framesBuf=[]; if(box)box.innerHTML='';
  }
  if(d.lines&&d.lines.length){
    const active=box&&curView==='frames'&&radarMode==='wifi';
    d.lines.forEach(l=>{
      if(l.id>framesLastId)framesLastId=l.id;
      framesBuf.push(l);
      if(active){const row=appendFrameLine(l); if(row)box.appendChild(row);}
    });
    while(framesBuf.length>FRAMES_BUF_CAP)framesBuf.shift();
    if(active){
      while(box.childElementCount>FRAMES_BUF_CAP)box.removeChild(box.firstChild);
      if(framesAutoScroll)box.scrollTop=box.scrollHeight;
    }
  }
  const now=performance.now();let rate='';
  if(framesPrevT){const dt=(now-framesPrevT)/1000;if(dt>0)rate=' · '+((d.total-framesPrevTotal)/dt).toFixed(1)+'/s';}
  framesPrevT=now;framesPrevTotal=d.total;
  const st=document.getElementById('framesStat');
  if(st)st.textContent=(!scoutLinked?'○ scout not linked':framesArmed?'● dumping':'○ idle')
                        +' · '+d.total+' frames'+rate;
}
/**
 * Applies one Detailed-mode drain batch: appends each buffered line
 * (summary fields same as Simple mode, plus its full raw bytes as hex),
 * rendering it live if the Frames tab is open. The server has already
 * freed each line's device-side memory by the time this runs -- the batch
 * sent here is the only copy of that data left.
 * @param d Drain payload ({total, lines[], more}).
 */
function processFramesDetail(d){
  if(!liveOn)return;
  const box=document.getElementById('framesFeed');
  if(d.lines&&d.lines.length){
    const active=box&&curView==='frames'&&radarMode==='wifi';
    d.lines.forEach(l=>{
      framesDetailBuf.push(l);
      if(active){const row=appendFrameDetailLine(l); if(row)box.appendChild(row);}
    });
    if(active&&framesAutoScroll)box.scrollTop=box.scrollHeight;
  }
  const st=document.getElementById('framesStat');
  if(st)st.textContent='detailed · '+framesDetailBuf.length+' frames'
                        +(d.more?' (draining…)':' (drained, freed on device)');
}
/**
 * Renders one Detailed-mode row via the Simple-mode summary renderer (same
 * kind/search filters, same fields), then appends [hex]/[dissect] toggle
 * links matching the Cardputer/CYD on-device Detail view's Hex and Dissect
 * views (Summary is the row itself, already rendered).
 * @param l Drained line record ({id, age, s, raw}).
 * @returns The rendered row element, or null if filtered out.
 */
function appendFrameDetailLine(l){
  const row=appendFrameLine(l);
  if(!row)return null;
  row.classList.add('ffl-detail');
  const mk=(label,kind)=>{
    const s=document.createElement('span');
    s.className='ffviewbtn'; s.textContent=label;
    s.style.cssText='margin-left:6px;cursor:pointer;text-decoration:underline;color:var(--muted);font-size:11px';
    s.onclick=(e)=>{ e.stopPropagation(); toggleFramePanel(row,l,kind); };
    return s;
  };
  row.append(mk('[hex]','hex'), mk('[dissect]','dissect'));
  return row;
}
/**
 * Shows/hides a Hex or Dissect panel for a Detailed-mode row's raw bytes,
 * inserted directly after the row (replacing whichever of the two was open,
 * if any) -- matching the Cardputer/CYD on-device Frames Detail view's
 * Hex/Dissect sub-views (Summary is the row itself).
 * @param row Rendered summary row element the panel toggles under.
 * @param l Drained line record ({s: decoded CSV, raw: hex-encoded bytes}).
 * @param kind 'hex' or 'dissect'.
 */
function toggleFramePanel(row,l,kind){
  const cls='ff'+kind;
  const next=row.nextElementSibling;
  if(next&&next.classList&&next.classList.contains(cls)){ next.remove(); return; }
  if(next&&next.classList&&(next.classList.contains('ffhex')||next.classList.contains('ffdissect')))
    next.remove();
  const pre=document.createElement('pre');
  pre.className=cls;
  pre.style.cssText='margin:2px 0 6px 24px;font-size:11px;white-space:pre-wrap;color:var(--muted)';
  pre.textContent=kind==='hex'?frameHexDump(l.raw):frameDissectText(l);
  row.after(pre);
}
/**
 * 16-bytes-per-line hex+ASCII dump of a hex-encoded byte string, matching
 * the Cardputer/CYD on-device Frames Detail Hex view's layout.
 * @param hex Hex-encoded raw bytes.
 * @returns The formatted dump, or a placeholder if empty.
 */
function frameHexDump(hex){
  const bytes=(hex||'').match(/.{1,2}/g)||[];
  let out='';
  for(let i=0;i<bytes.length;i+=16){
    const chunk=bytes.slice(i,i+16);
    const ascii=chunk.map(h=>{const b=parseInt(h,16);return(b>=0x20&&b<0x7f)?String.fromCharCode(b):'.';}).join('');
    out+=chunk.join(' ').padEnd(47)+'  '+ascii+'\n';
  }
  return out||'(no raw bytes captured for this frame)';
}
/**
 * Dissect-view text for one Detailed-mode row: decodes its hex-encoded raw
 * bytes and MAC fields (from the same CSV the Simple-mode summary parses)
 * and hands them to frameDissect().
 * @param l Drained line record ({s: decoded CSV, raw: hex-encoded bytes}).
 * @returns The dissection text, or a placeholder if there are no raw bytes.
 */
function frameDissectText(l){
  const p=(l.s||'').split(',');
  const bytes=(l.raw||'').match(/.{1,2}/g)||[];
  if(!bytes.length)return '(no raw bytes captured for this frame)';
  return frameDissect(bytes.map(h=>parseInt(h,16)), p[2]||'', p[3]||'', p[4]||'');
}
/**
 * Classifies an 802.1X/EAPOL frame at the LLC/SNAP boundary, mirroring
 * wifi_frame.cpp's eapolLabel() exactly (same offsets/return labels) so the
 * web Dissect view matches the on-device one byte-for-byte.
 * @param b Raw frame bytes (number array).
 * @param len Length of b to consider.
 * @param hdrLen 802.11 header length preceding the LLC/SNAP payload.
 * @returns "" if not EAPOL at hdrLen; else a short categorical label.
 */
function eapolLabelJs(b,len,hdrLen){
  let off=hdrLen;
  if(off+8>len)return'';
  if(b[off]!==0xAA||b[off+1]!==0xAA||b[off+2]!==0x03)return'';
  const ethertype=(b[off+6]<<8)|b[off+7];
  off+=8;
  if(ethertype!==0x888E)return'';
  if(off+4>len)return'EAPOL';
  const type=b[off+1];
  off+=4;
  switch(type){
    case 1:return'EAPOL-Start';
    case 2:return'EAPOL-Logoff';
    case 3:return'EAPOL-Key';
    case 4:return'EAPOL-ASF-Alert';
    case 0:break;
    default:return'EAPOL';
  }
  if(off+4>len)return'EAPOL-EAP';
  const code=b[off];
  if((code!==1&&code!==2)||off+5>len||b[off+4]!==1)return'EAPOL-EAP';
  return code===1?'EAPOL-EAP-ID-REQ':'EAPOL-EAP-ID-RESP';
}
/**
 * Layer-by-layer text dissection of one raw 802.11 frame, mirroring
 * src/wifi/FrameDecode.cpp's dissectFrame() field-for-field and
 * format-string-for-format-string (802.11 header/flags/seq, then a
 * type-specific body: DATA walks LLC/SNAP -> IPv4/IPv6 -> TCP/UDP or
 * recognises EAPOL; mgmt subtypes print their own fixed fields plus tagged
 * parameters). Does not reproduce the device's WITH_SECURITYTOOLS RSN/WPA
 * security-line addition (that needs the full IE security parser) -- every
 * other line matches.
 * @param b Raw frame bytes (number array).
 * @param mac Source MAC string, from the same decoded fields the row shows.
 * @param dst Destination MAC string, may be empty.
 * @param bssid BSSID string, may be empty.
 * @returns The dissection text, newline-joined.
 */
function frameDissect(b,mac,dst,bssid){
  const len=b.length;
  if(len<10)return'(no raw bytes captured for this frame)';
  const lines=[];
  const hx=(v,w)=>v.toString(16).toUpperCase().padStart(w||0,'0');
  const fc0=b[0], fc1=b[1];
  const type=(fc0>>2)&3, subtype=(fc0>>4)&0xF;
  lines.push('802.11 '+['Mgmt','Ctrl','Data','Ext'][type&3]+'  subtype 0x'+hx(subtype));
  lines.push('ToDS='+((fc1>>0)&1)+' FromDS='+((fc1>>1)&1)+' Retry='+((fc1>>3)&1)+' Prot='+((fc1>>6)&1));
  if(len>=4)lines.push('Duration: '+(b[2]|(b[3]<<8))+' us');
  if(mac)lines.push('SA:    '+mac);
  if(dst)lines.push('DA/RA: '+dst);
  if(bssid)lines.push('BSSID: '+bssid);
  if(len>=24){const seq=b[22]|(b[23]<<8);lines.push('Seq: '+(seq>>4)+'  Frag: '+(seq&0xF));}

  const dissectTags=(off,tagsLen)=>{
    const TAGNAME={0:'SSID',1:'Rates',3:'DS Param',5:'TIM',7:'Country',42:'ERP',48:'RSN',
                   50:'Ext Rates',61:'HT Info',127:'Ext Cap',191:'VHT Cap',221:'Vendor'};
    let i=0;
    while(i+2<=tagsLen){
      const id=b[off+i], tl=b[off+i+1];
      if(i+2+tl>tagsLen)break;
      const d=off+i+2, name=TAGNAME[id];
      if((id===1||id===50)&&tl>0){
        const rates=[]; for(let k=0;k<tl;k++)rates.push(((b[d+k]&0x7F)*0.5).toFixed(1));
        lines.push('  '+name+': '+rates.join(',')+' Mbps');
      }else if(id===3&&tl===1){
        lines.push('  DS Param: ch '+b[d]);
      }else if(id===221&&tl>=4){
        lines.push('  Vendor: OUI '+hx(b[d],2)+':'+hx(b[d+1],2)+':'+hx(b[d+2],2)+' type '+b[d+3]+' ('+tl+'B)');
      }else if(name){
        lines.push('  '+name+' ('+tl+'B)');
      }else{
        lines.push('  Tag '+id+' ('+tl+'B)');
      }
      i+=2+tl;
    }
  };
  const dissectTransport=(ipPayOff,proto)=>{
    if(proto===6&&ipPayOff+20<=len){
      const sport=(b[ipPayOff]<<8)|b[ipPayOff+1], dport=(b[ipPayOff+2]<<8)|b[ipPayOff+3];
      lines.push('-- TCP -- '+sport+' -> '+dport+'  flags 0x'+hx(b[ipPayOff+13],2));
    }else if(proto===17&&ipPayOff+8<=len){
      const sport=(b[ipPayOff]<<8)|b[ipPayOff+1], dport=(b[ipPayOff+2]<<8)|b[ipPayOff+3],
            ulen=(b[ipPayOff+4]<<8)|b[ipPayOff+5];
      lines.push('-- UDP -- '+sport+' -> '+dport+'  len '+ulen);
    }
  };
  const ip6=(off)=>{let o='';for(let k=0;k<16;k+=2)o+=(k?':':'')+hx(b[off+k],2)+hx(b[off+k+1],2);return o;};

  if(type===2){
    const qos=!!(subtype&0x08), hdrLen=24+(qos?2:0);
    lines.push('-- '+(qos?'QoS':'Legacy')+' Data --');
    if(qos&&len>=26)lines.push('  TID: '+(b[24]&0xF));
    const eapol=eapolLabelJs(b,len,hdrLen);
    if(eapol){lines.push('-- '+eapol+' --');return lines.join('\n');}
    let off=hdrLen;
    if(off+8>len||b[off]!==0xAA||b[off+1]!==0xAA||b[off+2]!==0x03){
      lines.push('  (no LLC/SNAP -- encrypted or truncated)');
      return lines.join('\n');
    }
    const ethertype=(b[off+6]<<8)|b[off+7];
    off+=8;
    lines.push('-- LLC/SNAP -- Ethertype 0x'+hx(ethertype,4));
    if(ethertype===0x0800&&off+20<=len&&(b[off]>>4)===4){
      const ihl=(b[off]&0xF)*4, proto=b[off+9];
      lines.push('-- IPv4 -- '+[b[off+12],b[off+13],b[off+14],b[off+15]].join('.')+' -> '+
                 [b[off+16],b[off+17],b[off+18],b[off+19]].join('.')+'  proto '+proto);
      if(ihl>=20&&off+ihl<=len)dissectTransport(off+ihl,proto);
    }else if(ethertype===0x86DD&&off+40<=len){
      const proto=b[off+6];
      lines.push('-- IPv6 -- '+ip6(off+8)+' -> '+ip6(off+24)+'  next '+proto);
      dissectTransport(off+40,proto);
    }else if(ethertype===0x0806){
      lines.push('-- ARP --');
    }
    return lines.join('\n');
  }
  if(type!==0)return lines.join('\n');

  switch(subtype){
    case 0x8: case 0x5: {
      if(len<36)break;
      const interval=b[32]|(b[33]<<8), capField=b[34]|(b[35]<<8);
      lines.push('-- '+(subtype===0x8?'Beacon':'Probe-Resp')+' -- interval '+interval+' TU  cap 0x'+hx(capField,4));
      dissectTags(36,len-36);
      break;
    }
    case 0x4:
      lines.push('-- Probe-Req --');
      if(len>24)dissectTags(24,len-24);
      break;
    case 0x0: case 0x2: {
      const tagOff=subtype===0x0?28:34;
      lines.push('-- '+(subtype===0x0?'Assoc':'Reassoc')+'-Req --');
      if(len>tagOff)dissectTags(tagOff,len-tagOff);
      break;
    }
    case 0x1: case 0x3: {
      if(len<30)break;
      const status=b[26]|(b[27]<<8), aid=(b[28]|(b[29]<<8))&0x3FFF;
      lines.push('-- '+(subtype===0x1?'Assoc':'Reassoc')+'-Resp -- status '+status+'  AID '+aid);
      if(len>30)dissectTags(30,len-30);
      break;
    }
    case 0xA: case 0xC: {
      if(len<26)break;
      lines.push('-- '+(subtype===0xA?'Disassoc':'Deauth')+' -- reason '+(b[24]|(b[25]<<8)));
      break;
    }
    case 0xB: {
      if(len<28)break;
      const algo=b[24]|(b[25]<<8), seqn=b[26]|(b[27]<<8), status=len>=30?(b[28]|(b[29]<<8)):0;
      lines.push('-- Authentication -- algo '+algo+'  seq '+seqn+'  status '+status);
      break;
    }
    default: break;
  }
  return lines.join('\n');
}
/* @ENDGUARD */setView((localStorage.getItem('view'))||'map');
syncZoomLock();
ouiLoad();
syncModeUI('wifi');
/**
 * Shows the auth-gate overlay and focuses the password field.
 */
function showAuth(){const g=document.getElementById('authGate');
  if(g&&!g.classList.contains('show')){g.classList.add('show');
    const p=document.getElementById('authPass');if(p)p.focus();}}
/**
 * Hides the auth-gate overlay.
 */
function hideAuth(){const g=document.getElementById('authGate');if(g)g.classList.remove('show');}
/**
 * Submits the login form to /api/auth/login; hides the auth gate and
 * resumes ticking on success, or shows an error on failure.
 * @param e Submit event, if any (default-prevented).
 */
async function authSubmit(e){if(e)e.preventDefault();
  const p=document.getElementById('authPass'),er=document.getElementById('authErr');
  if(er)er.textContent='';
  try{const r=await fetch('/api/auth/login',{method:'POST',body:p?p.value:''});
    if(r.ok){if(p)p.value='';hideAuth();if(LITE_MODE)liteRefresh();else tick();if(typeof detectGpsLogs==='function')detectGpsLogs();}
    else{if(er)er.textContent='Wrong password.';if(p){p.value='';p.focus();}}}
  catch(x){if(er)er.textContent='Connection error.';}}
let pollMs=1000;
let quickTickT=null;
/**
 * Debounces a single extra tick() call 150ms out.
 */
function quickTick(){ clearTimeout(quickTickT); quickTickT=setTimeout(tick,150); }
/**
 * Clamps and applies a new poll interval, marking the poll-interval
 * control busy and updating its label.
 * @param v Requested poll interval in ms.
 */
function setPollMs(v){
  v=Math.max(250,Math.min(10000,parseInt(v,10)||1000));
  const el=document.getElementById('pollms'); if(el)el.dataset.busy='1';
  pollMs=v;
  const l=document.getElementById('pollmsL'); if(l)l.textContent=v;
}
/**
 * Persists the clamped poll interval to /api/prefs/pollms and clears the
 * control's busy state.
 * @param v Poll interval in ms to save.
 */
async function savePollMs(v){
  const el=document.getElementById('pollms');
  try{await fetch('/api/prefs/pollms?ms='+Math.max(250,Math.min(10000,parseInt(v,10)||1000)),{method:'POST'});}catch(e){}
  if(el)delete el.dataset.busy;
}

let wsFailStreak=0;
const WS_LOST_STREAK=4;
/** Time of the last /ws message; the server pushes "data" every pollMs, so silence means the link is gone. */
let lastWsMsgMs=0;
const WS_STALE_MIN_MS=5000;
/** Set by dismissApLost(); suppresses showApLost() until the AP is actually seen again
 * (hideApLost() clears it) so the user can look at cached results while still off the AP.
 * A page refresh resets this along with everything else, so the overlay still auto-shows
 * on reload if the AP is still unreachable. */
let aplostDismissed=false;
/**
 * Shows the "AP connection lost" banner, unless the user dismissed it (stays down until
 * hideApLost() runs, i.e. the AP is actually seen again).
 */
function showApLost(){ if(aplostDismissed) return; const el=document.getElementById('aplost'); if(el)el.classList.add('on'); }
/**
 * Hides the "AP connection lost" banner and clears any prior dismissal, so the next real
 * loss shows it fresh.
 */
function hideApLost(){ aplostDismissed=false; const el=document.getElementById('aplost'); if(el)el.classList.remove('on'); }
/**
 * User-initiated close of the AP-lost overlay (the × button) -- hides it without waiting
 * for reconnect, so cached results are visible while still off the AP. Reconnect polling
 * keeps running in the background; hideApLost() (on actual reconnect) clears the
 * suppression, and a refresh clears it too.
 */
function dismissApLost(){ aplostDismissed=true; const el=document.getElementById('aplost'); if(el)el.classList.remove('on'); }
let ws=null, wsOpen=false, wsBackoffMs=500, wsConnectTimer=null;
const WS_CONNECT_TIMEOUT_MS=4000;
/**
 * Opens the /ws WebSocket connection and wires up its open/message/
 * error/close handlers, dispatching "data"/"config"/"scout"/"frames"
 * messages, with a connect timeout that forces a retry if the socket
 * never opens.
 */
function wsConnect(){
  const proto=(location.protocol==='https:')?'wss://':'ws://';
  try{ ws=new WebSocket(proto+location.host+'/ws'); }catch(e){ wsScheduleReconnect(); return; }
  clearTimeout(wsConnectTimer);
  const thisWs=ws;
  wsConnectTimer=setTimeout(()=>{ if(ws===thisWs&&!wsOpen) ws.close(); },WS_CONNECT_TIMEOUT_MS);
  ws.onopen=()=>{ clearTimeout(wsConnectTimer); wsOpen=true; wsBackoffMs=500; wsFailStreak=0; lastWsMsgMs=Date.now(); hideApLost(); tick(); };
  ws.onmessage=e=>{
    lastWsMsgMs=Date.now();
    let d; try{ d=JSON.parse(e.data); }catch(err){ return; }
    if(d.t==='data') processData(d);
    else if(d.t==='config') mergeCfg(d);
    else if(d.t==='scout') processScout(d);
/* @GUARD:IF WITH_FRAMES */    else if(d.t==='frames') processFrames(d);
    else if(d.t==='framesdetail') processFramesDetail(d);
/* @ENDGUARD */  };
  ws.onerror=()=>{};
  ws.onclose=()=>{ clearTimeout(wsConnectTimer); wsOpen=false; ws=null;
    wsFailStreak++;
    if(!capturing&&!capFinishing&&!sfSending&&!sfFinishing&&!laSending&&!laFinishing&&wsFailStreak>=WS_LOST_STREAK) showApLost();
    wsScheduleReconnect(); };
}
/**
 * Schedules a WebSocket reconnect attempt with exponential backoff,
 * capped at 5s.
 */
function wsScheduleReconnect(){
  setTimeout(wsConnect, wsBackoffMs);
  wsBackoffMs=Math.min(wsBackoffMs*2,5000);
}
/**
 * True while a capture, send or frame run owns the AP (it is supposed to drop), so the
 * AP-lost overlay must stay down.
 * @returns true if a run is in progress or waiting for the device to rejoin.
 */
function runOwnsAp(){
  return capturing||capFinishing||sfSending||sfFinishing||laSending||laFinishing||
         fcSending||fcFinishing||fdSending||fdFinishing;
}
/**
 * Detects a dead /ws. Leaving 802Eleven's AP does not close the socket cleanly: the browser
 * gets no close event for a long time, so onclose (and the WS_LOST_STREAK count) never runs.
 * Instead the push feed simply stops. When nothing has arrived for longer than the push cadence
 * allows, drop the socket by hand and run the same loss path: count the failure, show the
 * AP-lost QR once WS_LOST_STREAK is reached, and keep retrying the connection.
 */
function wsWatchdog(){
  if(!ws||!wsOpen||runOwnsAp()) return;
  const stale=Math.max(WS_STALE_MIN_MS,pollMs*3);
  if(Date.now()-lastWsMsgMs<stale) return;
  const dead=ws;
  ws=null; wsOpen=false;
  dead.onopen=dead.onmessage=dead.onerror=dead.onclose=null;
  try{dead.close();}catch(e){}
  wsFailStreak++;
  if(wsFailStreak>=WS_LOST_STREAK) showApLost();
  wsScheduleReconnect();
}
setInterval(wsWatchdog,1000);
/**
 * Manually refreshes data and the scout feed for Lite mode, where there
 * is no live WebSocket push. User-initiated, unlike liteHeartbeat's silent
 * polling -- clears any dismissApLost() suppression first, so a Refresh
 * click still shows the AP-lost QR if the AP is genuinely still unreachable,
 * even right after closing it.
 */
function liteRefresh(){
  aplostDismissed=false;
  fetch('/api/data').then(r=>{
    if(r.ok){ wsFailStreak=0; hideApLost(); }
    else throw 0;
  }).catch(()=>{ wsFailStreak=WS_LOST_STREAK; showApLost(); });
  liteAllow=true; tick(); liteAllow=false;
  if(typeof scoutTick==='function') scoutTick();
  if(curView==='localap'&&typeof localApTick==='function') localApTick();
}
let liteHbTimer=null;
/**
 * Polls /api/data as a lightweight liveness check in Lite mode, where no
 * WebSocket exists to notice the AP coming back on its own. Hides the
 * AP-lost QR overlay (and clears any manual dismissal) the moment a poll
 * succeeds; the overlay's own × button (dismissApLost()) is the other way
 * off it while still disconnected.
 */
function liteHeartbeat(){
  if(runOwnsAp()) return;
  fetch('/api/data').then(r=>{
    if(r.ok){ wsFailStreak=0; hideApLost(); }
    else throw 0;
  }).catch(()=>{ wsFailStreak++; if(wsFailStreak>=WS_LOST_STREAK) showApLost(); });
}
if(LITE_MODE){
  const lb=document.getElementById('liveBtn'); if(lb) lb.style.display='none';
  const rb=document.getElementById('liteRefreshBtn'); if(rb) rb.style.display='';
  document.title='802Eleven Lite';
  liteHbTimer=setInterval(liteHeartbeat,6000);
}
if(LITE_MODE)liteRefresh();
else tick();
{
  const aq=document.getElementById('aplostQrImg'); if(aq) aq.src='/api/network/apqr';
  prefetchApCreds();
  loadMacInfo();
}
if(!LITE_MODE){
  wsConnect();
}
/* @GUARD:IF WITH_WEB_THEMES */
/**
 * Applies a dashboard theme by name (empty = default) and persists the
 * choice to localStorage -- client-side only, no device round trip.
 * @param name One of the html[data-theme] values baked into the CSS.
 */
function setWebTheme(name){
  try{
    if(name)document.documentElement.setAttribute('data-theme',name);
    else document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('websTheme',name||'');
  }catch(e){}
}
/**
 * Syncs the Settings > Performance theme <select> to the theme currently
 * applied (set by the anti-FOUC inline script at page load).
 */
function syncWebThemeSelect(){
  const el=document.getElementById('webTheme'); if(!el)return;
  try{el.value=localStorage.getItem('websTheme')||'';}catch(e){}
}
/* @ENDGUARD */