/**
 * Parametric models, objective function and a deterministic optimiser.
 * Pure TypeScript: usable from the worker, the UI and node scripts.
 */
import type { Scene, SimParams } from './scene';
import type { SimResult } from './analysis';
import { sideRadialScene, SIDE_RADIAL_DEFAULTS } from './presets';

// ---------------------------------------------------------------------------
// Parametric models

export interface DesignVariable {
  key: string;
  label: string;
  unit?: string;
  min: number;
  max: number;
  /** Baseline value, also used when the variable is disabled. */
  value: number;
  enabled: boolean;
}

export interface ParametricModel {
  id: string;
  name: string;
  variables: DesignVariable[];
  build(params: Record<string, number>): Scene;
}

/** Side-radial unit: cone reflector under a down-firing driver, annular side slot. */
export const SIDE_RADIAL_MODEL: ParametricModel = {
  id: 'side-radial',
  name: '측면 방사형 (원뿔 리플렉터 + 환형 슬롯)',
  variables: [
    { key: 'coneApexZ', label: '리플렉터 꼭짓점 높이', unit: 'mm', min: 4, max: 32, value: SIDE_RADIAL_DEFAULTS.coneApexZ, enabled: true },
    { key: 'coneBaseR', label: '리플렉터 바닥 반경', unit: 'mm', min: 8, max: 33, value: SIDE_RADIAL_DEFAULTS.coneBaseR, enabled: true },
    { key: 'slotZ0', label: '슬롯 하단 높이', unit: 'mm', min: 2, max: 30, value: SIDE_RADIAL_DEFAULTS.slotZ[0], enabled: true },
    { key: 'slotH', label: '슬롯 높이', unit: 'mm', min: 3, max: 25, value: SIDE_RADIAL_DEFAULTS.slotZ[1] - SIDE_RADIAL_DEFAULTS.slotZ[0], enabled: true },
    { key: 'driverZ', label: '드라이버 높이', unit: 'mm', min: 25, max: 50, value: SIDE_RADIAL_DEFAULTS.driverZ, enabled: false },
  ],
  build(p) {
    const driverZ = p.driverZ;
    // The cone apex must stay clear of the driver membrane (2 cells + margin).
    const coneApexZ = Math.min(p.coneApexZ, driverZ - 4);
    const zTop = SIDE_RADIAL_DEFAULTS.height - SIDE_RADIAL_DEFAULTS.wall - 1;
    const slotZ0 = Math.min(p.slotZ0, zTop - 3);
    const slotZ1 = Math.min(slotZ0 + p.slotH, zTop);
    return sideRadialScene({ coneApexZ, coneBaseR: p.coneBaseR, slotZ: [slotZ0, slotZ1], driverZ });
  },
};

export const MODELS: Record<string, ParametricModel> = { [SIDE_RADIAL_MODEL.id]: SIDE_RADIAL_MODEL };

/** Parameter vector with every variable at its baseline value. */
export function baselineParams(variables: DesignVariable[]): Record<string, number> {
  const p: Record<string, number> = {};
  for (const v of variables) p[v.key] = v.value;
  return p;
}

// ---------------------------------------------------------------------------
// Objective

export interface ObjectiveSettings {
  /** Frequency band the objective is evaluated over (Hz). */
  band: [number, number];
  /** Main radiation direction (deg from +z; 90 = sideways). */
  sideAngle: number;
  /** Half-width (deg) of the angular window the uniformity term covers. */
  spread: number;
  weights: { level: number; uniformity: number; flatness: number; leakage: number };
}

export const DEFAULT_OBJECTIVE: ObjectiveSettings = {
  band: [1000, 8000],
  sideAngle: 90,
  spread: 30,
  weights: { level: 1, uniformity: 1, flatness: 0.5, leakage: 0.5 },
};

export interface ObjectiveBreakdown {
  /** Weighted total, higher is better. */
  score: number;
  /** Mean dB at the side angle over the band. */
  level: number;
  /** Mean over the band of the std-dev of dB across the angular window. */
  uniformity: number;
  /** Std-dev over the band of the side-angle response. */
  flatness: number;
  /** Mean over the band of max(dB at 0°, dB at 180°) minus the side dB. */
  leakage: number;
}

function nearestIndex(arr: ArrayLike<number>, v: number): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const d = Math.abs(arr[i] - v);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export function scoreResult(res: SimResult, o: ObjectiveSettings): ObjectiveBreakdown {
  const nF = res.freqs.length;
  const kIdx: number[] = [];
  for (let k = 0; k < nF; k++) if (res.freqs[k] >= o.band[0] && res.freqs[k] <= o.band[1]) kIdx.push(k);
  if (kIdx.length === 0) return { score: -Infinity, level: NaN, uniformity: NaN, flatness: NaN, leakage: NaN };

  const aSide = nearestIndex(res.angles, o.sideAngle);
  const aUp = nearestIndex(res.angles, 0);
  const aDown = nearestIndex(res.angles, 180);
  const window: number[] = [];
  for (let a = 0; a < res.angles.length; a++) {
    if (Math.abs(res.angles[a] - o.sideAngle) <= o.spread + 1e-9) window.push(a);
  }
  const at = (a: number, k: number) => res.db[a * nF + k];

  let level = 0, uniformity = 0, leakage = 0;
  const side: number[] = [];
  for (const k of kIdx) {
    const s = at(aSide, k);
    side.push(s);
    level += s;
    let m = 0;
    for (const a of window) m += at(a, k);
    m /= window.length;
    let v = 0;
    for (const a of window) v += (at(a, k) - m) ** 2;
    uniformity += Math.sqrt(v / window.length);
    leakage += Math.max(at(aUp, k), at(aDown, k)) - s;
  }
  level /= kIdx.length;
  uniformity /= kIdx.length;
  leakage /= kIdx.length;
  // A level this low means the probes saw no signal (blocked slot, buried driver): not a valid design.
  if (level < -200) return { score: -Infinity, level, uniformity, flatness: NaN, leakage };
  const mean = side.reduce((x, y) => x + y, 0) / side.length;
  const flatness = Math.sqrt(side.reduce((x, y) => x + (y - mean) ** 2, 0) / side.length);

  const w = o.weights;
  const score = w.level * level - w.uniformity * uniformity - w.flatness * flatness - w.leakage * leakage;
  return { score, level, uniformity, flatness, leakage };
}

// ---------------------------------------------------------------------------
// Deterministic optimiser: Latin-hypercube exploration, then local refinement
// of the best candidates. Same seed + same settings = same sequence of designs.

export interface OptimizeSettings {
  seed: number;
  nSamples: number;
  nRefine: number;
  /** Number of parents kept for refinement. */
  topK: number;
  dx: number;
  durationMs: number;
  fMin: number;
  fMax: number;
  spongeMm: number;
  objective: ObjectiveSettings;
}

export const DEFAULT_OPTIMIZE: OptimizeSettings = {
  seed: 1,
  nSamples: 16,
  nRefine: 12,
  topK: 4,
  dx: 2,
  durationMs: 6,
  fMin: 500,
  fMax: 10000,
  spongeMm: 100,
  objective: DEFAULT_OBJECTIVE,
};

export function simParamsFor(s: OptimizeSettings): SimParams {
  return {
    dx: s.dx,
    durationMs: s.durationMs,
    fMin: s.fMin,
    fMax: s.fMax,
    spongeCells: Math.max(1, Math.round(s.spongeMm / s.dx)),
    spongeMax: 0.05,
    courant: 0.45,
  };
}

export interface Candidate {
  id: number;
  origin: 'baseline' | 'sample' | 'refine';
  params: Record<string, number>;
  score: number;
  breakdown: ObjectiveBreakdown | null;
  result: SimResult | null;
}

export interface OptimizeProgress {
  done: number;
  total: number;
  best: Candidate | null;
  /** Candidates sorted by score, best first. */
  ranked: Candidate[];
}

/** Small, fast, seedable PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n points in [0,1)^dims, one per stratum per dimension. */
export function latinHypercube(n: number, dims: number, rng: () => number): number[][] {
  const pts: number[][] = Array.from({ length: n }, () => new Array<number>(dims).fill(0));
  for (let d = 0; d < dims; d++) {
    const perm = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    for (let i = 0; i < n; i++) pts[i][d] = (perm[i] + rng()) / n;
  }
  return pts;
}

function gaussian(rng: () => number): number {
  const u = 1 - rng(), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Round to 0.1 mm so candidates are readable and grid-stable. */
const snap = (x: number) => Math.round(x * 10) / 10;

export function rankCandidates(cs: Candidate[]): Candidate[] {
  return [...cs].sort((a, b) => (b.score - a.score) || (a.id - b.id));
}

export interface OptimizeHooks {
  onProgress?: (p: OptimizeProgress) => void | Promise<void>;
  shouldStop?: () => boolean;
  /** Called before each evaluation with the candidate about to run. */
  onEvaluate?: (c: Candidate) => void;
}

/**
 * Run the optimisation. `evaluate` must return the simulation result for a
 * scene, or null if the scene is invalid or the run was stopped.
 */
export async function optimize(
  model: ParametricModel,
  variables: DesignVariable[],
  settings: OptimizeSettings,
  evaluate: (scene: Scene, candidate: Candidate) => Promise<SimResult | null>,
  hooks: OptimizeHooks = {},
): Promise<Candidate[]> {
  const rng = mulberry32(settings.seed);
  const active = variables.filter((v) => v.enabled);
  const base = baselineParams(variables);
  const all: Candidate[] = [];
  let nextId = 0;
  const total = 1 + settings.nSamples + settings.nRefine;

  const run = async (params: Record<string, number>, origin: Candidate['origin']): Promise<Candidate | null> => {
    if (hooks.shouldStop?.()) return null;
    const c: Candidate = { id: nextId++, origin, params, score: -Infinity, breakdown: null, result: null };
    hooks.onEvaluate?.(c);
    let result: SimResult | null = null;
    try {
      result = await evaluate(model.build(params), c);
    } catch {
      result = null;
    }
    if (hooks.shouldStop?.()) return null;
    if (result) {
      c.result = result;
      c.breakdown = scoreResult(result, settings.objective);
      c.score = Number.isFinite(c.breakdown.score) ? c.breakdown.score : -Infinity;
    }
    all.push(c);
    const ranked = rankCandidates(all);
    await hooks.onProgress?.({ done: all.length, total, best: ranked[0] ?? null, ranked });
    return c;
  };

  // 1. Baseline (all variables at their default values).
  if (!(await run({ ...base }, 'baseline'))) return rankCandidates(all);

  // 2. Space-filling exploration.
  const lhs = latinHypercube(settings.nSamples, Math.max(1, active.length), rng);
  for (let i = 0; i < settings.nSamples; i++) {
    const p = { ...base };
    active.forEach((v, d) => { p[v.key] = snap(v.min + lhs[i][d] * (v.max - v.min)); });
    if (!(await run(p, 'sample'))) return rankCandidates(all);
  }

  // 3. Local refinement around the current best parents, shrinking step size.
  for (let i = 0; i < settings.nRefine; i++) {
    const parents = rankCandidates(all).filter((c) => Number.isFinite(c.score)).slice(0, settings.topK);
    if (parents.length === 0) break;
    const parent = parents[i % parents.length];
    const sigma = 0.15 * (1 - (0.7 * i) / Math.max(1, settings.nRefine));
    const p = { ...parent.params };
    for (const v of active) p[v.key] = snap(clamp(p[v.key] + gaussian(rng) * sigma * (v.max - v.min), v.min, v.max));
    if (!(await run(p, 'refine'))) return rankCandidates(all);
  }

  return rankCandidates(all);
}
