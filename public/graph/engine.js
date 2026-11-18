/*
 * My Portrait graph physics engine — browser port of
 * Sources/GraphPhysics/{GraphPhysicsEngine,GraphConstants,GraphModel}.swift.
 *
 * Plain script, no modules, no dependencies. Exposes:
 *   window.GraphEngine     (class)
 *   window.GraphConstants  (frozen object of tunables, identical values)
 *   window.BeltLayout      ({ homes(...) } pure function used by the scene builder)
 *
 * Model: d3-force semantics. Barnes-Hut quadtree repulsion + per-edge springs
 * + centering + alpha cooling, plus bubble / belt / family passes. Main ball
 * (index 0) is pinned at the origin.
 *
 * Coordinates: world units, main ball at (0,0). readSnapshot() returns a
 * Float32Array [x0, y0, x1, y1, ...] indexed by node index.
 *
 * Not 1:1 with Swift (by necessity):
 *  - Threads/locks (simLock, snapLock, dragLock, NSCondition) are gone; the
 *    engine is single-threaded. The physics thread's loop body is step():
 *    the renderer calls it once per 1/60 s. step() itself runs 0..N internal
 *    ticks exactly like the Swift loop (hot sub-step, reveal fast-forward,
 *    release-settle fast-forward), so one step() == one 60 Hz loop frame.
 *  - The physics thread's usleep/park wait is gone: when parked, step() does
 *    nothing and returns false; the renderer may stop requesting frames.
 *  - parkEvents (AsyncStream<Bool>) -> optional callback engine.onParkChange.
 *  - The shadow engine (Swift: background DispatchQueue running to completion)
 *    is a second GraphEngine (isShadow=true) advanced incrementally inside
 *    step() under a wall-clock budget (opts.shadowBudgetMs, default 8 ms).
 *    Cancellation by generation counter is immediate instead of every 16 ticks.
 *  - SplitMix64 + Float.random use the same algorithm family but layouts do
 *    not bit-match the Swift app for a given seed. Within JS everything is
 *    deterministic for a seed.
 *  - Math is in float64 (JS numbers) instead of Float32.
 *  - Swift uses node.id as the array index; here the array index is used.
 */
(function (global) {
  "use strict";

  // MARK: - GraphConstants (all tunables, identical values)

  const GraphConstants = Object.freeze({
    // edges
    edgeStyle: "line",
    lineEdgeWidth: 1.3,
    edgeEndWidthMax: 7,
    leafEdgeEndWidthMax: 7,
    waistRatio: 0.18,
    edgeEndWidth(ballRadius) {
      return Math.min(ballRadius, 7);
    },
    leafEdgeEndWidth(ballRadius) {
      return Math.min(ballRadius, 7);
    },

    // ball radii (world units)
    mainRadius: 44,
    categoryRadius: 22,
    folderRadiusBase: 10,
    folderRadiusScale: 1.4,
    folderRadiusMax: 28,
    eventRadiusBase: 0.2,
    eventRadiusScale: 2.4,
    eventRadiusMin: 1.5,
    eventRadiusMax: 14,
    portraitRadiusBase: 2.5,
    portraitRadiusScale: 0.69,

    // link strength
    categoryStrength: 20,
    folderStrengthBase: 5,
    eventStrengthMax: 15,
    portraitStrengthMax: 18,

    // bubbles
    bubbleFill: 0.26,
    bubblePadding: 4,
    bubbleGap: 12,
    bubbleCollideStrength: 0.5,
    bubbleEaseVelCap: 2,
    bubbleEasePosCap: 0.5,
    bubbleEaseDeepOverlap: 10,
    familyCarry: 0.9,
    bubbleRestFloor: 0.25,
    bubbleRestJitter: 0.12,

    // meteor belt
    beltWeightMax: 1.5,
    folderMinCoreEvents: 5,
    unclassifiedFolderMin: 3,
    unclassifiedHubMinFolders: 2,
    rootBubbleScale: 1.5,
    rootRestFloor: 0.1,
    beltTier1Max: 1.0,
    beltTier2Max: 0.5,
    beltGap: 10,
    ringCenterLerp: 0.1,
    ringPredMargin: 45,
    ringSlack: 35,
    beltMaxHalfArc: 3.0,
    beltRowGap: 1.3,
    beltEndTaper: 0.45,
    beltSpring: 0.06,

    // shadow engine
    shadowTickCap: 3000,

    // opening reveal
    beltGlideArcCap: 40,
    beltGlideRadialCap: 30,
    beltRevealStep: 0.02,
    beltRevealTimeoutTicks: 600,

    // camera framing (used by the renderer, kept here for parity)
    cameraFrameFill: 0.72,
    cameraFolderFill: 0.82,
    cameraTrackLerp: 0.08,
    cameraFocusFrames: 36,

    // physics
    manyBodyStrength: -15,
    mainBodyStrength: -4,
    leafBodyStrength: -2,
    familySpreadStrength: 0.2,
    hubAngularStrength: 0.08,
    hubAngularMaxHubs: 5,
    bhTheta2: 0.81,
    bhDistanceMin2: 1,
    alphaDecay: 0.0228,
    alphaMin: 0.001,
    portraitRotationDampingStartAlpha: 0.02,
    velocityDamping: 0.6,
    centerStrength: 0.05,
    dragAlphaTarget: 0.3,
    parkNetMove: 13,
    parkQuietWindow: 30,
    brakeDecay: 0.96,
    parkRestlessCap: 1800,
    physicsHz: 60,
    explosionRadius: 12,
    mainCollisionPadding: 4,
    hubSpringStrength: 1.0,
    collideStrength: 0.7,
    collidePadding: 1,
    collideIterations: 3,

    // interaction animation (renderer side, kept for parity)
    pulseSpeed: 225,
    pulseHubTravelSeconds: 1,
    pulseArriveFlashPeak: 0.85,
    pulseArriveFlashSec: 0.45,
    pulseMaxDepthMain: 2,
    pulseMaxDepthOther: 1,
    pulseTickCount: 3,
    pulseTickSpacing: 1,
    pulseTickLengthScale: 1,
    pulseTickStrokeWidth: 1.2,
    hoverBlinkHz: 2.2,
    labelFadeZoomHi: 0.9,
    labelFadeZoomLo: 0.6,

    // folder -> main link strength: self-weighted mean (Σw²/Σw) + base
    folderStrength(memberWeights) {
      let sum = 0,
        sq = 0;
      for (const w of memberWeights) {
        sum += w;
        sq += w * w;
      }
      if (!(sum > 0)) return 5;
      return sq / sum + 5;
    },
  });
  const C = GraphConstants;
  const PI = Math.PI;
  const TWO_PI = 2 * Math.PI;
  const FLOAT_ULP_OF_ONE = 1.1920929e-7; // Float.ulpOfOne
  const EMPTY = new Float64Array(0);

  // MARK: - BeltLayout (pure function shared with the scene builder)

  const BeltLayout = Object.freeze({
    /**
     * @param radii    belt ball radii (inner tier first, high weight first)
     * @param tiers    tier per ball (0 inner / 1 mid / 2 outer)
     * @param hashA    deterministic [0,1) hash per ball
     * @param hashB    second independent [0,1) hash per ball
     * @param bubbleR  own bubble radius
     * @param mainDist hub->main spring rest length
     * @param tierBases shared global tier bases, or null
     * @returns {{offsets:number[], angles:number[], tierStarts:number[]}}
     */
    homes(radii, tiers, hashA, hashB, bubbleR, mainDist, tierBases = null) {
      const n = radii.length;
      if (n === 0) return { offsets: [], angles: [], tierStarts: [0, 0, 0] };
      let rMax = -Infinity;
      for (const r of radii) rMax = Math.max(rMax, r);
      const slotW = 2 * (rMax + 1);
      const baseR = mainDist + bubbleR;
      const ownHalf = Math.asin(
        Math.min(0.95, bubbleR / Math.max(mainDist, bubbleR + 1)),
      );
      const arcCap = Math.min(C.beltMaxHalfArc, ownHalf * 3.4 + 0.2);
      const tierCount = [0, 0, 0];
      for (const t of tiers) tierCount[Math.min(Math.max(t, 0), 2)] += 1;
      const maxTC = Math.max(tierCount[0], tierCount[1], tierCount[2]);
      const famArc = Math.min(
        arcCap,
        (maxTC * slotW) / (2 * (baseR + C.beltGap) * 0.65),
      );
      const offsets = new Array(n).fill(0);
      const angles = new Array(n).fill(0);
      const tierStarts = [0, 0, 0];
      let cursor = C.beltGap;
      let placed = 0;
      for (let t = 0; t < 3; t++) {
        if (tierBases) cursor = Math.max(cursor, tierBases[t]);
        tierStarts[t] = cursor;
        const idxs = [];
        for (let i = 0; i < n; i++) if (tiers[i] === t) idxs.push(i);
        if (idxs.length === 0) continue;
        let k = 0;
        while (k < idxs.length) {
          const ringR = baseR + cursor;
          // end taper: inner rows wide, outer rows narrow
          const depth = placed / n;
          const rowArc = famArc * (1 - C.beltEndTaper * depth * depth);
          // each row filled to 50%
          const cap = Math.max(
            1,
            Math.trunc(((2 * rowArc * ringR) / slotW) * 0.5),
          );
          const rowCount = Math.min(cap, idxs.length - k);
          const slot = (2 * rowArc) / rowCount;
          const rowStart = k;
          for (let j = 0; j < rowCount; j++) {
            const g = idxs[k];
            // blur: radial ±1.1 row, angular ±1.2 slot (deterministic hashes)
            offsets[g] = cursor + (hashA[g] - 0.5) * slotW * 2.2;
            angles[g] =
              -rowArc + (j + 0.5) * slot + (hashB[g] - 0.5) * slot * 2.4;
            angles[g] = Math.max(-rowArc, Math.min(rowArc, angles[g]));
            k += 1;
            placed += 1;
          }
          // re-center each row on the ray, then scale back into rowArc
          let mean = 0;
          for (let x = rowStart; x < k; x++) mean += angles[idxs[x]];
          mean /= rowCount;
          let maxAbs = 0;
          for (let x = rowStart; x < k; x++) {
            const g = idxs[x];
            angles[g] -= mean;
            maxAbs = Math.max(maxAbs, Math.abs(angles[g]));
          }
          if (maxAbs > rowArc) {
            const scale = rowArc / maxAbs;
            for (let x = rowStart; x < k; x++) angles[idxs[x]] *= scale;
          }
          cursor += slotW * C.beltRowGap;
        }
      }
      return { offsets, angles, tierStarts };
    },
  });

  // MARK: - Deterministic RNG (SplitMix64)

  const M64 = (1n << 64n) - 1n;
  class SplitMix64 {
    constructor(seed) {
      this.state = BigInt.asUintN(64, BigInt(Math.floor(Number(seed) || 0)));
    }
    next() {
      this.state = (this.state + 0x9e3779b97f4a7c15n) & M64;
      let z = this.state;
      z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
      z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
      return z ^ (z >> 31n);
    }
    /** uniform float in [lo, hi) with 24-bit resolution (Float.random analogue) */
    float(lo, hi) {
      const u = Number(this.next() >> 40n) / 16777216;
      return lo + u * (hi - lo);
    }
  }

  const nowMs =
    typeof performance !== "undefined" && performance.now
      ? () => performance.now()
      : () => Date.now();

  function isHubKind(kind) {
    return kind === "main" || kind === "folder" || kind === "category";
  }
  const hyp = Math.hypot;
  function len(x, y) {
    return Math.sqrt(x * x + y * y);
  }

  // MARK: - GraphEngine

  class GraphEngine {
    /**
     * @param scene {zone, nodes:[...], edges:[...]} — see README of the port
     * @param opts  {seed=7, isShadow=false, shadowBudgetMs=8}
     */
    constructor(scene, opts = {}) {
      const seed = opts.seed === undefined ? 7 : opts.seed;
      this.isShadow = !!opts.isShadow;
      this.shadowBudgetMs =
        opts.shadowBudgetMs === undefined ? 8 : opts.shadowBudgetMs;
      /** optional callback(parked:boolean) — replaces Swift parkEvents stream */
      this.onParkChange = null;
      this.sceneRef = scene;
      this.n = scene.nodes.length;
      const n = this.n;
      const rng = new SplitMix64(seed);
      this.px = new Float64Array(n);
      this.py = new Float64Array(n);
      this._explosionPositions(rng);
      this.seedPhase = rng.float(0, TWO_PI);
      this.vx = new Float64Array(n);
      this.vy = new Float64Array(n);
      this._loadSceneArrays(scene);

      // --- sim state (Swift: simLock-protected) ---
      this.ringRad = 0;
      this.ringDirty = true;
      this.ringCx = 0;
      this.ringCy = 0;
      this.ringTargetRad = 0;
      this.ringTargetCx = 0;
      this.ringTargetCy = 0;
      this.beltForming = true;
      this.beltDragHome = EMPTY; // interleaved per belt ball
      this.wasDragging = false;
      this.hubPrev = EMPTY; // interleaved per hub slot
      this.beltTmpNow = EMPTY;
      this.beltTmpC = EMPTY;
      this.beltTmpS = EMPTY;
      this.beltTmpPol = EMPTY;
      this.beltPredSegs = []; // per hub slot: [[lo,hi], ...]
      this.beltPredDirty = true;
      this.beltRayCorrectedToActual = false;
      this.beltPredPos = EMPTY; // interleaved per hub slot
      this.hubQuietRef = EMPTY; // interleaved per hub slot
      this.hubStatic = [];
      this.hubQuietBase = 0;
      this.beltFamBase = [];
      this.beltFamSlope = [];
      this.beltFamSel = [];
      this.alpha = 1;
      this.alphaTarget = 0;
      this.quietRef = null; // Float64Array(2n) or null
      this.quietFlag = false;
      this.brake = 1;
      this.restlessTicks = 0;
      this.releaseSettleEpisode = false;
      this.releaseHubIndex = -1;
      this.settleTeamIdx = [];
      this.settleTeamPrev = EMPTY;
      this.beltPenMax = 0;
      this.beltTransitAny = false;
      this.famPrev = EMPTY;
      this.famDeltaX = EMPTY;
      this.famDeltaY = EMPTY;
      this.tickCount = 0;
      // drag (Swift: dragLock-protected)
      this.draggedIndex = null;
      this.draggedToX = 0;
      this.draggedToY = 0;
      this.dragPrevPos = null; // [x,y] or null
      this.dragNbr = [];
      this.pendingAlphaTarget = null;

      // --- shadow engine bookkeeping ---
      this.shadowGen = 0;
      this.shadowDone = false;
      this.shadowInFlight = false;
      this.shadowReady = false;
      this.shadowResult = EMPTY;
      this.shadowReadyClonePos = null;
      this.shadowClonePosPending = null;
      this._shadowJob = null; // replaces the DispatchQueue task
      this.beltLockTick = 0;
      this.dragSpawnPos = [Infinity, Infinity];
      this.lastShadowSpawnTick = 0;
      this.lastDragPos = [0, 0];
      this.dragMoveEma = -1;

      // --- opening reveal ---
      this.beltReveal = this.isShadow || this.beltIdx.length === 0 ? 1 : 0;
      this.beltRevealGo = false;
      this.beltRevealArm = 0;
      this.animationSpeedScale = 1;
      this.revealFFAccum = 0;

      // --- snapshot / loop control ---
      this._snap = new Float32Array(2 * n);
      this.beltRevealSnap = this.beltReveal;
      this.ringCenterSnapX = 0;
      this.ringCenterSnapY = 0;
      this.ringRadiusSnap = 0;
      this.shouldRun = true;
      this.parkedFlag = false;

      this._allocateTree();
      this._seedHubAngles(); // hubs first: leaf/belt birth reads hub positions
      this._seedLeafAngles();
      this._publishSnapshot();
    }

    // Per-node / per-hub arrays derived from the scene (Swift: the static helpers
    // chargeArray, centerScaleArray, familyIdArray, linkArrays, hubArrays,
    // leafArrays, familyArrays, beltArrays).
    _loadSceneArrays(scene) {
      const nodes = scene.nodes;
      const n = nodes.length;
      this.nodeRadius = new Float64Array(n);
      this.nodeCharge = new Float64Array(n);
      this.nodeCenterScale = new Float64Array(n);
      this.nodeFamily = new Int32Array(n);
      this.nodeBelt = new Uint8Array(n);
      this.nodeTransit = new Uint8Array(n);
      let maxR = 0;
      for (let i = 0; i < n; i++) {
        const nd = nodes[i];
        const r = nd.radius;
        this.nodeRadius[i] = r;
        if (r > maxR) maxR = r;
        // per-role charge: main small, hubs medium, leaves near zero
        switch (nd.kind) {
          case "main":
            this.nodeCharge[i] = C.mainBodyStrength;
            break;
          case "folder":
          case "category":
            this.nodeCharge[i] = C.manyBodyStrength;
            break;
          default:
            this.nodeCharge[i] = C.leafBodyStrength;
            break;
        }
        const hub = isHubKind(nd.kind);
        // centering only for non-main hubs
        this.nodeCenterScale[i] = hub && i !== 0 ? 1 : 0;
        // family id: leaf = own hub index, hubs/main = -1
        this.nodeFamily[i] = hub ? -1 : Math.max(nd.hubIndex, 0);
        this.nodeBelt[i] =
          nd.beltTier !== null && nd.beltTier !== undefined ? 1 : 0;
      }
      this.maxNodeRadius = n > 0 ? maxR : 0;

      // linkArrays: d3 default stiffness 1/min(degree), override via springStrength
      const edges = scene.edges;
      const e = edges.length;
      const degree = new Int32Array(n);
      for (const ed of edges) {
        degree[ed.a] += 1;
        degree[ed.b] += 1;
      }
      this.edgesA = new Int32Array(e);
      this.edgesB = new Int32Array(e);
      this.linkStrength = new Float64Array(e);
      this.linkBias = new Float64Array(e);
      this.linkRest = new Float64Array(e);
      for (let i = 0; i < e; i++) {
        const ed = edges[i];
        this.edgesA[i] = ed.a;
        this.edgesB[i] = ed.b;
        const da = degree[ed.a],
          db = degree[ed.b];
        this.linkStrength[i] =
          ed.springStrength !== null && ed.springStrength !== undefined
            ? ed.springStrength
            : 1 / Math.min(Math.max(da, 1), Math.max(db, 1));
        this.linkBias[i] = da / (da + db);
        this.linkRest[i] = ed.restLength;
      }

      // hubArrays: bubble radius / mass (leaf count + 1) / clearance from main
      const main = nodes[0];
      const mainBub =
        main && main.hubBubbleRadius != null ? main.hubBubbleRadius : 0;
      const mainR = main ? main.radius : 0;
      this.mainEnclosureR = Math.max(mainBub, mainR);
      const leafCount = new Map(),
        maxLeafR = new Map();
      for (let i = 0; i < n; i++) {
        const nd = nodes[i];
        if (isHubKind(nd.kind)) continue;
        leafCount.set(nd.hubIndex, (leafCount.get(nd.hubIndex) || 0) + 1);
        maxLeafR.set(
          nd.hubIndex,
          Math.max(maxLeafR.get(nd.hubIndex) || 0, nd.radius),
        );
      }
      const rootExtra = Math.max(mainBub - mainR, 0);
      const hubIdx = [],
        bubble = [],
        mass = [],
        clear = [];
      const slotOf = new Map();
      for (let i = 0; i < n; i++) {
        const nd = nodes[i];
        if (!isHubKind(nd.kind) || i === 0) continue;
        slotOf.set(i, hubIdx.length);
        hubIdx.push(i);
        bubble.push(nd.hubBubbleRadius != null ? nd.hubBubbleRadius : -1);
        mass.push((leafCount.get(i) || 0) + 1);
        clear.push((maxLeafR.get(i) || 0) + C.mainCollisionPadding + rootExtra);
      }
      this.hubIndices = Int32Array.from(hubIdx);
      this.hubBubbleR = Float64Array.from(bubble);
      this.hubMass = Float64Array.from(mass);
      this.hubMainClear = Float64Array.from(clear);

      // leafArrays: all non-belt leaves, own hub, in-bubble hard limit
      const li = [],
        lh = [],
        lm = [];
      for (let i = 0; i < n; i++) {
        const nd = nodes[i];
        if (isHubKind(nd.kind) || this.nodeBelt[i]) continue;
        li.push(i);
        const hub = Math.max(nd.hubIndex, 0);
        lh.push(hub);
        const br = nodes[hub].hubBubbleRadius;
        lm.push(br != null ? br - nd.radius - 1 : -1);
      }
      this.leafIndices = Int32Array.from(li);
      this.leafOwnHub = Int32Array.from(lh);
      this.leafMaxDist = Float64Array.from(lm);

      // familyArrays: per-hub leaves sorted by rest length, split into 1..5 radial bands
      const restOf = new Map();
      for (const ed of edges)
        if (!isHubKind(nodes[ed.a].kind)) restOf.set(ed.a, ed.restLength);
      const byHub = new Map();
      for (let i = 0; i < n; i++) {
        const nd = nodes[i];
        if (isHubKind(nd.kind) || !(nd.hubIndex >= 0) || this.nodeBelt[i])
          continue;
        if (!byHub.has(nd.hubIndex)) byHub.set(nd.hubIndex, []);
        byHub.get(nd.hubIndex).push(i);
      }
      const famLeaf = [],
        famRange = [];
      const hubKeys = [...byHub.keys()].sort((a, b) => a - b);
      for (const hub of hubKeys) {
        const leaves = byHub.get(hub);
        if (leaves.length < 3) continue;
        const sorted = leaves.slice().sort((a, b) => {
          const ra = restOf.has(a) ? restOf.get(a) : 0,
            rb = restOf.has(b) ? restOf.get(b) : 0;
          return ra !== rb ? ra - rb : a - b;
        });
        const bands = Math.max(1, Math.min(Math.trunc(sorted.length / 16), 5));
        const per = Math.trunc(sorted.length / bands);
        let i = 0;
        for (let b = 0; b < bands; b++) {
          const hi = b === bands - 1 ? sorted.length : (b + 1) * per;
          if (hi - i >= 3) {
            const lo = famLeaf.length;
            for (let x = i; x < hi; x++) famLeaf.push(sorted[x]);
            famRange.push({ hub, lo, hi: famLeaf.length });
          }
          i = hi;
        }
      }
      this.familyLeaf = Int32Array.from(famLeaf);
      this.familyRange = famRange;

      // beltArrays: node / own hub / radial offset / slot angle / hub slot; famW, famReach
      const ns = hubIdx.length;
      const bi = [],
        bh = [],
        br = [],
        ba = [],
        bs = [];
      const famW = new Float64Array(ns).fill(0.2);
      const famReach = new Float64Array(ns);
      for (let i = 0; i < n; i++) {
        if (!this.nodeBelt[i]) continue;
        const nd = nodes[i];
        const hub = Math.max(nd.hubIndex, 0);
        bi.push(i);
        bh.push(hub);
        const sl = slotOf.has(hub) ? slotOf.get(hub) : 0;
        bs.push(sl);
        const off = nd.beltRadialOffset || 0;
        const ang = nd.beltAngle || 0;
        br.push(off);
        ba.push(ang);
        if (sl < ns) {
          famW[sl] = Math.max(famW[sl], Math.abs(ang));
          famReach[sl] = Math.max(famReach[sl], off);
        }
      }
      this.beltIdx = Int32Array.from(bi);
      this.beltHub = Int32Array.from(bh);
      this.beltRing = Float64Array.from(br);
      this.beltAng = Float64Array.from(ba);
      this.beltHubSlot = Int32Array.from(bs);
      this.beltFamW = famW;
      this.beltFamReach = famReach;
    }

    // MARK: - Public API

    /** Positions of the last published frame: new Float32Array [x0,y0,x1,y1,...] (world units). */
    readSnapshot() {
      return this._snap.slice();
    }

    /** Ring of the last published frame. r = 0 when there is no belt / not yet pinned. */
    readRingSnapshot() {
      return {
        cx: this.ringCenterSnapX,
        cy: this.ringCenterSnapY,
        r: this.ringRadiusSnap,
      };
    }

    /** Belt (meteor) opacity multiplier 0..1 of the last published frame. <1 = hidden/fading in; belts are not hittable then. */
    readBeltReveal() {
      return this.beltRevealSnap;
    }
    get beltRevealAlpha() {
      return this.beltRevealSnap;
    }

    /** true when the sim is asleep; step() is a no-op until an interaction. */
    isParked() {
      return this.parkedFlag;
    }

    /** Animation speed multiplier, clamped to [0.65, 2.5]. Takes effect next tick. */
    setAnimationSpeedScale(s) {
      this.animationSpeedScale = Math.max(0.65, Math.min(2.5, s));
    }

    /** Start dragging node `index` (the caller blocks index 0, like the Swift renderer). */
    beginDrag(index, x, y) {
      this.draggedIndex = index;
      this.draggedToX = x;
      this.draggedToY = y;
      this.pendingAlphaTarget = C.dragAlphaTarget;
      this.releaseHubIndex = index;
      this.wake();
    }

    drag(x, y) {
      this.draggedToX = x;
      this.draggedToY = y;
    }

    endDrag() {
      this.draggedIndex = null;
      this.pendingAlphaTarget = 0;
      this.wake();
    }

    /**
     * Swift wake() signals the physics thread. Single-threaded here: the next
     * step() re-evaluates parking on its own, so this only exists for API
     * parity. The renderer must resume calling step() after any interaction.
     */
    wake() {}

    /** Stop the engine (Swift shutdown()). step() becomes a no-op; any shadow job is dropped. */
    shutdown() {
      this.shouldRun = false;
      this.shadowGen += 1;
      this._shadowJob = null;
      this.shadowInFlight = false;
    }

    /** Re-explode (refresh with changed data / switch back to a canvas). */
    explode(seed = 7) {
      const rng = new SplitMix64(seed);
      this._explosionPositions(rng);
      this.seedPhase = rng.float(0, TWO_PI);
      this.vx.fill(0);
      this.vy.fill(0);
      this._seedHubAngles();
      this._seedLeafAngles();
      // back to forming state; shadow rebuilt; ring recomputed
      this.beltForming = true;
      this.beltPredDirty = true;
      this.beltRayCorrectedToActual = false;
      this.ringDirty = true;
      this.releaseSettleEpisode = false; // exit 3
      this.ringRad = 0;
      this.ringCx = 0;
      this.ringCy = 0;
      this.ringTargetRad = 0;
      this.ringTargetCx = 0;
      this.ringTargetCy = 0;
      this.shadowGen += 1; // discard running shadow
      this.nodeTransit.fill(0);
      this.hubPrev = EMPTY;
      this.hubQuietRef = EMPTY;
      this.famPrev = EMPTY;
      this.alpha = 1;
      // arm the opening reveal
      this.beltReveal = this.beltIdx.length === 0 ? 1 : 0;
      this.beltRevealGo = false;
      this.beltRevealArm = this.tickCount;
      this.revealFFAccum = 0;
      this._publishSnapshot();
      this.wake();
    }

    /** Light data refresh: same node set, new edge params. Keeps positions. */
    updateScene(scene) {
      if (scene.nodes.length !== this.n) return;
      this.sceneRef = scene;
      this._loadSceneArrays(scene);
      this.beltPredDirty = true;
      this.beltRayCorrectedToActual = false;
      this.shadowGen += 1;
      this.ringDirty = true;
      this.hubPrev = EMPTY;
      this.hubQuietRef = EMPTY;
      this.famPrev = EMPTY;
      this.alpha = Math.max(this.alpha, 0.1);
      this.wake();
    }

    /**
     * Timeline scene switch with a variable node set. carryOver[newIndex] = old
     * index, or -1 for a newborn node (born at its hub).
     */
    updateSceneRemapping(scene, carryOver) {
      if (carryOver.length !== scene.nodes.length) return;
      const oldN = this.n;
      const m = scene.nodes.length;
      const npx = new Float64Array(m),
        npy = new Float64Array(m);
      const nvx = new Float64Array(m),
        nvy = new Float64Array(m);
      const filled = new Uint8Array(m);
      // 1. survivors keep position and velocity
      for (let i = 0; i < m; i++) {
        const o = carryOver[i];
        if (o >= 0 && o < oldN) {
          npx[i] = this.px[o];
          npy[i] = this.py[o];
          nvx[i] = this.vx[o];
          nvy[i] = this.vy[o];
          filled[i] = 1;
        }
      }
      // 2. newborns at their hub (+ deterministic golden-angle jitter)
      for (let i = 0; i < m; i++) {
        if (filled[i]) continue;
        const h = scene.nodes[i].hubIndex;
        let bx = 0,
          by = 0;
        if (h >= 0 && h < m && filled[h]) {
          bx = npx[h];
          by = npy[h];
        } else if (m > 0 && filled[0]) {
          bx = npx[0];
          by = npy[0];
        }
        const a = i * 2.399963;
        npx[i] = bx + Math.cos(a) * 2;
        npy[i] = by + Math.sin(a) * 2;
      }
      this.n = m;
      this.px = npx;
      this.py = npy;
      this.vx = nvx;
      this.vy = nvy;
      this._allocateTree();
      this.sceneRef = scene;
      this._loadSceneArrays(scene);
      this._snap = new Float32Array(2 * m);
      this.beltDragHome = EMPTY;
      this.settleTeamIdx = [];
      this.settleTeamPrev = EMPTY;
      this.releaseSettleEpisode = false;
      this.beltPredDirty = true;
      this.beltRayCorrectedToActual = false;
      this.shadowGen += 1;
      this.ringDirty = true;
      this.hubPrev = EMPTY;
      this.hubQuietRef = EMPTY;
      this.famPrev = EMPTY;
      this.alpha = Math.max(this.alpha, 0.1);
      this._publishSnapshot();
      this.wake();
    }

    // MARK: - Physics loop body (Swift loop(), one iteration)

    /**
     * One iteration of the 60 Hz physics loop. Call once per 1/60 s.
     * Returns true when it ran ticks, false when parked (or shut down).
     */
    step() {
      if (!this.shouldRun) return false;
      // Background shadow task substitute: advance it under a time budget.
      this._pumpShadow();

      const pending = this.pendingAlphaTarget;
      this.pendingAlphaTarget = null;
      const dragging = this.draggedIndex !== null;
      if (pending !== null) {
        this.alphaTarget = pending;
        if (pending > 0 && this.alpha < pending) this.alpha = pending;
      }
      // first drag ends the forming state; drag-start edge snapshots belt homes
      if (dragging) {
        this.beltForming = false;
        if (!this.wasDragging) {
          const nb = this.beltIdx.length;
          const home = new Float64Array(2 * nb);
          for (let b = 0; b < nb; b++) {
            const i = this.beltIdx[b];
            home[2 * b] = this.px[i];
            home[2 * b + 1] = this.py[i];
          }
          this.beltDragHome = home;
          this.dragMoveEma = -1;
        }
        this.releaseSettleEpisode = false; // exit 2
      } else if (this.wasDragging) {
        // release edge: the only place the settle episode is armed
        this.releaseSettleEpisode = true;
        this.beltRayCorrectedToActual = false;
        this._buildSettleTeam();
        // warm-up hit test: precomputed shadow for a release near here (<60pt) and still
        const releaseIsStill = this.dragMoveEma >= 0 && this.dragMoveEma < 1.5;
        const ldx = this.lastDragPos[0],
          ldy = this.lastDragPos[1];
        const near = (p) => p !== null && hyp(p[0] - ldx, p[1] - ldy) < 60;
        const readyHit =
          releaseIsStill && this.shadowReady && near(this.shadowReadyClonePos);
        const pendingHit =
          releaseIsStill &&
          !readyHit &&
          this.shadowInFlight &&
          near(this.shadowClonePosPending);
        if (pendingHit) {
          this.shadowReady = false;
          this.shadowReadyClonePos = null;
        } else if (readyHit && this.shadowInFlight) {
          this.shadowGen += 1;
        }
        if (!readyHit && !pendingHit) this.beltPredDirty = true;
        this.shadowClonePosPending = null;
        // static/moving refresh: hubs shoved >12pt during the drag become "moving"
        const nh = this.hubIndices.length;
        if (this.hubQuietRef.length === 2 * nh) {
          for (let s = 0; s < nh; s++) {
            const h = this.hubIndices[s];
            const x = this.px[h],
              y = this.py[h];
            if (
              hyp(
                x - this.hubQuietRef[2 * s],
                y - this.hubQuietRef[2 * s + 1],
              ) > 12
            ) {
              this.hubStatic[s] = false;
            }
            this.hubQuietRef[2 * s] = x;
            this.hubQuietRef[2 * s + 1] = y;
          }
          this.hubQuietBase = this.tickCount;
        }
      }
      this.wasDragging = dragging;
      // park = cold && truly still (brake slid to 0) && reveal done
      const coldNow = this.alpha < C.alphaMin && this.alphaTarget === 0;
      const quiet = this.brake === 0;
      if (coldNow && !quiet) this.restlessTicks += 1;
      else this.restlessTicks = 0;
      const cooled =
        coldNow &&
        (quiet || this.restlessTicks > C.parkRestlessCap) &&
        this.beltReveal >= 1;
      const sleeping = cooled && !dragging;
      const stateChanged = this.parkedFlag !== sleeping;
      this.parkedFlag = sleeping;
      if (stateChanged && typeof this.onParkChange === "function")
        this.onParkChange(sleeping);
      if (sleeping) return false;

      // cold-tail settle fast-forward: snapshot the dragged team first
      const settleFF =
        !dragging &&
        this.releaseSettleEpisode &&
        this.alpha <= 0.02 &&
        this.shadowDone;
      if (
        settleFF &&
        this.settleTeamPrev.length === 2 * this.settleTeamIdx.length
      ) {
        for (let j = 0; j < this.settleTeamIdx.length; j++) {
          const i = this.settleTeamIdx[j];
          this.settleTeamPrev[2 * j] = this.px[i];
          this.settleTeamPrev[2 * j + 1] = this.py[i];
        }
      }
      // hot sub-step: 2 ticks per frame while alpha > 0.02 (not while dragging)
      const baseTicks = !dragging && this.alpha > 0.02 ? 2 : 1;
      // opening hidden phase: scale ticks per frame by animationSpeedScale
      const revealFF =
        !dragging &&
        !this.isShadow &&
        this.beltReveal < 1 &&
        !this.beltRevealGo;
      let runTicks = baseTicks;
      if (revealFF) {
        this.revealFFAccum += baseTicks * this.animationSpeedScale;
        runTicks = Math.trunc(this.revealFFAccum);
        this.revealFFAccum -= runTicks;
      }
      for (let t = 0; t < runTicks; t++) this._tick();
      if (this.quietFlag && this.shadowDone) {
        this.releaseSettleEpisode = false; // exit 1
      } else if (settleFF) {
        let resid = 0;
        for (let j = 0; j < this.settleTeamIdx.length; j++) {
          const i = this.settleTeamIdx[j];
          const d = hyp(
            this.px[i] - this.settleTeamPrev[2 * j],
            this.py[i] - this.settleTeamPrev[2 * j + 1],
          );
          if (d > resid) resid = d;
        }
        const extra = GraphEngine._extraSettleTicks(resid);
        for (let t = 0; t < extra; t++) this._tick();
      }
      if (this.restlessTicks > C.parkRestlessCap)
        this.releaseSettleEpisode = false; // exit 4
      this._publishSnapshot();
      return true;
    }

    _publishSnapshot() {
      const s = this._snap,
        px = this.px,
        py = this.py;
      for (let i = 0; i < this.n; i++) {
        s[2 * i] = px[i];
        s[2 * i + 1] = py[i];
      }
      this.beltRevealSnap = this.beltReveal;
      this.ringCenterSnapX = this.ringCx;
      this.ringCenterSnapY = this.ringCy;
      this.ringRadiusSnap = this.ringRad;
    }

    // Release edge: lock the dragged team (hub + its core leaves + all belts).
    _buildSettleTeam() {
      const team = [];
      if (this.releaseHubIndex < 0) {
        this.settleTeamIdx = team;
        this.settleTeamPrev = EMPTY;
        return;
      }
      team.push(this.releaseHubIndex);
      for (let li = 0; li < this.leafIndices.length; li++) {
        if (this.leafOwnHub[li] === this.releaseHubIndex)
          team.push(this.leafIndices[li]);
      }
      for (let b = 0; b < this.beltIdx.length; b++) team.push(this.beltIdx[b]);
      this.settleTeamIdx = team;
      const prev = new Float64Array(2 * team.length);
      for (let j = 0; j < team.length; j++) {
        prev[2 * j] = this.px[team[j]];
        prev[2 * j + 1] = this.py[team[j]];
      }
      this.settleTeamPrev = prev;
    }

    // Extra fast-forward ticks from the team's residual speed (0..4).
    static _extraSettleTicks(r) {
      const k = Math.trunc((r - 0.3) / 0.3);
      return Math.max(0, Math.min(4, k));
    }

    // MARK: - One tick

    _tick() {
      if (this.n <= 0) {
        this.alpha = 0;
        return;
      }
      this.tickCount += 1;
      // drag load shedding: heavy passes every other tick while dragging
      const heavy = this.alphaTarget === 0 || this.tickCount % 2 === 0;
      if (heavy) {
        this._buildTree();
        this._manyBodyPass();
      }
      this._linkPass();
      this._beltPass();
      this._bubblePass();
      if (heavy) this._familySpreadPass();
      if (heavy) this._hubAngularPass();
      // collide every tick (light ticks reuse the previous tree)
      this._collidePass();
      this._dampPortraitFamilyRotation();
      this._centerAndIntegrate();
      this.alpha += (this.alphaTarget - this.alpha) * C.alphaDecay;
      // net-displacement window for the quiet test
      const n = this.n,
        px = this.px,
        py = this.py;
      if (this.tickCount % C.parkQuietWindow === 0) {
        if (this.quietRef && this.quietRef.length === 2 * n) {
          const q = this.quietRef;
          let m2 = 0;
          const t2 = C.parkNetMove * C.parkNetMove;
          for (let i = 1; i < n; i++) {
            const dx = px[i] - q[2 * i],
              dy = py[i] - q[2 * i + 1];
            m2 = Math.max(m2, dx * dx + dy * dy);
            if (m2 >= t2) break;
          }
          this.quietFlag =
            m2 < t2 && this.beltPenMax < 1.5 && !this.beltTransitAny;
        } else {
          this.quietFlag = false;
        }
        const q =
          this.quietRef && this.quietRef.length === 2 * n
            ? this.quietRef
            : new Float64Array(2 * n);
        for (let i = 0; i < n; i++) {
          q[2 * i] = px[i];
          q[2 * i + 1] = py[i];
        }
        this.quietRef = q;
      }
      // brake: cold + quiet -> displacement decays to 0
      if (this.alpha < C.alphaMin && this.alphaTarget === 0 && this.quietFlag) {
        this.brake *= C.brakeDecay;
        if (this.brake < 0.02) this.brake = 0;
      } else {
        this.brake = 1;
      }
    }

    // MARK: - Hub angular spread (only when hub count <= hubAngularMaxHubs)

    _hubAngularPass() {
      const count = this.hubIndices.length;
      if (count < 2 || count > C.hubAngularMaxHubs) return;
      const k = C.hubAngularStrength;
      const items = [];
      for (let s = 0; s < count; s++) {
        const h = this.hubIndices[s];
        items.push({ t: Math.atan2(this.py[h], this.px[h]), hub: h });
      }
      items.sort((a, b) => a.t - b.t);
      for (let i = 0; i < count; i++) {
        const tL = items[(i + count - 1) % count].t;
        const tC = items[i].t;
        const tR = items[(i + 1) % count].t;
        let gapL = tC - tL;
        if (gapL < 0) gapL += TWO_PI;
        let gapR = tR - tC;
        if (gapR < 0) gapR += TWO_PI;
        const delta = (gapR - gapL) * 0.5;
        const hub = items[i].hub;
        const x = this.px[hub],
          y = this.py[hub];
        const r = len(x, y);
        if (!(r > 1)) continue;
        const tx = -y / r,
          ty = x / r;
        const push = Math.max(Math.min(delta, 0.1), -0.1);
        this.vx[hub] += tx * (push * r * k);
        this.vy[hub] += ty * (push * r * k);
      }
    }

    // MARK: - Seeding

    // Hub birth angles: equal-angle ring around the main ball.
    _seedHubAngles() {
      const nh = this.hubIndices.length;
      if (nh < 2) return;
      const r = C.explosionRadius;
      for (let k = 0; k < nh; k++) {
        const a = this.seedPhase + (TWO_PI * k) / nh;
        const h = this.hubIndices[k];
        this.px[h] = Math.cos(a) * r;
        this.py[h] = Math.sin(a) * r;
      }
    }

    // Leaf birth angles: golden angle around own hub; belts along their slot ray.
    _seedLeafAngles() {
      if (this.leafIndices.length === 0) return;
      const golden = 2.39996323;
      const counter = new Map();
      const px = this.px,
        py = this.py;
      for (let li = 0; li < this.leafIndices.length; li++) {
        const hub = this.leafOwnHub[li];
        const j = counter.get(hub) || 0;
        counter.set(hub, j + 1);
        const leaf = this.leafIndices[li];
        const a = golden * j + hub * 0.7 + this.seedPhase;
        const maxD = this.leafMaxDist[li];
        const r =
          maxD > 0
            ? Math.max(maxD * 0.1, this.nodeRadius[hub] + 3)
            : this.nodeRadius[hub] + 8;
        px[leaf] = px[hub] + Math.cos(a) * r;
        py[leaf] = py[hub] + Math.sin(a) * r;
      }
      for (let b = 0; b < this.beltIdx.length; b++) {
        const hub = this.beltHub[b];
        const hx = px[hub],
          hy = py[hub];
        const a = Math.atan2(hy, hx) + this.beltAng[b];
        const bubR = this.hubBubbleR[this.beltHubSlot[b]];
        const bub = Math.max(bubR === undefined ? 0 : bubR, 0);
        const r = Math.max(
          this.nodeRadius[hub] + 3,
          (bub + this.beltRing[b]) * 0.4,
        );
        const i = this.beltIdx[b];
        px[i] = hx + Math.cos(a) * r;
        py[i] = hy + Math.sin(a) * r;
      }
    }

    // MARK: - Belt pass (meteor ring: reveal, drag homes, shadow, ring, carve, slot springs)

    _beltPass() {
      const nb = this.beltIdx.length;
      if (nb === 0) return;
      // opening reveal progression (top: no early exit may block it)
      if (this.beltReveal < 1 && !this.isShadow) {
        if (this.beltRevealGo) {
          this.beltReveal = Math.min(
            this.beltReveal + C.beltRevealStep * this.animationSpeedScale,
            1,
          );
        } else if (
          this.tickCount - this.beltRevealArm >
          C.beltRevealTimeoutTicks
        ) {
          this.beltRevealGo = true;
        }
      }
      const px = this.px,
        py = this.py,
        vx = this.vx,
        vy = this.vy;
      const di = this.draggedIndex === null ? -1 : this.draggedIndex;
      // (2) dragging: spring back to the drag-start snapshot; warm-up shadow for hubs
      if (di >= 0) {
        this.hubPrev = EMPTY;
        if (this.dragMoveEma < 0) {
          this.dragMoveEma = 0;
        } else {
          this.dragMoveEma =
            this.dragMoveEma * 0.6 +
            hyp(px[di] - this.lastDragPos[0], py[di] - this.lastDragPos[1]) *
              0.4;
        }
        this.lastDragPos = [px[di], py[di]];
        if (
          di !== 0 &&
          this.nodeFamily[di] < 0 &&
          hyp(px[di] - this.dragSpawnPos[0], py[di] - this.dragSpawnPos[1]) >
            30 &&
          this.tickCount - this.lastShadowSpawnTick >= 10
        ) {
          if (this._spawnShadow(di)) {
            this.dragSpawnPos = [px[di], py[di]];
            this.lastShadowSpawnTick = this.tickCount;
          }
        }
        if (this.beltDragHome.length !== 2 * nb) return;
        const k = C.beltSpring * Math.max(this.alpha, 0.1);
        const home = this.beltDragHome;
        for (let b = 0; b < nb; b++) {
          const i = this.beltIdx[b];
          if (i === di) continue;
          const dx = home[2 * b] - px[i] - vx[i];
          const dy = home[2 * b + 1] - py[i] - vy[i];
          const dLen = len(dx, dy);
          const boost = Math.min(1 + dLen / 150, 3);
          vx[i] += dx * (k * boost);
          vy[i] += dy * (k * boost);
          this.nodeTransit[i] = dLen > 24 ? 1 : 0;
        }
        return;
      }
      // (1)(3) slot machine. Floor 0.35 (not 0.1) so belts keep up with turning hubs.
      let k = C.beltSpring * Math.max(this.alpha, 0.35);
      if (!this.beltForming && this.tickCount - this.beltLockTick < 45)
        k *= 2.5; // take-off window
      const hubIdx = this.hubIndices;
      const nh = hubIdx.length;
      if (this.hubPrev.length !== 2 * nh) {
        const hp = new Float64Array(2 * nh);
        for (let s = 0; s < nh; s++) {
          hp[2 * s] = px[hubIdx[s]];
          hp[2 * s + 1] = py[hubIdx[s]];
        }
        this.hubPrev = hp;
        this.beltTmpNow = hp.slice();
        this.beltTmpC = new Float64Array(nh).fill(1);
        this.beltTmpS = new Float64Array(nh);
        this.beltTmpPol = new Float64Array(nh);
        return;
      }
      const now = this.beltTmpNow;
      for (let s = 0; s < nh; s++) {
        now[2 * s] = px[hubIdx[s]];
        now[2 * s + 1] = py[hubIdx[s]];
      }
      // static/moving judgement per hub (0.5 s window, hysteresis 6/12 pt)
      if (this.hubQuietRef.length !== 2 * nh) {
        this.hubQuietRef = now.slice();
        this.hubStatic = new Array(nh).fill(false);
        this.hubQuietBase = this.tickCount;
      } else if (this.tickCount - this.hubQuietBase >= 30) {
        const q = this.hubQuietRef;
        for (let s = 0; s < nh; s++) {
          const m = hyp(now[2 * s] - q[2 * s], now[2 * s + 1] - q[2 * s + 1]);
          if (this.hubStatic[s]) {
            if (m > 12) this.hubStatic[s] = false;
          } else if (m < 6) this.hubStatic[s] = true;
          q[2 * s] = now[2 * s];
          q[2 * s + 1] = now[2 * s + 1];
        }
        this.hubQuietBase = this.tickCount;
      }
      // the shadow itself only needs hub end positions: stop here
      if (this.isShadow) return;
      // shadow: spawn when dirty; consume a ready result once (pin ring on opening)
      if (this.beltPredDirty || this.beltPredPos.length !== 2 * nh) {
        if (this._spawnShadow(-1)) this.beltPredDirty = false;
      } else if (!this.shadowDone) {
        const ok = this.shadowReady;
        const res = this.shadowResult;
        if (ok) {
          this.shadowReady = false;
          this.shadowReadyClonePos = null;
        }
        if (ok && res.length === 2 * nh) {
          this.beltPredPos = res;
          const enc = this._enclosureCircles(res);
          if (this.ringDirty) {
            // opening: pin for good (hidden behind the explosion)
            const mec = GraphEngine.minEnclosingCircle(enc.cx, enc.cy, enc.r);
            this.ringRad = mec.r + C.beltGap + C.ringPredMargin;
            this.ringTargetRad = this.ringRad;
            this.ringCx = mec.x;
            this.ringCy = mec.y;
            this.ringTargetCx = mec.x;
            this.ringTargetCy = mec.y;
            this.ringDirty = false;
          } else if (!this._ringCovered(enc)) {
            // release: adjust once to the shadow's end state
            const mec = GraphEngine.minEnclosingCircle(enc.cx, enc.cy, enc.r);
            this.ringTargetCx = mec.x;
            this.ringTargetCy = mec.y;
            this.ringTargetRad = mec.r + C.beltGap + C.ringPredMargin;
          }
          this.shadowDone = true;
          this.quietFlag = false;
          this.beltLockTick = this.tickCount;
        }
      }
      // ring supervision (dead zone): only when the layout is static or cold
      let allStatic = this.hubStatic.length === nh;
      if (allStatic)
        for (let s = 0; s < nh; s++)
          if (!this.hubStatic[s]) {
            allStatic = false;
            break;
          }
      // first stable window after release: correct the ray end points to real positions once
      if (
        !this.beltForming &&
        this.shadowDone &&
        allStatic &&
        !this.beltRayCorrectedToActual
      ) {
        this.beltPredPos = now.slice();
        this.beltRayCorrectedToActual = true;
        this.quietFlag = false;
      }
      if (allStatic || this.alpha < C.alphaMin) {
        const enc = this._enclosureCircles(now);
        if (!this._ringCovered(enc)) {
          const mec = GraphEngine.minEnclosingCircle(enc.cx, enc.cy, enc.r);
          this.ringTargetCx = mec.x;
          this.ringTargetCy = mec.y;
          this.ringTargetRad = mec.r + C.beltGap + C.ringPredMargin;
        }
      }
      // ring hard-cut to target (ringCenterLerp is unused in Swift as well)
      this.ringCx = this.ringTargetCx;
      this.ringCy = this.ringTargetCy;
      this.ringRad = this.ringTargetRad;
      const rcx = this.ringCx,
        rcy = this.ringCy,
        ringRad = this.ringRad;
      const hubPrev = this.hubPrev;
      const havePred = this.beltPredPos.length === 2 * nh;
      for (let s = 0; s < nh; s++) {
        const relx = now[2 * s] - rcx,
          rely = now[2 * s + 1] - rcy;
        const rpx = hubPrev[2 * s] - rcx,
          rpy = hubPrev[2 * s + 1] - rcy;
        const d = Math.atan2(rely, relx) - Math.atan2(rpy, rpx);
        this.beltTmpC[s] = Math.cos(d);
        this.beltTmpS[s] = Math.sin(d);
        // family bearing = intersection of the main->folder ray with the ring
        const fx = havePred ? this.beltPredPos[2 * s] : now[2 * s];
        const fy = havePred ? this.beltPredPos[2 * s + 1] : now[2 * s + 1];
        const fl = len(fx, fy);
        const ux = fl > 1e-4 ? fx / fl : 1,
          uy = fl > 1e-4 ? fy / fl : 0;
        const b = ux * rcx + uy * rcy;
        const disc = Math.max(
          b * b - (rcx * rcx + rcy * rcy) + ringRad * ringRad,
          0,
        );
        const sq = Math.sqrt(disc);
        const ppx = ux * (b + sq) - rcx,
          ppy = uy * (b + sq) - rcy;
        this.beltTmpPol[s] = Math.atan2(ppy, ppx);
      }
      // per-tick arc carving + per-family affine home parameters
      this._carveBeltSegs();
      if (this.beltFamBase.length !== nh) {
        this.beltFamBase = new Array(nh).fill(0);
        this.beltFamSlope = new Array(nh).fill(1);
        this.beltFamSel = new Array(nh).fill(0);
      }
      for (let s = 0; s < nh; s++) {
        const segs = this.beltPredSegs[s];
        const fw = Math.max(this.beltFamW[s], 0.05);
        if (segs.length === 0) {
          this.beltFamBase[s] = 0;
          this.beltFamSlope[s] = 1;
          continue;
        }
        // pick one best free segment (sticky bonus prevents ping-pong)
        let best = segs[0];
        if (segs.length > 1) {
          let bestScore = -Number.MAX_VALUE;
          for (const seg of segs) {
            const l = seg[0],
              h = seg[1];
            const dist = l > 0 ? l : h < 0 ? -h : 0;
            let score = Math.min(h - l, 2 * fw) * 2 - dist;
            if (this.beltFamSel[s] >= l && this.beltFamSel[s] <= h)
              score += fw * 0.8;
            if (score > bestScore) {
              bestScore = score;
              best = seg;
            }
          }
        }
        const lo = best[0],
          hi = best[1];
        this.beltFamSel[s] = (lo + hi) / 2;
        let base = 0,
          slope = 1;
        if (2 * fw <= hi - lo) {
          base = Math.min(Math.max(0, lo + fw), hi - fw);
        } else {
          base = (lo + hi) / 2;
          slope = (hi - lo) / (2 * fw);
        }
        // backlog nudge
        const lossR = Math.max(0, fw - hi);
        const lossL = Math.max(0, fw + lo);
        base += Math.min(Math.max((lossL - lossR) * 0.08, -0.12), 0.12);
        this.beltFamBase[s] = base;
        this.beltFamSlope[s] = slope;
      }
      const carrying = this.beltForming; // (1) forming carries; (3) after release pure spring
      // standby until the shadow result is locked: belts get no slot force
      if (!this.shadowDone) {
        for (let b = 0; b < nb; b++) this.nodeTransit[this.beltIdx[b]] = 0;
        this.beltTransitAny = false;
        for (let s = 0; s < 2 * nh; s++) hubPrev[s] = now[s];
        return;
      }
      let transitAny = false;
      const measureArrive = this.beltReveal < 1 && !this.beltRevealGo;
      const hubBubbleR = this.hubBubbleR,
        nodeRadius = this.nodeRadius;
      const ac = C.beltGlideArcCap * this.animationSpeedScale;
      const rc2 = C.beltGlideRadialCap * this.animationSpeedScale;
      for (let b = 0; b < nb; b++) {
        const i = this.beltIdx[b];
        const s = this.beltHubSlot[b];
        // frame carry (forming only): rigid rotation about the ring center
        if (carrying) {
          const p0x = px[i] - rcx,
            p0y = py[i] - rcy;
          const c = this.beltTmpC[s],
            sn = this.beltTmpS[s];
          px[i] = rcx + (p0x * c - p0y * sn);
          py[i] = rcy + (p0x * sn + p0y * c);
        }
        const a = this.beltFamBase[s] + this.beltFamSlope[s] * this.beltAng[b];
        const homeAng = this.beltTmpPol[s] + a;
        const rr = ringRad + this.beltRing[b];
        let tx = rcx + Math.cos(homeAng) * rr;
        let ty = rcy + Math.sin(homeAng) * rr;
        // project the home out of live bubbles
        for (let jj = 0; jj < nh; jj++) {
          if (!(hubBubbleR[jj] > 0)) continue;
          const dvx = tx - now[2 * jj],
            dvy = ty - now[2 * jj + 1];
          const dist = len(dvx, dvy);
          const minD = hubBubbleR[jj] + nodeRadius[i] + 2;
          if (dist < minD) {
            const dx = dist > 1e-4 ? dvx / dist : 1,
              dy = dist > 1e-4 ? dvy / dist : 0;
            tx = now[2 * jj] + dx * minD;
            ty = now[2 * jj + 1] + dy * minD;
          }
        }
        // polar spring: radial + tangential components about the ring center
        const relCx = px[i] - rcx,
          relCy = py[i] - rcy;
        const rCur = len(relCx, relCy);
        const relTx = tx - rcx,
          relTy = ty - rcy;
        let dispX, dispY;
        if (rCur > 1e-3) {
          const rdx = relCx / rCur,
            rdy = relCy / rCur;
          const tdx = -rdy,
            tdy = rdx;
          let dth = Math.atan2(relTy, relTx) - Math.atan2(relCy, relCx);
          while (dth > PI) dth -= TWO_PI;
          while (dth < -PI) dth += TWO_PI;
          let dr = len(relTx, relTy) - rCur;
          let arc = rCur * dth;
          // glide carrot (after forming only)
          if (!carrying) {
            arc = Math.max(-ac, Math.min(ac, arc));
            dr = Math.max(-rc2, Math.min(rc2, dr));
          }
          dispX = rdx * dr + tdx * arc;
          dispY = rdy * dr + tdy * arc;
        } else {
          dispX = relTx;
          dispY = relTy;
        }
        const dx = dispX - vx[i],
          dy = dispY - vy[i];
        const dLen = len(dx, dy);
        const boost = Math.min(1 + dLen / 150, 3);
        vx[i] += dx * (k * boost);
        vy[i] += dy * (k * boost);
        // transit: immune to collision while far from target (not while forming)
        const tr = !carrying && dLen > 24;
        this.nodeTransit[i] = tr ? 1 : 0;
        if (tr) transitAny = true;
      }
      this.beltTransitAny = transitAny;
      for (let s = 0; s < 2 * nh; s++) hubPrev[s] = now[s];
      // arrival = whole layout settled: all hubs static, cold, quiet window
      if (
        measureArrive &&
        allStatic &&
        this.alpha < C.alphaMin &&
        this.quietFlag
      ) {
        this.beltRevealGo = true;
      }
    }

    // MARK: - Shadow engine

    // Spawn a shadow: clone current state into a fresh isShadow engine and run it
    // to hub convergence. Swift runs it on a background queue; here _pumpShadow
    // advances it inside step() under a time budget.
    _spawnShadow(releasedSim = -1) {
      const nh = this.hubIndices.length;
      if (this.isShadow || nh === 0) return false;
      // placeholder bearing = current live hub positions (refreshed on every call)
      const pp = new Float64Array(2 * nh);
      for (let s = 0; s < nh; s++) {
        pp[2 * s] = this.px[this.hubIndices[s]];
        pp[2 * s + 1] = this.py[this.hubIndices[s]];
      }
      this.beltPredPos = pp;
      if (this.shadowInFlight) {
        if (releasedSim >= 0) return false; // warm-up does not kill a finishing job
        this.shadowGen += 1;
        this.shadowReady = false;
        this.shadowReadyClonePos = null;
        this.shadowClonePosPending = null;
        this.shadowDone = false;
        return false;
      }
      this.shadowInFlight = true;
      this.shadowGen += 1;
      const myGen = this.shadowGen;
      if (releasedSim < 0) {
        this.shadowReady = false;
        this.shadowReadyClonePos = null;
      }
      this.shadowDone = false;

      const sh = new GraphEngine(this.sceneRef, { isShadow: true });
      sh.px.set(this.px);
      sh.py.set(this.py);
      sh.vx.set(this.vx);
      sh.vy.set(this.vy);
      if (releasedSim >= 0) {
        sh.vx[releasedSim] = 0;
        sh.vy[releasedSim] = 0;
      }
      const clonePos =
        releasedSim >= 0 ? [this.px[releasedSim], this.py[releasedSim]] : null;
      this.shadowClonePosPending = clonePos;
      sh.alpha = this.alpha;
      sh.alphaTarget = 0;
      sh.beltForming = this.beltForming;
      sh.nodeTransit.set(this.nodeTransit);
      sh.ringCx = this.ringCx;
      sh.ringCy = this.ringCy;
      sh.ringRad = this.ringRad;
      sh.ringTargetCx = this.ringTargetCx;
      sh.ringTargetCy = this.ringTargetCy;
      sh.ringTargetRad = this.ringTargetRad;
      sh.ringDirty = this.ringDirty;
      sh.beltFamSel = this.beltFamSel.slice();
      sh.beltFamBase = this.beltFamBase.slice();
      sh.beltFamSlope = this.beltFamSlope.slice();
      this._shadowJob = {
        sh,
        gen: myGen,
        releasedSim,
        clonePos,
        steps: 0,
        hubIdx: this.hubIndices.slice(),
      };
      return true;
    }

    // Advance the in-flight shadow job (replaces the GCD background task).
    _pumpShadow() {
      const job = this._shadowJob;
      if (!job) return;
      if (job.gen !== this.shadowGen) {
        // discarded (drag / explode / new scene)
        this._shadowJob = null;
        this.shadowInFlight = false;
        return;
      }
      const sh = job.sh;
      const t0 = nowMs();
      let finished = false;
      while (job.steps < C.shadowTickCap) {
        sh._tick();
        job.steps += 1;
        // warm-up delivers at quasi-still; formal jobs wait for brake == 0
        const settled = job.releasedSim >= 0 ? sh.quietFlag : sh.brake === 0;
        if (sh.alpha < C.alphaMin && settled) {
          finished = true;
          break;
        }
        if (nowMs() - t0 >= this.shadowBudgetMs) break;
      }
      if (!finished && job.steps < C.shadowTickCap) return; // continue next step()
      const nhh = job.hubIdx.length;
      const result = new Float64Array(2 * nhh);
      for (let s = 0; s < nhh; s++) {
        result[2 * s] = sh.px[job.hubIdx[s]];
        result[2 * s + 1] = sh.py[job.hubIdx[s]];
      }
      if (this.shadowGen === job.gen) {
        this.shadowResult = result;
        this.shadowReady = true;
        this.shadowReadyClonePos = job.clonePos;
      }
      this.shadowInFlight = false;
      this._shadowJob = null;
    }

    // Ring dead-zone test against the target ring: covered with >=10pt margin and not looser than margin+slack.
    _ringCovered(enc) {
      let need = 0;
      for (let i = 0; i < enc.cx.length; i++) {
        need = Math.max(
          need,
          hyp(enc.cx[i] - this.ringTargetCx, enc.cy[i] - this.ringTargetCy) +
            enc.r[i],
        );
      }
      return (
        need <= this.ringTargetRad - 10 &&
        this.ringTargetRad - need <= C.ringPredMargin + C.ringSlack
      );
    }

    // Enclosure set: main circle + every hub bubble (hub positions from interleaved H by slot).
    _enclosureCircles(H) {
      const cx = [0],
        cy = [0],
        r = [Math.max(this.nodeRadius[0], this.mainEnclosureR)];
      for (let s = 0; s < this.hubIndices.length; s++) {
        cx.push(H[2 * s]);
        cy.push(H[2 * s + 1]);
        r.push(
          this.hubBubbleR[s] > 0
            ? this.hubBubbleR[s]
            : this.nodeRadius[this.hubIndices[s]],
        );
      }
      return { cx, cy, r };
    }

    /**
     * Minimum enclosing circle of a set of circles (O(n³) enumeration of
     * single / pair / Apollonius triple candidates). Returns {x, y, r}.
     */
    static minEnclosingCircle(cx, cy, r) {
      const n = cx.length;
      if (n === 0) return { x: 0, y: 0, r: 0 };
      let bestX = cx[0],
        bestY = cy[0];
      let bestR = Number.MAX_VALUE;
      const covers = (x, y, R) => {
        const eps = R * 1e-4 + 1e-3;
        for (let i = 0; i < n; i++) {
          const dx = cx[i] - x,
            dy = cy[i] - y;
          if (Math.sqrt(dx * dx + dy * dy) + r[i] > R + eps) return false;
        }
        return true;
      };
      const consider = (x, y, R) => {
        if (R < bestR && Number.isFinite(R) && covers(x, y, R)) {
          bestX = x;
          bestY = y;
          bestR = R;
        }
      };
      for (let i = 0; i < n; i++) consider(cx[i], cy[i], r[i]);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = cx[j] - cx[i],
            dy = cy[j] - cy[i];
          const d = Math.sqrt(dx * dx + dy * dy);
          const R = (d + r[i] + r[j]) / 2;
          if (d < 1e-9) continue;
          const t = (R - r[i]) / d;
          consider(cx[i] + dx * t, cy[i] + dy * t, R);
        }
      }
      for (let p = 0; p < n; p++) {
        for (let q = p + 1; q < n; q++) {
          for (let w = q + 1; w < n; w++) {
            const a11 = 2 * (cx[q] - cx[p]),
              a12 = 2 * (cy[q] - cy[p]);
            const a21 = 2 * (cx[w] - cx[p]),
              a22 = 2 * (cy[w] - cy[p]);
            const det = a11 * a22 - a12 * a21;
            if (Math.abs(det) < 1e-9) continue;
            const dq = r[p] - r[q],
              dw = r[p] - r[w];
            const kq =
              cx[q] * cx[q] +
              cy[q] * cy[q] -
              cx[p] * cx[p] -
              cy[p] * cy[p] -
              dq * dq;
            const kw =
              cx[w] * cx[w] +
              cy[w] * cy[w] -
              cx[p] * cx[p] -
              cy[p] * cy[p] -
              dw * dw;
            const x0 = (kq * a22 - kw * a12) / det;
            const x1 = (-2 * dq * a22 + 2 * dw * a12) / det;
            const y0 = (a11 * kw - a21 * kq) / det;
            const y1 = (-a11 * 2 * dw + a21 * 2 * dq) / det;
            const ex = x0 - cx[p],
              ey = y0 - cy[p];
            const qa = x1 * x1 + y1 * y1 - 1;
            const qb = 2 * (ex * x1 + ey * y1);
            const qc = ex * ex + ey * ey;
            if (Math.abs(qa) < 1e-12) {
              if (Math.abs(qb) > 1e-12) {
                const d1 = -qc / qb;
                if (d1 >= 0) consider(x0 + x1 * d1, y0 + y1 * d1, d1 + r[p]);
              }
              continue;
            }
            const disc = qb * qb - 4 * qa * qc;
            if (disc < 0) continue;
            const sq = Math.sqrt(disc);
            for (const d1 of [(-qb - sq) / (2 * qa), (-qb + sq) / (2 * qa)]) {
              if (d1 >= 0) consider(x0 + x1 * d1, y0 + y1 * d1, d1 + r[p]);
            }
          }
        }
      }
      if (bestR === Number.MAX_VALUE) {
        // numeric fallback (unreachable in theory)
        let x = 0,
          y = 0;
        for (let i = 0; i < n; i++) {
          x += cx[i];
          y += cy[i];
        }
        x /= n;
        y /= n;
        let R = 0;
        for (let i = 0; i < n; i++)
          R = Math.max(R, hyp(cx[i] - x, cy[i] - y) + r[i]);
        bestX = x;
        bestY = y;
        bestR = R;
      }
      return { x: bestX, y: bestY, r: bestR };
    }

    /**
     * Preload the invisible ring for a seed: headless shadow run to convergence,
     * same formula as the opening pin. Returns {cx, cy, r} or null (no belt).
     * Synchronous (can take hundreds of ms at ~3000 nodes); see preloadRingAsync.
     */
    static preloadRing(scene, seed) {
      const sh = GraphEngine._preloadShadow(scene, seed);
      if (!sh) return null;
      let steps = 0;
      while (steps < C.shadowTickCap) {
        sh._tick();
        steps += 1;
        if (sh.alpha < C.alphaMin && sh.brake === 0) break;
      }
      return GraphEngine._preloadResult(sh);
    }

    /** Same as preloadRing, chunked over macrotasks (budgetMs per chunk). Resolves {cx,cy,r} or null. */
    static preloadRingAsync(scene, seed, budgetMs = 8) {
      return new Promise((resolve) => {
        const sh = GraphEngine._preloadShadow(scene, seed);
        if (!sh) {
          resolve(null);
          return;
        }
        let steps = 0;
        const chunk = () => {
          const t0 = nowMs();
          while (steps < C.shadowTickCap) {
            sh._tick();
            steps += 1;
            if (sh.alpha < C.alphaMin && sh.brake === 0) {
              resolve(GraphEngine._preloadResult(sh));
              return;
            }
            if (nowMs() - t0 >= budgetMs) {
              setTimeout(chunk, 0);
              return;
            }
          }
          resolve(GraphEngine._preloadResult(sh));
        };
        chunk();
      });
    }

    static _preloadShadow(scene, seed) {
      if (
        !scene.nodes.some(
          (nd) => nd.beltTier !== null && nd.beltTier !== undefined,
        )
      )
        return null;
      const sh = new GraphEngine(scene, { seed, isShadow: true });
      if (sh.hubIndices.length === 0) return null;
      return sh;
    }

    static _preloadResult(sh) {
      const nh = sh.hubIndices.length;
      const H = new Float64Array(2 * nh);
      for (let s = 0; s < nh; s++) {
        H[2 * s] = sh.px[sh.hubIndices[s]];
        H[2 * s + 1] = sh.py[sh.hubIndices[s]];
      }
      const enc = sh._enclosureCircles(H);
      const mec = GraphEngine.minEnclosingCircle(enc.cx, enc.cy, enc.r);
      return { cx: mec.x, cy: mec.y, r: mec.r + C.beltGap + C.ringPredMargin };
    }

    // MARK: - Dynamic arc carving (ring-center frame)

    _carveBeltSegs() {
      const nh = this.hubIndices.length;
      if (nh === 0) return;
      if (this.beltPredSegs.length !== nh) {
        this.beltPredSegs = [];
        for (let s = 0; s < nh; s++) this.beltPredSegs.push([[-2.98, 2.98]]);
      }
      const havePred = this.beltPredPos.length === 2 * nh;
      const rcx = this.ringCx,
        rcy = this.ringCy;
      const gapF = C.beltGap;
      const now = this.beltTmpNow;
      for (let s = 0; s < nh; s++) {
        if (!(this.beltFamReach[s] > 0)) continue;
        const polar = this.beltTmpPol[s];
        const bLo = this.ringRad + gapF - 6;
        const bHi = this.ringRad + this.beltFamReach[s] + 20;
        const rB = this.ringRad + (gapF + this.beltFamReach[s]) * 0.5;
        let segs = [[-2.98, 2.98]];
        // blockers: main circle (t = -1) + every bubble
        for (let t = -1; t < nh; t++) {
          let ptx, pty, bT;
          if (t < 0) {
            ptx = 0;
            pty = 0;
            bT = this.nodeRadius[0] + 8;
          } else {
            if (!(this.hubBubbleR[t] > 0)) continue;
            ptx = havePred ? this.beltPredPos[2 * t] : now[2 * t];
            pty = havePred ? this.beltPredPos[2 * t + 1] : now[2 * t + 1];
            bT = this.hubBubbleR[t] + 8;
          }
          const relx = ptx - rcx,
            rely = pty - rcy;
          const dT = Math.max(len(relx, rely), 1);
          if (dT + bT < bLo || dT - bT > bHi) continue; // radial gate
          const cosRB = (dT * dT + rB * rB - bT * bT) / (2 * dT * rB);
          let w;
          if (cosRB >= 1) {
            const rEff = Math.min(Math.max(dT, bLo), bHi);
            const cosE = (dT * dT + rEff * rEff - bT * bT) / (2 * dT * rEff);
            if (cosE >= 1) continue;
            w = Math.acos(Math.max(cosE, -1));
          } else {
            w = Math.acos(Math.max(cosRB, -1));
          }
          let rel = Math.atan2(rely, relx) - polar;
          while (rel > PI) rel -= TWO_PI;
          while (rel < -PI) rel += TWO_PI;
          // interval subtraction: remove [rel-w, rel+w]
          const out = [];
          for (const seg of segs) {
            const l = seg[0],
              h = seg[1];
            if (rel + w <= l || rel - w >= h) {
              out.push(seg);
              continue;
            }
            if (rel - w - l >= 0.1) out.push([l, rel - w]);
            if (h - (rel + w) >= 0.1) out.push([rel + w, h]);
          }
          segs = out;
          if (segs.length === 0) break;
        }
        if (segs.length === 0) segs = [[-0.15, 0.15]]; // fully blocked: minimal window
        this.beltPredSegs[s] = segs;
      }
    }

    // MARK: - Bubble collision (velocity domain, heavy moves less)

    _bubblePass() {
      const h = this.hubIndices.length;
      if (h === 0) return;
      const k = C.bubbleCollideStrength;
      const mainR = this.nodeRadius[0];
      const di = this.draggedIndex === null ? -1 : this.draggedIndex;
      const px = this.px,
        py = this.py,
        vx = this.vx,
        vy = this.vy;
      const bub = this.hubBubbleR,
        mass = this.hubMass;
      for (let ii = 0; ii < h; ii++) {
        if (!(bub[ii] > 0)) continue;
        const i = this.hubIndices[ii];
        // bubble vs main (main pinned, only the hub moves)
        if (i !== di) {
          const x = px[i],
            y = py[i];
          const d = len(x, y);
          const minD = mainR + bub[ii] + this.hubMainClear[ii];
          if (d < minD && d > 1e-4) {
            let ov = minD - d;
            if (!this.beltForming && ov > C.bubbleEaseDeepOverlap) {
              ov = C.bubbleEaseVelCap;
              const ux = x / d,
                uy = y / d;
              const closing = vx[i] * ux + vy[i] * uy;
              if (closing < 0) {
                vx[i] -= ux * closing;
                vy[i] -= uy * closing;
              }
            }
            vx[i] += (x / d) * (ov * k);
            vy[i] += (y / d) * (ov * k);
          }
        }
        // bubble vs bubble
        for (let jj = ii + 1; jj < h; jj++) {
          if (!(bub[jj] > 0)) continue;
          const j = this.hubIndices[jj];
          if (i === di || j === di) continue;
          let dvx = px[j] - px[i],
            dvy = py[j] - py[i];
          let dist = len(dvx, dvy);
          if (dist < 1e-4) {
            dvx = 1e-3;
            dvy = 0;
            dist = 1e-3;
          }
          const need = bub[ii] + bub[jj] + 2;
          if (dist < need) {
            let ov = need - dist;
            const wi = mass[jj] / (mass[ii] + mass[jj]);
            if (!this.beltForming && ov > C.bubbleEaseDeepOverlap) {
              ov = C.bubbleEaseVelCap;
              const ux = dvx / dist,
                uy = dvy / dist;
              const rv = (vx[j] - vx[i]) * ux + (vy[j] - vy[i]) * uy;
              if (rv < 0) {
                vx[i] += ux * (rv * wi);
                vy[i] += uy * (rv * wi);
                vx[j] -= ux * (rv * (1 - wi));
                vy[j] -= uy * (rv * (1 - wi));
              }
            }
            const push = (ov / dist) * k;
            vx[i] -= dvx * (push * wi);
            vy[i] -= dvy * (push * wi);
            vx[j] += dvx * (push * (1 - wi));
            vy[j] += dvy * (push * (1 - wi));
          }
        }
      }
    }

    // MARK: - Barnes-Hut quadtree

    _allocateTree() {
      const cap = 4 * Math.max(this.n, 1) + 64;
      this.qChild = new Int32Array(4 * cap).fill(-1);
      this.qMass = new Float64Array(cap);
      this.qComX = new Float64Array(cap);
      this.qComY = new Float64Array(cap);
      this.qWidth = new Float64Array(cap);
      this.qMaxR = new Float64Array(cap);
      this.qCount = 0;
      this.nextPoint = new Int32Array(Math.max(this.n, 1)).fill(-1);
      this.rootCx = 0;
      this.rootCy = 0;
      this.rootHalf = 0;
      this.cStackNode = new Int32Array(256);
      this.cStackCX = new Float64Array(256);
      this.cStackCY = new Float64Array(256);
      this.cStackHalf = new Float64Array(256);
      this.bhStack = new Int32Array(256);
    }

    _buildTree() {
      const n = this.n,
        P = this.px,
        Q = this.py;
      let lox = P[0],
        loy = Q[0],
        hix = P[0],
        hiy = Q[0];
      for (let i = 0; i < n; i++) {
        const x = P[i],
          y = Q[i];
        if (x < lox) lox = x;
        if (x > hix) hix = x;
        if (y < loy) loy = y;
        if (y > hiy) hiy = y;
      }
      const side = Math.max(hix - lox, hiy - loy) + 1e-3;
      const rcx = (lox + hix) * 0.5,
        rcy = (loy + hiy) * 0.5;
      this.rootCx = rcx;
      this.rootCy = rcy;
      this.rootHalf = side * 0.5;
      const ch = this.qChild,
        wid = this.qWidth,
        NP = this.nextPoint;
      let qCount = 1;
      ch[0] = -1;
      ch[1] = -1;
      ch[2] = -1;
      ch[3] = -1;
      wid[0] = side;
      for (let i = 0; i < n; i++) NP[i] = -1;
      const skipBelt = this.isShadow;
      const BELT = this.nodeBelt;
      for (let pi = 0; pi < n; pi++) {
        // shadow slimming: belts are not inserted (no BH, no collide)
        if (skipBelt && BELT[pi]) continue;
        const x = P[pi],
          y = Q[pi];
        let node = 0;
        let cx = rcx,
          cy = rcy;
        let half = side * 0.5;
        let depth = 0;
        for (;;) {
          const q = (x >= cx ? 1 : 0) | (y >= cy ? 2 : 0);
          const slot = node * 4 + q;
          const c = ch[slot];
          if (c === -1) {
            // empty -> leaf
            ch[slot] = -pi - 2;
            break;
          } else if (c >= 0) {
            // internal -> descend
            node = c;
            cx += (x >= cx ? half : -half) * 0.5;
            cy += (y >= cy ? half : -half) * 0.5;
            half *= 0.5;
            depth += 1;
          } else {
            // occupied leaf -> split or chain
            const other = -c - 2;
            if (depth >= 26 || (P[other] === x && Q[other] === y)) {
              NP[pi] = NP[other];
              NP[other] = pi;
              break;
            }
            const newNode = qCount;
            qCount += 1;
            const b4 = newNode * 4;
            ch[b4] = -1;
            ch[b4 + 1] = -1;
            ch[b4 + 2] = -1;
            ch[b4 + 3] = -1;
            wid[newNode] = half;
            ch[slot] = newNode;
            const scx = cx + (x >= cx ? half : -half) * 0.5;
            const scy = cy + (y >= cy ? half : -half) * 0.5;
            const oq = (P[other] >= scx ? 1 : 0) | (Q[other] >= scy ? 2 : 0);
            ch[b4 + oq] = -other - 2;
            node = newNode;
            cx = scx;
            cy = scy;
            half *= 0.5;
            depth += 1;
          }
        }
      }
      this.qCount = qCount;
      // bottom-up aggregation: charge, center of mass, max radius (children > parents)
      const M = this.qMass,
        CX = this.qComX,
        CY = this.qComY,
        MR = this.qMaxR;
      const R = this.nodeRadius,
        NC = this.nodeCharge;
      for (let node = qCount - 1; node >= 0; node--) {
        let m = 0,
          comx = 0,
          comy = 0,
          mr = 0;
        for (let k = 0; k < 4; k++) {
          const c = ch[node * 4 + k];
          if (c === -1) continue;
          if (c >= 0) {
            const cm = M[c];
            m += cm;
            comx += CX[c] * cm;
            comy += CY[c] * cm;
            if (MR[c] > mr) mr = MR[c];
          } else {
            let pi = -c - 2;
            while (pi >= 0) {
              const q = NC[pi];
              m += q;
              comx += P[pi] * q;
              comy += Q[pi] * q;
              if (R[pi] > mr) mr = R[pi];
              pi = NP[pi];
            }
          }
        }
        M[node] = m;
        if (m !== 0) {
          CX[node] = comx / m;
          CY[node] = comy / m;
        } else {
          CX[node] = 0;
          CY[node] = 0;
        }
        MR[node] = mr;
      }
    }

    // Repulsion: only hubs receive it (leaves are positioned by their own family).
    _manyBodyPass() {
      const a = this.alpha;
      const theta2 = C.bhTheta2,
        dMin2 = C.bhDistanceMin2;
      const S = this.bhStack;
      const P = this.px,
        Q = this.py,
        V = this.vx,
        W = this.vy;
      const ch = this.qChild,
        M = this.qMass,
        CX = this.qComX,
        CY = this.qComY;
      const WD = this.qWidth,
        NP = this.nextPoint,
        NC = this.nodeCharge;
      for (let hi = 0; hi < this.hubIndices.length; hi++) {
        const i = this.hubIndices[hi];
        const x = P[i],
          y = Q[i];
        let fx = 0,
          fy = 0;
        S[0] = 0;
        let sp = 1;
        while (sp > 0) {
          sp -= 1;
          const node = S[sp];
          const dx = CX[node] - x,
            dy = CY[node] - y;
          const dist2 = Math.max(dx * dx + dy * dy, 1e-9);
          const w = WD[node];
          if (w * w < theta2 * dist2) {
            // far enough: whole cluster as one point
            const d2 = Math.max(dist2, dMin2);
            const f = (M[node] * a) / d2;
            fx += dx * f;
            fy += dy * f;
            continue;
          }
          for (let k = 0; k < 4; k++) {
            const c = ch[node * 4 + k];
            if (c === -1) continue;
            if (c >= 0) {
              S[sp] = c;
              sp += 1;
            } else {
              let pi = -c - 2;
              while (pi >= 0) {
                if (pi !== i) {
                  const ddx = P[pi] - x,
                    ddy = Q[pi] - y;
                  const dl2 = Math.max(ddx * ddx + ddy * ddy, dMin2);
                  const f = (NC[pi] * a) / dl2;
                  fx += ddx * f;
                  fy += ddy * f;
                }
                pi = NP[pi];
              }
            }
          }
        }
        V[i] += fx;
        W[i] += fy;
      }
    }

    // MARK: - Springs

    _linkPass() {
      // alpha floor 0.1: all positioning forces sleep or wake together
      const a = Math.max(this.alpha, 0.1);
      const e = this.edgesA.length;
      const P = this.px,
        Q = this.py,
        V = this.vx,
        W = this.vy;
      const EA = this.edgesA,
        EB = this.edgesB,
        LS = this.linkStrength,
        LB = this.linkBias,
        LR = this.linkRest;
      for (let i = 0; i < e; i++) {
        const s = EA[i],
          t = EB[i];
        let dx = P[t] + V[t] - P[s] - V[s];
        let dy = Q[t] + W[t] - Q[s] - W[s];
        if (dx === 0 && dy === 0) {
          dx = 1e-3;
          dy = 1e-3;
        }
        const l = Math.sqrt(dx * dx + dy * dy);
        const k = ((l - LR[i]) / l) * a * LS[i];
        const b = LB[i];
        V[t] -= dx * (k * b);
        W[t] -= dy * (k * b);
        V[s] += dx * (k * (1 - b));
        W[s] += dy * (k * (1 - b));
      }
    }

    // MARK: - Integrate + hard constraints

    _centerAndIntegrate() {
      const n = this.n;
      const a = this.alpha;
      const cs = C.centerStrength;
      const damping = C.velocityDamping;
      const bk = this.brake;
      const P = this.px,
        Q = this.py,
        V = this.vx,
        W = this.vy,
        CS = this.nodeCenterScale;
      const R = this.nodeRadius;
      for (let i = 0; i < n; i++) {
        const c = cs * a * CS[i];
        V[i] += (0 - P[i]) * c;
        W[i] += (0 - Q[i]) * c;
        V[i] *= damping;
        W[i] *= damping;
        P[i] += V[i] * bk;
        Q[i] += W[i] * bk; // bk = brake ratio (1 normally, slides to 0)
      }
      // pins: main at origin; dragged ball follows the pointer (d3 fx/fy)
      P[0] = 0;
      Q[0] = 0;
      V[0] = 0;
      W[0] = 0;
      const hasDrag = this.draggedIndex !== null;
      const di = hasDrag ? this.draggedIndex : -1;
      if (hasDrag && di > 0 && di < n) {
        P[di] = this.draggedToX;
        Q[di] = this.draggedToY;
        V[di] = 0;
        W[di] = 0;
      }
      // main ball hard collision (radial push-out, includes the dragged ball)
      if (n > 1) {
        const mainR = R[0];
        const pad = C.mainCollisionPadding;
        for (let i = 1; i < n; i++) {
          const d = len(P[i], Q[i]);
          const minD = mainR + R[i] + pad;
          if (d < minD) {
            const dx = d > 1e-4 ? P[i] / d : 1,
              dy = d > 1e-4 ? Q[i] / d : 0;
            P[i] = dx * minD;
            Q[i] = dy * minD;
          }
        }
      }
      // bubble hard solve: bubble vs main, bubble vs bubble (3 rounds)
      const nh = this.hubIndices.length;
      if (nh > 0) {
        const bub = this.hubBubbleR;
        const mainR = R[0];
        for (let round = 0; round < 3; round++) {
          for (let ii = 0; ii < nh; ii++) {
            if (!(bub[ii] > 0)) continue;
            const i = this.hubIndices[ii];
            if (i === di) continue;
            const d = len(P[i], Q[i]);
            const minD = mainR + bub[ii] + this.hubMainClear[ii];
            if (d < minD) {
              const dx = d > 1e-4 ? P[i] / d : 1,
                dy = d > 1e-4 ? Q[i] / d : 0;
              let step = minD - d;
              if (!this.beltForming && step > C.bubbleEaseDeepOverlap)
                step = C.bubbleEasePosCap;
              P[i] = dx * (d + step);
              Q[i] = dy * (d + step);
              // PBD velocity reconcile: drop closing normal velocity
              const cv = V[i] * dx + W[i] * dy;
              if (cv < 0) {
                V[i] -= dx * cv;
                W[i] -= dy * cv;
              }
            }
          }
          for (let ii = 0; ii < Math.max(nh - 1, 0); ii++) {
            if (!(bub[ii] > 0)) continue;
            for (let jj = ii + 1; jj < nh; jj++) {
              if (!(bub[jj] > 0)) continue;
              const i = this.hubIndices[ii],
                j = this.hubIndices[jj];
              if (i === di || j === di) continue;
              const ddx = P[j] - P[i],
                ddy = Q[j] - Q[i];
              const dist = len(ddx, ddy);
              const minD = bub[ii] + bub[jj];
              if (dist < minD) {
                const dx = dist > 1e-4 ? ddx / dist : 1,
                  dy = dist > 1e-4 ? ddy / dist : 0;
                let push = (minD - dist) * 0.5;
                if (!this.beltForming && minD - dist > C.bubbleEaseDeepOverlap)
                  push = C.bubbleEasePosCap;
                P[i] -= dx * push;
                Q[i] -= dy * push;
                P[j] += dx * push;
                Q[j] += dy * push;
                const rv = (V[j] - V[i]) * dx + (W[j] - W[i]) * dy;
                if (rv < 0) {
                  V[i] += dx * (rv * 0.5);
                  W[i] += dy * (rv * 0.5);
                  V[j] -= dx * (rv * 0.5);
                  W[j] -= dy * (rv * 0.5);
                }
              }
            }
          }
        }
      }
      // leaf vs own hub hard collision (push leaf only)
      const nl = this.leafIndices.length;
      if (nl > 0) {
        const pad = C.mainCollisionPadding;
        for (let li = 0; li < nl; li++) {
          const leaf = this.leafIndices[li];
          const hub = this.leafOwnHub[li];
          if (!(hub > 0)) continue;
          const ddx = P[leaf] - P[hub],
            ddy = Q[leaf] - Q[hub];
          const dist = len(ddx, ddy);
          const minD = R[leaf] + R[hub] + pad;
          if (dist < minD) {
            const dx = dist > 1e-4 ? ddx / dist : 1,
              dy = dist > 1e-4 ? ddy / dist : 0;
            P[leaf] = P[hub] + dx * minD;
            Q[leaf] = Q[hub] + dy * minD;
            const cv = V[leaf] * dx + W[leaf] * dy;
            if (cv < 0) {
              V[leaf] -= dx * cv;
              W[leaf] -= dy * cv;
            }
          }
        }
      }
      // in-bubble clamp: leaf never leaves its own bubble (position only, after all hard constraints)
      if (nl > 0) {
        for (let li = 0; li < nl; li++) {
          const leaf = this.leafIndices[li];
          if (leaf === di) continue;
          const hub = this.leafOwnHub[li];
          if (hub === di) continue;
          const maxD = this.leafMaxDist[li];
          if (!(maxD > 0)) continue;
          const ddx = P[leaf] - P[hub],
            ddy = Q[leaf] - Q[hub];
          const dist = len(ddx, ddy);
          if (dist > maxD && dist > 1e-4) {
            P[leaf] = P[hub] + (ddx / dist) * maxD;
            Q[leaf] = Q[hub] + (ddy / dist) * maxD;
          }
        }
      }
      // belt slide-out of bubbles (not while dragging, not in transit), <= 2.5pt/tick
      const nb = this.beltIdx.length;
      if (nb > 0 && nh > 0 && !hasDrag) {
        const bub = this.hubBubbleR;
        for (let b = 0; b < nb; b++) {
          const i = this.beltIdx[b];
          if (this.nodeTransit[i]) continue;
          for (let jj = 0; jj < nh; jj++) {
            if (!(bub[jj] > 0)) continue;
            const h = this.hubIndices[jj];
            const ddx = P[i] - P[h],
              ddy = Q[i] - Q[h];
            const dist = len(ddx, ddy);
            const minD = bub[jj] + R[i] + 1;
            if (dist < minD) {
              const dx = dist > 1e-4 ? ddx / dist : 1,
                dy = dist > 1e-4 ? ddy / dist : 0;
              const m = Math.min(minD - dist, 2.5);
              P[i] += dx * m;
              Q[i] += dy * m;
            }
          }
        }
      }
      // family frame carry (every hub's net displacement -> its leaves)
      this._familyCarryPass();
      // drag hard clearance: swept capsule + 2 rounds of neighbourhood PBD
      if (hasDrag && di > 0 && di < n) {
        const pdx = P[di],
          pdy = Q[di];
        const rd = R[di];
        const pad = C.collidePadding;
        const prevx = this.dragPrevPos ? this.dragPrevPos[0] : pdx;
        const prevy = this.dragPrevPos ? this.dragPrevPos[1] : pdy;
        const segx = pdx - prevx,
          segy = pdy - prevy;
        const segLen2 = segx * segx + segy * segy;
        const nbr = [];
        for (let j = 1; j < n; j++) {
          if (j === di) continue;
          let t = 0;
          if (segLen2 > 1e-8) {
            t = Math.max(
              0,
              Math.min(
                1,
                ((P[j] - prevx) * segx + (Q[j] - prevy) * segy) / segLen2,
              ),
            );
          }
          const cx = prevx + segx * t,
            cy = prevy + segy * t;
          const ddx = P[j] - cx,
            ddy = Q[j] - cy;
          const dist = len(ddx, ddy);
          const minD = rd + R[j] + pad;
          if (dist < minD) {
            const dx = dist > 1e-4 ? ddx / dist : 1,
              dy = dist > 1e-4 ? ddy / dist : 0;
            P[j] = cx + dx * minD;
            Q[j] = cy + dy * minD;
            const closing = V[j] * dx + W[j] * dy;
            if (closing < 0) {
              V[j] -= dx * closing;
              W[j] -= dy * closing;
            }
          }
          if (dist < minD + 24) nbr.push(j);
        }
        this.dragNbr = nbr;
        const maxR = this.maxNodeRadius;
        for (let round = 0; round < 2; round++) {
          // x-axis sweep: sort by x captured now, only check overlapping x-projections
          const sweep = nbr.map((idx) => ({ index: idx, x: P[idx] }));
          sweep.sort((u, v) => u.x - v.x);
          for (let a = 0; a < Math.max(sweep.length - 1, 0); a++) {
            const i = sweep[a].index;
            const reachX = R[i] + maxR + pad;
            for (let b = a + 1; b < sweep.length; b++) {
              if (sweep[b].x - sweep[a].x >= reachX) break;
              const j = sweep[b].index;
              const ddx = P[j] - P[i],
                ddy = Q[j] - Q[i];
              const dist = len(ddx, ddy);
              const minD = R[i] + R[j] + pad;
              if (dist < minD) {
                const dx = dist > 1e-4 ? ddx / dist : 1,
                  dy = dist > 1e-4 ? ddy / dist : 0;
                const push = (minD - dist) * 0.5;
                P[i] -= dx * push;
                Q[i] -= dy * push;
                P[j] += dx * push;
                Q[j] += dy * push;
                const rv = (V[j] - V[i]) * dx + (W[j] - W[i]) * dy;
                if (rv < 0) {
                  const ri2 = R[i] * R[i],
                    rj2 = R[j] * R[j];
                  const wi = rj2 / Math.max(ri2 + rj2, 1e-6);
                  V[i] += dx * (rv * wi);
                  W[i] += dy * (rv * wi);
                  V[j] -= dx * (rv * (1 - wi));
                  W[j] -= dy * (rv * (1 - wi));
                }
              }
            }
          }
        }
        this.dragPrevPos = [pdx, pdy];
      } else {
        this.dragPrevPos = null;
      }
    }

    // Family frame carry: hub net displacement × familyCarry added to own leaves.
    _familyCarryPass() {
      const nh = this.hubIndices.length;
      const n = this.n;
      if (nh === 0 || this.leafIndices.length === 0) return;
      const P = this.px,
        Q = this.py;
      if (this.famPrev.length !== 2 * nh || this.famDeltaX.length !== n) {
        const fp = new Float64Array(2 * nh);
        for (let s = 0; s < nh; s++) {
          fp[2 * s] = P[this.hubIndices[s]];
          fp[2 * s + 1] = Q[this.hubIndices[s]];
        }
        this.famPrev = fp;
        this.famDeltaX = new Float64Array(n);
        this.famDeltaY = new Float64Array(n);
        return;
      }
      const c = C.familyCarry;
      const fp = this.famPrev,
        DX = this.famDeltaX,
        DY = this.famDeltaY;
      let any = false;
      for (let s = 0; s < nh; s++) {
        const h = this.hubIndices[s];
        const dx = P[h] - fp[2 * s],
          dy = Q[h] - fp[2 * s + 1];
        fp[2 * s] = P[h];
        fp[2 * s + 1] = Q[h];
        // dead zone 0.2pt/tick: slow family circulation is not carried
        if (dx * dx + dy * dy > 0.04) {
          DX[h] = dx * c;
          DY[h] = dy * c;
          any = true;
        } else {
          DX[h] = 0;
          DY[h] = 0;
        }
      }
      // no carry while forming (famPrev still refreshed)
      if (!any || this.beltForming) return;
      const di = this.draggedIndex === null ? -1 : this.draggedIndex;
      for (let li = 0; li < this.leafIndices.length; li++) {
        const i = this.leafIndices[li];
        if (i === di) continue;
        const h = this.leafOwnHub[li];
        const dx = DX[h],
          dy = DY[h];
        if (dx !== 0 || dy !== 0) {
          P[i] += dx;
          Q[i] += dy;
        }
      }
    }

    // MARK: - Family angular spread (neighbour-midpoint relaxation, not scaled by alpha)

    _familySpreadPass() {
      const ranges = this.familyRange;
      if (ranges.length === 0) return;
      const a = 1;
      const k = C.familySpreadStrength;
      const P = this.px,
        Q = this.py,
        V = this.vx,
        W = this.vy;
      for (const fam of ranges) {
        const count = fam.hi - fam.lo;
        if (count < 3) continue;
        const hx = P[fam.hub],
          hy = Q[fam.hub];
        const items = new Array(count);
        let cvx = 0,
          cvy = 0;
        for (let x = fam.lo; x < fam.hi; x++) {
          const leaf = this.familyLeaf[x];
          const t = Math.atan2(Q[leaf] - hy, P[leaf] - hx);
          items[x - fam.lo] = { t, leaf };
          cvx += Math.cos(t);
          cvy += Math.sin(t);
        }
        items.sort((u, v) => u.t - v.t);
        cvx /= count;
        cvy /= count;
        const cMag = len(cvx, cvy);
        const cAng = Math.atan2(cvy, cvx);
        const evenGap = TWO_PI / count;
        const relBoost = Math.min(1 + 0.03 / evenGap, 8);
        const m1w = 0.4 * Math.min(Math.max(count - 16, 0) / 32, 1);
        for (let i = 0; i < count; i++) {
          const tL = items[(i + count - 1) % count].t;
          const tC = items[i].t;
          const tR = items[(i + 1) % count].t;
          let gapL = tC - tL;
          if (gapL < 0) gapL += TWO_PI;
          let gapR = tR - tC;
          if (gapR < 0) gapR += TWO_PI;
          const delta = (gapR - gapL) * 0.5 * relBoost;
          const leaf = items[i].leaf;
          const rx = P[leaf] - hx,
            ry = Q[leaf] - hy;
          const r = len(rx, ry);
          if (!(r > 1)) continue;
          const tx = -ry / r,
            ty = rx / r;
          const mode1 = cMag * Math.sin(tC - cAng) * m1w;
          const push = Math.max(Math.min(delta + mode1, 0.1), -0.1);
          const f = push * r * k * a;
          V[leaf] += tx * f;
          W[leaf] += ty * f;
        }
      }
    }

    // Portrait cooling tail: remove the shared rotation of each leaf band about its hub.
    _dampPortraitFamilyRotation() {
      const start = C.portraitRotationDampingStartAlpha;
      if (
        this.sceneRef.zone !== "portrait" ||
        this.alphaTarget !== 0 ||
        !(this.alpha < start) ||
        this.familyRange.length === 0
      )
        return;
      const span = Math.max(start - C.alphaMin, FLOAT_ULP_OF_ONE);
      const strength = Math.min(Math.max((start - this.alpha) / span, 0), 1);
      GraphEngine.dampCoherentFamilyRotation(
        this.px,
        this.py,
        this.vx,
        this.vy,
        this.familyLeaf,
        this.familyRange,
        strength,
      );
    }

    /** Remove `strength` of each band's common angular velocity (flat x/y arrays, in place). */
    static dampCoherentFamilyRotation(
      px,
      py,
      vx,
      vy,
      leaves,
      ranges,
      strength,
    ) {
      const amount = Math.min(Math.max(strength, 0), 1);
      if (!(amount > 0) || px.length !== vx.length) return;
      const n = px.length;
      for (const range of ranges) {
        if (range.hi - range.lo < 3) continue;
        const hub = range.hub;
        if (!(hub >= 0 && hub < n) || range.lo < 0 || range.hi > leaves.length)
          continue;
        const hx = px[hub],
          hy = py[hub],
          hvx = vx[hub],
          hvy = vy[hub];
        let angular = 0,
          inertia = 0;
        for (let x = range.lo; x < range.hi; x++) {
          const leaf = leaves[x];
          if (!(leaf >= 0 && leaf < n)) continue;
          const rx = px[leaf] - hx,
            ry = py[leaf] - hy;
          const rvx = vx[leaf] - hvx,
            rvy = vy[leaf] - hvy;
          angular += rx * rvy - ry * rvx;
          inertia += rx * rx + ry * ry;
        }
        if (!(inertia > FLOAT_ULP_OF_ONE)) continue;
        const omega = (angular / inertia) * amount;
        for (let x = range.lo; x < range.hi; x++) {
          const leaf = leaves[x];
          if (!(leaf >= 0 && leaf < n)) continue;
          const rx = px[leaf] - hx,
            ry = py[leaf] - hy;
          vx[leaf] -= -ry * omega;
          vy[leaf] -= rx * omega;
        }
      }
    }

    // MARK: - Radius-aware collision (d3 forceCollide port, tree-pruned)

    _collidePass() {
      const n = this.n;
      if (n <= 1) return;
      const strength = C.collideStrength;
      const pad = C.collidePadding;
      let beltPen = 0;
      const iters = this.alphaTarget > 0 ? 1 : C.collideIterations;
      const P = this.px,
        Q = this.py,
        V = this.vx,
        W = this.vy;
      const R = this.nodeRadius,
        FAM = this.nodeFamily,
        BELT = this.nodeBelt,
        TR = this.nodeTransit;
      const ch = this.qChild,
        MR = this.qMaxR,
        NP = this.nextPoint;
      const SN = this.cStackNode,
        SX = this.cStackCX,
        SY = this.cStackCY,
        SH = this.cStackHalf;
      const isShadow = this.isShadow;
      const rootCx = this.rootCx,
        rootCy = this.rootCy,
        rootHalf = this.rootHalf;
      for (let it = 0; it < iters; it++) {
        // family isolation only in steady state; cross-family resistance while dragging
        const isolate = this.alphaTarget === 0;
        for (let i = 0; i < n; i++) {
          const fi = FAM[i];
          if (fi < 0) continue; // only leaves (hubs: bubbles / hard constraints)
          if (isShadow && BELT[i]) continue; // shadow: belts frozen
          if (TR[i]) continue; // in transit
          const pix = P[i] + V[i],
            piy = Q[i] + W[i]; // predicted position (d3)
          const ri = R[i] + pad;
          const ri2 = ri * ri;
          const beltI = BELT[i];
          SN[0] = 0;
          SX[0] = rootCx;
          SY[0] = rootCy;
          SH[0] = rootHalf;
          let sp = 1;
          while (sp > 0) {
            sp -= 1;
            const node = SN[sp];
            const cx = SX[sp],
              cy = SY[sp],
              h = SH[sp];
            const reach = ri + MR[node] + pad;
            if (
              pix < cx - h - reach ||
              pix > cx + h + reach ||
              piy < cy - h - reach ||
              piy > cy + h + reach
            )
              continue;
            for (let k = 0; k < 4; k++) {
              const c = ch[node * 4 + k];
              if (c === -1) continue;
              if (c >= 0) {
                SN[sp] = c;
                SX[sp] = cx + ((k & 1) === 1 ? h : -h) * 0.5;
                SY[sp] = cy + ((k & 2) === 2 ? h : -h) * 0.5;
                SH[sp] = h * 0.5;
                sp += 1;
              } else {
                let pj = -c - 2;
                while (pj >= 0) {
                  const fj = FAM[pj];
                  if (
                    pj > i &&
                    !TR[pj] &&
                    (fj === fi ||
                      (!isolate && fj >= 0) ||
                      ((beltI || BELT[pj]) && fj >= 0))
                  ) {
                    const rj = R[pj] + pad;
                    const rsum = ri + rj;
                    let dx = pix - (P[pj] + V[pj]);
                    let dy = piy - (Q[pj] + W[pj]);
                    let l2 = dx * dx + dy * dy;
                    if (l2 < rsum * rsum) {
                      if (l2 < 1e-6) {
                        dx = 1e-3;
                        dy = 1e-3;
                        l2 = dx * dx + dy * dy;
                      }
                      const l = Math.sqrt(l2);
                      const push = ((rsum - l) / l) * strength;
                      const wj = (rj * rj) / (ri2 + rj * rj);
                      V[i] += dx * (push * wj);
                      W[i] += dy * (push * wj);
                      V[pj] -= dx * (push * (1 - wj));
                      W[pj] -= dy * (push * (1 - wj));
                      if (beltI && BELT[pj])
                        beltPen = Math.max(beltPen, rsum - l - 2 * pad);
                    }
                  }
                  pj = NP[pj];
                }
              }
            }
          }
        }
      }
      this.beltPenMax = beltPen;
    }

    // Explosion seed positions: uniform in [-r, r]², main at origin.
    _explosionPositions(rng) {
      const r = C.explosionRadius;
      for (let i = 0; i < this.n; i++) {
        this.px[i] = rng.float(-r, r);
        this.py[i] = rng.float(-r, r);
      }
      if (this.n > 0) {
        this.px[0] = 0;
        this.py[0] = 0;
      }
    }
  }

  global.GraphEngine = GraphEngine;
  global.GraphConstants = GraphConstants;
  global.BeltLayout = BeltLayout;
})(typeof window !== "undefined" ? window : globalThis);
