import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Scene, PathShape, PathNode, Driver, ShapeRole } from '../engine/scene';
import type { Diagnostic } from '../engine/checks';
import {
  bandNodes, bandOf, cornerNode, distToSegment, driverSegment, ellipsePath, isSmoothNode, nearestOnPath, pointInPolygon, polygonsOverlap, sceneBounds,
  type Band,
  segmentIsLine, shapeToPath, shapeToPolygon, smoothNode, splitSegment, type Pt,
} from '../engine/geometry';
import { readCanvasTheme, type CanvasTheme } from './theme';

export interface GridInfo {
  Nr: number; Nz: number; dx: number; zMin: number;
  solid: Uint8Array; sigma: Float32Array;
  probes: { fr: number; fz: number; angleDeg: number }[];
}

export type Selection =
  | { kind: 'shape'; index: number; vertex?: number; handle?: 'in' | 'out'; side?: -1 | 1 }
  | { kind: 'shapes'; indices: number[] }
  | { kind: 'driver'; index: number }
  | { kind: 'measure' }
  | null;

export function selectedShapeIndices(selection: Selection): number[] {
  if (selection?.kind === 'shapes') return selection.indices;
  return selection?.kind === 'shape' ? [selection.index] : [];
}

export function shapeSelection(indices: number[]): Selection {
  const unique = [...new Set(indices)].sort((a, b) => a - b);
  if (unique.length === 0) return null;
  return unique.length === 1 ? { kind: 'shape', index: unique[0] } : { kind: 'shapes', indices: unique };
}

export type Tool = 'select' | 'pen' | 'rect' | 'ellipse';

export interface SectionCanvasHandle {
  fitDevice(): void;
  fitDomain(): void;
  zoomBy(factor: number): void;
}

interface Props {
  scene: Scene;
  /** commit=false while dragging, true when the gesture ends or for discrete edits. */
  onChange: (scene: Scene, commit: boolean) => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
  tool: Tool;
  onToolDone: () => void;
  field: { grid: GridInfo | null; frame: Float32Array | null; scale: number };
  gridMask: GridInfo | null;
  diagnostics: Diagnostic[];
  spongeMm: number;
  editable: boolean;
  snap: number;
  /** Bumped when the colour scheme changes so the canvas repaints with the new palette. */
  themeKey?: string;
  /** Reports the current zoom (px per mm) so the shell can show a readout. */
  onZoom?: (pxPerMm: number) => void;
}

/** Role palette as CSS custom properties: usable directly in HTML/SVG styles. */
export const ROLE_COLORS: Record<ShapeRole, { fill: string; stroke: string; name: string }> = {
  housing: { fill: 'var(--role-housing)', stroke: 'var(--role-housing-line)', name: '하우징' },
  reflector: { fill: 'var(--role-reflector)', stroke: 'var(--role-reflector-line)', name: '리플렉터' },
  slot: { fill: 'var(--role-slot)', stroke: 'var(--role-slot-line)', name: '슬롯' },
  fabric: { fill: 'var(--role-fabric)', stroke: 'var(--role-fabric-line)', name: '패브릭' },
  driver: { fill: 'var(--role-driverbody)', stroke: 'var(--role-driverbody-line)', name: '드라이버 몸체' },
  other: { fill: 'var(--role-other)', stroke: 'var(--role-other-line)', name: '기타' },
};
export const DRIVER_COLOR = 'var(--role-driver)';
export const MEASURE_COLOR = 'var(--role-measure)';

function roleStyle(T: CanvasTheme, role: ShapeRole): { fill: string; stroke: string } {
  switch (role) {
    case 'housing': return { fill: T.housingFill, stroke: T.housingStroke };
    case 'reflector': return { fill: T.reflectorFill, stroke: T.reflectorStroke };
    case 'slot': return { fill: T.slotFill, stroke: T.slotStroke };
    case 'fabric': return { fill: T.fabricFill, stroke: T.fabricStroke };
    case 'driver': return { fill: T.driverBodyFill, stroke: T.driverBodyStroke };
    default: return { fill: T.otherFill, stroke: T.otherStroke };
  }
}

interface View { s: number; ox: number; oy: number }

interface Marquee {
  startPx: [number, number];
  currentPx: [number, number];
  base: number[];
  hits: number[];
  moved: boolean;
}

type Drag =
  | { kind: 'anchor'; index: number; node: number; orig: PathNode; start: Pt }
  | { kind: 'handle'; index: number; node: number; which: 'in' | 'out' }
  | { kind: 'shape'; index: number; orig: PathNode[]; start: Pt }
  | { kind: 'shapes'; items: { index: number; orig: PathNode[] }[]; start: Pt }
  | { kind: 'bandEdge'; index: number; edge: 'start' | 'end'; band: Band }
  | { kind: 'bandMove'; index: number; band: Band; start: Pt }
  | { kind: 'driverEnd'; index: number; end: 0 | 1 }
  | { kind: 'driver'; index: number; orig: Driver; start: Pt }
  | { kind: 'measureRadius' }
  | { kind: 'measureCenter'; startZ: number; origZ: number }
  | { kind: 'pan'; startPx: [number, number]; origView: View }
  | { kind: 'marquee'; gesture: Marquee }
  | { kind: 'rect'; start: Pt; current: Pt; ellipse: boolean; square: boolean }
  | { kind: 'pen'; node: number; startPx: [number, number]; dragged: boolean };

const HANDLE_PX = 9;
const MARQUEE_THRESHOLD_PX = 7;

export function roleOf(s: { role?: ShapeRole; material: string }): ShapeRole {
  return s.role ?? (s.material === 'rigid' ? 'housing' : s.material === 'fabric' ? 'fabric' : 'slot');
}

function makeHatch(T: CanvasTheme): CanvasPattern | null {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 8;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = T.fabricFill; g.fillRect(0, 0, 8, 8);
  g.strokeStyle = T.fabricHatch; g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(-2, 10); g.lineTo(10, -2); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.stroke();
  return g.createPattern(c, 'repeat');
}

const cloneNode = (n: PathNode): PathNode => ({ p: [n.p[0], n.p[1]], ...(n.hIn ? { hIn: [n.hIn[0], n.hIn[1]] as Pt } : {}), ...(n.hOut ? { hOut: [n.hOut[0], n.hOut[1]] as Pt } : {}) });
const cloneNodes = (ns: PathNode[]) => ns.map(cloneNode);
const translateNode = (n: PathNode, dr: number, dz: number): PathNode => ({
  p: [n.p[0] + dr, n.p[1] + dz],
  ...(n.hIn ? { hIn: [n.hIn[0] + dr, n.hIn[1] + dz] as Pt } : {}),
  ...(n.hOut ? { hOut: [n.hOut[0] + dr, n.hOut[1] + dz] as Pt } : {}),
});

export const SectionCanvas = forwardRef<SectionCanvasHandle, Props>(function SectionCanvas(p, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ s: 4, ox: 0, oy: 0 });
  const viewRef = useRef(view); viewRef.current = view;
  const dragRef = useRef<Drag | null>(null);
  const [penNodes, setPenNodes] = useState<PathNode[]>([]);
  const [mouseMm, setMouseMm] = useState<Pt | null>(null);
  const [rectDrag, setRectDrag] = useState<{ start: Pt; current: Pt; ellipse: boolean } | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [panning, setPanning] = useState(false);
  const hatchRef = useRef<{ key: string; pattern: CanvasPattern | null } | null>(null);
  const layerRef = useRef<HTMLCanvasElement | null>(null);
  const fittedRef = useRef(false);

  // ---- coordinate helpers -------------------------------------------------
  const toPx = useCallback((r: number, z: number, v: View = viewRef.current): [number, number] => [v.ox + r * v.s, v.oy - z * v.s], []);
  const toMm = useCallback((px: number, py: number, v: View = viewRef.current): Pt => [(px - v.ox) / v.s, (v.oy - py) / v.s], []);
  const snapV = useCallback((v: number) => Math.round(v / p.snap) * p.snap, [p.snap]);
  const snapR = useCallback((r: number) => Math.max(0, snapV(Math.abs(r))), [snapV]);
  const snapH = (v: number) => Math.round(v * 10) / 10; // handles snap to 0.1 mm
  /** Shift: keep only the dominant axis of a delta. */
  const axisLock = (dr: number, dz: number, shift: boolean): [number, number] => (!shift ? [dr, dz] : Math.abs(dr) >= Math.abs(dz) ? [dr, 0] : [0, dz]);

  const fitBox = useCallback((r0: number, r1: number, z0: number, z1: number, margin: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const w = el.clientWidth, h = el.clientHeight;
    const rr = Math.max(r1, -r0) + margin, zh = z1 - z0 + 2 * margin;
    const s = Math.min(w / (2 * rr), h / zh);
    setView({ s, ox: w / 2, oy: h / 2 + ((z0 + z1) / 2) * s });
  }, []);

  const zoomBy = useCallback((f: number) => {
    const el = wrapRef.current;
    const v = viewRef.current;
    const px = el ? el.clientWidth / 2 : 0, py = el ? el.clientHeight / 2 : 0;
    const s = Math.min(80, Math.max(0.3, v.s * f));
    setView({ s, ox: px - (px - v.ox) * (s / v.s), oy: py - (py - v.oy) * (s / v.s) });
  }, []);

  useImperativeHandle(ref, () => ({
    fitDevice: () => { const b = sceneBounds(p.scene); fitBox(-b.r1, b.r1, b.z0, b.z1, Math.max(15, (b.z1 - b.z0) * 0.45)); },
    fitDomain: () => { const d = p.scene.domain; fitBox(-d.rMax, d.rMax, d.zMin, d.zMax, 5); },
    zoomBy,
  }), [p.scene, fitBox, zoomBy]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      setSize((prev) => {
        // Keep the mm point at the viewport centre fixed while the panel layout changes.
        if (fittedRef.current && prev.w > 0 && prev.h > 0 && (prev.w !== w || prev.h !== h)) {
          const v = viewRef.current;
          setView({ s: v.s, ox: v.ox + (w - prev.w) / 2, oy: v.oy + (h - prev.h) / 2 });
        }
        return { w, h };
      });
      if (!fittedRef.current && w > 0) {
        fittedRef.current = true;
        const b = sceneBounds(p.scene);
        fitBox(-b.r1, b.r1, b.z0, b.z1, Math.max(15, (b.z1 - b.z0) * 0.45));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitBox, p.scene]);

  useEffect(() => { p.onZoom?.(view.s); }, [view.s, p.onZoom]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const v = viewRef.current;
      const f = Math.exp(-e.deltaY * 0.0015);
      const s = Math.min(80, Math.max(0.3, v.s * f));
      setView({ s, ox: px - (px - v.ox) * (s / v.s), oy: py - (py - v.oy) * (s / v.s) });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ---- raster layers ---------------------------------------------------------
  const fieldImage = useMemo(() => {
    const { grid, frame, scale } = p.field;
    if (!grid || !frame) return null;
    const T = readCanvasTheme();
    const [bR, bG, bB] = T.fieldBase, [pR, pG, pB] = T.fieldPos, [nR, nG, nB] = T.fieldNeg;
    const { Nr, Nz, solid } = grid;
    const W = 2 * Nr - 1, H = Nz;
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const ctx = off.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const data = img.data;
    const inv = 1 / Math.max(scale, 1e-12);
    for (let j = 0; j < Nz; j++) {
      const y = Nz - 1 - j;
      for (let i = 0; i < Nr; i++) {
        const c = j * Nr + i;
        let R = bR, G = bG, B = bB;
        if (!solid[c]) {
          const v = Math.max(-1, Math.min(1, frame[c] * inv));
          const m = Math.sign(v) * Math.sqrt(Math.abs(v));
          if (m > 0) { R = bR + (pR - bR) * m; G = bG + (pG - bG) * m; B = bB + (pB - bB) * m; }
          else { R = bR - (nR - bR) * m; G = bG - (nG - bG) * m; B = bB - (nB - bB) * m; }
        }
        for (const x of [Nr - 1 + i, Nr - 1 - i]) {
          const o = (y * W + x) * 4;
          data[o] = R; data[o + 1] = G; data[o + 2] = B; data[o + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return { canvas: off, grid };
  }, [p.field, p.themeKey]);

  const maskImage = useMemo(() => {
    const g = p.gridMask;
    if (!g) return null;
    const T = readCanvasTheme();
    const { Nr, Nz, solid, sigma } = g;
    const W = 2 * Nr - 1, H = Nz;
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const ctx = off.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const data = img.data;
    for (let j = 0; j < Nz; j++) {
      const y = Nz - 1 - j;
      for (let i = 0; i < Nr; i++) {
        const c = j * Nr + i;
        let R = 0, G = 0, B = 0, A = 0;
        if (solid[c]) { [R, G, B] = T.gridSolid; A = 110; }
        else if (sigma[c] > 0) { [R, G, B] = T.gridSigma; A = 110; }
        for (const x of [Nr - 1 + i, Nr - 1 - i]) {
          const o = (y * W + x) * 4;
          data[o] = R; data[o + 1] = G; data[o + 2] = B; data[o + 3] = A;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return { canvas: off, grid: g };
  }, [p.gridMask, p.themeKey]);

  // ---- shape access ------------------------------------------------------------
  const nodesOf = useCallback((index: number): PathNode[] => shapeToPath(p.scene.shapes[index]).nodes, [p.scene]);

  const writeNodes = useCallback((index: number, nodes: PathNode[], commit: boolean) => {
    const shapes = p.scene.shapes.slice();
    const s = shapeToPath(shapes[index]);
    shapes[index] = { ...s, nodes } as PathShape;
    p.onChange({ ...p.scene, shapes }, commit);
  }, [p]);

  const updateDriver = useCallback((index: number, d: Driver, commit: boolean) => {
    const drivers = p.scene.drivers.slice();
    drivers[index] = d;
    p.onChange({ ...p.scene, drivers }, commit);
  }, [p]);

  const addShape = useCallback((nodes: PathNode[]) => {
    const shape: PathShape = { kind: 'path', nodes, material: 'rigid', role: 'housing', label: `shape ${p.scene.shapes.length + 1}` };
    p.onChange({ ...p.scene, shapes: [...p.scene.shapes, shape] }, true);
    p.onSelect({ kind: 'shape', index: p.scene.shapes.length });
  }, [p]);

  const finishPen = useCallback(() => {
    if (penNodes.length >= 3) addShape(penNodes);
    setPenNodes([]);
    p.onToolDone();
  }, [penNodes, addShape, p]);

  const shapeIndicesInRect = useCallback((a: [number, number], b: [number, number]): number[] => {
    const left = Math.min(a[0], b[0]), right = Math.max(a[0], b[0]);
    const top = Math.min(a[1], b[1]), bottom = Math.max(a[1], b[1]);
    const box: Pt[] = [[left, top], [right, top], [right, bottom], [left, bottom]];
    return p.scene.shapes.flatMap((shape, index) => {
      const polygon = shapeToPolygon(shape);
      const hit = [1, -1].some((side) => polygonsOverlap(polygon.map(([r, z]) => toPx(side * r, z)), box));
      return hit ? [index] : [];
    });
  }, [p.scene.shapes, toPx]);

  // ---- hit testing -----------------------------------------------------------
  const hitTest = useCallback((px: number, py: number): { sel: Selection; drag: Drag | null } => {
    const v = viewRef.current;
    const [xm, zm] = toMm(px, py, v);
    const rm = Math.abs(xm);
    const tol = HANDLE_PX / v.s;
    const scene = p.scene;
    const near = (a: Pt | undefined, b: Pt) => !!a && Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
    const cursor: Pt = [rm, zm];

    if (p.selection?.kind === 'shape' && scene.shapes[p.selection.index]) {
      const idx = p.selection.index;
      const band = bandOf(scene.shapes[idx]);
      if (band) {
        const rc = (band.r0 + band.r1) / 2, zc = (band.z0 + band.z1) / 2;
        const endPt: Pt = band.axis === 'z' ? [rc, band.z1] : [band.r1, zc];
        const startPt: Pt = band.axis === 'z' ? [rc, band.z0] : [band.r0, zc];
        if (near(endPt, cursor)) return { sel: { kind: 'shape', index: idx }, drag: { kind: 'bandEdge', index: idx, edge: 'end', band } };
        if (near(startPt, cursor)) return { sel: { kind: 'shape', index: idx }, drag: { kind: 'bandEdge', index: idx, edge: 'start', band } };
      }
      const nodes = nodesOf(idx);
      const vi = p.selection.vertex;
      // Handles of the selected anchor and the facing handles of its neighbours.
      if (vi !== undefined && nodes[vi]) {
        const n = nodes.length;
        const cands: { node: number; which: 'in' | 'out'; pt?: Pt }[] = [
          { node: vi, which: 'in', pt: nodes[vi].hIn }, { node: vi, which: 'out', pt: nodes[vi].hOut },
          { node: (vi + n - 1) % n, which: 'out', pt: nodes[(vi + n - 1) % n].hOut },
          { node: (vi + 1) % n, which: 'in', pt: nodes[(vi + 1) % n].hIn },
        ];
        for (const c of cands) if (near(c.pt, cursor)) return { sel: { kind: 'shape', index: idx, vertex: vi, handle: c.which, side: xm < 0 ? -1 : 1 }, drag: { kind: 'handle', index: idx, node: c.node, which: c.which } };
      }
      for (let k = 0; k < nodes.length; k++) {
        if (near(nodes[k].p, cursor)) return { sel: { kind: 'shape', index: idx, vertex: k, side: xm < 0 ? -1 : 1 }, drag: { kind: 'anchor', index: idx, node: k, orig: cloneNode(nodes[k]), start: cursor } };
      }
    }
    for (let k = scene.drivers.length - 1; k >= 0; k--) {
      const { a, b } = driverSegment(scene.drivers[k]);
      if (near(a, cursor)) return { sel: { kind: 'driver', index: k }, drag: { kind: 'driverEnd', index: k, end: 0 } };
      if (near(b, cursor)) return { sel: { kind: 'driver', index: k }, drag: { kind: 'driverEnd', index: k, end: 1 } };
    }
    {
      const m = scene.measure;
      if (near([0, m.zCenter + m.radius], cursor)) return { sel: { kind: 'measure' }, drag: { kind: 'measureRadius' } };
      if (near([0, m.zCenter], cursor)) return { sel: { kind: 'measure' }, drag: { kind: 'measureCenter', startZ: zm, origZ: m.zCenter } };
    }
    for (let k = scene.drivers.length - 1; k >= 0; k--) {
      const { a, b } = driverSegment(scene.drivers[k]);
      if (distToSegment(cursor, a, b) <= tol) return { sel: { kind: 'driver', index: k }, drag: { kind: 'driver', index: k, orig: scene.drivers[k], start: cursor } };
    }
    for (let k = scene.shapes.length - 1; k >= 0; k--) {
      const pts = shapeToPolygon(scene.shapes[k]);
      const nodes = nodesOf(k);
      const hit = pointInPolygon(rm, zm, pts) || nearestOnPath(nodes, cursor).dist <= tol;
      if (hit) {
        const band = bandOf(scene.shapes[k]);
        if (band) return { sel: { kind: 'shape', index: k }, drag: { kind: 'bandMove', index: k, band, start: cursor } };
        return { sel: { kind: 'shape', index: k }, drag: { kind: 'shape', index: k, orig: cloneNodes(nodes), start: cursor } };
      }
    }
    {
      const m = scene.measure;
      if (Math.abs(Math.hypot(rm, zm - m.zCenter) - m.radius) <= tol) return { sel: { kind: 'measure' }, drag: { kind: 'measureRadius' } };
    }
    return { sel: null, drag: null };
  }, [p.scene, p.selection, toMm, nodesOf]);

  // ---- pointer gestures ----------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    e.currentTarget.focus();
    const v = viewRef.current;
    if (e.button === 1) {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { kind: 'pan', startPx: [px, py], origView: v };
      setPanning(true);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const [xm, zm] = toMm(px, py, v);
    const cur: Pt = [snapR(xm), snapV(zm)];
    if (!p.editable) return;
    setMarquee(null);

    if (p.tool === 'pen') {
      if (penNodes.length >= 3 && Math.hypot(penNodes[0].p[0] - Math.abs(xm), penNodes[0].p[1] - zm) <= HANDLE_PX / v.s) { finishPen(); return; }
      const next = [...penNodes, { p: cur } as PathNode];
      setPenNodes(next);
      dragRef.current = { kind: 'pen', node: next.length - 1, startPx: [px, py], dragged: false };
      return;
    }
    if (p.tool === 'rect' || p.tool === 'ellipse') {
      dragRef.current = { kind: 'rect', start: cur, current: cur, ellipse: p.tool === 'ellipse', square: e.shiftKey };
      setRectDrag({ start: cur, current: cur, ellipse: p.tool === 'ellipse' });
      return;
    }
    const { sel, drag } = hitTest(px, py);
    const current = selectedShapeIndices(p.selection).filter((index) => !!p.scene.shapes[index]);
    if (e.shiftKey && sel?.kind === 'shape') {
      const next = current.includes(sel.index) ? current.filter((index) => index !== sel.index) : [...current, sel.index];
      p.onSelect(shapeSelection(next));
      dragRef.current = null;
      return;
    }
    if (sel?.kind === 'shape' && p.selection?.kind === 'shapes' && current.includes(sel.index)) {
      p.onSelect(shapeSelection(current));
      dragRef.current = {
        kind: 'shapes',
        items: current.map((index) => ({ index, orig: cloneNodes(nodesOf(index)) })),
        start: [Math.abs(xm), zm],
      };
      return;
    }
    if (sel) {
      p.onSelect(sel);
      dragRef.current = drag;
      return;
    }
    const gesture: Marquee = {
      startPx: [px, py], currentPx: [px, py], base: e.shiftKey ? current : [], hits: [], moved: false,
    };
    dragRef.current = { kind: 'marquee', gesture };
    setMarquee(gesture);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const v = viewRef.current;
    const [xm, zm] = toMm(px, py, v);
    setMouseMm([Math.abs(xm), zm]);
    const d = dragRef.current;
    if (!d) return;
    const scene = p.scene;
    switch (d.kind) {
      case 'pan':
        setView({ s: d.origView.s, ox: d.origView.ox + (px - d.startPx[0]), oy: d.origView.oy + (py - d.startPx[1]) });
        break;
      case 'anchor': {
        const nodes = cloneNodes(nodesOf(d.index));
        const target: Pt = [snapR(xm), snapV(zm)];
        const [ddr, ddz] = axisLock(target[0] - d.orig.p[0], target[1] - d.orig.p[1], e.shiftKey);
        nodes[d.node] = translateNode(d.orig, Math.max(-d.orig.p[0], ddr), ddz);
        writeNodes(d.index, nodes, false);
        break;
      }
      case 'handle': {
        const nodes = cloneNodes(nodesOf(d.index));
        const n = nodes[d.node];
        let h: Pt = [Math.max(0, snapH(Math.abs(xm))), snapH(zm)];
        if (e.shiftKey) { const [hr, hz] = axisLock(h[0] - n.p[0], h[1] - n.p[1], true); h = [Math.max(0, n.p[0] + hr), n.p[1] + hz]; }
        const wasSmooth = isSmoothNode(n);
        if (d.which === 'in') n.hIn = h; else n.hOut = h;
        // Mirror the opposite handle (angle and length) unless Alt is held or the anchor was a corner.
        if (!e.altKey && wasSmooth) {
          const mirror: Pt = [Math.max(0, 2 * n.p[0] - h[0]), 2 * n.p[1] - h[1]];
          if (d.which === 'in') n.hOut = mirror; else n.hIn = mirror;
        }
        nodes[d.node] = n;
        writeNodes(d.index, nodes, false);
        break;
      }
      case 'shape': {
        const minR = Math.min(...d.orig.flatMap((n) => [n.p[0], ...(n.hIn ? [n.hIn[0]] : []), ...(n.hOut ? [n.hOut[0]] : [])]));
        const [ldr, ldz] = axisLock(snapV(Math.abs(xm) - d.start[0]), snapV(zm - d.start[1]), e.shiftKey);
        const dr = Math.max(-minR, ldr), dz = ldz;
        writeNodes(d.index, d.orig.map((n) => translateNode(n, dr, dz)), false);
        break;
      }
      case 'shapes': {
        const minR = Math.min(...d.items.flatMap(({ orig }) => orig.flatMap((n) => [n.p[0], ...(n.hIn ? [n.hIn[0]] : []), ...(n.hOut ? [n.hOut[0]] : [])])));
        const [ldr, ldz] = axisLock(snapV(Math.abs(xm) - d.start[0]), snapV(zm - d.start[1]), e.shiftKey);
        const dr = Math.max(-minR, ldr), dz = ldz;
        const shapes = scene.shapes.slice();
        for (const item of d.items) {
          const shape = shapeToPath(shapes[item.index]);
          shapes[item.index] = { ...shape, nodes: item.orig.map((n) => translateNode(n, dr, dz)) } as PathShape;
        }
        p.onChange({ ...scene, shapes }, false);
        break;
      }
      case 'bandEdge': {
        const b = { ...d.band };
        if (b.axis === 'z') {
          const z = snapV(zm);
          if (d.edge === 'end') b.z1 = Math.max(b.z0 + p.snap, z); else b.z0 = Math.min(b.z1 - p.snap, z);
        } else {
          const r = snapR(xm);
          if (d.edge === 'end') b.r1 = Math.max(b.r0 + p.snap, r); else b.r0 = Math.min(b.r1 - p.snap, r);
        }
        writeNodes(d.index, bandNodes(b), false);
        break;
      }
      case 'bandMove': {
        if (d.band.axis === 'z') {
          const dz = snapV(zm - d.start[1]);
          writeNodes(d.index, bandNodes({ ...d.band, z0: d.band.z0 + dz, z1: d.band.z1 + dz }), false);
        } else {
          const dr = Math.max(-d.band.r0, snapV(Math.abs(xm) - d.start[0]));
          writeNodes(d.index, bandNodes({ ...d.band, r0: d.band.r0 + dr, r1: d.band.r1 + dr }), false);
        }
        break;
      }
      case 'driverEnd': {
        const dr = scene.drivers[d.index];
        if (dr.kind === 'piston') {
          const r: [number, number] = [Math.min(...dr.r), Math.max(...dr.r)];
          r[d.end] = snapR(xm);
          if (r[1] - r[0] < 1) r[d.end] = d.end === 0 ? Math.max(0, r[1] - 1) : r[0] + 1;
          updateDriver(d.index, { ...dr, r }, false);
        } else {
          const z: [number, number] = [Math.min(...dr.z), Math.max(...dr.z)];
          z[d.end] = snapV(zm);
          if (z[1] - z[0] < 1) z[d.end] = d.end === 0 ? z[1] - 1 : z[0] + 1;
          updateDriver(d.index, { ...dr, z }, false);
        }
        break;
      }
      case 'driver': {
        if (d.orig.kind === 'piston') updateDriver(d.index, { ...d.orig, z: snapV(d.orig.z + (zm - d.start[1])) }, false);
        else updateDriver(d.index, { ...d.orig, r: Math.max(1, snapV(d.orig.r + (Math.abs(xm) - d.start[0]))) }, false);
        break;
      }
      case 'measureRadius': {
        const radius = Math.max(5, snapV(Math.hypot(xm, zm - scene.measure.zCenter)));
        p.onChange({ ...scene, measure: { ...scene.measure, radius } }, false);
        break;
      }
      case 'measureCenter':
        p.onChange({ ...scene, measure: { ...scene.measure, zCenter: snapV(d.origZ + (zm - d.startZ)) } }, false);
        break;
      case 'rect': {
        let cur: Pt = [snapR(xm), snapV(zm)];
        if (e.shiftKey) {
          const w = cur[0] - d.start[0], h = cur[1] - d.start[1];
          const s = Math.max(Math.abs(w), Math.abs(h));
          cur = [Math.max(0, d.start[0] + Math.sign(w || 1) * s), d.start[1] + Math.sign(h || 1) * s];
        }
        d.current = cur;
        setRectDrag({ start: d.start, current: cur, ellipse: d.ellipse });
        break;
      }
      case 'pen': {
        // Click-drag on a new pen anchor pulls out symmetric handles (Figma/Illustrator behaviour).
        if (!d.dragged && Math.hypot(px - d.startPx[0], py - d.startPx[1]) < 4) break;
        d.dragged = true;
        setPenNodes((prev) => {
          const next = cloneNodes(prev);
          const n = next[d.node];
          const h: Pt = [Math.max(0, snapH(Math.abs(xm))), snapH(zm)];
          n.hOut = h;
          n.hIn = [Math.max(0, 2 * n.p[0] - h[0]), 2 * n.p[1] - h[1]];
          return next;
        });
        break;
      }
      case 'marquee': {
        const distance = Math.hypot(px - d.gesture.startPx[0], py - d.gesture.startPx[1]);
        if (!d.gesture.moved && distance < MARQUEE_THRESHOLD_PX) break;
        d.gesture.moved = true;
        d.gesture.currentPx = [px, py];
        d.gesture.hits = shapeIndicesInRect(d.gesture.startPx, d.gesture.currentPx);
        setMarquee({ ...d.gesture, hits: [...d.gesture.hits] });
        break;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    setPanning(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.kind === 'marquee') {
      if (d.gesture.moved) {
        const rect = e.currentTarget.getBoundingClientRect();
        d.gesture.currentPx = [e.clientX - rect.left, e.clientY - rect.top];
        d.gesture.hits = shapeIndicesInRect(d.gesture.startPx, d.gesture.currentPx);
      }
      p.onSelect(shapeSelection(d.gesture.moved ? [...d.gesture.base, ...d.gesture.hits] : d.gesture.base));
      setMarquee(null);
      return;
    }
    if (d.kind === 'rect') {
      setRectDrag(null);
      const r0 = Math.min(d.start[0], d.current[0]), r1 = Math.max(d.start[0], d.current[0]);
      const z0 = Math.min(d.start[1], d.current[1]), z1 = Math.max(d.start[1], d.current[1]);
      if (r1 - r0 >= p.snap && z1 - z0 >= p.snap) {
        addShape(d.ellipse ? ellipsePath((r0 + r1) / 2, (z0 + z1) / 2, (r1 - r0) / 2, (z1 - z0) / 2) : [{ p: [r0, z0] }, { p: [r1, z0] }, { p: [r1, z1] }, { p: [r0, z1] }]);
      }
      p.onToolDone();
      return;
    }
    if (d.kind === 'pen' || d.kind === 'pan') return;
    p.onChange(p.scene, true);
  };

  const onPointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    setPanning(false);
    setMarquee(null);
    setRectDrag(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d && !['pan', 'pen', 'rect', 'marquee'].includes(d.kind)) p.onChange(p.scene, true);
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!p.editable || p.tool !== 'select' || p.selection?.kind !== 'shape') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const v = viewRef.current;
    const [xm, zm] = toMm(e.clientX - rect.left, e.clientY - rect.top, v);
    const cur: Pt = [Math.abs(xm), zm];
    const idx = p.selection.index;
    if (bandOf(p.scene.shapes[idx])) return; // bands have no anchors to edit
    const nodes = cloneNodes(nodesOf(idx));
    const tol = HANDLE_PX / v.s;
    // Double-click an anchor: toggle corner <-> smooth.
    for (let k = 0; k < nodes.length; k++) {
      if (Math.hypot(nodes[k].p[0] - cur[0], nodes[k].p[1] - cur[1]) <= tol) {
        nodes[k] = nodes[k].hIn || nodes[k].hOut ? cornerNode(nodes[k]) : smoothNode(nodes, k);
        writeNodes(idx, nodes, true);
        p.onSelect({ kind: 'shape', index: idx, vertex: k, side: xm < 0 ? -1 : 1 });
        return;
      }
    }
    // Double-click a segment: insert an anchor without changing the curve.
    const hit = nearestOnPath(nodes, cur);
    if (hit.dist <= tol) {
      const a = nodes[hit.seg], b = nodes[(hit.seg + 1) % nodes.length];
      const { a: na, mid, b: nb } = splitSegment(a, b, hit.t);
      nodes[hit.seg] = na; nodes[(hit.seg + 1) % nodes.length] = nb;
      if (segmentIsLine(a, b)) mid.p = [snapR(mid.p[0]), snapV(mid.p[1])];
      nodes.splice(hit.seg + 1, 0, mid);
      writeNodes(idx, nodes, true);
      p.onSelect({ kind: 'shape', index: idx, vertex: hit.seg + 1, side: xm < 0 ? -1 : 1 });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (e.key === 'Escape') { setPenNodes([]); if (p.tool !== 'select') p.onToolDone(); else p.onSelect(null); return; }
    if (e.key === 'Enter' && p.tool === 'pen') { finishPen(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && p.editable && p.selection) {
      e.preventDefault();
      const sel = p.selection;
      if (sel.kind === 'shape') {
        const nodes = cloneNodes(nodesOf(sel.index));
        if (sel.vertex !== undefined && sel.handle) {
          const n = nodes[sel.vertex];
          if (sel.handle === 'in') delete n.hIn; else delete n.hOut;
          writeNodes(sel.index, nodes, true);
          p.onSelect({ kind: 'shape', index: sel.index, vertex: sel.vertex });
        } else if (sel.vertex !== undefined && nodes.length > 3) {
          nodes.splice(sel.vertex, 1);
          writeNodes(sel.index, nodes, true);
          p.onSelect({ kind: 'shape', index: sel.index });
        } else {
          p.onChange({ ...p.scene, shapes: p.scene.shapes.filter((_, i) => i !== sel.index) }, true);
          p.onSelect(null);
        }
      } else if (sel.kind === 'shapes') {
        const selected = new Set(sel.indices);
        p.onChange({ ...p.scene, shapes: p.scene.shapes.filter((_, i) => !selected.has(i)) }, true);
        p.onSelect(null);
      } else if (sel.kind === 'driver') {
        p.onChange({ ...p.scene, drivers: p.scene.drivers.filter((_, i) => i !== sel.index) }, true);
        p.onSelect(null);
      }
    }
  };

  // ---- drawing ------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w <= 0 || size.h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(size.w * dpr));
    canvas.height = Math.max(1, Math.round(size.h * dpr));
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = view;
    const scene = p.scene;
    const T = readCanvasTheme();
    const SELECT_COLOR = T.select, ERROR_COLOR = T.error;
    const P = (r: number, z: number) => toPx(r, z, v);

    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, size.w, size.h);

    const dom = scene.domain;
    const [dx0, dy0] = P(-dom.rMax, dom.zMax), [dx1, dy1] = P(dom.rMax, dom.zMin);
    ctx.fillStyle = T.domain;
    ctx.fillRect(dx0, dy0, dx1 - dx0, dy1 - dy0);

    if (fieldImage) {
      const g = fieldImage.grid;
      const [fx, fy] = P(-(g.Nr - 1) * g.dx, g.zMin + (g.Nz - 1) * g.dx);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(fieldImage.canvas, fx, fy, (2 * g.Nr - 2) * g.dx * v.s, (g.Nz - 1) * g.dx * v.s);
    }

    const sp = p.spongeMm;
    ctx.fillStyle = T.sponge;
    const [sx0, sy0] = P(-dom.rMax + sp, dom.zMax - sp), [sx1, sy1] = P(dom.rMax - sp, dom.zMin + sp);
    ctx.beginPath();
    ctx.rect(dx0, dy0, dx1 - dx0, dy1 - dy0);
    ctx.rect(sx0, sy0, sx1 - sx0, sy1 - sy0);
    ctx.fill('evenodd');
    ctx.strokeStyle = T.domainLine; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.strokeRect(dx0, dy0, dx1 - dx0, dy1 - dy0);

    ctx.strokeStyle = T.axis; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(P(0, dom.zMin)[0], dy0); ctx.lineTo(P(0, dom.zMin)[0], dy1); ctx.stroke();
    ctx.setLineDash([]);

    // Ground plane.
    if (scene.floor?.enabled) {
      const [, fy] = P(0, scene.floor.z);
      const yBottom = Math.min(dy1, size.h + 10), yTop = Math.max(fy, dy0);
      ctx.fillStyle = T.floor;
      ctx.fillRect(dx0, yTop, dx1 - dx0, Math.max(0, yBottom - yTop));
      ctx.save(); ctx.beginPath(); ctx.rect(dx0, yTop, dx1 - dx0, Math.max(0, yBottom - yTop)); ctx.clip();
      ctx.strokeStyle = T.floor; ctx.lineWidth = 1;
      for (let x = dx0 - 40; x < dx1 + 40; x += 14) { ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x - 30, yTop + 30); ctx.stroke(); }
      ctx.restore();
      ctx.strokeStyle = T.floorLine; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(dx0, fy); ctx.lineTo(dx1, fy); ctx.stroke();
      ctx.fillStyle = T.floorLine; ctx.font = '11px "SF Pro KR", sans-serif';
      ctx.fillText(`바닥 z = ${scene.floor.z}`, dx0 + 6, fy - 5);
    }

    // Path drawing helper: true Bézier segments, optionally mirrored.
    const pathNodes = (g: CanvasRenderingContext2D, nodes: PathNode[], mirror: boolean) => {
      const m = mirror ? -1 : 1;
      g.beginPath();
      nodes.forEach((n, i) => {
        const [x, y] = P(m * n.p[0], n.p[1]);
        if (i === 0) { g.moveTo(x, y); return; }
        const prev = nodes[i - 1];
        if (segmentIsLine(prev, n)) g.lineTo(x, y);
        else {
          const c1 = prev.hOut ?? prev.p, c2 = n.hIn ?? n.p;
          const [x1, y1] = P(m * c1[0], c1[1]), [x2, y2] = P(m * c2[0], c2[1]);
          g.bezierCurveTo(x1, y1, x2, y2, x, y);
        }
      });
      const last = nodes[nodes.length - 1], first = nodes[0];
      if (last && first) {
        const [x, y] = P(m * first.p[0], first.p[1]);
        if (segmentIsLine(last, first)) g.lineTo(x, y);
        else {
          const c1 = last.hOut ?? last.p, c2 = first.hIn ?? first.p;
          const [x1, y1] = P(m * c1[0], c1[1]), [x2, y2] = P(m * c2[0], c2[1]);
          g.bezierCurveTo(x1, y1, x2, y2, x, y);
        }
      }
      g.closePath();
    };

    if (!layerRef.current) layerRef.current = document.createElement('canvas');
    const layer = layerRef.current;
    layer.width = Math.max(1, Math.round(size.w * dpr));
    layer.height = Math.max(1, Math.round(size.h * dpr));
    const L = layer.getContext('2d')!;
    L.setTransform(dpr, 0, 0, dpr, 0, 0);
    const themeKey = p.themeKey ?? 'dark';
    if (!hatchRef.current || hatchRef.current.key !== themeKey) hatchRef.current = { key: themeKey, pattern: makeHatch(T) };
    const hatch = hatchRef.current.pattern;

    const shapeNodes = scene.shapes.map((s) => shapeToPath(s).nodes);
    const order = scene.shapes.map((s, i) => ({ s, i })).sort((a, b) => {
      const rank = (x: typeof a) => (x.s.material === 'air' ? 2 : x.s.material === 'fabric' ? 1 : 0);
      return rank(a) - rank(b);
    });
    for (const { s, i } of order) {
      const role = roleOf(s);
      const style = roleStyle(T, role);
      for (const mirror of [false, true]) {
        pathNodes(L, shapeNodes[i], mirror);
        if (s.material === 'air') {
          L.save(); L.globalCompositeOperation = 'destination-out'; L.fillStyle = '#000'; L.fill(); L.restore();
          L.fillStyle = T.slotFill; L.fill();
          L.strokeStyle = T.slotStroke; L.lineWidth = 1.25; L.setLineDash([4, 3]); L.stroke(); L.setLineDash([]);
        } else {
          L.fillStyle = s.material === 'fabric' ? (hatch ?? T.fabricFill) : style.fill;
          L.fill();
          L.strokeStyle = style.stroke; L.lineWidth = 1; L.stroke();
        }
      }
    }
    ctx.drawImage(layer, 0, 0, size.w, size.h);

    if (maskImage) {
      const g = maskImage.grid;
      const [fx, fy] = P(-(g.Nr - 1) * g.dx, g.zMin + (g.Nz - 1) * g.dx);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(maskImage.canvas, fx - g.dx * v.s / 2, fy - g.dx * v.s / 2, (2 * g.Nr - 1) * g.dx * v.s, g.Nz * g.dx * v.s);
    }

    // Drivers.
    scene.drivers.forEach((d) => {
      const { a, b, dir } = driverSegment(d);
      for (const m of [1, -1]) {
        const [ax, ay] = P(m * a[0], a[1]), [bx, by] = P(m * b[0], b[1]);
        const back: Pt = [-dir[0] * 2, -dir[1] * 2];
        const [cx, cy] = P(m * (a[0] + back[0]), a[1] + back[1]), [ex, ey] = P(m * (b[0] + back[0]), b[1] + back[1]);
        ctx.fillStyle = T.driverSoft;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(ex, ey); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = T.driver; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        const n = Math.max(1, Math.floor(Math.hypot(bx - ax, by - ay) / 26));
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) / n;
          const r = a[0] + t * (b[0] - a[0]), z = a[1] + t * (b[1] - a[1]);
          const [x0, y0] = P(m * r, z), [x1, y1] = P(m * (r + dir[0] * 4), z + dir[1] * 4);
          const ang = Math.atan2(y1 - y0, x1 - x0);
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - 6 * Math.cos(ang - 0.5), y1 - 6 * Math.sin(ang - 0.5));
          ctx.lineTo(x1 - 6 * Math.cos(ang + 0.5), y1 - 6 * Math.sin(ang + 0.5));
          ctx.closePath(); ctx.fillStyle = T.driver; ctx.fill();
        }
      }
    });

    // Measurement arc.
    {
      const m = scene.measure;
      const angleMax = m.angleMax ?? 180;
      const [cx, cy] = P(0, m.zCenter);
      const R = m.radius * v.s;
      ctx.strokeStyle = T.measure; ctx.lineWidth = 1.25; ctx.setLineDash([6, 5]);
      const a0 = -Math.PI / 2, a1 = -Math.PI / 2 + (angleMax * Math.PI) / 180;
      ctx.beginPath(); ctx.arc(cx, cy, R, a0, a1); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, R, -a1 - Math.PI, -a0 - Math.PI, true); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = T.measure;
      for (let a = 0; a <= angleMax + 1e-9; a += m.angleStep) {
        const th = (a * Math.PI) / 180;
        for (const mm of [1, -1]) {
          const [x, y] = P(mm * m.radius * Math.sin(th), m.zCenter + m.radius * Math.cos(th));
          ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.beginPath(); ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6); ctx.stroke();
    }

    // Diagnostics.
    for (const d of p.diagnostics.filter((x) => x.severity === 'error')) {
      ctx.strokeStyle = ERROR_COLOR; ctx.lineWidth = 2.5; ctx.setLineDash([5, 3]);
      if (d.target?.kind === 'shape' && scene.shapes[d.target.index]) {
        for (const mirror of [false, true]) { pathNodes(ctx, shapeNodes[d.target.index], mirror); ctx.stroke(); }
      } else if (d.target?.kind === 'driver' && scene.drivers[d.target.index]) {
        const { a, b } = driverSegment(scene.drivers[d.target.index]);
        for (const m of [1, -1]) { const [ax, ay] = P(m * a[0], a[1]), [bx, by] = P(m * b[0], b[1]); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); }
      } else if (d.target?.kind === 'measure') {
        const m = scene.measure; const [cx, cy] = P(0, m.zCenter);
        ctx.beginPath(); ctx.arc(cx, cy, m.radius * v.s, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.setLineDash([]);
      if (d.point) {
        for (const m of [1, -1]) {
          const [x, y] = P(m * d.point[0], d.point[1]);
          ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = ERROR_COLOR; ctx.fill();
          ctx.strokeStyle = T.handleFill; ctx.lineWidth = 2; ctx.stroke();
          ctx.fillStyle = T.handleFill; ctx.font = '700 10px "SF Pro KR", sans-serif'; ctx.fillText('!', x - 2, y + 4);
        }
      }
    }

    // Selection: outline, anchors, handles.
    const sel = p.selection;
    const square = (r: number, z: number, filled: boolean) => {
      for (const m of [1, -1]) {
        const [x, y] = P(m * r, z);
        ctx.beginPath(); ctx.rect(x - 4.5, y - 4.5, 9, 9);
        ctx.fillStyle = filled ? SELECT_COLOR : T.handleFill; ctx.fill();
        ctx.strokeStyle = SELECT_COLOR; ctx.lineWidth = 1.5; ctx.stroke();
      }
    };
    const circle = (r: number, z: number, filled: boolean) => {
      for (const m of [1, -1]) {
        const [x, y] = P(m * r, z);
        ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = filled ? SELECT_COLOR : T.handleFill; ctx.fill();
        ctx.strokeStyle = SELECT_COLOR; ctx.lineWidth = 1.5; ctx.stroke();
      }
    };
    const handleLine = (from: Pt, to: Pt) => {
      for (const m of [1, -1]) {
        const [x0, y0] = P(m * from[0], from[1]), [x1, y1] = P(m * to[0], to[1]);
        ctx.strokeStyle = SELECT_COLOR; ctx.globalAlpha = 0.75; ctx.lineWidth = 1.25;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    };
    const groupedIndices = marquee
      ? [...new Set([...marquee.base, ...marquee.hits])].filter((index) => !!scene.shapes[index])
      : sel?.kind === 'shapes' ? sel.indices.filter((index) => !!scene.shapes[index]) : null;
    const selBand = sel?.kind === 'shape' && scene.shapes[sel.index] ? bandOf(scene.shapes[sel.index]) : null;
    if (groupedIndices) {
      ctx.save();
      ctx.strokeStyle = SELECT_COLOR; ctx.lineWidth = 2; ctx.setLineDash([]);
      for (const index of groupedIndices) {
        for (const mirror of [false, true]) { pathNodes(ctx, shapeNodes[index], mirror); ctx.stroke(); }
      }
      ctx.restore();
    } else if (sel?.kind === 'shape' && selBand) {
      const nodes = shapeNodes[sel.index];
      ctx.strokeStyle = SELECT_COLOR; ctx.lineWidth = 2;
      for (const mirror of [false, true]) { pathNodes(ctx, nodes, mirror); ctx.stroke(); }
      // Two bar handles at the start and end of the band (across its width).
      ctx.fillStyle = T.handleFill; ctx.strokeStyle = SELECT_COLOR; ctx.lineWidth = 1.5;
      if (selBand.axis === 'z') {
        const rc = (selBand.r0 + selBand.r1) / 2, halfW = Math.max((selBand.r1 - selBand.r0) / 2, 2);
        for (const zz of [selBand.z0, selBand.z1]) for (const m of [1, -1]) {
          const [x0, y] = P(m * (rc - halfW), zz), [x1] = P(m * (rc + halfW), zz);
          ctx.beginPath(); ctx.rect(Math.min(x0, x1) - 3, y - 3, Math.abs(x1 - x0) + 6, 6); ctx.fill(); ctx.stroke();
        }
      } else {
        const zc = (selBand.z0 + selBand.z1) / 2, halfH = Math.max((selBand.z1 - selBand.z0) / 2, 2);
        for (const rr of [selBand.r0, selBand.r1]) for (const m of [1, -1]) {
          const [x, y0] = P(m * rr, zc + halfH), [, y1] = P(m * rr, zc - halfH);
          ctx.beginPath(); ctx.rect(x - 3, Math.min(y0, y1) - 3, 6, Math.abs(y1 - y0) + 6); ctx.fill(); ctx.stroke();
        }
      }
      const [lx, ly] = P(selBand.r1 + 3, selBand.axis === 'z' ? (selBand.z0 + selBand.z1) / 2 : selBand.z1 + 2);
      ctx.fillStyle = SELECT_COLOR; ctx.font = '11px "JetBrainsMono", monospace';
      ctx.fillText(selBand.axis === 'z'
        ? `z ${selBand.z0} → ${selBand.z1}  (${(selBand.z1 - selBand.z0).toFixed(1)} mm)`
        : `r ${selBand.r0} → ${selBand.r1}  (${(selBand.r1 - selBand.r0).toFixed(1)} mm)`, lx, ly + 4);
    } else if (sel?.kind === 'shape' && scene.shapes[sel.index]) {
      const nodes = shapeNodes[sel.index];
      ctx.strokeStyle = SELECT_COLOR; ctx.lineWidth = 2;
      for (const mirror of [false, true]) { pathNodes(ctx, nodes, mirror); ctx.stroke(); }
      if (sel.vertex !== undefined && nodes[sel.vertex]) {
        const n = nodes.length, vi = sel.vertex;
        const show: { node: number; which: 'in' | 'out' }[] = [
          { node: vi, which: 'in' }, { node: vi, which: 'out' },
          { node: (vi + n - 1) % n, which: 'out' }, { node: (vi + 1) % n, which: 'in' },
        ];
        for (const s of show) {
          const nd = nodes[s.node];
          const h = s.which === 'in' ? nd.hIn : nd.hOut;
          if (!h) continue;
          handleLine(nd.p, h);
          circle(h[0], h[1], s.node === vi && sel.handle === s.which);
        }
      }
      nodes.forEach((nd, k) => square(nd.p[0], nd.p[1], sel.vertex === k && !sel.handle));
    } else if (sel?.kind === 'driver' && scene.drivers[sel.index]) {
      const { a, b } = driverSegment(scene.drivers[sel.index]);
      square(a[0], a[1], false); square(b[0], b[1], false);
    } else if (sel?.kind === 'measure') {
      const m = scene.measure;
      square(0, m.zCenter + m.radius, false); square(0, m.zCenter, true);
    }

    if (marquee) {
      const left = Math.min(marquee.startPx[0], marquee.currentPx[0]);
      const top = Math.min(marquee.startPx[1], marquee.currentPx[1]);
      const width = Math.abs(marquee.currentPx[0] - marquee.startPx[0]);
      const height = Math.abs(marquee.currentPx[1] - marquee.startPx[1]);
      ctx.save();
      ctx.fillStyle = T.selectSoft;
      ctx.fillRect(left, top, width, height);
      ctx.strokeStyle = SELECT_COLOR; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.strokeRect(left + 0.5, top + 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
      ctx.restore();
    }

    // Pen preview.
    if (p.tool === 'pen' && penNodes.length > 0) {
      ctx.strokeStyle = SELECT_COLOR; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      const preview: PathNode[] = mouseMm ? [...penNodes, { p: [snapR(mouseMm[0]), snapV(mouseMm[1])] }] : penNodes;
      ctx.beginPath();
      preview.forEach((n, i) => {
        const [x, y] = P(n.p[0], n.p[1]);
        if (i === 0) { ctx.moveTo(x, y); return; }
        const prev = preview[i - 1];
        if (segmentIsLine(prev, n)) ctx.lineTo(x, y);
        else { const c1 = prev.hOut ?? prev.p, c2 = n.hIn ?? n.p; const [x1, y1] = P(c1[0], c1[1]), [x2, y2] = P(c2[0], c2[1]); ctx.bezierCurveTo(x1, y1, x2, y2, x, y); }
      });
      ctx.stroke(); ctx.setLineDash([]);
      penNodes.forEach((n, i) => {
        square(n.p[0], n.p[1], i === 0);
        if (n.hOut) { handleLine(n.p, n.hOut); circle(n.hOut[0], n.hOut[1], false); }
        if (n.hIn) { handleLine(n.p, n.hIn); circle(n.hIn[0], n.hIn[1], false); }
      });
    }
    if (rectDrag) {
      const [x0, y0] = P(rectDrag.start[0], rectDrag.start[1]), [x1, y1] = P(rectDrag.current[0], rectDrag.current[1]);
      ctx.strokeStyle = SELECT_COLOR; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5;
      if (rectDrag.ellipse) { ctx.beginPath(); ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2); ctx.stroke(); }
      else ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.setLineDash([]);
    }

  }, [p.scene, p.selection, p.diagnostics, p.tool, p.spongeMm, p.themeKey, view, size, fieldImage, maskImage, penNodes, mouseMm, rectDrag, marquee, toPx, snapR, snapV]);

  // Debug hook for automated UI checks: mm -> canvas px mapping and the scene being drawn.
  useEffect(() => {
    (window as unknown as { __sectionCanvas?: unknown }).__sectionCanvas = {
      toPx: (r: number, z: number) => toPx(r, z, view), scene: p.scene, selection: p.selection, canvas: canvasRef.current,
    };
  }, [view, p.scene, p.selection, toPx]);

  const cursor = panning ? 'grabbing' : p.tool !== 'select' || marquee ? 'crosshair' : 'default';
  const scaleBarMm = view.s > 12 ? 5 : view.s > 4 ? 10 : view.s > 1.2 ? 50 : 100;

  const anchorPopover = (() => {
    const sel = p.selection;
    if (!p.editable || sel?.kind !== 'shape' || sel.vertex === undefined || bandOf(p.scene.shapes[sel.index])) return null;
    const path = shapeToPath(p.scene.shapes[sel.index]);
    const node = path.nodes[sel.vertex];
    if (!node) return null;
    const side = sel.side ?? 1;
    const [px, py] = toPx(side * node.p[0], node.p[1]);
    const popoverWidth = 214, popoverHeight = 142, popoverGap = 18;
    const nodeCount = path.nodes.length;
    const previous = path.nodes[(sel.vertex + nodeCount - 1) % nodeCount];
    const next = path.nodes[(sel.vertex + 1) % nodeCount];
    const protectedPoints = [node.p, node.hIn, node.hOut, previous?.hOut, next?.hIn]
      .filter((point): point is Pt => !!point)
      .map((point) => toPx(side * point[0], point[1]));
    const protectedRect = {
      left: Math.min(...protectedPoints.map((point) => point[0])) - 16,
      right: Math.max(...protectedPoints.map((point) => point[0])) + 16,
      top: Math.min(...protectedPoints.map((point) => point[1])) - 16,
      bottom: Math.max(...protectedPoints.map((point) => point[1])) + 16,
    };
    type PopoverPlacement = 'above' | 'below' | 'outward' | 'inward';
    const candidates: { placement: PopoverPlacement; left: number; top: number }[] = [
      { placement: 'above', left: px - popoverWidth / 2, top: protectedRect.top - popoverHeight - popoverGap },
      { placement: 'below', left: px - popoverWidth / 2, top: protectedRect.bottom + popoverGap },
      { placement: 'outward', left: side > 0 ? protectedRect.right + popoverGap : protectedRect.left - popoverWidth - popoverGap, top: py - popoverHeight / 2 },
      { placement: 'inward', left: side > 0 ? protectedRect.left - popoverWidth - popoverGap : protectedRect.right + popoverGap, top: py - popoverHeight / 2 },
    ];
    const maxLeft = Math.max(12, size.w - popoverWidth - 12);
    const maxTop = Math.max(72, size.h - popoverHeight - 70);
    const fittedCandidates = candidates.map((candidate, priority) => {
      const left = Math.max(12, Math.min(maxLeft, candidate.left));
      const top = Math.max(72, Math.min(maxTop, candidate.top));
      const overlapWidth = Math.max(0, Math.min(left + popoverWidth, protectedRect.right) - Math.max(left, protectedRect.left));
      const overlapHeight = Math.max(0, Math.min(top + popoverHeight, protectedRect.bottom) - Math.max(top, protectedRect.top));
      return { ...candidate, left, top, score: overlapWidth * overlapHeight + priority * 0.01 };
    });
    const { left, top, placement } = fittedCandidates.sort((a, b) => a.score - b.score)[0];
    const curved = !!(node.hIn || node.hOut);
    const writeAnchor = (axis: 0 | 1, value: number) => {
      if (!Number.isFinite(value)) return;
      const shapes = p.scene.shapes.slice();
      const next = shapeToPath(shapes[sel.index]);
      next.nodes = cloneNodes(next.nodes);
      const current = next.nodes[sel.vertex!];
      const delta: Pt = axis === 0 ? [Math.max(0, value) - current.p[0], 0] : [0, value - current.p[1]];
      next.nodes[sel.vertex!] = translateNode(current, delta[0], delta[1]);
      shapes[sel.index] = next;
      p.onChange({ ...p.scene, shapes }, true);
    };
    const setCurved = (nextCurved: boolean) => {
      if (nextCurved === curved) return;
      const shapes = p.scene.shapes.slice();
      const next = shapeToPath(shapes[sel.index]);
      next.nodes = cloneNodes(next.nodes);
      next.nodes[sel.vertex!] = nextCurved ? smoothNode(next.nodes, sel.vertex!) : cornerNode(next.nodes[sel.vertex!]);
      shapes[sel.index] = next;
      p.onChange({ ...p.scene, shapes }, true);
    };
    return (
      <div className={`anchor-popover place-${placement} ${side > 0 ? 'side-right' : 'side-left'}`} role="dialog" aria-label={`앵커 ${sel.vertex + 1} 편집`} style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="anchor-popover-head"><strong>앵커 {sel.vertex + 1}</strong><span>{curved ? '곡선' : '코너'}</span></div>
        <div className="anchor-coordinates">
          <label>r<input aria-label="앵커 r" type="number" step="0.1" value={node.p[0]} onChange={(e) => writeAnchor(0, +e.target.value)} /></label>
          <label>z<input aria-label="앵커 z" type="number" step="0.1" value={node.p[1]} onChange={(e) => writeAnchor(1, +e.target.value)} /></label>
        </div>
        <div className="anchor-type-toggle" aria-label="앵커 유형">
          <button className={!curved ? 'active' : ''} onClick={() => setCurved(false)}>코너</button>
          <button className={curved ? 'active' : ''} onClick={() => setCurved(true)}>곡선</button>
        </div>
      </div>
    );
  })();

  return (
    <div ref={wrapRef} className="section-wrap">
      <canvas
        ref={canvasRef}
        className="section-canvas"
        style={{ width: size.w, height: size.h, cursor }}
        tabIndex={0}
        title="빈 공간 드래그: 영역 선택 · 가운데 버튼 드래그: 화면 이동"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => { if (!dragRef.current) setMouseMm(null); }}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      />
      {anchorPopover}
      <div className="canvas-readout canvas-scale numeric" aria-hidden="true">
        <span>{scaleBarMm} mm</span>
        <i className="canvas-scale-line" style={{ width: Math.max(38, scaleBarMm * view.s) }} />
      </div>
      {mouseMm && (
        <div className="canvas-readout canvas-coordinates numeric" aria-label={`포인터 좌표 r ${mouseMm[0].toFixed(1)}, z ${mouseMm[1].toFixed(1)} 밀리미터`}>
          <span>r</span><b>{mouseMm[0].toFixed(1)}</b><span>z</span><b>{mouseMm[1].toFixed(1)}</b><span>mm</span>
        </div>
      )}
    </div>
  );
});
