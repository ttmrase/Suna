// Suna — game loop, touch input and UI.

import { Sim } from './sim.js';
import { makeBeach } from './terrain.js';
import { Renderer } from './render.js';
import { Sound } from './audio.js';
import { save, load, clearSave } from './store.js';
import { t, applyText } from './i18n.js';

const STEP_MS = 1000 / 120;      // simulation steps per second of play
const MAX_STEPS = 3;             // per frame; slower devices run the world a little slower instead of stalling
const BRUSH = [3, 5, 8];         // radius in cells
const FLOW = [0, 1.4, 3.0];      // spring output per step
const RATE = { dig: 7.5, pile: 6.5, pour: 7.0, smooth: 9.0 }; // per second at the brush centre

const $ = (id) => document.getElementById(id);
const canvas = $('view');

let sim, renderer, sound;
let tool = 'dig';
let brush = 1;
let flow = 1;
let pixelScale = 0;             // drawing-buffer pixels per CSS pixel (0 = not chosen yet)
const pointers = new Map();      // pointerId -> { x, y, lx, ly, tool }: where the finger is, and was last frame

// ------------------------------------------------------------------ world

function gridFor(cssW, cssH) {
  if (!(cssW > 0 && cssH > 0)) { cssW = screen.width || 360; cssH = screen.height || 800; }
  // about 3 CSS px per cell on a phone; keep the cell count in check on tablets
  const W = Math.max(112, Math.min(168, Math.round(cssW / 3.1)));
  const H = Math.max(160, Math.min(380, Math.round(W * cssH / cssW)));
  return [W, H];
}

function newWorld(seed) {
  const [W, H] = gridFor(window.innerWidth, window.innerHeight);
  const fresh = new Sim(W, H);
  makeBeach(fresh, seed);
  fresh.springs[0].rate = FLOW[flow];
  return fresh;
}

function attach(world) {
  sim = world;
  if (renderer) renderer.setSim(sim); else renderer = new Renderer(canvas, sim);
  resize();
}

function resize() {
  const cssW = window.innerWidth, cssH = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  // start near 1M pixels; the frame-time watchdog lowers this if the device struggles
  const cap = Math.sqrt(1.0e6 / (cssW * cssH));
  if (!(pixelScale > 0)) pixelScale = Math.min(dpr, Math.max(1, cap));
  renderer.resize(cssW, cssH, pixelScale);
}

// ------------------------------------------------------------------ input

function cellAt(ev) {
  const r = canvas.getBoundingClientRect();
  const [cx, cy] = renderer.toCell((ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height);
  return [cx - 0.5, cy - 0.5];
}

function onDown(ev) {
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  try { canvas.setPointerCapture(ev.pointerId); } catch { /* the pointer is already gone */ }
  const [x, y] = cellAt(ev);
  pointers.set(ev.pointerId, { x, y, lx: x, ly: y, tool });
  sound.unlock();
  hideHint();
  ev.preventDefault();
}
function onMove(ev) {
  const p = pointers.get(ev.pointerId);
  if (!p) return;
  [p.x, p.y] = cellAt(ev);
  ev.preventDefault();
}
function onUp(ev) {
  pointers.delete(ev.pointerId);
}

/** Apply every held finger's tool along the path it travelled since the last frame. */
function applyTools(dt) {
  if (!(dt > 0.001)) dt = 0.001;
  let scrape = 0, splash = 0;
  for (const p of pointers.values()) {
    const r = BRUSH[brush];
    const dx = p.x - p.lx, dy = p.y - p.ly;
    const dist = Math.hypot(dx, dy);
    if (p.tool === 'spring') {
      const sp = sim.springs[0];
      sp.x = Math.max(4, Math.min(sim.W - 5, p.x));
      sp.y = Math.max(4, Math.min(sim.seaStart - 8, p.y));
      if (flow === 0) setFlow(1);
      p.lx = p.x; p.ly = p.y;
      continue;
    }
    const n = Math.max(1, Math.ceil(dist / (r * 0.25)));
    const share = dt / n;
    for (let k = 1; k <= n; k++) {
      const x = p.lx + dx * k / n, y = p.ly + dy * k / n;
      if (p.tool === 'dig') sim.dig(x, y, r, RATE.dig * share);
      else if (p.tool === 'pile') sim.pile(x, y, r, RATE.pile * share);
      else if (p.tool === 'pour') sim.pour(x, y, r, RATE.pour * share);
      else if (p.tool === 'smooth') sim.smooth(x, y, r * 1.25, Math.min(0.5, RATE.smooth * share));
    }
    if (p.tool === 'pour') splash = 1;
    else scrape = Math.max(scrape, Math.min(1, 0.25 + dist / (dt * 90)));
    p.lx = p.x; p.ly = p.y;
  }
  sound.setScrape(scrape);
  return splash;
}

// ------------------------------------------------------------------ UI

function setTool(name) {
  tool = name;
  for (const el of document.querySelectorAll('.tool')) {
    el.setAttribute('aria-pressed', el.dataset.tool === name ? 'true' : 'false');
  }
}
function setBrush(i) {
  brush = i;
  $('size').dataset.size = String(i);
}
function setFlow(i) {
  flow = i;
  $('flow').dataset.level = String(i);
  if (sim) for (const sp of sim.springs) sp.rate = FLOW[i];
}

let hintTimer = 0;
function showHint(text, ms = 6000) {
  const el = $('hint');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(hideHint, ms);
}
function hideHint() {
  $('hint').classList.remove('show');
}

function openSheet() {
  $('reset').classList.remove('confirm');
  $('reset').textContent = t('reset');
  $('sound').textContent = t(sound.enabled ? 'soundOn' : 'soundOff');
  $('sheet').hidden = false;
}
function closeSheet() {
  $('sheet').hidden = true;
}

function wireUi() {
  applyText(document);
  for (const el of document.querySelectorAll('.tool')) {
    el.addEventListener('click', () => {
      setTool(el.dataset.tool);
      sound.unlock();
      if (el.dataset.tool === 'spring') showHint(t('hintSpring'), 3500);
    });
  }
  $('size').addEventListener('click', () => setBrush((brush + 1) % BRUSH.length));
  $('flow').addEventListener('click', () => {
    setFlow((flow + 1) % FLOW.length);
    showHint(t(['flow0', 'flow1', 'flow2'][flow]), 1600);
  });
  $('menu').addEventListener('click', openSheet);
  $('close').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', (ev) => { if (ev.target === $('sheet')) closeSheet(); });
  $('sound').addEventListener('click', () => {
    sound.setEnabled(!sound.enabled);
    try { localStorage.setItem('suna.sound', sound.enabled ? '1' : '0'); } catch { /* storage unavailable */ }
    $('sound').textContent = t(sound.enabled ? 'soundOn' : 'soundOff');
  });
  $('reset').addEventListener('click', () => {
    const btn = $('reset');
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm');
      btn.textContent = t('resetConfirm');
      return;
    }
    clearSave();
    pointers.clear();
    attach(newWorld((Math.random() * 1e9) | 0));
    closeSheet();
  });

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  // Android may take the graphics context away while the app is in the background
  canvas.addEventListener('webglcontextlost', (ev) => { ev.preventDefault(); contextLost = true; });
  canvas.addEventListener('webglcontextrestored', () => {
    renderer = new Renderer(canvas, sim);
    resize();
    contextLost = false;
  });
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pointers.clear();
      sound.suspend();
      save(sim, { flow });
    } else {
      last = 0;
      sound.resume();
    }
  });
  window.addEventListener('pagehide', () => save(sim, { flow }));
}

// ------------------------------------------------------------------ loop

let last = 0, acc = 0, slow = 0, frames = 0, lastSave = 0;
let contextLost = false;
let simMs = 0;        // smoothed time spent simulating per frame
let stepLimit = MAX_STEPS;

function frame(now) {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  const dtMs = last ? Math.min(now - last, 100) : 16.7;
  last = now;

  const splash = applyTools(dtMs / 1000);
  acc += dtMs;
  let steps = Math.floor(acc / STEP_MS);
  if (steps > stepLimit) { steps = stepLimit; acc = 0; } else acc -= steps * STEP_MS;
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) sim.step();
  simMs += (performance.now() - t0 - simMs) * 0.05;
  // a slow processor gets a slower-running world rather than a stuttering one
  if (simMs > 9 && stepLimit > 1) stepLimit = 1;
  else if (simMs < 3 && stepLimit < MAX_STEPS) stepLimit = MAX_STEPS;

  const rings = [];
  for (const p of pointers.values()) {
    if (p.tool !== 'spring') rings.push({ x: p.x, y: p.y, r: BRUSH[brush] * (p.tool === 'smooth' ? 1.25 : 1), a: 0.55 });
  }
  if (!contextLost) renderer.draw(now / 1000, rings);
  sound.setFlow(sim.flowEnergy, sim.slipMoved, splash);

  // if most frames run long and it is not the simulation's doing, render fewer pixels
  frames++;
  if (dtMs > 22) slow++;
  if (frames >= 60) {
    if (slow > 30 && simMs < 8 && pixelScale > 0.7) {
      pixelScale = Math.max(0.7, pixelScale * 0.85);
      renderer.resize(window.innerWidth, window.innerHeight, pixelScale);
    }
    frames = 0; slow = 0;
  }
  // The beach is saved whenever the app goes to the background; this is only a
  // safety net, taken while no finger is down so that it cannot cause a hitch mid-stroke.
  if (now - lastSave > 60000 && pointers.size === 0) {
    lastSave = now;
    save(sim, { flow });
  }
}

// ------------------------------------------------------------------ start

/** Resolve once the page has a size that has stopped changing (the app window settles just after launch). */
async function viewportSettled() {
  const nextFrame = () => new Promise((done) => {
    const timer = setTimeout(done, 60); // frames do not run while the page is hidden
    requestAnimationFrame(() => { clearTimeout(timer); done(); });
  });
  const began = performance.now();
  let w = 0, h = 0, same = 0;
  while (performance.now() - began < 1500) {
    await nextFrame();
    if (window.innerWidth > 0 && window.innerWidth === w && window.innerHeight === h) {
      if (++same >= 4) return;
    } else {
      same = 0; w = window.innerWidth; h = window.innerHeight;
    }
  }
}

async function start() {
  await viewportSettled();
  sound = new Sound();
  try { sound.setEnabled(localStorage.getItem('suna.sound') !== '0'); } catch { /* storage unavailable */ }
  let world = null, firstRun = true;
  try {
    const saved = load(window.innerWidth / window.innerHeight);
    if (saved) {
      world = saved.sim;
      flow = [0, 1, 2].includes(saved.meta.flow) ? saved.meta.flow : 1;
      firstRun = false;
    }
  } catch (err) {
    console.warn('could not restore the saved beach', err);
  }
  // ?seed=N starts a fresh, repeatable beach (used when testing in a browser)
  const seedParam = new URLSearchParams(location.search).get('seed');
  if (seedParam !== null) { world = null; firstRun = false; }
  if (!world) world = newWorld(seedParam !== null ? +seedParam : (Math.random() * 1e9) | 0);
  try {
    attach(world);
  } catch (err) {
    const el = $('fatal');
    el.textContent = t('noWebgl');
    el.hidden = false;
    console.error(err);
    return;
  }
  setTool('dig');
  setBrush(1);
  setFlow(flow);
  wireUi();
  if (firstRun) setTimeout(() => showHint(t('hintStart'), 9000), 1500);
  // hooks for the Android shell (and for poking at things from a browser console)
  window.suna = {
    get sim() { return sim; },
    get renderer() { return renderer; },
    sound,
    save: () => save(sim, { flow }),
    back() {
      if ($('sheet').hidden) return false;
      closeSheet();
      return true;
    },
  };
  requestAnimationFrame(frame);
}

start();
