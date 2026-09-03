import type { BuiltGrid } from './rasterize';

export const C_AIR = 343; // m/s
export const RHO_AIR = 1.204; // kg/m³

/**
 * Axisymmetric acoustic FDTD on a staggered (Yee) grid in (r, z).
 *
 * Layout (all arrays indexed c = j*Nr + i, r fastest):
 *   p[c]   pressure at cell centre (r_i = i·dx, z_j = zMin + j·dx). Cell i=0 is a disc of radius dx/2.
 *   vr[c]  radial velocity on the face between cell i and i+1 (r = (i+½)dx).
 *   vz[c]  axial velocity on the face between cell j and j+1 (z = z_j + dx/2).
 *
 * The update is written as plain loops over typed arrays so it can be ported
 * one-to-one to a WGSL compute shader.
 */
export class AxiFDTD {
  readonly Nr: number;
  readonly Nz: number;
  readonly dx: number; // metres
  readonly dt: number; // seconds
  readonly c: number;
  readonly rho: number;

  readonly p: Float32Array;
  readonly vr: Float32Array;
  readonly vz: Float32Array;
  readonly solid: Uint8Array;
  readonly sigma: Float32Array;
  readonly damp: Float32Array;

  private readonly srcFace: Int32Array;
  private readonly srcIsZ: Uint8Array;
  private readonly srcSign: Float32Array;

  private readonly cv: number; // dt / (rho dx)
  private readonly cp: number; // rho c² dt / dx
  private readonly kd: number; // dt / rho

  constructor(
    g: BuiltGrid,
    opts: { spongeCells: number; spongeMax?: number; courant: number; c?: number; rho?: number },
  ) {
    this.Nr = g.Nr;
    this.Nz = g.Nz;
    this.dx = g.dx * 1e-3;
    this.c = opts.c ?? C_AIR;
    this.rho = opts.rho ?? RHO_AIR;
    // 2-D stability limit is dx/(c·√2); the axis cell is slightly stiffer, so stay well below it.
    this.dt = (opts.courant * this.dx) / (this.c * Math.SQRT2);

    const n = g.Nr * g.Nz;
    this.p = new Float32Array(n);
    this.vr = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.solid = g.solid;
    this.sigma = g.sigma;
    this.srcFace = g.srcFace;
    this.srcIsZ = g.srcIsZ;
    this.srcSign = g.srcSign;

    this.cv = this.dt / (this.rho * this.dx);
    this.cp = (this.rho * this.c * this.c * this.dt) / this.dx;
    this.kd = this.dt / this.rho;

    this.damp = AxiFDTD.buildSponge(g.Nr, g.Nz, opts.spongeCells, opts.spongeMax ?? 0.08);
  }

  /** Quadratic sponge on the outer r and both z boundaries (never on the axis). */
  static buildSponge(Nr: number, Nz: number, cells: number, smax: number): Float32Array {
    const damp = new Float32Array(Nr * Nz).fill(1);
    if (cells <= 0) return damp;
    for (let j = 0; j < Nz; j++) {
      for (let i = 0; i < Nr; i++) {
        const dist = Math.min(Nr - 1 - i, j, Nz - 1 - j);
        if (dist < cells) {
          const u = (cells - dist) / cells;
          damp[j * Nr + i] = 1 - smax * u * u;
        }
      }
    }
    return damp;
  }

  /** Advance one time step with the given source velocity (m/s). */
  step(srcValue: number): void {
    const { Nr, Nz, p, vr, vz, solid, sigma, damp, cv, cp, kd } = this;

    // --- radial velocity ---
    for (let j = 0; j < Nz; j++) {
      const row = j * Nr;
      for (let i = 0; i < Nr - 1; i++) {
        const c = row + i;
        if (solid[c] | solid[c + 1]) { vr[c] = 0; continue; }
        let v = vr[c] - cv * (p[c + 1] - p[c]);
        const s = sigma[c] + sigma[c + 1];
        if (s > 0) v /= 1 + 0.5 * s * kd;
        vr[c] = v * damp[c];
      }
      vr[row + Nr - 1] = 0;
    }

    // --- axial velocity ---
    for (let j = 0; j < Nz - 1; j++) {
      const row = j * Nr;
      for (let i = 0; i < Nr; i++) {
        const c = row + i;
        const d = c + Nr;
        if (solid[c] | solid[d]) { vz[c] = 0; continue; }
        let v = vz[c] - cv * (p[d] - p[c]);
        const s = sigma[c] + sigma[d];
        if (s > 0) v /= 1 + 0.5 * s * kd;
        vz[c] = v * damp[c];
      }
    }
    {
      const row = (Nz - 1) * Nr;
      for (let i = 0; i < Nr; i++) vz[row + i] = 0;
    }

    // --- prescribed velocity sources (hard source on faces) ---
    for (let k = 0; k < this.srcFace.length; k++) {
      const f = this.srcFace[k];
      const val = this.srcSign[k] * srcValue;
      if (this.srcIsZ[k]) vz[f] = val; else vr[f] = val;
    }

    // --- pressure ---
    for (let j = 0; j < Nz; j++) {
      const row = j * Nr;
      for (let i = 0; i < Nr; i++) {
        const c = row + i;
        if (solid[c]) { p[c] = 0; continue; }
        // (1/r) d(r·vr)/dr in finite-volume form; the axis cell is a disc of radius dx/2.
        const divr = i === 0 ? 4 * vr[c] : ((i + 0.5) * vr[c] - (i - 0.5) * vr[c - 1]) / i;
        const vzm = j > 0 ? vz[c - Nr] : 0;
        const divz = vz[c] - vzm;
        p[c] = (p[c] - cp * (divr + divz)) * damp[c];
      }
    }
  }

  /** Bilinear sample of pressure at fractional grid coordinates. */
  sample(fr: number, fz: number): number {
    const { Nr, Nz, p } = this;
    const i = Math.floor(fr), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= Nr - 1 || j >= Nz - 1) return 0;
    const a = fr - i, b = fz - j;
    const c = j * Nr + i;
    return (
      p[c] * (1 - a) * (1 - b) +
      p[c + 1] * a * (1 - b) +
      p[c + Nr] * (1 - a) * b +
      p[c + Nr + 1] * a * b
    );
  }
}

/**
 * Gaussian velocity pulse whose spectrum is about -12 dB at fMax.
 * Returns the waveform sampled at dt for nSteps.
 */
export function gaussianPulse(dt: number, nSteps: number, fMax: number): Float32Array {
  const tau = 0.83 / (Math.PI * fMax);
  const t0 = 5 * tau;
  const s = new Float32Array(nSteps);
  for (let n = 0; n < nSteps; n++) {
    const t = n * dt - t0;
    s[n] = Math.exp(-(t * t) / (2 * tau * tau));
  }
  return s;
}
