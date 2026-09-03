/**
 * Pre-run validation of a Scene and its numerical settings, plus post-run
 * sanity checks. Pure functions: no DOM, no solver state.
 */
import type { Scene, SimParams } from './scene';
import { C_AIR } from './fdtd';

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  /** Stable machine-readable code, e.g. 'probe-in-sponge'. */
  code: string;
  message: string;
  /** Element the diagnostic is about, for highlighting in the editor. */
  target?: { kind: 'shape' | 'driver' | 'measure' | 'domain'; index: number };
  /** A point (r, z in mm) to mark on the canvas. */
  point?: [number, number];
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPair = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);

/** Cells per wavelength at frequency f for grid spacing dx (mm). */
export function cellsPerWavelength(dx: number, f: number): number {
  return C_AIR / (f * dx * 1e-3);
}

/** Largest dx (mm) that still gives `ppw` cells per wavelength at fMax. */
export function maxDxFor(fMax: number, ppw = 10): number {
  return (C_AIR / (fMax * ppw)) * 1e3;
}

/** Propagation delay from the axis to the measurement arc, in ms. */
export function arrivalDelayMs(scene: Scene): number {
  return ((scene.measure.radius * 1e-3) / C_AIR) * 1e3;
}

/**
 * Lowest frequency the spectrum can be trusted at for a run of `durationMs`.
 * Rule: at least three periods of usable signal after the first arrival.
 */
export function reliableFMin(scene: Scene, durationMs: number): number {
  const usable = durationMs - arrivalDelayMs(scene);
  if (usable <= 0) return Infinity;
  return 3 / (usable * 1e-3);
}

/** Run length (ms) needed for `fMin` to be reliable. */
export function requiredDurationMs(scene: Scene, fMin: number): number {
  return arrivalDelayMs(scene) + (3 / fMin) * 1e3;
}

/** Minimum distance (mm) from any probe to the start of the sponge layer. Negative = inside. */
export function probeSpongeClearance(scene: Scene, params: SimParams): number {
  const t = params.spongeCells * params.dx;
  const { rMax, zMin, zMax } = scene.domain;
  const { radius, zCenter, angleStep, angleMax = 180 } = scene.measure;
  let minClear = Infinity;
  for (let a = 0; a <= angleMax + 1e-9; a += angleStep) {
    const th = (a * Math.PI) / 180;
    const r = radius * Math.sin(th);
    const z = zCenter + radius * Math.cos(th);
    const clear = Math.min(rMax - t - r, zMax - t - z, z - (zMin + t));
    if (clear < minClear) minClear = clear;
  }
  return minClear;
}

/** Structural validation of untrusted scene input (e.g. parsed JSON). */
export function validateScene(input: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (code: string, message: string) => out.push({ severity: 'error', code, message });

  if (!input || typeof input !== 'object') { err('scene-type', '씬은 객체여야 합니다.'); return out; }
  const s = input as Record<string, unknown>;

  const d = s.domain as Record<string, unknown> | undefined;
  if (!d || typeof d !== 'object') { err('domain-missing', 'domain 이 없습니다.'); return out; }
  if (!isNum(d.rMax) || !isNum(d.zMin) || !isNum(d.zMax)) {
    err('domain-type', 'domain.rMax/zMin/zMax 는 유한한 숫자여야 합니다.');
    return out;
  }
  if (d.rMax <= 0) err('domain-rmax', `domain.rMax 는 양수여야 합니다 (현재 ${d.rMax}).`);
  if (d.zMax <= d.zMin) err('domain-z', `domain.zMax(${d.zMax}) 는 zMin(${d.zMin}) 보다 커야 합니다.`);
  const rMax = d.rMax, zMin = d.zMin, zMax = d.zMax;
  const inDomain = (r: number, z: number) => r >= 0 && r <= rMax && z >= zMin && z <= zMax;

  const m = s.measure as Record<string, unknown> | undefined;
  if (!m || typeof m !== 'object') err('measure-missing', 'measure 가 없습니다.');
  else {
    if (!isNum(m.radius) || m.radius <= 0) err('measure-radius', 'measure.radius 는 양수여야 합니다.');
    if (!isNum(m.zCenter)) err('measure-zcenter', 'measure.zCenter 는 숫자여야 합니다.');
    if (!isNum(m.angleStep) || m.angleStep <= 0 || m.angleStep > 180) {
      err('measure-step', 'measure.angleStep 은 0 초과 180 이하이어야 합니다.');
    }
    if (m.angleMax !== undefined && (!isNum(m.angleMax) || m.angleMax <= 0 || m.angleMax > 180)) {
      err("measure-anglemax", "measure.angleMax 는 0 초과 180 이하이어야 합니다.");
    }
    const angleMax = isNum(m.angleMax) ? m.angleMax : 180;
    if (isNum(m.radius) && isNum(m.zCenter) && isNum(m.angleStep) && m.angleStep > 0) {
      const bad: number[] = [];
      for (let a = 0; a <= angleMax + 1e-9; a += m.angleStep) {
        const th = (a * Math.PI) / 180;
        if (!inDomain(m.radius * Math.sin(th), m.zCenter + m.radius * Math.cos(th))) bad.push(a);
      }
      if (bad.length) {
        out.push({ severity: 'error', code: 'probe-outside', target: { kind: 'measure', index: 0 }, message: `측정점이 도메인 밖에 있습니다: θ = ${bad.slice(0, 6).join(', ')}${bad.length > 6 ? ' …' : ''}°` });
      }
    }
  }

  if (!Array.isArray(s.shapes)) err('shapes-type', 'shapes 는 배열이어야 합니다.');
  else {
    s.shapes.forEach((sh: unknown, k: number) => {
      const x = sh as Record<string, unknown>;
      const tag = `shapes[${k}]${typeof x?.label === 'string' ? ` (${x.label})` : ''}`;
      const err = (code: string, message: string) => out.push({ severity: 'error', code, message, target: { kind: 'shape', index: k } });
      const warn = (code: string, message: string) => out.push({ severity: 'warning', code, message, target: { kind: 'shape', index: k } });
      if (!x || typeof x !== 'object') { err('shape-type', `${tag}: 객체여야 합니다.`); return; }
      if (!['rigid', 'fabric', 'air'].includes(x.material as string)) {
        err('shape-material', `${tag}: material 은 rigid/fabric/air 중 하나여야 합니다.`);
      }
      if (x.sigma !== undefined && (!isNum(x.sigma) || x.sigma < 0)) {
        err('shape-sigma', `${tag}: sigma 는 0 이상 숫자여야 합니다.`);
      }
      if (x.kind === 'rect') {
        if (!isPair(x.r) || !isPair(x.z)) { err('rect-type', `${tag}: r, z 는 [min, max] 숫자 쌍이어야 합니다.`); return; }
        if (x.r[0] < 0 || x.r[1] < 0) err('rect-negative-r', `${tag}: r 은 0 이상이어야 합니다 (축대칭).`);
        if (x.r[0] === x.r[1] || x.z[0] === x.z[1]) err('rect-zero-size', `${tag}: 폭 또는 높이가 0 입니다.`);
        const r0 = Math.min(...x.r), r1 = Math.max(...x.r), z0 = Math.min(...x.z), z1 = Math.max(...x.z);
        if (r0 > rMax || z0 > zMax || z1 < zMin) err('shape-outside', `${tag}: 도메인 밖에 있습니다.`);
        else if (r1 > rMax || z0 < zMin || z1 > zMax) warn('shape-clipped', `${tag}: 도메인 밖으로 나가 잘립니다.`);
      } else if (x.kind === 'path') {
        const nodes = x.nodes as unknown;
        const okNode = (n: unknown) => !!n && typeof n === 'object' && isPair((n as { p: unknown }).p)
          && ((n as { hIn?: unknown }).hIn === undefined || isPair((n as { hIn?: unknown }).hIn))
          && ((n as { hOut?: unknown }).hOut === undefined || isPair((n as { hOut?: unknown }).hOut));
        if (!Array.isArray(nodes) || nodes.length < 3 || !nodes.every(okNode)) {
          err('path-nodes', `${tag}: nodes 는 { p: [r, z], hIn?, hOut? } 3개 이상이어야 합니다.`);
          return;
        }
        const pts = (nodes as { p: [number, number] }[]).map((n) => n.p);
        if (pts.some(([r]) => r < 0)) err('polygon-negative-r', `${tag}: 앵커의 r 은 0 이상이어야 합니다.`);
        if (pts.some(([r, z]) => r > rMax || z < zMin || z > zMax)) warn('shape-clipped', `${tag}: 도메인 밖으로 나가 잘립니다.`);
      } else if (x.kind === 'polygon') {
        if (!Array.isArray(x.points) || x.points.length < 3 || !x.points.every(isPair)) {
          err('polygon-points', `${tag}: points 는 [r, z] 쌍 3개 이상이어야 합니다.`);
          return;
        }
        const pts = x.points as [number, number][];
        if (pts.some(([r]) => r < 0)) err('polygon-negative-r', `${tag}: r 은 0 이상이어야 합니다.`);
        if (pts.some(([r, z]) => r > rMax || z < zMin || z > zMax)) warn('shape-clipped', `${tag}: 도메인 밖으로 나가 잘립니다.`);
      } else {
        err('shape-kind', `${tag}: kind 는 rect, polygon, path 중 하나여야 합니다.`);
      }
    });
  }

  if (!Array.isArray(s.drivers)) err('drivers-type', 'drivers 는 배열이어야 합니다.');
  else {
    if (s.drivers.length === 0) err('drivers-empty', '드라이버가 하나도 없습니다.');
    s.drivers.forEach((dr: unknown, k: number) => {
      const x = dr as Record<string, unknown>;
      const tag = `drivers[${k}]${typeof x?.label === 'string' ? ` (${x.label})` : ''}`;
      const err = (code: string, message: string) => out.push({ severity: 'error', code, message, target: { kind: 'driver', index: k } });
      if (!x || typeof x !== 'object') { err('driver-type', `${tag}: 객체여야 합니다.`); return; }
      if (x.kind === 'piston') {
        if (!isNum(x.z) || !isPair(x.r)) { err('piston-type', `${tag}: z 는 숫자, r 은 [min, max] 쌍이어야 합니다.`); return; }
        if (!['+z', '-z'].includes(x.dir as string)) err('piston-dir', `${tag}: dir 은 +z 또는 -z 여야 합니다.`);
        if (x.r[0] < 0 || x.r[1] < 0) err('driver-negative-r', `${tag}: r 은 0 이상이어야 합니다.`);
        if (x.r[0] === x.r[1]) err('driver-zero-size', `${tag}: 반경 범위가 0 입니다.`);
        if (!inDomain(Math.max(...x.r), x.z) || !inDomain(Math.min(...x.r), x.z)) err('driver-outside', `${tag}: 도메인 밖에 있습니다.`);
      } else if (x.kind === 'radial') {
        if (!isNum(x.r) || !isPair(x.z)) { err('radial-type', `${tag}: r 은 숫자, z 는 [min, max] 쌍이어야 합니다.`); return; }
        if (!['+r', '-r'].includes(x.dir as string)) err('radial-dir', `${tag}: dir 은 +r 또는 -r 여야 합니다.`);
        if (x.r <= 0) err('driver-negative-r', `${tag}: r 은 양수여야 합니다.`);
        if (x.z[0] === x.z[1]) err('driver-zero-size', `${tag}: z 범위가 0 입니다.`);
        if (!inDomain(x.r, x.z[0]) || !inDomain(x.r, x.z[1])) err('driver-outside', `${tag}: 도메인 밖에 있습니다.`);
      } else {
        err('driver-kind', `${tag}: kind 는 piston 또는 radial 이어야 합니다.`);
      }
    });
  }
  return out;
}

/** Numerical-setting checks for a structurally valid scene. */
export function checkSetup(scene: Scene, params: SimParams): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (code: string, message: string) => out.push({ severity: 'error', code, message });
  const warn = (code: string, message: string) => out.push({ severity: 'warning', code, message });
  const info = (code: string, message: string) => out.push({ severity: 'info', code, message });

  const { dx, durationMs, fMax, fMin, spongeCells, courant } = params;
  if (!isNum(dx) || dx <= 0) { err('dx', 'dx 는 양수여야 합니다.'); return out; }
  if (!isNum(durationMs) || durationMs <= 0) { err('duration', '해석 시간은 양수여야 합니다.'); return out; }
  if (!isNum(fMax) || fMax <= 0) { err('fmax', 'fMax 는 양수여야 합니다.'); return out; }
  if (!isNum(fMin) || fMin <= 0 || fMin >= fMax) err('fmin', 'fMin 은 0 보다 크고 fMax 보다 작아야 합니다.');
  if (!isNum(courant) || courant <= 0 || courant > 0.7) err('courant', `Courant 수 ${courant} 는 0 초과 0.7 이하여야 안정합니다.`);
  if (!Number.isInteger(spongeCells) || spongeCells < 0) err('sponge-cells', 'spongeCells 는 0 이상 정수여야 합니다.');

  // Resolution: cells per wavelength at fMax.
  const ppw = cellsPerWavelength(dx, fMax);
  const dxRec = maxDxFor(fMax, 10).toFixed(2);
  if (ppw < 6) {
    err('resolution', `fMax ${fMax} Hz 에서 파장당 ${ppw.toFixed(1)} 셀. 6 미만이면 수치 분산으로 결과를 믿을 수 없습니다. dx ≤ ${dxRec} mm 로 줄이거나 fMax 를 낮추세요.`);
  } else if (ppw < 10) {
    warn('resolution', `fMax ${fMax} Hz 에서 파장당 ${ppw.toFixed(1)} 셀 (권장 10 이상). dx ≤ ${dxRec} mm 권장.`);
  }

  // Low-frequency reliability vs run length.
  const fRel = reliableFMin(scene, durationMs);
  if (!Number.isFinite(fRel)) {
    err('duration-short', `해석 시간 ${durationMs} ms 가 측정 원호 도달 시간 ${arrivalDelayMs(scene).toFixed(2)} ms 보다 짧습니다.`);
  } else if (isNum(fMin) && fMin < fRel) {
    warn('fmin-unreliable', `${fMin} Hz는 ${requiredDurationMs(scene, fMin).toFixed(1)} ms 이상 필요합니다. 현재 ${durationMs} ms에서는 약 ${Math.round(fRel)} Hz 아래를 제외합니다.`);
  }

  // Sponge geometry.
  const spongeMm = spongeCells * dx;
  if (spongeMm < 30) warn('sponge-thin', `흡수층 두께 ${spongeMm} mm. 30 mm 미만이면 경계 반사가 커집니다.`);
  const clear = probeSpongeClearance(scene, params);
  if (clear < 0) {
    err('probe-in-sponge', `측정 원호가 흡수층 안에 들어갑니다 (${(-clear).toFixed(0)} mm 침범). 도메인을 키우거나 measure.radius 를 줄이세요.`);
  } else if (clear < 60) {
    warn('probe-near-sponge', `측정 원호와 흡수층 사이가 ${clear.toFixed(0)} mm 입니다 (권장 60 mm 이상). 저주파 경계 반사가 섞일 수 있습니다.`);
  }

  // Features thinner than one cell are misrepresented by the staircase grid.
  const thin: string[] = [];
  scene.shapes.forEach((s, k) => {
    if (s.kind !== 'rect') return;
    const w = Math.abs(s.r[1] - s.r[0]), h = Math.abs(s.z[1] - s.z[0]);
    if (Math.min(w, h) < dx) thin.push(s.label ?? `shapes[${k}]`);
  });
  if (thin.length) warn('thin-feature', `dx ${dx} mm 보다 얇은 형상: ${thin.join(', ')}. 벽은 굵어지고 절단(air)은 막힐 수 있습니다. dx 를 줄이거나 절단 폭에 여유를 두세요.`);

  // Sources inside the sponge are almost certainly a setup mistake.
  for (const d of scene.drivers) {
    const pts: [number, number][] = d.kind === 'piston' ? [[Math.max(...d.r), d.z]] : [[d.r, d.z[0]], [d.r, d.z[1]]];
    const inside = pts.some(([r, z]) =>
      r > scene.domain.rMax - spongeMm || z > scene.domain.zMax - spongeMm || z < scene.domain.zMin + spongeMm);
    if (inside) warn('driver-in-sponge', `드라이버${d.label ? ` (${d.label})` : ''} 가 흡수층 안에 있습니다.`);
  }

  // Cost estimate.
  const Nr = Math.round(scene.domain.rMax / dx) + 1;
  const Nz = Math.round((scene.domain.zMax - scene.domain.zMin) / dx) + 1;
  const dt = (courant * dx * 1e-3) / (C_AIR * Math.SQRT2);
  const steps = Math.ceil((durationMs * 1e-3) / dt);
  const cellSteps = Nr * Nz * steps;
  info('cost', `${Nr}×${Nz} 셀, ${steps} 스텝, 약 ${(cellSteps / 1e6).toFixed(0)} M cell·step (CPU 약 ${(cellSteps / 60e6).toFixed(0)} s).`);
  if (cellSteps > 3e9) warn('cost-high', '계산량이 큽니다. dx 를 키우거나 시간을 줄이는 것을 고려하세요.');

  return out;
}

/**
 * Post-run decay check on probe histories. If the signal at the end of the
 * run is still strong relative to its peak, the spectrum is truncated and
 * shows ringing artefacts.
 */
export function checkDecay(probeHist: ArrayLike<number>[], tailFraction = 0.1): Diagnostic[] {
  let peak = 0, tail = 0;
  for (const h of probeHist) {
    const n = h.length;
    const t0 = Math.floor(n * (1 - tailFraction));
    for (let i = 0; i < n; i++) {
      const v = Math.abs(h[i]);
      if (v > peak) peak = v;
      if (i >= t0 && v > tail) tail = v;
    }
  }
  if (peak <= 0) {
    return [{ severity: 'error', code: 'no-signal', message: '측정점에 신호가 도달하지 않았습니다. 드라이버가 고체에 묻혀 있거나 해석 시간이 도달 시간보다 짧습니다.' }];
  }
  const db = 20 * Math.log10(tail / peak + 1e-30);
  if (db > -30) {
    return [{ severity: 'warning', code: 'not-decayed', message: `종료 시점 신호가 피크 대비 ${db.toFixed(0)} dB 로 아직 감쇠하지 않았습니다 (권장 -30 dB 이하). 내부 공진이 남아 있으니 해석 시간을 늘리세요.` }];
  }
  return [];
}

export const hasErrors = (d: Diagnostic[]): boolean => d.some((x) => x.severity === 'error');
