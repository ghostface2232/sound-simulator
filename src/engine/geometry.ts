/**
 * 2-D geometry helpers for the r-z section: polygon predicates, cubic Bézier
 * paths (flattening, splitting, smoothing), scene normalisation and the
 * geometric conflict checks that the structural validator does not cover.
 */
import type { Scene, Shape, PathShape, PathNode, Driver, ShapeRole, Material } from './scene';
import type { Diagnostic } from './checks';

export type Pt = [number, number];

/** Maximum chord length (mm) used when flattening curves for the solver and hit-testing. */
export const FLATTEN_STEP = 0.5;

// ---------------------------------------------------------------------------
// Polygons

export function pointInPolygon(r: number, z: number, pts: Pt[]): boolean {
  let inside = false;
  for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
    const [ra, za] = pts[a];
    const [rb, zb] = pts[b];
    if (za > z !== zb > z && r < ((rb - ra) * (z - za)) / (zb - za) + ra) inside = !inside;
  }
  return inside;
}

const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Proper intersection of segments ab and cd (touching at endpoints does not count). */
export function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function segmentIntersection(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const den = (a[0] - b[0]) * (c[1] - d[1]) - (a[1] - b[1]) * (c[0] - d[0]);
  if (Math.abs(den) < 1e-12) return null;
  const t = ((a[0] - c[0]) * (c[1] - d[1]) - (a[1] - c[1]) * (c[0] - d[0])) / den;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/** First self-intersection point of a closed polygon, or null. */
export function polygonSelfIntersection(pts: Pt[]): Pt | null {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through the wrap-around
      const c = pts[j], d = pts[(j + 1) % n];
      if (segmentsIntersect(a, b, c, d)) return segmentIntersection(a, b, c, d) ?? a;
    }
  }
  return null;
}

/** Signed area (positive = counter-clockwise in r-z). */
export function polygonArea(pts: Pt[]): number {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return -s / 2;
}

export function polygonBounds(pts: Pt[]) {
  let r0 = Infinity, r1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [r, z] of pts) {
    if (r < r0) r0 = r; if (r > r1) r1 = r;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { r0, r1, z0, z1 };
}

/** Distance from point p to segment ab. */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}

/** True if the polygons share interior (edge crossing or containment). */
export function polygonsOverlap(a: Pt[], b: Pt[]): boolean {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return a.some(([r, z]) => pointInPolygon(r, z, b)) || b.some(([r, z]) => pointInPolygon(r, z, a));
}

/** If the polygon is an axis-aligned rectangle, return its bounds. */
export function asAxisAlignedRect(pts: Pt[]): { r0: number; r1: number; z0: number; z1: number } | null {
  if (pts.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4];
    if (Math.abs(a[0] - b[0]) > 1e-9 && Math.abs(a[1] - b[1]) > 1e-9) return null;
  }
  const bb = polygonBounds(pts);
  return Math.abs(polygonArea(pts)) > 1e-9 ? bb : null;
}

// ---------------------------------------------------------------------------
// Cubic Bézier paths

export const bezierPoint = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt => {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
};

export const segmentIsLine = (a: PathNode, b: PathNode): boolean => !a.hOut && !b.hIn;

/** Control points of the segment from node a to node b. */
export function segmentControls(a: PathNode, b: PathNode): [Pt, Pt, Pt, Pt] {
  return [a.p, a.hOut ?? a.p, b.hIn ?? b.p, b.p];
}

/** Points along the segment a→b including a, excluding b. */
export function flattenSegment(a: PathNode, b: PathNode, maxStep = FLATTEN_STEP): Pt[] {
  if (segmentIsLine(a, b)) return [a.p];
  const [p0, p1, p2, p3] = segmentControls(a, b);
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const n = Math.min(256, Math.max(2, Math.ceil(len / maxStep)));
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) out.push(bezierPoint(p0, p1, p2, p3, i / n));
  return out;
}

/** Flatten a closed path to a polygon. Straight segments contribute only their start node. */
export function flattenPath(nodes: PathNode[], maxStep = FLATTEN_STEP): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < nodes.length; i++) out.push(...flattenSegment(nodes[i], nodes[(i + 1) % nodes.length], maxStep));
  return out;
}

/** Split segment a→b at parameter t (de Casteljau). The returned nodes reproduce the original curve. */
export function splitSegment(a: PathNode, b: PathNode, t: number): { a: PathNode; mid: PathNode; b: PathNode } {
  if (segmentIsLine(a, b)) {
    return { a, mid: { p: [a.p[0] + t * (b.p[0] - a.p[0]), a.p[1] + t * (b.p[1] - a.p[1])] }, b };
  }
  const [p0, p1, p2, p3] = segmentControls(a, b);
  const lerp = (x: Pt, y: Pt): Pt => [x[0] + t * (y[0] - x[0]), x[1] + t * (y[1] - x[1])];
  const q0 = lerp(p0, p1), q1 = lerp(p1, p2), q2 = lerp(p2, p3);
  const r0 = lerp(q0, q1), r1 = lerp(q1, q2);
  const m = lerp(r0, r1);
  return {
    a: { ...a, hOut: q0 },
    mid: { p: m, hIn: r0, hOut: r1 },
    b: { ...b, hIn: q2 },
  };
}

/** Nearest point on the path to q: segment index, parameter and distance. */
export function nearestOnPath(nodes: PathNode[], q: Pt): { seg: number; t: number; dist: number; point: Pt } {
  let best = { seg: 0, t: 0, dist: Infinity, point: nodes[0]?.p ?? [0, 0] as Pt };
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i], b = nodes[(i + 1) % nodes.length];
    if (segmentIsLine(a, b)) {
      const dx = b.p[0] - a.p[0], dz = b.p[1] - a.p[1];
      const l2 = dx * dx + dz * dz;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((q[0] - a.p[0]) * dx + (q[1] - a.p[1]) * dz) / l2));
      const point: Pt = [a.p[0] + t * dx, a.p[1] + t * dz];
      const dist = Math.hypot(q[0] - point[0], q[1] - point[1]);
      if (dist < best.dist) best = { seg: i, t, dist, point };
    } else {
      const [p0, p1, p2, p3] = segmentControls(a, b);
      const n = 48;
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const point = bezierPoint(p0, p1, p2, p3, t);
        const dist = Math.hypot(q[0] - point[0], q[1] - point[1]);
        if (dist < best.dist) best = { seg: i, t, dist, point };
      }
    }
  }
  return best;
}

/** Give node i Catmull-Rom style tangent handles (smooth corner). */
export function smoothNode(nodes: PathNode[], i: number): PathNode {
  const n = nodes.length;
  const prev = nodes[(i - 1 + n) % n].p, next = nodes[(i + 1) % n].p, p = nodes[i].p;
  if (p[0] < 1e-9) {
    // Anchor on the axis: the mirrored shape must stay C1 across r = 0, so the tangent is
    // perpendicular to the axis, and no handle may cross to r < 0. Segments running along the
    // axis (neighbour also at r = 0) stay straight.
    const out: PathNode = { p };
    if (next[0] > 1e-9) out.hOut = [Math.abs(next[0] - p[0]) / 3, p[1]];
    if (prev[0] > 1e-9) out.hIn = [Math.abs(prev[0] - p[0]) / 3, p[1]];
    return out;
  }
  const d: Pt = [(next[0] - prev[0]) / 6, (next[1] - prev[1]) / 6];
  return { p, hIn: [Math.max(0, p[0] - d[0]), p[1] - d[1]], hOut: [Math.max(0, p[0] + d[0]), p[1] + d[1]] };
}

export const cornerNode = (node: PathNode): PathNode => ({ p: node.p });

/** True if both handles exist and are collinear through the anchor. */
export function isSmoothNode(node: PathNode): boolean {
  if (!node.hIn || !node.hOut) return false;
  const a: Pt = [node.hIn[0] - node.p[0], node.hIn[1] - node.p[1]];
  const b: Pt = [node.hOut[0] - node.p[0], node.hOut[1] - node.p[1]];
  const la = Math.hypot(a[0], a[1]), lb = Math.hypot(b[0], b[1]);
  if (la < 1e-9 || lb < 1e-9) return false;
  return (a[0] * b[0] + a[1] * b[1]) / (la * lb) < -0.999;
}

export function polygonToPath(pts: Pt[]): PathNode[] {
  return pts.map((p) => ({ p: [p[0], p[1]] as Pt }));
}

// ---------------------------------------------------------------------------
// Shapes and scenes

export function shapeToPolygon(s: Shape): Pt[] {
  if (s.kind === 'polygon') return s.points;
  if (s.kind === 'path') return flattenPath(s.nodes);
  const r0 = Math.min(...s.r), r1 = Math.max(...s.r), z0 = Math.min(...s.z), z1 = Math.max(...s.z);
  return [[r0, z0], [r1, z0], [r1, z1], [r0, z1]];
}

/** Editor form of any shape: a closed Bézier path (straight segments where the source had none). */
export function shapeToPath(s: Shape): PathShape {
  const base = { material: s.material, role: s.role ?? defaultRole(s.material), ...(s.sigma !== undefined ? { sigma: s.sigma } : {}), ...(s.label !== undefined ? { label: s.label } : {}) };
  if (s.kind === 'path') return { ...base, kind: 'path', nodes: s.nodes.map((n) => ({ p: [n.p[0], n.p[1]] as Pt, ...(n.hIn ? { hIn: [n.hIn[0], n.hIn[1]] as Pt } : {}), ...(n.hOut ? { hOut: [n.hOut[0], n.hOut[1]] as Pt } : {}) })) };
  return { ...base, kind: 'path', nodes: polygonToPath(shapeToPolygon(s)) };
}

export function defaultRole(material: Material): ShapeRole {
  return material === 'rigid' ? 'housing' : material === 'fabric' ? 'fabric' : 'slot';
}

/** Closed 4-anchor Bézier ellipse centred at (cr, cz). Anchors are clamped to r >= 0. */
export function ellipsePath(cr: number, cz: number, rr: number, rz: number): PathNode[] {
  const k = 0.5522847498; // circle approximation constant
  const R = (r: number) => Math.max(0, r);
  return [
    { p: [R(cr + rr), cz], hIn: [R(cr + rr), cz - k * rz], hOut: [R(cr + rr), cz + k * rz] },
    { p: [cr, cz + rz], hIn: [R(cr + k * rr), cz + rz], hOut: [R(cr - k * rr), cz + rz] },
    { p: [R(cr - rr), cz], hIn: [R(cr - rr), cz + k * rz], hOut: [R(cr - rr), cz - k * rz] },
    { p: [cr, cz - rz], hIn: [R(cr - k * rr), cz - rz], hOut: [R(cr + k * rr), cz - rz] },
  ];
}

/**
 * Default driver body (basket + magnet) behind a driver face, as an editable rigid path
 * with role 'driver'. Depth is measured away from the firing direction.
 */
export function driverBodyShape(d: Driver, depth = 16): PathShape {
  const { a, b, dir } = driverSegment(d);
  const back = (q: Pt, k: number): Pt => [Math.max(0, q[0] - dir[0] * k), q[1] - dir[1] * k];
  let pts: Pt[];
  if (d.kind === 'piston') {
    const r0 = a[0], r1 = b[0];
    const rim = r1 + 1.5, neck = Math.max(r0 + 2, r1 * 0.45), magnet = Math.max(r0 + 3, r1 * 0.55);
    // Face rim -> basket taper -> magnet block, closed along the axis (or inner radius).
    pts = [
      back([r0, a[1]], 0.5), back([rim, a[1]], 0.5), back([rim, a[1]], 3), back([neck, a[1]], depth * 0.55),
      back([magnet, a[1]], depth * 0.55), back([magnet, a[1]], depth), back([r0, a[1]], depth),
    ];
  } else {
    const z0 = a[1], z1 = b[1], h = z1 - z0;
    pts = [back([a[0], z0 - 1], 0.5), back([a[0], z1 + 1], 0.5), back([a[0], z1 + 1], 3), back([a[0], z0 + h * 0.8], depth), back([a[0], z0 + h * 0.2], depth), back([a[0], z0 - 1], 3)];
  }
  return { kind: 'path', nodes: pts.map((p) => ({ p })), material: 'rigid', role: 'driver', label: `${d.label ?? 'driver'} body` };
}

export interface Band { r0: number; r1: number; z0: number; z1: number }

/** Slots and fabric are edited as bands (z start + length, radial extent) when they are axis-aligned rects. */
export function bandOf(s: Shape): Band | null {
  const role = s.role ?? defaultRole(s.material);
  if (role !== 'slot' && role !== 'fabric') return null;
  return asAxisAlignedRect(shapeToPolygon(s));
}

export function bandNodes(b: Band): PathNode[] {
  const r0 = Math.max(0, Math.min(b.r0, b.r1)), r1 = Math.max(b.r0, b.r1), z0 = Math.min(b.z0, b.z1), z1 = Math.max(b.z0, b.z1);
  return [{ p: [r0, z0] }, { p: [r1, z0] }, { p: [r1, z1] }, { p: [r0, z1] }];
}

/** Outer radius of the rigid parts (where a side slot or fabric would go). */
export function outerRadius(scene: Scene): number {
  let r = 0;
  for (const s of scene.shapes) if (s.material === 'rigid') for (const [rr] of shapeToPolygon(s)) r = Math.max(r, rr);
  return r;
}

/** Default side slot cutting the outer wall (2 mm past both faces, wall assumed <= 4 mm). */
export function defaultSlot(scene: Scene, z0 = 3, length = 10): PathShape {
  const R = outerRadius(scene) || 35;
  return { kind: 'path', nodes: bandNodes({ r0: R - 6, r1: R + 2, z0, z1: z0 + length }), material: 'air', role: 'slot', label: `slot ${scene.shapes.filter((s) => s.role === 'slot').length + 1}` };
}

/** Default fabric layer on the outer surface. */
export function defaultFabric(scene: Scene, z0 = 2, height = 12, thickness = 1): PathShape {
  const R = outerRadius(scene) || 35;
  return { kind: 'path', nodes: bandNodes({ r0: R, r1: R + thickness, z0, z1: z0 + height }), material: 'fabric', role: 'fabric', sigma: 2e5, label: `fabric ${scene.shapes.filter((s) => s.role === 'fabric').length + 1}` };
}

export function materialForRole(role: ShapeRole, current?: Material): Material {
  switch (role) {
    case 'housing': case 'reflector': case 'driver': return 'rigid';
    case 'slot': return 'air';
    case 'fabric': return 'fabric';
    default: return current ?? 'rigid';
  }
}

/** Editor form of a scene: every shape is a path with a role. Rasterises identically to the source. */
export function normalizeScene(scene: Scene): Scene {
  return {
    ...scene,
    shapes: scene.shapes.map(shapeToPath),
    drivers: scene.drivers.map((d) => ({ ...d })),
    measure: { ...scene.measure },
    domain: { ...scene.domain },
  };
}

/** Driver face as a segment plus its firing direction (unit vector in r-z). */
export function driverSegment(d: Driver): { a: Pt; b: Pt; dir: Pt } {
  if (d.kind === 'piston') {
    const r0 = Math.min(...d.r), r1 = Math.max(...d.r);
    return { a: [r0, d.z], b: [r1, d.z], dir: [0, d.dir === '+z' ? 1 : -1] };
  }
  const z0 = Math.min(...d.z), z1 = Math.max(...d.z);
  return { a: [d.r, z0], b: [d.r, z1], dir: [d.dir === '+r' ? 1 : -1, 0] };
}

/** Bounding box of everything the user drew (not the domain). */
export function sceneBounds(scene: Scene) {
  let r0 = Infinity, r1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const add = (r: number, z: number) => { r0 = Math.min(r0, r); r1 = Math.max(r1, r); z0 = Math.min(z0, z); z1 = Math.max(z1, z); };
  for (const s of scene.shapes) for (const [r, z] of shapeToPolygon(s)) add(r, z);
  for (const d of scene.drivers) { const { a, b } = driverSegment(d); add(a[0], a[1]); add(b[0], b[1]); }
  if (!Number.isFinite(r0)) return { r0: 0, r1: 50, z0: 0, z1: 50 };
  return { r0, r1, z0, z1 };
}

const label = (s: { label?: string }, k: number, what: string) => (s.label ? `${s.label}` : `${what} ${k}`);

/**
 * Geometric conflicts: things that are structurally valid JSON but make no
 * physical sense on the grid. Each diagnostic carries the element and, where
 * useful, a point to mark on the canvas.
 */
export function checkGeometry(scene: Scene): Diagnostic[] {
  const out: Diagnostic[] = [];
  const polys = scene.shapes.map(shapeToPolygon);
  const rigid = scene.shapes.map((s, i) => ({ s, i, pts: polys[i] })).filter((x) => x.s.material === 'rigid');

  scene.shapes.forEach((s, k) => {
    const pts = polys[k];
    const name = label(s, k, '형상');
    if (s.kind !== 'rect') {
      const x = polygonSelfIntersection(pts);
      if (x) out.push({ severity: 'error', code: 'poly-self-intersect', message: `${name}: 외곽선이 스스로 교차합니다.`, target: { kind: 'shape', index: k }, point: x });
      if (Math.abs(polygonArea(pts)) < 0.05) out.push({ severity: 'error', code: 'poly-degenerate', message: `${name}: 면적이 0 에 가깝습니다.`, target: { kind: 'shape', index: k }, point: pts[0] });
      if (pts.some(([r]) => r < -1e-9)) out.push({ severity: 'error', code: 'curve-negative-r', message: `${name}: 곡선이 축(r = 0) 왼쪽으로 나갑니다.`, target: { kind: 'shape', index: k }, point: pts.find(([r]) => r < 0) });
    }
    if (s.role === 'slot' && s.material === 'air' && !rigid.some((r) => r.i !== k && polygonsOverlap(pts, r.pts))) {
      out.push({ severity: 'warning', code: 'slot-no-wall', message: `${name}: 슬롯이 어떤 벽도 뚫지 않습니다.`, target: { kind: 'shape', index: k }, point: pts[0] });
    }
  });

  scene.drivers.forEach((d, k) => {
    const { a, b, dir } = driverSegment(d);
    const name = label(d, k, '드라이버');
    // Sample the face and a point 1 mm in front of it; both must be outside every rigid body.
    for (let t = 0; t <= 1.0001; t += 0.25) {
      const r = a[0] + t * (b[0] - a[0]), z = a[1] + t * (b[1] - a[1]);
      const front: Pt = [r + dir[0] * 1, z + dir[1] * 1];
      const hit = rigid.find((x) => pointInPolygon(front[0], front[1], x.pts) || pointInPolygon(r, z, x.pts));
      if (hit) {
        const role = hit.s.role === 'reflector' ? '리플렉터' : '고체';
        out.push({ severity: 'error', code: 'driver-in-solid', message: `${name}: 진동판 앞이 ${role}(${label(hit.s, hit.i, '형상')}) 안에 있습니다. 소리가 나갈 수 없습니다.`, target: { kind: 'driver', index: k }, point: front });
        break;
      }
    }
  });

  {
    const { radius, zCenter, angleStep, angleMax = 180 } = scene.measure;
    for (let ang = 0; ang <= angleMax + 1e-9; ang += angleStep) {
      const th = (ang * Math.PI) / 180;
      const r = radius * Math.sin(th), z = zCenter + radius * Math.cos(th);
      const hit = rigid.find((x) => pointInPolygon(r, z, x.pts));
      if (hit) {
        out.push({ severity: 'error', code: 'probe-in-solid', message: `측정 원호가 고체(${label(hit.s, hit.i, '형상')}) 를 지납니다 (θ = ${ang}°). 반경을 키우세요.`, target: { kind: 'measure', index: 0 }, point: [r, z] });
        break;
      }
    }
  }
  return out;
}
