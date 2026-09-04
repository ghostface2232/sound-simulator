import { useMemo } from 'react';
import type { Scene } from '../engine/scene';
import { driverSegment, sceneBounds, shapeToPolygon } from '../engine/geometry';
import { roleOf } from './SectionCanvas';

interface Props {
  scene: Scene;
  /** CSS size of the thumbnail box. */
  width?: number;
  height?: number;
  className?: string;
}

const ROLE_VAR: Record<string, string> = {
  housing: 'var(--role-housing)', reflector: 'var(--role-reflector)', slot: 'var(--role-slot-line)',
  fabric: 'var(--role-fabric)', driver: 'var(--role-driverbody)', other: 'var(--role-other)',
};

/** Tiny mirrored r-z thumbnail of a scene, rendered as inline SVG (1 unit = 1 mm). */
export function ScenePreview({ scene, width = 72, height = 56, className }: Props) {
  const { paths, drivers, viewBox } = useMemo(() => {
    const b = sceneBounds(scene);
    const pad = Math.max(3, (b.z1 - b.z0) * 0.08);
    const x0 = -b.r1 - pad, x1 = b.r1 + pad, y0 = -b.z1 - pad, y1 = -b.z0 + pad;
    const paths = scene.shapes.map((s, i) => {
      const pts = shapeToPolygon(s);
      const d = (m: number) => pts.map(([r, z], k) => `${k === 0 ? 'M' : 'L'}${(m * r).toFixed(2)} ${(-z).toFixed(2)}`).join(' ') + 'Z';
      const role = roleOf(s);
      return { key: i, d: `${d(1)} ${d(-1)}`, role, air: s.material === 'air' };
    });
    const drivers = scene.drivers.map((dr, i) => { const { a, b: bb } = driverSegment(dr); return { key: i, a, b: bb }; });
    return { paths, drivers, viewBox: `${x0} ${y0} ${x1 - x0} ${y1 - y0}` };
  }, [scene]);

  return (
    <svg className={`scene-preview ${className ?? ''}`} viewBox={viewBox} width={width} height={height} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <line x1="0" y1="-10000" x2="0" y2="10000" stroke="var(--canvas-axis)" strokeWidth="0.4" strokeDasharray="1.5 1.5" vectorEffect="non-scaling-stroke" />
      {paths.map((p) => (
        <path key={p.key} d={p.d} fill={p.air ? 'var(--canvas-domain)' : ROLE_VAR[p.role]} stroke={p.air ? 'var(--role-slot-line)' : 'none'} strokeWidth="0.8" strokeDasharray={p.air ? '1.5 1' : undefined} fillRule="evenodd" vectorEffect="non-scaling-stroke" />
      ))}
      {drivers.map((d) => [1, -1].map((m) => (
        <line key={`${d.key}${m}`} x1={m * d.a[0]} y1={-d.a[1]} x2={m * d.b[0]} y2={-d.b[1]} stroke="var(--role-driver)" strokeWidth="2.2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      )))}
    </svg>
  );
}
