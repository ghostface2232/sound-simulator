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
  /** Lowest frequency kept in `freqs` (max of the user's fMin and what the run length resolves). */
  fMinReliable: number;
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

  return { freqs, angles: Float32Array.from(angles), db, dt, nSteps, fMinReliable: fMin };
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

/**
 * Response at an exact frequency, linearly interpolated between neighbouring
 * FFT bins in dB. Using the nearest bin makes the requested frequency depend
 * on dt/nfft, which can create false differences when comparing simulations
 * that use different grid spacings.
 */
export function sliceAtFrequency(res: SimResult, f: number): Float32Array {
  const { freqs } = res;
  const nFreq = freqs.length;
  const out = new Float32Array(res.angles.length);
  if (nFreq === 0) return out;

  let k0 = 0, k1 = 0, mix = 0;
  if (f <= freqs[0]) {
    k0 = k1 = 0;
  } else if (f >= freqs[nFreq - 1]) {
    k0 = k1 = nFreq - 1;
  } else {
    let lo = 0, hi = nFreq - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (freqs[mid] <= f) lo = mid; else hi = mid;
    }
    k0 = lo; k1 = hi;
    mix = (f - freqs[k0]) / (freqs[k1] - freqs[k0]);
  }

  for (let a = 0; a < out.length; a++) {
    const row = a * nFreq;
    const v0 = res.db[row + k0];
    out[a] = k0 === k1 ? v0 : v0 + (res.db[row + k1] - v0) * mix;
  }
  return out;
}

/** Directivity at one frequency, normalised so the maximum is 0 dB. */
export function polarAt(res: SimResult, f: number): { angles: Float32Array; db: Float32Array } {
  const out = sliceAtFrequency(res, f);
  let max = -Infinity;
  for (let a = 0; a < out.length; a++) if (out[a] > max) max = out[a];
  for (let a = 0; a < out.length; a++) out[a] -= max;
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
