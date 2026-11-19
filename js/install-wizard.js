(function () {

  var FLAG_CATALOG = {
    WITH_SECURITYTOOLS: { label: 'Security tools', desc: 'WPS IE parsing, passive EAPOL activity tracking, frame crafting, Local AP/captive portal.' },
    WITH_TLS: { label: 'TLS (HTTPS)', desc: 'Dashboard on :443 with the embedded self&#8209;signed cert instead of plain HTTP.', warn: 'Each live HTTPS connection costs ~32&nbsp;KB heap &mdash; risky stacked on an already heap&#8209;tight image (e.g. + Security tools).' },
    WITH_WIFIOPEN: { label: 'Open WiFi AP', desc: "Board's own AP has no password &mdash; dashboard gate (if set) is unaffected." },
    WITH_FRAMES: { label: 'Frame dump', desc: 'Live per&#8209;frame Wireshark&#8209;style dump pushed over the WebSocket.' },
    WITH_SERIAL: { label: 'Serial console', desc: 'Interactive command console over the boot&#8209;log UART/USB&#8209;CDC.' },
    WITH_WEB_THEMES: { label: 'Web themes', desc: 'All 12 dashboard palettes selectable at runtime instead of one compiled&#8209;in.' },
    WITH_SDCARD: { label: 'SD card', desc: 'SdSpool heap&#8209;relief log, cross&#8209;device snapshot, full IEEE OUI lookup. No&#8209;op with no card mounted.' },
    WITH_GPS: { label: 'GPS + Log only', desc: 'Logs WiFi sightings to SD, GPS&#8209;tagged when a fix is held &mdash; a GPS module is optional, logging still runs without one.', warn: 'Requires <code>WITH_SDCARD=1</code> too, and is only wired up on the Cardputer build.' },
    WITH_CYDWEB: { label: 'CYD web server', desc: 'A Settings "Web Server" toggle that brings up the same dashboard/AP stack as the devkit primary.', only: ['cyd', 'cyd-c5'] }
  };

  var DEVICE_ICONS = {
    board: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 4v3"/><path d="M15 4v3"/><path d="M9 17v3"/><path d="M15 17v3"/><path d="M4 9h3"/><path d="M4 15h3"/><path d="M17 9h3"/><path d="M17 15h3"/>',
    keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M6.5 10h.01"/><path d="M10 10h.01"/><path d="M14 10h.01"/><path d="M17.5 10h.01"/><path d="M7 14h10"/>',
    dongle: '<rect x="7" y="3" width="10" height="13" rx="2"/><path d="M10 16v2"/><path d="M14 16v2"/><path d="M9 21h6"/>',
    display: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    stick: '<rect x="9" y="3" width="6" height="13" rx="2"/><circle cx="12" cy="19" r="2"/>'
  };
  function deviceIconSvg(key) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + DEVICE_ICONS[key] + '</svg>';
  }

  var DEVICES = [
    {
      id: 's3', label: 'ESP32&#8209;S3 DevKitC&#8209;1', note: 'Native USB&#8209;JTAG on&#8209;board &mdash; flash port is the 303A VID.',
      portNote: 'Two USB ports show up: VID <code>303A</code> (native USB&#8209;JTAG) is the flash port; a CH343 bridge (VID <code>1A86</code>) carries the boot log only.',
      icon: 'board', group: 'main',
      fixed: true, fixedEnv: '802eleven', baked: ['WITH_SECURITYTOOLS', 'WITH_FRAMES'],
      fixedFeatures: ['WiFi capture (mgmt, or mgmt+data frames)', 'Optional Scout board over UART', 'No dashboard password by default']
    },
    {
      id: 'cardputer', label: 'M5Stack Cardputer Adv', note: 'On&#8209;device LCD + keyboard UI, plus the web dashboard.',
      portNote: 'Native USB&#8209;CDC flash port (no separate boot&#8209;log bridge on this build).',
      icon: 'keyboard', group: 'main',
      fixed: true, fixedEnv: 'cardputer', baked: ['WITH_SECURITYTOOLS', 'WITH_FRAMES'],
      fixedFeatures: ['On&#8209;device tile menu (Web Server, WiFi Scan, Sentinel, Scout, Settings)', 'No mDNS on this build']
    },
    {
      id: 'tdongle', label: 'T&#8209;Dongle&#8209;C5', note: 'Pocket dongle, dual&#8209;band (2.4/5&nbsp;GHz), LCD + BOOT button + APA102 LED.',
      portNote: 'Native USB&#8209;JTAG flash port, VID <code>303A</code>.',
      icon: 'dongle', group: 'main',
      fixed: true, fixedEnv: 't-dongle-c5', baked: ['WITH_SECURITYTOOLS', 'WITH_FRAMES'],
      fixedFeatures: ['Dual&#8209;band capture (2.4/5&nbsp;GHz)', 'Tiny on&#8209;device screen UI']
    },
    {
      id: 'cyd', label: 'CYD (Cheap Yellow Display)', note: 'ESP32&#8209;2432S028R touchscreen board.',
      portNote: 'Single USB&#8209;UART bridge &mdash; same port for flashing and monitoring.',
      icon: 'display', group: 'main',
      fixed: true, fixedEnv: 'cyd-24', baked: ['WITH_SECURITYTOOLS', 'WITH_FRAMES'], pillExclude: ['WITH_CYDWEB'],
      fixedFeatures: ['Touchscreen on&#8209;device UI', 'Local WiFi Scan (no web UI/AP, no scout)']
    },
    {
      id: 'cyd-c5', label: 'CYD&#8209;C5 (NM&#8209;CYD&#8209;C5)', note: 'Dual&#8209;band (2.4/5&nbsp;GHz) CYD variant with PSRAM.',
      portNote: 'Native USB&#8209;JTAG flash port, VID <code>303A</code>.',
      icon: 'display', group: 'main',
      fixed: true, fixedEnv: 'cyd-c5', baked: ['WITH_SECURITYTOOLS', 'WITH_FRAMES'],
      fixedFeatures: ['Touchscreen on&#8209;device UI', 'Dual&#8209;band capture (2.4/5&nbsp;GHz)']
    },
    {
      id: 'stick', label: 'M5StickC&#8209;S3', note: 'Compact stick build &mdash; WIP, not yet a released image.',
      portNote: 'Native USB&#8209;CDC flash port.',
      icon: 'stick', group: 'main',
      fixed: true, fixedEnv: 'sticks3', baked: ['WITH_SECURITYTOOLS', 'WITH_FRAMES'],
      fixedFeatures: ['Screen&#8209;only on&#8209;device UI (Scan APs / Scan Clients)']
    },
    {
      id: 'scout', label: 'Scout (ESP32&#8209;S3)', note: 'Headless companion board &mdash; continuous WiFi monitor mode, streams frames to a primary over UART.',
      portNote: 'Native USB&#8209;JTAG flash port, VID <code>303A</code> &mdash; same board type as the S3 primary, so tell them apart by the <code>SER=</code> MAC, not COM number.',
      icon: 'board', group: 'scout',
      fixed: true, fixedEnv: 'scout', baked: ['WITH_SECURITYTOOLS', 'WITH_FRAMES'],
      fixedFeatures: ['Continuous WiFi monitor mode (no capture bursts)', 'No dashboard/AP of its own', 'UART link to a primary board']
    },
    {
      id: 'scout-c5', label: 'Scout C5 (ESP32&#8209;C5)', note: 'Dual&#8209;band (2.4/5&nbsp;GHz) scout variant.',
      portNote: 'Native USB&#8209;JTAG flash port, VID <code>303A</code>.',
      icon: 'board', group: 'scout',
      fixed: true, fixedEnv: 'scout-c5', baked: ['WITH_SECURITYTOOLS', 'WITH_FRAMES'],
      fixedFeatures: ['Continuous dual&#8209;band WiFi monitor mode (2.4/5&nbsp;GHz)', 'No dashboard/AP of its own', 'UART link to a primary board (TX=GPIO11, RX=GPIO12 &mdash; XIAO C5 breakout)']
    }
  ];

  var wiz = {
    step: 0,
    deviceIdx: 0,
    buildIdx: 0,
    flags: {}
  };

  function curDevice() { return DEVICES[wiz.deviceIdx]; }
  function curEnv() {
    var d = curDevice();
    return d.fixed ? d.fixedEnv : d.builds[wiz.buildIdx].env;
  }
  function curBaked() {
    var d = curDevice();
    return (d.fixed ? d.baked : d.builds[wiz.buildIdx].baked) || [];
  }
  function pillableFlags() {
    var d = curDevice();
    var excl = d.pillExclude || [];
    return Object.keys(FLAG_CATALOG).filter(function (f) {
      var meta = FLAG_CATALOG[f];
      if (excl.indexOf(f) !== -1) return false;
      if (meta.only && meta.only.indexOf(d.id) === -1) return false;
      return true;
    });
  }
  function isBakedOn(f) { return curBaked().indexOf(f) !== -1; }
  function resetFlags() {
    wiz.flags = {};
    curBaked().forEach(function (f) { wiz.flags[f] = true; });
  }
  function curExtraFlags() {
    return pillableFlags().filter(function (f) { return !!wiz.flags[f] !== isBakedOn(f); });
  }

  function renderSteps() {
    var els = document.querySelectorAll('.wiz-step');
    els.forEach(function (el, i) {
      el.classList.toggle('active', i === wiz.step);
      el.classList.toggle('done', i < wiz.step);
    });
  }

  var DEVICE_GROUPS = [
    { id: 'main', label: '802Eleven', desc: 'Standalone boards &mdash; each runs its own dashboard/AP.' },
    { id: 'scout', label: 'Scout', desc: 'Headless companions &mdash; capture only, stream to a primary over UART, no web UI.' }
  ];

  function renderDevicePanel() {
    var html = '<h3 class="wiz-title">Choose your board</h3><p class="wiz-sub">Which 802Eleven target are you flashing?</p>';
    DEVICE_GROUPS.forEach(function (g) {
      var members = DEVICES.map(function (d, i) { return { d: d, i: i }; }).filter(function (x) { return x.d.group === g.id; });
      if (!members.length) return;
      html += '<h4 class="device-group-title">' + g.label + '</h4><p class="device-group-sub">' + g.desc + '</p><div class="device-grid">';
      members.forEach(function (x) {
        var d = x.d, i = x.i;
        html += '<button class="device-opt' + (i === wiz.deviceIdx ? ' sel' : '') + '" data-device="' + i + '"><span class="device-icon">' + deviceIconSvg(d.icon) + '</span><div><h4>' + d.label + '</h4><p>' + d.note + '</p></div></button>';
      });
      html += '</div>';
    });
    return html;
  }

  function renderFlagPills() {
    var pillable = pillableFlags();
    if (!pillable.length) return '';
    var html = '<div class="flag-pills-head"><h4 style="margin:0; font-family:var(--mono); font-size:0.84rem;">Flags</h4><p class="wiz-sub">Highlighted = on in this build\'s default image. Click a pill to flip it &mdash; each flip becomes an explicit <code>-D FLAG=0/1</code> override, no <code>platformio.ini</code> edit, not a tested combo.</p></div><div class="flag-pills">';
    pillable.forEach(function (f) {
      var meta = FLAG_CATALOG[f];
      var on = !!wiz.flags[f];
      var baked = isBakedOn(f);
      var flipped = on !== baked;
      var title = meta.desc.replace(/<[^>]+>/g, '') + (baked ? ' (on by default)' : '');
      html += '<button type="button" class="flag-pill' + (on ? ' on' : '') + (meta.warn ? ' warn' : '') + (flipped ? ' flipped' : '') + '" data-flagpill="' + f + '" title="' + title + '">' + meta.label + '</button>';
    });
    html += '</div>';
    var warnFlag = pillable.filter(function (f) { return wiz.flags[f] && FLAG_CATALOG[f].warn; })[0];
    if (warnFlag) html += '<p class="flag-pill-warn">&#9888; ' + FLAG_CATALOG[warnFlag].warn + '</p>';
    return html;
  }

  function renderFeaturesPanel() {
    var d = curDevice();
    if (d.fixed) {
      var html = '<h3 class="wiz-title">Features</h3><p class="feat-fixed-note">' + d.label + ' ships one build (<code>' + d.fixedEnv + '</code>) with a fixed feature set:</p><ul style="margin:0; padding-left:18px; color:var(--text-dim); font-size:0.82rem; line-height:1.6;">';
      d.fixedFeatures.forEach(function (f) { html += '<li>' + f + '</li>'; });
      html += '</ul>' + renderFlagPills();
      return html;
    }
    var html2 = '<h3 class="wiz-title">Choose your build</h3><p class="wiz-sub">' + d.label + ' has several feature variants &mdash; pick one.</p><div class="feat-list">';
    d.builds.forEach(function (b, i) {
      html2 += '<div class="feat-opt' + (i === wiz.buildIdx ? ' sel' : '') + '" data-build="' + i + '"><span class="dot"></span><div><h4>' + b.label + '</h4><p>' + b.desc + '</p></div></div>';
    });
    html2 += '</div>' + renderFlagPills();
    return html2;
  }

  function renderInstructionsPanel() {
    var d = curDevice();
    var extra = curExtraFlags();
    var extraLi = extra.length
      ? '<li>Flags flipped from <code>' + curEnv() + '</code>\'s default: ' + extra.map(function (f) { return '<code>' + f + '=' + (wiz.flags[f] ? 1 : 0) + '</code>'; }).join(', ') + ' (see the next step\'s command).</li>'
      : '';
    return '' +
      '<h3 class="wiz-title">Instructions</h3><p class="wiz-sub">For ' + d.label + ' &mdash; env <code>' + curEnv() + '</code>.</p>' +
      '<ol style="margin:0; padding-left:20px; color:var(--text-dim); font-size:0.86rem; line-height:1.8;">' +
      '<li>Clone the repo and open it in PlatformIO (VS Code extension or the CLI).</li>' +
      '<li>Plug the board in over USB. ' + d.portNote + '</li>' +
      '<li>Build then flash the <code>' + curEnv() + '</code> env (exact commands on the next step).</li>' +
      extraLi +
      '<li>Join the <strong>802Eleven</strong> WiFi AP (see the next step for grabbing the password), then browse to the dashboard.</li>' +
      '</ol>';
  }

  function renderCommandsPanel() {
    var env = curEnv();
    var d = curDevice();
    var extra = curExtraFlags();
    var extraArgs = extra.length ? ' ' + extra.map(function (f) { return '-D ' + f + '=' + (wiz.flags[f] ? 1 : 0); }).join(' ') : '';
    var cmds = [
      { title: 'Clone', cmd: 'git clone <repo>' },
      { title: 'Build', cmd: 'pio run -e ' + env + extraArgs },
      { title: 'Find the flash port', cmd: 'pio device list' },
      { title: 'Flash', cmd: 'pio run -e ' + env + extraArgs + ' -t upload --upload-port <port>' },
      { title: 'Get the WiFi password (Python)', cmd: 'python tools/wifi_qr.py' },
      { title: 'Browse the dashboard', cmd: 'http://192.168.4.1/' }
    ];
    var html = '<h3 class="wiz-title">Commands</h3><p class="wiz-sub">' + d.portNote + '</p>';
    if (extra.length) html += '<p class="flag-pill-note">Extra <code>-D</code> flags applied on top of <code>' + env + '</code>\'s own build_flags &mdash; not a validated platformio.ini env, your combo.</p>';
    cmds.forEach(function (c, i) {
      html += '<div class="cmd-block"><h4>' + c.title + '</h4><pre id="cmdpre' + i + '">' + c.cmd.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre><button class="cmd-copy" data-copy="' + i + '">Copy</button></div>';
    });
    html += '' +
      '<div class="serial-panel">' +
      '<h4>Or read the WiFi password straight from the board</h4>' +
      '<p class="hint">Connects to the boot&#8209;log serial port in this browser (Web Serial) and scrapes the same "WiFi AP :" / "Password :" banner <code>tools/wifi_qr.py</code> reads &mdash; no Python needed. Chrome/Edge only.</p>' +
      '<div class="serial-tabs">' +
      '<button class="serial-tab active" data-tab="connect">Connect</button>' +
      '<button class="serial-tab" data-tab="wifiqr">Join WiFi</button>' +
      '<button class="serial-tab" data-tab="dashqr">Dashboard</button>' +
      '<button class="serial-tab" data-tab="console">Console</button>' +
      '</div>' +
      '<div class="serial-tab-panel" data-tabpanel="connect">' +
      '<div class="serial-controls">' +
      '<button class="serial-btn" id="serialConnect">Connect to board&hellip;</button>' +
      '<button class="serial-btn" id="serialDisconnect" disabled>Disconnect</button>' +
      '<span class="serial-status" id="serialStatus">not connected</span>' +
      '</div>' +
      '<div class="serial-creds" id="serialCreds"></div>' +
      '<div class="serial-next-row">' +
      '<button class="serial-btn primary" id="serialNextConnect">Next: Join WiFi &rarr;</button>' +
      '</div>' +
      '</div>' +
      '<div class="serial-tab-panel serial-center" data-tabpanel="wifiqr" hidden>' +
      '<p class="serial-dash-hint" id="serialWifiHint">Connect to the board first (Connect tab) to get its live SSID/password.</p>' +
      '<div class="qr-box" id="serialQrWifiBox" style="display:none;"><h5>Scan to join WiFi</h5><div id="qrWifi"></div></div>' +
      '<button class="serial-btn primary" id="serialNextWifi">Next: Dashboard &rarr;</button>' +
      '</div>' +
      '<div class="serial-tab-panel serial-center" data-tabpanel="dashqr" hidden>' +
      '<div class="qr-box" id="serialQrDashBox"><h5>Scan to open dashboard</h5><div id="qrDash"></div></div>' +
      '<a class="serial-btn" id="serialOpenDash" href="' + DASHBOARD_URL + '" target="_blank" rel="noopener">Open dashboard &rarr;</a>' +
      '</div>' +
      '<div class="serial-tab-panel" data-tabpanel="console" hidden>' +
      '<div class="serial-log" id="serialLog"></div>' +
      '</div>' +
      '</div>';
    return html;
  }

  var PANEL_RENDERERS = [renderDevicePanel, renderFeaturesPanel, renderInstructionsPanel, renderCommandsPanel];

  function render() {
    renderSteps();
    var panel = document.getElementById('wizPanel');
    panel.innerHTML = PANEL_RENDERERS[wiz.step]();
    document.getElementById('wizBack').style.visibility = wiz.step === 0 ? 'hidden' : 'visible';
    document.getElementById('wizNext').textContent = wiz.step === 3 ? 'Done' : 'Next →';
    wireStepEvents();
  }

  function wireStepEvents() {
    var panel = document.getElementById('wizPanel');
    panel.querySelectorAll('[data-device]').forEach(function (el) {
      el.addEventListener('click', function () {
        wiz.deviceIdx = parseInt(el.getAttribute('data-device'), 10);
        wiz.buildIdx = 0;
        resetFlags();
        render();
      });
    });
    panel.querySelectorAll('[data-build]').forEach(function (el) {
      el.addEventListener('click', function () {
        wiz.buildIdx = parseInt(el.getAttribute('data-build'), 10);
        resetFlags();
        render();
      });
    });
    panel.querySelectorAll('[data-flagpill]').forEach(function (el) {
      el.addEventListener('click', function () {
        var f = el.getAttribute('data-flagpill');
        wiz.flags[f] = !wiz.flags[f];
        render();
      });
    });
    panel.querySelectorAll('[data-copy]').forEach(function (el) {
      el.addEventListener('click', function () {
        var pre = document.getElementById('cmdpre' + el.getAttribute('data-copy'));
        var text = pre.textContent;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).catch(function () {});
        }
        var old = el.textContent;
        el.textContent = 'Copied';
        setTimeout(function () { el.textContent = old; }, 1200);
      });
    });
    if (wiz.step === 3) wireSerialPanel();
  }

  document.querySelectorAll('.wiz-step').forEach(function (el) {
    el.addEventListener('click', function () {
      wiz.step = parseInt(el.getAttribute('data-step'), 10);
      render();
    });
  });

  document.getElementById('wizBack').addEventListener('click', function () {
    if (wiz.step > 0) { wiz.step--; render(); }
  });
  document.getElementById('wizNext').addEventListener('click', function () {
    if (wiz.step < 3) { wiz.step++; render(); }
    else { document.getElementById('wizard').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });

  resetFlags();
  render();

  var serialPort = null, serialReader = null, serialKeepReading = false;
  var reSsid = /WiFi AP\s*:\s*(\S+)/;
  var rePwd = /Password\s*:\s*(\S+)/;
  var DASHBOARD_URL = 'http://192.168.4.1/';

  function wifiUri(ssid, pwd, isOpen) {
    function esc(s) { return s.replace(/([\\;,:"])/g, '\\$1'); }
    var h = 'true';
    if (isOpen || !pwd) return 'WIFI:T:nopass;S:' + esc(ssid) + ';H:' + h + ';;';
    return 'WIFI:T:WPA;S:' + esc(ssid) + ';P:' + esc(pwd) + ';H:' + h + ';;';
  }

  function renderDashQr() {
    var qrDashEl = document.getElementById('qrDash');
    if (!qrDashEl || typeof QRCode === 'undefined') return;
    qrDashEl.innerHTML = '';
    new QRCode(qrDashEl, { text: DASHBOARD_URL, width: 160, height: 160 });
  }

  function renderWifiQr(ssid, pwd, isOpen) {
    var wifiBox = document.getElementById('serialQrWifiBox');
    var qrWifiEl = document.getElementById('qrWifi');
    if (!wifiBox || !qrWifiEl || typeof QRCode === 'undefined') return;
    qrWifiEl.innerHTML = '';
    new QRCode(qrWifiEl, { text: wifiUri(ssid, pwd, isOpen), width: 160, height: 160 });
    wifiBox.style.display = 'flex';
  }

  function serialLog(line) {
    var box = document.getElementById('serialLog');
    if (!box) return;
    var d = document.createElement('div');
    d.textContent = line;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  function serialCredChip(label, value) {
    return '<span class="serial-chip">' + label + ': ' + value + '<button data-copyval="' + value.replace(/"/g, '&quot;') + '">Copy</button></span>';
  }

  function showCreds(ssid, pwd, isOpen) {
    var box = document.getElementById('serialCreds');
    if (!box) return;
    var html = '';
    if (ssid) html += serialCredChip('SSID', ssid);
    if (isOpen) html += '<span class="serial-chip">Open network (no password)</span>';
    else if (pwd) html += serialCredChip('Password', pwd);
    box.innerHTML = html;
    box.querySelectorAll('[data-copyval]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var v = btn.getAttribute('data-copyval');
        if (navigator.clipboard) navigator.clipboard.writeText(v).catch(function () {});
        var old = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = old; }, 1200);
      });
    });
    renderWifiQr(ssid, pwd, isOpen);
    var wifiHint = document.getElementById('serialWifiHint');
    if (wifiHint) wifiHint.style.display = 'none';
    switchSerialTab('wifiqr');
  }

  function wireSerialTabs() {
    var tabs = document.querySelectorAll('.serial-tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        switchSerialTab(tab.getAttribute('data-tab'));
      });
    });
  }

  function switchSerialTab(name) {
    document.querySelectorAll('.serial-tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.getAttribute('data-tab') === name);
    });
    document.querySelectorAll('.serial-tab-panel').forEach(function (p) {
      p.hidden = p.getAttribute('data-tabpanel') !== name;
    });
  }

  function wireSerialPanel() {
    var connectBtn = document.getElementById('serialConnect');
    var disconnectBtn = document.getElementById('serialDisconnect');
    var status = document.getElementById('serialStatus');
    if (!connectBtn) return;

    wireSerialTabs();
    renderDashQr();

    var nextConnect = document.getElementById('serialNextConnect');
    if (nextConnect) nextConnect.addEventListener('click', function () { switchSerialTab('wifiqr'); });
    var nextWifi = document.getElementById('serialNextWifi');
    if (nextWifi) nextWifi.addEventListener('click', function () { switchSerialTab('dashqr'); });

    if (!('serial' in navigator)) {
      connectBtn.disabled = true;
      status.textContent = 'Web Serial not supported in this browser — use Chrome or Edge, or the Python tool above.';
      return;
    }

    connectBtn.addEventListener('click', function () {
      connectSerial(status, connectBtn, disconnectBtn);
    });
    disconnectBtn.addEventListener('click', function () {
      disconnectSerial(status, connectBtn, disconnectBtn);
    });
  }

  function connectSerial(status, connectBtn, disconnectBtn) {
    navigator.serial.requestPort().then(function (port) {
      serialPort = port;
      return port.open({ baudRate: 115200 });
    }).then(function () {
      status.textContent = 'connected, waiting for boot banner…';
      status.classList.add('live');
      connectBtn.disabled = true;
      disconnectBtn.disabled = false;
      if (serialPort.setSignals) {
        serialPort.setSignals({ dataTerminalReady: false, requestToSend: true })
          .then(function () { return new Promise(function (r) { setTimeout(r, 100); }); })
          .then(function () { return serialPort.setSignals({ requestToSend: false }); })
          .catch(function () {});
      }
      readSerialLoop();
    }).catch(function (err) {
      status.textContent = 'connect failed: ' + err.message;
      status.classList.remove('live');
    });
  }

  function disconnectSerial(status, connectBtn, disconnectBtn) {
    serialKeepReading = false;
    if (serialReader) { try { serialReader.cancel(); } catch (e) {} }
    if (serialPort) { serialPort.close().catch(function () {}); }
    serialPort = null;
    status.textContent = 'not connected';
    status.classList.remove('live');
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
  }

  function readSerialLoop() {
    serialKeepReading = true;
    var decoder = new TextDecoder();
    var buf = '';
    var ssid = null, pwd = null, isOpen = false;
    var textReader = serialPort.readable.getReader();
    serialReader = textReader;

    function pump() {
      if (!serialKeepReading) return;
      textReader.read().then(function (result) {
        if (result.done || !serialKeepReading) return;
        buf += decoder.decode(result.value, { stream: true });
        var lines = buf.split(/\r?\n/);
        buf = lines.pop();
        lines.forEach(function (line) {
          if (!line) return;
          serialLog(line);
          var m = reSsid.exec(line);
          if (m) ssid = m[1];
          if (/OPEN network/.test(line)) isOpen = true;
          else {
            var mp = rePwd.exec(line);
            if (mp) pwd = mp[1];
          }
          if (ssid && (pwd || isOpen)) {
            var status = document.getElementById('serialStatus');
            if (status) status.textContent = 'got it';
            showCreds(ssid, pwd, isOpen);
          }
        });
        pump();
      }).catch(function () {
        try { textReader.releaseLock(); } catch (e) {}
      });
    }
    pump();
  }
})();
