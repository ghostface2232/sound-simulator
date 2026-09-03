import type { Scene } from './scene';

/** Piston in an infinite rigid baffle. Used to validate the solver against theory. */
export function pistonBaffleScene(a = 20, extent = 320, measureRadius = 150): Scene {
  return {
    name: 'piston-baffle',
    description: `반경 ${a}mm 피스톤, 무한 배플. 이론 지향성 2J1(ka sinθ)/(ka sinθ)와 비교용.`,
    // zMin sits well below the baffle so the bottom sponge layer only ever touches solid cells.
    domain: { rMax: extent, zMin: -170, zMax: extent + 10 },
    // Only the half-space above the baffle is meaningful.
    measure: { radius: measureRadius, zCenter: 0, angleStep: 5, angleMax: 90 },
    // Baffle top at z = -0.5 so it lands on a cell boundary (dx = 1) flush with the piston face.
    shapes: [{ kind: 'rect', r: [0, extent], z: [-170, -0.5], material: 'rigid', label: '배플' }],
    drivers: [{ kind: 'piston', z: 0, r: [0, a], dir: '+z', label: '피스톤' }],
  };
}

export interface SideRadialParams {
  housingR: number;
  wall: number;
  height: number;
  driverR: number;
  driverZ: number;
  coneApexZ: number;
  coneBaseR: number;
  coneBaseZ: number;
  slotZ: [number, number];
  fabric: boolean;
  fabricSigma: number;
  /** Optional free-form reflector profile [r, z][] replacing the cone (closed against z = coneBaseZ). */
  reflectorProfile?: [number, number][];
}

export const SIDE_RADIAL_DEFAULTS: SideRadialParams = {
  housingR: 35,
  wall: 1.5,
  height: 60,
  driverR: 20,
  driverZ: 36,
  coneApexZ: 20,
  coneBaseR: 30,
  coneBaseZ: 1.5,
  slotZ: [3, 13],
  fabric: true,
  fabricSigma: 2e5,
};

/**
 * Closed 70 mm cylinder, 40 mm driver firing down onto a cone reflector,
 * sound leaving through an annular slot in the lower side wall (the attached image).
 */
export function sideRadialScene(p: Partial<SideRadialParams> = {}): Scene {
  const q = { ...SIDE_RADIAL_DEFAULTS, ...p };
  const R = q.housingR;
  const shapes: Scene['shapes'] = [
    { kind: 'rect', r: [R - q.wall, R], z: [0, q.height], material: 'rigid', role: 'housing', label: '측벽' },
    { kind: 'rect', r: [0, R], z: [0, q.wall], material: 'rigid', role: 'housing', label: '바닥판' },
    { kind: 'rect', r: [0, R], z: [q.height - q.wall, q.height], material: 'rigid', role: 'housing', label: '상판' },
    {
      kind: 'polygon',
      points: q.reflectorProfile
        ? [[0, q.coneBaseZ], ...q.reflectorProfile, [q.reflectorProfile[q.reflectorProfile.length - 1][0], q.coneBaseZ]]
        : [[0, q.coneApexZ], [q.coneBaseR, q.coneBaseZ], [0, q.coneBaseZ]],
      material: 'rigid',
      role: 'reflector',
      label: q.reflectorProfile ? '리플렉터 프로파일' : '원뿔 리플렉터',
    },
    // Cut 2 mm past both wall faces so the slot stays open on coarse grids (a 1.5 mm wall
    // rasterises to two cells at dx >= 2 mm; a cut the width of the wall would leave one closed).
    { kind: 'rect', r: [R - q.wall - 2, R + 2], z: q.slotZ, material: 'air', role: 'slot', label: '측면 슬롯' },
  ];
  if (q.fabric) {
    shapes.push({
      kind: 'rect', r: [R, R + 1], z: [q.slotZ[0] - 1, q.slotZ[1] + 1],
      material: 'fabric', role: 'fabric', sigma: q.fabricSigma, label: '패브릭',
    });
  }
  return {
    name: 'side-radial',
    description: '70mm 하우징, 40mm 드라이버 하향 발사, 원뿔 리플렉터, 하단 측면 환형 슬롯 + 패브릭.',
    domain: { rMax: 290, zMin: -250, zMax: 310 },
    measure: { radius: 120, zCenter: 30, angleStep: 5 },
    shapes,
    drivers: [{ kind: 'piston', z: q.driverZ, r: [0, q.driverR], dir: '-z', label: '드라이버' }],
  };
}

/** Conventional front-firing unit: driver in the top plate of a closed cylinder. */
export function frontFiringScene(): Scene {
  const R = 35, wall = 1.5, H = 50;
  return {
    name: 'front-firing',
    description: '70mm 밀폐 원통, 상판에 40mm 드라이버가 정면(+z)으로 방사.',
    domain: { rMax: 290, zMin: -250, zMax: 310 },
    measure: { radius: 120, zCenter: H, angleStep: 5 },
    shapes: [
      { kind: 'rect', r: [R - wall, R], z: [0, H], material: 'rigid', label: '측벽' },
      { kind: 'rect', r: [0, R], z: [0, wall], material: 'rigid', label: '바닥판' },
      { kind: 'rect', r: [20, R], z: [H - wall, H], material: 'rigid', label: '상판' },
    ],
    drivers: [{ kind: 'piston', z: H, r: [0, 20], dir: '+z', label: '드라이버' }],
  };
}

/** 360° up-firing unit with a suspended cone reflector above the driver. */
export function upFiring360Scene(): Scene {
  const R = 35, wall = 1.5, H = 50;
  return {
    name: 'up-firing-360',
    description: '상향 발사 드라이버 위에 원뿔 리플렉터를 띄워 360° 수평 방사.',
    domain: { rMax: 290, zMin: -250, zMax: 310 },
    measure: { radius: 120, zCenter: H + 15, angleStep: 5 },
    shapes: [
      { kind: 'rect', r: [R - wall, R], z: [0, H], material: 'rigid', label: '측벽' },
      { kind: 'rect', r: [0, R], z: [0, wall], material: 'rigid', label: '바닥판' },
      { kind: 'rect', r: [20, R], z: [H - wall, H], material: 'rigid', label: '상판' },
      { kind: 'polygon', points: [[0, H + 12], [R, H + 32], [0, H + 32]], material: 'rigid', role: 'reflector', label: '리플렉터' },
    ],
    drivers: [{ kind: 'piston', z: H, r: [0, 20], dir: '+z', label: '드라이버' }],
  };
}

export const PRESETS: Record<string, () => Scene> = {
  'side-radial': () => sideRadialScene(),
  'front-firing': frontFiringScene,
  'up-firing-360': upFiring360Scene,
  'piston-baffle': () => pistonBaffleScene(),
};
