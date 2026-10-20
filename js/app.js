/* RetroLens web — port of the Python PortalProcessor/GeometryUtils to the browser. */
(function () {
  "use strict";

  // Thresholds were tuned for a 960px-wide frame (same as the Python version); they scale with canvas width.
  const CFG = {
    baseWidth: 960,
    pinchPx: 45,
    fistPx: 80,
    rotatedDy: 25,
    filterCooldownMs: 150,
    modeCooldownMs: 1200,
    minPortalPx: 10,
  };

  const FILTER_KEYS = ["dual-tone", "thermal", "sketch", "pixelate", "glitch", "invert",
    "red-channel", "edge", "blur", "cartoon", "rainbow-wave"];

  const HAND_CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
    [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

  const $ = (id) => document.getElementById(id);
  const video = $("cam"), canvas = $("view");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const tmp = document.createElement("canvas");
  const tctx = tmp.getContext("2d");

  const state = {
    running: false, hands: null, stream: null,
    filterIdx: 0, is3d: false, isBowtie: false,
    lastSwitch: 0, lastMode: 0, scale: 1, busy: false,
  };

  /* ---------- geometry (port of GeometryUtils) ---------- */
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  function isFistClosed(pts21, threshold) {
    const wrist = pts21[0];
    const tips = [8, 12, 16, 20];
    const mean = tips.reduce((s, i) => s + dist(pts21[i], wrist), 0) / tips.length;
    return mean < threshold;
  }

  function isHandRotated(thumb, index) {
    const dx = index[0] - thumb[0], dy = index[1] - thumb[1];
    return dy > CFG.rotatedDy * state.scale || Math.abs(dx) > Math.abs(dy) * 1.1;
  }

  function splitByX(pts) {
    const s = [...pts].sort((a, b) => a[0] - b[0]);
    const left = s.slice(0, 2).sort((a, b) => a[1] - b[1]);
    const right = s.slice(2).sort((a, b) => a[1] - b[1]);
    return { left, right };
  }
  function sortQuadClean(pts) {
    const { left, right } = splitByX(pts);
    return [left[0], right[0], right[1], left[1]];
  }
  function sortQuadBowtie(pts) {
    const { left, right } = splitByX(pts);
    return [left[0], right[1], right[0], left[1]];
  }

  /* ---------- portal rendering ---------- */
  function renderPortal(poly, filterKey) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [px, py] of poly) {
      minX = Math.min(minX, px); minY = Math.min(minY, py);
      maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
    }
    const x = Math.max(0, Math.floor(minX)), y = Math.max(0, Math.floor(minY));
    const w = Math.min(Math.ceil(maxX), canvas.width) - x;
    const h = Math.min(Math.ceil(maxY), canvas.height) - y;
    if (w <= CFG.minPortalPx || h <= CFG.minPortalPx) return;

    const img = ctx.getImageData(x, y, w, h);
    const out = RetroFilters[filterKey](img);
    if (tmp.width !== w || tmp.height !== h) { tmp.width = w; tmp.height = h; }
    tctx.putImageData(out, 0, 0);

    ctx.save();
    ctx.beginPath();
    poly.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(tmp, x, y);
    ctx.restore();

    ctx.beginPath();
    poly.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.closePath();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawHand(pts21) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,.85)";
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(pts21[a][0], pts21[a][1]);
      ctx.lineTo(pts21[b][0], pts21[b][1]);
    }
    ctx.stroke();
    ctx.fillStyle = "#ff8c0a";
    for (const p of pts21) { ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, Math.PI * 2); ctx.fill(); }
  }

  /* ---------- filter / mode state ---------- */
  const currentFilter = () => FILTER_KEYS[state.filterIdx];
  const secondaryFilter = () => FILTER_KEYS[(state.filterIdx + 1) % FILTER_KEYS.length];

  function cycleFilter(step) {
    state.filterIdx = (state.filterIdx + step + FILTER_KEYS.length) % FILTER_KEYS.length;
    syncUi();
  }
  function toggleMode() {
    state.is3d = !state.is3d;
    syncUi();
  }

  const chipEls = [];
  function buildChips() {
    const wrap = $("chips");
    FILTER_KEYS.forEach((k, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.textContent = k; b.setAttribute("role", "option");
      b.addEventListener("click", () => { state.filterIdx = i; syncUi(); });
      wrap.appendChild(b); chipEls.push(b);
    });
  }

  function modeLabel() { return state.is3d ? "3D mesh" : state.isBowtie ? "2D bowtie" : "2D quad"; }
  let lastModeLabel = "";
  function syncUi() {
    chipEls.forEach((el, i) => {
      const on = i === state.filterIdx;
      el.setAttribute("aria-selected", String(on));
      if (on) el.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    });
    $("hudFilter").textContent = currentFilter();
    $("modeBtn").textContent = state.is3d ? "Mode 2D" : "Mode 3D";
    syncMode();
  }
  function syncMode() {
    const label = modeLabel();
    if (label !== lastModeLabel) { $("hudMode").textContent = label; lastModeLabel = label; }
  }

  /* ---------- per-frame pipeline ---------- */
  function onResults(results) {
    const W = canvas.width, H = canvas.height, s = state.scale;
    const now = performance.now();

    // mirrored camera frame (selfie view)
    ctx.save();
    ctx.translate(W, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, W, H);
    ctx.restore();

    const hands = (results.multiHandLandmarks || []).map((lm) => lm.map((p) => [(1 - p.x) * W, p.y * H]));
    const allTips = [];
    let fists = 0;
    state.isBowtie = false;

    for (const h of hands) {
      const tips = [4, 8, 12, 16, 20].map((i) => h[i]);
      allTips.push(tips);
      if (dist(tips[0], tips[4]) < CFG.pinchPx * s && now - state.lastSwitch > CFG.filterCooldownMs) {
        cycleFilter(1); state.lastSwitch = now;
      }
      if (isFistClosed(h, CFG.fistPx * s)) fists++;
    }

    if (fists === 2 && now - state.lastMode > CFG.modeCooldownMs) {
      toggleMode(); state.lastMode = now;
    }

    if (state.is3d) {
      if (allTips.length === 2) {
        const [t1, t2] = allTips;
        renderPortal([t1[0], t1[1], t1[2], t2[2], t2[1], t2[0]], currentFilter());
        renderPortal([t1[2], t1[3], t1[4], t2[4], t2[3], t2[2]], secondaryFilter());
      } else if (allTips.length === 1) {
        renderPortal(allTips[0], currentFilter());
      }
    } else if (allTips.length === 2) {
      const corners = [allTips[0][0], allTips[0][1], allTips[1][0], allTips[1][1]];
      let quad;
      if (isHandRotated(corners[0], corners[1]) || isHandRotated(corners[2], corners[3])) {
        quad = sortQuadBowtie(corners); state.isBowtie = true;
      } else {
        quad = sortQuadClean(corners);
      }
      renderPortal(quad, currentFilter());
    } else if (allTips.length === 1) {
      const t = allTips[0];
      renderPortal([t[0], t[1], t[2], t[4]], currentFilter());
    }

    hands.forEach(drawHand);
    syncMode();
  }

  async function loop() {
    if (!state.running) return;
    if (!state.busy && video.readyState >= 2) {
      state.busy = true;
      try { await state.hands.send({ image: video }); } catch (e) { console.error(e); }
      state.busy = false;
    }
    requestAnimationFrame(loop);
  }

  /* ---------- camera lifecycle ---------- */
  function setStatus(msg, isError) {
    const el = $("status");
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
  }

  async function start() {
    const btn = $("startBtn");
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("Kamera hanya bisa dipakai lewat HTTPS atau localhost, dan browser harus mendukung kamera.", true);
      return;
    }
    btn.disabled = true;
    setStatus("Meminta izin kamera…");
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
      });
      video.srcObject = state.stream;
      await video.play();

      const vw = video.videoWidth || 960, vh = video.videoHeight || 540;
      canvas.width = Math.min(CFG.baseWidth, vw);
      canvas.height = Math.round(canvas.width * vh / vw);
      $("stage").style.aspectRatio = `${canvas.width} / ${canvas.height}`;
      state.scale = canvas.width / CFG.baseWidth;

      setStatus("Memuat model pelacak tangan…");
      if (!state.hands) {
        state.hands = new Hands({ locateFile: (f) => `vendor/mediapipe/hands/${f}` });
        state.hands.setOptions({
          maxNumHands: 2, modelComplexity: 1,
          minDetectionConfidence: 0.7, minTrackingConfidence: 0.7,
        });
        state.hands.onResults(onResults);
        await state.hands.initialize();
      }

      $("overlay").hidden = true;
      $("hud").hidden = false;
      $("controls").hidden = false;
      state.running = true;
      syncUi();
      loop();
    } catch (err) {
      console.error(err);
      stopStream();
      const msg = err && err.name === "NotAllowedError"
        ? "Izin kamera ditolak. Aktifkan izin kamera untuk situs ini di pengaturan browser, lalu coba lagi."
        : err && err.name === "NotFoundError"
        ? "Kamera tidak ditemukan. Pasang atau aktifkan kamera, lalu coba lagi."
        : "Gagal memulai: " + (err && err.message ? err.message : err);
      setStatus(msg, true);
      btn.disabled = false;
      btn.textContent = "Coba lagi";
    }
  }

  function stopStream() {
    state.running = false;
    if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
    video.srcObject = null;
  }

  function stop() {
    stopStream();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    $("hud").hidden = true;
    $("controls").hidden = true;
    $("overlay").hidden = false;
    $("startBtn").disabled = false;
    $("startBtn").textContent = "Nyalakan kamera";
    setStatus("Kamera dimatikan.");
  }

  function screenshot() {
    if (!state.running) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `retrolens-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  }

  /* ---------- wiring ---------- */
  buildChips();
  $("startBtn").addEventListener("click", start);
  $("prevBtn").addEventListener("click", () => cycleFilter(-1));
  $("nextBtn").addEventListener("click", () => cycleFilter(1));
  $("modeBtn").addEventListener("click", toggleMode);
  $("shotBtn").addEventListener("click", screenshot);
  $("stopBtn").addEventListener("click", stop);

  window.addEventListener("keydown", (e) => {
    if (!state.running || e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case "n": cycleFilter(1); break;
      case "p": cycleFilter(-1); break;
      case "c": toggleMode(); break;
      case "s": screenshot(); break;
      case "q": stop(); break;
    }
  });

})();
