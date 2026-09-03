import type { Scene, Shape } from './scene';
import { pointInPolygon, polygonBounds, asAxisAlignedRect, shapeToPolygon } from './geometry';

/** Grid data produced from a Scene, ready for the solver. */
export interface BuiltGrid {
  Nr: number;
  Nz: number;
  dx: number;
  zMin: number;
  /** 1 = rigid cell, 0 = air/fabric. Indexed j*Nr + i (r fastest). */
  solid: Uint8Array;
  /** Flow resistivity per cell (Pa·s/m²), 0 for air. */
  sigma: Float32Array;
  /** Source faces: index into the vr or vz array. */
  srcFace: Int32Array;
  /** 1 = vz face, 0 = vr face. */
  srcIsZ: Uint8Array;
  /** Signed area weight of the prescribed velocity (±1 inside the driver, partial at its edges). */
  srcSign: Float32Array;
  /** Probe positions in fractional grid coordinates (fr, fz) and their angles (deg). */
  probes: { fr: number; fz: number; angleDeg: number }[];
}

/**
 * Rasterise a shape. Rigid/fabric shapes mark every cell they overlap
 * (so walls thinner than dx still exist); air cut-outs use the cell
 * centre so holes do not grow.
 */
function rasterShape(
  s: Shape,
  Nr: number, Nz: number, dx: number, zMin: number,
  solid: Uint8Array, sigma: Float32Array,
) {
  const conservative = s.material !== 'air';
  const half = conservative ? dx * 0.5 : 0;

  // Axis-aligned polygons (the editor form of a rect) take the exact rect path so both forms rasterise identically.
  const poly = s.kind === 'rect' ? null : shapeToPolygon(s);
  const rectBounds = s.kind === 'rect'
    ? { r0: Math.min(...s.r), r1: Math.max(...s.r), z0: Math.min(...s.z), z1: Math.max(...s.z) }
    : asAxisAlignedRect(poly!);
  const b = rectBounds ?? polygonBounds(poly!);
  const asRect = rectBounds !== null;

  const i0 = Math.max(0, Math.floor((b.r0 - half) / dx));
  const i1 = Math.min(Nr - 1, Math.ceil((b.r1 + half) / dx));
  const j0 = Math.max(0, Math.floor((b.z0 - half - zMin) / dx));
  const j1 = Math.min(Nz - 1, Math.ceil((b.z1 + half - zMin) / dx));

  for (let j = j0; j <= j1; j++) {
    const z = zMin + j * dx;
    for (let i = i0; i <= i1; i++) {
      const r = i * dx;
      let hit: boolean;
      if (asRect) {
        hit = r + half > b.r0 && r - half < b.r1 && z + half > b.z0 && z - half < b.z1;
      } else {
        const pts = poly!;
        hit = conservative
          ? pointInPolygon(r, z, pts) ||
            pointInPolygon(r - half, z - half, pts) || pointInPolygon(r + half, z - half, pts) ||
            pointInPolygon(r - half, z + half, pts) || pointInPolygon(r + half, z + half, pts)
          : pointInPolygon(r, z, pts);
      }
      if (!hit) continue;
      const c = j * Nr + i;
      if (s.material === 'rigid') { solid[c] = 1; sigma[c] = 0; }
      else if (s.material === 'fabric') { solid[c] = 0; sigma[c] = s.sigma ?? 2e5; }
      else { solid[c] = 0; sigma[c] = 0; }
    }
  }
}

export function buildGrid(scene: Scene, dx: number): BuiltGrid {
  const { rMax, zMin, zMax } = scene.domain;
  const Nr = Math.round(rMax / dx) + 1;
  const Nz = Math.round((zMax - zMin) / dx) + 1;
  const solid = new Uint8Array(Nr * Nz);
  const sigma = new Float32Array(Nr * Nz);

  for (const s of scene.shapes) rasterShape(s, Nr, Nz, dx, zMin, solid, sigma);

  // Ground plane: solid rows across the full radius (conservative: any cell overlapping z <= floor).
  if (scene.floor?.enabled) {
    const jTop = Math.min(Nz - 1, Math.floor((scene.floor.z - zMin) / dx + 0.5 - 1e-9));
    for (let j = 0; j <= jTop; j++) for (let i = 0; i < Nr; i++) { solid[j * Nr + i] = 1; sigma[j * Nr + i] = 0; }
  }

  const srcFace: number[] = [];
  const srcIsZ: number[] = [];
  const srcSign: number[] = [];

  // The cell directly in front of a driver face must be air, otherwise the
  // prescribed velocity sits between two solid cells and radiates nothing.
  const air = (c: number) => { solid[c] = 0; sigma[c] = 0; };

  // Area fraction of cell i (an annulus, or a disc for i = 0) that lies inside [r0, r1].
  const annulusFrac = (i: number, r0: number, r1: number) => {
    const lo = Math.max(0, (i - 0.5) * dx), hi = (i + 0.5) * dx;
    const a = Math.max(lo, r0), b = Math.min(hi, r1);
    if (b <= a) return 0;
    return (b * b - a * a) / (hi * hi - lo * lo);
  };
  // Length fraction of cell j that lies inside [z0, z1].
  const spanFrac = (j: number, z0: number, z1: number) => {
    const lo = zMin + (j - 0.5) * dx, hi = lo + dx;
    return Math.max(0, Math.min(hi, z1) - Math.max(lo, z0)) / dx;
  };

  for (const d of scene.drivers) {
    if (d.kind === "piston") {
      const jd = Math.round((d.z - zMin) / dx);
      const r0 = Math.min(...d.r), r1 = Math.max(...d.r);
      const sign = d.dir === "+z" ? 1 : -1;
      for (let i = 0; i < Nr; i++) {
        const w = annulusFrac(i, r0, r1);
        if (w <= 0) continue;
        if (sign > 0) {
          // Membrane body occupies the two cells behind the face; the cell in front must be air.
          for (const jj of [jd - 1, jd - 2]) if (jj >= 0) solid[jj * Nr + i] = 1;
          if (jd - 1 >= 0 && jd < Nz) { air(jd * Nr + i); srcFace.push((jd - 1) * Nr + i); srcIsZ.push(1); srcSign.push(w); }
        } else {
          for (const jj of [jd, jd + 1]) if (jj < Nz) solid[jj * Nr + i] = 1;
          if (jd - 1 >= 0 && jd < Nz) { air((jd - 1) * Nr + i); srcFace.push((jd - 1) * Nr + i); srcIsZ.push(1); srcSign.push(-w); }
        }
      }
    } else {
      const id = Math.round(d.r / dx);
      const z0 = Math.min(...d.z), z1 = Math.max(...d.z);
      const sign = d.dir === "+r" ? 1 : -1;
      for (let j = 0; j < Nz; j++) {
        const w = spanFrac(j, z0, z1);
        if (w <= 0) continue;
        if (sign > 0) {
          for (const ii of [id - 1, id - 2]) if (ii >= 0) solid[j * Nr + ii] = 1;
          if (id - 1 >= 0 && id < Nr) { air(j * Nr + id); srcFace.push(j * Nr + id - 1); srcIsZ.push(0); srcSign.push(w); }
        } else {
          for (const ii of [id, id + 1]) if (ii < Nr) solid[j * Nr + ii] = 1;
          if (id - 1 >= 0 && id < Nr) { air(j * Nr + id - 1); srcFace.push(j * Nr + id - 1); srcIsZ.push(0); srcSign.push(-w); }
        }
      }
    }
  }

  const probes: BuiltGrid['probes'] = [];
  const { radius, zCenter, angleStep, angleMax = 180 } = scene.measure;
  for (let a = 0; a <= angleMax + 1e-9; a += angleStep) {
    const th = (a * Math.PI) / 180;
    const r = radius * Math.sin(th);
    const z = zCenter + radius * Math.cos(th);
    probes.push({ fr: r / dx, fz: (z - zMin) / dx, angleDeg: a });
  }

  return {
    Nr, Nz, dx, zMin, solid, sigma,
    srcFace: Int32Array.from(srcFace),
    srcIsZ: Uint8Array.from(srcIsZ),
    srcSign: Float32Array.from(srcSign),
    probes,
  };
}
