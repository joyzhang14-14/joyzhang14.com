// Interactive memory graph: renderer, camera, pulses and gestures for GraphEngine.
// Mirrors My Portrait's GraphRendererView / GraphCamera / GraphPulseScheduler /
// GraphRootView (camera framing + tap routing), light color scheme.
(() => {
  const root = document.getElementById("memory-graph");
  if (!root || !window.GraphEngine) return;
  const C = window.GraphConstants;
  const canvas = root.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const labels = JSON.parse(root.dataset.labels || "{}");
  const mainImg = new Image();
  mainImg.src = root.dataset.mainImage;

  let scene, engine, hubNodes, colorGroups, beltGroups, adjacency;
  let W = 0,
    H = 0,
    dpr = 1;
  const cam = { cx: 0, cy: 0, zoom: 1 };
  const SEED = 7;
  // Follow the site theme: flashes/pulses use the contrast color (black on
  // light, white on dark), labels use the page ink.
  // Labels cross-fade with the page (0.7s); the label color is eased per frame.
  const THEME_FADE_SEC = 0.7;
  let labelFrom = null, labelTo = null, labelFadeStart = 0;
  let contrast, labelInk;
  const applyScheme = () => {
    const dark = window.siteTheme
      ? window.siteTheme.isDark()
      : matchMedia("(prefers-color-scheme: dark)").matches;
    contrast = dark ? "255,255,255" : "0,0,0";
    const next = dark ? [230, 230, 230] : [17, 17, 17];
    labelFrom = labelTo ? currentLabel() : next;
    labelTo = next;
    labelFadeStart = performance.now() / 1000;
    labelInk = labelFrom.join(",");
  };
  const labelFading = () =>
    performance.now() / 1000 - labelFadeStart < THEME_FADE_SEC;
  function currentLabel() {
    const u = Math.min((performance.now() / 1000 - labelFadeStart) / THEME_FADE_SEC, 1);
    const e = u * u * (3 - 2 * u);
    return labelFrom.map((c, i) => Math.round(c + (labelTo[i] - c) * e));
  }
  applyScheme();
  addEventListener("themechange", () => {
    applyScheme();
    if (started) wake();
  });
  const ZOOM_MIN = 0.15,
    ZOOM_MAX = 6;
  let camTask = null; // per-frame camera animation, returns true when finished
  let hideLinks = true;
  // Links fade in/out instead of popping: alpha eases toward the switch state.
  const LINK_FADE_SEC = 1.2;
  let linkAlpha = 0;
  const linkToggle = document.querySelector(".link-toggle");
  if (linkToggle)
    linkToggle.addEventListener("click", (e) => {
      e.stopPropagation(); // don't count as "skip typing"
      hideLinks = !hideLinks;
      linkToggle.setAttribute("aria-checked", String(!hideLinks));
      if (started) wake();
    });
  let pulses = [],
    pulseStart = 0,
    pulseEnd = 0;
  let hovered = null,
    hoverScreen = null;
  let running = false,
    started = false,
    visible = false;
  let lastT = 0,
    acc = 0;

  // ---------- engine adapters ----------
  let snap = null;
  function readSnap() {
    const s = engine.readSnapshot();
    if (s.length === scene.nodes.length * 2 && typeof s[0] === "number")
      return s;
    const out = new Float64Array(scene.nodes.length * 2);
    for (let i = 0; i < s.length; i++) {
      out[2 * i] = s[i].x;
      out[2 * i + 1] = s[i].y;
    }
    return out;
  }
  const beltReveal = () =>
    typeof engine.readBeltReveal === "function"
      ? engine.readBeltReveal()
      : (engine.beltRevealAlpha ?? 1);
  const ring = () => engine.readRingSnapshot();
  const parked = () => engine.isParked();

  // ---------- camera ----------
  const toScreen = (x, y) => [
    (x - cam.cx) * cam.zoom + W / 2,
    (y - cam.cy) * cam.zoom + H / 2,
  ];
  const toWorld = (sx, sy) => [
    (sx - W / 2) / cam.zoom + cam.cx,
    (sy - H / 2) / cam.zoom + cam.cy,
  ];
  function zoomBy(f, ax, ay) {
    if (!isFinite(f) || f <= 0) return;
    const [wx, wy] = toWorld(ax, ay);
    cam.zoom = Math.min(Math.max(cam.zoom * f, ZOOM_MIN), ZOOM_MAX);
    cam.cx = wx - (ax - W / 2) / cam.zoom;
    cam.cy = wy - (ay - H / 2) / cam.zoom;
  }
  function frameFor(cx, cy, r, fill = C.cameraFrameFill) {
    if (!(r > 1) || W < 2 || H < 2) return null;
    const z = (Math.min(W, H) * fill) / (2 * r);
    return { cx, cy, zoom: Math.min(Math.max(z, ZOOM_MIN), ZOOM_MAX) };
  }
  function overview() {
    const rg = ring();
    if (rg && rg.r > 1) return frameFor(rg.cx, rg.cy, rg.r);
    let cx = 0,
      cy = 0,
      n = scene.nodes.length;
    for (let i = 0; i < n; i++) {
      cx += snap[2 * i];
      cy += snap[2 * i + 1];
    }
    cx /= n;
    cy /= n;
    let r = 0;
    for (let i = 0; i < n; i++)
      r = Math.max(
        r,
        Math.hypot(snap[2 * i] - cx, snap[2 * i + 1] - cy) +
          scene.nodes[i].radius,
      );
    return frameFor(cx, cy, r);
  }
  // Lerp-follow the live ring until physics parks and the camera has caught up.
  function trackRing(opening = false) {
    let frames = 0;
    camTask = () => {
      const live = ring();
      const t =
        opening && !(live && live.r > 1) && preloaded
          ? frameFor(preloaded.cx, preloaded.cy, preloaded.r)
          : overview();
      if (!t || ++frames > 900) return true;
      const k = C.cameraTrackLerp;
      cam.cx += (t.cx - cam.cx) * k;
      cam.cy += (t.cy - cam.cy) * k;
      cam.zoom += (t.zoom - cam.zoom) * k;
      if (
        parked() &&
        Math.hypot(t.cx - cam.cx, t.cy - cam.cy) < 0.5 &&
        Math.abs(t.zoom - cam.zoom) < 0.001
      ) {
        Object.assign(cam, t);
        return true;
      }
      return false;
    };
  }
  // van Wijk & Nuij smooth zoom+pan to a fixed target.
  function animateCamera(c1x, c1y, z1raw, onDone) {
    const z1 = Math.min(Math.max(z1raw, ZOOM_MIN), ZOOM_MAX);
    const c0x = cam.cx,
      c0y = cam.cy,
      z0 = cam.zoom;
    const finish = () => {
      cam.cx = c1x;
      cam.cy = c1y;
      cam.zoom = z1;
      onDone && onDone();
    };
    if (
      Math.hypot(c1x - c0x, c1y - c0y) < 0.5 &&
      Math.abs(Math.log(z1 / z0)) < 0.005
    ) {
      camTask = null;
      finish();
      return;
    }
    const minDim = Math.min(W, H);
    const w0 = minDim / z0,
      w1 = minDim / z1;
    const dx = c1x - c0x,
      dy = c1y - c0y,
      u1 = Math.hypot(dx, dy);
    const n = Math.max(C.cameraFocusFrames, 1);
    let i = 0;
    const ease = (u) => u * u * (3 - 2 * u);
    if (u1 < 1e-4) {
      camTask = () => {
        const t = ease(i / n);
        cam.cx = c1x;
        cam.cy = c1y;
        cam.zoom = minDim / (w0 * Math.pow(w1 / w0, t));
        if (++i > n) {
          finish();
          return true;
        }
        return false;
      };
      return;
    }
    const rho = 1.4,
      rho2 = rho * rho,
      rho4 = rho2 * rho2;
    const dw = w1 * w1 - w0 * w0;
    const b0 = (dw + rho4 * u1 * u1) / (2 * w0 * rho2 * u1);
    const b1 = (dw - rho4 * u1 * u1) / (2 * w1 * rho2 * u1);
    const r0 = Math.log(-b0 + Math.sqrt(b0 * b0 + 1));
    const r1 = Math.log(-b1 + Math.sqrt(b1 * b1 + 1));
    const S = (r1 - r0) / rho;
    const ux = dx / u1,
      uy = dy / u1;
    camTask = () => {
      const s = ease(i / n) * S;
      const w = (w0 * Math.cosh(r0)) / Math.cosh(rho * s + r0);
      const uu =
        (w0 / rho2) * Math.cosh(r0) * Math.tanh(rho * s + r0) -
        (w0 / rho2) * Math.sinh(r0);
      cam.cx = c0x + ux * uu;
      cam.cy = c0y + uy * uu;
      cam.zoom = minDim / w;
      if (++i > n) {
        finish();
        return true;
      }
      return false;
    };
  }

  // ---------- pulses ----------
  function schedule(origin, speed, maxDepth, blocked) {
    const list = [];
    let total = 0;
    const visited = new Set([origin, ...blocked]);
    const frontier = [[origin, 0, 0]];
    for (let h = 0; h < frontier.length; h++) {
      const [node, arrival, depth] = frontier[h];
      if (depth >= maxDepth) continue;
      for (const [ei, other] of adjacency[node]) {
        if (visited.has(other)) continue;
        visited.add(other);
        const len = Math.hypot(
          snap[2 * other] - snap[2 * node],
          snap[2 * other + 1] - snap[2 * node + 1],
        );
        const duration = Math.max(len / speed, 0.05);
        list.push({ edge: ei, from: node, start: arrival, duration });
        total = Math.max(total, arrival + duration);
        frontier.push([other, arrival + duration, depth + 1]);
      }
    }
    return { list, total };
  }
  function hubPulseSpeed(hub, blocked) {
    let sum = 0,
      cnt = 0;
    for (const e of scene.edges) {
      const other = e.a === hub ? e.b : e.b === hub ? e.a : -1;
      if (other < 0 || blocked.includes(other)) continue;
      sum += Math.hypot(
        snap[2 * other] - snap[2 * hub],
        snap[2 * other + 1] - snap[2 * hub + 1],
      );
      cnt++;
    }
    return cnt && sum ? sum / cnt / C.pulseHubTravelSeconds : C.pulseSpeed;
  }
  function triggerPulse(hub) {
    const isMain = scene.nodes[hub].kind === "main";
    const blocked = isMain ? [] : [0];
    const speed = isMain ? C.pulseSpeed : hubPulseSpeed(hub, blocked);
    const { list, total } = schedule(
      hub,
      speed,
      isMain ? C.pulseMaxDepthMain : C.pulseMaxDepthOther,
      blocked,
    );
    const now = performance.now() / 1000;
    if (!pulses.length) {
      pulseStart = now;
      pulseEnd = 0;
    }
    const base = now - pulseStart;
    for (const p of list) pulses.push({ ...p, start: base + p.start });
    pulseEnd = Math.max(pulseEnd, base + total);
    wake();
  }

  // ---------- hit testing ----------
  function hitTest(sx, sy) {
    const beltOk = beltReveal() >= 1;
    const [wx, wy] = toWorld(sx, sy);
    let best = null,
      bestD = Infinity;
    for (let i = 0; i < scene.nodes.length; i++) {
      const nd = scene.nodes[i];
      if (!beltOk && nd.beltTier != null) continue;
      const d = Math.hypot(snap[2 * i] - wx, snap[2 * i + 1] - wy);
      if (d <= nd.radius + 4 && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  // ---------- drawing ----------
  const rgb = (c, a = 1) =>
    `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
  const onScreen = (x, y, r) =>
    !(x + r < 0 || x - r > W || y + r < 0 || y - r > H);

  function taperedEdge(path, e, pa, pb) {
    const z = cam.zoom;
    let dx = pb[0] - pa[0],
      dy = pb[1] - pa[1];
    const len = Math.max(Math.hypot(dx, dy), 0.001);
    dx /= len;
    dy /= len;
    const nx = -dy,
      ny = dx;
    const wb = Math.min(e.halfWidthB, scene.nodes[e.b].radius) * z;
    const stretch = Math.max(len / z / Math.max(e.restLength, 1), 1);
    const wa = (wb * C.waistRatio) / stretch,
      wm = wa;
    const ballR = scene.nodes[e.b].radius * z;
    const rim = Math.min(
      Math.sqrt(Math.max(ballR * ballR - wb * wb, 0)),
      len * 0.5,
    );
    const ex = pb[0] - dx * rim,
      ey = pb[1] - dy * rim;
    const mx = (pa[0] + ex) / 2,
      my = (pa[1] + ey) / 2;
    path.moveTo(pa[0] + nx * wa, pa[1] + ny * wa);
    path.quadraticCurveTo(
      mx + nx * wm,
      my + ny * wm,
      ex + nx * wb,
      ey + ny * wb,
    );
    path.lineTo(ex - nx * wb, ey - ny * wb);
    path.quadraticCurveTo(
      mx - nx * wm,
      my - ny * wm,
      pa[0] - nx * wa,
      pa[1] - ny * wa,
    );
    path.closePath();
  }
  function localHalfWidth(e, t, from, screenLen) {
    if (e.b === 0 && isHub(e.a)) {
      const z = cam.zoom;
      const mainW = Math.min(e.halfWidthB, scene.nodes[e.b].radius) * z;
      const stretch = Math.max(screenLen / z / Math.max(e.restLength, 1), 1);
      const tipW = (mainW * C.waistRatio) / stretch;
      const ballR = scene.nodes[e.b].radius * z;
      const rim = Math.min(
        Math.sqrt(Math.max(ballR * ballR - mainW * mainW, 0)),
        screenLen * 0.5,
      );
      const sFromA = (from === e.b ? 1 - t : t) * screenLen;
      const tb = Math.min(
        Math.max(sFromA / Math.max(screenLen - rim, 1), 0),
        1,
      );
      const u = 1 - tb;
      return u * u * tipW + 2 * u * tb * tipW + tb * tb * mainW;
    }
    return C.lineEdgeWidth / 2;
  }
  const isHub = (i) =>
    ["main", "folder", "category"].includes(scene.nodes[i].kind);

  function draw(pos, now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const P = (i) => toScreen(pos[2 * i], pos[2 * i + 1]);
    // edges: hub↔main tapered bands, others thin lines (screen-pixel width).
    // Minimal look (the app's hideLinks): no lines and no pulse bars; the
    // arrival flashes still cascade ball by ball.
    // smoothstep: starts faint and eases in, so thin lines don't seem to pop
    const linkShown = linkAlpha * linkAlpha * (3 - 2 * linkAlpha);
    if (linkShown > 0.001) {
      ctx.globalAlpha = linkShown;
      const lines = new Path2D(),
        bands = new Path2D();
      for (const e of scene.edges) {
        const pa = P(e.a),
          pb = P(e.b);
        if (
          Math.max(pa[0], pb[0]) < -50 ||
          Math.min(pa[0], pb[0]) > W + 50 ||
          Math.max(pa[1], pb[1]) < -50 ||
          Math.min(pa[1], pb[1]) > H + 50
        )
          continue;
        if (e.b === 0 && isHub(e.a)) taperedEdge(bands, e, pa, pb);
        else {
          lines.moveTo(pa[0], pa[1]);
          lines.lineTo(pb[0], pb[1]);
        }
      }
      ctx.fillStyle = "rgba(128,128,128,0.45)";
      ctx.fill(bands);
      ctx.strokeStyle = "rgba(128,128,128,0.45)";
      ctx.lineWidth = C.lineEdgeWidth;
      ctx.stroke(lines);
      ctx.globalAlpha = 1;
    }
    // pulses: three thin bars perpendicular to the edge
    const elapsed = now - pulseStart;
    if (linkShown > 0.001 && pulses.length) {
      const ticks = new Path2D();
      for (const p of pulses) {
        const t = (elapsed - p.start) / p.duration;
        if (t < 0 || t > 1) continue;
        const e = scene.edges[p.edge];
        const to = e.a === p.from ? e.b : e.a;
        const pa = P(p.from),
          pb = P(to);
        let dx = pb[0] - pa[0],
          dy = pb[1] - pa[1];
        const len = Math.max(Math.hypot(dx, dy), 0.001);
        dx /= len;
        dy /= len;
        const nx = -dy,
          ny = dx;
        for (let k = 0; k < C.pulseTickCount; k++) {
          const off = (k - (C.pulseTickCount - 1) / 2) * C.pulseTickSpacing;
          const tk = Math.min(Math.max(t + off / len, 0), 1);
          const x = pa[0] + (pb[0] - pa[0]) * tk,
            y = pa[1] + (pb[1] - pa[1]) * tk;
          const hl =
            localHalfWidth(e, tk, p.from, len) * C.pulseTickLengthScale;
          ticks.moveTo(x - nx * hl, y - ny * hl);
          ticks.lineTo(x + nx * hl, y + ny * hl);
        }
      }
      ctx.strokeStyle = `rgba(${contrast},0.9)`;
      ctx.lineWidth = C.pulseTickStrokeWidth;
      ctx.globalAlpha = linkShown;
      ctx.stroke(ticks);
      ctx.globalAlpha = 1;
    }
    // balls: one path per color, big first
    const z = cam.zoom;
    const fillGroups = (groups) => {
      for (const g of groups) {
        const path = new Path2D();
        let any = false;
        for (const i of g.nodes) {
          const [x, y] = P(i),
            r = scene.nodes[i].radius * z;
          if (!onScreen(x, y, r)) continue;
          path.moveTo(x + r, y);
          path.arc(x, y, r, 0, Math.PI * 2);
          any = true;
        }
        if (any) {
          ctx.fillStyle = g.color;
          ctx.fill(path);
        }
      }
    };
    fillGroups(colorGroups);
    if (mainImg.complete && mainImg.naturalWidth) {
      const [x, y] = P(0),
        r = scene.nodes[0].radius * z;
      if (onScreen(x, y, r)) ctx.drawImage(mainImg, x - r, y - r, r * 2, r * 2);
    }
    const reveal = beltReveal();
    if (reveal > 0.005) {
      ctx.globalAlpha = reveal;
      fillGroups(beltGroups);
      ctx.globalAlpha = 1;
    }
    const disc = (i, a) => {
      const [x, y] = P(i),
        r = scene.nodes[i].radius * z;
      ctx.fillStyle = `rgba(${contrast},${a})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    };
    if (hovered != null)
      disc(hovered, 0.35 + 0.35 * Math.sin(now * C.hoverBlinkHz * 2 * Math.PI));
    if (pulses.length) {
      const flash = new Map();
      for (const p of pulses) {
        const age = elapsed - (p.start + p.duration);
        if (age < 0 || age > C.pulseArriveFlashSec) continue;
        const e = scene.edges[p.edge];
        const to = e.a === p.from ? e.b : e.a;
        const a = C.pulseArriveFlashPeak * (1 - age / C.pulseArriveFlashSec);
        if (a > (flash.get(to) || 0)) flash.set(to, a);
      }
      for (const [i, a] of flash) disc(i, a);
    }
    // hub labels, always shown (the box is small, so overview zoom is far below the app's LOD fade)
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    labelInk = currentLabel().join(",");
    ctx.fillStyle = `rgba(${labelInk},0.9)`;
    for (const nd of hubNodes) {
      const text = labels[nd.id];
      if (!text) continue;
      const [x, y0] = P(nd.id),
        y = y0 + nd.radius * z + 12;
      if (x < -100 || x > W + 100 || y < -30 || y > H + 30) continue;
      ctx.font = `500 ${nd.kind === "main" ? 13 : 11}px -apple-system, system-ui, sans-serif`;
      ctx.fillText(text, x, y);
    }
  }

  // ---------- page scroll ----------
  // Clicking or dragging in the graph slowly scrolls the page so the whole graph
  // (with its caption) sits centered in the window.
  let scrollAnim = 0;
  function revealGraph() {
    const fig = root.closest("figure") || root;
    const r = fig.getBoundingClientRect();
    const maxY = document.documentElement.scrollHeight - innerHeight;
    const target = Math.min(
      Math.max(
        r.height <= innerHeight
          ? scrollY + r.top - (innerHeight - r.height) / 2
          : scrollY + r.top - 16,
        0,
      ),
      maxY,
    );
    const from = scrollY;
    if (Math.abs(target - from) < 2) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      scrollTo(0, target);
      return;
    }
    const id = ++scrollAnim;
    const t0 = performance.now();
    const DURATION = 900;
    const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
    const step = (now) => {
      if (id !== scrollAnim) return;
      const u = Math.min((now - t0) / DURATION, 1);
      scrollTo(0, from + (target - from) * ease(u));
      if (u < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  // the visitor scrolling by hand takes over
  const stopScrollAnim = () => scrollAnim++;
  addEventListener("wheel", stopScrollAnim, { passive: true });
  addEventListener("touchmove", stopScrollAnim, { passive: true });
  addEventListener("keydown", stopScrollAnim);

  // ---------- gestures ----------
  let drag = null; // {mode:'pan'|'node', idx, sx, sy, moved, world, minDist, ballR}
  const pinch = new Map();
  let pinchDist = 0;
  const local = (ev) => {
    const b = canvas.getBoundingClientRect();
    return [ev.clientX - b.left, ev.clientY - b.top];
  };

  canvas.addEventListener("pointerdown", (ev) => {
    if (!started) return;
    canvas.setPointerCapture(ev.pointerId);
    pinch.set(ev.pointerId, local(ev));
    if (pinch.size === 2) {
      if (drag && drag.mode === "node") engine.endDrag();
      drag = null;
      const [a, b] = [...pinch.values()];
      pinchDist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      return;
    }
    const [sx, sy] = local(ev);
    // client coords for the tap threshold and panning, so the page scroll below
    // doesn't read as pointer movement
    drag = {
      mode: null,
      idx: hitTest(sx, sy),
      csx: ev.clientX,
      csy: ev.clientY,
      lcx: ev.clientX,
      lcy: ev.clientY,
      moved: false,
    };
    revealGraph();
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!started) return;
    const p = local(ev);
    if (pinch.has(ev.pointerId)) pinch.set(ev.pointerId, p);
    if (pinch.size === 2) {
      const [a, b] = [...pinch.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinchDist > 0) {
        camTask = null;
        zoomBy(d / pinchDist, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      }
      pinchDist = d;
      wake();
      return;
    }
    if (!drag) {
      hoverScreen = p;
      wake();
      return;
    }
    const [sx, sy] = p;
    if (
      !drag.moved &&
      Math.hypot(ev.clientX - drag.csx, ev.clientY - drag.csy) < 2
    )
      return;
    if (!drag.moved) {
      drag.moved = true;
      hovered = null;
      hoverScreen = null;
      camTask = null;
      if (drag.idx != null && drag.idx > 0) {
        drag.mode = "node";
        const nd = scene.nodes[drag.idx];
        drag.minDist = C.mainRadius + nd.radius + C.mainCollisionPadding;
        drag.ballR = nd.radius;
        const [wx, wy] = toWorld(sx, sy);
        engine.beginDrag(drag.idx, wx, wy);
      } else drag.mode = "pan";
    }
    if (drag.mode === "pan") {
      cam.cx -= (ev.clientX - drag.lcx) / cam.zoom;
      cam.cy -= (ev.clientY - drag.lcy) / cam.zoom;
    } else {
      let [wx, wy] = toWorld(sx, sy);
      for (const h of hubNodes) {
        if (h.id === 0 || h.id === drag.idx) continue;
        const cx = snap[2 * h.id],
          cy = snap[2 * h.id + 1];
        const minD = h.radius + drag.ballR + C.mainCollisionPadding;
        const dx = wx - cx,
          dy = wy - cy,
          dd = Math.hypot(dx, dy);
        if (dd < minD) {
          if (dd > 1) {
            wx = cx + (dx / dd) * minD;
            wy = cy + (dy / dd) * minD;
          } else {
            wx = cx + minD;
            wy = cy;
          }
        }
      }
      const r = Math.hypot(wx, wy);
      if (r < drag.minDist) {
        if (r > 1) {
          wx = (wx / r) * drag.minDist;
          wy = (wy / r) * drag.minDist;
        } else {
          wx = drag.minDist;
          wy = 0;
        }
      }
      drag.world = [wx, wy];
      engine.drag(wx, wy);
    }
    drag.lcx = ev.clientX;
    drag.lcy = ev.clientY;
    wake();
  });
  const endPointer = (ev) => {
    pinch.delete(ev.pointerId);
    if (pinch.size) return;
    pinchDist = 0;
    if (!drag) return;
    if (!drag.moved) onTap(drag.idx);
    else if (drag.mode === "node") {
      engine.endDrag();
      trackRing();
    }
    drag = null;
    wake();
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => {
    if (!drag) {
      hoverScreen = null;
      hovered = null;
      wake();
    }
  });
  // Trackpad pinch (ctrl+wheel) or Cmd+wheel zooms; a plain wheel keeps scrolling the page.
  canvas.addEventListener(
    "wheel",
    (ev) => {
      if (!started || !(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      camTask = null;
      const [sx, sy] = local(ev);
      zoomBy(Math.exp(-ev.deltaY * 0.01), sx, sy);
      wake();
    },
    { passive: false },
  );

  function onTap(id) {
    if (id == null) {
      const t = overview();
      if (t) animateCamera(t.cx, t.cy, t.zoom);
      return;
    }
    const nd = scene.nodes[id];
    if (isHub(id)) {
      if (nd.hubBubbleRadius != null) {
        const t = frameFor(
          snap[2 * id],
          snap[2 * id + 1],
          nd.hubBubbleRadius,
          C.cameraFolderFill,
        );
        if (t) animateCamera(t.cx, t.cy, t.zoom, () => triggerPulse(id));
        else triggerPulse(id);
      } else triggerPulse(id);
    } else {
      const hub = nd.hubIndex;
      const br = (hub >= 0 && scene.nodes[hub].hubBubbleRadius) || 160;
      const t = frameFor(
        snap[2 * id],
        snap[2 * id + 1],
        br,
        C.cameraFolderFill,
      );
      if (t) animateCamera(t.cx, t.cy, t.zoom);
    }
  }

  // ---------- loop ----------
  function wake() {
    if (running || !visible) return;
    running = true;
    lastT = performance.now();
    requestAnimationFrame(frame);
  }
  function frame(t) {
    const dt = Math.min((t - lastT) / 1000, 0.1);
    lastT = t;
    acc += dt;
    const linkTarget = hideLinks ? 0 : 1;
    if (linkAlpha !== linkTarget) {
      const d = dt / LINK_FADE_SEC;
      linkAlpha = linkTarget
        ? Math.min(1, linkAlpha + d)
        : Math.max(0, linkAlpha - d);
    }
    let steps = 0;
    while (acc >= 1 / C.physicsHz && steps < 4) {
      engine.step();
      acc -= 1 / C.physicsHz;
      steps++;
    }
    snap = readSnap();
    if (camTask && camTask()) camTask = null;
    // the dragged ball sits exactly under the pointer; push render-only overlaps out
    let pos = snap;
    if (drag && drag.mode === "node" && drag.world) {
      pos = Float64Array.from(snap);
      const di = drag.idx,
        [wx, wy] = drag.world;
      pos[2 * di] = wx;
      pos[2 * di + 1] = wy;
      const rd = scene.nodes[di].radius;
      for (let j = 1; j < scene.nodes.length; j++) {
        if (j === di) continue;
        const dx = pos[2 * j] - wx,
          dy = pos[2 * j + 1] - wy,
          d = Math.hypot(dx, dy);
        const minD = rd + scene.nodes[j].radius + 1;
        if (d < minD) {
          pos[2 * j] = wx + (d > 1 ? dx / d : 1) * minD;
          pos[2 * j + 1] = wy + (d > 1 ? dy / d : 0) * minD;
        }
      }
    }
    if (!drag && hoverScreen) hovered = hitTest(hoverScreen[0], hoverScreen[1]);
    canvas.style.cursor =
      hovered != null
        ? "pointer"
        : drag && drag.mode === "pan"
          ? "grabbing"
          : "grab";
    const now = performance.now() / 1000;
    if (
      pulses.length &&
      now - pulseStart > pulseEnd + C.pulseArriveFlashSec + 0.2
    )
      pulses = [];
    draw(pos, now);
    const busy =
      !parked() ||
      camTask ||
      linkAlpha !== (hideLinks ? 0 : 1) ||
      labelFading() ||
      pulses.length ||
      hovered != null ||
      drag ||
      pinch.size;
    if (busy && visible) requestAnimationFrame(frame);
    else running = false;
  }

  function resize() {
    const b = root.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = b.width;
    H = b.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (started) wake();
  }

  // Same order as the app: preload the ring, create the engine (born in the
  // pre-explosion state), put the camera on the preloaded ring, then follow the live ring.
  let preload = null,
    preloaded = null;
  let starting = false;
  function start() {
    if (starting) return;
    starting = true;
    preload.then((r) => {
      preloaded = r;
      engine = new window.GraphEngine(scene, { seed: SEED });
      started = true;
      snap = readSnap();
      const t = preloaded
        ? frameFor(preloaded.cx, preloaded.cy, preloaded.r)
        : overview();
      if (t) Object.assign(cam, t);
      trackRing(true);
      wake();
    });
  }

  fetch(root.dataset.scene)
    .then((r) => r.json())
    .then((data) => {
      scene = data;
      preload = window.GraphEngine.preloadRingAsync(scene, SEED, 8);
      hubNodes = scene.nodes.filter((n, i) => isHub(i));
      adjacency = scene.nodes.map(() => []);
      scene.edges.forEach((e, i) => {
        adjacency[e.a].push([i, e.b]);
        adjacency[e.b].push([i, e.a]);
      });
      const order = scene.nodes
        .map((_, i) => i)
        .sort((a, b) => scene.nodes[b].radius - scene.nodes[a].radius);
      const groups = new Map(),
        belts = new Map();
      for (const i of order) {
        const nd = scene.nodes[i],
          key = nd.color.join(",");
        const m = nd.beltTier != null ? belts : groups;
        if (!m.has(key)) m.set(key, { color: rgb(nd.color), nodes: [] });
        m.get(key).nodes.push(i);
      }
      colorGroups = [...groups.values()];
      beltGroups = [...belts.values()];
      resize();
      // bloom when the graph first scrolls into view
      new IntersectionObserver(
        (entries) => {
          visible = entries[0].isIntersecting;
          if (visible && !started) start();
          else if (visible) wake();
        },
        { threshold: 0.25 },
      ).observe(root);
    });
  addEventListener("resize", resize);
})();
