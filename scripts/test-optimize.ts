/**
 * Optimiser tests (CPU, node):
 *  1. objective sanity on synthetic data
 *  2. Latin-hypercube stratification
 *  3. same seed + settings => identical candidate sequence and scores
 *  4. the optimiser beats a plain baseline reflector on the objective
 * Run with: npm test  (or npx tsx scripts/test-optimize.ts)
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_OBJECTIVE, SIDE_RADIAL_MODEL, latinHypercube, mulberry32, optimize, scoreResult, simParamsFor,
  type OptimizeSettings,
} from '../src/engine/optimize';
import { runSimulation } from '../src/engine/runner';
import type { Scene } from '../src/engine/scene';
import type { SimResult } from '../src/engine/analysis';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

function syntheticResult(fill: (angle: number, f: number) => number): SimResult {
  const angles = Float32Array.from({ length: 37 }, (_, i) => i * 5);
  const freqs = Float32Array.from({ length: 40 }, (_, i) => 500 + i * 250);
  const db = new Float32Array(angles.length * freqs.length);
  for (let a = 0; a < angles.length; a++) for (let k = 0; k < freqs.length; k++) db[a * freqs.length + k] = fill(angles[a], freqs[k]);
  return { angles, freqs, db, dt: 1e-6, nSteps: 1, fMinReliable: 500 };
}

const evaluateWith = (settings: OptimizeSettings) => async (scene: Scene) =>
  (await runSimulation(scene, { ...simParamsFor(settings), backend: 'cpu' }, {}, 1e9))?.result ?? null;

const summarize = (cs: { id: number; origin: string; params: Record<string, number>; score: number }[]) =>
  cs.map((c) => [c.id, c.origin, c.params, Number(c.score.toFixed(6))]);

async function main() {
  console.log('objective');
  await test('uniform omni pattern scores level with zero penalties', () => {
    const b = scoreResult(syntheticResult(() => 30), DEFAULT_OBJECTIVE);
    assert.equal(b.level, 30);
    assert.ok(Math.abs(b.uniformity) < 1e-9 && Math.abs(b.flatness) < 1e-9 && Math.abs(b.leakage) < 1e-9);
    assert.ok(Math.abs(b.score - 30) < 1e-9);
  });
  await test('side-firing pattern beats an up-firing one', () => {
    const side = scoreResult(syntheticResult((a) => 30 - 0.3 * Math.abs(a - 90)), DEFAULT_OBJECTIVE);
    const up = scoreResult(syntheticResult((a) => 30 - 0.3 * a), DEFAULT_OBJECTIVE);
    assert.ok(side.score > up.score, `${side.score} vs ${up.score}`);
    assert.ok(up.leakage > 0 && side.leakage < 0);
  });

  console.log('sampling');
  await test('latin hypercube puts one sample in every stratum of every dimension', () => {
    const n = 16, d = 3;
    const pts = latinHypercube(n, d, mulberry32(42));
    for (let k = 0; k < d; k++) {
      const strata = new Set(pts.map((p) => Math.floor(p[k] * n)));
      assert.equal(strata.size, n, `dim ${k}`);
    }
  });
  await test('mulberry32 is deterministic', () => {
    const a = mulberry32(9), b = mulberry32(9);
    for (let i = 0; i < 100; i++) assert.equal(a(), b());
  });

  console.log('profile model');
  await test('free-form profile model builds valid scenes for dish, truncated cone and bump shapes', async () => {
    const { SIDE_RADIAL_PROFILE_MODEL } = await import('../src/engine/optimize');
    const { diagnose } = await import('../src/engine/runner');
    const { hasErrors } = await import('../src/engine/checks');
    const { DEFAULT_PARAMS } = await import('../src/engine/scene');
    const base = { slotZ0: 3, slotH: 10, driverZ: 36 };
    const shapes = {
      dish: { h0: 2, h1: 3, h2: 6, h3: 12, h4: 20 },
      truncated: { h0: 18, h1: 18, h2: 12, h3: 6, h4: 1.5 },
      bump: { h0: 4, h1: 16, h2: 22, h3: 10, h4: 2 },
    };
    for (const [name, h] of Object.entries(shapes)) {
      const s = SIDE_RADIAL_PROFILE_MODEL.build({ ...base, ...h });
      const refl = s.shapes.find((x) => x.role === 'reflector');
      assert.ok(refl && refl.kind === 'polygon' && refl.points.length === 7, name);
      assert.ok(!hasErrors(diagnose(s, DEFAULT_PARAMS)), `${name}: ${diagnose(s, DEFAULT_PARAMS).filter((d) => d.severity === 'error').map((d) => d.code)}`);
    }
    // Heights above the driver are clamped below the membrane instead of producing a conflict.
    const tall = SIDE_RADIAL_PROFILE_MODEL.build({ ...base, h0: 30, h1: 30, h2: 30, h3: 30, h4: 30 });
    assert.ok(!hasErrors(diagnose(tall, DEFAULT_PARAMS)));
  });

  console.log('optimizer');
  const small: OptimizeSettings = {
    seed: 7, nSamples: 3, nRefine: 2, topK: 2,
    dx: 3, durationMs: 4, fMin: 500, fMax: 6000, spongeMm: 90, objective: DEFAULT_OBJECTIVE,
  };
  await test('same seed and settings reproduce the same candidates and scores', async () => {
    const a = await optimize(SIDE_RADIAL_MODEL, SIDE_RADIAL_MODEL.variables, small, evaluateWith(small));
    const b = await optimize(SIDE_RADIAL_MODEL, SIDE_RADIAL_MODEL.variables, small, evaluateWith(small));
    assert.equal(a.length, 1 + small.nSamples + small.nRefine);
    assert.deepEqual(summarize(a), summarize(b));
    assert.ok(a.every((c) => Number.isFinite(c.score)), 'all candidates evaluated');
  });
  await test('a different seed explores different designs', async () => {
    const a = await optimize(SIDE_RADIAL_MODEL, SIDE_RADIAL_MODEL.variables, { ...small, nRefine: 0 }, evaluateWith(small));
    const b = await optimize(SIDE_RADIAL_MODEL, SIDE_RADIAL_MODEL.variables, { ...small, nRefine: 0, seed: 8 }, evaluateWith(small));
    assert.notDeepEqual(summarize(a.filter((c) => c.origin === 'sample')), summarize(b.filter((c) => c.origin === 'sample')));
  });

  const demo: OptimizeSettings = {
    seed: 3, nSamples: 8, nRefine: 6, topK: 3,
    dx: 2.5, durationMs: 6, fMin: 500, fMax: 10000, spongeMm: 100, objective: DEFAULT_OBJECTIVE,
  };
  await test('optimised reflector beats a plain (almost flat) reflector on the objective', async () => {
    const evaluate = evaluateWith(demo);
    // Plain baseline: tiny cone, narrow base, default slot.
    const plainParams = { coneApexZ: 4, coneBaseR: 8, slotZ0: 3, slotH: 10, driverZ: 36 };
    const plainRes = await evaluate(SIDE_RADIAL_MODEL.build(plainParams));
    assert.ok(plainRes);
    const plain = scoreResult(plainRes, demo.objective);

    const ranked = await optimize(SIDE_RADIAL_MODEL, SIDE_RADIAL_MODEL.variables, demo, evaluate, {
      onProgress: (p) => { if (p.done % 5 === 0) console.log(`       ${p.done}/${p.total} best ${p.best?.score.toFixed(2)}`); },
    });
    const best = ranked[0];
    const baseline = ranked.find((c) => c.origin === 'baseline')!;
    console.log(`       plain ${plain.score.toFixed(2)} | preset baseline ${baseline.score.toFixed(2)} | best ${best.score.toFixed(2)} (#${best.id} ${best.origin}) ${JSON.stringify(best.params)}`);
    console.log(`       best breakdown: level ${best.breakdown!.level.toFixed(1)} uniformity ${best.breakdown!.uniformity.toFixed(2)} flatness ${best.breakdown!.flatness.toFixed(2)} leakage ${best.breakdown!.leakage.toFixed(2)}`);
    assert.ok(best.score > plain.score + 0.5, `best ${best.score} should beat plain ${plain.score} by > 0.5`);
    assert.ok(best.score >= baseline.score, 'baseline is a candidate, so best can never be worse');
    assert.ok(ranked.every((c, i) => i === 0 || ranked[i - 1].score >= c.score), 'ranked descending');
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
}
main();
