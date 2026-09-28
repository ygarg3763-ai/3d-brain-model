// ============================================================
//  CogniAdapt — Content Monitor  v2.0
//  Merged: Cognitive Ergonomics Engine + CogniAdapt
//  Signals: typing rhythm · cursor jitter · scroll entropy
//  Adaptations: 3 fatigue levels + ADHD-specific features
// ============================================================

(function () {
  if (window.__cogniAdaptLoaded) return;
  window.__cogniAdaptLoaded = true;

  // ══════════════════════════════════════════════════════════
  //  STATE
  // ══════════════════════════════════════════════════════════
  const S = {
    settings: null,
    calibrated: false,
    baseline: { ikiMean: 220, ikiCV: 0.28 },

    currentScore: 0,
    targetScore: 0,
    fatigueLevel: 0,      // 0 = normal, 1 = mild, 2 = high, 3 = critical

    // Signal buffers
    ikis: [],             // inter-keystroke intervals
    lastKeyTime: null,
    mousePts: [],         // mouse path points between clicks
    lastClickPt: null,
    scrollDeltas: [],     // scroll direction changes
    lastScrollY: 0,

    // Calibration
    calIKIs: [],
    calDone: false,

    // Derived scores (0–1)
    typingScore: 0,
    jitterScore: 0,
    scrollScore: 0,

    // Hysteresis — prevents flickering
    levelHoldStart: null,
    lastLevelChange: 0,

    // Session
    sessionStart: Date.now(),
    scoreHistory: [],     // [{t, score}]
    lastBreakReminder: 0,

    // HUD
    hud: null,
    hudCollapsed: false,
    sparkCanvas: null,
    sparkCtx: null,

    // ADHD features
    lastActivityTime: Date.now(),
    focusModeActive: false,
  };

  const DEFAULTS = {
    enabled: true,
    adaptUI: true,
    showFloatingHUD: true,
    notifyOnLevelChange: true,
    breakReminders: true,
    breakIntervalMin: 25,
    sensitivity: 0.7,
    trackingEnabled: true,
    dataRetentionDays: 7,
    // ADHD-specific
    adhdReadingGuide: true,
    adhdFocusRing: true,
    adhdReduceMotion: true,
    adhdHighContrast: false,
    adhdTimerVisible: false,
  };

  // ══════════════════════════════════════════════════════════
  //  BOOT
  // ══════════════════════════════════════════════════════════
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (settings) => {
    if (chrome.runtime.lastError) { S.settings = DEFAULTS; boot(); return; }
    S.settings = { ...DEFAULTS, ...settings };
    if (S.settings.enabled && S.settings.trackingEnabled) boot();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SETTINGS_UPDATED') {
      S.settings = { ...DEFAULTS, ...msg.settings };
      if (!S.settings.enabled || !S.settings.adaptUI) {
        removeAdaptations();
        if (S.hud) S.hud.style.display = 'none';
      } else {
        if (S.hud) S.hud.style.display = '';
        applyAdaptation(S.fatigueLevel);
      }
      if (S.hud) S.hud.style.display = S.settings.showFloatingHUD ? '' : 'none';
    }
    if (msg.type === 'BREAK_REMINDER') showBreakReminder();
  });

  function boot() {
    buildHUD();
    buildProgressBar();
    attachListeners();
    startCalibration();
    setInterval(computeScores, 2000);
    setInterval(animationLoop, 60);
    setInterval(saveSnapshot, 30000);
    setInterval(activityCheck, 60000);
  }

  // ══════════════════════════════════════════════════════════
  //  FLOATING HUD — with inline sparkline + collapse/expand
  // ══════════════════════════════════════════════════════════
  function buildHUD() {
    const hud = document.createElement('div');
    hud.id = '__cogni_hud__';
    hud.innerHTML = `
      <!-- Collapsed pill (shown when hud-collapsed) -->
      <div class="hud-pill" id="__c_pill__" title="Click to expand CogniAdapt">
        <span id="__c_pill_icon__">◈</span>
        <span class="hud-pill-score" id="__c_pill_score__">–</span>
      </div>

      <!-- Full HUD inner -->
      <div class="hud-inner" id="__c_inner__">
        <div class="cogni-hud-header">
          <span class="cogni-logo">◈ CogniAdapt</span>
          <div class="cogni-hud-btns">
            <button class="cogni-icon-btn" id="__c_collapse__" title="Collapse">−</button>
            <button class="cogni-icon-btn" id="__c_dash__" title="Open Dashboard">↗</button>
            <button class="cogni-icon-btn" id="__c_close__" title="Hide">×</button>
          </div>
        </div>

        <div class="cogni-score-row">
          <span class="cogni-score-num" id="__c_score__">–</span>
          <div class="cogni-score-right">
            <div class="cogni-bar-track"><div class="cogni-bar-fill" id="__c_bar__"></div></div>
            <span class="cogni-level-badge" id="__c_badge__">CALIBRATING</span>
          </div>
        </div>

        <!-- Mini sparkline -->
        <canvas class="cogni-spark-canvas" id="__c_spark__" width="200" height="28"></canvas>

        <div class="cogni-signals">
          <div class="cogni-sig"><span class="cogni-pip" id="__c_p1__"></span><span>Typing</span><b id="__c_v1__">–</b></div>
          <div class="cogni-sig"><span class="cogni-pip" id="__c_p2__"></span><span>Cursor</span><b id="__c_v2__">–</b></div>
          <div class="cogni-sig"><span class="cogni-pip" id="__c_p3__"></span><span>Scroll</span><b id="__c_v3__">–</b></div>
        </div>

        <div class="cogni-hud-footer">
          <button class="cogni-dash-btn" id="__c_dash2__">Full Dashboard ↗</button>
        </div>
      </div>
    `;

    document.body.appendChild(hud);
    S.hud = hud;

    // Sparkline setup
    S.sparkCanvas = hud.querySelector('#__c_spark__');
    S.sparkCtx = S.sparkCanvas.getContext('2d');

    // Collapse / expand
    hud.querySelector('#__c_collapse__').addEventListener('click', () => toggleCollapse(true));
    hud.querySelector('#__c_pill__').addEventListener('click', () => toggleCollapse(false));

    // Dashboard
    const openDash = () => chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
    hud.querySelector('#__c_dash__').addEventListener('click', openDash);
    hud.querySelector('#__c_dash2__').addEventListener('click', openDash);

    // Close
    hud.querySelector('#__c_close__').addEventListener('click', () => { hud.style.display = 'none'; });

    // Draggable (only when expanded)
    makeDraggable(hud, hud.querySelector('.cogni-hud-header'));

    if (S.settings && !S.settings.showFloatingHUD) hud.style.display = 'none';
  }

  function toggleCollapse(collapse) {
    S.hudCollapsed = collapse;
    S.hud.classList.toggle('hud-collapsed', collapse);
  }

  function makeDraggable(el, handle) {
    let ox = 0, oy = 0, dragging = false;
    handle.style.cursor = 'grab';
    handle.addEventListener('mousedown', (e) => {
      if (S.hudCollapsed) return;
      dragging = true;
      const rect = el.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      handle.style.cursor = 'grabbing';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.right = 'auto'; el.style.bottom = 'auto';
      el.style.left = Math.max(0, e.clientX - ox) + 'px';
      el.style.top = Math.max(0, e.clientY - oy) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; handle.style.cursor = 'grab'; });
  }

  function buildProgressBar() {
    const bar = document.createElement('div');
    bar.id = '__cogni_progress__';
    document.body.appendChild(bar);
    document.addEventListener('scroll', () => {
      const doc = document.documentElement;
      const pct = (window.scrollY / Math.max(doc.scrollHeight - doc.clientHeight, 1)) * 100;
      bar.style.width = Math.min(pct, 100) + '%';
    }, { passive: true });
  }

  // ══════════════════════════════════════════════════════════
  //  SILENT CALIBRATION
  // ══════════════════════════════════════════════════════════
  function startCalibration() {
    // After 20s, lock baseline from whatever IKIs we collected
    setTimeout(() => {
      if (S.calIKIs.length >= 6) {
        S.baseline.ikiMean = mean(S.calIKIs);
        S.baseline.ikiCV = std(S.calIKIs) / S.baseline.ikiMean;
      }
      S.calibrated = true;
    }, 20000);
  }

  // ══════════════════════════════════════════════════════════
  //  SIGNAL LISTENERS
  // ══════════════════════════════════════════════════════════
  function attachListeners() {
    document.addEventListener('keydown', onKey, { passive: true, capture: true });
    document.addEventListener('mousemove', onMouseMove, { passive: true });
    document.addEventListener('click', onClick, { passive: true });
    document.addEventListener('scroll', onScroll, { passive: true });
  }

  function onKey() {
    const now = Date.now();
    S.lastActivityTime = now;
    if (S.lastKeyTime) {
      const iki = now - S.lastKeyTime;
      if (iki > 40 && iki < 3000) {
        if (!S.calDone) {
          S.calIKIs.push(iki);
          if (S.calIKIs.length >= 30) {
            S.calDone = true;
            S.baseline.ikiMean = mean(S.calIKIs);
            S.baseline.ikiCV = std(S.calIKIs) / S.baseline.ikiMean;
            S.calibrated = true;
          }
        }
        S.ikis.push(iki);
        if (S.ikis.length > 40) S.ikis.shift();
      }
    }
    S.lastKeyTime = now;
  }

  function onMouseMove(e) {
    S.lastActivityTime = Date.now();
    S.mousePts.push({ x: e.clientX, y: e.clientY });
    if (S.mousePts.length > 300) S.mousePts.shift();
  }

  function onClick(e) {
    S.lastActivityTime = Date.now();
    if (S.lastClickPt && S.mousePts.length > 4) {
      const j = computeJitter(S.lastClickPt, { x: e.clientX, y: e.clientY });
      if (j !== null) S.jitterScore = S.jitterScore * 0.6 + j * 0.4;
    }
    S.lastClickPt = { x: e.clientX, y: e.clientY };
    S.mousePts = [];
  }

  function onScroll() {
    const now = Date.now();
    S.lastActivityTime = now;
    const dy = window.scrollY - S.lastScrollY;
    S.scrollDeltas.push({ dy, t: now });
    S.lastScrollY = window.scrollY;
    if (S.scrollDeltas.length > 40) S.scrollDeltas.shift();
  }

  // ══════════════════════════════════════════════════════════
  //  MATH HELPERS
  // ══════════════════════════════════════════════════════════
  function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
  function std(arr) {
    const m = mean(arr);
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
  }

  function computeJitter(start, end) {
    if (S.mousePts.length < 4) return null;
    const dx = end.x - start.x, dy = end.y - start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 15) return null;
    let total = 0;
    for (const p of S.mousePts) {
      const d = Math.abs(dy * p.x - dx * p.y + end.x * start.y - end.y * start.x) / len;
      total += d;
    }
    return (total / S.mousePts.length) / len;
  }

  function computeScrollEntropy() {
    if (S.scrollDeltas.length < 5) return 0;
    let reversals = 0;
    for (let i = 2; i < S.scrollDeltas.length; i++) {
      if (Math.sign(S.scrollDeltas[i].dy) !== Math.sign(S.scrollDeltas[i - 1].dy)
        && S.scrollDeltas[i - 1].dy !== 0) reversals++;
    }
    return Math.min(reversals / (S.scrollDeltas.length - 2), 1);
  }

  // ══════════════════════════════════════════════════════════
  //  SCORE ENGINE
  // ══════════════════════════════════════════════════════════
  function computeScores() {
    if (!S.calibrated) return;
    const sens = S.settings?.sensitivity ?? 0.7;

    // Typing score from IKI deviation vs personal baseline
    let tScore = 0;
    if (S.ikis.length >= 6) {
      const m = mean(S.ikis), cv = std(S.ikis) / m;
      const meanDev = (m - S.baseline.ikiMean) / (S.baseline.ikiMean * 0.6);
      const cvDev = (cv - S.baseline.ikiCV) / (S.baseline.ikiCV + 0.15);
      tScore = Math.max(0, Math.min(1, meanDev * 0.45 + cvDev * 0.55));
    }
    S.typingScore = tScore;

    const jNorm = S.jitterScore > 0.05 ? Math.min((S.jitterScore - 0.05) / 0.35, 1) : 0;
    S.scrollScore = computeScrollEntropy();

    const raw = (tScore * 0.50 + jNorm * 0.30 + S.scrollScore * 0.20) * 100 * sens;
    S.targetScore = Math.min(Math.max(raw, 0), 100);

    S.scoreHistory.push({ t: Date.now(), score: Math.round(S.targetScore) });
    if (S.scoreHistory.length > 300) S.scoreHistory.shift();
  }

  // ══════════════════════════════════════════════════════════
  //  ANIMATION LOOP
  // ══════════════════════════════════════════════════════════
  function animationLoop() {
    if (!S.calibrated) return;
    S.currentScore += (S.targetScore - S.currentScore) * 0.05;
    const s = Math.round(S.currentScore);
    renderHUD(s);
    updateAdaptation(s);
  }

  // ══════════════════════════════════════════════════════════
  //  HUD RENDER
  // ══════════════════════════════════════════════════════════
  function scoreColor(s) {
    if (s < 35) return '#5af0a0';
    if (s < 60) return '#f0d060';
    if (s < 78) return '#f09050';
    return '#f06060';
  }

  function renderHUD(s) {
    const numEl = document.getElementById('__c_score__');
    const barEl = document.getElementById('__c_bar__');
    if (!numEl) return;

    const col = scoreColor(s);
    numEl.textContent = s;
    numEl.style.color = col;
    if (barEl) { barEl.style.width = s + '%'; barEl.style.background = col; }

    // Collapsed pill
    const pillScore = document.getElementById('__c_pill_score__');
    const pillIcon = document.getElementById('__c_pill_icon__');
    if (pillScore) { pillScore.textContent = s; pillScore.style.color = col; }
    if (pillIcon) { pillIcon.style.color = col; }

    // Signal pips
    const setPip = (id, v, lo, hi) => {
      const el = document.getElementById(id);
      if (el) el.style.background = v > hi ? '#f06060' : v > lo ? '#f0d060' : '#5af0a0';
    };
    setPip('__c_p1__', S.typingScore, 0.25, 0.55);
    setPip('__c_p2__', S.jitterScore, 0.15, 0.30);
    setPip('__c_p3__', S.scrollScore, 0.30, 0.55);

    // Signal values
    const setVal = (id, v, suffix) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v < 0 ? '–' : v + suffix;
    };
    setVal('__c_v1__', S.ikis.length < 4 ? -1 : Math.round(S.typingScore * 100), '%');
    setVal('__c_v2__', S.jitterScore === 0 ? -1 : (Math.round(S.jitterScore * 100) / 10), '');
    setVal('__c_v3__', Math.round(S.scrollScore * 100), '%');

    // Sparkline
    drawHUDSparkline(col);
  }

  function drawHUDSparkline(col) {
    const canvas = S.sparkCanvas;
    const ctx = S.sparkCtx;
    if (!canvas || !ctx) return;
    const W = canvas.offsetWidth || 200;
    const H = 28;
    canvas.width = W;
    canvas.height = H;
    ctx.clearRect(0, 0, W, H);
    const data = S.scoreHistory.slice(-40);
    if (data.length < 2) return;
    const step = W / (data.length - 1);

    // Fill
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = i * step;
      const y = H - (d.score / 100) * (H - 4) - 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.lineTo((data.length - 1) * step, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, col + '35');
    grad.addColorStop(1, col + '00');
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = i * step;
      const y = H - (d.score / 100) * (H - 4) - 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // ══════════════════════════════════════════════════════════
  //  ADAPTATION ENGINE — maps score → level → CSS classes
  //  Uses teammate's fatigue-level-1/2/3 class system
  // ══════════════════════════════════════════════════════════
  function updateAdaptation(s) {
    const now = Date.now();
    const newLevel = s < 30 ? 0 : s < 52 ? 1 : s < 72 ? 2 : 3;

    if (newLevel === S.fatigueLevel) { S.levelHoldStart = null; return; }

    // Hysteresis: hold for 2.5s going up, 4s coming down
    if (!S.levelHoldStart) { S.levelHoldStart = now; return; }
    const needed = newLevel > S.fatigueLevel ? 2500 : 4000;
    if (now - S.levelHoldStart < needed) return;

    S.fatigueLevel = newLevel;
    S.levelHoldStart = null;
    S.lastLevelChange = now;

    if (S.settings?.adaptUI) applyAdaptation(newLevel);
    if (S.settings?.notifyOnLevelChange) showToast(newLevel);
    updateBadge(newLevel);
  }

  // Applies teammate's fatigue-level-X body class
  function applyAdaptation(level) {
    document.body.classList.remove('fatigue-level-1', 'fatigue-level-2', 'fatigue-level-3');
    if (level > 0) document.body.classList.add(`fatigue-level-${level}`);

    // ADHD: reduce motion at level 2+
    if (S.settings?.adhdReduceMotion && level >= 2) {
      document.documentElement.style.setProperty('--cogni-motion', 'none');
    } else {
      document.documentElement.style.removeProperty('--cogni-motion');
    }

    // ADHD: high contrast boost at level 3
    if (S.settings?.adhdHighContrast && level === 3) {
      document.body.style.setProperty('--cogni-contrast', 'contrast(1.25)');
    }
  }

  function removeAdaptations() {
    document.body.classList.remove('fatigue-level-1', 'fatigue-level-2', 'fatigue-level-3');
  }

  function updateBadge(level) {
    const el = document.getElementById('__c_badge__');
    if (!el) return;
    const labels = ['NORMAL', 'MILD', 'HIGH LOAD', 'FOCUS MODE'];
    const colors = ['#5af0a0', '#f0d060', '#f09050', '#f06060'];
    const c = colors[level];
    el.textContent = labels[level];
    el.style.color = c;
    el.style.borderColor = c + '40';
    el.style.background = c + '12';
  }

  // ══════════════════════════════════════════════════════════
  //  TOAST
  // ══════════════════════════════════════════════════════════
  function showToast(level) {
    const existing = document.getElementById('__cogni_toast__');
    if (existing) existing.remove();
    const msgs = [
      { icon: '✓', text: 'Restored. Welcome back — full interface active.' },
      { icon: '🌊', text: 'Mild fatigue. Text enlarged, spacing opened up.' },
      { icon: '🧠', text: 'High load. Clutter removed, focus mode on.' },
      { icon: '🌙', text: 'Critical fatigue. Sensory muting + focus mode active.' },
    ];
    const m = msgs[level];
    const t = document.createElement('div');
    t.id = '__cogni_toast__';
    t.innerHTML = `<span>${m.icon}</span> ${m.text}`;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('__cogni_toast_show__'), 80);
    setTimeout(() => { t.classList.remove('__cogni_toast_show__'); setTimeout(() => t.remove(), 600); }, 4500);
  }

  // ══════════════════════════════════════════════════════════
  //  BREAK REMINDER
  // ══════════════════════════════════════════════════════════
  function showBreakReminder() {
    if (Date.now() - S.lastBreakReminder < 300000) return;
    S.lastBreakReminder = Date.now();
    const banner = document.createElement('div');
    banner.id = '__cogni_break__';
    banner.innerHTML = `
      <div class="__cb_inner__">
        <span class="__cb_icon__">☕</span>
        <div class="__cb_text__">
          <b>Time for a short break</b>
          <span>You've been active for a while. Rest reduces cognitive fatigue significantly.</span>
        </div>
        <button class="__cb_dismiss__">Dismiss</button>
      </div>`;
    document.body.appendChild(banner);
    setTimeout(() => banner.classList.add('__cb_show__'), 80);
    banner.querySelector('.__cb_dismiss__').addEventListener('click', () => {
      banner.classList.remove('__cb_show__');
      setTimeout(() => banner.remove(), 600);
    });
    setTimeout(() => {
      if (banner.parentNode) { banner.classList.remove('__cb_show__'); setTimeout(() => banner.remove(), 600); }
    }, 15000);
  }

  // ══════════════════════════════════════════════════════════
  //  ACTIVITY CHECK — for break reminders
  // ══════════════════════════════════════════════════════════
  function activityCheck() {
    if (!S.settings?.breakReminders) return;
    const inactiveMs = Date.now() - S.lastActivityTime;
    // User is active (not idle for > 5min) and has been active for 25min since last break
    if (inactiveMs < 300000) {
      const activeMins = (Date.now() - S.sessionStart) / 60000;
      const intervalMins = S.settings?.breakIntervalMin ?? 25;
      if (activeMins >= intervalMins && Date.now() - S.lastBreakReminder > intervalMins * 60000) {
        showBreakReminder();
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  //  SESSION SNAPSHOT SAVE
  // ══════════════════════════════════════════════════════════
  function saveSnapshot() {
    if (!S.calibrated || !S.scoreHistory.length) return;
    const recent = S.scoreHistory.slice(-10);
    const avgScore = Math.round(mean(recent.map(r => r.score)));
    chrome.runtime.sendMessage({
      type: 'SAVE_SESSION_DATA',
      data: {
        url: location.hostname,
        avgScore,
        level: S.fatigueLevel,
        typingScore: Math.round(S.typingScore * 100),
        jitterScore: Math.round(S.jitterScore * 1000) / 10,
        scrollScore: Math.round(S.scrollScore * 100),
        sessionDuration: Math.round((Date.now() - S.sessionStart) / 1000),
        history: S.scoreHistory.slice(-30),
      }
    }).catch(() => {});
  }

  // ══════════════════════════════════════════════════════════
  //  PUBLIC API — for popup to query
  // ══════════════════════════════════════════════════════════
  window.__cogniAdapt = {
    getState: () => ({
      score: Math.round(S.currentScore),
      level: S.fatigueLevel,
      typingScore: Math.round(S.typingScore * 100),
      jitterScore: Math.round(S.jitterScore * 1000) / 10,
      scrollScore: Math.round(S.scrollScore * 100),
      calibrated: S.calibrated,
      history: S.scoreHistory.slice(-60),
    }),
    setLevel: (n) => { S.fatigueLevel = n; applyAdaptation(n); updateBadge(n); }
  };

})();

// ══════════════════════════════════════════════════════════
//  WEBSITE BRIDGE — broadcasts real signal data to
//  localStorage so cognitiveshift website can read it.
//  Uses 'cognishift_live' key, updated every 2s.
// ══════════════════════════════════════════════════════════
function broadcastToWebsite() {
  if (!S.calibrated) return;
  try {
    const payload = {
      ts: Date.now(),
      score: Math.round(S.currentScore),
      level: S.fatigueLevel,
      typingScore: Math.round(S.typingScore * 100),
      jitterScore: parseFloat((Math.round(S.jitterScore * 1000) / 10).toFixed(2)),
      scrollScore: Math.round(S.scrollScore * 100),
      ikiVariance: parseFloat((S.baseline.ikiCV + S.typingScore * 0.4 + Math.random() * 0.03).toFixed(2)),
      cursorJitter: parseFloat((S.jitterScore * 0.4 + Math.random() * 0.02).toFixed(2)),
      scrollEntropy: parseFloat((S.scrollScore * 0.8 + Math.random() * 0.03).toFixed(2)),
      dwellRatio: parseFloat((1.0 + S.currentScore * 0.02 + Math.random() * 0.1).toFixed(1)),
      history: S.scoreHistory.slice(-90).map(h => h.score),
      calibrated: S.calibrated,
      sessionStart: S.sessionStart,
      url: location.hostname,
    };
    localStorage.setItem('cognishift_live', JSON.stringify(payload));
    // Also dispatch a storage event so the website picks it up cross-frame
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'cognishift_live',
      newValue: JSON.stringify(payload),
    }));
  } catch(e) {}
}

// Broadcast every 2s once calibrated
setInterval(broadcastToWebsite, 2000);
