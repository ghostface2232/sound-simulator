/// <reference lib="webworker" />
import { runSimulation } from '../engine/runner';
import type { Diagnostic } from '../engine/checks';
import type { Scene, SimParams } from '../engine/scene';

export type WorkerIn =
  | { type: 'run'; scene: Scene; params: SimParams; frameEvery: number }
  | { type: 'stop' };

export type WorkerOut =
  | { type: 'grid'; Nr: number; Nz: number; dx: number; zMin: number; solid: Uint8Array; sigma: Float32Array; probes: { fr: number; fz: number; angleDeg: number }[] }
  | { type: 'frame'; step: number; nSteps: number; p: Float32Array }
  | { type: 'done'; freqs: Float32Array; angles: Float32Array; db: Float32Array; dt: number; nSteps: number; fMinReliable: number; warnings: Diagnostic[]; elapsedMs: number }
  | { type: 'stopped' }
  | { type: 'error'; message: string };

let stopRequested = false;

const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type === 'stop') { stopRequested = true; return; }
  if (msg.type !== 'run') return;

  stopRequested = false;
  const t0 = performance.now();
  try {
    const out = await runSimulation(msg.scene, msg.params, {
      onGrid: (g) => post({
        type: 'grid', Nr: g.Nr, Nz: g.Nz, dx: g.dx, zMin: g.zMin,
        solid: g.solid.slice(), sigma: g.sigma.slice(), probes: g.probes,
      }),
      onFrame: async (p, step, nSteps) => {
        const copy = p.slice();
        post({ type: 'frame', step, nSteps, p: copy }, [copy.buffer]);
        // Yield so 'stop' messages can be processed.
        await new Promise((r) => setTimeout(r, 0));
      },
      shouldStop: () => stopRequested,
    }, msg.frameEvery);

    if (!out) { post({ type: 'stopped' }); return; }
    const { result, warnings } = out;
    post({
      type: 'done',
      freqs: result.freqs, angles: result.angles, db: result.db,
      dt: result.dt, nSteps: result.nSteps, fMinReliable: result.fMinReliable,
      warnings, elapsedMs: performance.now() - t0,
    });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
