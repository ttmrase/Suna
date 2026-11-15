// Suna — WebGL2 renderer.
//
// Each frame the simulation fields are packed into two small RGBA8 textures
// (one texel per cell) and a single full-screen fragment shader turns them
// into lit sand and water at display resolution. All noise comes from one
// small pre-computed texture so the shader stays cheap on phone GPUs.

const HMAX = 40;     // height range packed into 16 bits
const DMIN = -1;     // signed water depth range packed into 16 bits
const DRANGE = 16;
const VMAX = 1;      // velocity range packed into 8 bits per axis
const NOISE = 256;   // noise texture size in texels
const LATTICE = 4;   // texels per feature of the smooth noise
export const MAX_SPRINGS = 4;

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const fragmentSource = (cMax) => `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uA;      // RG: sand height, BA: signed water depth
uniform sampler2D uB;      // R: sediment, G: dampness, BA: velocity
uniform sampler2D uN;      // R: smooth noise, GB: its gradient, A: white noise
uniform vec2 uGrid;        // cells
uniform vec2 uView;        // uv scale so the grid covers the canvas
uniform float uTime;
uniform float uPx;         // cells per output pixel
uniform vec4 uSpring[${MAX_SPRINGS}]; // x, y, strength, unused
uniform vec4 uTouch[2];    // x, y, radius, alpha — brush ring

in vec2 vUv;
out vec4 outColor;

const float HMAX = ${HMAX.toFixed(1)};
const float DMIN = ${DMIN.toFixed(1)};
const float DRANGE = ${DRANGE.toFixed(1)};
const float CMAX = ${cMax.toFixed(3)};
const float VMAX = ${VMAX.toFixed(1)};
const float FEATURES = ${(NOISE / LATTICE).toFixed(1)};  // smooth-noise features across the texture
const float TEXELS = ${NOISE.toFixed(1)};
const vec3 LIGHT = vec3(-0.52, -0.58, 0.627);   // towards the sun (screen y points down)
const float RELIEF = 1.55;

float decH(vec4 t) { return (t.r * 65280.0 + t.g * 255.0) * (HMAX / 65535.0); }
float decD(vec4 t) { return (t.b * 65280.0 + t.a * 255.0) * (DRANGE / 65535.0) + DMIN; }
float heightAt(vec2 cell) { return decH(textureLod(uA, cell / uGrid, 0.0)); }

// smooth noise: x = value 0..1, yz = gradient per feature
vec3 noise3(vec2 q) {
  vec4 t = textureLod(uN, q / FEATURES, 0.0);
  return vec3(t.r, (t.gb - 0.5) * 4.0);
}
float noise1(vec2 q) { return textureLod(uN, q / FEATURES, 0.0).r; }
// white noise, one value per texel
float white(vec2 texel) { return textureLod(uN, texel / TEXELS, 0.0).a; }

// cubic B-spline filtering from four bilinear taps
vec4 cubicW(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x;
  float y = s.y - 4.0 * s.x;
  float z = s.z - 4.0 * s.y + 6.0 * s.x;
  float w = 6.0 - x - y - z;
  return vec4(x, y, z, w) * (1.0 / 6.0);
}
vec4 smoothTex(sampler2D tex, vec2 cell) {
  vec2 tc = cell - 0.5;
  vec2 f = fract(tc);
  tc -= f;
  vec4 xc = cubicW(f.x), yc = cubicW(f.y);
  vec4 c = tc.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 off = (c + vec4(xc.yw, yc.yw) / s) / uGrid.xxyy;
  vec4 s0 = textureLod(tex, off.xz, 0.0);
  vec4 s1 = textureLod(tex, off.yz, 0.0);
  vec4 s2 = textureLod(tex, off.xw, 0.0);
  vec4 s3 = textureLod(tex, off.yw, 0.0);
  float sx = s.x / (s.x + s.y), sy = s.z / (s.z + s.w);
  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}

// A noise pattern carried along by the current. Two copies of the pattern,
// half a cycle apart, are cross-faded so the stretching never builds up.
// The pattern drifts at about 40% of the water's real speed (120 steps/s).
vec3 flowNoise(vec2 p, vec2 vel, float scale, float cycle) {
  float t = uTime / cycle;
  float p0 = fract(t), p1 = fract(t + 0.5);
  float w0 = 1.0 - abs(2.0 * p0 - 1.0);
  vec2 drift = vel * (48.0 * cycle);
  vec3 n0 = noise3((p - drift * (p0 - 0.5)) * scale + vec2(11.3, 5.7));
  vec3 n1 = noise3((p - drift * (p1 - 0.5)) * scale + vec2(47.9, 23.1));
  return mix(n1, n0, w0);
}

void main() {
  vec2 uv = (vUv - 0.5) * uView + 0.5;
  vec2 p = uv * uGrid;                       // position in cells

  // ---- terrain shape
  vec4 a = smoothTex(uA, p);
  float h = decH(a), ds = decD(a);
  vec2 grad = 0.5 * vec2(heightAt(p + vec2(1.0, 0.0)) - heightAt(p - vec2(1.0, 0.0)),
                         heightAt(p + vec2(0.0, 1.0)) - heightAt(p - vec2(0.0, 1.0)));
  vec4 bq = textureLod(uB, uv, 0.0);
  float damp = bq.g;
  float sed = bq.r * CMAX;
  vec2 vel = (bq.ba - 0.5) * 2.0 * VMAX;
  float speed = length(vel);

  // ---- sand grain
  float w1 = white(p * 5.3), w2 = white(p * 2.1 + 97.0);
  float grain = (w1 - 0.5) * 1.15 + (w2 - 0.5) * 0.6;
  float mottle = noise1(p * 0.11) * 0.65 + noise1(p * 0.31 + 7.0) * 0.35 - 0.5;
  vec3 n = normalize(vec3(-grad * RELIEF + vec2(w1 - 0.5, w2 - 0.5) * 0.16, 1.0));

  // ---- light: sun, soft cast shadow, sky fill, cavity shading
  float ndl = max(dot(n, LIGHT), 0.0) / LIGHT.z;
  vec2 ldir = normalize(LIGHT.xy);
  float rise = LIGHT.z / length(LIGHT.xy);
  float shadow = 1.0;
  float t = 0.7;
  for (int k = 0; k < 6; k++) {
    float ht = heightAt(p + ldir * t);
    shadow = min(shadow, clamp(1.0 - (ht - h - rise * t) * 1.9 / (0.35 + 0.22 * t), 0.0, 1.0));
    t *= 1.55;
  }
  float hb = decH(textureLod(uA, uv, 2.3));
  float cavity = clamp((hb - h) * 0.30, -0.22, 0.45);
  vec3 sun = vec3(1.04, 0.985, 0.90) * 0.66;
  vec3 sky = vec3(0.60, 0.69, 0.84) * 0.42;
  vec3 light = sun * ndl * (0.14 + 0.86 * shadow) + sky * (1.0 - cavity);

  // ---- sand colour
  float wet = smoothstep(0.02, 0.85, damp);
  float soaked = smoothstep(0.88, 1.0, damp);
  float under = smoothstep(0.0, 0.10, ds);
  vec3 dry = vec3(0.955, 0.835, 0.62) + mottle * vec3(0.06, 0.054, 0.042);
  vec3 moist = vec3(0.68, 0.545, 0.365) + mottle * vec3(0.036, 0.032, 0.024);
  vec3 sat = vec3(0.52, 0.40, 0.265);
  vec3 sand = mix(mix(dry, moist, wet), sat, soaked * (1.0 - under));
  // seen through water the bed looks paler than soaked sand in the open air
  sand = mix(sand, moist * 1.16, under);
  sand *= 1.0 + grain * mix(0.15, 0.08, wet);
  // the hard floor of the sandbox shows through where the sand is gone
  float bare = 1.0 - smoothstep(0.04, 0.30, h);
  if (bare > 0.0) {
    vec3 stone = vec3(0.36, 0.40, 0.45) * (0.85 + 0.3 * noise1(p * 0.6)) * (1.0 + grain * 0.1);
    sand = mix(sand, stone, bare);
  }
  vec3 col = sand * light;
  // glints: single dry grains catching the sun
  float glint = smoothstep(0.93, 0.99, w1) * (1.0 - wet) * shadow * smoothstep(0.7, 1.2, ndl);
  col += glint * 0.14;
  // wet sheen on soaked sand
  vec3 hv = normalize(LIGHT + vec3(0.0, 0.0, 1.0));
  col += soaked * (1.0 - bare) * shadow * pow(max(dot(n, hv), 0.0), 40.0) * 0.22;

  // ---- water
  if (ds > -0.03) {
    float d = max(ds, 0.0);
    float cover = smoothstep(-0.005, 0.03, ds);
    float run = min(speed, 0.8);
    // gentle surface ripples, a little stronger where the water runs fast
    vec3 rp = flowNoise(p, vel, 0.8, 0.9);
    vec2 rip = rp.yz * (0.8 * (0.05 + run * 0.4));
    // rings spreading from the springs
    for (int k = 0; k < ${MAX_SPRINGS}; k++) {
      vec4 sp = uSpring[k];
      if (sp.z <= 0.0) continue;
      vec2 dv = p - sp.xy;
      float r = length(dv) + 1e-3;
      float ring = cos(r * 1.9 - uTime * 7.0) * exp(-r * 0.30) * sp.z;
      rip += dv / r * ring * 0.45;
    }
    vec3 nw = normalize(vec3(-rip, 1.0));
    vec3 day = sky + sun * (0.3 + 0.7 * shadow);

    // the bed shows through the shallows; deeper water takes on its own colour
    float veil = 1.0 - exp(-d * 1.8);
    vec3 tint = mix(vec3(0.36, 0.77, 0.87), vec3(0.07, 0.40, 0.63), 1.0 - exp(-d * 0.42));
    // caustics: a net of light on the bed
    float c1 = 1.0 - abs(2.0 * rp.x - 1.0);
    float c2 = 1.0 - abs(2.0 * flowNoise(p * 1.7 + rip * 4.0 + 31.0, vel * 0.5, 0.75, 1.7).x - 1.0);
    float caustic = pow(c1 * c2, 3.0) * exp(-d * 0.5) * shadow * smoothstep(0.03, 0.2, d);
    vec3 bed = col * (1.0 + caustic * 0.7);
    vec3 wcol = mix(bed, tint * day, veil * 0.93);
    // stirred-up sand clouds the water
    float mud = 1.0 - exp(-sed * (d + 0.05) * 42.0);
    wcol = mix(wcol, vec3(0.75, 0.61, 0.42) * day, mud * 0.94);
    // streaks of light drawn out along the current
    vec2 along = vel / (speed + 1e-4) * min(1.0, speed * 12.0) * 0.55;
    float streak = (flowNoise(p - along, vel, 1.5, 0.55).x + flowNoise(p, vel, 1.5, 0.55).x
                  + flowNoise(p + along, vel, 1.5, 0.55).x) / 3.0;
    streak = (streak - 0.5) * 1.7 + 0.5;
    float lines = smoothstep(0.56, 0.86, streak) * smoothstep(0.03, 0.28, speed);
    wcol += vec3(0.95, 0.98, 1.0) * lines * (0.10 + 0.22 * run) * (0.4 + 0.6 * shadow);
    // sky reflection and sun on the ripples
    float fres = 0.03 + 0.6 * (1.0 - nw.z);
    wcol = mix(wcol, vec3(0.84, 0.92, 0.98), clamp(fres, 0.0, 0.4));
    float sdot = max(dot(nw, hv), 0.0);
    wcol += vec3(1.0, 0.97, 0.90) * (pow(sdot, 46.0) * 0.28 + pow(sdot, 260.0) * 0.8) * shadow;
    // white water where it rushes
    float foam = smoothstep(0.36, 0.70, speed + (streak - 0.5) * 0.3) * smoothstep(0.45, 0.8, streak);
    wcol = mix(wcol, vec3(0.98), foam * 0.6 * (0.5 + 0.5 * shadow));
    // a bright thread along the water's edge
    float lip = smoothstep(0.0, 0.025, ds) * (1.0 - smoothstep(0.03, 0.13, ds));
    wcol += lip * 0.10 * day;
    col = mix(col, wcol, cover);
  }

  // ---- brush ring
  for (int k = 0; k < 2; k++) {
    vec4 tc = uTouch[k];
    if (tc.w <= 0.0) continue;
    float r = length(p - tc.xy);
    float ring = 1.0 - smoothstep(0.0, uPx * 1.5 + 0.12, abs(r - tc.z));
    col = mix(col, vec3(1.0), ring * tc.w * 0.5);
  }

  // gentle vignette and dither
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * 0.16;
  col += (white(gl_FragCoord.xy + uTime * 61.0) - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('shader: ' + log);
  }
  return sh;
}

/**
 * Tiling noise texture. R: smooth value noise with features LATTICE texels
 * across; G, B: its gradient per feature, packed as (g / 4 + 0.5);
 * A: independent random value per texel.
 */
function noisePixels() {
  const size = NOISE, cells = size / LATTICE;
  let seed = 0x9e3779b9;
  const rand = () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
  const value = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const fy = y / LATTICE, iy = Math.floor(fy), y1 = (iy + 1) % cells;
    let ty = fy - iy; ty = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < size; x++) {
      const fx = x / LATTICE, ix = Math.floor(fx), x1 = (ix + 1) % cells;
      let tx = fx - ix; tx = tx * tx * (3 - 2 * tx);
      const a = lattice[ix + iy * cells], b = lattice[x1 + iy * cells];
      const c = lattice[ix + y1 * cells], d = lattice[x1 + y1 * cells];
      value[x + y * size] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  const out = new Uint8Array(size * size * 4);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = (x + size - 1) % size, xp = (x + 1) % size, ym = (y + size - 1) % size, yp = (y + 1) % size;
      const gx = (value[xp + y * size] - value[xm + y * size]) * 0.5 * LATTICE;
      const gy = (value[x + yp * size] - value[x + ym * size]) * 0.5 * LATTICE;
      const o = (x + y * size) * 4;
      out[o] = clamp(value[x + y * size] * 255);
      out[o + 1] = clamp((gx / 4 + 0.5) * 255);
      out[o + 2] = clamp((gy / 4 + 0.5) * 255);
      out[o + 3] = rand() * 256;
    }
  }
  return out;
}

export class Renderer {
  constructor(canvas, sim) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.canvas = canvas;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragmentSource(sim.p.cMax)));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.u = {};
    for (const name of ['uA', 'uB', 'uN', 'uGrid', 'uView', 'uTime', 'uPx', 'uSpring', 'uTouch']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.texN = this._texture(NOISE, NOISE, noisePixels(), gl.LINEAR, gl.REPEAT);
    this.springData = new Float32Array(MAX_SPRINGS * 4);
    this.touchData = new Float32Array(8);
    this.view = [1, 1];
    this.setSim(sim);
  }

  /** Draw a different world from now on (a new beach, or one of another size). */
  setSim(sim) {
    const gl = this.gl;
    const { W, H } = sim;
    if (!this.sim || this.sim.W !== W || this.sim.H !== H) {
      if (this.texA) { gl.deleteTexture(this.texA); gl.deleteTexture(this.texB); }
      this.bufA = new Uint8Array(W * H * 4);
      this.bufB = new Uint8Array(W * H * 4);
      this.texA = this._texture(W, H, null, gl.LINEAR_MIPMAP_LINEAR, gl.CLAMP_TO_EDGE);
      this.texB = this._texture(W, H, null, gl.LINEAR, gl.CLAMP_TO_EDGE);
    }
    this.sim = sim;
  }

  _texture(W, H, pixels, minFilter, wrap) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    return tex;
  }

  /** Pack the simulation fields into the two byte textures. */
  pack() {
    const sim = this.sim;
    const { W, H, b, w, g, s, vx, vy } = sim;
    const A = this.bufA, B = this.bufB;
    const hk = 65535 / HMAX, dk = 65535 / DRANGE;
    const invMoist = 1 / sim.p.moistDepth, invC = 255 / sim.p.cMax, vk = 127 / VMAX;
    for (let y = 0, i = 0; y < H; y++) {
      for (let x = 0; x < W; x++, i++) {
        const o = i << 2;
        const bi = b[i], wi = w[i];
        let hv = (bi * hk + 0.5) | 0;
        if (hv > 65535) hv = 65535;
        A[o] = hv >> 8; A[o + 1] = hv & 255;
        // signed depth: on dry cells next to water, how far the neighbouring
        // water level lies below the sand, so the waterline follows the terrain
        let ds;
        if (wi > 0) ds = wi;
        else {
          let sum = 0, n = 0, j;
          if (x > 0 && w[j = i - 1] > 0) { sum += b[j] + w[j]; n++; }
          if (x < W - 1 && w[j = i + 1] > 0) { sum += b[j] + w[j]; n++; }
          if (y > 0 && w[j = i - W] > 0) { sum += b[j] + w[j]; n++; }
          if (y < H - 1 && w[j = i + W] > 0) { sum += b[j] + w[j]; n++; }
          if (n) { ds = sum / n - bi; if (ds > 0) ds = 0; else if (ds < DMIN) ds = DMIN; }
          else ds = DMIN;
        }
        let dv = ((ds - DMIN) * dk + 0.5) | 0;
        if (dv > 65535) dv = 65535;
        A[o + 2] = dv >> 8; A[o + 3] = dv & 255;

        const c = wi > 0.01 ? s[i] / wi * invC : 0;
        B[o] = c > 255 ? 255 : c;
        const m = wi > 0.02 ? 1 : 1 - (bi - g[i] - 0.03) * invMoist;
        B[o + 1] = m <= 0 ? 0 : m >= 1 ? 255 : m * 255;
        const u = vx[i] * vk, v = vy[i] * vk;
        B[o + 2] = (u > 127 ? 127 : u < -127 ? -127 : u) + 128;
        B[o + 3] = (v > 127 ? 127 : v < -127 ? -127 : v) + 128;
      }
    }
  }

  /** Size the drawing buffer; scale < 1 renders at reduced resolution. */
  resize(cssW, cssH, pixelScale) {
    const w = Math.max(64, Math.round(cssW * pixelScale)), h = Math.max(64, Math.round(cssH * pixelScale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    // the grid covers the canvas: crop whichever axis is too long
    const gridAspect = this.sim.W / this.sim.H, viewAspect = cssW / cssH;
    this.view = viewAspect > gridAspect ? [1, gridAspect / viewAspect] : [viewAspect / gridAspect, 1];
  }

  /** Canvas-relative fraction (0..1) to cell coordinates. */
  toCell(fx, fy) {
    return [((fx - 0.5) * this.view[0] + 0.5) * this.sim.W, ((fy - 0.5) * this.view[1] + 0.5) * this.sim.H];
  }

  draw(time, touches) {
    const gl = this.gl, sim = this.sim, u = this.u;
    const { W, H } = sim;
    this.pack();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texA);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, this.bufA);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texB);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, this.bufB);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.texN);
    gl.uniform1i(u.uA, 0);
    gl.uniform1i(u.uB, 1);
    gl.uniform1i(u.uN, 2);
    gl.uniform2f(u.uGrid, W, H);
    gl.uniform2f(u.uView, this.view[0], this.view[1]);
    gl.uniform1f(u.uTime, time % 3600);
    gl.uniform1f(u.uPx, W * this.view[0] / this.canvas.width);
    const sd = this.springData;
    sd.fill(0);
    sim.springs.slice(0, MAX_SPRINGS).forEach((sp, k) => {
      sd[k * 4] = sp.x + 0.5; sd[k * 4 + 1] = sp.y + 0.5;
      sd[k * 4 + 2] = sp.rate > 0 ? Math.min(1.4, 0.5 + sp.rate * 0.35) : 0;
    });
    gl.uniform4fv(u.uSpring, sd);
    const td = this.touchData;
    td.fill(0);
    (touches || []).slice(0, 2).forEach((tc, k) => {
      td[k * 4] = tc.x + 0.5; td[k * 4 + 1] = tc.y + 0.5; td[k * 4 + 2] = tc.r; td[k * 4 + 3] = tc.a;
    });
    gl.uniform4fv(u.uTouch, td);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
