/** Headless run of a preset: npx tsx scripts/run-scene.ts <preset> [dx] [durationMs] */
import { runSimulation } from '../src/engine/runner';
import { PRESETS } from '../src/engine/presets';
import { DEFAULT_PARAMS } from '../src/engine/scene';
import { polarAt } from '../src/engine/analysis';

async function main() {
  const key = process.argv[2] ?? 'side-radial';
  const dx = Number(process.argv[3] ?? DEFAULT_PARAMS.dx);
  const durationMs = Number(process.argv[4] ?? DEFAULT_PARAMS.durationMs);
  const scene = PRESETS[key]();
  const t0 = Date.now();
  const out = await runSimulation(scene, { ...DEFAULT_PARAMS, dx, durationMs }, {
    onFrame: (p, step, nSteps) => {
      if (step % 1000 === 0) {
        let mx = 0; for (let i = 0; i < p.length; i += 13) mx = Math.max(mx, Math.abs(p[i]));
        console.log(`step ${step}/${nSteps}  |p|~${mx.toExponential(2)}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }
    },
  }, 100);
  if (!out) return;
  const { sim, result, grid } = out;
  let pmax = 0; for (let i = 0; i < sim.p.length; i++) pmax = Math.max(pmax, Math.abs(sim.p[i]));
  console.log(`grid ${sim.Nr}x${sim.Nz}, steps ${result.nSteps}, src faces ${grid.srcFace.length}, ${((Date.now() - t0) / 1000).toFixed(1)}s, final |p|max ${pmax.toExponential(2)}`);
  for (const f of [1000, 3000, 6000, 10000]) {
    const { angles, db } = polarAt(result, f);
    const parts: string[] = [];
    for (let k = 0; k < angles.length; k += 6) parts.push(`${angles[k]}°:${db[k].toFixed(1)}`);
    console.log(`${f} Hz  ${parts.join('  ')}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
