import { AxiFDTD, gaussianPulse } from './fdtd';
import { GpuAxiFDTD } from './gpu';
import { buildGrid, type BuiltGrid } from './rasterize';
import { analyze, type SimResult } from './analysis';
import { validateScene, checkSetup, checkDecay, hasErrors, reliableFMin, type Diagnostic } from './checks';
import type { Scene, SimParams } from './scene';

export type BackendUsed = 'cpu' | 'gpu';

export class SceneValidationError extends Error {
  constructor(public readonly diagnostics: Diagnostic[]) {
    super(
      diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => `[${d.code}] ${d.message}`)
        .join('\n'),
    );
    this.name = 'SceneValidationError';
  }
}

/** All pre-run diagnostics for a (possibly malformed) scene and its parameters. */
export function diagnose(scene: unknown, params: SimParams): Diagnostic[] {
  const structural = validateScene(scene);
  if (hasErrors(structural)) return structural;
  return [...structural, ...checkSetup(scene as Scene, params)];
}

export interface RunCallbacks {
  onGrid?: (g: BuiltGrid) => void;
  /** Called every frameEvery steps with a pressure snapshot (copy it if you keep it). */
  onFrame?: (p: Float32Array, step: number, nSteps: number) => void | Promise<void>;
  shouldStop?: () => boolean;
}

export interface RunOutput {
  grid: BuiltGrid;
  result: SimResult;
  /** Final solver state. */
  sim: { Nr: number; Nz: number; dt: number; p: Float32Array };
  /** Pre-run warnings plus post-run checks (decay, signal presence). */
  warnings: Diagnostic[];
  backend: BackendUsed;
  /** Raw probe histories (Pa-equivalent, arbitrary scale), one per angle. */
  hist: Float32Array[];
}

/**
 * Run a full broadband simulation and return the frequency-domain result.
 * Throws SceneValidationError if the scene or parameters have errors.
 */
export async function runSimulation(
  scene: Scene,
  params: SimParams,
  cb: RunCallbacks = {},
  frameEvery = 20,
): Promise<RunOutput | null> {
  const diags = diagnose(scene, params);
  if (hasErrors(diags)) throw new SceneValidationError(diags);
  const warnings = diags.filter((d) => d.severity === 'warning');

  const grid = buildGrid(scene, params.dx);
  cb.onGrid?.(grid);

  const opts = { spongeCells: params.spongeCells, spongeMax: params.spongeMax, courant: params.courant };
  const want = params.backend ?? 'auto';

  let hist: Float32Array[] | null = null;
  let sim: RunOutput['sim'] | null = null;
  let backend: BackendUsed = 'cpu';

  if (want !== 'cpu') {
    // dt is identical on both backends; build the pulse once from the CPU formula.
    const probeDt = new AxiFDTD(grid, opts).dt;
    const nSteps = Math.ceil((params.durationMs * 1e-3) / probeDt);
    const src = gaussianPulse(probeDt, nSteps, params.fMax);
    const gpu = await GpuAxiFDTD.create(grid, opts, src);
    if (gpu) {
      try {
        const out = await gpu.run({ onFrame: cb.onFrame, shouldStop: cb.shouldStop }, Math.max(frameEvery, 50));
        if (!out) return null;
        hist = out.hist;
        sim = { Nr: gpu.Nr, Nz: gpu.Nz, dt: gpu.dt, p: out.p };
        backend = 'gpu';
      } finally {
        gpu.dispose();
      }
    } else if (want === 'gpu') {
      throw new Error('WebGPU 를 사용할 수 없습니다 (navigator.gpu 없음 또는 어댑터 요청 실패).');
    }
  }

  if (!hist || !sim) {
    const cpu = new AxiFDTD(grid, opts);
    const nSteps = Math.ceil((params.durationMs * 1e-3) / cpu.dt);
    const src = gaussianPulse(cpu.dt, nSteps, params.fMax);
    hist = grid.probes.map(() => new Float32Array(nSteps));
    for (let n = 0; n < nSteps; n++) {
      cpu.step(src[n]);
      for (let k = 0; k < grid.probes.length; k++) {
        const pr = grid.probes[k];
        hist[k][n] = cpu.sample(pr.fr, pr.fz);
      }
      if (n % frameEvery === 0) {
        if (cb.shouldStop?.()) return null;
        await cb.onFrame?.(cpu.p, n, nSteps);
      }
    }
    sim = { Nr: cpu.Nr, Nz: cpu.Nz, dt: cpu.dt, p: cpu.p };
  }

  const nSteps = hist[0]?.length ?? 0;
  const src = gaussianPulse(sim.dt, nSteps, params.fMax);
  const fMinCut = Math.max(params.fMin, reliableFMin(scene, params.durationMs));
  const result = analyze(hist, src, sim.dt, grid.probes.map((p) => p.angleDeg), fMinCut, params.fMax);
  warnings.push(...checkDecay(hist));
  return { grid, result, sim, warnings, backend, hist };
}

export interface ParityReport {
  /** Largest |cpu - gpu| over all probe samples, relative to the largest |cpu| sample. */
  maxRelDiff: number;
  /** Largest |dB difference| over all angles and frequencies in the result. */
  maxDbDiff: number;
  cpuMs: number;
  gpuMs: number;
  nSteps: number;
}

/** Run the same scene on both backends and compare probe histories and spectra. */
export async function compareBackends(scene: Scene, params: SimParams): Promise<ParityReport> {
  const t0 = performance.now();
  const cpu = await runSimulation(scene, { ...params, backend: 'cpu' }, {}, 1e9);
  const t1 = performance.now();
  const gpu = await runSimulation(scene, { ...params, backend: 'gpu' }, {}, 1e9);
  const t2 = performance.now();
  if (!cpu || !gpu) throw new Error('stopped');

  let peak = 0, maxAbs = 0;
  for (let k = 0; k < cpu.hist.length; k++) {
    const a = cpu.hist[k], b = gpu.hist[k];
    for (let i = 0; i < a.length; i++) {
      peak = Math.max(peak, Math.abs(a[i]));
      maxAbs = Math.max(maxAbs, Math.abs(a[i] - b[i]));
    }
  }
  let maxDb = 0;
  const ca = cpu.result.db, cb = gpu.result.db;
  for (let i = 0; i < ca.length; i++) {
    // Ignore bins that are effectively empty on either backend.
    if (ca[i] < -200 || cb[i] < -200) continue;
    maxDb = Math.max(maxDb, Math.abs(ca[i] - cb[i]));
  }
  return { maxRelDiff: maxAbs / (peak || 1), maxDbDiff: maxDb, cpuMs: t1 - t0, gpuMs: t2 - t1, nSteps: cpu.result.nSteps };
}
