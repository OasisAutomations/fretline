// Fretline UI: song/background loading, settings, saved charts (IndexedDB), recorder, results.
(function () {
  const FL = window.FL, G = FL.G;
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const DEF = { diff: 'medium', speed: 6, offset: 0, voff: 0, dim: 45, hwOp: 70, beatLines: true, keys: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG'] };
  let settings = Object.assign({}, DEF, JSON.parse(localStorage.getItem('fretline.settings') || '{}'));
  if (!Array.isArray(settings.keys) || settings.keys.length !== 5) settings.keys = DEF.keys.slice();
  const saveSettings = () => { localStorage.setItem('fretline.settings', JSON.stringify(settings)); FL.Game.liveSettings(settings); };
  const S = FL.S = { song: null, bg: { type: 'none', url: null, file: null, name: '' }, prevSong: null, chartSrc: 'auto' };

  // ---------- IndexedDB ----------
  const DB = {
    db: null,
    open() { return this.db ? Promise.resolve(this.db) : new Promise((res, rej) => { const r = indexedDB.open('fretline', 1); r.onupgradeneeded = () => r.result.createObjectStore('songs', { keyPath: 'key' }); r.onsuccess = () => { this.db = r.result; res(r.result); }; r.onerror = () => rej(r.error); }); },
    async tx(mode, fn) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('songs', mode), st = t.objectStore('songs'); const rq = fn(st); t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error); }); },
    get(k) { return this.tx('readonly', s => s.get(k)).catch(() => null); },
    put(v) { return this.tx('readwrite', s => s.put(v)).catch(() => null); },
    del(k) { return this.tx('readwrite', s => s.delete(k)).catch(() => null); },
    all() { return this.tx('readonly', s => s.getAll()).then(r => r || []).catch(() => []); }
  };
  FL.DB = DB;

  function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, ms); }
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // ---------- settings UI ----------
  function applyBg() {
    $('#bgDim').style.opacity = settings.dim / 100;
    $('#dimRange').value = settings.dim; $('#dimVal').textContent = settings.dim + '%';
  }
  function syncSettingsUI() {
    $('#sDiff').value = settings.diff; $('#sSpeed').value = settings.speed; $('#sSpeedV').textContent = settings.speed;
    $('#sOff').value = settings.offset; $('#sOffV').textContent = settings.offset + ' ms';
    $('#sVoff').value = settings.voff; $('#sVoffV').textContent = settings.voff + ' ms';
    $('#sDim').value = settings.dim; $('#sDimV').textContent = settings.dim + '%';
    $('#sHw').value = settings.hwOp; $('#sHwV').textContent = settings.hwOp + '%';
    $('#sBeat').checked = settings.beatLines !== false;
    $$('#diffSeg button').forEach(b => b.classList.toggle('on', b.dataset.diff === settings.diff));
    const kb = $('#keyBtns'); kb.innerHTML = '';
    settings.keys.forEach((k, i) => { const b = document.createElement('button'); b.textContent = FL.keyLabel(k); b.style.borderColor = FL.LANE_COLORS[i]; b.style.color = FL.LANE_COLORS[i]; b.dataset.i = i; kb.appendChild(b); });
    $('#keyHint').textContent = settings.keys.map(FL.keyLabel).join(' ');
    applyBg();
  }
  function bindRange(id, key, fmtv) { $(id).addEventListener('input', e => { settings[key] = +e.target.value; saveSettings(); syncSettingsUI(); }); }
  bindRange('#sSpeed', 'speed'); bindRange('#sOff', 'offset'); bindRange('#sVoff', 'voff'); bindRange('#sDim', 'dim'); bindRange('#sHw', 'hwOp');
  $('#dimRange').addEventListener('input', e => { settings.dim = +e.target.value; saveSettings(); syncSettingsUI(); });
  $('#sBeat').addEventListener('change', e => { settings.beatLines = e.target.checked; saveSettings(); });
  $('#sDiff').addEventListener('change', e => { setDiff(e.target.value); });
  $$('#diffSeg button').forEach(b => b.addEventListener('click', () => setDiff(b.dataset.diff)));
  function setDiff(d) { settings.diff = d; saveSettings(); syncSettingsUI(); refreshChartInfo(); }
  let waitKey = -1;
  $('#keyBtns').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; waitKey = +b.dataset.i; $$('#keyBtns button').forEach(x => x.classList.remove('wait')); b.classList.add('wait'); b.textContent = '…'; });
  window.addEventListener('keydown', e => {
    if (waitKey < 0) return;
    e.preventDefault(); e.stopPropagation();
    if (e.code === 'Escape' || e.code === 'Space') { waitKey = -1; syncSettingsUI(); toast('Esc and Space are reserved'); return; }
    const dup = settings.keys.indexOf(e.code); if (dup >= 0 && dup !== waitKey) settings.keys[dup] = settings.keys[waitKey];
    settings.keys[waitKey] = e.code; waitKey = -1; saveSettings(); syncSettingsUI();
  }, true);
  $('#keysReset').addEventListener('click', () => { settings.keys = DEF.keys.slice(); saveSettings(); syncSettingsUI(); });
  $('#allReset').addEventListener('click', () => { settings = Object.assign({}, DEF, { keys: DEF.keys.slice() }); saveSettings(); syncSettingsUI(); refreshChartInfo(); });

  // ---------- modals ----------
  function openModal(id) { $(id).hidden = false; document.body.dataset.modal = id; }
  function closeModal(id) { $(id).hidden = true; delete document.body.dataset.modal; }
  $('#openSettings').addEventListener('click', () => { syncSettingsUI(); openModal('#settings'); });
  $('#pSettings').addEventListener('click', () => { syncSettingsUI(); openModal('#settings'); });
  $('#settingsClose').addEventListener('click', () => closeModal('#settings'));
  $('#openSaved').addEventListener('click', async () => { await renderSaved(); openModal('#saved'); });
  $('#savedClose').addEventListener('click', () => closeModal('#saved'));
  $('#fsBtn').addEventListener('click', toggleFs);
  function toggleFs() { const d = document, el = d.documentElement; if (d.fullscreenElement) d.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen().catch(() => {}); else toast('Fullscreen is not available here. On iPhone, use Share > Add to Home Screen.'); }

  async function renderSaved() {
    const list = (await DB.all()).sort((a, b) => b.updated - a.updated), box = $('#savedList'); box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<p class="muted">Nothing saved yet. Load a song and its chart is saved automatically.</p>'; return; }
    list.forEach(r => {
      const d = document.createElement('div'); d.className = 'saved-item';
      d.innerHTML = `<div><b></b><span class="muted small"></span></div><button class="btn ghost">Delete</button>`;
      d.querySelector('b').textContent = r.name; d.querySelector('span').textContent = `${fmt(r.duration || 0)} · ${Math.round(r.analysis ? r.analysis.bpm : 0)} BPM${r.rec ? ' · recorded chart (' + r.rec.notes.length + ' notes)' : ''}`;
      d.querySelector('button').addEventListener('click', async () => { await DB.del(r.key); if (S.song && S.song.key === r.key) { S.song.rec = null; S.chartSrc = 'auto'; refreshChartInfo(); } renderSaved(); });
      box.appendChild(d);
    });
  }

  // ---------- song loading ----------
  const isAudioName = n => /\.(mp3|wav|m4a|ogg|oga|opus|aac|flac|weba)$/i.test(n);
  const isVideoName = n => /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(n);
  const isImageName = n => /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(n);
  const kind = f => (f.type.startsWith('audio/') || isAudioName(f.name)) ? 'audio' : (f.type.startsWith('video/') || isVideoName(f.name)) ? 'video' : (f.type.startsWith('image/') || isImageName(f.name)) ? 'image' : 'unknown';
  const songKey = f => `${f.name}|${f.size}|${f.lastModified}`;
  const cleanName = n => n.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
  const setProg = p => { const w = $('#songProg'); w.hidden = p == null; if (p != null) $('#songProgBar').style.width = Math.round(p * 100) + '%'; };
  let loadToken = 0;

  async function loadSongFile(file, fromVideo) {
    const token = ++loadToken;
    $('#songName').textContent = cleanName(file.name); $('#songMeta').textContent = 'Decoding audio…'; setProg(0.02);
    lockPlay(true);
    let buf;
    try {
      const ab = await file.arrayBuffer(); const ctx = FL.ensureCtx();
      buf = await ctx.decodeAudioData(ab);
    } catch (e) {
      if (token !== loadToken) return false;
      setProg(null); $('#songMeta').textContent = fromVideo ? "This browser couldn't read audio from that video." : "Couldn't decode that file. Try mp3, wav, m4a or ogg.";
      toast($('#songMeta').textContent); if (S.song) showSong(); lockPlay(false); return false;
    }
    if (token !== loadToken) return false;
    const key = songKey(file); let rec = await DB.get(key), an, cached = false;
    if (rec && rec.analysis && rec.analysis.v === FL.ANALYSIS_VERSION) { an = FL.unpackAnalysis(rec.analysis); cached = true; }
    else {
      $('#songMeta').textContent = 'Analyzing beats…';
      an = await FL.analyzeBuffer(buf, p => { if (token === loadToken) setProg(0.05 + 0.9 * p); });
      if (token !== loadToken) return false;
      rec = { key, name: cleanName(file.name), duration: buf.duration, analysis: FL.packAnalysis(an), rec: (rec && rec.rec) || null, updated: Date.now() };
      await DB.put(rec);
    }
    setProg(null);
    S.song = { key, name: cleanName(file.name), buf, an, rec: rec.rec || null, isDemo: false, cached, file, fromVideo: !!fromVideo };
    if (!S.song.rec && S.chartSrc === 'rec') S.chartSrc = 'auto';
    showSong(); lockPlay(false);
    return true;
  }
  function lockPlay(b) { $('#playBtn').disabled = b || !S.song; $('#recBtn').disabled = b || !S.song; }
  function showSong() {
    const s = S.song; if (!s) return;
    $('#songName').textContent = s.name;
    const bpm = s.an.exact || s.an.conf >= 1.3 ? `${Math.round(s.an.bpm)} BPM` : `~${Math.round(s.an.bpm)} BPM (steady beat not clear)`;
    $('#songMeta').textContent = `${fmt(s.buf.duration)} · ${bpm}${s.cached ? ' · loaded saved chart' : ''}${s.fromVideo ? ' · audio from video' : ''}`;
    refreshChartInfo(); lockPlay(false);
  }
  function refreshChartInfo() {
    const s = S.song; if (!s) return;
    const counts = ['easy', 'medium', 'hard', 'expert'].map(d => FL.buildChart(s.an, d, s.key).length);
    const cur = counts[['easy', 'medium', 'hard', 'expert'].indexOf(settings.diff)];
    const sel = $('#chartSrc'); sel.innerHTML = '<option value="auto">Auto-generated</option>' + (s.rec ? `<option value="rec">My recorded chart (${s.rec.notes.length} notes)</option>` : '');
    if (S.chartSrc === 'rec' && !s.rec) S.chartSrc = 'auto'; sel.value = S.chartSrc;
    $('#chartInfo').textContent = S.chartSrc === 'rec' && s.rec ? `Recorded chart: ${s.rec.notes.length} notes` : `${cur} notes on ${settings.diff[0].toUpperCase() + settings.diff.slice(1)} (Easy ${counts[0]} · Med ${counts[1]} · Hard ${counts[2]} · Expert ${counts[3]})`;
    const best = JSON.parse(localStorage.getItem('fretline.best') || '{}')[s.key + '|' + (S.chartSrc === 'rec' ? 'rec' : settings.diff)];
    $('#bestScore').textContent = best ? `Best: ${best.toLocaleString()}` : '';
  }
  $('#chartSrc').addEventListener('change', e => { S.chartSrc = e.target.value; refreshChartInfo(); });
  $('#songInput').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await handleFile(f, true); });
  $('#demoBtn').addEventListener('click', async () => {
    FL.ensureCtx(); const token = ++loadToken; lockPlay(true); $('#songName').textContent = 'Fretline Demo (synthesized)'; $('#songMeta').textContent = 'Generating demo track…'; setProg(0.3);
    try {
      const d = await FL.makeDemo(); if (token !== loadToken) return;
      const rec = await DB.get('demo');
      S.song = { key: 'demo', name: 'Fretline Demo (synthesized)', buf: d.buffer, an: d.an, rec: rec ? rec.rec : null, isDemo: true };
      if (!rec) DB.put({ key: 'demo', name: 'Fretline Demo (synthesized)', duration: d.buffer.duration, analysis: FL.packAnalysis(Object.assign({}, d.an)), rec: null, updated: Date.now() });
      S.song.an.exact = true; setProg(null); showSong();
    } catch (e) { setProg(null); $('#songMeta').textContent = 'Could not generate the demo in this browser.'; lockPlay(false); }
  });

  // ---------- background ----------
  const bgVideo = $('#bgVideo');
  function clearBg() {
    if (S.bg.url) URL.revokeObjectURL(S.bg.url);
    S.bg = { type: 'none', url: null, file: null, name: '' };
    bgVideo.pause(); bgVideo.removeAttribute('src'); bgVideo.load(); $('#bgImg').style.backgroundImage = '';
    document.body.classList.remove('has-video', 'has-image');
    $('#bgThumb').hidden = true; $('#bgThumbEmpty').hidden = false; $('#bgName').textContent = '';
    const va = $('#vidAudio'); va.checked = false; va.disabled = true; restoreSong();
  }
  async function setBg(file) {
    const k = kind(file); if (k !== 'video' && k !== 'image') { toast('Pick a video (mp4, webm, mov) or an image.'); return; }
    if (S.bg.url) URL.revokeObjectURL(S.bg.url);
    const url = URL.createObjectURL(file);
    S.bg = { type: k, url, file, name: file.name };
    document.body.classList.toggle('has-video', k === 'video'); document.body.classList.toggle('has-image', k === 'image');
    $('#bgName').textContent = file.name; const va = $('#vidAudio');
    if (k === 'image') { $('#bgImg').style.backgroundImage = `url("${url}")`; bgVideo.removeAttribute('src'); bgVideo.load(); setThumb(url); va.checked = false; va.disabled = true; restoreSong(); return; }
    $('#bgImg').style.backgroundImage = ''; va.disabled = false; if (va.checked) { va.checked = false; restoreSong(); }
    bgVideo.onerror = () => { toast("This browser can't play that video. Try an H.264 mp4 or a webm."); };
    bgVideo.onloadeddata = () => { try { bgVideo.currentTime = Math.min(1, (bgVideo.duration || 2) / 3); } catch (e) {} };
    bgVideo.onseeked = () => { bgVideo.onseeked = null; thumbFromVideo(); };
    bgVideo.src = url; bgVideo.load();
  }
  function setThumb(src) { const i = $('#bgThumb'); i.src = src; i.hidden = false; $('#bgThumbEmpty').hidden = true; }
  function thumbFromVideo() { try { const c = document.createElement('canvas'); c.width = 224; c.height = 128; c.getContext('2d').drawImage(bgVideo, 0, 0, 224, 128); setThumb(c.toDataURL('image/jpeg', .7)); } catch (e) {} }
  $('#bgInput').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await setBg(f); });
  $('#bgNone').addEventListener('click', clearBg);
  $('#vidAudio').addEventListener('change', async e => {
    if (e.target.checked && S.bg.type === 'video') {
      if (S.song && !S.song.fromVideo) S.prevSong = S.song;
      const ok = await loadSongFile(S.bg.file, true); if (!ok) { e.target.checked = false; restoreSong(); }
    } else restoreSong();
  });
  function restoreSong() { if (S.song && S.song.fromVideo) { S.song = S.prevSong || null; S.prevSong = null; if (S.song) showSong(); else { $('#songName').textContent = 'No song loaded'; $('#songMeta').textContent = ''; lockPlay(false); $('#chartInfo').textContent = 'Load a song to build a chart.'; } } }

  async function handleFile(f, preferSong) {
    const k = kind(f);
    if (k === 'audio') { const va = $('#vidAudio'); if (va.checked) { va.checked = false; } S.prevSong = null; await loadSongFile(f); }
    else if (k === 'video' || k === 'image') { if (preferSong && k === 'video') { await setBg(f); toast('Video set as the background. Tick "Use the video\'s own audio" to use its sound as the song.'); } else await setBg(f); }
    else toast('That file type is not supported.');
  }
  // drag and drop anywhere on the menu
  const dz = $('#dropZone');
  ['dragenter', 'dragover'].forEach(ev => window.addEventListener(ev, e => { e.preventDefault(); if (document.body.dataset.screen === 'menu') dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => window.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) dz.classList.remove('over'); }));
  window.addEventListener('drop', async e => { if (document.body.dataset.screen !== 'menu') return; for (const f of [...e.dataTransfer.files]) await handleFile(f, false); });

  // ---------- play ----------
  function currentNotes() {
    const s = S.song;
    if (S.chartSrc === 'rec' && s.rec) return s.rec.notes.map(n => ({ t: n.t, lane: n.lane, sp: !!n.sp }));
    return FL.buildChart(s.an, settings.diff, s.key);
  }
  function startGame(mode) {
    if (!S.song) return;
    FL.ensureCtx();
    closeModal('#results'); $('#results').hidden = true; $('#pauseMenu').hidden = true;
    document.body.dataset.screen = 'game'; $('#game').hidden = false;
    $('#spBtn').hidden = mode === 'record';
    if (matchMedia('(pointer: coarse)').matches && document.documentElement.requestFullscreen && !document.fullscreenElement) { document.documentElement.requestFullscreen().then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {})).catch(() => {}); }
    const s = S.song, src = S.chartSrc;
    S.lastMode = mode;
    FL.Game.start({
      buf: s.buf, notes: mode === 'record' ? [] : currentNotes(), bpm: s.an.bpm, phase: s.an.phase, mode, settings, title: s.name,
      hasVideo: S.bg.type === 'video',
      onEnd: sum => showResults(sum, src), onRecEnd: rec => showRecSave(rec)
    });
  }
  $('#playBtn').addEventListener('click', () => startGame('play'));
  $('#recBtn').addEventListener('click', () => startGame('record'));
  document.addEventListener('fl-paused', () => { if (G.mode === 'play') $('#pauseMenu').hidden = false; });
  $('#resumeBtn').addEventListener('click', () => { $('#pauseMenu').hidden = true; FL.Game.resume(); });
  $('#restartBtn').addEventListener('click', () => { $('#pauseMenu').hidden = true; FL.ctx.resume().then(() => FL.Game.restart()); });
  $('#quitBtn').addEventListener('click', () => { $('#pauseMenu').hidden = true; toMenu(); });
  $('#menuBtn').addEventListener('click', toMenu);
  $('#againBtn').addEventListener('click', () => startGame(S.lastMode || 'play'));
  function toMenu() { FL.Game.quit(); if (FL.ctx && FL.ctx.state === 'suspended') FL.ctx.resume().catch(() => {}); $('#results').hidden = true; $('#recSave').hidden = true; $('#game').hidden = true; document.body.dataset.screen = 'menu'; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); refreshChartInfo(); }
  window.addEventListener('keydown', e => { if (e.code === 'Escape' && !e.flPaused && !$('#pauseMenu').hidden && !document.body.dataset.modal && waitKey < 0) { $('#pauseMenu').hidden = true; FL.Game.resume(); } });

  function showResults(sum, src) {
    const best = JSON.parse(localStorage.getItem('fretline.best') || '{}'), k = S.song.key + '|' + (src === 'rec' ? 'rec' : settings.diff);
    const prev = best[k] || 0; if (sum.score > prev) { best[k] = sum.score; localStorage.setItem('fretline.best', JSON.stringify(best)); }
    $('#resGrade').textContent = sum.accuracy >= 0.97 ? 'S' : sum.accuracy >= 0.9 ? 'A' : sum.accuracy >= 0.8 ? 'B' : sum.accuracy >= 0.65 ? 'C' : sum.accuracy >= 0.5 ? 'D' : 'E';
    $('#resStars').textContent = '★'.repeat(sum.stars) + '☆'.repeat(5 - sum.stars);
    $('#resTitle').textContent = S.song.name + (sum.score > prev && prev ? ' - new best!' : '');
    $('#resScore').textContent = sum.score.toLocaleString();
    $('#resPerfect').textContent = sum.perfect; $('#resGood').textContent = sum.good; $('#resMiss').textContent = sum.miss;
    $('#resCombo').textContent = sum.maxCombo; $('#resAcc').textContent = Math.round(sum.accuracy * 100) + '%'; $('#resBest').textContent = Math.max(prev, sum.score).toLocaleString();
    $('#results').hidden = false;
  }

  // ---------- recorder ----------
  let lastRec = null;
  function showRecSave(rec) { lastRec = rec; $('#recMsg').textContent = rec.length ? `Recorded ${rec.length} notes.` : 'No notes were recorded.'; $('#recSaveBtn').disabled = !rec.length; $('#recSnap').checked = true; $('#recSave').hidden = false; }
  $('#recSaveBtn').addEventListener('click', async () => {
    const s = S.song, an = s.an; let notes = lastRec.map(n => ({ t: n.t, lane: n.lane }));
    if ($('#recSnap').checked && an.bpm) { const slot = 60 / an.bpm / 4; notes = notes.map(n => ({ t: +(an.phase + Math.round((n.t - an.phase) / slot) * slot).toFixed(4), lane: n.lane })).filter(n => n.t > 0.1); }
    const seen = new Set(); notes = notes.filter(n => { const k = n.t + '|' + n.lane; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.t - b.t || a.lane - b.lane);
    FL.markStar(notes);
    s.rec = { notes, created: Date.now() }; S.chartSrc = 'rec';
    const rec = (await DB.get(s.key)) || { key: s.key, name: s.name, duration: s.buf.duration, analysis: FL.packAnalysis(s.an) };
    rec.rec = s.rec; rec.updated = Date.now(); await DB.put(rec);
    $('#recSave').hidden = true; toMenu(); toast(`Saved ${notes.length} notes. Choose "My recorded chart" and press Play.`);
  });
  $('#recAgain').addEventListener('click', () => { $('#recSave').hidden = true; startGame('record'); });
  $('#recDiscard').addEventListener('click', () => { $('#recSave').hidden = true; toMenu(); });

  // ---------- calibration ----------
  const cal = { clicks: [], deltas: [], running: false, timer: 0 };
  function calibTap(e) {
    if (!cal.running || !FL.ctx) return;
    const lat = (FL.ctx.outputLatency || 0) || (FL.ctx.baseLatency || 0) || 0;
    const t = FL.ctx.currentTime - lat; let best = null;
    for (const c of cal.clicks) if (best === null || Math.abs(t - c) < Math.abs(t - best)) best = c;
    if (best === null || Math.abs(t - best) > 0.35) return;
    cal.deltas.push((t - best) * 1000); cal.clicks = cal.clicks.filter(c => c !== best);
    $('#calibMsg').textContent = `${cal.deltas.length} taps. Keep going…`;
  }
  $('#calibBtn').addEventListener('click', () => { closeModal('#settings'); openModal('#calib'); $('#calibMsg').textContent = 'Tap any key, or the big button, exactly when you hear each click. 12 clicks.'; $('#calibApply').disabled = true; });
  $('#calibStart').addEventListener('click', () => {
    const ctx = FL.ensureCtx(); cal.clicks = []; cal.deltas = []; cal.running = true; $('#calibApply').disabled = true; $('#calibMsg').textContent = 'Listen…';
    const t0 = ctx.currentTime + 1.2;
    for (let i = 0; i < 12; i++) {
      const t = t0 + i * 0.6, o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = 1100; g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.6, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      o.connect(g); g.connect(FL.master); o.start(t); o.stop(t + 0.1); cal.clicks.push(t);
    }
    clearTimeout(cal.timer);
    cal.timer = setTimeout(() => {
      cal.running = false; const d = cal.deltas.slice(2).sort((a, b) => a - b);
      if (d.length < 4) { $('#calibMsg').textContent = 'Not enough taps. Press Start and try again.'; return; }
      cal.result = Math.round(d[Math.floor(d.length / 2)] / 5) * 5; cal.result = Math.max(-250, Math.min(250, cal.result));
      $('#calibMsg').textContent = `Result: ${cal.result} ms (${d.length} taps). Press Apply to use it.`; $('#calibApply').disabled = false;
    }, 1200 + 12 * 600 + 500);
  });
  $('#calibTap').addEventListener('pointerdown', e => { e.preventDefault(); calibTap(e); });
  window.addEventListener('keydown', e => { if (document.body.dataset.modal === '#calib' && !e.repeat && !['Escape'].includes(e.code)) { e.preventDefault(); calibTap(e); } });
  $('#calibApply').addEventListener('click', () => { settings.offset = cal.result; saveSettings(); syncSettingsUI(); closeModal('#calib'); openModal('#settings'); });
  $('#calibClose').addEventListener('click', () => { cal.running = false; clearTimeout(cal.timer); closeModal('#calib'); openModal('#settings'); });

  // ---------- init ----------
  FL.initGameInput();
  syncSettingsUI(); FL.Game.liveSettings(settings); G.settings = settings;
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  FL.app = { settings: () => settings, startGame, S, DB, loadSongFile, setBg };
  FL.ready = true;
})();
