// Development aid: run the simulation headless and write a false-colour PNG of the result.
//   node tools/snapshot.mjs out.png [steps] [seed]
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { Sim } from '../app/src/main/assets/www/js/sim.js';
import { makeBeach } from '../app/src/main/assets/www/js/terrain.js';

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
export function writePng(path, W, H, rgb) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** Shaded relief with water in blue, muddy water in brown, damp sand darker. */
export function paint(sim, scale = 3) {
  const { W, H, b, w, g, s } = sim;
  const out = Buffer.alloc(W * scale * H * scale * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = x + y * W;
    const bx = b[Math.min(W - 1, x + 1) + y * W] - b[Math.max(0, x - 1) + y * W];
    const by = b[x + Math.min(H - 1, y + 1) * W] - b[x + Math.max(0, y - 1) * W];
    const light = Math.max(0.35, Math.min(1.3, 1 - 0.55 * (bx + by)));
    const damp = Math.max(0, Math.min(1, 1 - (b[i] - g[i]) / 1.3));
    let r = (232 - 70 * damp) * light, gr = (208 - 70 * damp) * light, bl = (160 - 65 * damp) * light;
    if (b[i] < 0.1) { r = 90; gr = 95; bl = 105; }
    if (w[i] > 0.002) {
      const a = Math.min(0.92, 0.35 + w[i] * 0.45);
      const mud = Math.min(1, (s[i] / w[i]) * 5);
      const wr = 40 + 140 * mud, wg = 130 + 20 * mud, wb = 200 - 100 * mud;
      r += (wr - r) * a; gr += (wg - gr) * a; bl += (wb - bl) * a;
    }
    for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
      const o = ((y * scale + sy) * W * scale + x * scale + sx) * 3;
      out[o] = Math.max(0, Math.min(255, r));
      out[o + 1] = Math.max(0, Math.min(255, gr));
      out[o + 2] = Math.max(0, Math.min(255, bl));
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [out = 'snapshot.png', steps = '2400', seed = '1'] = process.argv.slice(2);
  const sim = new Sim(128, 284);
  makeBeach(sim, +seed);
  const t0 = performance.now();
  for (let i = 0; i < +steps; i++) sim.step();
  const ms = (performance.now() - t0) / +steps;
  const t = sim.totals();
  console.log(`${steps} steps, ${ms.toFixed(3)} ms/step, wet cells ${sim.wetCells}, sand ${t.sand.toFixed(1)}, water ${t.water.toFixed(1)}`);
  writePng(out, sim.W * 3, sim.H * 3, paint(sim, 3));
}
