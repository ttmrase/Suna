// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../app/src/main/assets/www/js/sim.js';
import { makeBeach } from '../app/src/main/assets/www/js/terrain.js';

/** A closed sandbox: no sea, no drying, so volumes can be checked exactly. */
function box(W, H, shape, params = {}) {
  const sim = new Sim(W, H, { seaRows: 0, tideAmp: 0, dryRate: 0, ...params });
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) sim.b[x + y * W] = shape(x, y);
  // water table well below the surface everywhere
  for (let i = 0; i < sim.N; i++) sim.g[i] = Math.max(0, sim.b[i] - 1.5);
  sim.rescan();
  return sim;
}
function run(sim, steps) { for (let i = 0; i < steps; i++) sim.step(); }
function finite(sim) {
  for (const f of ['b', 'w', 'g', 's', 'l', 'fx', 'fy', 'vx', 'vy']) {
    for (let i = 0; i < sim.N; i++) if (!Number.isFinite(sim[f][i])) return `${f}[${i}] = ${sim[f][i]}`;
  }
  return null;
}
const bowl = (W, H) => (x, y) => 6 + 0.012 * ((x - W / 2) ** 2 + (y - H / 2) ** 2);

test('water poured into a bowl is conserved and comes to rest level', () => {
  const W = 48, H = 48;
  const sim = box(W, H, bowl(W, H));
  for (let k = 0; k < 40; k++) sim.pour(10, 12, 4, 0.5);
  const before = sim.totals();
  // long enough that a deep pond has soaked the sand under and around it
  run(sim, 20000);
  const after = sim.totals();
  assert.equal(finite(sim), null);
  const total0 = before.water + before.ground, total1 = after.water + after.ground;
  assert.ok(Math.abs(total1 - total0) < total0 * 1e-3, `water ${total0} -> ${total1}`);
  // the pond's surface is flat
  let lo = Infinity, hi = -Infinity, wet = 0;
  for (let i = 0; i < sim.N; i++) {
    if (sim.w[i] > 0.05) { const e = sim.b[i] + sim.w[i]; lo = Math.min(lo, e); hi = Math.max(hi, e); wet++; }
  }
  assert.ok(wet > 20, 'a pond formed');
  assert.ok(hi - lo < 0.02, `surface spread ${hi - lo}`);
  for (let i = 0; i < sim.N; i++) assert.ok(sim.w[i] >= 0 && sim.s[i] >= 0);
});

test('sand is conserved by erosion, deposition and slides', () => {
  const W = 40, H = 90;
  const sim = box(W, H, (x, y) => 14 - y * 0.08 + 0.02 * (x - W / 2) ** 2 - (Math.abs(x - W / 2) < 3 ? 1 : 0));
  sim.springs.push({ x: W / 2, y: 6, rate: 1.2, r: 2.5 });
  // loosen the channel so that plenty of sand moves
  for (let y = 4; y < H - 4; y += 2) sim.dig(W / 2, y, 3.5, 0.1, 1);
  const sand0 = sim.totals().sand;
  run(sim, 4000);
  assert.equal(finite(sim), null);
  let moved = 0;
  for (let i = 0; i < sim.N; i++) moved += sim.l[i];
  assert.ok(moved > 10, 'water moved sand');
  const sand1 = sim.totals().sand;
  assert.ok(Math.abs(sand1 - sand0) < sand0 * 2e-4, `sand ${sand0} -> ${sand1}`);
});

test('a heap of dry sand settles to its angle of repose', () => {
  const W = 41, H = 41;
  const sim = box(W, H, () => 4);
  for (let k = 0; k < 30; k++) sim.pile(20, 20, 3, 0.5);
  const sand0 = sim.totals().sand;
  run(sim, 800);
  const sand1 = sim.totals().sand;
  assert.ok(Math.abs(sand1 - sand0) < 1e-2 * sand0);
  let steepest = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) {
    steepest = Math.max(steepest, Math.abs(sim.b[x + y * W] - sim.b[x + 1 + y * W]));
  }
  assert.ok(steepest <= sim.p.talusDry * 1.05, `steepest slope ${steepest}`);
  assert.ok(sim.b[20 + 20 * W] > 6, 'a heap remains');
});

test('a ridge holds water back, but the water seeps through the sand', () => {
  const W = 60, H = 30;
  // two basins separated by a ridge 3 above the floor of the basins
  const shape = (x) => 6 + (Math.abs(x - 30) < 4 ? 3 : 0) + (x < 3 || x > W - 4 ? 5 : 0);
  const dry = box(W, H, shape, { KT: 0 });
  const leaky = box(W, H, shape);
  for (const sim of [dry, leaky]) {
    for (let i = 0; i < sim.N; i++) if ((i % W) < 26 && (i % W) >= 3) sim.w[i] = 2.2; // left basin filled below the crest
    sim.rescan();
    run(sim, 9000);
    assert.equal(finite(sim), null);
  }
  const rightWater = (sim) => { let t = 0; for (let i = 0; i < sim.N; i++) if ((i % W) > 34) t += sim.w[i]; return t; };
  assert.equal(rightWater(dry), 0, 'nothing crosses an impermeable ridge');
  assert.ok(rightWater(leaky) > 1, `seepage reached the far side (${rightWater(leaky)})`);
});

test('running water deepens a freshly dug groove but leaves firm sand under a thin sheet alone', () => {
  const W = 40, H = 100;
  const slope = (x, y) => 14 - y * 0.05;
  // a groove with water concentrated in it
  const groove = box(W, H, slope);
  for (let y = 3; y < H - 3; y++) groove.dig(W / 2, y, 3, 0.25, 0);
  groove.springs.push({ x: W / 2, y: 5, rate: 0.9, r: 2 });
  const bed0 = groove.b[W / 2 + 30 * W];
  run(groove, 6000);
  const bed1 = groove.b[W / 2 + 30 * W];
  assert.ok(bed1 < bed0 - 0.25, `groove bed ${bed0} -> ${bed1}`);

  // the same water spread thin over untouched sand
  const sheet = box(W, H, slope);
  for (let x = 4; x < W - 4; x += 4) sheet.springs.push({ x, y: 5, rate: 0.1, r: 2 });
  const before = Float32Array.from(sheet.b);
  run(sheet, 3000);
  let worst = 0;
  for (let y = 20; y < H - 20; y++) for (let x = 6; x < W - 6; x++) {
    worst = Math.max(worst, Math.abs(sheet.b[x + y * W] - before[x + y * W]));
  }
  assert.ok(worst < 0.02, `firm sand moved by ${worst}`);
});

test('digging near the sea brings water up through the sand', () => {
  const sim = new Sim(64, 120);
  makeBeach(sim, 3);
  sim.springs[0].rate = 0;
  const y = sim.seaStart - 30, x = 12;
  assert.ok(sim.b[x + y * sim.W] > sim.p.seaLevel + 0.2, 'the spot starts above sea level');
  for (let k = 0; k < 60; k++) sim.dig(x, y, 5, 0.1);
  assert.ok(sim.b[x + y * sim.W] < sim.p.seaLevel - 0.5, 'the hole reaches below sea level');
  run(sim, 2400);
  assert.ok(sim.w[x + y * sim.W] > 0.2, `water in the hole: ${sim.w[x + y * sim.W]}`);
});

test('tools: digging moves sand to the rim, patting keeps volume and firms the sand', () => {
  const W = 40, H = 40;
  const sim = box(W, H, () => 10);
  const t0 = sim.totals().sand;
  const removed = sim.dig(20, 20, 5, 0.6, 0.5);
  assert.ok(removed > 0);
  assert.ok(Math.abs(t0 - sim.totals().sand - removed * 0.5) < 1e-2, 'half of the scoop lands on the rim');
  assert.ok(sim.b[20 + 20 * W] < 10 && sim.b[27 + 20 * W] > 10);
  assert.ok(sim.l[20 + 20 * W] > 0, 'dug sand is loose');
  const t1 = sim.totals().sand;
  for (let k = 0; k < 20; k++) sim.smooth(20, 20, 8, 0.3);
  assert.ok(Math.abs(sim.totals().sand - t1) < 1e-2 * t1 / 100, 'patting conserves sand');
  assert.ok(sim.l[20 + 20 * W] < 0.01, 'patted sand is firm');
});

test('the beach stays well-behaved over ten minutes of play time', () => {
  const sim = new Sim(96, 210);
  makeBeach(sim, 11);
  let peak = 0;
  for (let i = 0; i < 72000; i++) {
    sim.step();
    if (i % 4000 === 0) {
      for (let k = 0; k < sim.N; k++) peak = Math.max(peak, Math.abs(sim.vx[k]), Math.abs(sim.vy[k]));
    }
  }
  assert.equal(finite(sim), null);
  assert.ok(peak < 2, `peak speed ${peak}`);
  // the creek still reaches the sea and has not flooded the beach
  assert.ok(sim.wetCells > 800 && sim.wetCells < sim.seaStart * sim.W * 0.4, `wet cells ${sim.wetCells}`);
  let lowest = Infinity;
  for (let i = 0; i < sim.seaStart * sim.W; i++) lowest = Math.min(lowest, sim.b[i]);
  assert.ok(lowest > 1, `the stream has not cut down to the floor (${lowest})`);
});

test('random play never breaks the world', () => {
  // a seeded stream of taps and strokes with every tool, far rougher than a person would be
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const sim = new Sim(96, 210);
  makeBeach(sim, 4);
  const tools = ['dig', 'pile', 'pour', 'smooth'];
  for (let round = 0; round < 400; round++) {
    const tool = tools[(rand() * tools.length) | 0];
    let x = rand() * sim.W, y = rand() * sim.H;
    const dx = (rand() - 0.5) * 6, dy = (rand() - 0.5) * 6, r = 3 + rand() * 5;
    const strokes = 5 + ((rand() * 40) | 0);
    for (let k = 0; k < strokes; k++) {
      if (tool === 'smooth') sim.smooth(x, y, r, 0.3);
      else sim[tool](x, y, r, tool === 'pour' ? 0.15 : 0.12 + rand() * 0.3);
      x += dx; y += dy;
      sim.step(); sim.step();
    }
    if (round % 40 === 0) sim.springs[0].rate = [0, 1.4, 3][(rand() * 3) | 0];
    if (round % 55 === 0) { sim.springs[0].x = 6 + rand() * (sim.W - 12); sim.springs[0].y = 6 + rand() * (sim.seaStart - 20); }
  }
  for (let i = 0; i < 6000; i++) sim.step();
  assert.equal(finite(sim), null);
  const t = sim.totals();
  let deepest = 0, fastest = 0, tallest = 0;
  for (let i = 0; i < sim.seaStart * sim.W; i++) {
    deepest = Math.max(deepest, sim.w[i]);
    tallest = Math.max(tallest, sim.b[i]);
    fastest = Math.max(fastest, Math.hypot(sim.vx[i], sim.vy[i]));
    assert.ok(sim.w[i] >= 0 && sim.s[i] >= 0 && sim.b[i] >= 0 && sim.l[i] >= 0 && sim.g[i] >= 0 && sim.g[i] <= sim.b[i] + 1e-3);
  }
  assert.ok(deepest < 16, `deepest water ${deepest}`);
  assert.ok(fastest < 3, `fastest water ${fastest}`);
  assert.ok(tallest < 40, `tallest sand ${tallest}`);
  assert.ok(t.water < sim.N * 4, `water volume ${t.water}`);
});
