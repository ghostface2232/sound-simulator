/** Geometry helper and conflict-check tests. Run with: npm test */
import assert from 'node:assert/strict';
import {
  polygonSelfIntersection, polygonArea, polygonsOverlap, normalizeScene, checkGeometry, asAxisAlignedRect, type Pt,
} from '../src/engine/geometry';
import { buildGrid } from '../src/engine/rasterize';
import { diagnose } from '../src/engine/runner';
import { hasErrors } from '../src/engine/checks';
import { PRESETS, sideRadialScene } from '../src/engine/presets';
import { DEFAULT_PARAMS } from '../src/engine/scene';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`); process.exitCode = 1; }
}
const codes = (d: { code: string; severity: string }[], sev?: string) => d.filter((x) => !sev || x.severity === sev).map((x) => x.code);

async function main() {
  console.log('polygon predicates');
  await test('self-intersection: bow-tie yes, square no', () => {
    const bowtie: Pt[] = [[0, 0], [10, 10], [10, 0], [0, 10]];
    const square: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    assert.ok(polygonSelfIntersection(bowtie));
    assert.equal(polygonSelfIntersection(square), null);
    assert.equal(Math.abs(polygonArea(square)), 100);
    assert.deepEqual(asAxisAlignedRect(square), { r0: 0, r1: 10, z0: 0, z1: 10 });
    assert.equal(asAxisAlignedRect([[0, 0], [10, 0], [5, 10]]), null);
  });
  await test('overlap: crossing, containment, and disjoint', () => {
    const a: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    assert.ok(polygonsOverlap(a, [[5, 5], [15, 5], [15, 15], [5, 15]]));
    assert.ok(polygonsOverlap(a, [[2, 2], [4, 2], [3, 4]]));
    assert.ok(!polygonsOverlap(a, [[20, 20], [30, 20], [30, 30]]));
  });

  console.log('normalisation');
  await test('rect -> polygon scenes rasterise to identical grids', () => {
    for (const dx of [1, 2.5]) {
      const a = buildGrid(sideRadialScene(), dx);
      const b = buildGrid(normalizeScene(sideRadialScene()), dx);
      assert.deepEqual(Array.from(a.solid), Array.from(b.solid), `solid dx ${dx}`);
      assert.deepEqual(Array.from(a.sigma), Array.from(b.sigma), `sigma dx ${dx}`);
      assert.deepEqual(Array.from(a.srcFace), Array.from(b.srcFace));
    }
  });
  await test('normalised presets carry roles and pass all checks', () => {
    for (const [k, mk] of Object.entries(PRESETS)) {
      const s = normalizeScene(mk());
      assert.ok(s.shapes.every((sh) => sh.kind === 'polygon' && sh.role), k);
      assert.ok(!hasErrors(diagnose(s, DEFAULT_PARAMS)), `${k}: ${codes(diagnose(s, DEFAULT_PARAMS), 'error')}`);
    }
  });

  console.log('conflicts');
  await test('reflector apex through the driver is an error that blocks the run', () => {
    const s = normalizeScene(sideRadialScene({ coneApexZ: 40 })); // driver at z = 36 firing down
    const d = checkGeometry(s);
    assert.ok(codes(d, 'error').includes('driver-in-solid'), codes(d).join());
    assert.ok(d.find((x) => x.code === 'driver-in-solid')?.point);
    assert.ok(hasErrors(diagnose(s, DEFAULT_PARAMS)));
  });
  await test('measurement arc through the housing is an error', () => {
    const s = normalizeScene(sideRadialScene());
    s.measure.radius = 30;
    assert.ok(codes(checkGeometry(s), 'error').includes('probe-in-solid'));
  });
  await test('slot that cuts no wall warns; degenerate and self-intersecting polygons error', () => {
    const s = normalizeScene(sideRadialScene());
    const slot = s.shapes.findIndex((x) => x.role === 'slot');
    (s.shapes[slot] as { points: Pt[] }).points = [[60, 0], [70, 0], [70, 10], [60, 10]];
    assert.ok(codes(checkGeometry(s), 'warning').includes('slot-no-wall'));
    s.shapes.push({ kind: 'polygon', points: [[0, 100], [10, 110], [10, 100], [0, 110]], material: 'rigid', role: 'other' });
    s.shapes.push({ kind: 'polygon', points: [[0, 120], [10, 120], [20, 120]], material: 'rigid', role: 'other' });
    const c = codes(checkGeometry(s), 'error');
    assert.ok(c.includes('poly-self-intersect') && c.includes('poly-degenerate'), c.join());
  });
  await test('a clean scene has no geometry diagnostics', () => {
    assert.deepEqual(checkGeometry(normalizeScene(sideRadialScene())), []);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
}
main();
