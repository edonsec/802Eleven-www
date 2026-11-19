/* ==========================================================================
 * 802Eleven DEMO — synthetic backend.
 *
 * Stands in for the ESP32-S3's esp_http_server so the dashboard (index.html +
 * style.css + app.js, extracted verbatim from src/WebPage.cpp) runs unmodified
 * in a plain browser tab, no firmware attached. Installs a window.fetch
 * override BEFORE app.js loads (app.js's own CSRF-echo IIFE wraps whatever
 * window.fetch already is, so this must load first — see index.html).
 *
 * This file mimics the JSON shapes built by src/web/JsonBuilder.cpp and the
 * route handlers in src/web/RadarServer.cpp for the WITH_RECON build
 * (WITH_SECURITYTOOLS=1, WITH_FRAMES=1, WITH_RECON=1). WiFi-only, like the
 * real firmware -- BLE was removed from this project entirely. WITH_RECON
 * disables handshake/PMKID pcap capture and Send-Frame injection; EAPOL stats
 * (passive M1–M4 seen per AP) are still collected. If you change a real /api/*
 * response shape, mirror the change here too (see demo/GUARDS.md).
 * ========================================================================== */
(function(){
'use strict';

const rnd  = (a,b)=>a+Math.random()*(b-a);
const irnd = (a,b)=>Math.floor(rnd(a,b+1));
const pick = arr=>arr[irnd(0,arr.length-1)];
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const now  = ()=>Date.now();

function randMac(locallyAdministered){
  const b=[]; for(let i=0;i<6;i++) b.push(irnd(0,255));
  if(locallyAdministered) b[0] = (b[0] & 0xFC) | 0x02; else b[0] = b[0] & 0xFC;
  return b.map(x=>x.toString(16).padStart(2,'0')).join(':').toUpperCase();
}
function macFromOui(oui){
  const b=oui.split(':').map(h=>parseInt(h,16));
  for(let i=0;i<3;i++) b.push(irnd(0,255));
  return b.map(x=>x.toString(16).padStart(2,'0')).join(':').toUpperCase();
}

const VENDORS = [
  ['AC:DE:48','Apple'], ['F0:18:98','Apple'], ['3C:06:30','Apple'],
  ['B8:27:EB','Raspberry Pi'], ['DC:A6:32','Raspberry Pi'],
  ['00:1A:11','Google'], ['F4:F5:D8','Google'],
  ['CC:50:E3','Samsung'], ['8C:79:F5','Samsung'],
  ['00:50:F2','Microsoft'], ['9C:AD:97','TP-Link'],
  ['00:0C:29','VMware'], ['B4:FB:E4','Ubiquiti'], ['24:5A:4C','Ubiquiti'],
  ['A4:83:E7','Intel'], ['E4:5F:01','Raspberry Pi'],
];
function vendorFor(mac){
  const p=mac.slice(0,8);
  const hit=VENDORS.find(v=>v[0]===p);
  return hit?hit[1]:'';
}

const SSIDS = ['RouterNet-5G','MeshBox 4410','AcmeClient-Guest','OrbitMesh',
  'NetHub-2C7B','Handset_Pro','LinkGear_88A1','publicwifi','campusnet',
  'AcmeClient_Net','GridNode-IoT','BrewHouse WiFi','FiberLink-3390','DepotWLAN'];

/* --------------------------------------------------------------------------
 * Simulated AP/client population (WiFi -- the only radar this firmware has)
 * ------------------------------------------------------------------------ */
const wifiRecs   = new Map();
const assocs     = new Map();
const deauths    = new Map();
const handshakes = new Map();
const hsSdFiles  = [];

function randHex(len){let s='';for(let i=0;i<len;i++)s+=irnd(0,15).toString(16);return s;}
function hsFileName(bssid,ssid){
  const hex=bssid.replace(/:/g,'').toLowerCase();
  const clean=(ssid||'').replace(/[^A-Za-z0-9_]/g,'').slice(0,20);
  return 'hs_'+(clean?clean+'_':'')+hex+'.pcapng';
}

const SSIDS_EXTRA = ['Pretty Fly for a WiFi','FBI Surveillance Van','Router_of_Theseus',
  'Family room TV','MyRouterName','The_Guest_EXT','Home-guest','Village2024','Cruiser',
  'LAN Solo','Drop It Like It\'s Hotspot','TellMyWifiLoveHer','Wu-Tang LAN',
  'No Free WiFi Here','Bill Wi The Science Fi','The Promised LAN','Get Off My LAN',
  '404_Network_Unavailable','Loading...','Guest\'s'];

function seedWifi(){
  const apCount=8;
  for(let i=0;i<apCount;i++){
    const mac=randMac(false), ssid=SSIDS[i%SSIDS.length];
    const hidden = i===apCount-1;
    const t=now();
    wifiRecs.set(mac,{
      mac, rssi:irnd(-80,-35), rssiSum:0, count:0, rssiMin:-35, rssiMax:-80,
      firstSeenMs:t, lastSeenMs:t, channel:pick([1,1,6,6,6,11,11,36]),
      kinds:1, randomMac:false, vendor:vendorFor(mac)||pick(['Ubiquiti','TP-Link','Netgear','ASUS','Aruba']),
      ssid: hidden?'':ssid,
      sec: hidden?4:pick([1,2,3,3,4,4,5]),
      cipher: pick([1,2,2,3]),
      pmf: pick([0,0,1,2]),
      secIe: true, hidden, everNamed: !hidden,
      ...(i<2 ? {manufacturer:pick(['Netgear Inc.','TP-Link Corp.']),
                 modelName:pick(['Nighthawk RAX50','Archer AX55']),
                 model:pick(['RAX50','AX55'])} : {}),
    });
  }
  {
    const mac=randMac(false), t=now();
    wifiRecs.set(mac,{
      mac, rssi:irnd(-80,-40), rssiSum:0, count:0, rssiMin:-40, rssiMax:-80,
      firstSeenMs:t, lastSeenMs:t, channel:pick([1,6,11]),
      kinds:1, randomMac:false, vendor:vendorFor(mac)||pick(['Ubiquiti','TP-Link','Netgear','ASUS','Aruba']),
      ssid:'RecoveredNet-2FA1', sec:pick([3,4,5]), cipher:pick([2,2,3]), pmf:pick([0,1,2]),
      secIe:true, hidden:true, everNamed:true,
    });
  }
  for(let i=0;i<5;i++){
    const mac=randMac(true), t=now();
    wifiRecs.set(mac,{
      mac, rssi:irnd(-80,-45), rssiSum:0, count:0, rssiMin:-45, rssiMax:-80,
      firstSeenMs:t, lastSeenMs:t, channel:pick([1,6,11]),
      kinds:2, randomMac:true, vendor:'', ssid: pick(['','','HomeHub-9F2A','Guest_Router_42']),
      sec:0, cipher:0, pmf:0, secIe:false, hidden:false, everNamed:false,
    });
  }
  const apList=[...wifiRecs.values()].filter(w=>w.kinds&1);
  for(let i=0;i<6;i++){
    const ap=pick(apList), client=randMac(true), t=now();
    assocs.set(client,{client,bssid:ap.mac,ssid:ap.ssid||'‹hidden›',
      rssi:irnd(-80,-40),count:irnd(1,40),firstSeenMs:t,lastSeenMs:t,
      clientRnd:true,bssidVendor:ap.vendor});
  }
  for(let i=0;i<SSIDS_EXTRA.length;i++){
    const mac=randMac(false), t=now(), hidden=Math.random()<0.15;
    wifiRecs.set(mac,{
      mac, rssi:irnd(-85,-45), rssiSum:0, count:0, rssiMin:-45, rssiMax:-85,
      firstSeenMs:t, lastSeenMs:t, channel:pick([1,1,6,6,6,11,11,36]),
      kinds:1, randomMac:false, vendor:vendorFor(mac)||pick(['Ubiquiti','TP-Link','Netgear','ASUS','Aruba','']),
      ssid: hidden?'':SSIDS_EXTRA[i],
      sec: hidden?4:pick([1,2,3,3,4,4,5]), cipher: pick([1,2,2,3]), pmf: pick([0,0,1,2]),
      secIe: true, hidden, everNamed: !hidden,
    });
  }
  const heroMac=macFromOui('B4:FB:E4');
  wifiRecs.set(heroMac,{
    mac:heroMac, rssi:-32, rssiSum:0, count:0, rssiMin:-30, rssiMax:-40,
    firstSeenMs:now(), lastSeenMs:now(), channel:6,
    kinds:1, randomMac:false, vendor:'Ubiquiti', ssid:'802Eleven',
    sec:3, cipher:2, pmf:1, secIe:true, hidden:false, everNamed:true,
  });
  const heroClientOuis=['AC:DE:48','B8:27:EB','CC:50:E3','00:1A:11'];
  for(let i=0;i<4;i++){
    const client=macFromOui(heroClientOuis[i]), t=now();
    wifiRecs.set(client,{
      mac:client, rssi:irnd(-70,-40), rssiSum:0, count:0, rssiMin:-40, rssiMax:-70,
      firstSeenMs:t, lastSeenMs:t, channel:6, kinds:2, randomMac:false,
      vendor:vendorFor(client), ssid:'802Eleven', sec:0, cipher:0, pmf:0, secIe:false,
      hidden:false, everNamed:false,
    });
    assocs.set(client,{client,bssid:heroMac,ssid:'802Eleven',
      rssi:irnd(-70,-40),count:irnd(4,20),firstSeenMs:t,lastSeenMs:t,
      clientRnd:false,bssidVendor:'Ubiquiti'});
  }
  const meshSsid='MeshHome-3F21', meshChans=[1,6,11], meshMacs=[];
  meshChans.forEach(ch=>{
    const mac=randMac(false), t=now();
    meshMacs.push(mac);
    wifiRecs.set(mac,{
      mac, rssi:irnd(-75,-40), rssiSum:0, count:0, rssiMin:-40, rssiMax:-75,
      firstSeenMs:t, lastSeenMs:t, channel:ch,
      kinds:1, randomMac:false, vendor:vendorFor(mac)||'Ubiquiti',
      ssid:meshSsid, sec:4, cipher:2, pmf:1, secIe:true, hidden:false, everNamed:true,
    });
  });
  {
    const meshClient=randMac(true), t=now();
    wifiRecs.set(meshClient,{
      mac:meshClient, rssi:irnd(-70,-40), rssiSum:0, count:0, rssiMin:-40, rssiMax:-70,
      firstSeenMs:t, lastSeenMs:t, channel:meshChans[1], kinds:2, randomMac:true,
      vendor:'', ssid:'', sec:0, cipher:0, pmf:0, secIe:false, hidden:false, everNamed:false,
    });
    assocs.set(meshClient,{client:meshClient,bssid:meshMacs[1],ssid:meshSsid,
      rssi:irnd(-70,-40),count:irnd(4,20),firstSeenMs:t,lastSeenMs:t,
      clientRnd:true,bssidVendor:vendorFor(meshMacs[1])||'Ubiquiti'});
  }
  const ap=pick(apList);
  const victim=randMac(true);
  deauths.set(victim+'|'+ap.mac,{src:ap.mac,dst:victim,bssid:ap.mac,reason:7,
    disassoc:false,rssi:irnd(-70,-40),count:irnd(12,40),firstSeenMs:now(),lastSeenMs:now()});
  const victim2=randMac(true);
  deauths.set(victim2+'|'+pick(apList).mac,{src:pick(apList).mac,dst:victim2,bssid:ap.mac,reason:3,
    disassoc:true,rssi:irnd(-70,-40),count:1,firstSeenMs:now(),lastSeenMs:now()});
  // WITH_RECON: passive EAPOL stats only -- no pcap capture, no pmkid.
  const hsFullAp=pick(apList), hsFullClient=randMac(true);
  handshakes.set(hsFullClient+'|'+hsFullAp.mac,{client:hsFullClient,bssid:hsFullAp.mac,
    mask:0xF,pmkid:'',rssi:irnd(-70,-40),count:irnd(4,10),lastSeenMs:now()});
  const hsPmkidAp=pick(apList), hsPmkidClient=randMac(true);
  handshakes.set(hsPmkidClient+'|'+hsPmkidAp.mac,{client:hsPmkidClient,bssid:hsPmkidAp.mac,
    mask:0x1,pmkid:'',rssi:irnd(-80,-50),count:1,lastSeenMs:now()});
  const hsPartAp=pick(apList), hsPartClient=randMac(true);
  handshakes.set(hsPartClient+'|'+hsPartAp.mac,{client:hsPartClient,bssid:hsPartAp.mac,
    mask:0x3,pmkid:'',rssi:irnd(-75,-45),count:irnd(1,3),lastSeenMs:now()});
  hsSdFiles.length=0; // no pcap files in recon mode
}
seedWifi();

/* --------------------------------------------------------------------------
 * GPS anchor per AP (demo-only). Real GPS-tagged captures (Cardputer
 * WITH_GPS + WITH_SDCARD, "GPS wardriving") record the recording device's
 * own position at the moment each beacon was seen -- lat/lon riding the
 * WiFi record itself, which app.js::showMacInfo's Location row already
 * renders when present (fed today by a GPS session-log import). Here we just
 * fabricate that same per-AP lat/lon so it shows up in the MAC info card
 * live, gated by the Env popover's "GPS module" flag (state.gps, checked in
 * buildDataJson() below) -- no separate UI, this rides the real field.
 * Spread APs ~30-170m from a fixed demo site so they read like one drive-by.
 * ------------------------------------------------------------------------ */
const GPS_BASE_LAT = 37.7749, GPS_BASE_LON = -122.4194;
/**
 * Stamps every current AP record with a fabricated lat/lon anchor. Called at
 * initial load AND after every reseed (/api/clear, new session) -- wifiRecs
 * gets fresh record objects each time, so this must re-run or those objects
 * never carry gpsLat/gpsLon and the Env "GPS module" flag silently has
 * nothing to show for the rest of the page's life.
 */
/** Formats a Date as "YYYY-MM-DD HH:MM:SS" UTC, matching GnssModule::utcTimestamp()'s wire format. */
function fmtUtcStamp(d){
  const p=n=>(''+n).padStart(2,'0');
  return d.getUTCFullYear()+'-'+p(d.getUTCMonth()+1)+'-'+p(d.getUTCDate())+' '+
    p(d.getUTCHours())+':'+p(d.getUTCMinutes())+':'+p(d.getUTCSeconds());
}
function seedGpsAnchors(){
  let i = 0;
  // Fabricated "walked past" order/pacing for the demo's GPS Trail view --
  // real GPS-tagged rows carry the GNSS fix time (see fmtUtcStamp), so the
  // trail's Start/End-of-trail stamps and DIST column have something to show.
  const walkStart = now() - 180000;
  wifiRecs.forEach(w=>{
    if(!(w.kinds & 1)) return;
    const ang = (i*47 % 360) * Math.PI/180;
    const distM = 30 + (i*23 % 140);
    w.gpsLat = GPS_BASE_LAT + (distM*Math.cos(ang))/111320;
    w.gpsLon = GPS_BASE_LON + (distM*Math.sin(ang))/(111320*Math.cos(GPS_BASE_LAT*Math.PI/180));
    w.gpsTs = fmtUtcStamp(new Date(walkStart + i*9000));
    i++;
  });
}
seedGpsAnchors();

/* Occasionally mutate a record so the feed feels alive. */
function churn(){
  wifiRecs.forEach(w=>{
    if(Math.random()<0.6){
      w.rssi=clamp(w.rssi+irnd(-3,3),-90,-30);
      w.rssiMax=Math.max(w.rssiMax,w.rssi); w.rssiMin=Math.min(w.rssiMin,w.rssi);
      w.count++; w.rssiSum+=w.rssi*2; w.lastSeenMs=now();
    }
    if(state.gps && w.gpsLat!=null && Math.random()<0.6){
      w.gpsLat = clamp(w.gpsLat+rnd(-0.000015,0.000015), -90, 90);
      w.gpsLon = clamp(w.gpsLon+rnd(-0.000015,0.000015), -180, 180);
    }
  });
  assocs.forEach(a=>{ if(Math.random()<0.5){a.count++; a.lastSeenMs=now(); a.rssi=clamp(a.rssi+irnd(-3,3),-90,-30);} });
  deauths.forEach(d=>{ if(Math.random()<0.15){d.count++; d.lastSeenMs=now();} });
  handshakes.forEach(h=>{
    if(Math.random()<0.1){
      h.count++; h.lastSeenMs=now(); h.rssi=clamp(h.rssi+irnd(-3,3),-90,-30);
      if(h.mask!==0xF && Math.random()<0.15) h.mask=Math.min(0xF,(h.mask<<1)|1);
    }
  });
}
setInterval(churn, 1200);

/* --------------------------------------------------------------------------
 * Sentinel watch simulation (WITH_SECURITYTOOLS) -- mirrors the "sentinel"
 * object RadarServer::appendSentinelPayload_ emits (deauth-flood / karma /
 * rogue-hardware watches). `null` until /api/sentinel/start is first called,
 * same as the real firmware only emitting the key once a session has ever
 * run this boot (SentinelWatch::everRan()).
 * ------------------------------------------------------------------------ */
let sentinel = null;
const ROGUE_LABELS = ['ESP32 (Espressif OUI)','WiFi adapter (promisc-capable)',
  'Raspberry Pi','Spoofed vendor OUI','Custom/DIY hardware'];
function sentinelStart(mask, chan){
  /* Real firmware drops its own AP/httpd for the run (CaptureRadioGuard) --
   * nothing to simulate here, the demo dashboard just keeps polling. */
  clearInterval(sentinel && sentinel.timer);
  sentinel = {
    active:true, mask: mask||7,
    deauthRows: new Map(), deauthAlerting:false,
    /* Real SentinelWatch::karmaNewSession() never uses a real/observed SSID --
     * it fabricates karmaPrefix ("sk-" default) + 6 random hex digits, so a
     * response can only mean an AP blindly answers ANY probed SSID. */
    karmaSsid: 'sk-'+randHex(6), karmaSends:0, karmaResponded:false,
    karmaApMac:'', karmaRssi:0, karmaCh:0,
    rogueHits: new Map(), rogueAllowed: new Set(),
    chan: chan||0,
  };
  sentinel.timer = setInterval(sentinelTick, 1000);
}
function sentinelStop(){
  if(!sentinel) return;
  sentinel.active=false;
  clearInterval(sentinel.timer);
}
function sentinelTick(){
  if(!sentinel || !sentinel.active) return;
  const m = sentinel.mask;
  if((m&1) && Math.random()<0.35){
    const mac = Math.random()<0.5 ? randMac(true) : macFromOui(pick(VENDORS)[0]);
    const row = sentinel.deauthRows.get(mac) || {cnt:0, rssi:irnd(-80,-40)};
    row.cnt += irnd(1,3); row.rssi = clamp(row.rssi+irnd(-3,3),-90,-30);
    sentinel.deauthRows.set(mac, row);
    if(row.cnt>=10){
      sentinel.deauthAlerting=true; sentinel.deauthWorst=mac;
      sentinel.deauthSsid=pick(SSIDS); sentinel.deauthCh=pick([1,6,11]);
      sentinel.deauthBssid=macFromOui(pick(VENDORS)[0]);
    }
  }
  if((m&2) && !sentinel.karmaResponded){
    if(Math.random()<0.3) sentinel.karmaSends++;
    if(sentinel.karmaSends>=6 && Math.random()<0.2){
      sentinel.karmaResponded=true; sentinel.karmaApMac=randMac(true);
      sentinel.karmaRssi=irnd(-75,-40); sentinel.karmaCh=pick([1,6,11]);
    }
  }
  if((m&4) && Math.random()<0.12 && sentinel.rogueHits.size<6){
    const mac = (Math.random()<0.6 && wifiRecs.length) ? wifiRecs[Math.floor(Math.random()*wifiRecs.length)].mac : randMac(false);
    if(!sentinel.rogueAllowed.has(mac)){
      sentinel.rogueHits.set(mac,{
        label: pick(ROGUE_LABELS), ssid: Math.random()<0.6?pick(SSIDS_EXTRA):'',
        vendor: pick(['Espressif','Raspberry Pi','TP-Link','']),
        rssi: irnd(-80,-40), ch: pick([1,6,11]), cnt: irnd(1,20),
        attacking: Math.random()<0.4,
        ssidhop: Math.random()<0.25, beaconflood: Math.random()<0.15, probeflood: Math.random()<0.15,
      });
    }
  }
  sentinel.rogueHits.forEach(h=>{ if(Math.random()<0.3) h.cnt++; });
}
function buildSentinelJson(){
  if(!sentinel) return undefined;
  const out = {active: sentinel.active?1:0, mask: sentinel.mask,
    alerting: (sentinel.deauthAlerting || sentinel.karmaResponded ||
      [...sentinel.rogueHits.values()].some(h=>h.attacking)) ? 1 : 0};
  if(sentinel.mask & 1){
    const rows = [...sentinel.deauthRows.entries()].map(([mac,r])=>({mac,cnt:r.cnt,rssi:r.rssi}));
    out.deauth = {alerting: sentinel.deauthAlerting?1:0,
      worstcount: sentinel.deauthAlerting ? (sentinel.deauthRows.get(sentinel.deauthWorst)||{cnt:0}).cnt : 0,
      rows};
    if(sentinel.deauthAlerting){
      out.deauth.worstmac = sentinel.deauthWorst;
      out.deauth.worstssid = sentinel.deauthSsid;
      out.deauth.worstch = sentinel.deauthCh;
      out.deauth.worstbssid = sentinel.deauthBssid;
    }
  }
  if(sentinel.mask & 2){
    out.karma = {responded: sentinel.karmaResponded?1:0, ssid: sentinel.karmaSsid, sends: sentinel.karmaSends};
    if(sentinel.karmaResponded){
      out.karma.apmac = sentinel.karmaApMac; out.karma.rssi = sentinel.karmaRssi; out.karma.ch = sentinel.karmaCh;
    }
  }
  if(sentinel.mask & 4){
    out.rogue = {alerting: [...sentinel.rogueHits.values()].some(h=>h.attacking)?1:0,
      hits: [...sentinel.rogueHits.entries()].map(([mac,h])=>({
        mac, label:h.label, ssid:h.ssid, vendor:h.vendor, rssi:h.rssi, ch:h.ch, cnt:h.cnt,
        attacking:h.attacking?1:0, ssidhop:h.ssidhop?1:0, beaconflood:h.beaconflood?1:0, probeflood:h.probeflood?1:0}))};
  }
  return out;
}
/* Auto-arm Sentinel (all 3 watches) so the tab/panel have something to show --
 * on real hardware this needs either a T-Dongle-C5's physical BOOT-button
 * boot path (Settings > Boot & Sentinel, TDONGLE_BUILD-only) or the WITH_SERIAL
 * "sentinel start" console command, neither of which this primary-board demo has. */
sentinelStart(7, 0);

/* --------------------------------------------------------------------------
 * Server-side-ish state the real firmware also tracks
 * ------------------------------------------------------------------------ */
const state = {
  cap:false, capLeft:0, capSecs:20, capTimer:null,
  scoutLinked:true, capchan:0, scoutchan:0, scoutchan5:0, capdata:false, scoutdata:false,
  scouttypes:0x0F, scoutpause:false, retain:false, ttlmin:0, pollms:1000, framesOn:false,
  frameDetailOn:false,
  uiPass:'', gateNvs:false, gateDefault:false, token:null, csrf:'demo-csrf-token',
  hsRamArmed:false,
  sdBoard:true,
  capdual:false, dband:false, gps:false, dongle:false,
  led:true, screen:0, orient:0, bootmode:0, bootmask:7, bootchan:0,
  idleview:0, autooff:0, dim:100, roguecat:0, captive:true,
  apSsid:'802Eleven', apOpen:false, apHidden:true, apPass:'demopass1', apMac:'',
  apSsidNvs:false, macRandLast:false,
  staSsid:'', staPass:'', staEnabled:false, staStatus:0, staMac:'', staMacLink:false,
  injectActive:false, injectSent:0, injectOk:0,
  localApActive:false, localApLocal:false, localApUnlimited:false, localApSecsLeft:0,
  localApTotal:0, localApSubtotal:0, localApStaTotal:0, localApTimer:null,
  localApFields:[], localApFieldId:0,
  sessions:[], sessionSeq:0,
};
window.__mockState = state;

function buildDataJson(){
  const out = {
    cap: state.cap?1:0, capleft: state.capLeft,
    capsecs: state.capSecs, scout: state.scoutLinked?1:0, capchan: state.capchan,
    scoutchan: state.scoutchan, capdata: state.capdata?1:0, scoutdata: state.scoutdata?1:0,
    scouttypes: state.scouttypes, scoutpause: state.scoutpause?1:0, retain: state.retain?1:0,
    ttlmin: state.ttlmin, pollms: state.pollms, frames: state.framesOn?1:0,
    capdual: state.capdual?1:0, dband: state.dband?1:0,
    heap: 118000+irnd(-4000,4000), minheap: 96000, maxblock: 64000+irnd(-2000,2000),
    wifi: [], assoc: [], deauth: [], handshake: [],
  };
  const sentinelJson = buildSentinelJson();
  if(sentinelJson) out.sentinel = sentinelJson;
  wifiRecs.forEach(w=>{
    out.wifi.push({
      mac:w.mac, rssi:w.rssi, avg: w.count? Math.round((w.rssiSum-(w.count>>1))/w.count):w.rssi,
      min:w.rssiMin, max:w.rssiMax, cnt:w.count,
      age: Math.floor((now()-w.lastSeenMs)/1000), life: Math.floor((now()-w.firstSeenMs)/1000),
      ch:w.channel, kind:(w.kinds&1)?'beacon':'probe', rnd:w.randomMac?1:0,
      sec:w.sec, cip:w.cipher, pmf:w.pmf, secie:w.secIe?1:0, hid:w.hidden?1:0,
      vendor:w.vendor, ssid:w.ssid,
      ...(state.gps && w.gpsLat!=null ? {lat:w.gpsLat, lon:w.gpsLon, ts:w.gpsTs} : {}),
      ...(w.manufacturer?{mfr:w.manufacturer}:{}),
      ...(w.modelName?{modelname:w.modelName}:{}),
      ...(w.model?{model:w.model}:{}),
    });
  });
  assocs.forEach(a=>out.assoc.push({client:a.client,bssid:a.bssid,ssid:a.ssid,rssi:a.rssi,
    cnt:a.count,age:Math.floor((now()-a.lastSeenMs)/1000),rnd:a.clientRnd?1:0,vendor:a.bssidVendor}));
  deauths.forEach(d=>out.deauth.push({src:d.src,dst:d.dst,bssid:d.bssid,reason:d.reason,
    dis:d.disassoc?1:0,rssi:d.rssi,cnt:d.count,age:Math.floor((now()-d.lastSeenMs)/1000)}));
  handshakes.forEach(h=>out.handshake.push({client:h.client,bssid:h.bssid,mask:h.mask,pmkid:h.pmkid,
    rssi:h.rssi,cnt:h.count,age:Math.floor((now()-h.lastSeenMs)/1000)}));
  return out;
}

/* ---- capture window simulation ------------------------------------------ */
function armCapture(secs){
  secs = clamp(secs||20,5,300);
  state.cap = true; state.capSecs = secs; state.capLeft = secs;
  clearInterval(state.capTimer);
  state.capTimer = setInterval(()=>{
    state.capLeft--;
    if(state.capLeft<=0){ clearInterval(state.capTimer); state.cap=false; state.capLeft=0; }
  },1000);
}

/* ---- scout feed simulation ----------------------------------------------- */
const scoutFeed = []; let scoutFeedId=0;
function pushScoutLine(s){ scoutFeed.push({id:++scoutFeedId, tMs:now(), s}); if(scoutFeed.length>150) scoutFeed.shift(); }
setInterval(()=>{
  if(!state.scoutLinked || state.scoutpause) return;
  const kinds=['W','W','W','P','A','D'];
  const k=pick(kinds);
  if(k==='W'){
    const mac=Math.random()<0.5?randMac(true):macFromOui(pick(VENDORS)[0]);
    const kind=pick([0,1]);
    pushScoutLine(`W,${mac},${irnd(-85,-40)},${pick([1,6,11])},${kind?'beacon':'probe'},${toHex(pick(SSIDS))}`);
  }else if(k==='P'){
    pushScoutLine(`P,${randMac(true)},${randMac(false)},${irnd(-80,-40)},${pick([1,6,11])},${toHex(pick(SSIDS))}`);
  }else if(k==='A'){
    pushScoutLine(`A,${randMac(true)},${randMac(false)},${irnd(-80,-40)},${toHex(pick(SSIDS))}`);
  }else{
    pushScoutLine(`D,${randMac(false)},${randMac(true)},${randMac(false)},7,0,${irnd(-80,-40)}`);
  }
}, 900);
function toHex(s){ return Array.from(new TextEncoder().encode(s)).map(b=>b.toString(16).padStart(2,'0')).join(''); }

/* ---- raw frame dump simulation (WITH_FRAMES, WS-only, see "Frame dump") --
 * Wire shape: N,<kind>,<mac>,<dst>,<bssid>,<rssi>,<ch>,<len>,<extra> -- kind
 * is the WK_* bit (1 probe-req, 2 beacon, 4 probe-resp, 8 assoc, 0x10 deauth,
 * 0x20 data, 0x40 auth, 0x80 qos-data); extra is hex ssid for mgmt frames,
 * "<reason>,<disassoc>" for deauth, an ascii-dump payload (optionally
 * "EAPOL-M#|<payload>") for data/qos-data, empty for assoc/auth. ------- */
const framesFeed = []; let framesFeedId=0; const FRAME_FEED_CAP=60;
function pushFrameLine(s){ framesFeed.push({id:++framesFeedId, tMs:now(), s}); if(framesFeed.length>FRAME_FEED_CAP) framesFeed.shift(); }
/* Detailed-mode buffer (see RadarServer::sendFramesDetail_): holds the whole run, full raw bytes
 * included, until a "framesdrain" WS request empties it -- mirrors the real device's frameDetail_. */
const frameDetailBuf = []; let frameDetailNextId=0; const FRAME_DETAIL_MAX=500;
function pushDetailLine(s, rawHex){
  if(frameDetailBuf.length>=FRAME_DETAIL_MAX) return;
  frameDetailBuf.push({id:++frameDetailNextId, tMs:now(), s, raw:rawHex});
}
const PAYLOAD_SAMPLES=['GET /index.html HTTP/1.1','Host: example.com','User-Agent: curl/8.4.0',
  'hello from the demo','ping','PING 8.8.8.8','ACK','SSH-2.0-OpenSSH_9.6'];
function macToBytes(mac){ return (mac||'00:00:00:00:00:00').split(':').map(h=>parseInt(h,16)||0); }
function bytesToHex(b){ return b.map(x=>x.toString(16).padStart(2,'0')).join(''); }
function pushBytes(arr, ...vals){ for(const v of vals) arr.push(v&0xFF); }
function pushBytesArr(arr, more){ for(const v of more) arr.push(v&0xFF); }
function asciiBytes(s){ return Array.from(s).map(c=>c.charCodeAt(0)&0xFF); }
/**
 * Fabricates plausible raw 802.11 bytes for one frame kind, well-formed
 * enough for frameDissect()/the hex dump to show something real -- mirrors
 * (not byte-identical to) the on-device simulators' own fabricators
 * (each board's tools/sims/.../shim/WifiSniffer_sim.cpp fabDataFrameBytes and friends).
 * Only used for Detailed-mode rows; Simple-mode rows never carry raw bytes
 * on the real device either (see "frames" vs "framesdetail" in RadarServer).
 * @param kind WK_* bit (1/2/4/8/0x10/0x20/0x40/0x80, same as the CSV field).
 * @param mac Source MAC string.
 * @param dst Destination MAC string, may be empty.
 * @param bssid BSSID string, may be empty.
 * @returns Hex-encoded raw frame bytes.
 */
function fabFrameBytes(kind, mac, dst, bssid){
  const FC0={1:0x40,2:0x80,4:0x50,8:0x00,0x10:0xC0,0x20:0x08,0x40:0xB0,0x80:0x88}[kind] ?? 0x00;
  const a1=macToBytes(dst||bssid||mac), a2=macToBytes(mac), a3=macToBytes(bssid||dst||mac);
  const b=[];
  pushBytes(b, FC0, kind===0x20||kind===0x80?0x02:0x00, irnd(0,255), irnd(0,255));
  pushBytesArr(b, a1); pushBytesArr(b, a2); pushBytesArr(b, a3);
  pushBytes(b, irnd(0,255), irnd(0,255));
  if(kind===0x80) pushBytes(b, 0x00, 0x00);
  const ssid=pick(SSIDS);
  if(kind===2||kind===4){
    for(let i=0;i<8;i++) b.push(0);
    pushBytes(b, 0x64, 0x00, 0x11, 0x04);
    pushBytes(b, 0, ssid.length); pushBytesArr(b, asciiBytes(ssid));
    pushBytes(b, 1, 2, 0x82, 0x84);
    pushBytes(b, 3, 1, pick([1,6,11]));
  } else if(kind===1){
    pushBytes(b, 0, ssid.length); pushBytesArr(b, asciiBytes(ssid));
    pushBytes(b, 1, 2, 0x82, 0x84);
  } else if(kind===8){
    pushBytes(b, 0x11, 0x04, 0x0A, 0x00);
    pushBytes(b, 0, ssid.length); pushBytesArr(b, asciiBytes(ssid));
    pushBytes(b, 1, 2, 0x82, 0x84);
  } else if(kind===0x10){
    pushBytes(b, 7, 0);
  } else if(kind===0x40){
    pushBytes(b, 0, 0, 1, 0, 0, 0);
  } else {
    pushBytes(b, 0xAA, 0xAA, 0x03, 0, 0, 0, 0x08, 0x00);
    const proto=pick([6,17]);
    pushBytes(b, 0x45, 0x00, 0, 40, 0, 0, 0x40, 0, 64, proto, 0, 0);
    pushBytes(b, 10,0,0,1, 10,0,0,2);
    if(proto===6){
      pushBytes(b, 0x01,0xBB, 0xC3,0x50, 0,0,0,1, 0,0,0,1, 0x50,0x18, 0x20,0x00, 0,0, 0,0);
    } else {
      pushBytes(b, 0xC3,0x50, 0x00,0x35, 0,20, 0,0);
    }
    pushBytesArr(b, asciiBytes(pick(PAYLOAD_SAMPLES).slice(0,16)));
  }
  return bytesToHex(b);
}
setInterval(()=>{
  const detail = state.frameDetailOn && (state.scoutLinked || state.cap);
  const simple = !detail && state.framesOn && (state.scoutLinked || state.cap);
  if(!detail && !simple) return;
  const kind=pick([1,1,2,4,8,0x10,0x20,0x40,0x80]);
  const rssi=irnd(-85,-40), ch=pick([1,6,11]), len=irnd(40,1200);
  let line='', mac='', dst='', bssid='';
  if(kind===2||kind===1||kind===4){
    mac=randMac(kind!==2); dst=''; bssid=mac;
    line=`N,${kind},${mac},,${bssid},${rssi},${ch},${len},${toHex(pick(SSIDS))}`;
  }else if(kind===0x40){
    mac=randMac(false); bssid=mac;
    line=`N,${kind},${mac},,${bssid},${rssi},${ch},${len},`;
  }else if(kind===8){
    mac=randMac(true); bssid=randMac(false);
    line=`N,${kind},${mac},,${bssid},${rssi},${ch},${len},`;
  }else if(kind===0x10){
    mac=randMac(false); dst=randMac(true); bssid=randMac(false);
    line=`N,${kind},${mac},${dst},${bssid},${rssi},${ch},${len},7,${irnd(0,1)}`;
  }else{
    mac=randMac(true); bssid=randMac(false);
    const eapol=Math.random()<0.15?`EAPOL-M${irnd(1,4)}|`:'';
    line=`N,${kind},${mac},,${bssid},${rssi},${ch},${len},${eapol}${toHex(pick(PAYLOAD_SAMPLES))}`;
  }
  if(detail) pushDetailLine(line, fabFrameBytes(kind, mac, dst, bssid));
  else pushFrameLine(line);
}, 350);

/* --------------------------------------------------------------------------
 * Fake /ws — app.js's real transport is a WebSocket push (see RadarServer::
 * wsTick), not polling; only the fetch() router above stands in for the
 * fallback HTTP endpoints. Without this, `new WebSocket(...)` in app.js's
 * wsConnect() fails against a browser tab with no real server behind it,
 * wsFailStreak climbs past WS_LOST_STREAK, and the page falsely shows the
 * "Reconnecting to 802Eleven…" #aplost overlay a genuine device would only
 * show after actually losing its AP -- something this demo can never satisfy.
 * Mimics the real /ws contract closely enough for app.js's onopen/onmessage/
 * onclose handlers: pushes a {t:'data',...} message every ~pollms and a
 * {t:'scout',...} one whenever the scout feed above has grown.
 * ------------------------------------------------------------------------ */
class MockWebSocket{
  constructor(url){
    this.url=url; this.readyState=0; this.onopen=null; this.onmessage=null; this.onerror=null; this.onclose=null;
    this._closed=false; this._scoutLastId=0; this._framesLastId=0;
    this._openTimer=setTimeout(()=>{
      if(this._closed)return;
      this.readyState=1;
      if(this.onopen)this.onopen({});
      this._pushTimer=setInterval(()=>this._push(), Math.max(250,state.pollms||1000));
    }, 60+Math.random()*80);
  }
  _push(){
    if(this._closed||!this.onmessage)return;
    this.onmessage({data:JSON.stringify(Object.assign({t:'data'},buildDataJson()))});
    if(scoutFeedId>this._scoutLastId){
      const lines=scoutFeed.filter(l=>l.id>this._scoutLastId).map(l=>({id:l.id,age:now()-l.tMs,s:l.s}));
      this._scoutLastId=scoutFeedId;
      this.onmessage({data:JSON.stringify({t:'scout',linked:state.scoutLinked?1:0,total:scoutFeedId,lines})});
    }
    if(framesFeedId>this._framesLastId){
      const lines=framesFeed.filter(l=>l.id>this._framesLastId).map(l=>({id:l.id,age:now()-l.tMs,s:l.s}));
      this._framesLastId=framesFeedId;
      this.onmessage({data:JSON.stringify({t:'frames',total:framesFeedId,lines})});
    }
  }
  /**
   * Handles the one client->server message app.js's real transport sends:
   * Detailed-mode Frames' "framesdrain" request (see RadarServer::handleWs_
   * / sendFramesDetail_). Replies with one or more {t:'framesdetail',...}
   * messages, draining frameDetailBuf in small batches and freeing each
   * line as it's sent -- same shape/behaviour as the real device.
   * @param data Raw WS message text sent by the client.
   */
  send(data){
    let msg; try{ msg=JSON.parse(data); }catch(e){ return; }
    if(!msg||msg.t!=='framesdrain')return;
    const drainBatch=()=>{
      if(this._closed||!this.onmessage)return;
      const lines=frameDetailBuf.splice(0,16).map(l=>({id:l.id,age:now()-l.tMs,s:l.s,raw:l.raw}));
      const more=frameDetailBuf.length>0;
      this.onmessage({data:JSON.stringify({t:'framesdetail',total:frameDetailBuf.length,lines,more})});
      if(more) setTimeout(drainBatch, 30+Math.random()*40);
    };
    setTimeout(drainBatch, 40+Math.random()*60);
  }
  close(){
    if(this._closed)return;
    this._closed=true; this.readyState=3;
    clearTimeout(this._openTimer); clearInterval(this._pushTimer);
    if(this.onclose)this.onclose({});
  }
}
window.WebSocket = MockWebSocket;

/* --------------------------------------------------------------------------
 * fetch() router — mirrors src/RadarServer.cpp's route table.
 * ------------------------------------------------------------------------ */
function json(obj, status){
  return new Promise(res=>setTimeout(()=>res(new Response(JSON.stringify(obj),
    {status:status||200, headers:{'Content-Type':'application/json'}})), 40+Math.random()*60));
}

const realFetch = window.fetch.bind(window);
window.fetch = function(url, opts){
  opts = opts||{};
  let u; try{ u = new URL(url, location.href); } catch(e){ return realFetch(url,opts); }
  if(u.pathname.startsWith('/api/')){
    return route(u, opts);
  }
  return realFetch(url, opts);
};

if(!document.cookie.includes('sscsrf=')) document.cookie = 'sscsrf='+state.csrf+'; Path=/';

async function route(u, opts){
  const p = u.pathname, q = u.searchParams;
  switch(p){
    case '/api/data':
      return json(buildDataJson());

    case '/api/clear':
      wifiRecs.clear(); assocs.clear(); deauths.clear(); handshakes.clear();
      seedWifi();
      seedGpsAnchors();
      return json({ok:true});

    case '/api/security/handshakes':
      return json({sd:state.sdBoard, files:state.sdBoard?hsSdFiles.slice():[]});
    case '/api/security/handshake': {
      const name=(await readForm(opts)).get('name');
      const idx=hsSdFiles.findIndex(f=>f.name===name);
      if(idx<0) return json({ok:false,err:'notfound'});
      hsSdFiles.splice(idx,1);
      return json({ok:true});
    }

    case '/api/security/handshake/capture':
      return json({err:'recon'}, 403); // WITH_RECON: capture disabled
    case '/api/security/handshakes/ram':
      return json({armed: state.hsRamArmed, targets: []});
    case '/api/security/handshake/ram':
      return json({ok:false, err:'notfound'}, 404);

    case '/api/sysinfo':
      return json({
        heapFree: 118000+irnd(-4000,4000), heapSize: 327680, heapMin: 96000,
        psramFree: 0, psramSize: 0,
        sketchUsed: 1380000, sketchFree: 620000, flashSize: 8388608,
        wifi: wifiRecs.size,
        gate: state.uiPass?1:0, gatenvs: state.gateNvs?1:0, gatedef: state.gateDefault?1:0,
        hiddb: [...wifiRecs.values()].filter(w=>w.hidden||w.everNamed===false).length,
        tdongle: state.dongle?1:0, led: state.led?1:0, screen: state.screen,
        orient: state.orient, bootmode: state.bootmode, bootmask: state.bootmask,
        bootchan: state.bootchan,
      });

    case '/api/prefs/pollms':
      if(q.has('ms')) state.pollms = clamp(parseInt(q.get('ms'),10)||1000,250,10000);
      return json({ok:true, pollms: state.pollms});

    case '/api/wifi/capture': {
      if(state.cap) return json({ok:true, busy:true});
      const b = await readForm(opts);
      if(b.has('cap')) state.capchan = parseInt(b.get('cap'),10)||0;
      if(b.has('captypes')) state.captypes = parseInt(b.get('captypes'),10)||0;
      if(b.has('data')) state.capdata = b.get('data')!=='0';
      if(b.has('frames')) state.framesOn = b.get('frames')!=='0';
      if(b.has('framesdetail')){
        state.frameDetailOn = b.get('framesdetail')!=='0';
        if(state.frameDetailOn) frameDetailBuf.length=0;
      }
      armCapture(parseInt(b.get('secs'),10));
      return json({ok:true, secs: state.capSecs});
    }

    case '/api/wifi/chan': {
      const b = await readForm(opts);
      if(b.has('cap')) state.capchan = parseInt(b.get('cap'),10)||0;
      if(b.has('scout')) state.scoutchan = parseInt(b.get('scout'),10)||0;
      if(b.has('scout5')) state.scoutchan5 = parseInt(b.get('scout5'),10)||0;
      return json({ok:true, cap: state.capchan, scout: state.scoutchan, scout5: state.scoutchan5||0});
    }

    case '/api/wifi/opts': {
      const b = await readForm(opts);
      if(b.has('data')) state.capdata = b.get('data')!=='0';
      if(b.has('scoutdata')) state.scoutdata = b.get('scoutdata')!=='0';
      if(b.has('scouttypes')) state.scouttypes = parseInt(b.get('scouttypes'),10)||0;
      if(b.has('retain')) state.retain = b.get('retain')!=='0';
      if(b.has('ttlmin')) state.ttlmin = Math.max(0, parseInt(b.get('ttlmin'),10)||0);
      if(b.has('scoutpause')) state.scoutpause = b.get('scoutpause')!=='0';
      if(b.has('scoutflush')) { /* no-op: nothing queued in the demo */ }
      if(b.has('frames')) state.framesOn = b.get('frames')!=='0';
      return json({ok:true, data: state.capdata?1:0, scoutdata: state.scoutdata?1:0,
        scouttypes: state.scouttypes, retain: state.retain?1:0, ttlmin: state.ttlmin,
        scoutpause: state.scoutpause?1:0, frames: state.framesOn?1:0});
    }

    case '/api/wifi/scout': {
      const since = parseInt(q.get('since'),10)||0;
      return json({linked: state.scoutLinked?1:0, total: scoutFeedId,
        lines: scoutFeed.filter(l=>l.id>since).map(l=>({id:l.id, age: now()-l.tMs, s:l.s}))});
    }

    case '/api/prefs/led':
      if(q.has('on')) state.led = q.get('on')!=='0';
      return json({ok:true, led: state.led?1:0});
    case '/api/prefs/screen':
      if(q.has('mode')) state.screen = parseInt(q.get('mode'),10)||0;
      return json({ok:true, screen: state.screen});
    case '/api/prefs/orient':
      if(q.has('o')) state.orient = parseInt(q.get('o'),10)||0;
      return json({ok:true, orient: state.orient});
    case '/api/prefs/bootsentinel':
      if(q.has('mode')) state.bootmode = parseInt(q.get('mode'),10)||0;
      if(q.has('mask')) state.bootmask = parseInt(q.get('mask'),10)||0;
      if(q.has('chan')) state.bootchan = parseInt(q.get('chan'),10)||0;
      return json({ok:true, bootmode: state.bootmode, bootmask: state.bootmask, bootchan: state.bootchan});
    case '/api/prefs/idleview':
      if(q.has('v')) state.idleview = parseInt(q.get('v'),10)||0;
      return json({ok:true, idleview: state.idleview});
    case '/api/prefs/autooff':
      if(q.has('min')) state.autooff = parseInt(q.get('min'),10)||0;
      return json({ok:true, autooff: state.autooff});
    case '/api/prefs/dim':
      if(q.has('pct')) state.dim = clamp(parseInt(q.get('pct'),10)||100,10,100);
      return json({ok:true, dim: state.dim});
    case '/api/prefs/roguecat':
      if(q.has('mask')) state.roguecat = parseInt(q.get('mask'),10)||0;
      return json({ok:true, roguecat: state.roguecat});

    case '/api/captive': {
      const b = await readForm(opts);
      if(b.has('on')) state.captive = b.get('on')!=='0';
      return json({ok:true, captive: state.captive?1:0});
    }

    case '/api/security/hiddb':
      if(opts.method==='POST'){ /* clear -- no-op, seeded hidden APs stay */ }
      return json({ok:true, hiddb: [...wifiRecs.values()].filter(w=>w.hidden).length});

    /* ---- Network settings (dashboard AP + uplink STA + MAC overrides) --- */
    case '/api/network/ap':
      if(opts.method==='POST'){
        const b = await readForm(opts);
        if(q.has('reset')){
          state.apSsid='802Eleven'; state.apOpen=false; state.apHidden=true; state.apSsidNvs=false;
        } else {
          if(b.has('ssid')) state.apSsid=b.get('ssid')||state.apSsid;
          if(b.has('sec')) state.apOpen=(b.get('sec')!=='wpa2');
          if(b.has('pass') && b.get('pass')) state.apPass=b.get('pass');
          if(b.has('hidden')) state.apHidden=b.get('hidden')!=='0';
          state.apSsidNvs=true;
        }
        return json({ok:true, ssid:state.apSsid, open:state.apOpen?1:0, hidden:state.apHidden?1:0});
      }
      return json({ssid:state.apSsid, open:state.apOpen?1:0, hidden:state.apHidden?1:0,
        haspass: state.apOpen?0:1, custom: state.apSsidNvs?1:0, ssiddef:'802Eleven',
        mac: state.apMac, macrand: state.macRandLast?1:0});

    case '/api/network/appass':
      return json({ssid:state.apSsid, open:state.apOpen?1:0, pass: state.apOpen?'':state.apPass});

    case '/api/network/apmac': {
      const b = await readForm(opts);
      state.apMac = b.get('mac')||'';
      return json({ok:true});
    }

    case '/api/network/sta':
      if(opts.method==='POST'){
        if(q.has('forget')){ state.staSsid=''; state.staPass=''; state.staStatus=0; return json({ok:true, status:0}); }
        if(q.has('enable')){ state.staEnabled = q.get('enable')!=='0'; return json({ok:true, en: state.staEnabled?1:0}); }
        const b = await readForm(opts);
        if(b.has('ssid')) state.staSsid=b.get('ssid');
        if(b.has('pass') && b.get('pass')) state.staPass=b.get('pass');
        state.staEnabled=true; state.staStatus=2;
        return json({ok:true, status: state.staStatus});
      }
      return json({ssid:state.staSsid, haspass: state.staPass?1:0, en: state.staEnabled?1:0,
        status: state.staStatus, ip: state.staStatus===2?'192.168.1.42':'', rssi: state.staStatus===2?-58:null,
        mac: state.staMac, maclink: state.staMacLink?1:0});

    case '/api/network/stamac': {
      const b = await readForm(opts);
      state.staMac = b.get('mac')||''; state.staMacLink=false;
      return json({ok:true});
    }
    case '/api/network/stamaclink':
      if(q.has('on')) state.staMacLink = q.get('on')!=='0';
      return json({ok:true});
    case '/api/network/macrand':
      if(q.has('on')) state.macRandLast = q.get('on')!=='0';
      return json({ok:true});

    /* ---- Sentinel watch (WITH_SECURITYTOOLS) ------------------------------ */
    case '/api/sentinel/start': {
      const b = await readForm(opts);
      sentinelStart(parseInt(b.get('mask'),10)||7, parseInt(b.get('chan'),10)||0);
      return json({ok:true});
    }
    case '/api/sentinel/stop':
      sentinelStop();
      return json({ok:true});
    case '/api/sentinel/allow': {
      const b = await readForm(opts);
      const mac = b.get('mac');
      if(sentinel && mac){ sentinel.rogueAllowed.add(mac); sentinel.rogueHits.delete(mac); }
      return json({ok:true});
    }
    case '/api/sentinel/dismiss': {
      const b = await readForm(opts);
      const type = b.get('type'), mac = b.get('mac');
      if(sentinel){
        if(type==='deauth'){ sentinel.deauthAlerting=false; sentinel.deauthRows.clear(); }
        else if(type==='karma'){ sentinel.karmaResponded=false; sentinel.karmaSends=0; }
        else if(type==='rogue' && mac){ sentinel.rogueHits.delete(mac); }
      }
      return json({ok:true});
    }
    case '/api/sentinel/clear':
      if(sentinel){
        sentinel.deauthRows.clear(); sentinel.deauthAlerting=false;
        sentinel.karmaResponded=false; sentinel.karmaSends=0;
        sentinel.rogueHits.clear();
      }
      return json({ok:true});

    /* ---- Send-Frame injection — disabled in WITH_RECON ------------------- */
    case '/api/security/inject/start':
    case '/api/security/inject/stop':
      return json({err:'recon'}, 403);

    /* ---- Local AP / captive portal (WITH_SECURITYTOOLS) ------------------ */
    case '/api/security/localap': {
      const since = parseInt(q.get('since'),10)||0;
      return json({active: state.localApActive?1:0, linked: state.scoutLinked?1:0,
        local: state.localApLocal?1:0, unlimited: state.localApUnlimited?1:0,
        secsleft: state.localApSecsLeft, total: state.localApTotal,
        subtotal: state.localApSubtotal, statotal: state.localApStaTotal,
        fields: state.localApFields.filter(c=>c.id>since)});
    }
    case '/api/security/localap/start': {
      const b = await readForm(opts);
      const secs = clamp(parseInt(b.get('secs'),10)||120,30,1800);
      state.localApActive=true; state.localApLocal=!state.scoutLinked;
      state.localApUnlimited=false; state.localApSecsLeft=secs;
      state.localApTotal=0; state.localApSubtotal=0; state.localApStaTotal=0;
      clearInterval(state.localApTimer);
      state.localApTimer=setInterval(()=>{
        if(!state.localApActive) return;
        state.localApSecsLeft--;
        if(state.localApSecsLeft<=0){ clearInterval(state.localApTimer); state.localApActive=false; return; }
        if(Math.random()<0.15){
          state.localApStaTotal++;
          state.localApFields.push({id:++state.localApFieldId, age:0,
            fields:'event=connect; mac='+randMac(true)});
        }
        if(Math.random()<0.3){
          state.localApTotal++; state.localApSubtotal++;
          const uas=['Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/116',
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
            'curl/7.88.1','Dalvik/2.1.0 (Linux; U; Android 12)'][Math.floor(Math.random()*5)];
          const r=Math.random();
          if(r<0.35){
            const hosts=['connectivitycheck.gstatic.com','captive.apple.com','detectportal.firefox.com',
              'msftconnecttest.com','www.msftncsi.com','nmcheck.gnome.org'][Math.floor(Math.random()*6)];
            state.localApFields.push({id:++state.localApFieldId, age:0, fields:'dns='+hosts});
          } else if(r<0.65){
            const hosts=['connectivitycheck.gstatic.com','captive.apple.com','detectportal.firefox.com',
              'msftconnecttest.com'][Math.floor(Math.random()*4)];
            const paths=['/generate_204','/hotspot-detect.html','/canonical.html','/connecttest.txt'][Math.floor(Math.random()*4)];
            state.localApFields.push({id:++state.localApFieldId, age:0,
              fields:'host='+hosts+'; path='+paths+'; ua='+uas});
          } else {
            const langs=['en-US','en-GB','fr-FR','de-DE','zh-CN','ja-JP','es-ES'][Math.floor(Math.random()*7)];
            const tzs=['America/New_York','Europe/London','Asia/Tokyo','America/Los_Angeles','Europe/Berlin'][Math.floor(Math.random()*5)];
            const scrs=['390x844','1170x2532','1280x800','1920x1080','414x896','360x780'][Math.floor(Math.random()*6)];
            const cpus=[2,4,6,8][Math.floor(Math.random()*4)];
            const mems=[1,2,4,8][Math.floor(Math.random()*4)];
            const conns=['4g','3g','wifi','2g'][Math.floor(Math.random()*4)];
            state.localApFields.push({id:++state.localApFieldId, age:0,
              fields:'lang='+langs+'; tz='+tzs+'; scr='+scrs+'; touch=5; mem='+mems+'; cpu='+cpus+'; conn='+conns+'; ua='+uas});
          }
        }
      },1000);
      return json({ok:true});
    }
    case '/api/security/localap/stop':
      state.localApActive=false; clearInterval(state.localApTimer);
      return json({ok:true});

    /* ---- SD-backed session archive/replay --------------------------------
     * The demo's simulated 802eleven/esp32-s3-sec primary has no SD slot (SD
     * is Cardputer-only, see CLAUDE.md), so this mirrors the real firmware's
     * behaviour there: everything degrades to sd:false/nosd/404 unless the
     * Env popover's "SD card present" toggle (state.sdBoard) is on. ------- */
    case '/api/session/list':
      return json({sd: state.sdBoard, files: state.sdBoard? state.sessions.slice() : []});
    case '/api/session/load': {
      if(!state.sdBoard) return new Response('', {status:404});
      const name=q.get('name');
      const s=state.sessions.find(f=>f.name===name);
      if(!s) return new Response('', {status:404});
      return json(s.data);
    }
    case '/api/session/save': {
      if(!state.sdBoard) return json({ok:false,err:'nosd'});
      const body=await readBody(opts);
      let data; try{ data=JSON.parse(body); }catch(e){ data={}; }
      const label=q.get('label')||'';
      const name=(label?label.replace(/[^A-Za-z0-9_-]/g,'').slice(0,24)+'_':'')+'session'+(++state.sessionSeq)+'.json';
      state.sessions.push({name, size:body.length, data});
      return json({ok:true, name});
    }
    case '/api/session/delete': {
      const b=await readForm(opts);
      const name=b.get('name');
      const idx=state.sessions.findIndex(f=>f.name===name);
      if(idx<0) return json({ok:false,err:'notfound'});
      state.sessions.splice(idx,1);
      return json({ok:true});
    }
    case '/api/session/wifilog':
      if(!state.sdBoard) return new Response('', {status:404});
      return json({app:'802Eleven', version:1, wifilog:true, mode:'wifi', wifi:{wifi:[]}});
    case '/api/session/wifilog/clear':
      if(!state.sdBoard) return json({ok:false,err:'nosd'});
      return json({ok:true});
    case '/api/session/wifiscan':
      if(!state.sdBoard) return new Response('', {status:404});
      return json({app:'802Eleven', version:1, wscan:true, mode:'wifi', wifi:{wifi:[]}, assoc:[]});
    case '/api/session/wifisync':
      if(opts.method==='POST') return state.sdBoard? json({ok:true}) : json({ok:false,err:'nosd'});
      return new Response('', {status:200, headers:{'Content-Type':'text/plain'}});

    case '/api/auth/login': {
      if(!state.uiPass) return json({ok:true});
      const body = await readBody(opts);
      if(body===state.uiPass){ document.cookie='sstoken=demo; Path=/'; return json({ok:true}); }
      return json({err:'auth'}, 401);
    }

    case '/api/auth/setpass': {
      const body = await readBody(opts);
      const nl = body.indexOf('\n');
      const oldPw = nl>=0? body.slice(0,nl) : body;
      const newPw = nl>=0? body.slice(nl+1) : '';
      const reset = q.get('reset')==='1';
      if(state.uiPass && oldPw!==state.uiPass) return json({err:'oldpass'}, 403);
      if(reset){ state.uiPass=''; state.gateNvs=false; }
      else { state.uiPass=newPw; state.gateNvs=!!newPw; }
      return json({ok:true});
    }

    default:
      return json({err:'not found'}, 404);
  }
}
async function readBody(opts){
  if(!opts || !opts.body) return '';
  if(typeof opts.body === 'string') return opts.body;
  try{ return await new Response(opts.body).text(); }catch(e){ return ''; }
}
async function readForm(opts){ return new URLSearchParams(await readBody(opts)); }

})();
