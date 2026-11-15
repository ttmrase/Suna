// Development aid: time each simulation pass.  node tools/profile.mjs [steps]
import { Sim } from '../app/src/main/assets/www/js/sim.js';
import { makeBeach } from '../app/src/main/assets/www/js/terrain.js';

const steps = +(process.argv[2] || 3000);
const sim = new Sim(128, 284);
makeBeach(sim, 1);
const names = ['_sources', '_extents', '_flux', '_advect', '_erode', '_slip', '_groundwater', '_sea'];
const acc = Object.fromEntries(names.map((n) => [n, 0]));
for (const n of names) {
  const orig = sim[n].bind(sim);
  sim[n] = (...a) => { const t = performance.now(); const r = orig(...a); acc[n] += performance.now() - t; return r; };
}
for (let i = 0; i < 600; i++) sim.step(); // warm up
for (const n of names) acc[n] = 0;
const t0 = performance.now();
for (let i = 0; i < steps; i++) sim.step();
const total = (performance.now() - t0) / steps;
console.log(`total ${total.toFixed(3)} ms/step, wet cells ${sim.wetCells}`);
for (const n of names) console.log(`  ${n.padEnd(13)} ${(acc[n] / steps).toFixed(4)}`);
