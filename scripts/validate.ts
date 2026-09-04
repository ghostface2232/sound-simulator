/**
 * Solver validation: piston of radius a in an infinite rigid baffle.
 * Theory (far field): D(θ) = |2 J1(ka sinθ) / (ka sinθ)|.
 *
 *   npm run validate                 # baseline dx = 1 mm + grid-convergence sweep
 *   npx tsx scripts/validate.ts 0.75 # baseline at another dx (convergence sweep still runs)
 *   npx tsx scripts/validate.ts 1 --no-convergence
 *
 * Exits with code 1 when any criterion fails.
 */
import { runSimulation } from '../src/engine/runner';
import { pistonBaffleScene } from '../src/engine/presets';
import { polarAt } from '../src/engine/analysis';
import { C_AIR } from '../src/engine/fdtd';
import { DEFAULT_PARAMS } from '../src/engine/scene';

const A_MM = 20;
const EXTENT_MM = 320;
const MEASURE_MM = 150;
const SPONGE_MM = 100;
const FREQS = [3000, 6000, 10000, 15000];
const MAX_ANGLE = 60;
const NULL_FLOOR_DB = -20; // points deeper than this are inside a null and not judged
const BASELINE_TOL_DB = 0.75;
const CONVERGENCE_TOL_DB = 0.6;

function besselJ1(x: number): number {
  const ax = Math.abs(x);
  let ans: number;
  if (ax < 8) {
    const y = x * x;
    const a1 = x * (72362614232.0 + y * (-7895059235.0 + y * (242396853.1 + y * (-2972611.439 + y * (15704.4826 + y * -30.16036606)))));
    const a2 = 144725228442.0 + y * (2300535178.0 + y * (18583304.74 + y * (99447.43394 + y * (376.9991397 + y))));
    ans = a1 / a2;
  } else {
    const z = 8 / ax, y = z * z, xx = ax - 2.356194491;
    const a1 = 1 + y * (0.183105e-2 + y * (-0.3516396496e-4 + y * (0.2457520174e-5 + y * -0.240337019e-6)));
    const a2 = 0.04687499995 + y * (-0.2002690873e-3 + y * (0.8449199096e-5 + y * (-0.88228987e-6 + y * 0.105787412e-6)));
    ans = Math.sqrt(0.636619772 / ax) * (Math.cos(xx) * a1 - z * Math.sin(xx) * a2);
    if (x < 0) ans = -ans;
  }
  return ans;
}

function theoryDb(thetaDeg: number, aM: number, f: number): number {
  const k = (2 * Math.PI * f) / C_AIR;
  const x = k * aM * Math.sin((thetaDeg * Math.PI) / 180);
  const d = Math.abs(x) < 1e-6 ? 1 : Math.abs((2 * besselJ1(x)) / x);
  return 20 * Math.log10(d + 1e-12);
}

interface CaseResult {
  dx: number;
  seconds: number;
  cells: string;
  /** Simulated normalised directivity in dB, keyed by `${f}:${theta}`. */
  pattern: Map<string, number>;
  worstErr: number;
}

async function runCase(dx: number): Promise<CaseResult> {
  const scene = pistonBaffleScene(A_MM, EXTENT_MM, MEASURE_MM);
  const spongeCells = Math.round(SPONGE_MM / dx);
  const t0 = Date.now();
  const out = await runSimulation(scene, { ...DEFAULT_PARAMS, dx, durationMs: 4, fMin: 1000, spongeCells }, {}, 1e9);
  if (!out) throw new Error('stopped');
  const { result, sim, warnings } = out;
  for (const w of warnings) if (w.code !== 'fmin-unreliable') console.log(`  warning [${w.code}] ${w.message}`);

  let pmax = 0;
  for (let i = 0; i < sim.p.length; i++) pmax = Math.max(pmax, Math.abs(sim.p[i]));
  if (!Number.isFinite(pmax)) throw new Error('solver blew up (non-finite pressure)');

  const pattern = new Map<string, number>();
  let worstErr = 0;
  for (const f of FREQS) {
    const { angles, db } = polarAt(result, f);
    for (let k = 0; k < angles.length; k++) {
      const th = angles[k];
      if (th > MAX_ANGLE) continue;
      pattern.set(`${f}:${th}`, db[k]);
      const t = theoryDb(th, A_MM / 1000, f);
      if (t > NULL_FLOOR_DB) worstErr = Math.max(worstErr, Math.abs(db[k] - t));
    }
  }
  return { dx, seconds: (Date.now() - t0) / 1000, cells: `${sim.Nr}x${sim.Nz}`, pattern, worstErr };
}

function printTable(c: CaseResult) {
  for (const f of FREQS) {
    console.log(`\nf = ${f} Hz  (ka = ${((2 * Math.PI * f * A_MM) / 1000 / C_AIR).toFixed(2)})`);
    console.log('  θ    sim     theory   err');
    for (let th = 0; th <= MAX_ANGLE; th += 10) {
      const s = c.pattern.get(`${f}:${th}`)!;
      const t = theoryDb(th, A_MM / 1000, f);
      console.log(`  ${String(th).padStart(3)}  ${s.toFixed(2).padStart(6)}  ${t.toFixed(2).padStart(7)}  ${(s - t).toFixed(2).padStart(6)}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const baseDx = Number(args.find((a) => !a.startsWith('--')) ?? 1);
  const doConvergence = !args.includes('--no-convergence');
  let ok = true;

  console.log(`baseline: dx = ${baseDx} mm, a = ${A_MM} mm, measure r = ${MEASURE_MM} mm, sponge ${SPONGE_MM} mm`);
  const base = await runCase(baseDx);
  console.log(`grid ${base.cells}, ${base.seconds.toFixed(1)} s`);
  printTable(base);
  console.log(`\nworst |error| above ${NULL_FLOOR_DB} dB, θ ≤ ${MAX_ANGLE}°: ${base.worstErr.toFixed(2)} dB (tolerance ${BASELINE_TOL_DB})`);
  if (base.worstErr > BASELINE_TOL_DB) { ok = false; console.log('  -> baseline FAIL'); }

  if (doConvergence) {
    console.log('\nconvergence sweep');
    const dxs = [1.5, 1, 0.75];
    const cases: CaseResult[] = [];
    for (const dx of dxs) {
      const c = dx === baseDx ? base : await runCase(dx);
      cases.push(c);
      console.log(`  dx = ${dx.toFixed(2).padStart(4)} mm  grid ${c.cells.padEnd(9)} ${c.seconds.toFixed(1).padStart(5)} s  worst err ${c.worstErr.toFixed(2)} dB`);
    }
    // Error must not grow as the grid is refined, and the two finest grids must agree.
    const errs = cases.map((c) => c.worstErr);
    if (errs[errs.length - 1] > errs[0] + 0.1) { ok = false; console.log('  -> FAIL: error grows with refinement'); }
    const a = cases[cases.length - 2], b = cases[cases.length - 1];
    let maxDiff = 0;
    let maxDiffAt = '';
    for (const [key, v] of b.pattern) {
      const [fStr, thStr] = key.split(':');
      const t = theoryDb(Number(thStr), A_MM / 1000, Number(fStr));
      if (t <= NULL_FLOOR_DB) continue;
      const diff = Math.abs(v - (a.pattern.get(key) ?? v));
      if (diff > maxDiff) { maxDiff = diff; maxDiffAt = key; }
    }
    console.log(`  max |Δ| between dx ${a.dx} and ${b.dx}: ${maxDiff.toFixed(2)} dB at ${maxDiffAt.replace(':', ' Hz, ')}° (tolerance ${CONVERGENCE_TOL_DB})`);
    if (maxDiff > CONVERGENCE_TOL_DB) { ok = false; console.log('  -> FAIL: not converged'); }
  }

  console.log(ok ? '\nPASS' : '\nFAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
