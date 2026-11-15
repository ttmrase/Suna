// Initial beach: a gentle slope running from the top of the screen down into
// the sea, with a small creek that already winds its way across it.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise built from a random lattice with the given cell size. */
function valueNoise(W, H, cell, rand) {
  const gw = Math.ceil(W / cell) + 2, gh = Math.ceil(H / cell) + 2;
  const lattice = new Float32Array(gw * gh);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand() * 2 - 1;
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = y / cell, iy = Math.floor(fy);
    let ty = fy - iy; ty = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < W; x++) {
      const fx = x / cell, ix = Math.floor(fx);
      let tx = fx - ix; tx = tx * tx * (3 - 2 * tx);
      const a = lattice[ix + iy * gw], b = lattice[ix + 1 + iy * gw];
      const c = lattice[ix + (iy + 1) * gw], d = lattice[ix + 1 + (iy + 1) * gw];
      out[x + y * W] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

export const BEACH = {
  shoreCells: 18,   // rows of simulated sea between the waterline and the open edge
  slope: 0.05,      // beach gradient above the waterline
  seaSlope: 0.14,   // gradient below the waterline
  springY: 0.085,   // spring position as a fraction of the height
  creekDepth: 1.55,
  creekHalfWidth: 3.7,
  springRate: 1.4,
};

/** Row where the dry beach meets the sea. */
export function shoreRow(sim) {
  return sim.H - sim.p.seaRows - BEACH.shoreCells;
}

/** Shape the sand, carve the creek, flood the sea and put a spring at the creek's head. */
export function makeBeach(sim, seed = 1) {
  const { W, H, b } = sim;
  const rand = mulberry32(seed);
  const big = valueNoise(W, H, 46, rand);
  const mid = valueNoise(W, H, 17, rand);
  const small = valueNoise(W, H, 6, rand);
  const L = sim.p.seaLevel;
  const shoreY = shoreRow(sim);
  const springY = Math.round(BEACH.springY * H);

  // creek centre line: two superposed meanders, growing from nothing at the spring
  const p1 = rand() * Math.PI * 2, p2 = rand() * Math.PI * 2;
  const l1 = 95 + rand() * 40, l2 = 41 + rand() * 16;
  const side = rand() < 0.5 ? -1 : 1;
  const centre = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const t = Math.max(0, y - springY);
    const grow = 1 - Math.exp(-t / 28);
    const m = Math.sin(t * 2 * Math.PI / l1 + p1) - Math.sin(p1);
    const n = Math.sin(t * 2 * Math.PI / l2 + p2) - Math.sin(p2);
    centre[y] = W * 0.5 + side * grow * (W * 0.12 * m + W * 0.045 * n);
    centre[y] = Math.min(W - 14, Math.max(14, centre[y]));
  }

  for (let y = 0; y < H; y++) {
    const d = shoreY - y; // cells above the waterline
    // how strongly the creek is cut at this row: from the spring down to just past the waterline
    const cut = Math.min(1, Math.max(0, (y - springY + 4) / 5)) * Math.min(1, Math.max(0, (d + 14) / 14));
    const dc = y > 0 && y < H - 1 ? (centre[y + 1] - centre[y - 1]) * 0.5 : 0;
    const across = 1 / Math.sqrt(1 + dc * dc); // measure distance perpendicular to the channel
    for (let x = 0; x < W; x++) {
      const i = x + y * W;
      let h = d > 0 ? L + d * BEACH.slope : L + d * BEACH.seaSlope;
      // raise the two sides slightly so water keeps away from the edges
      const u = (x / (W - 1)) * 2 - 1;
      h += 0.9 * u * u * u * u;
      // undulations fade out under the sea
      const fade = Math.min(1, Math.max(0.15, (d + 10) / 30));
      h += (big[i] * 0.5 + mid[i] * 0.2 + small[i] * 0.05) * fade;
      if (cut > 0) {
        const q = (x - centre[y]) * across / BEACH.creekHalfWidth;
        h -= BEACH.creekDepth * cut * Math.exp(-q * q);
      }
      b[i] = Math.max(1.2, h);
    }
  }
  // a small round basin where the water wells up
  const sx = centre[springY], sy = springY;
  sim._brush(sx, sy, 6.5, (i, f) => { b[i] -= 0.55 * f; });

  sim.springs.length = 0;
  sim.springs.push({ x: sx, y: sy, rate: BEACH.springRate, r: 2.5 });
  sim.settle();
}
