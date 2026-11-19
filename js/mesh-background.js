(function () {
  var canvas = document.getElementById('mesh');
  var ctx = canvas.getContext('2d');
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var DPR = Math.min(window.devicePixelRatio || 1, 2);
  var nodes = [];
  var W = 0, H = 0;
  var pulses = [];
  var lastPulse = 0;

  function hex2rgb(hex) {
    var h = hex.trim().replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var num = parseInt(h, 16) || 0;
    return ((num >> 16) & 255) + ',' + ((num >> 8) & 255) + ',' + (num & 255);
  }

  var curColors = null;
  function colors() {
    var cs = getComputedStyle(document.documentElement);
    var rgbA = hex2rgb(cs.getPropertyValue('--accent-a') || '#52ffff');
    var rgbB = hex2rgb(cs.getPropertyValue('--accent-b') || '#e6193f');
    var rgbDim = hex2rgb(cs.getPropertyValue('--text-dim') || '#8b41dd');
    return {
      node: 'rgba(' + rgbDim + ',0.5)',
      nodeApBg: 'rgba(' + rgbA + ',0.9)',
      line: 'rgba(' + rgbDim + ',0.18)',
      lineLit: 'rgba(' + rgbA + ',0.45)',
      pulseA: rgbA,
      pulseB: rgbB
    };
  }
  function refreshColors() { curColors = colors(); }

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    seed();
    refreshColors();
  }

  function seed() {
    var area = W * H;
    var count = Math.max(16, Math.min(46, Math.round(area / 34000)));
    nodes = [];
    for (var i = 0; i < count; i++) {
      var isAp = i % 5 === 0;
      nodes.push({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.10,
        vy: (Math.random() - 0.5) * 0.10,
        r: isAp ? 3.4 : 1.7,
        ap: isAp
      });
    }
  }

  function linkDist() {
    return Math.min(220, Math.max(120, Math.min(W, H) * 0.22));
  }

  function step(t) {
    var c = curColors || colors();
    ctx.clearRect(0, 0, W, H);
    var maxD = linkDist();

    if (!reduced) {
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < -20 || n.x > W + 20) n.vx *= -1;
        if (n.y < -20 || n.y > H + 20) n.vy *= -1;
      }
    }

    var edges = [];
    for (var a = 0; a < nodes.length; a++) {
      for (var b = a + 1; b < nodes.length; b++) {
        var na = nodes[a], nb = nodes[b];
        var dx = na.x - nb.x, dy = na.y - nb.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < maxD) {
          var lit = na.ap || nb.ap;
          ctx.strokeStyle = lit ? c.lineLit : c.line;
          ctx.lineWidth = lit ? 1 : 0.7;
          ctx.beginPath();
          ctx.moveTo(na.x, na.y);
          ctx.lineTo(nb.x, nb.y);
          ctx.stroke();
          if (lit) edges.push([a, b]);
        }
      }
    }

    if (!reduced && edges.length && t - lastPulse > 900) {
      lastPulse = t;
      var e = edges[Math.floor(Math.random() * edges.length)];
      pulses.push({ from: e[0], to: e[1], p: 0, color: Math.random() < 0.5 ? c.pulseA : c.pulseB });
    }

    pulses = pulses.filter(function (pl) { return pl.p <= 1; });
    for (var k = 0; k < pulses.length; k++) {
      var pl = pulses[k];
      var nf = nodes[pl.from], nt = nodes[pl.to];
      if (!nf || !nt) { pl.p = 2; continue; }
      var px = nf.x + (nt.x - nf.x) * pl.p;
      var py = nf.y + (nt.y - nf.y) * pl.p;
      var fade = pl.p < 0.15 ? pl.p / 0.15 : (pl.p > 0.85 ? (1 - pl.p) / 0.15 : 1);
      ctx.beginPath();
      ctx.fillStyle = 'rgba(' + pl.color + ',' + (0.9 * fade) + ')';
      ctx.arc(px, py, 2.4, 0, Math.PI * 2);
      ctx.fill();
      pl.p += 0.012;
    }

    for (var j = 0; j < nodes.length; j++) {
      var nn = nodes[j];
      ctx.beginPath();
      ctx.fillStyle = nn.ap ? c.nodeApBg : c.node;
      ctx.arc(nn.x, nn.y, nn.r, 0, Math.PI * 2);
      ctx.fill();
      if (nn.ap) {
        ctx.beginPath();
        ctx.strokeStyle = c.lineLit;
        ctx.lineWidth = 1;
        ctx.arc(nn.x, nn.y, nn.r + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    requestAnimationFrame(step);
  }

  window.addEventListener('resize', resize);
  try {
    refreshColors();
    resize();
    requestAnimationFrame(step);
  } catch (e) {}
})();
