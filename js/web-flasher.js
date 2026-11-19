(function () {
  function wireModeTabs() {
    document.querySelectorAll('.install-mode-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var mode = tab.getAttribute('data-mode');
        document.querySelectorAll('.install-mode-tab').forEach(function (t) {
          t.classList.toggle('active', t === tab);
        });
        document.querySelectorAll('.install-mode-panel').forEach(function (p) {
          p.hidden = p.getAttribute('data-mode-panel') !== mode;
        });
        if (mode !== 'webinstall') document.getElementById('wfPostFlash').hidden = true;
      });
    });
  }

  function wireWfTabs() {
    document.querySelectorAll('.wf-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var name = tab.getAttribute('data-wftab');
        document.querySelectorAll('.wf-tab').forEach(function (t) {
          t.classList.toggle('active', t === tab);
        });
        document.querySelectorAll('.wf-tab-panel').forEach(function (p) {
          p.hidden = p.getAttribute('data-wftabpanel') !== name;
        });
      });
    });
  }

  function switchWfTab(name) {
    document.querySelectorAll('.wf-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-wftab') === name);
    });
    document.querySelectorAll('.wf-tab-panel').forEach(function (p) {
      p.hidden = p.getAttribute('data-wftabpanel') !== name;
    });
  }

  function wireStaticCopyButtons() {
    document.querySelectorAll('.wf-tab-panel [data-copyval], .cmd-copy[data-copytext]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var v = btn.getAttribute('data-copyval') || btn.getAttribute('data-copytext');
        if (navigator.clipboard) navigator.clipboard.writeText(v).catch(function () {});
        var old = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = old; }, 1200);
      });
    });
  }

  function setConnectUi(isConnected) {
    var connectBtn = document.getElementById('wfConnect');
    var flashBtn = document.getElementById('wfFlash');
    var discBtn = document.getElementById('wfDisconnect');
    var term = document.querySelector('.wf-terminal');
    if (isConnected) {
      connectBtn.textContent = 'Connected';
      connectBtn.classList.add('connected');
      connectBtn.disabled = true;
      flashBtn.hidden = false;
      flashBtn.disabled = false;
      discBtn.hidden = false;
      discBtn.disabled = false;
      if (term) term.hidden = false;
    } else {
      connectBtn.textContent = 'Connect to board…';
      connectBtn.classList.remove('connected');
      connectBtn.disabled = false;
      flashBtn.hidden = true;
      flashBtn.disabled = true;
      discBtn.hidden = true;
      discBtn.disabled = true;
      if (term) term.hidden = true;
    }
  }

  function updateManualFlashCmd(erase) {
    var sel = document.getElementById('wfRelease');
    var rel = (sel && sel.value !== '') ? RELEASES[parseInt(sel.value, 10)] : null;
    var chip = (rel && rel.chip) ? rel.chip.replace(/-/g, '') : 'esp32s3';
    var base = 'esptool.py --chip ' + chip + ' --port COMx --baud 460800';
    var cmd = erase ? base + ' --erase-all write_flash 0x0 firmware-merged.bin' : base + ' write_flash 0x0 firmware-merged.bin';
    var pre = document.getElementById('manualFlashCmd');
    var btn = document.getElementById('manualFlashCopy');
    var note = document.getElementById('manualEraseNote');
    if (pre) pre.textContent = cmd;
    if (btn) btn.setAttribute('data-copytext', cmd);
    if (note) note.hidden = !erase;
  }

  var port = null, transport = null, espLoader = null, connected = false;
  var postFlashReader = null, postFlashKeepReading = false;
  var serialWriter = null;
  var capsTimer = null;
  var DASHBOARD_URL = 'http://192.168.4.1/';
  var reSsid = /WiFi AP\s*:\s*(\S+)/;
  var rePwd = /Password\s*:\s*(\S+)/;
  var reCaps = /^CAPS\s+(.+)/;
  var reMdns = /mDNS up:\s*(\S+)/;
  var reDevice = /^Device\s*:\s*(.+?)\s*$/;
  var reServerMsg = /^(Web server OFF.*|No web server on this build.*)$/;
  var mdnsUrl = null;
  var deviceSeen = false;
  var scoutSeen = false;
  var connectedChip = '';
  var BASE_CAPS = 'help,status,stop,clear,list,nets,scan,chan,band,type,data,clients,factory';

  var CMD_OPTIONS = {
    help: ['help'], status: ['status'], stop: ['stop'], clear: ['clear'],
    list: ['list'], nets: ['nets'], scan: ['scan 30', 'scan -'], chan: ['chan'],
    band: ['band'], type: ['type'], data: ['data on'], clients: ['clients'],
    watch: ['watch on'], factory: ['factory yes'], send: ['send help'],
    localap: ['localap help'], screen: ['screen normal'],
    orient: ['orient landscape'], led: ['led on'],
    sentinel: ['sentinel help', 'sentinel start all', 'sentinel start deauth', 'sentinel start karma',
      'sentinel start rogue', 'sentinel stop', 'sentinel status', 'sentinel hits', 'sentinel clear',
      'sentinel config', 'sentinel chan auto', 'sentinel chan 1,6,11', 'sentinel karma',
      'sentinel karma interval 4000', 'sentinel karma threshold 1', 'sentinel karma prefix sk-',
      'sentinel rogue all', 'sentinel allow ', 'sentinel boot off', 'sentinel boot all']
  };

  function applySupportedCommands(csv) {
    var names = csv.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var dl = document.getElementById('wfCmdList');
    if (!dl) return;
    dl.innerHTML = '';
    names.forEach(function (name) {
      (CMD_OPTIONS[name] || [name]).forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt;
        dl.appendChild(o);
      });
    });
  }

  var lastCapsAt = 0;
  var CAPS_MIN_INTERVAL_MS = 1500;
  var CAPS_ACK_TIMEOUT_MS = 2500;
  var capsReceived = false;
  var capsAckTimer = null;

  function setConsoleEnabled(enabled) {
    var note = document.getElementById('wfConsoleNoCaps');
    if (note) note.hidden = enabled;
    ['wfCmdInput', 'wfCmdSend', 'wfCmdInputModal', 'wfCmdSendModal'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.disabled = !enabled;
    });
    document.querySelectorAll('[data-wfcmd]').forEach(function (btn) { btn.disabled = !enabled; });
  }

  function requestCaps() {
    if (!postFlashKeepReading || !port || !serialWriter) return;
    var now = Date.now();
    if (now - lastCapsAt < CAPS_MIN_INTERVAL_MS) return;
    lastCapsAt = now;
    try { serialWriter.write(new TextEncoder().encode('caps\n')); } catch (e) {}
    if (capsAckTimer) clearTimeout(capsAckTimer);
    capsAckTimer = setTimeout(function () {
      if (!capsReceived) setConsoleEnabled(false);
    }, CAPS_ACK_TIMEOUT_MS);
  }

  var LOG_MAX_LINES = 500;

  function log(line) {
    document.querySelectorAll('.wf-log-target').forEach(function (box) {
      var d = document.createElement('div');
      d.textContent = line;
      box.appendChild(d);
      while (box.childNodes.length > LOG_MAX_LINES) box.removeChild(box.firstChild);
      box.scrollTop = box.scrollHeight;
    });
  }

  var terminal = {
    clean: function () {},
    writeLine: function (l) { log(l); },
    write: function (l) { log(l); }
  };

  function setStatus(text, mode) {
    var s = document.getElementById('wfStatus');
    if (!s) return;
    s.textContent = text;
    s.classList.toggle('live', mode === true);
    s.classList.toggle('done', mode === 'done');
    var row = document.getElementById('wfStatus').closest('.wf-progress-row');
    if (row) {
      var progress = document.getElementById('wfProgress');
      row.hidden = !text && (!progress || progress.hidden);
    }
  }

  function setProgress(pct) {
    var wrap = document.getElementById('wfProgress');
    var fill = document.getElementById('wfProgressFill');
    var pctEl = document.getElementById('wfProgressPct');
    if (!wrap) return;
    wrap.hidden = false;
    fill.style.width = pct + '%';
    pctEl.textContent = pct + '%';
  }

  function readFile(input) {
    return new Promise(function (resolve, reject) {
      var f = input && input.files && input.files[0];
      if (!f) { reject(new Error('no file selected for ' + (input ? input.id : '?'))); return; }
      var reader = new FileReader();
      reader.onload = function (e) { resolve(new Uint8Array(e.target.result)); };
      reader.onerror = function () { reject(new Error('failed to read ' + f.name)); };
      reader.readAsArrayBuffer(f);
    });
  }

  function parseAddr(s) {
    s = (s || '').trim();
    var n = /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
    return isNaN(n) ? 0 : n;
  }

  function wireFileNameDisplays() {
    var input = document.getElementById('wfFileMerged');
    var label = document.getElementById('wfFileMergedName');
    if (!input || !label) return;
    input.addEventListener('change', function () {
      label.textContent = (input.files && input.files[0]) ? input.files[0].name : 'Choose firmware .bin…';
    });
  }

  var extraRowSeq = 0;

  function addExtraRow(offset) {
    var id = 'wfExtra' + (++extraRowSeq);
    var row = document.createElement('div');
    row.className = 'wf-file-row wf-extra-row';
    row.innerHTML =
      '<input type="text" class="wf-addr" value="' + (offset || '0x0') + '" aria-label="Flash offset">' +
      '<label class="wf-file-input"><input type="file" accept=".bin" id="' + id + '"><span>Choose file&hellip;</span></label>' +
      '<button type="button" class="wf-remove" aria-label="Remove image">&times;</button>';
    var fileInput = row.querySelector('input[type="file"]');
    var fileLabel = row.querySelector('.wf-file-input span');
    fileInput.addEventListener('change', function () {
      fileLabel.textContent = (fileInput.files && fileInput.files[0]) ? fileInput.files[0].name : 'Choose file…';
    });
    row.querySelector('.wf-remove').addEventListener('click', function () { row.remove(); });
    document.getElementById('wfExtraFiles').appendChild(row);
  }

  function wireAddRowButtons() {
    document.querySelectorAll('[data-addpreset]').forEach(function (btn) {
      btn.addEventListener('click', function () { addExtraRow(btn.getAttribute('data-addpreset')); });
    });
  }

  function clearExtraRows() {
    document.getElementById('wfExtraFiles').innerHTML = '';
  }

  function extraFileArray() {
    var rows = Array.prototype.slice.call(document.querySelectorAll('.wf-extra-row'));
    var withFiles = rows.filter(function (row) { return row.querySelector('input[type="file"]').files.length; });
    return Promise.all(withFiles.map(function (row) {
      return readFile(row.querySelector('input[type="file"]')).then(function (data) {
        return { data: data, address: parseAddr(row.querySelector('.wf-addr').value) };
      });
    }));
  }

  var RELEASES = [];

  function loadReleases() {
    fetch('firmware/releases.json').then(function (r) {
      if (!r.ok) throw new Error('no manifest');
      return r.json();
    }).then(function (list) {
      if (!Array.isArray(list) || !list.length) return;
      RELEASES = list;
      var sel = document.getElementById('wfRelease');
      var ROLE_LABELS = { primary: 'Primary boards', scout: 'Scout boards (headless, no dashboard)' };
      var groups = {};
      list.forEach(function (rel, i) {
        var roleKey = rel.role || 'other';
        if (!groups[roleKey]) {
          var og = document.createElement('optgroup');
          og.label = ROLE_LABELS[roleKey] || 'Other';
          sel.appendChild(og);
          groups[roleKey] = og;
        }
        var opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = rel.label || rel.id || ('Build ' + (i + 1));
        groups[roleKey].appendChild(opt);
      });
      document.getElementById('wfReleaseRow').hidden = false;
      updateDownloadIcon();
      if (pendingReleaseId) selectReleaseById(pendingReleaseId);
    }).catch(function () { /* no prebuilt releases published — manual-only, unchanged */ });
  }

  function updateDownloadIcon() {
    var sel = document.getElementById('wfRelease');
    var btn = document.getElementById('wfReleaseDownload');
    if (!sel || !btn) return;
    btn.hidden = false;
    btn.disabled = sel.value === '';
  }

  function sha256Hex(buf) {
    return crypto.subtle.digest('SHA-256', buf).then(function (digest) {
      var bytes = new Uint8Array(digest);
      var hex = '';
      for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
      return hex;
    });
  }

  function verifySha256(buf, expected, label) {
    if (!expected) return Promise.resolve(buf);
    return sha256Hex(buf).then(function (actual) {
      if (actual !== expected.toLowerCase()) {
        throw new Error('checksum mismatch for ' + label + ' (expected ' + expected + ', got ' + actual + ')');
      }
      return buf;
    });
  }

  function downloadRelease(rel) {
    (rel.files || []).forEach(function (f) {
      fetch(f.url).then(function (r) {
        if (!r.ok) throw new Error('failed to fetch ' + f.url);
        return r.arrayBuffer();
      }).then(function (buf) {
        return verifySha256(buf, f.sha256, f.name || f.url).then(function () { return buf; });
      }).then(function (buf) {
        var blob = new Blob([buf]);
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = f.name || (rel.id + '.bin');
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      }).catch(function (err) { log('download failed: ' + err.message); });
    });
  }

  // Set once the user picks anything in the release dropdown (including
  // "own firmware"). Stops autoPickReleaseForChip() overriding that choice on
  // every later device connect.
  var releaseTouched = false;
  var pendingReleaseId = null;

  // Called from a "Supported hardware" card click (index.html) to
  // prepopulate the release dropdown for that board and jump to Install.
  function selectReleaseById(id) {
    var sel = document.getElementById('wfRelease');
    if (!sel) return;
    var idx = -1;
    for (var i = 0; i < RELEASES.length; i++) {
      if (RELEASES[i].id === id) { idx = i; break; }
    }
    if (idx === -1) { pendingReleaseId = id; return; }
    pendingReleaseId = null;
    sel.value = String(idx);
    sel.dispatchEvent(new Event('change'));
    document.querySelectorAll('.install-mode-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-mode') === 'webinstall');
    });
    document.querySelectorAll('.install-mode-panel').forEach(function (p) {
      p.hidden = p.getAttribute('data-mode-panel') !== 'webinstall';
    });
    var install = document.getElementById('install');
    if (install) install.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  window.wfSelectRelease = selectReleaseById;

  function wireReleaseSelect() {
    var sel = document.getElementById('wfRelease');
    if (!sel) return;
    sel.addEventListener('change', function () {
      releaseTouched = true;
      document.getElementById('wfManualFiles').hidden = sel.value !== '';
      document.getElementById('wfReleaseHint').textContent = '';
      updateDownloadIcon();
      updateManualFlashCmd(document.getElementById('wfErase').checked);
    });
    var btn = document.getElementById('wfReleaseDownload');
    if (btn) {
      btn.addEventListener('click', function () {
        if (sel.value === '') return;
        var rel = RELEASES[parseInt(sel.value, 10)];
        if (rel) downloadRelease(rel);
      });
    }
  }

  function autoPickReleaseForChip(chipName) {
    var sel = document.getElementById('wfRelease');
    if (!sel || !RELEASES.length || releaseTouched || sel.value !== '') return;
    var norm = (chipName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    var idx = RELEASES.findIndex(function (rel) {
      return rel.chip && norm.indexOf(String(rel.chip).toLowerCase().replace(/[^a-z0-9]/g, '')) !== -1;
    });
    if (idx === -1) return;
    sel.value = String(idx);
    document.getElementById('wfManualFiles').hidden = true;
    document.getElementById('wfReleaseHint').textContent = 'Auto-selected for your ' + chipName + '.';
    updateDownloadIcon();
    updateManualFlashCmd(document.getElementById('wfErase').checked);
  }

  function fetchReleaseFileArray(rel) {
    return Promise.all((rel.files || []).map(function (f) {
      return fetch(f.url).then(function (r) {
        if (!r.ok) throw new Error('failed to fetch ' + f.url);
        return r.arrayBuffer();
      }).then(function (buf) {
        return verifySha256(buf, f.sha256, f.name || f.url);
      }).then(function (buf) {
        return { data: new Uint8Array(buf), address: parseAddr(f.address) };
      });
    }));
  }

  function buildFileArray() {
    var sel = document.getElementById('wfRelease');
    if (sel && sel.value !== '') {
      var rel = RELEASES[parseInt(sel.value, 10)];
      if (!rel || !rel.files || !rel.files.length) return Promise.reject(new Error('selected build has no files'));
      return fetchReleaseFileArray(rel);
    }
    return readFile(document.getElementById('wfFileMerged')).then(function (primary) {
      return extraFileArray().then(function (extras) {
        return [{ data: primary, address: parseAddr(document.getElementById('wfAddrMerged').value) }].concat(extras);
      });
    });
  }

  function wifiUri(ssid, pwd, isOpen) {
    function esc(s) { return s.replace(/([\\;,:"])/g, '\\$1'); }
    var h = 'true';
    if (isOpen || !pwd) return 'WIFI:T:nopass;S:' + esc(ssid) + ';H:' + h + ';;';
    return 'WIFI:T:WPA;S:' + esc(ssid) + ';P:' + esc(pwd) + ';H:' + h + ';;';
  }

  function renderWfDashQr() {
    var url = mdnsUrl || DASHBOARD_URL;
    var urlEl = document.getElementById('wfDashUrl');
    var urlCopy = document.getElementById('wfDashUrlCopy');
    var ipEl = document.getElementById('wfDashIp');
    var ipCopy = document.getElementById('wfDashIpCopy');
    if (urlEl) urlEl.textContent = url;
    if (urlCopy) urlCopy.setAttribute('data-copyval', url);
    if (ipEl) ipEl.textContent = DASHBOARD_URL;
    if (ipCopy) ipCopy.setAttribute('data-copyval', DASHBOARD_URL);

    var el = document.getElementById('wfQrDash');
    if (!el || typeof QRCode === 'undefined') return;
    el.innerHTML = '';
    new QRCode(el, { text: url, width: 160, height: 160 });
  }

  function renderWfWifiQr(ssid, pwd, isOpen) {
    var box = document.getElementById('wfQrWifiBox');
    var el = document.getElementById('wfQrWifi');
    if (!box || !el || typeof QRCode === 'undefined') return;
    el.innerHTML = '';
    new QRCode(el, { text: wifiUri(ssid, pwd, isOpen), width: 160, height: 160 });
    box.classList.remove('qr-shown');
    box.style.display = 'flex';
  }

  function initQrReveal() {
    document.querySelectorAll('.qr-click').forEach(function (box) {
      var timer;
      function toggle() {
        clearTimeout(timer);
        if (box.classList.toggle('qr-shown')) timer = setTimeout(function () { box.classList.remove('qr-shown'); }, 8000);
      }
      box.addEventListener('click', toggle);
      box.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
  }
  initQrReveal();

  function wfCredRow(label, value, copyable) {
    var valueHtml = '<code>' + value + '</code>';
    if (copyable) valueHtml += '<button class="wf-copy" data-copyval="' + value.replace(/"/g, '&quot;') + '">Copy</button>';
    return '<div class="wf-cred-row"><span class="wf-cred-label">' + label + '</span><span class="wf-cred-value">' + valueHtml + '</span></div>';
  }

  function showWfCreds(ssid, pwd, isOpen) {
    var box = document.getElementById('wfCreds');
    if (!box) return;
    var html = '';
    if (ssid) html += wfCredRow('SSID', ssid, true);
    if (isOpen) html += wfCredRow('Password', 'open network — no password', false);
    else if (pwd) {
      var esc = pwd.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
      html += '<div class="wf-cred-row"><span class="wf-cred-label">Password</span><span class="wf-cred-value">' +
        '<code data-pw="' + esc + '">' + '&bull;'.repeat(Math.min(pwd.length, 16)) + '</code>' +
        '<button class="wf-copy" data-reveal="1">Reveal</button>' +
        '<button class="wf-copy" data-copyval="' + esc + '">Copy</button></span></div>';
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-reveal]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var code = btn.parentNode.querySelector('code[data-pw]');
        var shown = btn.textContent === 'Hide';
        clearTimeout(btn._t);
        if (!shown) btn._t = setTimeout(function () { if (btn.textContent === 'Hide') btn.click(); }, 8000);
        code.textContent = shown ? '•'.repeat(Math.min(code.getAttribute('data-pw').length, 16)) : code.getAttribute('data-pw');
        btn.textContent = shown ? 'Reveal' : 'Hide';
      });
    });
    box.querySelectorAll('[data-copyval]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var v = btn.getAttribute('data-copyval');
        if (navigator.clipboard) navigator.clipboard.writeText(v).catch(function () {});
        var old = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = old; }, 1200);
      });
    });
    renderWfWifiQr(ssid, pwd, isOpen);
  }

  function showDeviceNote(device) {
    deviceSeen = true;
    if (/scout/i.test(device)) scoutSeen = true;
  }

  function updateSdcardNote(hasSdcard) {
    var note = document.getElementById('wfSdcardNote');
    if (note) note.hidden = !hasSdcard;
  }

  function showServerNote(line) {
    var note = document.getElementById('wfServerNote');
    var text = document.getElementById('wfServerNoteText');
    if (!note || !text) return;
    text.textContent = line;
    note.hidden = false;
    document.getElementById('wfPostFlash').hidden = false;
    if (/^No web server on this build/.test(line)) {
      var pending = document.getElementById('wfCredsPending');
      if (pending) pending.hidden = true;
      // Scout companion: no WiFi/dashboard/console on this board, ever --
      // the Join WiFi / Dashboard / Console tabs have nothing to show.
      var tabs = document.getElementById('wfTabs');
      if (tabs) tabs.hidden = true;
      document.querySelectorAll('.wf-tab-panel').forEach(function (p) { p.hidden = true; });
      var openDash = document.getElementById('wfOpenDash');
      if (openDash) openDash.hidden = true;
      renderScoutPinout();
    }
  }

  // Scout UART link to a primary board -- TX/RX cross, common GND (see
  // CLAUDE.md "Scout companion" wiring). The scout's own pin depends on its
  // chip: XIAO C5 only breaks out D0-D10, so scout-c5 uses D6/D7 (GPIO11/12)
  // instead of the S3 scout's GPIO17/18. The primary's pin depends on WHICH
  // primary board it's wired to -- devkit S3 uses GPIO17/18, Cardputer's
  // GPIO17/18 aren't broken out so it uses its rear header G3/G4 instead --
  // independent of the scout chip, so both are listed.
  function renderScoutPinout() {
    var c5 = /c5/i.test(connectedChip);
    var scoutTx = c5 ? 'D6 (GPIO11)' : 'GPIO17';
    var scoutRx = c5 ? 'D7 (GPIO12)' : 'GPIO18';
    var rows = [
      ['Scout TX', scoutTx, 'Devkit RX (GPIO18)', 'Cardputer RX (G4)'],
      ['Scout RX', scoutRx, 'Devkit TX (GPIO17)', 'Cardputer TX (G3)'],
      ['GND', '&mdash;', 'Devkit GND', 'Cardputer GND']
    ];
    var html = '<tr><th>Scout pin</th><th>&rarr; Devkit S3 primary</th><th>&rarr; Cardputer primary</th></tr>';
    rows.forEach(function (r) {
      html += '<tr><td>' + r[0] + ' <code>' + r[1] + '</code></td><td>' + r[2] + '</td><td>' + r[3] + '</td></tr>';
    });
    var table = document.getElementById('wfScoutPinTable');
    var box = document.getElementById('wfScoutPins');
    var title = document.getElementById('wfStage3Title');
    if (table) table.innerHTML = html;
    if (box) box.hidden = false;
    if (title) title.textContent = 'Wire up the scout';
  }

  function readBootBanner(timeoutMs, revealImmediately) {
    setStatus('Checking for WiFi banner…', true);
    deviceSeen = false;
    scoutSeen = false;
    capsReceived = false;
    if (capsAckTimer) { clearTimeout(capsAckTimer); capsAckTimer = null; }
    setConsoleEnabled(false);
    var snote = document.getElementById('wfServerNote');
    if (snote) snote.hidden = true;
    log('--- reading boot banner ---');
    if (revealImmediately) {
      document.getElementById('wfPostFlash').hidden = false;
      renderWfDashQr();
    }
    port.open({ baudRate: 115200 }).then(function () {
      postFlashKeepReading = true;
      try { serialWriter = port.writable.getWriter(); } catch (e) {}
      var decoder = new TextDecoder();
      var buf = '';
      var ssid = null, pwd = null, isOpen = false;
      var found = false;
      var reader = port.readable.getReader();
      postFlashReader = reader;

      if (port.setSignals) {
        // Espressif's own usb_jtag_serial_reset (reset-to-run) sequence ends
        // with DTR high, RTS low -- required on native-USB boards (XIAO C5/
        // scout-c5, t-dongle-c5: no CH34x/CP210x reset bridge) or the chip
        // lands in download mode instead of booting firmware. Harmless on
        // classic CH343/CH340-bridge boards (primary/scout S3): their
        // auto-reset circuits are RC-coupled to the DTR/RTS *transitions*,
        // not the steady-state level left behind afterward.
        port.setSignals({ dataTerminalReady: false, requestToSend: true })
          .then(function () { return new Promise(function (r) { setTimeout(r, 100); }); })
          .then(function () { return port.setSignals({ dataTerminalReady: true, requestToSend: false }); })
          .catch(function () {});
      }
      if (capsTimer) clearTimeout(capsTimer);
      capsTimer = setTimeout(requestCaps, 400);

      var timer = timeoutMs ? setTimeout(function () {
        if (found || !postFlashKeepReading) return;
        stopBootBannerWatch();
        if (!deviceSeen) {
          setStatus('Connected — not running 802Eleven firmware', true);
          log('No 802Eleven "Device :" line seen — this board is not running 802Eleven firmware.');
          return;
        }
        if (scoutSeen) {
          setStatus('Connected — Scout companion board', 'done');
          log('Scout companion detected — headless WiFi relay, no dashboard/password on this board.');
          return;
        }
        setStatus('Connected — no WiFi banner seen yet', true);
        log('No WiFi banner seen within ' + Math.round(timeoutMs / 1000) + 's — flash firmware, or reconnect once it\'s booted.');
      }, timeoutMs) : null;

      function pump() {
        if (!postFlashKeepReading) return;
        reader.read().then(function (result) {
          if (result.done || !postFlashKeepReading) return;
          buf += decoder.decode(result.value, { stream: true });
          var lines = buf.split(/\r?\n/);
          buf = lines.pop();
          lines.forEach(function (line) {
            if (!line) return;
            log(line);
            var m = reSsid.exec(line);
            if (m) ssid = m[1];
            if (/OPEN network/.test(line)) isOpen = true;
            else {
              var mp = rePwd.exec(line);
              if (mp) pwd = mp[1];
            }
            var md = reDevice.exec(line);
            if (md) showDeviceNote(md[1]);
            var msv = reServerMsg.exec(line);
            if (msv) showServerNote(msv[1]);
            var mc = reCaps.exec(line);
            if (mc) {
              capsReceived = true;
              if (capsAckTimer) { clearTimeout(capsAckTimer); capsAckTimer = null; }
              setConsoleEnabled(true);
              applySupportedCommands(mc[1]);
            }
            var mm = reMdns.exec(line);
            if (mm) { mdnsUrl = mm[1]; renderWfDashQr(); }
            if (!found && ssid && (pwd || isOpen)) {
              found = true;
              if (timer) clearTimeout(timer);
              setStatus('');
              document.getElementById('wfPostFlash').hidden = false;
              var snote = document.getElementById('wfServerNote');
              if (snote) snote.hidden = true;
              renderWfDashQr();
              showWfCreds(ssid, pwd, isOpen);
            }
          });
          pump();
        }).catch(function (err) {
          if (postFlashKeepReading) log('Boot banner read stopped: ' + err.message);
          try { reader.releaseLock(); } catch (e) {}
        });
      }
      pump();
    }).catch(function (err) {
      log('Could not open the port to read the boot banner: ' + err.message);
    });
  }

  function stopBootBannerWatch() {
    postFlashKeepReading = false;
    if (capsTimer) { clearTimeout(capsTimer); capsTimer = null; }
    var reader = postFlashReader;
    postFlashReader = null;
    if (!reader) return Promise.resolve();
    return reader.cancel().catch(function () {}).then(function () {
      try { reader.releaseLock(); } catch (e) {}
    });
  }

  function releaseSerialWriter() {
    if (!serialWriter) return;
    try { serialWriter.releaseLock(); } catch (e) {}
    serialWriter = null;
  }

  function closePortIfOpen() {
    releaseSerialWriter();
    if (port && port.readable) return port.close().catch(function () {});
    return Promise.resolve();
  }

  function revealTerminal() {
    var d = document.querySelector('.wf-terminal');
    if (d) d.open = true;
  }

  function sendConsoleCmd(cmd) {
    cmd = (cmd || '').trim();
    if (!cmd) return;
    revealTerminal();
    if (!port || !serialWriter) {
      log('ERR not connected — click Connect first and wait for the boot banner read to start');
      return;
    }
    log('> ' + cmd);
    serialWriter.write(new TextEncoder().encode(cmd + '\n')).catch(function (err) {
      log('Write failed: ' + err.message);
    });
  }

  function wireSendPair(inputId, btnId) {
    var input = document.getElementById(inputId);
    var btn = document.getElementById(btnId);
    if (!input || !btn) return;
    function go() { sendConsoleCmd(input.value); input.value = ''; }
    btn.addEventListener('click', go);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
  }

  function wireConsole() {
    setConsoleEnabled(false);
    var consoleTab = document.querySelector('[data-wftab="console"]');
    if (consoleTab) consoleTab.addEventListener('click', function () { revealTerminal(); requestCaps(); });
    document.querySelectorAll('[data-wfcmd]').forEach(function (btn) {
      btn.addEventListener('click', function () { sendConsoleCmd(btn.getAttribute('data-wfcmd')); });
    });
    wireSendPair('wfCmdInput', 'wfCmdSend');
    wireSendPair('wfCmdInputModal', 'wfCmdSendModal');

    var expandBtn = document.getElementById('wfConsoleExpand');
    var modal = document.getElementById('wfConsoleModal');
    var closeBtn = document.getElementById('wfConsoleModalClose');
    if (modal && modal.parentNode !== document.body) document.body.appendChild(modal);
    function openModal() { modal.hidden = false; document.body.classList.add('wf-modal-open'); requestCaps(); }
    function closeModal() { modal.hidden = true; document.body.classList.remove('wf-modal-open'); }
    if (expandBtn && modal) expandBtn.addEventListener('click', openModal);
    if (closeBtn && modal) closeBtn.addEventListener('click', closeModal);
    if (modal) {
      modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !modal.hidden) closeModal();
      });
    }
  }

  function ensureRomSession() {
    if (espLoader) return Promise.resolve();
    if (!port) return Promise.reject(new Error('no board connected — click Connect first'));
    return stopBootBannerWatch().then(closePortIfOpen).then(function () {
      transport = new window.esptooljs.Transport(port, true);
      espLoader = new window.esptooljs.ESPLoader({ transport: transport, baudrate: 115200, terminal: terminal });
      setStatus('Reconnecting to flash…', true);
      return espLoader.main();
    }).then(function (chip) {
      connected = true;
      connectedChip = chip;
      log('Reconnected for flashing: ' + chip);
    });
  }

  // Clears stage 3 (join/dashboard/console) back to its pending state --
  // used both on a full UI reset and right after a flash, so a reboot
  // doesn't leave the previous session's stale creds/URL/caps on screen
  // while the board is still coming back up.
  function resetStage3Ui() {
    capsReceived = false;
    if (capsAckTimer) { clearTimeout(capsAckTimer); capsAckTimer = null; }
    setConsoleEnabled(false);
    applySupportedCommands(BASE_CAPS);
    mdnsUrl = null;
    var snote = document.getElementById('wfServerNote');
    if (snote) snote.hidden = true;
    updateSdcardNote(false);
    document.getElementById('wfCreds').innerHTML = '<div class="wf-cred-row wf-cred-pending" id="wfCredsPending">Reading WiFi credentials from the boot log&hellip;</div>';
    document.getElementById('wfQrWifiBox').style.display = 'none';
    document.querySelectorAll('.qr-click').forEach(function (b) { b.classList.remove('qr-shown'); });
    var dashUrlEl = document.getElementById('wfDashUrl');
    var dashIpEl = document.getElementById('wfDashIp');
    if (dashUrlEl) dashUrlEl.textContent = DASHBOARD_URL;
    if (dashIpEl) dashIpEl.textContent = DASHBOARD_URL;
    var dashQr = document.getElementById('wfQrDash');
    if (dashQr) dashQr.innerHTML = '';
    document.getElementById('wfOpenDash').hidden = false;
    var tabs = document.getElementById('wfTabs');
    if (tabs) tabs.hidden = false;
    document.querySelectorAll('.wf-tab-panel').forEach(function (p) { p.hidden = p.getAttribute('data-wftabpanel') !== 'wifi'; });
    var scoutPins = document.getElementById('wfScoutPins');
    if (scoutPins) scoutPins.hidden = true;
    var title = document.getElementById('wfStage3Title');
    if (title) title.textContent = 'Join & open the dashboard';
    switchWfTab('wifi');
  }

  function resetWfUi() {
    stopBootBannerWatch();
    releaseSerialWriter();
    resetStage3Ui();
    if (port) { try { port.close(); } catch (e) {} }
    port = null; transport = null; espLoader = null; connected = false;
    document.getElementById('wfPostFlash').hidden = true;
    document.querySelectorAll('.wf-log-target').forEach(function (box) { box.innerHTML = ''; });
    document.getElementById('wfFileMerged').value = '';
    document.getElementById('wfFileMergedName').textContent = 'Choose firmware .bin…';
    document.getElementById('wfAddrMerged').value = '0x0';
    clearExtraRows();
    var releaseSel = document.getElementById('wfRelease');
    if (releaseSel) releaseSel.value = '';
    document.getElementById('wfManualFiles').hidden = false;
    document.getElementById('wfReleaseHint').textContent = '';
    switchWfTab('wifi');
    setProgress(0);
    document.getElementById('wfProgress').hidden = true;
    setConnectUi(false);
    setStatus('');
  }

  function connect() {
    document.getElementById('wfConnect').disabled = true;
    stopBootBannerWatch().then(function () {
      return navigator.serial.requestPort();
    }).then(function (p) {
      port = p;
      return closePortIfOpen();
    }).then(function () {
      transport = new window.esptooljs.Transport(port, true);
      espLoader = new window.esptooljs.ESPLoader({ transport: transport, baudrate: 115200, terminal: terminal });
      setStatus('connecting…');
      return espLoader.main();
    }).then(function (chip) {
      log('Detected chip: ' + chip);
      connectedChip = chip;
      autoPickReleaseForChip(chip);
      setConnectUi(true);
      return transport.disconnect().then(function () {
        connected = false;
        espLoader = null;
        transport = null;
        readBootBanner(6000, false);
      });
    }).catch(function (err) {
      setConnectUi(false);
      setStatus('connect failed: ' + err.message);
      log('Connect failed: ' + err.message);
    });
  }

  function disconnect() {
    (async function () {
      await stopBootBannerWatch();
      try { if (espLoader) await espLoader.after('no_reset'); } catch (e) {}
      try { if (transport) await transport.disconnect(); } catch (e) {}
      try { await closePortIfOpen(); } catch (e) {}
      connected = false;
      port = null; transport = null; espLoader = null;
      setStatus('');
      setConnectUi(false);
    })();
  }

  function flash() {
    var flashBtn = document.getElementById('wfFlash');
    flashBtn.disabled = true;
    setStatus('Connecting…', true);

    var sel = document.getElementById('wfRelease');
    var selRel = (sel && sel.value !== '') ? RELEASES[parseInt(sel.value, 10)] : null;
    updateSdcardNote(!!(selRel && selRel.sdcard));

    ensureRomSession().then(function () {
      setStatus('Reading files…', true);
      return buildFileArray();
    }).then(function (fileArray) {
      setStatus('Flashing… do not disconnect the board', true);
      var erase = document.getElementById('wfErase').checked;
      return espLoader.writeFlash({
        fileArray: fileArray,
        flashMode: 'keep',
        flashFreq: 'keep',
        flashSize: 'keep',
        eraseAll: erase,
        compress: true,
        reportProgress: function (fileIndex, written, total) {
          setProgress(total ? Math.round((written / total) * 100) : 0);
        }
      });
    }).then(function () {
      log('Flash complete.');
      setStatus('Flash complete — resetting board', true);
      return espLoader.after('hard_reset');
    }).then(function () {
      return transport.disconnect();
    }).then(function () {
      connected = false;
      espLoader = null;
      transport = null;
      var connectBtn = document.getElementById('wfConnect');
      connectBtn.textContent = 'Flashed';
      connectBtn.classList.add('connected');
      connectBtn.disabled = true;
      document.getElementById('wfFlash').hidden = true;
      var discBtn = document.getElementById('wfDisconnect');
      discBtn.hidden = false;
      discBtn.disabled = false;
      resetStage3Ui();
      readBootBanner(0, true);
    }).catch(function (err) {
      setStatus('flash failed: ' + err.message);
      log('Flash failed: ' + err.message);
      flashBtn.disabled = false;
    });
  }

  function wfInit() {
    var connectBtn = document.getElementById('wfConnect');
    if (!connectBtn) return;

    wireFileNameDisplays();
    wireAddRowButtons();
    wireReleaseSelect();
    loadReleases();
    wireWfTabs();
    wireStaticCopyButtons();
    wireConsole();

    if (!('serial' in navigator)) {
      document.getElementById('wfBrowserWarn').hidden = false;
      document.querySelector('.wf-actions').hidden = true;
      var webTab = document.querySelector('.install-mode-tab[data-mode="webinstall"]');
      if (webTab) { webTab.disabled = true; webTab.title = 'This browser doesn’t support Web Serial'; }
      var manualTab = document.querySelector('.install-mode-tab[data-mode="manual"]');
      if (manualTab) manualTab.click();
      return;
    }

    connectBtn.addEventListener('click', connect);
    document.getElementById('wfDisconnect').addEventListener('click', disconnect);
    document.getElementById('wfFlash').addEventListener('click', flash);
    document.getElementById('wfFlashAnother').addEventListener('click', resetWfUi);
    document.getElementById('wfOpenDash').addEventListener('click', function () {
      var cur = document.querySelector('.wf-tab.active');
      var curName = cur ? cur.getAttribute('data-wftab') : 'wifi';
      if (curName === 'wifi') switchWfTab('dash');
      else if (curName === 'dash') {
        switchWfTab('console');
        this.hidden = true;
      }
    });
    document.getElementById('wfErase').addEventListener('change', function (e) {
      document.getElementById('wfEraseWarn').hidden = !e.target.checked;
      updateManualFlashCmd(e.target.checked);
    });
    updateManualFlashCmd(document.getElementById('wfErase').checked);

    if (typeof window.esptooljs === 'undefined') {
      connectBtn.disabled = true;
      setStatus('loading esptool-js…');
      window.addEventListener('esptooljs-ready', function () {
        connectBtn.disabled = false;
        setStatus('');
      }, { once: true });
      setTimeout(function () {
        if (typeof window.esptooljs === 'undefined') {
          setStatus('esptool-js failed to load — check your connection and reload.');
        }
      }, 8000);
    }
  }

  wireModeTabs();
  wfInit();
})();
