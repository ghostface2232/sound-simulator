/**
 * Parametric models, objective function and a deterministic optimiser.
 * Pure TypeScript: usable from the worker, the UI and node scripts.
 */
import type { Scene, SimParams, PathNode } from './scene';
import type { SimResult } from './analysis';
import { sideRadialScene, SIDE_RADIAL_DEFAULTS } from './presets';
import { normalizeScene, shapeToPath } from './geometry';

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

/** Reflector as a free-form profile: heights at fixed radii, so dishes, truncated cones and bumps are all reachable. */
export const PROFILE_RADII = [0, 8, 16, 24, 33.5];
export const SIDE_RADIAL_PROFILE_MODEL: ParametricModel = {
  id: 'side-radial-profile',
  name: '측면 방사형, 자유 프로파일 리플렉터 (5점 높이)',
  variables: [
    ...PROFILE_RADII.map((r, i) => ({
      key: `h${i}`, label: `프로파일 높이 @ r=${r}`, unit: 'mm', min: 1.5, max: 30,
      value: Math.max(1.5, 20 - (r / 30) * 18.5), enabled: true,
    })),
    { key: 'slotZ0', label: '슬롯 하단 높이', unit: 'mm', min: 2, max: 30, value: SIDE_RADIAL_DEFAULTS.slotZ[0], enabled: true },
    { key: 'slotH', label: '슬롯 높이', unit: 'mm', min: 3, max: 25, value: SIDE_RADIAL_DEFAULTS.slotZ[1] - SIDE_RADIAL_DEFAULTS.slotZ[0], enabled: true },
    { key: 'driverZ', label: '드라이버 높이', unit: 'mm', min: 25, max: 50, value: SIDE_RADIAL_DEFAULTS.driverZ, enabled: false },
  ],
  build(p) {
    const driverZ = p.driverZ;
    const zTop = SIDE_RADIAL_DEFAULTS.height - SIDE_RADIAL_DEFAULTS.wall - 1;
    const slotZ0 = Math.min(p.slotZ0, zTop - 3);
    const slotZ1 = Math.min(slotZ0 + p.slotH, zTop);
    const profile = PROFILE_RADII.map((r, i) => [r, Math.min(p[`h${i}`], driverZ - 4)] as [number, number]);
    return sideRadialScene({ slotZ: [slotZ0, slotZ1], driverZ, reflectorProfile: profile });
  },
};

export const MODELS: Record<string, ParametricModel> = {
  [SIDE_RADIAL_MODEL.id]: SIDE_RADIAL_MODEL,
  [SIDE_RADIAL_PROFILE_MODEL.id]: SIDE_RADIAL_PROFILE_MODEL,
};

export const SCENE_MODEL_ID = 'scene';

/**
 * Model built from the user's own scene: every reflector anchor becomes a
 * design variable (z enabled, r optional; Bézier handles move with the anchor),
 * plus slot offsets and driver height. The baseline is exactly the edited scene,
 * so optimisation starts from what the user drew and varies it.
 */
export function makeSceneModel(base: Scene, range = 8): ParametricModel {
  const scene = normalizeScene(base);
  const variables: DesignVariable[] = [];
  scene.shapes.forEach((s, si) => {
    const p = shapeToPath(s);
    const name = p.label ? p.label : `형상 ${si + 1}`;
    if (p.role === 'reflector') {
      p.nodes.forEach((n, ni) => {
        variables.push({ key: `s${si}n${ni}z`, label: `${name} 앵커 ${ni + 1} z`, unit: 'mm', min: n.p[1] - range, max: n.p[1] + range, value: n.p[1], enabled: true });
        if (n.p[0] > 0.01) {
          variables.push({ key: `s${si}n${ni}r`, label: `${name} 앵커 ${ni + 1} r`, unit: 'mm', min: Math.max(0, n.p[0] - range), max: n.p[0] + range, value: n.p[0], enabled: false });
        }
      });
    } else if (p.role === 'slot') {
      variables.push({ key: `s${si}dz`, label: `${name} 높이 이동`, unit: 'mm', min: -range, max: range, value: 0, enabled: true });
      variables.push({ key: `s${si}dh`, label: `${name} 높이 배율`, min: 0.5, max: 2, value: 1, enabled: false });
    }
  });
  scene.drivers.forEach((d, di) => {
    variables.push({ key: `d${di}dz`, label: `${d.label ?? `드라이버 ${di + 1}`} 높이 이동`, unit: 'mm', min: -range, max: range, value: 0, enabled: false });
  });

  return {
    id: SCENE_MODEL_ID,
    name: '현재 형상 (편집한 씬을 기준으로 변형)',
    variables,
    build(params) {
      const out = normalizeScene(scene);
      out.shapes = out.shapes.map((s, si) => {
        const p = shapeToPath(s);
        if (p.role === 'reflector') {
          p.nodes = p.nodes.map((n, ni) => {
            const dz = (params[`s${si}n${ni}z`] ?? n.p[1]) - n.p[1];
            const dr = n.p[0] > 0.01 ? (params[`s${si}n${ni}r`] ?? n.p[0]) - n.p[0] : 0;
            return shiftNode(n, dr, dz);
          });
        } else if (p.role === 'slot') {
          const dz = params[`s${si}dz`] ?? 0;
          const dh = params[`s${si}dh`] ?? 1;
          const z0 = Math.min(...p.nodes.map((n) => n.p[1]));
          p.nodes = p.nodes.map((n) => scaleNodeZ(shiftNode(n, 0, dz), z0 + dz, dh));
        }
        return p;
      });
      out.drivers = out.drivers.map((d, di) => {
        const dz = params[`d${di}dz`] ?? 0;
        if (dz === 0) return d;
        return d.kind === 'piston' ? { ...d, z: d.z + dz } : { ...d, z: [d.z[0] + dz, d.z[1] + dz] };
      });
      return out;
    },
  };
}

function shiftNode(n: PathNode, dr: number, dz: number): PathNode {
  const mv = (q: [number, number]): [number, number] => [Math.max(0, q[0] + dr), q[1] + dz];
  return { p: mv(n.p), ...(n.hIn ? { hIn: mv(n.hIn) } : {}), ...(n.hOut ? { hOut: mv(n.hOut) } : {}) };
}

function scaleNodeZ(n: PathNode, z0: number, k: number): PathNode {
  const sc = (q: [number, number]): [number, number] => [q[0], z0 + (q[1] - z0) * k];
  return { p: sc(n.p), ...(n.hIn ? { hIn: sc(n.hIn) } : {}), ...(n.hOut ? { hOut: sc(n.hOut) } : {}) };
}

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
  /** Number of parents kept in the evolution phase. */
  topK: number;
  dx: number;
  durationMs: number;
  fMin: number;
  fMax: number;
  spongeMm: number;
  objective: ObjectiveSettings;
  /** local: Gaussian steps around the baseline; global: Latin-hypercube over the full ranges. */
  explore: 'local' | 'global';
  /** Step size for local exploration as a fraction of each variable range. */
  localSigma: number;
}

export const DEFAULT_OPTIMIZE: OptimizeSettings = {
  seed: 1,
  nSamples: 16,
  nRefine: 24,
  topK: 4,
  dx: 2,
  durationMs: 6,
  fMin: 500,
  fMax: 10000,
  spongeMm: 100,
  objective: DEFAULT_OBJECTIVE,
  explore: 'local',
  localSigma: 0.25,
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
  /** baseline = start shape, sample = exploration, step = random step from a parent, momentum = continued along an improving direction. */
  origin: 'baseline' | 'sample' | 'step' | 'momentum';
  /** Candidate this one was derived from (evolution phase). */
  parentId?: number;
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

  const byId = new Map<number, Candidate>();
  const run = async (params: Record<string, number>, origin: Candidate['origin'], parentId?: number): Promise<Candidate | null> => {
    if (hooks.shouldStop?.()) return null;
    const c: Candidate = { id: nextId++, origin, params, score: -Infinity, breakdown: null, result: null, ...(parentId !== undefined ? { parentId } : {}) };
    byId.set(c.id, c);
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

  // 2. Exploration: small Gaussian steps around the baseline, or space-filling over the ranges.
  if (settings.explore === 'global') {
    const lhs = latinHypercube(settings.nSamples, Math.max(1, active.length), rng);
    for (let i = 0; i < settings.nSamples; i++) {
      const p = { ...base };
      active.forEach((v, d) => { p[v.key] = snap(v.min + lhs[i][d] * (v.max - v.min)); });
      if (!(await run(p, 'sample'))) return rankCandidates(all);
    }
  } else {
    for (let i = 0; i < settings.nSamples; i++) {
      const p = { ...base };
      for (const v of active) p[v.key] = snap(clamp(v.value + gaussian(rng) * settings.localSigma * (v.max - v.min), v.min, v.max));
      if (!(await run(p, 'sample'))) return rankCandidates(all);
    }
  }

  // 3. Evolution (self-improving loop). Keep the best `topK` designs as parents. A child either
  //    continues along the direction that made its parent better than the parent's own parent
  //    (momentum) or takes a random step. The step size follows the 1/5 success rule: it grows
  //    while steps keep improving and shrinks when they stop.
  let sigma = settings.explore === 'local' ? settings.localSigma : 0.15;
  const recent: boolean[] = [];
  for (let i = 0; i < settings.nRefine; i++) {
    const parents = rankCandidates(all).filter((c) => Number.isFinite(c.score)).slice(0, settings.topK);
    if (parents.length === 0) break;
    const parent = parents[i % parents.length];
    const gp = parent.parentId !== undefined ? byId.get(parent.parentId) : undefined;
    const improving = !!gp && Number.isFinite(gp.score) && parent.score > gp.score;
    const useMomentum = improving && i % 3 !== 2; // two of three steps follow a good direction, one explores
    const p = { ...parent.params };
    if (useMomentum && gp) {
      const k = 0.5 + rng(); // 0.5x .. 1.5x of the previous successful step
      for (const v of active) {
        const dir = parent.params[v.key] - gp.params[v.key];
        p[v.key] = snap(clamp(parent.params[v.key] + k * dir + gaussian(rng) * 0.25 * sigma * (v.max - v.min), v.min, v.max));
      }
    } else {
      for (const v of active) p[v.key] = snap(clamp(parent.params[v.key] + gaussian(rng) * sigma * (v.max - v.min), v.min, v.max));
    }
    const child = await run(p, useMomentum ? 'momentum' : 'step', parent.id);
    if (!child) return rankCandidates(all);
    recent.push(child.score > parent.score);
    if (recent.length > 5) recent.shift();
    const rate = recent.filter(Boolean).length / recent.length;
    sigma = clamp(sigma * (rate > 0.2 ? 1.15 : 0.85), 0.02, 1);
  }

  return rankCandidates(all);
}
