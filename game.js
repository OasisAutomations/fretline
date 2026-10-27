// Fretline game engine: timing, judging, scoring, rendering, input.
(function () {
  const FL = window.FL = window.FL || {};
  const COLORS = ['#2dd4bf', '#38bdf8', '#a78bfa', '#fbbf24', '#fb7185'];
  FL.LANE_COLORS = COLORS;
  const PERFECT = 0.05, GOOD = 0.115;

  FL.ensureCtx = function () {
    if (!FL.ctx) { const AC = window.AudioContext || window.webkitAudioContext; FL.ctx = new AC({ latencyHint: 'interactive' }); FL.master = FL.ctx.createGain(); FL.master.connect(FL.ctx.destination); }
    if (FL.ctx.state === 'suspended' && !(G && G.state === 'paused')) FL.ctx.resume().catch(() => {});
    return FL.ctx;
  };

  const $ = s => document.querySelector(s);
  let cv, g2, video;
  const G = FL.G = {
    state: 'idle', // idle | countdown | play | paused | resuming | done
    mode: 'play', notes: [], lanes: [[], [], [], [], []], ptr: [0, 0, 0, 0, 0],
    score: 0, combo: 0, maxCombo: 0, perfect: 0, good: 0, miss: 0, total: 0,
    star: 0, starOn: false, pressed: [0, 0, 0, 0, 0], fx: [], fb: null, rec: [],
    t0: 0, src: null, lastT: -3, lastC: 0, lastP: 0, settings: null, pointers: new Map(), geo: null, resumeAt: 0
  };

  function outLat() { const c = FL.ctx; return (c.outputLatency || 0) || (c.baseLatency || 0) || 0; }
  // smooth audible song time (seconds; negative during lead-in)
  function nowSong() {
    const c = FL.ctx; if (!c) return 0;
    if (G.state === 'paused' || G.state === 'resuming' || G.state === 'done' || G.state === 'idle') return G.lastT;
    const ct = c.currentTime, p = performance.now();
    if (ct !== G.lastC) { G.lastC = ct; G.lastP = p; }
    const t = G.lastC + Math.min(0.05, (p - G.lastP) / 1000) - outLat() - G.t0;
    return t;
  }
  FL.songTime = nowSong;

  FL.Game = {
    start(o) {
      cv = $('#cv'); g2 = cv.getContext('2d'); video = $('#bgVideo');
      FL.ensureCtx();
      Object.assign(G, { buf: o.buf, chart: o.notes || [], bpm: o.bpm || 0, phase: o.phase || 0, mode: o.mode || 'play', onEnd: o.onEnd, onRecEnd: o.onRecEnd, settings: o.settings, hasVideo: !!o.hasVideo, snapGrid: o.snapGrid || null, title: o.title || '' });
      G.restartOpts = o;
      begin();
    },
    restart() { begin(); },
    pause() { pause(); },
    resume() { resume(); },
    quit() { stopAll(); G.state = 'idle'; },
    stopRecording() { if (G.mode === 'record' && G.state !== 'idle') finish(); },
    press: (lane, t) => press(lane, t),
    liveSettings(s) { G.settings = s; }
  };

  function stopSrc() {
    if (G.src) { try { G.src.onended = null; G.src.stop(); } catch (e) {} try { G.src.disconnect(); } catch (e) {} G.src = null; }
  }
  function stopAll() { stopSrc(); if (video) video.pause(); G.pointers.clear(); }

  function begin() {
    stopSrc();
    const ctx = FL.ensureCtx();
    G.notes = G.mode === 'record' ? [] : G.chart.map((n, i) => ({ t: n.t, lane: n.lane, sp: !!n.sp, st: 0, id: i }));
    G.lanes = [[], [], [], [], []]; G.ptr = [0, 0, 0, 0, 0];
    G.notes.forEach(n => G.lanes[n.lane].push(n));
    G.total = G.notes.length;
    Object.assign(G, { score: 0, combo: 0, maxCombo: 0, perfect: 0, good: 0, miss: 0, star: 0, starOn: false, fx: [], fb: null, rec: [], pressed: [0, 0, 0, 0, 0], phraseOk: {} });
    // star phrases: group sp notes by consecutive runs
    let run = 0, prevSp = false; G.phrases = [];
    G.notes.forEach(n => { if (n.sp) { if (!prevSp) run++; n.phrase = run; } prevSp = n.sp; });
    G.notes.forEach(n => { if (n.phrase) { G.phrases[n.phrase] = G.phrases[n.phrase] || { n: 0, hit: 0, failed: false }; G.phrases[n.phrase].n++; } });
    const lead = 3;
    G.t0 = ctx.currentTime + 0.12 + lead; G.lastC = ctx.currentTime; G.lastP = performance.now(); G.lastT = -lead;
    const src = ctx.createBufferSource(); src.buffer = G.buf; src.connect(FL.master); src.start(G.t0);
    src.onended = () => { if (G.src === src && (G.state === 'play')) finish(); };
    G.src = src; G.state = 'play'; G.vidStarted = false; G.lastSync = 0;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    if (video && G.hasVideo) { try { video.pause(); video.currentTime = Math.max(0, (G.settings.voff || 0) / 1000); } catch (e) {} }
    G.endT = G.mode === 'record' ? G.buf.duration : Math.min(G.buf.duration + 0.2, (G.notes.length ? G.notes[G.notes.length - 1].t : 0) + 1.6);
    if (G.mode === 'play' && G.notes.length === 0) G.endT = G.buf.duration;
    if (!G.rafOn) { G.rafOn = true; requestAnimationFrame(frame); }
  }

  function pause() {
    if (G.state !== 'play' && G.state !== 'resuming') return;
    if (G.state === 'play') G.lastT = nowSong();
    G.state = 'paused';
    FL.ctx.suspend().catch(() => {}); if (video) video.pause();
    G.pointers.clear(); G.pressed = [0, 0, 0, 0, 0];
    document.dispatchEvent(new CustomEvent('fl-paused'));
  }
  function resume() {
    if (G.state !== 'paused') return;
    G.state = 'resuming'; G.resumeAt = performance.now() + 3000;
  }
  function doResume() {
    G.resumeAt = Infinity;
    FL.ctx.resume().then(() => {
      if (G.state !== 'resuming') return;
      G.lastC = FL.ctx.currentTime; G.lastP = performance.now(); G.state = 'play';
      if (video && G.hasVideo && G.vidStarted) video.play().catch(() => {});
    });
  }

  function finish() {
    if (G.state === 'done') return;
    G.lastT = nowSong(); G.state = 'done'; stopSrc(); if (video) video.pause();
    G.pointers.clear();
    if (G.mode === 'record') G.onRecEnd && G.onRecEnd(G.rec.slice());
    else G.onEnd && G.onEnd(summary());
  }
  function summary() {
    const tot = G.perfect + G.good + G.miss, acc = tot ? (G.perfect + 0.6 * G.good) / tot : 0;
    return { score: G.score, perfect: G.perfect, good: G.good, miss: G.miss, total: G.total, maxCombo: G.maxCombo, accuracy: acc, stars: acc >= 0.95 ? 5 : acc >= 0.85 ? 4 : acc >= 0.7 ? 3 : acc >= 0.5 ? 2 : 1 };
  }
  FL.summary = summary;

  function mult() { return Math.min(4, 1 + Math.floor(G.combo / 10)) * (G.starOn ? 2 : 1); }
  function feedback(txt, color) { G.fb = { txt, color, t: performance.now() }; }
  function resolve(n, kind) {
    n.st = kind; // 1 perfect 2 good 3 miss
    if (kind === 3) {
      G.miss++; G.combo = 0; feedback('MISS', '#f87171');
      if (n.phrase) G.phrases[n.phrase].failed = true;
    } else {
      if (kind === 1) G.perfect++; else G.good++;
      G.combo++; if (G.combo > G.maxCombo) G.maxCombo = G.combo;
      G.score += (kind === 1 ? 100 : 50) * mult();
      feedback(kind === 1 ? 'PERFECT' : 'GOOD', kind === 1 ? '#2dd4bf' : '#fbbf24');
      if (n.phrase) { const p = G.phrases[n.phrase]; p.hit++; if (p.hit === p.n && !p.failed) { G.star = Math.min(1, G.star + 0.25); feedback('STAR +', '#e0f2fe'); } }
    }
  }

  function press(lane, tAud) {
    if (G.state !== 'play') return;
    const off = (G.settings.offset || 0) / 1000;
    const t = (tAud === undefined ? nowSong() : tAud) - off;
    G.pressed[lane] = performance.now();
    if (G.mode === 'record') {
      if (t < 0) return;
      const last = G.rec.length ? G.rec.filter(r => r.lane === lane).pop() : null;
      if (last && t - last.t < 0.06) return;
      G.rec.push({ t: +t.toFixed(4), lane }); G.fx.push({ lane, t: performance.now(), k: 1 });
      return;
    }
    update(t);
    const arr = G.lanes[lane]; let p = G.ptr[lane];
    while (p < arr.length && arr[p].st) p++; G.ptr[lane] = p;
    if (p >= arr.length) { G.fx.push({ lane, t: performance.now(), k: 0 }); return; }
    const n = arr[p], dt = t - n.t;
    if (dt < -GOOD) { G.fx.push({ lane, t: performance.now(), k: 0 }); return; }
    if (dt > GOOD) return;
    resolve(n, Math.abs(dt) <= PERFECT ? 1 : 2);
    G.ptr[lane] = p + 1;
    G.fx.push({ lane, t: performance.now(), k: 1, perfect: n.st === 1 });
  }
  function update(t) {
    const off = 0; // t is already offset-corrected by caller for presses; for frame, caller passes corrected time
    for (let l = 0; l < 5; l++) {
      const arr = G.lanes[l]; let p = G.ptr[l];
      while (p < arr.length) {
        const n = arr[p];
        if (n.st) { p++; continue; }
        if (t - n.t > GOOD) { resolve(n, 3); p++; } else break;
      }
      G.ptr[l] = p;
    }
  }
  function activateStar() {
    if (G.state !== 'play' || G.starOn || G.star < 0.5) return;
    G.starOn = true; feedback('STAR POWER', '#e0f2fe');
  }

  // ---- video sync ----
  function syncVideo(t) {
    if (!video || !G.hasVideo || G.state !== 'play') return;
    const vt = t + (G.settings.voff || 0) / 1000, d = video.duration || 0;
    if (vt < 0) return;
    if (!G.vidStarted) { G.vidStarted = true; try { video.currentTime = d ? vt % d : vt; } catch (e) {} video.play().catch(() => {}); return; }
    const now = performance.now(); if (now - G.lastSync < 400) return; G.lastSync = now;
    const exp = d ? vt % d : vt, cur = video.currentTime;
    let diff = Math.abs(cur - exp); if (d) diff = Math.min(diff, d - diff);
    G.vidDrift = diff;
    if (diff > 0.25) { try { video.currentTime = exp; } catch (e) {} }
    if (video.paused && !video.ended) video.play().catch(() => {});
  }

  // ---- frame loop ----
  function frame() {
    requestAnimationFrame(frame);
    if (!cv || G.state === 'idle') return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (G.state === 'resuming' && G.resumeAt !== Infinity && performance.now() >= G.resumeAt) doResume();
    const nowP = performance.now(), dtF = Math.min(0.1, (nowP - (G.fp || nowP)) / 1000); G.fp = nowP;
    const raw = nowSong(), off = (G.settings.offset || 0) / 1000;
    G.curT = raw;
    if (G.state === 'play') {
      if (G.mode === 'play') update(raw - off);
      if (G.starOn) { G.star -= dtF / 12; if (G.star <= 0) { G.star = 0; G.starOn = false; } }
      syncVideo(raw);
      if (raw >= G.endT) finish();
      else if (G.mode === 'play' && G.notes.length && G.notes.every(n => n.st) && raw > G.notes[G.notes.length - 1].t + 1.2) finish();
    }
    draw(W, H, raw);
  }

  // ---- rendering ----
  function geom(W, H) {
    const hy = H * 0.8, topY = H * 0.07, Wh = W > H * 1.1 ? Math.min(W * 0.6, H * 1.0) : W * 0.94, sc1 = 0.26;
    return { W, H, hy, topY, cx: W / 2, Wh, laneW: Wh / 5, sc1, k: 1 / sc1 - 1 };
  }
  function proj(g, p) {
    if (p >= 0) { const sc = 1 / (1 + g.k * p); return { sc, y: g.hy - (g.hy - g.topY) * (1 - sc) / (1 - g.sc1) }; }
    return { sc: 1 - p * 0.7, y: g.hy - p * (g.hy - g.topY) * 0.55 };
  }
  const lx = (g, lane, sc) => g.cx + (lane - 2) * g.laneW * sc;
  function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

  function draw(W, H, t) {
    const c = g2, g = G.geo = geom(W, H), s = G.settings, look = 2.4 - 0.19 * ((s.speed || 6) - 1);
    c.clearRect(0, 0, W, H);
    const now = performance.now(), starOn = G.starOn;
    // highway
    const scBot = 1 + (H - g.hy) / (g.hy - g.topY) * (1 - g.sc1);
    const hw = (sc, y) => g.Wh * sc / 2;
    c.save();
    c.beginPath(); c.moveTo(g.cx - hw(g.sc1), g.topY); c.lineTo(g.cx + hw(g.sc1), g.topY); c.lineTo(g.cx + hw(scBot), H); c.lineTo(g.cx - hw(scBot), H); c.closePath();
    const op = (s.hwOp == null ? 70 : s.hwOp) / 100;
    const grad = c.createLinearGradient(0, g.topY, 0, H);
    grad.addColorStop(0, `rgba(8,13,19,${op * 0.55})`); grad.addColorStop(1, `rgba(14,22,31,${op})`);
    c.fillStyle = grad; c.fill();
    if (starOn) { c.fillStyle = 'rgba(125,240,255,0.10)'; c.fill(); }
    c.clip();
    // lane pressed glow
    for (let l = 0; l < 5; l++) {
      const age = now - G.pressed[l];
      if (age < 160) { const a = 0.25 * (1 - age / 160); c.fillStyle = hexA(COLORS[l], a); const xl = (ll) => [lx(g, ll - 0.5, g.sc1), lx(g, ll - 0.5, scBot)]; const a1 = xl(l), a2 = xl(l + 1); c.beginPath(); c.moveTo(a1[0], g.topY); c.lineTo(a2[0], g.topY); c.lineTo(a2[1], H); c.lineTo(a1[1], H); c.closePath(); c.fill(); }
    }
    // lane dividers
    c.lineWidth = 1.5;
    for (let i = 0; i <= 5; i++) {
      c.strokeStyle = (i === 0 || i === 5) ? (starOn ? '#7df0ff' : 'rgba(45,212,191,0.85)') : 'rgba(150,170,185,0.28)';
      c.lineWidth = (i === 0 || i === 5) ? 2.5 : 1.2;
      c.beginPath(); c.moveTo(lx(g, i - 0.5, g.sc1), g.topY); c.lineTo(lx(g, i - 0.5, scBot), H); c.stroke();
    }
    // beat lines
    if (s.beatLines !== false && G.bpm > 0) {
      const per = 60 / G.bpm; let k0 = Math.ceil((t - 0.1 * look - G.phase) / per);
      for (let k = k0; ; k++) {
        const tb = G.phase + k * per, p = (tb - t) / look; if (p > 1) break;
        const q = proj(g, p), a = (1 - Math.max(0, p) * 0.7) * (k % 4 === 0 ? 0.5 : 0.2);
        c.strokeStyle = `rgba(200,225,235,${a})`; c.lineWidth = (k % 4 === 0 ? 2 : 1) * q.sc + 0.5;
        c.beginPath(); c.moveTo(lx(g, -0.5, q.sc), q.y); c.lineTo(lx(g, 4.5, q.sc), q.y); c.stroke();
      }
    }
    // notes
    if (G.mode === 'play') {
      const off = (s.offset || 0) / 1000; const tt = t - off;
      for (let i = G.notes.length - 1; i >= 0; i--) {
        const n = G.notes[i]; if (n.st && n.st !== 3) continue;
        const p = (n.t - tt) / look; if (p > 1.02 || p < -0.14) continue;
        const q = proj(g, p), w = g.laneW * q.sc * 0.8, h = Math.max(4, g.laneW * q.sc * 0.34), x = lx(g, n.lane, q.sc);
        const alpha = n.st === 3 ? 0.35 : Math.min(1, (1.02 - p) * 6);
        drawGem(c, x, q.y, w, h, COLORS[n.lane], n.sp, alpha, n.st === 3);
      }
    }
    c.restore();
    // hit line + frets
    c.strokeStyle = 'rgba(228,232,236,0.9)'; c.lineWidth = 3; c.beginPath(); c.moveTo(lx(g, -0.5, 1), g.hy); c.lineTo(lx(g, 4.5, 1), g.hy); c.stroke();
    const keys = s.keys || [];
    for (let l = 0; l < 5; l++) {
      const x = lx(g, l, 1), r = g.laneW * 0.4, age = now - G.pressed[l], down = age < 130 || G.pointerDown(l);
      c.beginPath(); c.ellipse(x, g.hy, r, r * 0.52, 0, 0, Math.PI * 2);
      c.fillStyle = down ? COLORS[l] : 'rgba(15,23,32,0.88)'; c.fill();
      c.lineWidth = 3; c.strokeStyle = COLORS[l]; c.stroke();
      c.fillStyle = down ? '#0b1218' : COLORS[l]; c.font = `800 ${Math.max(12, r * 0.62)}px system-ui, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(FL.keyLabel(keys[l] || ''), x, g.hy + 1);
    }
    // hit effects
    G.fx = G.fx.filter(f => now - f.t < 380);
    for (const f of G.fx) {
      const a = 1 - (now - f.t) / 380, x = lx(g, f.lane, 1);
      c.strokeStyle = hexA(f.k ? COLORS[f.lane] : '#97a3ae', a); c.lineWidth = 3;
      c.beginPath(); c.ellipse(x, g.hy, g.laneW * (0.4 + 0.5 * (1 - a)), g.laneW * (0.2 + 0.25 * (1 - a)), 0, 0, Math.PI * 2); c.stroke();
      if (f.k) { c.fillStyle = hexA('#ffffff', a * 0.5); c.beginPath(); c.ellipse(x, g.hy, g.laneW * 0.3 * a, g.laneW * 0.15 * a, 0, 0, Math.PI * 2); c.fill(); }
    }
    // feedback text
    if (G.fb && now - G.fb.t < 600) {
      const a = 1 - (now - G.fb.t) / 600; c.globalAlpha = a; c.fillStyle = G.fb.color; c.font = `900 ${Math.max(16, g.laneW * 0.34)}px system-ui, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.shadowColor = 'rgba(0,0,0,.7)'; c.shadowBlur = 6; c.fillText(G.fb.txt, g.cx, g.hy - g.laneW * (1.15 + 0.3 * (1 - a))); c.shadowBlur = 0; c.globalAlpha = 1;
    }
    hud(c, g, t);
    // countdown / resume overlays
    if (t < 0 && G.state === 'play') bigText(c, g, String(Math.ceil(-t)), 'Get ready');
    if (G.state === 'resuming') bigText(c, g, String(Math.max(1, Math.min(3, Math.ceil((G.resumeAt - now) / 1000)))), 'Resuming');
  }
  function bigText(c, g, txt, sub) {
    c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(0, 0, g.W, g.H);
    c.fillStyle = '#e4e8ec'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `900 ${g.H * 0.22}px system-ui, sans-serif`; c.fillText(txt, g.cx, g.H * 0.42);
    c.font = `600 ${g.H * 0.05}px system-ui, sans-serif`; c.fillStyle = '#2dd4bf'; c.fillText(sub, g.cx, g.H * 0.58);
  }
  function hexA(h, a) { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`; }
  function drawGem(c, x, y, w, h, col, sp, alpha, missed) {
    c.globalAlpha = alpha;
    if (sp) { c.shadowColor = '#7df0ff'; c.shadowBlur = Math.max(6, w * 0.3); }
    rr(c, x - w / 2, y - h / 2, w, h, h * 0.45);
    c.fillStyle = missed ? '#475569' : (sp ? '#e0f7ff' : col); c.fill();
    c.shadowBlur = 0;
    c.lineWidth = Math.max(1.5, h * 0.12); c.strokeStyle = missed ? '#334155' : (sp ? '#38bdf8' : 'rgba(255,255,255,0.8)'); c.stroke();
    if (!missed) { rr(c, x - w * 0.36, y - h * 0.3, w * 0.72, h * 0.28, h * 0.14); c.fillStyle = 'rgba(255,255,255,0.35)'; c.fill(); }
    if (sp && !missed) { c.fillStyle = '#0ea5e9'; c.font = `900 ${h * 0.8}px system-ui`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('★', x, y + h * 0.05); }
    c.globalAlpha = 1;
  }
  function hud(c, g, t) {
    const small = g.H < 420, fs = small ? 15 : 20, side = Math.max(8, (g.W - g.Wh) / 2 - 8);
    const wide = side > 120;
    c.textBaseline = 'top';
    const panel = (x, y, w, h) => { rr(c, x, y, w, h, 12); c.fillStyle = 'rgba(8,13,19,0.62)'; c.fill(); };
    if (G.mode === 'record') {
      c.textAlign = 'center'; c.fillStyle = '#fb7185'; c.font = `800 ${fs}px system-ui`; c.fillText(`● RECORDING  ${G.rec.length} notes  — tap lanes to the beat`, g.cx, 8);
    } else {
      const lx0 = wide ? 12 : g.cx - g.Wh / 2 + 6, ly0 = 10;
      const pw = wide ? Math.min(side, 220) : 150, ph = small ? 58 : 76;
      if (wide) panel(lx0, ly0, pw, ph + (small ? 0 : 20)); else panel(lx0 - 4, ly0 - 4, pw, ph - 12);
      c.textAlign = 'left'; c.fillStyle = '#97a3ae'; c.font = `700 ${small ? 10 : 12}px system-ui`; c.fillText('SCORE', lx0 + 8, ly0 + 5);
      c.fillStyle = '#e4e8ec'; c.font = `900 ${fs + 8}px system-ui`; c.fillText(String(G.score).replace(/\B(?=(\d{3})+(?!\d))/g, ','), lx0 + 8, ly0 + (small ? 18 : 22));
      if (wide) { const tot = G.perfect + G.good + G.miss; c.fillStyle = '#97a3ae'; c.font = `600 ${small ? 11 : 13}px system-ui`; c.fillText(tot ? `Accuracy ${Math.round((G.perfect + 0.6 * G.good) / tot * 100)}%` : 'Accuracy —', lx0 + 8, ly0 + (small ? 44 : 56)); }
      // right: combo + multiplier + star meter
      const rw = wide ? Math.min(side, 200) : 110, rx = wide ? g.W - rw - 62 : g.cx + g.Wh / 2 - rw - 2, ry = 10;
      if (wide) panel(rx, ry, rw, small ? 74 : 96); 
      c.textAlign = 'right'; c.fillStyle = G.combo >= 10 ? '#2dd4bf' : '#e4e8ec'; c.font = `900 ${fs + 10}px system-ui`; c.fillText(String(G.combo), rx + rw - 10, ry + 4);
      c.fillStyle = '#97a3ae'; c.font = `700 ${small ? 10 : 12}px system-ui`; c.fillText('COMBO', rx + rw - 10, ry + (small ? 26 : 34));
      c.fillStyle = G.starOn ? '#7df0ff' : '#fbbf24'; c.font = `900 ${fs}px system-ui`; c.fillText('x' + mult(), rx + rw - 10, ry + (small ? 38 : 50));
      // star meter
      const bx = rx + 8, by = ry + (small ? 56 : 74), bw = rw - 18, bh = 8;
      c.fillStyle = 'rgba(255,255,255,0.12)'; rr(c, bx, by, bw, bh, 4); c.fill();
      c.fillStyle = G.starOn ? '#7df0ff' : (G.star >= 0.5 ? '#e0f2fe' : '#38bdf8'); rr(c, bx, by, Math.max(0, bw * G.star), bh, 4); c.fill();
      c.fillStyle = 'rgba(255,255,255,0.5)'; c.fillRect(bx + bw * 0.5 - 1, by - 2, 2, bh + 4);
      c.textAlign = 'left'; c.font = `700 ${small ? 9 : 11}px system-ui`; c.fillStyle = G.star >= 0.5 && !G.starOn ? '#e0f2fe' : '#97a3ae';
      c.fillText(G.starOn ? 'STAR POWER' : (G.star >= 0.5 ? 'SPACE / ★ to use' : 'STAR'), bx, by + 11);
    }
    // progress
    const dur = G.buf ? G.buf.duration : 1, pr = Math.max(0, Math.min(1, t / dur));
    c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(0, 0, g.W, 3); c.fillStyle = '#2dd4bf'; c.fillRect(0, 0, g.W * pr, 3);
  }

  // ---- input ----
  FL.keyLabel = code => {
    if (!code) return '';
    if (/^Key[A-Z]$/.test(code)) return code[3];
    if (/^Digit\d$/.test(code)) return code[5];
    const m = { Semicolon: ';', Comma: ',', Period: '.', Slash: '/', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`', Backslash: '\\', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: '␣', ShiftLeft: '⇧', ShiftRight: '⇧', Enter: '⏎' };
    return m[code] || code.replace(/^Numpad/, 'N');
  };
  const held = new Set();
  window.addEventListener('keydown', e => {
    if (G.state === 'idle' || G.state === 'done') return;
    if (document.body.dataset.modal) return;
    const keys = (G.settings && G.settings.keys) || [];
    const lane = keys.indexOf(e.code);
    if (e.code === 'Escape' || (e.code === 'KeyP' && lane < 0)) { e.preventDefault(); if (G.mode === 'record' && G.state === 'play') { finish(); return; } if (G.state === 'play') { e.flPaused = true; pause(); } return; }
    if (lane >= 0) { e.preventDefault(); if (e.repeat || held.has(e.code)) return; held.add(e.code); press(lane, nowSong() - Math.min(0.1, Math.max(0, (performance.now() - e.timeStamp) / 1000))); return; }
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) activateStar(); }
  });
  window.addEventListener('keyup', e => { held.delete(e.code); });
  window.addEventListener('blur', () => { held.clear(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && G.state === 'play' && G.mode === 'play') pause(); });

  G.pointerDown = lane => { for (const l of G.pointers.values()) if (l === lane) return true; return false; };
  function laneAt(x) {
    const g = G.geo; if (!g) return -1;
    const rel = (x - g.cx) / g.laneW + 2.5;
    if (rel < -1.6 || rel > 6.6) return -1;
    return Math.max(0, Math.min(4, Math.floor(rel)));
  }
  FL.initGameInput = function () {
    const el = $('#cv');
    el.addEventListener('pointerdown', e => {
      if (G.state !== 'play') return; e.preventDefault();
      const r = el.getBoundingClientRect(), lane = laneAt(e.clientX - r.left); if (lane < 0) return;
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      G.pointers.set(e.pointerId, lane); press(lane, nowSong() - Math.min(0.1, Math.max(0, (performance.now() - e.timeStamp) / 1000)));
    });
    const up = e => { G.pointers.delete(e.pointerId); };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', e => e.preventDefault());
    $('#spBtn').addEventListener('pointerdown', e => { e.preventDefault(); activateStar(); });
    $('#pauseBtn').addEventListener('click', () => { if (G.mode === 'record' && G.state === 'play') finish(); else pause(); });
  };
})();
