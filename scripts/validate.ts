/**
 * Solver validation: piston of radius a in an infinite rigid baffle.
 * Theory (far field): D(θ) = |2 J1(ka sinθ) / (ka sinθ)|.
 * Run with: npm run validate
 */
import { runSimulation } from '../src/engine/runner';
import { pistonBaffleScene } from '../src/engine/presets';
import { polarAt } from '../src/engine/analysis';
import { C_AIR } from '../src/engine/fdtd';

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

function theoryDb(thetaDeg: number, a: number, f: number): number {
  const k = (2 * Math.PI * f) / C_AIR;
  const x = k * a * Math.sin((thetaDeg * Math.PI) / 180);
  const d = Math.abs(x) < 1e-6 ? 1 : Math.abs((2 * besselJ1(x)) / x);
  return 20 * Math.log10(d + 1e-12);
}

async function main() {
  const a = 20; // mm
  // args: dx extent measureRadius spongeCells spongeMax
  const dx = Number(process.argv[2] ?? 1);
  const extent = Number(process.argv[3] ?? 320);
  const measureRadius = Number(process.argv[4] ?? 150);
  const spongeCells = Number(process.argv[5] ?? 100);
  const spongeMax = Number(process.argv[6] ?? 0.05);
  console.log({ dx, extent, measureRadius, spongeCells, spongeMax });
  const scene = pistonBaffleScene(a, extent, measureRadius);
  const t0 = Date.now();
  const out = await runSimulation(scene, { dx, durationMs: 4, fMax: 20000, spongeCells, spongeMax, courant: 0.45 }, {}, 1e9);
  if (!out) throw new Error('stopped');
  const { result, sim } = out;
  console.log(`grid ${sim.Nr}x${sim.Nz}, dt=${(sim.dt * 1e6).toFixed(2)} us, steps=${result.nSteps}, ${(Date.now() - t0) / 1000}s`);

  let pmax = 0;
  for (let i = 0; i < sim.p.length; i++) pmax = Math.max(pmax, Math.abs(sim.p[i]));
  console.log(`final |p|max = ${pmax.toExponential(2)} (should be small and finite)`);

  let worst = 0;
  for (const f of [3000, 6000, 10000, 15000]) {
    const { angles, db } = polarAt(result, f);
    console.log(`\nf = ${f} Hz  (ka = ${((2 * Math.PI * f * a) / 1000 / C_AIR).toFixed(2)})`);
    console.log('  θ    sim     theory   err');
    for (let k = 0; k < angles.length; k++) {
      const th = angles[k];
      if (th > 60 || th % 10 !== 0) continue;
      const t = theoryDb(th, a / 1000, f);
      const err = db[k] - t;
      // Ignore points deeper than -20 dB (nulls are sensitive to tiny errors).
      if (t > -20) worst = Math.max(worst, Math.abs(err));
      console.log(`  ${String(th).padStart(3)}  ${db[k].toFixed(2).padStart(6)}  ${t.toFixed(2).padStart(7)}  ${err.toFixed(2).padStart(6)}`);
    }
  }
  console.log(`\nworst |error| above -20 dB, θ ≤ 60°: ${worst.toFixed(2)} dB`);
  console.log(worst < 1.5 ? 'PASS' : 'FAIL');
}

main().catch((e) => { console.error(e); process.exit(1); });
