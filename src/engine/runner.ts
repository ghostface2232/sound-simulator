import { AxiFDTD, gaussianPulse } from './fdtd';
import { buildGrid, type BuiltGrid } from './rasterize';
import { analyze, type SimResult } from './analysis';
import { validateScene, checkSetup, checkDecay, hasErrors, reliableFMin, type Diagnostic } from './checks';
import type { Scene, SimParams } from './scene';

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
  /** Called every frameEvery steps; p is the live array (copy it if you keep it). */
  onFrame?: (p: Float32Array, step: number, nSteps: number) => void | Promise<void>;
  shouldStop?: () => boolean;
}

export interface RunOutput {
  grid: BuiltGrid;
  result: SimResult;
  sim: AxiFDTD;
  /** Pre-run warnings plus post-run checks (decay, signal presence). */
  warnings: Diagnostic[];
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

  const sim = new AxiFDTD(grid, { spongeCells: params.spongeCells, spongeMax: params.spongeMax, courant: params.courant });
  const nSteps = Math.ceil((params.durationMs * 1e-3) / sim.dt);
  const src = gaussianPulse(sim.dt, nSteps, params.fMax);

  const hist = grid.probes.map(() => new Float32Array(nSteps));

  for (let n = 0; n < nSteps; n++) {
    sim.step(src[n]);
    for (let k = 0; k < grid.probes.length; k++) {
      const pr = grid.probes[k];
      hist[k][n] = sim.sample(pr.fr, pr.fz);
    }
    if (n % frameEvery === 0) {
      if (cb.shouldStop?.()) return null;
      await cb.onFrame?.(sim.p, n, nSteps);
    }
  }

  const fMinCut = Math.max(params.fMin, reliableFMin(scene, params.durationMs));
  const result = analyze(hist, src, sim.dt, grid.probes.map((p) => p.angleDeg), fMinCut, params.fMax);
  warnings.push(...checkDecay(hist));
  return { grid, result, sim, warnings };
}
