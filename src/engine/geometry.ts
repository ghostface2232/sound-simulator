/**
 * 2-D geometry helpers for the r-z section: polygon predicates, scene
 * normalisation (rect -> polygon) and geometric conflict checks that the
 * structural validator in checks.ts does not cover.
 */
import type { Scene, Shape, PolygonShape, Driver, ShapeRole, Material } from './scene';
import type { Diagnostic } from './checks';

export type Pt = [number, number];

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

export function shapeToPolygon(s: Shape): Pt[] {
  if (s.kind === 'polygon') return s.points;
  const r0 = Math.min(...s.r), r1 = Math.max(...s.r), z0 = Math.min(...s.z), z1 = Math.max(...s.z);
  return [[r0, z0], [r1, z0], [r1, z1], [r0, z1]];
}

export function defaultRole(material: Material): ShapeRole {
  return material === 'rigid' ? 'housing' : material === 'fabric' ? 'fabric' : 'slot';
}

export function materialForRole(role: ShapeRole, current?: Material): Material {
  switch (role) {
    case 'housing': case 'reflector': return 'rigid';
    case 'slot': return 'air';
    case 'fabric': return 'fabric';
    default: return current ?? 'rigid';
  }
}

/** Editor form of a scene: every shape is a polygon with a role. Rasterises identically. */
export function normalizeScene(scene: Scene): Scene {
  const shapes: PolygonShape[] = scene.shapes.map((s) => ({
    kind: 'polygon',
    points: shapeToPolygon(s).map(([r, z]) => [r, z] as Pt),
    material: s.material,
    role: s.role ?? defaultRole(s.material),
    ...(s.sigma !== undefined ? { sigma: s.sigma } : {}),
    ...(s.label !== undefined ? { label: s.label } : {}),
  }));
  return { ...scene, shapes, drivers: scene.drivers.map((d) => ({ ...d })), measure: { ...scene.measure }, domain: { ...scene.domain } };
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
    if (s.kind === 'polygon') {
      const x = polygonSelfIntersection(pts);
      if (x) out.push({ severity: 'error', code: 'poly-self-intersect', message: `${name}: 폴리곤이 스스로 교차합니다.`, target: { kind: 'shape', index: k }, point: x });
      if (Math.abs(polygonArea(pts)) < 0.05) out.push({ severity: 'error', code: 'poly-degenerate', message: `${name}: 면적이 0 에 가깝습니다.`, target: { kind: 'shape', index: k }, point: pts[0] });
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
