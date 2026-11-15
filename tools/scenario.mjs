// Development aid: play a scripted scenario and write the frames side by side.
//   node tools/scenario.mjs <name> out.png
import { Sim } from '../app/src/main/assets/www/js/sim.js';
import { makeBeach } from '../app/src/main/assets/www/js/terrain.js';
import { paint, writePng } from './snapshot.mjs';

const W = 128, H = 284, SCALE = 2;

function creekX(sim, y) {
  // lowest point of the row = creek bed
  let best = 0, bx = 0;
  for (let x = 4; x < W - 4; x++) {
    const h = sim.b[x + y * W];
    if (x === 4 || h < best) { best = h; bx = x; }
  }
  return bx;
}
function stroke(sim, fn, x0, y0, x1, y1, r, amount) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (r / 3));
  for (let k = 0; k <= n; k++) fn.call(sim, x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n, r, amount);
}

const scenarios = {
  // the untouched creek over four minutes
  idle(sim, shot) {
    for (const t of [3600, 36000, 72000, 144000]) { while (sim.tick < t) sim.step(); shot(`${t / 120}s`); }
  },
  // a groove dug off to one side of the creek
  groove(sim, shot) {
    while (sim.tick < 1800) sim.step();
    const y = 90, x = creekX(sim, y);
    const dir = x < W / 2 ? 1 : -1;
    for (let pass = 0; pass < 3; pass++) stroke(sim, sim.dig, x, y, x + dir * 34, y + 70, 4, 0.12);
    shot('dug');
    for (const dt of [600, 1800, 3600, 7200]) { const t = sim.tick + dt; while (sim.tick < t) sim.step(); shot(`+${dt / 120}s`); }
  },
  // a dam across the creek
  dam(sim, shot) {
    while (sim.tick < 1800) sim.step();
    const y = 130, x = creekX(sim, y);
    for (let pass = 0; pass < 6; pass++) stroke(sim, sim.pile, x - 9, y, x + 9, y, 4.5, 0.12);
    shot('dam');
    for (const dt of [300, 600, 1200, 2400, 4800]) { const t = sim.tick + dt; while (sim.tick < t) sim.step(); shot(`+${dt / 120}s`); }
  },
  // a wide, tall dam: does it leak and fail?
  bigdam(sim, shot) {
    while (sim.tick < 1800) sim.step();
    const y = 130, x = creekX(sim, y);
    for (let pass = 0; pass < 14; pass++) stroke(sim, sim.pile, x - 26, y, x + 26, y + 3, 5.5, 0.12);
    shot('dam');
    for (const dt of [600, 1200, 2400, 4800, 9600]) { const t = sim.tick + dt; while (sim.tick < t) sim.step(); shot(`+${dt / 120}s`); }
  },
  // a hole dug next to the sea
  hole(sim, shot) {
    while (sim.tick < 600) sim.step();
    const y = sim.seaStart - 14 - 22;
    for (let pass = 0; pass < 30; pass++) sim.dig(30, y, 7, 0.12);
    shot('dug');
    for (const dt of [120, 600, 2400]) { const t = sim.tick + dt; while (sim.tick < t) sim.step(); shot(`+${dt / 120}s`); }
  },
};

const [name = 'idle', out = 'scenario.png', seed = '1'] = process.argv.slice(2);
const sim = new Sim(W, H);
makeBeach(sim, +seed);
const frames = [];
const t0 = performance.now();
scenarios[name](sim, (label) => {
  frames.push(paint(sim, SCALE));
  const t = sim.totals();
  let maxC = 0, maxV = 0;
  for (let i = 0; i < sim.N; i++) {
    if (sim.w[i] > 0.02) { maxC = Math.max(maxC, sim.s[i] / sim.w[i]); maxV = Math.max(maxV, Math.hypot(sim.vx[i], sim.vy[i])); }
  }
  console.log(`${label.padEnd(8)} tick ${sim.tick} sand ${t.sand.toFixed(1)} water ${t.water.toFixed(1)} wet ${sim.wetCells} maxC ${maxC.toFixed(3)} maxV ${maxV.toFixed(2)}`);
});
console.log(`${((performance.now() - t0) / sim.tick).toFixed(3)} ms/step`);
const fw = W * SCALE, fh = H * SCALE, gap = 4;
const tw = frames.length * (fw + gap) - gap;
const strip = Buffer.alloc(tw * fh * 3, 255);
frames.forEach((f, k) => {
  for (let y = 0; y < fh; y++) f.copy(strip, (y * tw + k * (fw + gap)) * 3, y * fw * 3, (y + 1) * fw * 3);
});
writePng(out, tw, fh, strip);
