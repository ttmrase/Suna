// Suna — sand & water simulation.
//
// A height-field model on a regular grid (x right, y down, index = x + y*W):
//   b  sand surface height above the hard floor (floor = 0)
//   w  depth of surface water standing on the sand
//   g  groundwater table height inside the sand (0 <= g <= b)
//   s  sand suspended in the water column (as bed-height equivalent)
//   l  thickness of loose sand lying on top of the firm, settled sand
//   fx water volume crossing the face between cell i and i+1 per step
//   fy water volume crossing the face between cell i and i+W per step
//
// Surface water follows a shallow-water "pipe" scheme with Chezy friction,
// moving sediment is carried by those same fluxes (so sand is conserved),
// slopes steeper than the angle of repose slide, and water seeps through the
// sand as groundwater so that dams leak and holes dug near water fill up.
//
// Sand the player has dug, heaped or that the water has just dropped is
// loose and washes away easily; the settled beach underneath only gives
// way to fast water. That is what lets a freshly dug groove deepen under a
// trickle while the rest of the beach stays put.
//
// Time is measured in steps; all rates below are per step with dx = 1.
// Every pass only visits the part of the grid where something can happen:
// wet cells for water, recently disturbed sand for slides.

export const DEFAULTS = {
  // --- surface water ---
  G: 0.25,        // gravity * dt^2
  dCap: 1.0,      // depth above which pressure-driven acceleration saturates (keeps it stable)
  k1: 0.004,      // linear friction (settles sloshing)
  k2: 0.06,       // Chezy friction: steady speed = sqrt(G * slope * depth / k2)
  // --- erosion / deposition ---
  vMinDepth: 0.08, // depth floor used when turning discharge into speed
  vc2Hard: 0.06,  // speed^2 that water needs before it moves firm, settled sand
  vc2Loose: 0.02, // ... and loose sand
  looseBlend: 0.04, // loose layer thickness at which the bed counts as fully loose
  digLoose: 0.5,  // depth of sand left loosened by digging
  Kc: 0.55,       // carrying capacity factor
  cMax: 0.3,      // maximum sediment concentration
  Ks: 0.03,       // pick-up rate of loose sand
  KsFirm: 0.003,  // pick-up rate of firm sand: it wears away slowly, all along a stream
  Kd: 0.05,       // settling rate
  maxHeight: 36,  // sand cannot be heaped higher than this
  // --- angle of repose (height difference per cell) ---
  talusDry: 0.65,
  talusMoist: 1.15,
  talusWet: 0.5,
  slipRate: 0.12,
  // --- groundwater (each cell is visited every 4th step, rates are per visit) ---
  Sy: 0.1,        // drainable pore space
  Ki: 0.04,       // infiltration rate limit
  KT: 0.02,       // lateral transmissivity (KT / Sy must stay below 0.25)
  dryDepth: 1.5,  // resting depth of the water table below the surface
  dryRate: 0.0005, // how fast damp sand dries out
  moistDepth: 1.3, // sand closer than this to the water table is damp
  // --- sea ---
  seaLevel: 8.0,
  seaRows: 26,    // rows along the bottom edge that are open sea, held at sea level
  seaDeep: 2.3,   // the bed there is kept at least this far below sea level
  tideAmp: 0.22,
  tidePeriod: 660,
};

const FLUX_EPS = 1e-7;
const WATER_EPS = 1e-5;
const BED_EPS = 1e-6;

export class Sim {
  constructor(W, H, params = {}) {
    this.W = W;
    this.H = H;
    this.N = W * H;
    this.p = Object.assign({}, DEFAULTS, params);
    const N = this.N;
    this.b = new Float32Array(N);
    this.w = new Float32Array(N);
    this.g = new Float32Array(N);
    this.s = new Float32Array(N);
    this.l = new Float32Array(N);
    this.fx = new Float32Array(N);
    this.fy = new Float32Array(N);
    this.vx = new Float32Array(N);
    this.vy = new Float32Array(N);
    this.tal = new Float32Array(N).fill(this.p.talusDry);
    // scratch
    this._k = new Float32Array(N).fill(1);
    this._c = new Float32Array(N);
    this._d = new Float32Array(N);
    this._head = new Float32Array(N);
    this._avail = new Float32Array(N);
    // per-row column range of wet cells (and the range last step)
    this._min = new Int32Array(H).fill(W);
    this._max = new Int32Array(H).fill(-1);
    this._pmin = new Int32Array(H).fill(W);
    this._pmax = new Int32Array(H).fill(-1);
    this._x0 = new Int32Array(H);
    this._x1 = new Int32Array(H);
    // per-row column range of sand that may be unstable (marks from this and the previous slip pass)
    this._smin = new Int32Array(H).fill(W);
    this._smax = new Int32Array(H).fill(-1);
    this._tmin = new Int32Array(H).fill(W);
    this._tmax = new Int32Array(H).fill(-1);
    this._u0 = new Int32Array(H);
    this._u1 = new Int32Array(H);
    this.springs = [];
    this.tick = 0;
    // statistics for sound and tests
    this.flowEnergy = 0;
    this.wetCells = 0;
    this.slipMoved = 0;
  }

  /** First row of the open sea. */
  get seaStart() { return this.H - this.p.seaRows; }

  /** Sea level right now, including the slow swell. */
  seaLevelNow() {
    const { seaLevel, tideAmp, tidePeriod } = this.p;
    return seaLevel + tideAmp * Math.sin(this.tick * (2 * Math.PI / tidePeriod));
  }

  // ---------------------------------------------------------------- setup

  /** Rebuild all bookkeeping from the fields (after loading or bulk edits). */
  rescan() {
    const { W, H, w } = this;
    const sea = this.seaStart;
    for (let y = 0; y < H; y++) {
      let mn = W, mx = -1;
      if (y < sea) {
        const r = y * W;
        for (let x = 0; x < W; x++) {
          if (w[r + x] > 0) { if (x < mn) mn = x; mx = x; }
        }
      }
      this._min[y] = mn; this._max[y] = mx;
      this._pmin[y] = 0; this._pmax[y] = W - 1;
      this._smin[y] = 0; this._smax[y] = W - 1;
      this._tmin[y] = 0; this._tmax[y] = W - 1;
    }
    this._k.fill(1);
    this._c.fill(0);
  }

  /** Fill everything below sea level and set the resting water table. */
  settle() {
    const { N, b, w, g, s, p } = this;
    this.l.fill(0);
    for (let i = 0; i < N; i++) {
      const bi = b[i];
      w[i] = bi < p.seaLevel ? p.seaLevel - bi : 0;
      s[i] = 0;
      let gi = Math.max(bi - p.dryDepth, p.seaLevel);
      if (gi > bi) gi = bi;
      if (gi < 0) gi = 0;
      g[i] = gi;
    }
    this.fx.fill(0); this.fy.fill(0); this.vx.fill(0); this.vy.fill(0);
    this.tick = 0;
    this.rescan();
    for (let band = 0; band < 4; band++) this._groundwater(band, true);
  }

  // ---------------------------------------------------------------- tools

  _wetMark(x, y) {
    if (y >= this.seaStart) return;
    if (x < this._min[y]) this._min[y] = x;
    if (x > this._max[y]) this._max[y] = x;
  }

  /** Flag sand in a box as possibly unstable so the next slip passes look at it. */
  _slipMark(x0, x1, y0, y1) {
    const { W, H, _smin: a, _smax: z } = this;
    if (x0 < 0) x0 = 0;
    if (x1 > W - 1) x1 = W - 1;
    if (y0 < 0) y0 = 0;
    if (y1 > H - 1) y1 = H - 1;
    for (let y = y0; y <= y1; y++) {
      if (x0 < a[y]) a[y] = x0;
      if (x1 > z[y]) z[y] = x1;
    }
  }

  /** Apply fn(i, falloff 0..1, x, y) over a soft round brush. */
  _brush(cx, cy, r, fn) {
    const { W, H } = this;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy, d2 = dx * dx + dy * dy;
        if (d2 >= r2) continue;
        const t = 1 - d2 / r2;
        fn(x + y * W, t * t, x, y);
      }
    }
  }

  /**
   * Scoop sand out. A share of it is pushed up around the rim, the way a
   * finger dragged through sand leaves a ridge on both sides.
   * Returns the volume removed.
   */
  dig(cx, cy, r, amount, rimShare = 0.5) {
    const { W, H, b, l } = this;
    const digLoose = this.p.digLoose;
    let removed = 0;
    this._brush(cx, cy, r, (i, f) => {
      let d = amount * f;
      if (d > b[i]) d = b[i];
      b[i] -= d;
      removed += d;
      // the scoop takes loose sand first and leaves the sand beneath it disturbed
      let li = l[i] - d;
      const stirred = digLoose * (f > 0.25 ? 1 : f * 4);
      if (li < stirred) li = stirred;
      if (li > b[i]) li = b[i];
      l[i] = li;
    });
    const ro = r * 1.7;
    this._slipMark(Math.floor(cx - ro) - 1, Math.ceil(cx + ro) + 1, Math.floor(cy - ro) - 1, Math.ceil(cy + ro) + 1);
    if (removed <= 0 || rimShare <= 0) return removed;
    const ri = r * 0.85, span = ro - ri;
    const x0 = Math.max(0, Math.floor(cx - ro)), x1 = Math.min(W - 1, Math.ceil(cx + ro));
    const y0 = Math.max(0, Math.floor(cy - ro)), y1 = Math.min(H - 1, Math.ceil(cy + ro));
    const sea = this.seaStart;
    let wsum = 0;
    for (let pass = 0; pass < 2; pass++) {
      const k = pass ? removed * rimShare / wsum : 0;
      if (pass && !(wsum > 0)) break;
      for (let y = y0; y <= y1; y++) {
        if (y >= sea) continue;
        for (let x = x0; x <= x1; x++) {
          const t = (Math.hypot(x - cx, y - cy) - ri) / span;
          if (t <= 0 || t >= 1) continue;
          const q = t * (1 - t) * 4;
          if (pass) {
            const i = x + y * W, add = Math.min(q * k, Math.max(0, this.p.maxHeight - b[i]));
            b[i] += add; l[i] += add;
          } else wsum += q;
        }
      }
    }
    return removed;
  }

  /** Heap sand. Returns the volume added. */
  pile(cx, cy, r, amount) {
    const { b, l } = this;
    const sea = this.seaStart;
    let added = 0;
    const top = this.p.maxHeight;
    this._brush(cx, cy, r, (i, f, x, y) => {
      if (y >= sea) return;
      const add = Math.min(amount * f, top - b[i]);
      if (add <= 0) return;
      b[i] += add; l[i] += add; added += add;
    });
    this._slipMark(Math.floor(cx - r) - 1, Math.ceil(cx + r) + 1, Math.floor(cy - r) - 1, Math.ceil(cy + r) + 1);
    return added;
  }

  /** Pour water. */
  pour(cx, cy, r, amount) {
    const { w } = this;
    this._brush(cx, cy, r, (i, f, x, y) => { w[i] += amount * f; this._wetMark(x, y); });
  }

  /**
   * Pat the sand: blend heights toward the brush average (conserves sand)
   * and press loose sand firm, so a patted dam stands up to water better.
   */
  smooth(cx, cy, r, strength) {
    const { b, l } = this;
    let sum = 0, wsum = 0;
    this._brush(cx, cy, r, (i, f) => { sum += b[i] * f; wsum += f; });
    if (wsum <= 0) return;
    const mean = sum / wsum;
    this._brush(cx, cy, r, (i, f) => {
      b[i] += (mean - b[i]) * strength * f;
      l[i] *= 1 - Math.min(1, strength * f * 1.5);
    });
    this._slipMark(Math.floor(cx - r) - 1, Math.ceil(cx + r) + 1, Math.floor(cy - r) - 1, Math.ceil(cy + r) + 1);
  }

  // ---------------------------------------------------------------- step

  step() {
    this._sources();
    this._extents();
    this._flux();
    this._advect();
    this._erode();
    this._slip((this.tick & 1) === 0);
    this._groundwater(this.tick & 3, false);
    this._sea();
    this.tick++;
  }

  _sources() {
    const { w } = this;
    for (const sp of this.springs) {
      if (!(sp.rate > 0)) continue;
      const r = sp.r || 2.5;
      // normalise so that `rate` is the total volume added per step
      let sum = 0;
      this._brush(sp.x, sp.y, r, (i, f) => { sum += f; });
      if (sum <= 0) continue;
      const k = sp.rate / sum;
      this._brush(sp.x, sp.y, r, (i, f, x, y) => { w[i] += k * f; this._wetMark(x, y); });
    }
  }

  /** Per-row column range covering wet cells, their neighbours, and cells that were wet last step. */
  _extents() {
    const { W, H, _min: mn, _max: mx, _pmin: pmn, _pmax: pmx, _x0: X0, _x1: X1 } = this;
    const sea = this.seaStart;
    for (let y = 0; y < H; y++) {
      if (y >= sea) { X0[y] = 0; X1[y] = -1; continue; }
      if (y === sea - 1) { X0[y] = 0; X1[y] = W - 1; continue; } // always borders the open sea
      let a = Math.min(mn[y], pmn[y]), z = Math.max(mx[y], pmx[y]);
      if (y > 0) { a = Math.min(a, mn[y - 1], pmn[y - 1]); z = Math.max(z, mx[y - 1], pmx[y - 1]); }
      if (y < H - 1) { a = Math.min(a, mn[y + 1], pmn[y + 1]); z = Math.max(z, mx[y + 1], pmx[y + 1]); }
      if (z < 0) { X0[y] = 0; X1[y] = -1; continue; }
      X0[y] = a > 0 ? a - 1 : 0;
      X1[y] = z < W - 1 ? z + 1 : W - 1;
    }
    for (let y = 0; y < H; y++) { pmn[y] = mn[y]; pmx[y] = mx[y]; }
  }

  _flux() {
    const { W, H, b, w, fx, fy, _x0: X0, _x1: X1 } = this;
    const { G, dCap, k1, k2 } = this.p;
    const fr1 = 1 + k1;
    const lastX = W - 1;
    for (let y = 0; y < H; y++) {
      const xa = X0[y], xb = X1[y];
      if (xb < xa) continue;
      const row = y * W;
      const hasDown = y < H - 1;
      for (let x = xa; x <= xb; x++) {
        const i = row + x;
        const bi = b[i], ei = bi + w[i];
        if (x < lastX) {
          const j = i + 1, bj = b[j], ej = bj + w[j];
          const d = (ei > ej ? ei : ej) - (bi > bj ? bi : bj);
          if (d <= 0) fx[i] = 0;
          else {
            let f = fx[i] + G * (d < dCap ? d : dCap) * (ei - ej);
            f /= fr1 + k2 * (f < 0 ? -f : f) / (d * d + 1e-4);
            fx[i] = (f < FLUX_EPS && f > -FLUX_EPS) ? 0 : f;
          }
        }
        if (hasDown) {
          const j = i + W, bj = b[j], ej = bj + w[j];
          const d = (ei > ej ? ei : ej) - (bi > bj ? bi : bj);
          if (d <= 0) fy[i] = 0;
          else {
            let f = fy[i] + G * (d < dCap ? d : dCap) * (ei - ej);
            f /= fr1 + k2 * (f < 0 ? -f : f) / (d * d + 1e-4);
            fy[i] = (f < FLUX_EPS && f > -FLUX_EPS) ? 0 : f;
          }
        }
      }
    }
  }

  /** Limit outflow to the water available, then move water and suspended sand. */
  _advect() {
    const { W, H, b, w, s, l, fx, fy, vx, vy, _k: K, _c: C, _x0: X0, _x1: X1, _min: mn, _max: mx } = this;
    const vMinDepth = this.p.vMinDepth;
    const lastX = W - 1;
    // pass 1: outflow scale and sediment concentration per cell
    for (let y = 0; y < H; y++) {
      const xa = X0[y], xb = X1[y];
      if (xb < xa) continue;
      const row = y * W;
      for (let x = xa; x <= xb; x++) {
        const i = row + x;
        let out = 0, f;
        f = fx[i]; if (f > 0) out += f;
        if (x > 0) { f = fx[i - 1]; if (f < 0) out -= f; }
        f = fy[i]; if (f > 0) out += f;
        if (y > 0) { f = fy[i - W]; if (f < 0) out -= f; }
        const wi = w[i];
        K[i] = out > wi ? wi / out : 1;
        C[i] = wi > WATER_EPS ? s[i] / wi : 0;
      }
    }
    // pass 2: scale each face by its donor cell
    for (let y = 0; y < H; y++) {
      const xa = X0[y], xb = X1[y];
      if (xb < xa) continue;
      const row = y * W;
      for (let x = xa; x <= xb; x++) {
        const i = row + x;
        if (x < lastX) { const f = fx[i]; if (f > 0) fx[i] = f * K[i]; else if (f < 0) fx[i] = f * K[i + 1]; }
        if (y < H - 1) { const f = fy[i]; if (f > 0) fy[i] = f * K[i]; else if (f < 0) fy[i] = f * K[i + W]; }
      }
    }
    // pass 3: update depth, sediment, velocity and the wet extents
    let energy = 0, wet = 0;
    for (let y = 0; y < H; y++) {
      const xa = X0[y], xb = X1[y];
      if (xb < xa) { mn[y] = W; mx[y] = -1; continue; }
      let lo = W, hi = -1;
      const row = y * W;
      for (let x = xa; x <= xb; x++) {
        const i = row + x;
        const fr = fx[i], fd = fy[i];
        const fl = x > 0 ? fx[i - 1] : 0, fu = y > 0 ? fy[i - W] : 0;
        let wi = w[i] + fl - fr + fu - fd;
        let si = s[i];
        if (fr !== 0) si -= fr * (fr > 0 ? C[i] : C[i + 1]);
        if (fd !== 0) si -= fd * (fd > 0 ? C[i] : C[i + W]);
        if (fl !== 0) si += fl * (fl > 0 ? C[i - 1] : C[i]);
        if (fu !== 0) si += fu * (fu > 0 ? C[i - W] : C[i]);
        if (wi < WATER_EPS) {
          // dried out: whatever sand was still afloat settles here
          wi = 0;
          if (si > 0) { b[i] += si; l[i] += si; }
          si = 0;
          vx[i] = 0; vy[i] = 0;
        } else {
          if (si < 0) si = 0;
          const inv = 1 / (wi > vMinDepth ? wi : vMinDepth);
          const qx = 0.5 * (fl + fr) * inv, qy = 0.5 * (fu + fd) * inv;
          vx[i] = qx; vy[i] = qy;
          energy += (qx * qx + qy * qy) * (wi < 1 ? wi : 1);
          wet++;
          if (x < lo) lo = x;
          hi = x;
        }
        w[i] = wi; s[i] = si;
      }
      mn[y] = lo; mx[y] = hi;
    }
    this.flowEnergy = energy;
    this.wetCells = wet;
  }

  _erode() {
    const { W, H, b, w, s, l, vx, vy, _min: mn, _max: mx, _smin: sa, _smax: sz } = this;
    const { vc2Hard, vc2Loose, looseBlend, Kc, cMax, Ks, KsFirm, Kd, vMinDepth } = this.p;
    const vcSpan = (vc2Loose - vc2Hard) / looseBlend, ksSpan = (Ks - KsFirm) / looseBlend;
    for (let y = 0; y < H; y++) {
      const xa = mn[y], xb = mx[y];
      if (xb < xa) continue;
      const row = y * W;
      let lo = W, hi = -1;
      for (let x = xa; x <= xb; x++) {
        const i = row + x;
        const wi = w[i];
        if (wi <= 0) continue;
        const u = vx[i], v = vy[i];
        const li = l[i];
        const ex = u * u + v * v - (li < looseBlend ? vc2Hard + vcSpan * li : vc2Loose);
        let seq = 0;
        if (ex > 0) {
          let c = Kc * ex / (wi > vMinDepth ? wi : vMinDepth);
          if (c > cMax) c = cMax;
          seq = c * wi;
        }
        const si = s[i];
        let d;
        if (seq > si) {
          d = (li < looseBlend ? KsFirm + ksSpan * li : Ks) * (seq - si);
          const bi = b[i];
          if (d > bi) d = bi;
          b[i] = bi - d; s[i] = si + d;
          l[i] = li > d ? li - d : 0;
        } else if (si > 0) {
          d = Kd * (si - seq);
          b[i] += d; s[i] = si - d;
          l[i] = li + d;
        } else continue;
        if (d > BED_EPS) { if (x < lo) lo = x; hi = x; }
      }
      if (hi >= 0) {
        if (lo < sa[y]) sa[y] = lo;
        if (hi > sz[y]) sz[y] = hi;
      }
    }
  }

  /** Slide sand wherever a slope is steeper than the sand there can hold. */
  _slip(orthogonal) {
    const { W, H, b, l, tal, _d: D, _smin: sa, _smax: sz, _tmin: ta, _tmax: tz, _u0: U0, _u1: U1 } = this;
    const rate = this.p.slipRate;
    const lastX = W - 1;
    // range of pair origins per row: marks on this row or the next, widened by one
    let any = false;
    for (let y = 0; y < H; y++) {
      let a = Math.min(sa[y], ta[y]), z = Math.max(sz[y], tz[y]);
      if (y < H - 1) { a = Math.min(a, sa[y + 1], ta[y + 1]); z = Math.max(z, sz[y + 1], tz[y + 1]); }
      if (z < 0) { U0[y] = 0; U1[y] = -1; continue; }
      U0[y] = a > 0 ? a - 1 : 0;
      U1[y] = z < lastX ? z + 1 : lastX;
      any = true;
    }
    // this pass's marks become the previous ones; movement found below makes the new marks
    for (let y = 0; y < H; y++) { ta[y] = sa[y]; tz[y] = sz[y]; sa[y] = W; sz[y] = -1; }
    this.slipMoved = 0;
    if (!any) return;
    let moved = 0;
    if (orthogonal) {
      for (let y = 0; y < H; y++) {
        const xa = U0[y], xb = U1[y];
        if (xb < xa) continue;
        const row = y * W, hasDown = y < H - 1;
        for (let x = xa; x <= xb; x++) {
          const i = row + x, bi = b[i];
          if (x < lastX) {
            const j = i + 1, diff = bi - b[j];
            if (diff > 0) { const e = diff - tal[i]; if (e > 0) { const m = e * rate; D[i] -= m; D[j] += m; moved += m; } }
            else { const e = -diff - tal[j]; if (e > 0) { const m = e * rate; D[i] += m; D[j] -= m; moved += m; } }
          }
          if (hasDown) {
            const j = i + W, diff = bi - b[j];
            if (diff > 0) { const e = diff - tal[i]; if (e > 0) { const m = e * rate; D[i] -= m; D[j] += m; moved += m; } }
            else { const e = -diff - tal[j]; if (e > 0) { const m = e * rate; D[i] += m; D[j] -= m; moved += m; } }
          }
        }
      }
    } else {
      const SQ = Math.SQRT2;
      for (let y = 0; y < H - 1; y++) {
        const xa = U0[y], xb = U1[y];
        if (xb < xa) continue;
        const row = y * W;
        for (let x = xa; x <= xb; x++) {
          const i = row + x, bi = b[i];
          if (x < lastX) {
            const j = i + W + 1, diff = bi - b[j];
            if (diff > 0) { const e = diff - tal[i] * SQ; if (e > 0) { const m = e * rate; D[i] -= m; D[j] += m; moved += m; } }
            else { const e = -diff - tal[j] * SQ; if (e > 0) { const m = e * rate; D[i] += m; D[j] -= m; moved += m; } }
          }
          if (x > 0) {
            const j = i + W - 1, diff = bi - b[j];
            if (diff > 0) { const e = diff - tal[i] * SQ; if (e > 0) { const m = e * rate; D[i] -= m; D[j] += m; moved += m; } }
            else { const e = -diff - tal[j] * SQ; if (e > 0) { const m = e * rate; D[i] += m; D[j] -= m; moved += m; } }
          }
        }
      }
    }
    this.slipMoved = moved;
    if (moved <= 0) return;
    // apply; each row can receive sand from pairs starting on it or on the row above
    for (let y = 0; y < H; y++) {
      let a = U0[y], z = U1[y];
      if (y > 0 && U1[y - 1] >= U0[y - 1]) {
        if (z < a) { a = U0[y - 1]; z = U1[y - 1]; }
        else { if (U0[y - 1] < a) a = U0[y - 1]; if (U1[y - 1] > z) z = U1[y - 1]; }
      }
      if (z < a) continue;
      if (a > 0) a--;
      if (z < lastX) z++;
      const row = y * W;
      let lo = W, hi = -1;
      for (let x = a; x <= z; x++) {
        const d = D[row + x];
        if (d !== 0) {
          // sand that slides is loose where it lands; a slide strips the loose layer first
          const li = l[row + x] + d;
          l[row + x] = li > 0 ? li : 0;
          b[row + x] += d; D[row + x] = 0;
          if (d > BED_EPS || d < -BED_EPS) { if (x < lo) lo = x; hi = x; }
        }
      }
      sa[y] = lo; sz[y] = hi;
    }
  }

  /**
   * Soak in, seep sideways through the sand, well up where the table meets
   * the surface, and dry out. The grid is split into four horizontal bands
   * and one band is handled per step to spread the cost.
   *
   * Each cell has a hydraulic head: the water surface where water stands on
   * it, otherwise its water table. Water moves between neighbours in
   * proportion to the difference. A cell that loses water gives up standing
   * water first and pore water after that; a cell that gains fills its pores
   * first and anything left over wells up onto the surface.
   */
  _groundwater(band, init) {
    const { W, H, b, w, g, tal, _head: head, _avail: avail, _d: D, _min: mn, _max: mx, _smin: sa, _smax: sz } = this;
    const { Sy, Ki, KT, dryDepth, dryRate, moistDepth, talusDry, talusMoist, talusWet } = this.p;
    const invSy = 1 / Sy;
    const y0 = (H * band) >> 2, y1 = (H * (band + 1)) >> 2;
    const yEnd = y1 < H ? y1 : H - 1; // includes one halo row below the band
    const sea = this.seaStart;
    const lastX = W - 1;
    for (let y = y0; y <= yEnd; y++) {
      const row = y * W, own = y < y1;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        let gi = g[i];
        const bi = b[i];
        let wi = w[i];
        if (gi > bi) {
          // sand was removed below the water table: its pore water is now standing water
          wi += (gi - bi) * Sy; gi = bi; w[i] = wi; g[i] = gi;
          if (y < sea) { if (x < mn[y]) mn[y] = x; if (x > mx[y]) mx[y] = x; }
        } else if (own && wi > 0 && gi < bi) {
          // standing water soaks into the sand below it
          let inf = (bi - gi) * Sy;
          if (inf > Ki) inf = Ki;
          if (inf > wi) inf = wi;
          wi -= inf; gi += inf * invSy;
          w[i] = wi; g[i] = gi;
        }
        head[i] = wi > 0 ? bi + wi : gi;
        avail[i] = (wi + gi * Sy) * 0.2; // the most one neighbour may take this visit
      }
    }
    for (let y = y0; y < y1; y++) {
      const row = y * W, hasDown = y < H - 1;
      for (let x = 0; x < W; x++) {
        const i = row + x, hi = head[i];
        if (x < lastX) {
          const j = i + 1;
          let q = KT * (hi - head[j]);
          if (q > 0) { if (q > avail[i]) q = avail[i]; } else if (-q > avail[j]) q = -avail[j];
          D[i] -= q; D[j] += q;
        }
        if (hasDown) {
          const j = i + W;
          let q = KT * (hi - head[j]);
          if (q > 0) { if (q > avail[i]) q = avail[i]; } else if (-q > avail[j]) q = -avail[j];
          D[i] -= q; D[j] += q;
        }
      }
    }
    const talSpan = talusMoist - talusDry, invMoist = 1 / moistDepth;
    for (let y = y0; y <= yEnd; y++) {
      const row = y * W, own = y < y1;
      let lo = W, hi = -1, slo = W, shi = -1;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        const bi = b[i];
        let gi = g[i], wi = w[i];
        const d = D[i];
        if (d !== 0) {
          D[i] = 0;
          if (d > 0) {
            const room = (bi - gi) * Sy;
            if (d <= room) gi += d * invSy;
            else {
              // the table reached the surface: water wells up
              gi = bi; wi += d - room;
              if (wi > WATER_EPS) { if (x < lo) lo = x; hi = x; }
            }
          } else if (wi >= -d) wi += d;
          else {
            gi += (d + wi) * invSy; wi = 0;
            if (gi < 0) gi = 0;
          }
          w[i] = wi;
        }
        if (!own) { g[i] = gi; continue; }
        const depth = bi - gi;
        if (wi <= 0 && depth < dryDepth && !init) {
          gi -= dryRate * (dryDepth - depth);
          if (gi < 0) gi = 0;
        }
        g[i] = gi;
        let t;
        if (wi > 0.03 || depth < 0.06) t = talusWet;
        else {
          let m = 1 - (depth - 0.1) * invMoist;
          m = m < 0 ? 0 : m > 1 ? 1 : m;
          t = talusDry + talSpan * m;
        }
        // sand that just got weaker may start to slide
        const old = tal[i];
        if (t < old && ((t * 16) | 0) < ((old * 16) | 0)) { if (x < slo) slo = x; shi = x; }
        tal[i] = t;
      }
      if (hi >= 0 && y < sea) { if (lo < mn[y]) mn[y] = lo; if (hi > mx[y]) mx[y] = hi; }
      if (shi >= 0) { if (slo < sa[y]) sa[y] = slo; if (shi > sz[y]) sz[y] = shi; }
    }
  }

  /** The open edge: the sea holds its level there and carries away whatever reaches it. */
  _sea() {
    const { W, H, b, w, s } = this;
    const { seaLevel, seaRows, seaDeep } = this.p;
    if (seaRows <= 0) return;
    const level = this.seaLevelNow();
    const bedMax = seaLevel - seaDeep;
    for (let i = (H - seaRows) * W, n = H * W; i < n; i++) {
      let bi = b[i];
      if (bi > bedMax) { bi = bedMax; b[i] = bi; }
      w[i] = level - bi;
      s[i] = 0;
    }
  }

  // ---------------------------------------------------------------- totals (for tests)

  /** Sand, surface water and groundwater volumes outside the open sea. */
  totals() {
    const { W, b, w, g, s } = this;
    const n = this.seaStart * W;
    let sand = 0, water = 0, ground = 0;
    for (let i = 0; i < n; i++) { sand += b[i] + s[i]; water += w[i]; ground += g[i]; }
    return { sand, water, ground: ground * this.p.Sy };
  }
}
