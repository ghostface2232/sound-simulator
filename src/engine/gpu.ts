/**
 * WebGPU port of the axisymmetric FDTD solver in fdtd.ts.
 *
 * Same grid, same update equations, same f32 arithmetic. Four compute passes
 * per time step (velocity, source, pressure, probe sampling) are recorded in
 * batches so the GPU runs hundreds of steps per submission. Probe histories
 * accumulate on the GPU and are read back once at the end.
 */
import type { BuiltGrid } from './rasterize';
import { AxiFDTD, C_AIR, RHO_AIR } from './fdtd';

/// <reference types="@webgpu/types" />

const WG = 256;

const SHADER = /* wgsl */ `
struct U {
  Nr: u32, Nz: u32, nSrc: u32, nProbe: u32,
  cv: f32, cp: f32, kd: f32, srcOff: u32,
  probeOff: u32, waveOff: u32, pad0: u32, pad1: u32,
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> p: array<f32>;
@group(0) @binding(2) var<storage, read_write> vr: array<f32>;
@group(0) @binding(3) var<storage, read_write> vz: array<f32>;
// cell.x = solid (0/1), cell.y = sigma, cell.z = damp
@group(0) @binding(4) var<storage, read> cell: array<vec4<f32>>;
// misc: [srcOff..] (face, isZ, sign, 0) per source face; [probeOff..] (fr, fz, 0, 0) per probe;
//       [waveOff..] source waveform packed 4 samples per vec4.
@group(0) @binding(5) var<storage, read> misc: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> hist: array<f32>;
@group(0) @binding(7) var<storage, read_write> state: array<u32>; // [0] = step

@compute @workgroup_size(${WG})
fn velocity(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x;
  let n = u.Nr * u.Nz;
  if (c >= n) { return; }
  let i = c % u.Nr;
  let j = c / u.Nr;
  let cc = cell[c];
  if (i < u.Nr - 1u) {
    let d = c + 1u;
    let cd = cell[d];
    if (cc.x > 0.5 || cd.x > 0.5) {
      vr[c] = 0.0;
    } else {
      var v = vr[c] - u.cv * (p[d] - p[c]);
      let s = cc.y + cd.y;
      if (s > 0.0) { v = v / (1.0 + 0.5 * s * u.kd); }
      vr[c] = v * cc.z;
    }
  } else {
    vr[c] = 0.0;
  }
  if (j < u.Nz - 1u) {
    let d = c + u.Nr;
    let cd = cell[d];
    if (cc.x > 0.5 || cd.x > 0.5) {
      vz[c] = 0.0;
    } else {
      var v = vz[c] - u.cv * (p[d] - p[c]);
      let s = cc.y + cd.y;
      if (s > 0.0) { v = v / (1.0 + 0.5 * s * u.kd); }
      vz[c] = v * cc.z;
    }
  } else {
    vz[c] = 0.0;
  }
}

@compute @workgroup_size(${WG})
fn source(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k >= u.nSrc) { return; }
  let e = misc[u.srcOff + k];
  let step = state[0];
  let w = misc[u.waveOff + (step >> 2u)];
  let val = e.z * w[step & 3u];
  let f = u32(e.x);
  if (e.y > 0.5) { vz[f] = val; } else { vr[f] = val; }
}

@compute @workgroup_size(${WG})
fn pressure(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x;
  let n = u.Nr * u.Nz;
  if (c >= n) { return; }
  let cc = cell[c];
  if (cc.x > 0.5) { p[c] = 0.0; return; }
  let i = c % u.Nr;
  let j = c / u.Nr;
  var divr: f32;
  if (i == 0u) {
    divr = 4.0 * vr[c];
  } else {
    let fi = f32(i);
    divr = ((fi + 0.5) * vr[c] - (fi - 0.5) * vr[c - 1u]) / fi;
  }
  var vzm = 0.0;
  if (j > 0u) { vzm = vz[c - u.Nr]; }
  let divz = vz[c] - vzm;
  p[c] = (p[c] - u.cp * (divr + divz)) * cc.z;
}

@compute @workgroup_size(${WG})
fn probe(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  let step = state[0];
  if (k < u.nProbe) {
    let pp = misc[u.probeOff + k];
    let fi = floor(pp.x);
    let fj = floor(pp.y);
    var val = 0.0;
    if (fi >= 0.0 && fj >= 0.0 && fi < f32(u.Nr - 1u) && fj < f32(u.Nz - 1u)) {
      let i = u32(fi);
      let j = u32(fj);
      let a = pp.x - fi;
      let b = pp.y - fj;
      let c = j * u.Nr + i;
      val = p[c] * (1.0 - a) * (1.0 - b) + p[c + 1u] * a * (1.0 - b)
          + p[c + u.Nr] * (1.0 - a) * b + p[c + u.Nr + 1u] * a * b;
    }
    hist[step * u.nProbe + k] = val;
  }
  workgroupBarrier();
  if (k == 0u) { state[0] = step + 1u; }
}
`;

let devicePromise: Promise<GPUDevice | null> | null = null;

/** Request (and cache) a GPU device. Resolves to null when WebGPU is unavailable. */
export function getGpuDevice(): Promise<GPUDevice | null> {
  if (!devicePromise) {
    devicePromise = (async () => {
      const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
      if (!gpu) return null;
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      device.lost.then(() => { devicePromise = null; });
      return device;
    })().catch(() => null);
  }
  return devicePromise;
}

export interface GpuRunHooks {
  onFrame?: (p: Float32Array, step: number, nSteps: number) => void | Promise<void>;
  shouldStop?: () => boolean;
}

export class GpuAxiFDTD {
  readonly Nr: number;
  readonly Nz: number;
  readonly dt: number;
  readonly dx: number;
  private readonly n: number;
  private readonly nProbe: number;
  private readonly nSteps: number;

  private readonly pBuf: GPUBuffer;
  private readonly histBuf: GPUBuffer;
  private readonly stateBuf: GPUBuffer;
  private readonly stagingP: GPUBuffer;
  private readonly stagingHist: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly pipes: Record<'velocity' | 'source' | 'pressure' | 'probe', GPUComputePipeline>;
  private readonly buffers: GPUBuffer[] = [];
  private readonly nSrc: number;

  private constructor(
    private readonly device: GPUDevice,
    g: BuiltGrid,
    opts: { spongeCells: number; spongeMax?: number; courant: number },
    src: Float32Array,
  ) {
    this.Nr = g.Nr; this.Nz = g.Nz; this.n = g.Nr * g.Nz;
    this.dx = g.dx * 1e-3;
    this.dt = (opts.courant * this.dx) / (C_AIR * Math.SQRT2);
    this.nSteps = src.length;
    this.nProbe = g.probes.length;
    this.nSrc = g.srcFace.length;

    const cv = this.dt / (RHO_AIR * this.dx);
    const cp = (RHO_AIR * C_AIR * C_AIR * this.dt) / this.dx;
    const kd = this.dt / RHO_AIR;

    const damp = AxiFDTD.buildSponge(g.Nr, g.Nz, opts.spongeCells, opts.spongeMax ?? 0.08);
    const cell = new Float32Array(this.n * 4);
    for (let c = 0; c < this.n; c++) {
      cell[c * 4] = g.solid[c];
      cell[c * 4 + 1] = g.sigma[c];
      cell[c * 4 + 2] = damp[c];
    }

    // misc layout: sources, then probes, then waveform (4 samples per vec4).
    const srcOff = 0;
    const probeOff = srcOff + this.nSrc;
    const waveOff = probeOff + this.nProbe;
    const waveVecs = Math.ceil(this.nSteps / 4);
    const misc = new Float32Array((waveOff + waveVecs) * 4);
    for (let k = 0; k < this.nSrc; k++) {
      misc[(srcOff + k) * 4] = g.srcFace[k];
      misc[(srcOff + k) * 4 + 1] = g.srcIsZ[k];
      misc[(srcOff + k) * 4 + 2] = g.srcSign[k];
    }
    for (let k = 0; k < this.nProbe; k++) {
      misc[(probeOff + k) * 4] = g.probes[k].fr;
      misc[(probeOff + k) * 4 + 1] = g.probes[k].fz;
    }
    misc.set(src, waveOff * 4);

    const uni = new ArrayBuffer(48);
    const u32 = new Uint32Array(uni), f32 = new Float32Array(uni);
    u32[0] = g.Nr; u32[1] = g.Nz; u32[2] = this.nSrc; u32[3] = this.nProbe;
    f32[4] = cv; f32[5] = cp; f32[6] = kd; u32[7] = srcOff;
    u32[8] = probeOff; u32[9] = waveOff;

    const mk = (size: number, usage: GPUBufferUsageFlags, data?: ArrayBufferView) => {
      const b = device.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage });
      if (data) device.queue.writeBuffer(b, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
      this.buffers.push(b);
      return b;
    };
    const ST = GPUBufferUsage.STORAGE, CS = GPUBufferUsage.COPY_SRC, CD = GPUBufferUsage.COPY_DST;
    const uniBuf = mk(48, GPUBufferUsage.UNIFORM | CD, u32);
    this.pBuf = mk(this.n * 4, ST | CS | CD);
    const vrBuf = mk(this.n * 4, ST | CD);
    const vzBuf = mk(this.n * 4, ST | CD);
    const cellBuf = mk(cell.byteLength, ST | CD, cell);
    const miscBuf = mk(misc.byteLength, ST | CD, misc);
    this.histBuf = mk(Math.max(4, this.nSteps * this.nProbe * 4), ST | CS | CD);
    this.stateBuf = mk(16, ST | CD, new Uint32Array([0, 0, 0, 0]));
    this.stagingP = mk(this.n * 4, GPUBufferUsage.MAP_READ | CD);
    this.stagingHist = mk(Math.max(4, this.nSteps * this.nProbe * 4), GPUBufferUsage.MAP_READ | CD);

    const module = device.createShaderModule({ code: SHADER });
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipe = (entryPoint: string) => device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
    this.pipes = { velocity: pipe('velocity'), source: pipe('source'), pressure: pipe('pressure'), probe: pipe('probe') };
    this.bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniBuf } },
        { binding: 1, resource: { buffer: this.pBuf } },
        { binding: 2, resource: { buffer: vrBuf } },
        { binding: 3, resource: { buffer: vzBuf } },
        { binding: 4, resource: { buffer: cellBuf } },
        { binding: 5, resource: { buffer: miscBuf } },
        { binding: 6, resource: { buffer: this.histBuf } },
        { binding: 7, resource: { buffer: this.stateBuf } },
      ],
    });
  }

  static async create(
    g: BuiltGrid,
    opts: { spongeCells: number; spongeMax?: number; courant: number },
    src: Float32Array,
  ): Promise<GpuAxiFDTD | null> {
    const device = await getGpuDevice();
    if (!device) return null;
    if (g.probes.length > WG) throw new Error(`GPU 백엔드는 측정점 ${WG}개까지 지원합니다.`);
    return new GpuAxiFDTD(device, g, opts, src);
  }

  private encodeSteps(enc: GPUCommandEncoder, count: number) {
    const pass = enc.beginComputePass();
    pass.setBindGroup(0, this.bindGroup);
    const cellGroups = Math.ceil(this.n / WG);
    const srcGroups = Math.max(1, Math.ceil(this.nSrc / WG));
    for (let s = 0; s < count; s++) {
      pass.setPipeline(this.pipes.velocity); pass.dispatchWorkgroups(cellGroups);
      pass.setPipeline(this.pipes.source); pass.dispatchWorkgroups(srcGroups);
      pass.setPipeline(this.pipes.pressure); pass.dispatchWorkgroups(cellGroups);
      pass.setPipeline(this.pipes.probe); pass.dispatchWorkgroups(1);
    }
    pass.end();
  }

  private async readBuffer(src: GPUBuffer, staging: GPUBuffer, bytes: number): Promise<Float32Array> {
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, staging, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ, 0, bytes);
    const out = new Float32Array(staging.getMappedRange(0, bytes).slice(0));
    staging.unmap();
    return out;
  }

  /** Run all steps. Returns per-probe histories and the final pressure field. */
  async run(hooks: GpuRunHooks = {}, frameEvery = 100): Promise<{ hist: Float32Array[]; p: Float32Array } | null> {
    const batch = Math.max(1, Math.min(frameEvery, 400));
    let step = 0;
    while (step < this.nSteps) {
      if (hooks.shouldStop?.()) return null;
      const count = Math.min(batch, this.nSteps - step);
      const enc = this.device.createCommandEncoder();
      this.encodeSteps(enc, count);
      this.device.queue.submit([enc.finish()]);
      step += count;
      if (hooks.onFrame) {
        const p = await this.readBuffer(this.pBuf, this.stagingP, this.n * 4);
        await hooks.onFrame(p, step, this.nSteps);
      }
    }
    await this.device.queue.onSubmittedWorkDone();
    const flat = await this.readBuffer(this.histBuf, this.stagingHist, this.nSteps * this.nProbe * 4);
    const hist = Array.from({ length: this.nProbe }, () => new Float32Array(this.nSteps));
    for (let s = 0; s < this.nSteps; s++) for (let k = 0; k < this.nProbe; k++) hist[k][s] = flat[s * this.nProbe + k];
    const p = await this.readBuffer(this.pBuf, this.stagingP, this.n * 4);
    return { hist, p };
  }

  dispose() {
    for (const b of this.buffers) b.destroy();
  }
}
