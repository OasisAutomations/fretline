// Fretline: audio analysis + chart generation + demo track synth. Everything runs in the browser.
(function () {
  const FL = window.FL = window.FL || {};
  FL.ANALYSIS_VERSION = 1;
  const LANES = 5;

  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  FL.hashStr = hashStr;
  const tick = () => new Promise(r => setTimeout(r, 0));

  function makeFFT(N) {
    const levels = Math.round(Math.log2(N));
    const cos = new Float32Array(N / 2), sin = new Float32Array(N / 2);
    for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = Math.sin(2 * Math.PI * i / N); }
    const rev = new Uint16Array(N);
    for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b); rev[i] = r; }
    return function (re, im) {
      for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1, step = N / size;
        for (let i = 0; i < N; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tr = re[l] * cos[k] + im[l] * sin[k], ti = -re[l] * sin[k] + im[l] * cos[k];
            re[l] = re[j] - tr; im[l] = im[j] - ti; re[j] += tr; im[j] += ti;
          }
        }
      }
    };
  }

  function pct(arr, p) { const a = Float32Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.floor(a.length * p))] || 1e-6; }

  // Seconds between the flux peak frame and the real attack (measured with synthetic clicks in tests).
  const ONSET_BIAS = -0.008;

  // Returns { bpm, phase, conf, duration, cands:[{t,s,pos}] }
  FL.analyzeBuffer = async function (buf, progress) {
    const chN = buf.numberOfChannels, sr0 = buf.sampleRate;
    const dec = Math.max(1, Math.round(sr0 / 22050));
    const sr = sr0 / dec, len = Math.floor(buf.length / dec);
    const x = new Float32Array(len);
    const chans = []; for (let c = 0; c < chN; c++) chans.push(buf.getChannelData(c));
    for (let i = 0; i < len; i++) { let s = 0; for (let c = 0; c < chN; c++) { const d = chans[c]; for (let k = 0; k < dec; k++) s += d[i * dec + k]; } x[i] = s / (chN * dec); }
    const N = 1024, hop = 256, nF = Math.max(0, Math.floor((len - N) / hop) + 1);
    const duration = buf.duration;
    if (nF < 200) return { bpm: 120, phase: 0, conf: 0, duration, cands: [] };
    const fft = makeFFT(N), win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    const hz = sr / N, nyq = N / 2;
    const b0 = Math.max(1, Math.ceil(40 / hz)), b1 = Math.ceil(200 / hz), b2 = Math.ceil(2000 / hz), b3 = Math.min(nyq, Math.ceil(9000 / hz));
    const re = new Float32Array(N), im = new Float32Array(N), prev = new Float32Array(nyq);
    const fl = new Float32Array(nF), fm = new Float32Array(nF), fh = new Float32Array(nF);
    for (let f = 0; f < nF; f++) {
      const o = f * hop;
      for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
      fft(re, im);
      let sl = 0, sm = 0, sh = 0;
      for (let k = b0; k < b3; k++) {
        const v = Math.log1p(Math.sqrt(re[k] * re[k] + im[k] * im[k]) * 2);
        const d = v - prev[k]; prev[k] = v;
        if (d > 0) { if (k < b1) sl += d; else if (k < b2) sm += d; else sh += d; }
      }
      fl[f] = sl; fm[f] = sm; fh[f] = sh;
      if (f % 1500 === 0) { if (progress) progress(0.7 * f / nF); await tick(); }
    }
    const pl = pct(fl, 0.97), pm = pct(fm, 0.97), ph = pct(fh, 0.97);
    for (let i = 0; i < nF; i++) { fl[i] /= pl; fm[i] /= pm; fh[i] /= ph; }
    const env = new Float32Array(nF);
    for (let i = 0; i < nF; i++) env[i] = 1.0 * fl[i] + 0.9 * fm[i] + 0.7 * fh[i];
    const fr = sr / hop; // frames per second
    // local-mean-removed envelope for tempo
    const pre = new Float64Array(nF + 1); for (let i = 0; i < nF; i++) pre[i + 1] = pre[i] + env[i];
    const mean = (a, b) => { a = Math.max(0, a); b = Math.min(nF, b); return (pre[b] - pre[a]) / Math.max(1, b - a); };
    const w1 = Math.round(fr * 0.5);
    const env2 = new Float32Array(nF);
    for (let i = 0; i < nF; i++) env2[i] = Math.max(0, env[i] - mean(i - w1, i + w1 + 1));
    if (progress) progress(0.75); await tick();
    // autocorrelation
    const maxLag = Math.round(fr * 2) + 10; // up to 2 seconds
    const acf = new Float32Array(maxLag + 1);
    for (let lag = 10; lag <= maxLag; lag++) { let s = 0; for (let i = 0; i + lag < nF; i++) s += env2[i] * env2[i + lag]; acf[lag] = s / (nF - lag); }
    const acfAt = l => { if (l < 10 || l > maxLag - 1) return 0; const i = Math.floor(l), f = l - i; return acf[i] * (1 - f) + acf[i + 1] * f; };
    let best = 120, bestScore = -1;
    for (let bpm = 65; bpm <= 185; bpm += 0.5) {
      const lag = 60 * fr / bpm;
      let sc = acfAt(lag) + 0.5 * acfAt(lag * 2) + 0.25 * acfAt(lag * 0.5);
      sc *= Math.exp(-0.5 * Math.pow(Math.log2(bpm / 118) / 0.75, 2));
      if (sc > bestScore) { bestScore = sc; best = bpm; }
    }
    // refine with a comb filter over (bpm, phase)
    const sm = new Float32Array(nF); for (let i = 1; i < nF - 1; i++) sm[i] = 0.25 * env[i - 1] + 0.5 * env[i] + 0.25 * env[i + 1];
    const envAt = p => { const i = Math.floor(p); if (i < 0 || i >= nF - 1) return 0; const f = p - i; return sm[i] * (1 - f) + sm[i + 1] * f; };
    let rb = best, rp = 0, rs = -1;
    for (let bpm = best * 0.97; bpm <= best * 1.03; bpm += 0.1) {
      const per = 60 * fr / bpm;
      for (let ph0 = 0; ph0 < per; ph0 += 0.5) {
        let s = 0, c = 0; for (let p = ph0; p < nF - 1; p += per) { s += envAt(p); c++; }
        s /= Math.max(1, c);
        if (s > rs) { rs = s; rb = bpm; rp = ph0; }
      }
    }
    const meanEnv = mean(0, nF);
    const conf = rs / Math.max(1e-6, meanEnv);
    const frameT = i => (i * hop + N * 0.5) / sr - ONSET_BIAS;
    const phase = ((frameT(rp) % (60 / rb)) + (60 / rb)) % (60 / rb);
    if (progress) progress(0.85); await tick();
    // peak picking with adaptive threshold
    const w2 = Math.round(fr * 0.4), cands = [];
    const p95 = pct(env, 0.95);
    for (let i = 3; i < nF - 3; i++) {
      const v = env[i];
      if (v < 0.12 * p95) continue;
      let isMax = true; for (let k = -3; k <= 3; k++) if (env[i + k] > v) { isMax = false; break; }
      if (!isMax || (env[i - 1] === v && env[i + 1] === v)) continue;
      const thr = 1.25 * mean(i - w2, i + w2 + 1) + 0.04 * p95;
      if (v < thr) continue;
      const s = Math.min(1, (v - thr * 0.6) / (p95 * 1.1));
      const l = Math.max(fl[i - 1], fl[i], fl[i + 1]), m = Math.max(fm[i - 1], fm[i], fm[i + 1]), h = Math.max(fh[i - 1], fh[i], fh[i + 1]);
      const pos = (0.4 * l + 2.0 * m + 3.7 * h) / (l + m + h + 1e-6);
      cands.push({ t: frameT(i), s: Math.max(0.02, s), pos });
    }
    if (progress) progress(1);
    return { bpm: rb, phase, conf, duration, cands };
  };

  const DIFFS = {
    easy:   { sub: 2, minGap: 0.42, nps: 1.5, minS: 0.40, chord: 0,    lanes: [1, 3] },
    medium: { sub: 2, minGap: 0.26, nps: 2.6, minS: 0.26, chord: 0.04, lanes: [0, 4] },
    hard:   { sub: 4, minGap: 0.16, nps: 4.0, minS: 0.16, chord: 0.12, lanes: [0, 4] },
    expert: { sub: 4, minGap: 0.105, nps: 5.8, minS: 0.08, chord: 0.2, lanes: [0, 4] }
  };
  FL.DIFFS = DIFFS;

  // an = analysis result, returns [{t, lane, sp}]
  FL.buildChart = function (an, diffName, seedKey) {
    const D = DIFFS[diffName] || DIFFS.medium;
    const rnd = mulberry32(hashStr((seedKey || 'x') + diffName));
    const per = 60 / an.bpm, slot = per / D.sub, snap = an.conf >= 1.3 || an.exact;
    const dur = an.duration;
    const cs = an.cands.filter(c => c.s >= D.minS && c.t > 0.25 && c.t < dur - 0.2).map(c => {
      let t = c.t, onBeat = 0;
      if (snap) {
        const k = Math.round((t - an.phase) / slot), ts = an.phase + k * slot;
        if (Math.abs(t - ts) <= 0.42 * slot || an.exact) t = ts;
        onBeat = (k % D.sub === 0) ? 1 : 0;
      }
      return { t, s: c.s * (1 + 0.25 * onBeat), pos: c.pos, raw: c };
    }).sort((a, b) => b.s - a.s);
    const RES = 0.005, occ = new Uint8Array(Math.ceil(dur / RES) + 10);
    const winBins = new Float32Array(Math.ceil(dur) + 6); // notes per second bins
    const cap = D.nps * 4, picked = [];
    for (const c of cs) {
      const i = Math.round(c.t / RES), g = Math.round(D.minGap / RES);
      let clash = false; for (let k = Math.max(0, i - g + 1); k < Math.min(occ.length, i + g); k++) if (occ[k]) { clash = true; break; }
      if (clash) continue;
      const sec = Math.floor(c.t); let cnt = 0; for (let k = sec - 2; k <= sec + 1; k++) cnt += winBins[Math.max(0, k)];
      if (cnt >= cap) continue;
      occ[i] = 1; winBins[sec]++; picked.push(c);
    }
    picked.sort((a, b) => a.t - b.t);
    const [minL, maxL] = D.lanes, span = maxL - minL;
    const notes = []; let prevLane = -1, rep = 0;
    for (let n = 0; n < picked.length; n++) {
      const c = picked[n], gap = n ? c.t - picked[n - 1].t : 9;
      let lane = minL + Math.round(Math.max(0, Math.min(4, c.pos + (rnd() - 0.5) * 1.5)) / 4 * span);
      if (lane === prevLane) { rep++; if (rep >= 2) { lane += (rnd() < 0.5 ? -1 : 1); rep = 0; } } else rep = 0;
      lane = Math.max(minL, Math.min(maxL, lane));
      if (prevLane >= 0 && gap < 0.22 && Math.abs(lane - prevLane) > 2) lane = prevLane + Math.sign(lane - prevLane) * 2;
      const note = { t: +c.t.toFixed(4), lane, sp: false };
      notes.push(note);
      if (D.chord && c.s > 0.8 && gap > 0.2 && rnd() < D.chord * 3) {
        let l2 = lane + (rnd() < 0.5 ? 1 : 2) * (lane < (minL + maxL) / 2 ? 1 : -1);
        l2 = Math.max(minL, Math.min(maxL, l2));
        if (l2 !== lane) notes.push({ t: note.t, lane: l2, sp: false });
      }
      prevLane = lane;
    }
    FL.markStar(notes);
    return notes;
  };

  // mark a few "star phrases": 4 consecutive note times, spaced through the song
  FL.markStar = function (notes) {
    notes.forEach(n => { n.sp = false; });
    const times = [...new Set(notes.map(n => n.t))];
    if (times.length < 24) return notes;
    const every = Math.max(20, Math.round(times.length / 6));
    for (let s = Math.round(every / 2); s + 4 < times.length; s += every) {
      if (times[s + 3] - times[s] > 3.5) continue;
      const set = new Set(times.slice(s, s + 4));
      notes.forEach(n => { if (set.has(n.t)) n.sp = true; });
    }
    return notes;
  };

  // ---- Built-in demo: original synthesized track, plus an exact chart for it ----
  FL.makeDemo = async function () {
    const bpm = 124, per = 60 / bpm, bars = 20, dur = bars * 4 * per + 1.5, sr = 44100;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const oc = new OAC(1, Math.ceil(dur * sr), sr);
    const master = oc.createGain(); master.gain.value = 0.8; master.connect(oc.destination);
    const noiseBuf = oc.createBuffer(1, sr, sr), nd = noiseBuf.getChannelData(0); const r = mulberry32(7); for (let i = 0; i < nd.length; i++) nd[i] = r() * 2 - 1;
    const ev = [];
    const env = (g, t, a, d, pk) => { g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(pk, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); };
    const kick = t => { const o = oc.createOscillator(), g = oc.createGain(); o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12); env(g, t, 0.002, 0.3, 1); o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.4); };
    const snare = t => { const s = oc.createBufferSource(); s.buffer = noiseBuf; const f = oc.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1900; const g = oc.createGain(); env(g, t, 0.002, 0.16, 0.7); s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + 0.3); const o = oc.createOscillator(), g2 = oc.createGain(); o.frequency.value = 190; env(g2, t, 0.002, 0.1, 0.4); o.connect(g2); g2.connect(master); o.start(t); o.stop(t + 0.2); };
    const hat = (t, v) => { const s = oc.createBufferSource(); s.buffer = noiseBuf; const f = oc.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000; const g = oc.createGain(); env(g, t, 0.001, 0.05, v); s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + 0.1); };
    const bass = (t, fq, d) => { const o = oc.createOscillator(); o.type = 'sawtooth'; o.frequency.value = fq; const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420; const g = oc.createGain(); env(g, t, 0.005, d, 0.55); o.connect(f); f.connect(g); g.connect(master); o.start(t); o.stop(t + d + 0.1); };
    const lead = (t, fq, d) => { const o = oc.createOscillator(); o.type = 'square'; o.frequency.value = fq; const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 3200; const g = oc.createGain(); env(g, t, 0.004, d, 0.22); o.connect(f); f.connect(g); g.connect(master); o.start(t); o.stop(t + d + 0.1); };
    const root = [55, 55, 65.41, 49]; // A1 A1 C2 G1
    const scale = [220, 261.63, 293.66, 329.63, 392, 440, 523.25, 587.33]; // A minor pentatonic-ish
    const t0 = 0.25;
    for (let bar = 0; bar < bars; bar++) {
      const chord = Math.floor(bar / 2) % 4;
      const intro = bar < 2, drop = bar >= 4 && bar < 16, outro = bar >= 16;
      for (let st = 0; st < 16; st++) {
        const t = t0 + (bar * 16 + st) * per / 4, beat = st % 4 === 0, step8 = st % 2 === 0;
        if (beat && !(outro && bar >= 18 && st >= 8)) { kick(t); ev.push({ t, s: 1.0, pos: 0.3 }); }
        if (!intro && (st === 4 || st === 12)) { snare(t); ev.push({ t, s: 0.95, pos: 2.0 }); }
        if (step8 || bar >= 8) { hat(t, step8 ? 0.35 : 0.2); if (!beat && (st % 4 === 2 || drop)) ev.push({ t, s: st % 4 === 2 ? 0.45 : 0.3, pos: 3.8 }); }
        if (!intro && step8 && !beat) { bass(t, root[chord] * (st % 8 === 6 ? 2 : 1), per * 0.4); ev.push({ t, s: 0.6, pos: 0.9 }); }
        if (drop && (st % 4 === 3 || st === 10 || st === 6)) { const idx = (bar * 3 + st) % scale.length; lead(t, scale[idx], per * 0.3); ev.push({ t, s: 0.7, pos: 1.3 + idx / (scale.length - 1) * 2.4 }); }
      }
    }
    const src = oc.createBufferSource(); // silent anchor to make sure length is correct
    const rendered = await oc.startRendering();
    return { buffer: rendered, an: { bpm, phase: t0, conf: 9, exact: true, duration: rendered.duration, cands: ev } };
  };

  FL.packAnalysis = an => ({ v: FL.ANALYSIS_VERSION, bpm: an.bpm, phase: an.phase, conf: an.conf, duration: an.duration, cands: an.cands.map(c => [+c.t.toFixed(4), +c.s.toFixed(3), +c.pos.toFixed(3)]) });
  FL.unpackAnalysis = p => ({ bpm: p.bpm, phase: p.phase, conf: p.conf, duration: p.duration, cands: p.cands.map(a => ({ t: a[0], s: a[1], pos: a[2] })) });
})();
