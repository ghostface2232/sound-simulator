/// <reference lib="webworker" />
import { compareBackends, runSimulation, type BackendUsed, type ParityReport } from '../engine/runner';
import type { Diagnostic } from '../engine/checks';
import type { Scene, SimParams } from '../engine/scene';
import {
  MODELS, optimize, simParamsFor,
  type Candidate, type DesignVariable, type OptimizeProgress, type OptimizeSettings,
} from '../engine/optimize';

export type WorkerIn =
  | { type: 'run'; scene: Scene; params: SimParams; frameEvery: number }
  | { type: 'parity'; scene: Scene; params: SimParams }
  | { type: 'optimize'; modelId: string; variables: DesignVariable[]; settings: OptimizeSettings; backend: SimParams['backend'] }
  | { type: 'stop' };

export type WorkerOut =
  | { type: 'grid'; Nr: number; Nz: number; dx: number; zMin: number; solid: Uint8Array; sigma: Float32Array; probes: { fr: number; fz: number; angleDeg: number }[] }
  | { type: 'frame'; step: number; nSteps: number; p: Float32Array }
  | { type: 'done'; freqs: Float32Array; angles: Float32Array; db: Float32Array; dt: number; nSteps: number; fMinReliable: number; warnings: Diagnostic[]; elapsedMs: number; backend: BackendUsed }
  | { type: 'parity-result'; report: ParityReport }
  | { type: 'opt-eval'; candidate: Candidate }
  | { type: 'opt-progress'; progress: OptimizeProgress }
  | { type: 'opt-done'; ranked: Candidate[]; elapsedMs: number }
  | { type: 'stopped' }
  | { type: 'error'; message: string };

let stopRequested = false;

const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
const yieldToQueue = () => new Promise((r) => setTimeout(r, 0));

const TOP_N = 12;
/** Keep the message small: top candidates only, but always keep the baseline for comparison. */
const trimRanked = (ranked: Candidate[]): Candidate[] => {
  const top = ranked.slice(0, TOP_N);
  const baseline = ranked.find((c) => c.origin === 'baseline');
  if (baseline && !top.includes(baseline)) top.push(baseline);
  return top;
};
const trimProgress = (p: OptimizeProgress): OptimizeProgress => ({ ...p, ranked: trimRanked(p.ranked) });

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type === 'stop') { stopRequested = true; return; }

  if (msg.type === 'parity') {
    try {
      post({ type: 'parity-result', report: await compareBackends(msg.scene, msg.params) });
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (msg.type === 'optimize') {
    stopRequested = false;
    const t0 = performance.now();
    const model = MODELS[msg.modelId];
    if (!model) { post({ type: 'error', message: `알 수 없는 모델: ${msg.modelId}` }); return; }
    const params: SimParams = { ...simParamsFor(msg.settings), backend: msg.backend };
    try {
      const ranked = await optimize(model, msg.variables, msg.settings, async (scene) => {
        const out = await runSimulation(scene, params, {
          onGrid: (g) => post({
            type: 'grid', Nr: g.Nr, Nz: g.Nz, dx: g.dx, zMin: g.zMin,
            solid: g.solid.slice(), sigma: g.sigma.slice(), probes: g.probes,
          }),
          onFrame: async (p, step, nSteps) => {
            const copy = p.slice();
            post({ type: 'frame', step, nSteps, p: copy }, [copy.buffer]);
            await yieldToQueue();
          },
          shouldStop: () => stopRequested,
        }, 200);
        return out?.result ?? null;
      }, {
        onProgress: async (p) => { post({ type: 'opt-progress', progress: trimProgress(p) }); await yieldToQueue(); },
        onEvaluate: (c) => post({ type: 'opt-eval', candidate: { ...c, result: null } }),
        shouldStop: () => stopRequested,
      });
      if (stopRequested) { post({ type: 'stopped' }); return; }
      post({ type: 'opt-done', ranked: trimRanked(ranked), elapsedMs: performance.now() - t0 });
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

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
        await yieldToQueue();
      },
      shouldStop: () => stopRequested,
    }, msg.frameEvery);

    if (!out) { post({ type: 'stopped' }); return; }
    const { result, warnings, backend } = out;
    post({
      type: 'done',
      freqs: result.freqs, angles: result.angles, db: result.db,
      dt: result.dt, nSteps: result.nSteps, fMinReliable: result.fMinReliable,
      warnings, elapsedMs: performance.now() - t0, backend,
    });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
