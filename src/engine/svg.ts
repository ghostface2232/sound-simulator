/**
 * SVG round-trip for the r-z section so shapes can be drawn in Figma /
 * Illustrator (1 user unit = 1 mm) and imported here without losing curves.
 *
 * Mapping: SVG x = r, SVG y = -z (so "up" on the drawing is +z).
 * Roles are carried as data-role attributes and as fill colours; on import a
 * data-role wins, otherwise the fill colour is matched against the palette.
 */
import type { Scene, PathNode, PathShape, ShapeRole } from './scene';
import { shapeToPath, materialForRole, type Pt } from './geometry';

export const ROLE_FILL: Record<ShapeRole, string> = {
  housing: '#3d434c', reflector: '#f28c28', slot: '#22b8cf', fabric: '#d9b97a', driver: '#e8879f', other: '#8a9099',
};

const f = (v: number) => (Math.round(v * 1000) / 1000).toString();

function nodesToD(nodes: PathNode[]): string {
  const parts: string[] = [];
  nodes.forEach((n, i) => {
    if (i === 0) { parts.push(`M ${f(n.p[0])} ${f(-n.p[1])}`); return; }
    const prev = nodes[i - 1];
    if (!prev.hOut && !n.hIn) parts.push(`L ${f(n.p[0])} ${f(-n.p[1])}`);
    else {
      const c1 = prev.hOut ?? prev.p, c2 = n.hIn ?? n.p;
      parts.push(`C ${f(c1[0])} ${f(-c1[1])} ${f(c2[0])} ${f(-c2[1])} ${f(n.p[0])} ${f(-n.p[1])}`);
    }
  });
  const last = nodes[nodes.length - 1], first = nodes[0];
  if (last.hOut || first.hIn) {
    const c1 = last.hOut ?? last.p, c2 = first.hIn ?? first.p;
    parts.push(`C ${f(c1[0])} ${f(-c1[1])} ${f(c2[0])} ${f(-c2[1])} ${f(first.p[0])} ${f(-first.p[1])}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

/** Export the shapes (both halves) plus reference lines. Drivers and the arc go to a locked-looking group. */
export function sceneToSvg(scene: Scene): string {
  const d = scene.domain;
  const paths = scene.shapes.map((s, i) => {
    const p = shapeToPath(s);
    const role = p.role ?? 'housing';
    const fill = ROLE_FILL[role];
    const opacity = s.material === 'air' ? 0.35 : 1;
    const safeLabel = (s.label ?? '').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '');
    const id = safeLabel || `${role}-${i + 1}`;
    return `  <path id="${id}" data-role="${role}" data-material="${s.material}"${s.sigma !== undefined ? ` data-sigma="${s.sigma}"` : ''}${p.axis ? ` data-axis="${p.axis}"` : ''} fill="${fill}" fill-opacity="${opacity}" stroke="none" d="${nodesToD(p.nodes)}"/>`;
  });
  const drivers = scene.drivers.map((dr, i) => {
    const a = dr.kind === 'piston' ? [Math.min(...dr.r), dr.z] : [dr.r, Math.min(...dr.z)];
    const b = dr.kind === 'piston' ? [Math.max(...dr.r), dr.z] : [dr.r, Math.max(...dr.z)];
    return `  <line id="driver-${i + 1}" data-driver="${dr.kind}" data-dir="${dr.dir}" x1="${f(a[0])}" y1="${f(-a[1])}" x2="${f(b[0])}" y2="${f(-b[1])}" stroke="#e0245e" stroke-width="1"/>`;
  });
  const m = scene.measure;
  const header = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(-d.rMax)} ${f(-d.zMax)} ${f(2 * d.rMax)} ${f(d.zMax - d.zMin)}" width="${f(2 * d.rMax)}mm" height="${f(d.zMax - d.zMin)}mm" data-speaker-sim="1">`;
  return [
    header,
    `  <!-- 1 unit = 1 mm. x = r, y = -z. Right half is the editable section; the left half is a mirror for reference. -->`,
    `  <g id="section">`,
    ...paths,
    `  </g>`,
    `  <g id="mirror" transform="scale(-1,1)" opacity="0.25">`,
    ...paths,
    `  </g>`,
    `  <g id="reference">`,
    ...drivers,
    `  <circle id="measure" data-radius="${m.radius}" data-zcenter="${m.zCenter}" cx="0" cy="${f(-m.zCenter)}" r="${f(m.radius)}" fill="none" stroke="#2e9e5b" stroke-width="0.5" stroke-dasharray="3 2"/>`,
    `  <line id="axis" x1="0" y1="${f(-d.zMax)}" x2="0" y2="${f(-d.zMin)}" stroke="#999" stroke-width="0.3" stroke-dasharray="2 2"/>`,
    `  </g>`,
    `</svg>`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Import

type Mat = [number, number, number, number, number, number]; // a b c d e f
const IDENT: Mat = [1, 0, 0, 1, 0, 0];
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function parseTransform(t: string | null): Mat {
  if (!t) return IDENT;
  let m = IDENT;
  const re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(t))) {
    const a = x[2].split(/[\s,]+/).filter(Boolean).map(Number);
    switch (x[1]) {
      case 'matrix': if (a.length === 6) m = mul(m, a as Mat); break;
      case 'translate': m = mul(m, [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]); break;
      case 'scale': m = mul(m, [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]); break;
      case 'rotate': {
        const th = ((a[0] ?? 0) * Math.PI) / 180, cx = a[1] ?? 0, cy = a[2] ?? 0;
        m = mul(m, [1, 0, 0, 1, cx, cy]); m = mul(m, [Math.cos(th), Math.sin(th), -Math.sin(th), Math.cos(th), 0, 0]); m = mul(m, [1, 0, 0, 1, -cx, -cy]);
        break;
      }
    }
  }
  return m;
}

/** Parse one closed subpath from a `d` string into editor nodes (M, L, H, V, C, S, Q, Z; absolute and relative). */
export function parsePathD(d: string, m: Mat = IDENT): PathNode[][] {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const subpaths: PathNode[][] = [];
  let nodes: PathNode[] = [];
  let cmd = '';
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let lastC2: [number, number] | null = null;
  let i = 0;
  const num = () => Number(tokens[i++]);
  const push = (x: number, y: number, hIn?: [number, number]) => {
    const [px, py] = apply(m, x, y);
    const node: PathNode = { p: [px, -py] };
    if (hIn) { const [hx, hy] = apply(m, hIn[0], hIn[1]); node.hIn = [hx, -hy]; }
    nodes.push(node);
  };
  const setOut = (x: number, y: number) => {
    const n = nodes[nodes.length - 1];
    if (n) { const [hx, hy] = apply(m, x, y); n.hOut = [hx, -hy]; }
  };
  const close = () => {
    if (nodes.length >= 3) {
      // A trailing L back to the start would duplicate the first anchor.
      const last = nodes[nodes.length - 1], first = nodes[0];
      if (Math.abs(last.p[0] - first.p[0]) < 1e-6 && Math.abs(last.p[1] - first.p[1]) < 1e-6 && !last.hIn && !first.hOut) nodes.pop();
      else if (Math.abs(last.p[0] - first.p[0]) < 1e-6 && Math.abs(last.p[1] - first.p[1]) < 1e-6 && last.hIn) { first.hIn = last.hIn; nodes.pop(); }
      subpaths.push(nodes);
    }
    nodes = [];
  };
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[a-zA-Z]/.test(t)) { cmd = t; i++; if (cmd === 'Z' || cmd === 'z') { close(); cx = sx; cy = sy; continue; } }
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M': { const x = num(), y = num(); cx = rel ? cx + x : x; cy = rel ? cy + y : y; if (nodes.length) close(); sx = cx; sy = cy; push(cx, cy); lastC2 = null; cmd = rel ? 'l' : 'L'; break; }
      case 'L': { const x = num(), y = num(); cx = rel ? cx + x : x; cy = rel ? cy + y : y; push(cx, cy); lastC2 = null; break; }
      case 'H': { const x = num(); cx = rel ? cx + x : x; push(cx, cy); lastC2 = null; break; }
      case 'V': { const y = num(); cy = rel ? cy + y : y; push(cx, cy); lastC2 = null; break; }
      case 'C': {
        let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
        if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
        setOut(x1, y1); push(x, y, [x2, y2]); cx = x; cy = y; lastC2 = [x2, y2]; break;
      }
      case 'S': {
        let x2 = num(), y2 = num(), x = num(), y = num();
        if (rel) { x2 += cx; y2 += cy; x += cx; y += cy; }
        const x1 = lastC2 ? 2 * cx - lastC2[0] : cx, y1 = lastC2 ? 2 * cy - lastC2[1] : cy;
        setOut(x1, y1); push(x, y, [x2, y2]); cx = x; cy = y; lastC2 = [x2, y2]; break;
      }
      case 'Q': {
        let qx = num(), qy = num(), x = num(), y = num();
        if (rel) { qx += cx; qy += cy; x += cx; y += cy; }
        // Quadratic -> cubic.
        const x1 = cx + (2 / 3) * (qx - cx), y1 = cy + (2 / 3) * (qy - cy);
        const x2 = x + (2 / 3) * (qx - x), y2 = y + (2 / 3) * (qy - y);
        setOut(x1, y1); push(x, y, [x2, y2]); cx = x; cy = y; lastC2 = null; break;
      }
      default: i++; // unsupported command (A, T): skip token
    }
  }
  if (nodes.length) close();
  return subpaths;
}

function roleFromFill(fill: string | null): ShapeRole | null {
  if (!fill) return null;
  const norm = fill.trim().toLowerCase();
  for (const [role, hex] of Object.entries(ROLE_FILL)) if (norm === hex) return role as ShapeRole;
  return null;
}

/** Shapes found in an SVG document. Elements inside a group with id "mirror" or "reference" are ignored. */
export function svgToShapes(svgText: string): PathShape[] {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('SVG 를 해석할 수 없습니다.');
  const out: PathShape[] = [];
  const walk = (el: Element, m: Mat) => {
    const id = el.getAttribute('id');
    if (id === 'mirror' || id === 'reference') return;
    const mm = mul(m, parseTransform(el.getAttribute('transform')));
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('data-role') as ShapeRole | null) ?? roleFromFill(el.getAttribute('fill')) ?? 'housing';
    const material = materialForRole(role);
    const sigmaAttr = el.getAttribute('data-sigma');
    const axisAttr = el.getAttribute('data-axis');
    const meta = { material, role, ...(sigmaAttr ? { sigma: Number(sigmaAttr) } : {}), ...(id ? { label: id } : {}), ...(axisAttr === 'r' || axisAttr === 'z' ? { axis: axisAttr as 'r' | 'z' } : {}) };
    if (tag === 'path') {
      for (const nodes of parsePathD(el.getAttribute('d') ?? '', mm)) out.push({ kind: 'path', nodes, ...meta });
    } else if (tag === 'rect') {
      const x = Number(el.getAttribute('x') ?? 0), y = Number(el.getAttribute('y') ?? 0);
      const w = Number(el.getAttribute('width') ?? 0), h = Number(el.getAttribute('height') ?? 0);
      const corners: [number, number][] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      out.push({ kind: 'path', nodes: corners.map(([px, py]) => { const [ax, ay] = apply(mm, px, py); return { p: [ax, -ay] as Pt }; }), ...meta });
    } else if (tag === 'polygon') {
      const pts = (el.getAttribute('points') ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
      const nodes: PathNode[] = [];
      for (let k = 0; k + 1 < pts.length; k += 2) { const [ax, ay] = apply(mm, pts[k], pts[k + 1]); nodes.push({ p: [ax, -ay] }); }
      if (nodes.length >= 3) out.push({ kind: 'path', nodes, ...meta });
    }
    for (const child of Array.from(el.children)) walk(child, mm);
  };
  walk(doc.documentElement, IDENT);
  // Anything on the left half is the mirror image: fold it onto r >= 0.
  for (const s of out) for (const n of s.nodes) {
    if (n.p[0] < 0) { n.p[0] = -n.p[0]; if (n.hIn) n.hIn[0] = -n.hIn[0]; if (n.hOut) n.hOut[0] = -n.hOut[0]; }
  }
  return out;
}
