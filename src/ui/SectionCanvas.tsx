import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Scene, PolygonShape, Driver, ShapeRole } from '../engine/scene';
import type { Diagnostic } from '../engine/checks';
import { distToSegment, driverSegment, pointInPolygon, sceneBounds, shapeToPolygon, type Pt } from '../engine/geometry';

export interface GridInfo {
  Nr: number; Nz: number; dx: number; zMin: number;
  solid: Uint8Array; sigma: Float32Array;
  probes: { fr: number; fz: number; angleDeg: number }[];
}

export type Selection =
  | { kind: 'shape'; index: number; vertex?: number }
  | { kind: 'driver'; index: number }
  | { kind: 'measure' }
  | null;

export type Tool = 'select' | 'pen' | 'rect';

export interface SectionCanvasHandle {
  fitDevice(): void;
  fitDomain(): void;
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
}

export const ROLE_COLORS: Record<ShapeRole, { fill: string; stroke: string; name: string }> = {
  housing: { fill: '#3d434c', stroke: '#22262c', name: '하우징' },
  reflector: { fill: '#f28c28', stroke: '#b8641a', name: '리플렉터' },
  slot: { fill: 'rgba(34,184,207,0.18)', stroke: '#1798ad', name: '슬롯' },
  fabric: { fill: '#d9b97a', stroke: '#9a7a3a', name: '패브릭' },
  other: { fill: '#8a9099', stroke: '#5c626b', name: '기타' },
};
export const DRIVER_COLOR = '#e0245e';
export const MEASURE_COLOR = '#2e9e5b';
export const SELECT_COLOR = '#2f6fe4';
export const ERROR_COLOR = '#d62828';

interface View { s: number; ox: number; oy: number }

type Drag =
  | { kind: 'vertex'; index: number; vertex: number }
  | { kind: 'shape'; index: number; orig: Pt[]; start: Pt }
  | { kind: 'driverEnd'; index: number; end: 0 | 1 }
  | { kind: 'driver'; index: number; orig: Driver; start: Pt }
  | { kind: 'measureRadius' }
  | { kind: 'measureCenter'; startZ: number; origZ: number }
  | { kind: 'pan'; startPx: [number, number]; origView: View }
  | { kind: 'rect'; start: Pt; current: Pt };

const HANDLE_PX = 7;

function roleOf(s: { role?: ShapeRole; material: string }): ShapeRole {
  return s.role ?? (s.material === 'rigid' ? 'housing' : s.material === 'fabric' ? 'fabric' : 'slot');
}

function makeHatch(): CanvasPattern | null {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 8;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = ROLE_COLORS.fabric.fill; g.fillRect(0, 0, 8, 8);
  g.strokeStyle = 'rgba(90,60,10,0.45)'; g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(-2, 10); g.lineTo(10, -2); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.stroke();
  return g.createPattern(c, 'repeat');
}

export const SectionCanvas = forwardRef<SectionCanvasHandle, Props>(function SectionCanvas(p, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ s: 4, ox: 0, oy: 0 });
  const viewRef = useRef(view); viewRef.current = view;
  const dragRef = useRef<Drag | null>(null);
  const [penPoints, setPenPoints] = useState<Pt[]>([]);
  const [mouseMm, setMouseMm] = useState<Pt | null>(null);
  const [rectDrag, setRectDrag] = useState<{ start: Pt; current: Pt } | null>(null);
  const hatchRef = useRef<CanvasPattern | null>(null);
  const layerRef = useRef<HTMLCanvasElement | null>(null);
  const fittedRef = useRef(false);

  // ---- coordinate helpers -------------------------------------------------
  const toPx = useCallback((r: number, z: number, v: View = viewRef.current): [number, number] => [v.ox + r * v.s, v.oy - z * v.s], []);
  const toMm = useCallback((px: number, py: number, v: View = viewRef.current): Pt => [(px - v.ox) / v.s, (v.oy - py) / v.s], []);
  const snapV = useCallback((v: number) => Math.round(v / p.snap) * p.snap, [p.snap]);
  const snapR = useCallback((r: number) => Math.max(0, snapV(Math.abs(r))), [snapV]);

  const fitBox = useCallback((r0: number, r1: number, z0: number, z1: number, margin: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const w = el.clientWidth, h = el.clientHeight;
    const rr = Math.max(r1, -r0) + margin, zh = z1 - z0 + 2 * margin;
    const s = Math.min(w / (2 * rr), h / zh);
    setView({ s, ox: w / 2, oy: h / 2 + ((z0 + z1) / 2) * s });
  }, []);

  useImperativeHandle(ref, () => ({
    fitDevice: () => { const b = sceneBounds(p.scene); fitBox(-b.r1, b.r1, b.z0, b.z1, Math.max(15, (b.z1 - b.z0) * 0.6)); },
    fitDomain: () => { const d = p.scene.domain; fitBox(-d.rMax, d.rMax, d.zMin, d.zMax, 5); },
  }), [p.scene, fitBox]);

  // Resize tracking.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
      if (!fittedRef.current && el.clientWidth > 0) {
        fittedRef.current = true;
        const b = sceneBounds(p.scene);
        fitBox(-b.r1, b.r1, b.z0, b.z1, Math.max(15, (b.z1 - b.z0) * 0.6));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitBox, p.scene]);

  // Wheel zoom (non-passive so we can prevent page scroll).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const v = viewRef.current;
      const f = Math.exp(-e.deltaY * 0.0015);
      const s = Math.min(60, Math.max(0.3, v.s * f));
      setView({ s, ox: px - (px - v.ox) * (s / v.s), oy: py - (py - v.oy) * (s / v.s) });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ---- field image -----------------------------------------------------------
  const fieldImage = useMemo(() => {
    const { grid, frame, scale } = p.field;
    if (!grid || !frame) return null;
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
        let R = 244, G = 245, B = 247, A = 255;
        if (!solid[c]) {
          let v = Math.max(-1, Math.min(1, frame[c] * inv));
          const m = Math.sign(v) * Math.sqrt(Math.abs(v));
          if (m > 0) { R = 244; G = 245 - 205 * m; B = 247 - 225 * m; }
          else { R = 244 + 215 * m; G = 245 + 150 * m; B = 247; }
        }
        for (const x of [Nr - 1 + i, Nr - 1 - i]) {
          const o = (y * W + x) * 4;
          data[o] = R; data[o + 1] = G; data[o + 2] = B; data[o + 3] = A;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return { canvas: off, grid };
  }, [p.field]);

  const maskImage = useMemo(() => {
    const g = p.gridMask;
    if (!g) return null;
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
        if (solid[c]) { R = 20; G = 24; B = 30; A = 110; }
        else if (sigma[c] > 0) { R = 200; G = 140; B = 40; A = 110; }
        for (const x of [Nr - 1 + i, Nr - 1 - i]) {
          const o = (y * W + x) * 4;
          data[o] = R; data[o + 1] = G; data[o + 2] = B; data[o + 3] = A;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return { canvas: off, grid: g };
  }, [p.gridMask]);

  // ---- hit testing -----------------------------------------------------------
  const hitTest = useCallback((px: number, py: number): { sel: Selection; drag: Drag | null } => {
    const v = viewRef.current;
    const [xm, zm] = toMm(px, py, v);
    const rm = Math.abs(xm);
    const tol = HANDLE_PX / v.s;
    const scene = p.scene;
    const near = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
    const cursor: Pt = [rm, zm];

    // Handles of the selected shape first.
    if (p.selection?.kind === 'shape') {
      const s = scene.shapes[p.selection.index];
      if (s) {
        const pts = shapeToPolygon(s);
        for (let k = 0; k < pts.length; k++) {
          if (near(pts[k], cursor)) return { sel: { kind: 'shape', index: p.selection.index, vertex: k }, drag: { kind: 'vertex', index: p.selection.index, vertex: k } };
        }
      }
    }
    // Driver end handles.
    for (let k = scene.drivers.length - 1; k >= 0; k--) {
      const { a, b } = driverSegment(scene.drivers[k]);
      if (near(a, cursor)) return { sel: { kind: 'driver', index: k }, drag: { kind: 'driverEnd', index: k, end: 0 } };
      if (near(b, cursor)) return { sel: { kind: 'driver', index: k }, drag: { kind: 'driverEnd', index: k, end: 1 } };
    }
    // Measurement handles.
    {
      const m = scene.measure;
      if (near([0, m.zCenter + m.radius], cursor)) return { sel: { kind: 'measure' }, drag: { kind: 'measureRadius' } };
      if (near([0, m.zCenter], cursor)) return { sel: { kind: 'measure' }, drag: { kind: 'measureCenter', startZ: zm, origZ: m.zCenter } };
    }
    // Drivers (segment).
    for (let k = scene.drivers.length - 1; k >= 0; k--) {
      const { a, b } = driverSegment(scene.drivers[k]);
      if (distToSegment(cursor, a, b) <= tol) return { sel: { kind: 'driver', index: k }, drag: { kind: 'driver', index: k, orig: scene.drivers[k], start: cursor } };
    }
    // Shapes: topmost (last drawn) wins; interior or near an edge.
    for (let k = scene.shapes.length - 1; k >= 0; k--) {
      const pts = shapeToPolygon(scene.shapes[k]);
      let hit = pointInPolygon(rm, zm, pts);
      if (!hit) for (let i = 0; i < pts.length && !hit; i++) hit = distToSegment(cursor, pts[i], pts[(i + 1) % pts.length]) <= tol;
      if (hit) return { sel: { kind: 'shape', index: k }, drag: { kind: 'shape', index: k, orig: pts.map((q) => [q[0], q[1]] as Pt), start: cursor } };
    }
    // Measurement arc line.
    {
      const m = scene.measure;
      const d = Math.hypot(rm, zm - m.zCenter);
      if (Math.abs(d - m.radius) <= tol) return { sel: { kind: 'measure' }, drag: { kind: 'measureRadius' } };
    }
    return { sel: null, drag: null };
  }, [p.scene, p.selection, toMm]);

  // ---- editing helpers -------------------------------------------------------
  const updateShape = useCallback((index: number, pts: Pt[], commit: boolean) => {
    const shapes = p.scene.shapes.slice();
    const s = shapes[index];
    const poly: PolygonShape = { ...(s.kind === 'polygon' ? s : { kind: 'polygon', material: s.material, role: s.role, sigma: s.sigma, label: s.label }), kind: 'polygon', points: pts };
    shapes[index] = poly;
    p.onChange({ ...p.scene, shapes }, commit);
  }, [p]);

  const updateDriver = useCallback((index: number, d: Driver, commit: boolean) => {
    const drivers = p.scene.drivers.slice();
    drivers[index] = d;
    p.onChange({ ...p.scene, drivers }, commit);
  }, [p]);

  const finishPen = useCallback(() => {
    if (penPoints.length >= 3) {
      const shape: PolygonShape = { kind: 'polygon', points: penPoints, material: 'rigid', role: 'housing', label: `shape ${p.scene.shapes.length + 1}` };
      p.onChange({ ...p.scene, shapes: [...p.scene.shapes, shape] }, true);
      p.onSelect({ kind: 'shape', index: p.scene.shapes.length });
    }
    setPenPoints([]);
    p.onToolDone();
  }, [penPoints, p]);

  // ---- mouse -------------------------------------------------------------------
  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    e.currentTarget.focus();
    const v = viewRef.current;
    if (e.button === 1 || e.button === 2 || e.altKey) {
      dragRef.current = { kind: 'pan', startPx: [px, py], origView: v };
      return;
    }
    const [xm, zm] = toMm(px, py, v);
    const cur: Pt = [snapR(xm), snapV(zm)];
    if (!p.editable) { dragRef.current = { kind: 'pan', startPx: [px, py], origView: v }; return; }

    if (p.tool === 'pen') {
      if (penPoints.length >= 3 && Math.hypot(penPoints[0][0] - Math.abs(xm), penPoints[0][1] - zm) <= HANDLE_PX / v.s) { finishPen(); return; }
      setPenPoints([...penPoints, cur]);
      return;
    }
    if (p.tool === 'rect') {
      dragRef.current = { kind: 'rect', start: cur, current: cur };
      setRectDrag({ start: cur, current: cur });
      return;
    }
    const { sel, drag } = hitTest(px, py);
    p.onSelect(sel);
    dragRef.current = drag ?? { kind: 'pan', startPx: [px, py], origView: v };
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
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
      case 'vertex': {
        const pts = shapeToPolygon(scene.shapes[d.index]).map((q) => [q[0], q[1]] as Pt);
        pts[d.vertex] = [snapR(xm), snapV(zm)];
        updateShape(d.index, pts, false);
        break;
      }
      case 'shape': {
        const minR = Math.min(...d.orig.map((q) => q[0]));
        const dr = Math.max(-minR, snapV(Math.abs(xm) - d.start[0]));
        const dz = snapV(zm - d.start[1]);
        updateShape(d.index, d.orig.map((q) => [q[0] + dr, q[1] + dz] as Pt), false);
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
        const cur: Pt = [snapR(xm), snapV(zm)];
        d.current = cur;
        setRectDrag({ start: d.start, current: cur });
        break;
      }
    }
  };

  const onMouseUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.kind === 'rect') {
      setRectDrag(null);
      const r0 = Math.min(d.start[0], d.current[0]), r1 = Math.max(d.start[0], d.current[0]);
      const z0 = Math.min(d.start[1], d.current[1]), z1 = Math.max(d.start[1], d.current[1]);
      if (r1 - r0 >= p.snap && z1 - z0 >= p.snap) {
        const shape: PolygonShape = { kind: 'polygon', points: [[r0, z0], [r1, z0], [r1, z1], [r0, z1]], material: 'rigid', role: 'housing', label: `shape ${p.scene.shapes.length + 1}` };
        p.onChange({ ...p.scene, shapes: [...p.scene.shapes, shape] }, true);
        p.onSelect({ kind: 'shape', index: p.scene.shapes.length });
      }
      p.onToolDone();
      return;
    }
    if (d.kind !== 'pan') p.onChange(p.scene, true);
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!p.editable || p.tool !== 'select' || p.selection?.kind !== 'shape') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const v = viewRef.current;
    const [xm, zm] = toMm(e.clientX - rect.left, e.clientY - rect.top, v);
    const cur: Pt = [Math.abs(xm), zm];
    const pts = shapeToPolygon(p.scene.shapes[p.selection.index]).map((q) => [q[0], q[1]] as Pt);
    const tol = HANDLE_PX / v.s;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (distToSegment(cur, a, b) <= tol) {
        pts.splice(i + 1, 0, [snapR(cur[0]), snapV(cur[1])]);
        updateShape(p.selection.index, pts, true);
        p.onSelect({ kind: 'shape', index: p.selection.index, vertex: i + 1 });
        return;
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (e.key === 'Escape') { setPenPoints([]); if (p.tool !== 'select') p.onToolDone(); else p.onSelect(null); return; }
    if (e.key === 'Enter' && p.tool === 'pen') { finishPen(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && p.editable && p.selection) {
      e.preventDefault();
      const sel = p.selection;
      if (sel.kind === 'shape') {
        const pts = shapeToPolygon(p.scene.shapes[sel.index]).map((q) => [q[0], q[1]] as Pt);
        if (sel.vertex !== undefined && pts.length > 3) {
          pts.splice(sel.vertex, 1);
          updateShape(sel.index, pts, true);
          p.onSelect({ kind: 'shape', index: sel.index });
        } else {
          p.onChange({ ...p.scene, shapes: p.scene.shapes.filter((_, i) => i !== sel.index) }, true);
          p.onSelect(null);
        }
      } else if (sel.kind === 'driver') {
        p.onChange({ ...p.scene, drivers: p.scene.drivers.filter((_, i) => i !== sel.index) }, true);
        p.onSelect(null);
      }
    }
  };

  // ---- drawing ------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr; canvas.height = size.h * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = view;
    const scene = p.scene;
    const P = (r: number, z: number) => toPx(r, z, v);

    ctx.fillStyle = '#eef0f3';
    ctx.fillRect(0, 0, size.w, size.h);

    // Domain and sponge.
    const dom = scene.domain;
    const [dx0, dy0] = P(-dom.rMax, dom.zMax), [dx1, dy1] = P(dom.rMax, dom.zMin);
    ctx.fillStyle = '#f6f7f9';
    ctx.fillRect(dx0, dy0, dx1 - dx0, dy1 - dy0);

    // Field.
    if (fieldImage) {
      const g = fieldImage.grid;
      const [fx, fy] = P(-(g.Nr - 1) * g.dx, g.zMin + (g.Nz - 1) * g.dx);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(fieldImage.canvas, fx, fy, (2 * g.Nr - 2) * g.dx * v.s, (g.Nz - 1) * g.dx * v.s);
    }

    // Sponge band (drawn over the field so it reads as "not trusted here").
    const sp = p.spongeMm;
    ctx.fillStyle = 'rgba(120,125,135,0.10)';
    const [sx0, sy0] = P(-dom.rMax + sp, dom.zMax - sp), [sx1, sy1] = P(dom.rMax - sp, dom.zMin + sp);
    ctx.beginPath();
    ctx.rect(dx0, dy0, dx1 - dx0, dy1 - dy0);
    ctx.rect(sx0, sy0, sx1 - sx0, sy1 - sy0);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#c9cdd4'; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.strokeRect(dx0, dy0, dx1 - dx0, dy1 - dy0);

    // Axis.
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(P(0, dom.zMin)[0], dy0); ctx.lineTo(P(0, dom.zMin)[0], dy1); ctx.stroke();
    ctx.setLineDash([]);

    // Geometry layer: solids and fabric, then slots cut through them.
    if (!layerRef.current) layerRef.current = document.createElement('canvas');
    const layer = layerRef.current;
    layer.width = size.w * dpr; layer.height = size.h * dpr;
    const L = layer.getContext('2d')!;
    L.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!hatchRef.current) hatchRef.current = makeHatch();

    const pathPoly = (g: CanvasRenderingContext2D, pts: Pt[], mirror: boolean) => {
      g.beginPath();
      pts.forEach((q, i) => { const [x, y] = P(mirror ? -q[0] : q[0], q[1]); i === 0 ? g.moveTo(x, y) : g.lineTo(x, y); });
      g.closePath();
    };
    const order = scene.shapes.map((s, i) => ({ s, i })).sort((a, b) => {
      const rank = (x: typeof a) => (x.s.material === 'air' ? 2 : x.s.material === 'fabric' ? 1 : 0);
      return rank(a) - rank(b);
    });
    for (const { s } of order) {
      const role = roleOf(s);
      const pts = shapeToPolygon(s);
      for (const mirror of [false, true]) {
        pathPoly(L, pts, mirror);
        if (s.material === 'air') {
          L.save(); L.globalCompositeOperation = 'destination-out'; L.fillStyle = '#000'; L.fill(); L.restore();
          L.fillStyle = ROLE_COLORS.slot.fill; L.fill();
          L.strokeStyle = ROLE_COLORS.slot.stroke; L.lineWidth = 1.5; L.setLineDash([4, 3]); L.stroke(); L.setLineDash([]);
        } else {
          L.fillStyle = s.material === 'fabric' ? (hatchRef.current ?? ROLE_COLORS.fabric.fill) : ROLE_COLORS[role].fill;
          L.fill();
          L.strokeStyle = ROLE_COLORS[role].stroke; L.lineWidth = 1.2; L.stroke();
        }
      }
    }
    ctx.drawImage(layer, 0, 0, size.w, size.h);

    // Solver grid mask.
    if (maskImage) {
      const g = maskImage.grid;
      const [fx, fy] = P(-(g.Nr - 1) * g.dx, g.zMin + (g.Nz - 1) * g.dx);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(maskImage.canvas, fx - g.dx * v.s / 2, fy - g.dx * v.s / 2, (2 * g.Nr - 1) * g.dx * v.s, g.Nz * g.dx * v.s);
    }

    // Drivers.
    scene.drivers.forEach((d) => {
      const { a, b, dir } = driverSegment(d);
      for (const mirror of [false, true]) {
        const m = mirror ? -1 : 1;
        const [ax, ay] = P(m * a[0], a[1]), [bx, by] = P(m * b[0], b[1]);
        // Membrane body (2 mm behind the face).
        const back: Pt = [-dir[0] * 2, -dir[1] * 2];
        const [cx, cy] = P(m * (a[0] + back[0]), a[1] + back[1]), [ex, ey] = P(m * (b[0] + back[0]), b[1] + back[1]);
        ctx.fillStyle = 'rgba(224,36,94,0.25)';
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(ex, ey); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = DRIVER_COLOR; ctx.lineWidth = 3.5;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        // Direction arrows.
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
          ctx.closePath(); ctx.fillStyle = DRIVER_COLOR; ctx.fill();
        }
      }
    });

    // Measurement arc.
    {
      const m = scene.measure;
      const angleMax = m.angleMax ?? 180;
      const [cx, cy] = P(0, m.zCenter);
      const R = m.radius * v.s;
      ctx.strokeStyle = MEASURE_COLOR; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]);
      const a0 = -Math.PI / 2, a1 = -Math.PI / 2 + (angleMax * Math.PI) / 180;
      ctx.beginPath(); ctx.arc(cx, cy, R, a0, a1); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI - a1 - Math.PI, Math.PI - a0 - Math.PI, true); ctx.stroke();
      ctx.setLineDash([]);
      // Probe dots.
      ctx.fillStyle = MEASURE_COLOR;
      for (let a = 0; a <= angleMax + 1e-9; a += m.angleStep) {
        const th = (a * Math.PI) / 180;
        for (const mm of [1, -1]) {
          const [x, y] = P(mm * m.radius * Math.sin(th), m.zCenter + m.radius * Math.cos(th));
          ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.beginPath(); ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6); ctx.stroke();
    }

    // Diagnostics: red outlines and markers.
    const bad = p.diagnostics.filter((d) => d.severity === 'error');
    for (const d of bad) {
      ctx.strokeStyle = ERROR_COLOR; ctx.lineWidth = 2.5; ctx.setLineDash([5, 3]);
      if (d.target?.kind === 'shape' && scene.shapes[d.target.index]) {
        for (const mirror of [false, true]) { pathPoly(ctx, shapeToPolygon(scene.shapes[d.target.index]), mirror); ctx.stroke(); }
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
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
          ctx.fillStyle = '#fff'; ctx.font = 'bold 10px system-ui'; ctx.fillText('!', x - 2, y + 4);
        }
      }
    }

    // Selection.
    const sel = p.selection;
    const handle = (r: number, z: number, filled: boolean) => {
      for (const m of [1, -1]) {
        const [x, y] = P(m * r, z);
        ctx.beginPath(); ctx.rect(x - 4, y - 4, 8, 8);
        ctx.fillStyle = filled ? SELECT_COLOR : '#fff'; ctx.fill();
        ctx.strokeStyle = SELECT_COLOR; ctx.lineWidth = 1.5; ctx.stroke();
      }
    };
    if (sel?.kind === 'shape' && scene.shapes[sel.index]) {
      const pts = shapeToPolygon(scene.shapes[sel.index]);
      ctx.strokeStyle = SELECT_COLOR; ctx.lineWidth = 2;
      for (const mirror of [false, true]) { pathPoly(ctx, pts, mirror); ctx.stroke(); }
      pts.forEach((q, k) => handle(q[0], q[1], sel.vertex === k));
    } else if (sel?.kind === 'driver' && scene.drivers[sel.index]) {
      const { a, b } = driverSegment(scene.drivers[sel.index]);
      handle(a[0], a[1], false); handle(b[0], b[1], false);
    } else if (sel?.kind === 'measure') {
      const m = scene.measure;
      handle(0, m.zCenter + m.radius, false); handle(0, m.zCenter, true);
    }

    // Pen / rect previews.
    if (p.tool === 'pen' && penPoints.length > 0) {
      ctx.strokeStyle = SELECT_COLOR; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.beginPath();
      penPoints.forEach((q, i) => { const [x, y] = P(q[0], q[1]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
      if (mouseMm) { const [x, y] = P(snapR(mouseMm[0]), snapV(mouseMm[1])); ctx.lineTo(x, y); }
      ctx.stroke(); ctx.setLineDash([]);
      penPoints.forEach((q, i) => handle(q[0], q[1], i === 0));
    }
    if (rectDrag) {
      const [x0, y0] = P(rectDrag.start[0], rectDrag.start[1]), [x1, y1] = P(rectDrag.current[0], rectDrag.current[1]);
      ctx.strokeStyle = SELECT_COLOR; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5;
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)); ctx.setLineDash([]);
    }

    // Scale bar and cursor readout.
    const barMm = v.s > 12 ? 5 : v.s > 4 ? 10 : v.s > 1.2 ? 50 : 100;
    ctx.strokeStyle = '#222'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(12, size.h - 14); ctx.lineTo(12 + barMm * v.s, size.h - 14); ctx.stroke();
    ctx.fillStyle = '#222'; ctx.font = '11px system-ui';
    ctx.fillText(`${barMm} mm`, 12, size.h - 18);
    if (mouseMm) ctx.fillText(`r ${mouseMm[0].toFixed(1)}  z ${mouseMm[1].toFixed(1)} mm`, size.w - 150, size.h - 8);
  }, [p.scene, p.selection, p.diagnostics, p.tool, p.spongeMm, view, size, fieldImage, maskImage, penPoints, mouseMm, rectDrag, toPx, snapR, snapV]);

  const cursor = p.tool === 'pen' || p.tool === 'rect' ? 'crosshair' : dragRef.current?.kind === 'pan' ? 'grabbing' : 'default';

  return (
    <div ref={wrapRef} className="section-wrap">
      <canvas
        ref={canvasRef}
        className="section-canvas"
        style={{ width: size.w, height: size.h, cursor }}
        tabIndex={0}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => { if (dragRef.current?.kind === 'pan') dragRef.current = null; setMouseMm(null); }}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="legend">
        {(['housing', 'reflector', 'slot', 'fabric'] as ShapeRole[]).map((r) => (
          <span key={r}><i style={{ background: ROLE_COLORS[r].fill, borderColor: ROLE_COLORS[r].stroke }} />{ROLE_COLORS[r].name}</span>
        ))}
        <span><i style={{ background: DRIVER_COLOR, borderColor: DRIVER_COLOR }} />드라이버</span>
        <span><i style={{ background: 'transparent', borderColor: MEASURE_COLOR, borderStyle: 'dashed' }} />측정 원호</span>
      </div>
    </div>
  );
});
