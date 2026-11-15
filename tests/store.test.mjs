// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

// a stand-in for the browser's localStorage
const memory = new Map();
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => { memory.set(k, String(v)); },
  removeItem: (k) => { memory.delete(k); },
};

const { Sim } = await import('../app/src/main/assets/www/js/sim.js');
const { makeBeach } = await import('../app/src/main/assets/www/js/terrain.js');
const { save, load, clearSave } = await import('../app/src/main/assets/www/js/store.js');

test('a beach survives being saved and loaded', () => {
  const sim = new Sim(64, 140);
  makeBeach(sim, 5);
  for (let i = 0; i < 900; i++) sim.step();
  sim.dig(20, 60, 4, 1);
  sim.pile(40, 70, 4, 2);
  assert.ok(save(sim, { flow: 2 }));

  const back = load(64 / 140);
  assert.ok(back, 'something was loaded');
  assert.equal(back.meta.flow, 2);
  assert.equal(back.sim.tick, sim.tick);
  assert.deepEqual(back.sim.springs, sim.springs);
  for (const [f, tol] of [['b', 1e-3], ['w', 1e-3], ['g', 1e-3], ['l', 1e-3]]) {
    let worst = 0;
    for (let i = 0; i < sim.N; i++) worst = Math.max(worst, Math.abs(sim[f][i] - back.sim[f][i]));
    assert.ok(worst < tol, `${f} differs by ${worst}`);
  }
  // the loaded beach keeps running
  for (let i = 0; i < 300; i++) back.sim.step();
  assert.ok(back.sim.wetCells > 0);
});

test('a save is kept for a slightly different screen, ignored for a very different one, and can be cleared', () => {
  assert.ok(load(64 / 146), 'a few percent taller is fine');
  assert.equal(load(3 / 4), null, 'a tablet-shaped screen starts afresh');
  clearSave();
  assert.equal(load(64 / 140), null);
});

test('a damaged save is reported rather than half-loaded', () => {
  const sim = new Sim(64, 140);
  makeBeach(sim, 1);
  save(sim, {});
  const data = JSON.parse(memory.get('suna.beach.v1'));
  data.b = data.b.slice(0, 100);
  memory.set('suna.beach.v1', JSON.stringify(data));
  assert.throws(() => load(64 / 140));
});
