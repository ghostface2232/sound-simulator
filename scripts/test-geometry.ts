/** Geometry helper and conflict-check tests. Run with: npm test */
import assert from 'node:assert/strict';
import {
  polygonSelfIntersection, polygonArea, polygonsOverlap, normalizeScene, checkGeometry, asAxisAlignedRect,
  bezierPoint, flattenPath, splitSegment, smoothNode, isSmoothNode, shapeToPath, FLATTEN_STEP, type Pt,
} from '../src/engine/geometry';
import { parsePathD, sceneToSvg } from '../src/engine/svg';
import type { PathNode } from '../src/engine/scene';
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
      assert.ok(s.shapes.every((sh) => sh.kind === 'path' && sh.role), k);
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
    (s.shapes[slot] as { nodes: PathNode[] }).nodes = [{ p: [60, 0] }, { p: [70, 0] }, { p: [70, 10] }, { p: [60, 10] }];
    assert.ok(codes(checkGeometry(s), 'warning').includes('slot-no-wall'));
    s.shapes.push({ kind: 'polygon', points: [[0, 100], [10, 110], [10, 100], [0, 110]], material: 'rigid', role: 'other' });
    s.shapes.push({ kind: 'polygon', points: [[0, 120], [10, 120], [20, 120]], material: 'rigid', role: 'other' });
    const c = codes(checkGeometry(s), 'error');
    assert.ok(c.includes('poly-self-intersect') && c.includes('poly-degenerate'), c.join());
  });
  await test('a clean scene has no geometry diagnostics', () => {
    assert.deepEqual(checkGeometry(normalizeScene(sideRadialScene())), []);
  });

  console.log('bezier paths');
  await test('flattened curve lies on the true curve with chords no longer than the step', () => {
    const nodes: PathNode[] = [
      { p: [0, 0], hOut: [10, 0] }, { p: [20, 10], hIn: [20, 0], hOut: [20, 20] }, { p: [0, 20], hIn: [10, 20] },
    ];
    const pts = flattenPath(nodes);
    assert.ok(pts.length > 30, 'curve is subdivided');
    for (const q of pts) {
      let best = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i], b = nodes[(i + 1) % nodes.length];
        const c1 = a.hOut ?? a.p, c2 = b.hIn ?? b.p;
        for (let k = 0; k <= 400; k++) {
          const x = bezierPoint(a.p, c1, c2, b.p, k / 400);
          best = Math.min(best, Math.hypot(x[0] - q[0], x[1] - q[1]));
        }
      }
      assert.ok(best < 0.05, `point off-curve by ${best}`);
    }
    for (let i = 1; i < pts.length; i++) {
      assert.ok(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) <= FLATTEN_STEP * 1.6);
    }
  });
  await test('splitting a segment preserves the curve and yields a smooth anchor', () => {
    const a: PathNode = { p: [0, 0], hOut: [10, 0] }, b: PathNode = { p: [20, 10], hIn: [20, 0] };
    const { a: na, mid, b: nb } = splitSegment(a, b, 0.37);
    const before = flattenPath([a, b, { p: [0, 10] }], 0.1);
    const after = flattenPath([na, mid, nb, { p: [0, 10] }], 0.1);
    for (const q of after) {
      const d = Math.min(...before.map((x) => Math.hypot(x[0] - q[0], x[1] - q[1])));
      assert.ok(d < 0.15, `split moved the curve by ${d}`);
    }
    assert.ok(isSmoothNode(mid));
  });
  await test('smoothing gives mirrored handles; a straight rect flattens to its 4 corners', () => {
    const sq: PathNode[] = [{ p: [0, 0] }, { p: [10, 0] }, { p: [10, 10] }, { p: [0, 10] }];
    assert.ok(isSmoothNode(smoothNode(sq, 1)));
    assert.deepEqual(flattenPath(sq), [[0, 0], [10, 0], [10, 10], [0, 10]]);
    assert.deepEqual(shapeToPath({ kind: 'rect', r: [0, 10], z: [0, 10], material: 'rigid' }).nodes.map((n) => n.p), [[0, 0], [10, 0], [10, 10], [0, 10]]);
  });
  await test('ellipse path lies on the ellipse; driver body sits behind the face and passes checks', async () => {
    const { ellipsePath, driverBodyShape, flattenPath: flat, checkGeometry: cg } = await import('../src/engine/geometry');
    const pts = flat(ellipsePath(20, 30, 10, 6));
    for (const [r, z] of pts) {
      const e = ((r - 20) / 10) ** 2 + ((z - 30) / 6) ** 2;
      assert.ok(Math.abs(e - 1) < 0.01, `ellipse error ${e}`);
    }
    const s = normalizeScene(sideRadialScene());
    const body = driverBodyShape(s.drivers[0]);
    assert.equal(body.role, 'driver');
    // Driver fires -z from z = 36, so the body must lie above the face.
    assert.ok(body.nodes.every((n) => n.p[1] >= 36), 'body behind the face');
    s.shapes.push(body);
    assert.deepEqual(cg(s).filter((d) => d.severity === 'error'), []);
  });
  await test('slots and fabric are bands; defaults sit on the outer wall and pass checks', async () => {
    const { bandOf, bandNodes, defaultSlot, defaultFabric, outerRadius, checkGeometry: cg } = await import('../src/engine/geometry');
    const s = normalizeScene(sideRadialScene());
    const slot = s.shapes.find((x) => x.role === 'slot')!, fabric = s.shapes.find((x) => x.role === 'fabric')!, refl = s.shapes.find((x) => x.role === 'reflector')!;
    assert.deepEqual(bandOf(slot), { r0: 31.5, r1: 37, z0: 3, z1: 13, axis: 'z' });
    assert.deepEqual(bandOf(fabric), { r0: 35, r1: 36, z0: 2, z1: 14, axis: 'z' });
    assert.equal(bandOf(refl), null, 'a triangle is not a band');
    assert.deepEqual(bandNodes({ r0: 5, r1: 2, z0: 9, z1: 4 }).map((n) => n.p), [[2, 4], [5, 4], [5, 9], [2, 9]]);
    assert.equal(outerRadius(s), 35);
    const s2 = { ...s, shapes: [...s.shapes.filter((x) => x.role !== 'slot' && x.role !== 'fabric'), defaultSlot(s), defaultFabric(s)] };
    const ns = defaultSlot(s), nf = defaultFabric(s);
    assert.deepEqual(bandOf(ns), { r0: 29, r1: 37, z0: 3, z1: 13, axis: 'z' });
    assert.deepEqual(bandOf(nf), { r0: 35, r1: 36, z0: 2, z1: 14, axis: 'z' });
    assert.deepEqual(cg(s2).filter((d) => d.severity === 'error'), []);
    assert.ok(!cg(s2).some((d) => d.code === 'slot-no-wall'), 'default slot cuts the wall');
    // Top and bottom plates: radial bands cutting the plate thickness.
    const top = defaultSlot(s, 'top'), bottom = defaultSlot(s, 'bottom'), topFab = defaultFabric(s, 'top');
    assert.deepEqual(bandOf(top), { r0: 10, r1: 20, z0: 54, z1: 62, axis: 'r' });
    assert.deepEqual(bandOf(bottom), { r0: 10, r1: 20, z0: -2, z1: 6, axis: 'r' });
    assert.deepEqual(bandOf(topFab), { r0: 9, r1: 21, z0: 60, z1: 61, axis: 'r' });
    const s3 = { ...s, shapes: [...s.shapes, top, bottom] };
    assert.ok(!cg(s3).some((d) => d.code === 'slot-no-wall'), 'plate slots cut the plates');
  });
  await test('floor: rows at z <= floor are solid, probes below it are errors, max angle is computed', async () => {
    const { maxAngleAboveFloor, checkGeometry: cg } = await import('../src/engine/geometry');
    const s = normalizeScene(sideRadialScene());
    s.floor = { enabled: true, z: 0 };
    const g = buildGrid(s, 1);
    const jFloor = Math.round((0 - s.domain.zMin) / 1);
    assert.ok(g.solid[jFloor * g.Nr + Math.floor(g.Nr / 2)] === 1 && g.solid[(jFloor + 3) * g.Nr + Math.floor(g.Nr / 2)] === 0, 'solid below the floor, air above');
    assert.ok(cg(s).some((d) => d.code === 'probe-below-floor'), 'arc dips below the floor');
    const am = maxAngleAboveFloor(s);
    assert.ok(am < 180 && am % s.measure.angleStep === 0, `max angle ${am}`);
    s.measure.angleMax = am;
    assert.ok(!cg(s).some((d) => d.code === 'probe-below-floor'));
  });
  await test('SVG export writes cubic paths that parse back to the same anchors and handles', () => {
    const s = normalizeScene(sideRadialScene());
    const refl = s.shapes.findIndex((x) => x.role === 'reflector');
    const rs = shapeToPath(s.shapes[refl]);
    rs.nodes = rs.nodes.map((_, i) => smoothNode(rs.nodes, i));
    s.shapes[refl] = rs;
    const svg = sceneToSvg(s);
    const d = svg.match(/id="reflector_cone"[^>]*d="([^"]+)"/)?.[1];
    assert.ok(d && d.includes(' C '), 'reflector exported as a cubic path');
    const back = parsePathD(d!)[0];
    assert.equal(back.length, rs.nodes.length);
    const same = (a?: Pt, b?: Pt) => (!a && !b) || (!!a && !!b && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3);
    back.forEach((n, i) => {
      const o = rs.nodes[i];
      assert.ok(same(n.p, o.p), `anchor ${i}`);
      assert.ok(same(n.hIn, o.hIn), `hIn ${i}`);
      assert.ok(same(n.hOut, o.hOut), `hOut ${i}`);
    });
    assert.ok(rs.nodes.some((n) => n.hIn && n.hOut), 'at least one fully smooth anchor round-trips');
    assert.equal(parsePathD('M 0 0 L 10 0 L 10 -10 Z')[0].length, 3);
    assert.deepEqual(parsePathD('m 5 5 l 10 0 v 10 h -10 z')[0].map((n) => n.p), [[5, -5], [15, -5], [15, -15], [5, -15]]);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
}
main();
