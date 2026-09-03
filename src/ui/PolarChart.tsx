import { useEffect, useRef } from 'react';
import type { SimResult } from '../engine/analysis';
import { polarAt } from '../engine/analysis';

interface Props {
  result: SimResult | null;
  freq: number;
  /** dB range shown from the outer ring (0 dB) to the centre. */
  range?: number;
}

/** Full 360° polar plot (mirrored r-z half-plane). 0° = +z (up). */
export function PolarChart({ result, freq, range = 30 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const cx = rect.width / 2, cy = rect.height / 2;
    const R = Math.min(cx, cy) - 22;

    ctx.strokeStyle = '#ccc'; ctx.lineWidth = 1; ctx.fillStyle = '#666'; ctx.font = '10px system-ui';
    for (let d = 0; d <= range; d += 10) {
      const rr = R * (1 - d / range);
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.fillText(`-${d}`, cx + 3, cy - rr - 2);
    }
    for (let a = 0; a < 360; a += 30) {
      const t = (a * Math.PI) / 180;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + R * Math.sin(t), cy - R * Math.cos(t)); ctx.stroke();
      ctx.fillText(`${a}°`, cx + (R + 8) * Math.sin(t) - 8, cy - (R + 8) * Math.cos(t) + 4);
    }

    if (!result) return;
    const { angles, db } = polarAt(result, freq);
    const toXY = (angDeg: number, v: number) => {
      const rr = R * Math.max(0, 1 + v / range);
      const t = (angDeg * Math.PI) / 180;
      return [cx + rr * Math.sin(t), cy - rr * Math.cos(t)];
    };
    ctx.strokeStyle = '#d33'; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let k = 0; k < angles.length; k++) {
      const [x, y] = toXY(angles[k], db[k]);
      k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    for (let k = angles.length - 1; k >= 0; k--) {
      const [x, y] = toXY(-angles[k], db[k]);
      ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.stroke();
    ctx.fillStyle = 'rgba(221,51,51,0.12)'; ctx.fill();
  }, [result, freq, range]);

  return <canvas ref={ref} className="chart-canvas" />;
}
