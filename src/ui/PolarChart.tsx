import { useEffect, useRef } from 'react';
import type { SimResult } from '../engine/analysis';
import { nearestBin } from '../engine/analysis';

export interface PolarSeries {
  result: SimResult;
  color: string;
  label: string;
}

interface Props {
  series: PolarSeries[];
  freq: number;
  /** dB range shown from the outer ring (0 dB) to the centre. */
  range?: number;
  /** 'each' normalises every series to its own maximum; 'shared' keeps relative levels. */
  normalize?: 'each' | 'shared';
}

/** Full 360° polar plot (mirrored r-z half-plane). 0° = +z (up). */
export function PolarChart({ series, freq, range = 30, normalize = 'each' }: Props) {
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

    ctx.strokeStyle = 'rgba(29,32,30,0.11)'; ctx.lineWidth = 1; ctx.fillStyle = '#777b76'; ctx.font = '10px "JetBrains Mono", monospace';
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
    if (series.length === 0) return;

    // Raw dB per series at the requested frequency.
    const curves = series.map((s) => {
      const k = nearestBin(s.result.freqs, freq);
      const nF = s.result.freqs.length;
      const db = new Float32Array(s.result.angles.length);
      let max = -Infinity;
      for (let a = 0; a < db.length; a++) { db[a] = s.result.db[a * nF + k]; if (db[a] > max) max = db[a]; }
      return { s, db, max };
    });
    const sharedMax = Math.max(...curves.map((c) => c.max));

    const toXY = (angDeg: number, v: number) => {
      const rr = R * Math.max(0, 1 + v / range);
      const t = (angDeg * Math.PI) / 180;
      return [cx + rr * Math.sin(t), cy - rr * Math.cos(t)];
    };

    curves.forEach(({ s, db, max }, idx) => {
      const ref0 = normalize === 'each' ? max : sharedMax;
      const angles = s.result.angles;
      ctx.strokeStyle = s.color; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let k = 0; k < angles.length; k++) {
        const [x, y] = toXY(angles[k], db[k] - ref0);
        k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      for (let k = angles.length - 1; k >= 0; k--) {
        const [x, y] = toXY(-angles[k], db[k] - ref0);
        ctx.lineTo(x, y);
      }
      ctx.closePath(); ctx.stroke();
      if (series.length === 1) { ctx.fillStyle = 'rgba(255,101,71,0.11)'; ctx.fill(); }
      if (s.label) {
        ctx.fillStyle = s.color;
        ctx.fillText(s.label, 4, 12 + idx * 12);
      }
    });
  }, [series, freq, range, normalize]);

  return <canvas ref={ref} className="chart-canvas" />;
}
