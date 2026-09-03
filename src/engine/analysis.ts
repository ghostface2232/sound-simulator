import { magnitudeSpectrum, nextPow2 } from './fft';

export interface SimResult {
  /** Frequency bins (Hz), limited to [fMin, fMax]. */
  freqs: Float32Array;
  /** Probe angles in degrees from +z. */
  angles: Float32Array;
  /** Transfer-function magnitude in dB, indexed a*nFreq + k. Arbitrary reference. */
  db: Float32Array;
  dt: number;
  nSteps: number;
}

/**
 * Convert probe time histories into a frequency response per angle.
 * H(f) = |P(f)| / |V_src(f)|, so the result is independent of the pulse shape.
 */
export function analyze(
  probeHist: Float32Array[],
  src: Float32Array,
  dt: number,
  angles: number[],
  fMin: number,
  fMax: number,
): SimResult {
  const nSteps = src.length;
  const nfft = nextPow2(nSteps * 2);
  const df = 1 / (nfft * dt);
  const kMin = Math.max(1, Math.ceil(fMin / df));
  const kMax = Math.min(nfft / 2 - 1, Math.floor(fMax / df));
  const nFreq = kMax - kMin + 1;

  const srcMag = magnitudeSpectrum(src, nfft);
  const freqs = new Float32Array(nFreq);
  for (let k = 0; k < nFreq; k++) freqs[k] = (kMin + k) * df;

  const db = new Float32Array(angles.length * nFreq);
  for (let a = 0; a < angles.length; a++) {
    const mag = magnitudeSpectrum(probeHist[a], nfft);
    for (let k = 0; k < nFreq; k++) {
      const h = mag[kMin + k] / (srcMag[kMin + k] + 1e-30);
      db[a * nFreq + k] = 20 * Math.log10(h + 1e-30);
    }
  }

  return { freqs, angles: Float32Array.from(angles), db, dt, nSteps };
}

/** Index of the frequency bin closest to f. */
export function nearestBin(freqs: Float32Array, f: number): number {
  let best = 0, bestD = Infinity;
  for (let k = 0; k < freqs.length; k++) {
    const d = Math.abs(freqs[k] - f);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

/** Directivity at one frequency, normalised so the maximum is 0 dB. */
export function polarAt(res: SimResult, f: number): { angles: Float32Array; db: Float32Array } {
  const k = nearestBin(res.freqs, f);
  const n = res.angles.length;
  const nFreq = res.freqs.length;
  const out = new Float32Array(n);
  let max = -Infinity;
  for (let a = 0; a < n; a++) { out[a] = res.db[a * nFreq + k]; if (out[a] > max) max = out[a]; }
  for (let a = 0; a < n; a++) out[a] -= max;
  return { angles: res.angles, db: out };
}

/** Frequency response for the probe nearest to the requested angle. */
export function responseAt(res: SimResult, angleDeg: number): Float32Array {
  let a = 0, bestD = Infinity;
  for (let i = 0; i < res.angles.length; i++) {
    const d = Math.abs(res.angles[i] - angleDeg);
    if (d < bestD) { bestD = d; a = i; }
  }
  const nFreq = res.freqs.length;
  return res.db.slice(a * nFreq, (a + 1) * nFreq);
}
