/** Unit tests for the diagnostic checks. Run with: npm test */
import assert from 'node:assert/strict';
import {
  validateScene, checkSetup, checkDecay, reliableFMin, requiredDurationMs,
  probeSpongeClearance, cellsPerWavelength,
} from '../src/engine/checks';
import { DEFAULT_PARAMS, type Scene } from '../src/engine/scene';
import { PRESETS, sideRadialScene } from '../src/engine/presets';
import { runSimulation } from '../src/engine/runner';

const codes = (d: { code: string; severity: string }[], sev?: string) =>
  d.filter((x) => !sev || x.severity === sev).map((x) => x.code);

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

async function main() {
  console.log('validateScene');
  await test('all presets are structurally valid', () => {
    for (const [k, mk] of Object.entries(PRESETS)) assert.deepEqual(codes(validateScene(mk()), 'error'), [], k);
  });
  await test('rejects non-object and missing domain', () => {
    assert.ok(codes(validateScene(null)).includes('scene-type'));
    assert.ok(codes(validateScene({ name: 'x' })).includes('domain-missing'));
  });
  await test('rejects negative and zero-size rects', () => {
    const s = sideRadialScene();
    s.shapes.push({ kind: 'rect', r: [-5, 10], z: [0, 10], material: 'rigid' });
    s.shapes.push({ kind: 'rect', r: [0, 10], z: [5, 5], material: 'rigid' });
    const c = codes(validateScene(s), 'error');
    assert.ok(c.includes('rect-negative-r'));
    assert.ok(c.includes('rect-zero-size'));
  });
  await test('rejects driver outside the domain', () => {
    const s = sideRadialScene();
    s.drivers = [{ kind: 'piston', z: 500, r: [0, 20], dir: '+z' }];
    assert.ok(codes(validateScene(s), 'error').includes('driver-outside'));
  });
  await test('rejects probes outside the domain', () => {
    const s = sideRadialScene();
    s.measure.radius = 400;
    assert.ok(codes(validateScene(s), 'error').includes('probe-outside'));
  });
  await test('rejects bad material and a 2-point polygon', () => {
    const s = sideRadialScene() as unknown as { shapes: unknown[] };
    s.shapes.push({ kind: 'rect', r: [0, 1], z: [0, 1], material: 'steel' });
    s.shapes.push({ kind: 'polygon', points: [[0, 0], [1, 1]], material: 'rigid' });
    const c = codes(validateScene(s), 'error');
    assert.ok(c.includes('shape-material'));
    assert.ok(c.includes('polygon-points'));
  });
  await test('warns when a shape is clipped by the domain', () => {
    const s = sideRadialScene();
    s.shapes.push({ kind: 'rect', r: [0, 10], z: [-300, -190], material: 'rigid' }); // zMin is -250
    assert.ok(codes(validateScene(s), 'warning').includes('shape-clipped'));
  });

  console.log('checkSetup');
  const base: Scene = sideRadialScene();
  await test('default params on side-radial: no errors', () => {
    assert.deepEqual(codes(checkSetup(base, DEFAULT_PARAMS), 'error'), []);
  });
  await test('resolution: dx 4 mm at 20 kHz is an error, 2.5 mm a warning', () => {
    assert.ok(cellsPerWavelength(4, 20000) < 6);
    assert.ok(codes(checkSetup(base, { ...DEFAULT_PARAMS, dx: 4 }), 'error').includes('resolution'));
    assert.ok(codes(checkSetup(base, { ...DEFAULT_PARAMS, dx: 2.5 }), 'warning').includes('resolution'));
    assert.ok(!codes(checkSetup(base, { ...DEFAULT_PARAMS, dx: 1 })).includes('resolution'));
  });
  await test('fMin below what the run length supports warns with the required duration', () => {
    const d = checkSetup(base, { ...DEFAULT_PARAMS, durationMs: 6, fMin: 200 });
    const w = d.find((x) => x.code === 'fmin-unreliable');
    assert.ok(w && w.severity === 'warning');
    assert.ok(w.message.includes(requiredDurationMs(base, 200).toFixed(1)));
    const fRel = reliableFMin(base, 6);
    assert.ok(fRel > 500 && fRel < 600, `reliable fMin ${fRel}`);
    assert.ok(!codes(checkSetup(base, { ...DEFAULT_PARAMS, durationMs: 20, fMin: 200 })).includes('fmin-unreliable'));
  });
  await test('run shorter than the arrival delay is an error', () => {
    assert.ok(codes(checkSetup(base, { ...DEFAULT_PARAMS, durationMs: 0.1 }), 'error').includes('duration-short'));
  });
  await test('probe inside sponge is an error, near sponge a warning', () => {
    const s = sideRadialScene();
    s.measure.radius = 230; // rMax 290, sponge 100 mm -> inside
    assert.ok(probeSpongeClearance(s, DEFAULT_PARAMS) < 0);
    assert.ok(codes(checkSetup(s, DEFAULT_PARAMS), 'error').includes('probe-in-sponge'));
    s.measure.radius = 160; // 30 mm clearance
    assert.ok(codes(checkSetup(s, DEFAULT_PARAMS), 'warning').includes('probe-near-sponge'));
    assert.ok(!codes(checkSetup(base, DEFAULT_PARAMS)).includes('probe-near-sponge'));
  });
  await test('courant above 0.7 is an error', () => {
    assert.ok(codes(checkSetup(base, { ...DEFAULT_PARAMS, courant: 0.9 }), 'error').includes('courant'));
  });
  await test('thin sponge warns', () => {
    assert.ok(codes(checkSetup(base, { ...DEFAULT_PARAMS, spongeCells: 10 }), 'warning').includes('sponge-thin'));
  });

  console.log('checkDecay');
  await test('flags a signal that has not decayed, accepts one that has', () => {
    const ringing = new Float32Array(1000).map((_, i) => Math.sin(i * 0.3));
    assert.ok(codes(checkDecay([ringing]), 'warning').includes('not-decayed'));
    const decayed = new Float32Array(1000).map((_, i) => Math.sin(i * 0.3) * Math.exp(-i / 60));
    assert.deepEqual(codes(checkDecay([decayed])), []);
    assert.ok(codes(checkDecay([new Float32Array(100)]), 'error').includes('no-signal'));
  });

  console.log('runner integration');
  await test('runSimulation rejects an invalid scene', async () => {
    const s = sideRadialScene();
    s.measure.radius = 400;
    await assert.rejects(() => runSimulation(s, DEFAULT_PARAMS), /probe-outside/);
  });
  await test('runSimulation trims the spectrum to the reliable fMin', async () => {
    const s = PRESETS['piston-baffle']();
    const params = { ...DEFAULT_PARAMS, dx: 3, fMax: 8000, fMin: 100, durationMs: 3, spongeCells: 20 };
    const out = await runSimulation(s, params);
    assert.ok(out);
    assert.ok(out.result.freqs[0] >= reliableFMin(s, 3) - 1);
    assert.ok(out.result.fMinReliable > 0);
    assert.ok(out.warnings.some((w) => w.code === 'fmin-unreliable'));
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
}
main();
