import { AxiFDTD, gaussianPulse } from './fdtd';
import { buildGrid, type BuiltGrid } from './rasterize';
import { analyze, type SimResult } from './analysis';
import type { Scene, SimParams } from './scene';

export interface RunCallbacks {
  onGrid?: (g: BuiltGrid) => void;
  /** Called every frameEvery steps; p is the live array (copy it if you keep it). */
  onFrame?: (p: Float32Array, step: number, nSteps: number) => void | Promise<void>;
  shouldStop?: () => boolean;
}

/** Run a full broadband simulation and return the frequency-domain result. */
export async function runSimulation(
  scene: Scene,
  params: SimParams,
  cb: RunCallbacks = {},
  frameEvery = 20,
): Promise<{ grid: BuiltGrid; result: SimResult; sim: AxiFDTD } | null> {
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

  const result = analyze(
    hist, src, sim.dt,
    grid.probes.map((p) => p.angleDeg),
    100, params.fMax,
  );
  return { grid, result, sim };
}
