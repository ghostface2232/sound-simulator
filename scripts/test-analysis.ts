import assert from 'node:assert/strict';
import { polarAt, sliceAtFrequency, type SimResult } from '../src/engine/analysis';

function result(freqs: number[], rows: number[][]): SimResult {
  return {
    freqs: Float32Array.from(freqs),
    angles: Float32Array.from(rows.map((_, i) => i * 45)),
    db: Float32Array.from(rows.flat()),
    dt: 1,
    nSteps: 1,
    fMinReliable: freqs[0],
  };
}

const res = result([100, 200], [[0, 10], [-20, -10]]);

assert.deepEqual([...sliceAtFrequency(res, 150)], [5, -15]);
assert.deepEqual([...sliceAtFrequency(res, 50)], [0, -20]);
assert.deepEqual([...sliceAtFrequency(res, 250)], [10, -10]);
assert.deepEqual([...polarAt(res, 150).db], [0, -20]);

console.log('analysis');
console.log('  ok   exact-frequency slices interpolate between FFT bins and clamp at the range edges');
console.log('  ok   interpolated polar responses keep their normalised directivity');
