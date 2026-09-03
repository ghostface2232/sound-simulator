/**
 * Scene description for the axisymmetric (r-z) simulation.
 * All lengths are in millimetres. The axis of symmetry is r = 0.
 * Shapes are rasterised in order; later shapes overwrite earlier ones,
 * so an 'air' shape can punch a hole through a rigid wall.
 */

export type Material = 'rigid' | 'fabric' | 'air';

/** What a shape represents; drives colours in the editor and a few geometry checks. */
export type ShapeRole = 'housing' | 'reflector' | 'slot' | 'fabric' | 'driver' | 'other';

export interface RectShape {
  kind: 'rect';
  r: [number, number];
  z: [number, number];
  material: Material;
  role?: ShapeRole;
  /** Flow resistivity in Pa·s/m² (fabric only). Typical grille cloth: 1e5–5e5. */
  sigma?: number;
  label?: string;
}

export interface PolygonShape {
  kind: 'polygon';
  /** Vertices as [r, z] pairs, in mm. */
  points: [number, number][];
  material: Material;
  role?: ShapeRole;
  sigma?: number;
  label?: string;
}

/** Anchor of a closed cubic-Bézier path. Handles are absolute [r, z]; a missing handle means a straight segment end. */
export interface PathNode {
  p: [number, number];
  hIn?: [number, number];
  hOut?: [number, number];
}

/** Closed path of cubic Bézier segments (the editor's native form). Flattened to a polygon for the solver. */
export interface PathShape {
  kind: 'path';
  nodes: PathNode[];
  material: Material;
  role?: ShapeRole;
  sigma?: number;
  label?: string;
  /** For slot/fabric bands: 'z' runs along the side wall (default), 'r' along a top/bottom plate. */
  axis?: 'z' | 'r';
}

export type Shape = RectShape | PolygonShape | PathShape;

/** A flat piston (disc or annulus) at height z, moving along the axis. */
export interface PistonDriver {
  kind: 'piston';
  z: number;
  r: [number, number];
  dir: '+z' | '-z';
  label?: string;
}

/** A cylindrical radiating surface at radius r spanning a z range, moving radially. */
export interface RadialDriver {
  kind: 'radial';
  r: number;
  z: [number, number];
  dir: '+r' | '-r';
  label?: string;
}

export type Driver = PistonDriver | RadialDriver;

export interface Scene {
  name: string;
  description?: string;
  domain: { rMax: number; zMin: number; zMax: number };
  /**
   * Measurement arc: centre on the axis at zCenter, angle measured from +z.
   * angleMax (default 180) limits the arc, e.g. 90 for a half-space baffle case.
   */
  measure: { radius: number; zCenter: number; angleStep: number; angleMax?: number };
  shapes: Shape[];
  drivers: Driver[];
  /** Infinite rigid ground plane: everything at z <= floor.z is solid across the whole domain. */
  floor?: { enabled: boolean; z: number };
}

export interface SimParams {
  /** Grid spacing in mm. */
  dx: number;
  /** Simulated time in ms. */
  durationMs: number;
  /** Upper frequency of interest (Hz); sets the source pulse width. */
  fMax: number;
  /**
   * Lowest frequency the user wants to see (Hz). The spectrum is cut at the
   * larger of this and what the run length can actually resolve.
   */
  fMin: number;
  /** Absorbing layer thickness in cells. */
  spongeCells: number;
  /** Peak per-step damping fraction at the outer edge of the sponge. */
  spongeMax?: number;
  /** Courant number (fraction of the stability limit). */
  courant: number;
  /** Compute backend. 'auto' uses WebGPU when available and falls back to CPU. */
  backend?: 'auto' | 'gpu' | 'cpu';
}

export const DEFAULT_PARAMS: SimParams = {
  dx: 1,
  durationMs: 6,
  fMax: 20000,
  // 6 ms minus the arrival delay resolves ~530 Hz; 500 Hz keeps the default run warning-free.
  fMin: 500,
  spongeCells: 100,
  spongeMax: 0.05,
  courant: 0.45,
};
