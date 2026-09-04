import { useEffect, useRef } from 'react';
import type { SimResult } from '../engine/analysis';
import { sliceAtFrequency } from '../engine/analysis';
import { readCanvasTheme } from './theme';

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
  themeKey?: string;
}

/** Full 360° polar plot (mirrored r-z half-plane). 0° = +z (up). */
export function PolarChart({ series, freq, range = 30, normalize = 'each', themeKey }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;
      canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const T = readCanvasTheme();

      const cx = rect.width / 2, cy = rect.height / 2;
      const R = Math.min(cx, cy) - 16;

      ctx.lineWidth = 1; ctx.font = '9.5px "JetBrainsMono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let d = 0; d <= range; d += 10) {
        const rr = R * (1 - d / range);
        ctx.strokeStyle = d === 0 ? T.axis : T.chartGrid;
        ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
        if (d > 0 && d < range) { ctx.fillStyle = T.chartText; ctx.fillText(`-${d}`, cx + 11, cy - rr + 6); }
      }
      ctx.strokeStyle = T.chartGrid;
      for (let a = 0; a < 360; a += 30) {
        const t = (a * Math.PI) / 180;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + R * Math.sin(t), cy - R * Math.cos(t)); ctx.stroke();
        if (a <= 180) {
          ctx.fillStyle = a % 90 === 0 ? T.text : T.chartText;
          ctx.fillText(`${a}°`, cx + (R + 9) * Math.sin(t), cy - (R + 9) * Math.cos(t));
        }
      }
      if (series.length === 0) return;

      const curves = series.map((s) => {
        const db = sliceAtFrequency(s.result, freq);
        let max = -Infinity;
        for (let a = 0; a < db.length; a++) if (db[a] > max) max = db[a];
        return { s, db, max };
      });
      const sharedMax = Math.max(...curves.map((c) => c.max));
      const toXY = (angDeg: number, v: number) => {
        const rr = R * Math.max(0, 1 + v / range);
        const t = (angDeg * Math.PI) / 180;
        return [cx + rr * Math.sin(t), cy - rr * Math.cos(t)];
      };

      curves.forEach(({ s, db, max }) => {
        const ref0 = normalize === 'each' ? max : sharedMax;
        const angles = s.result.angles;
        ctx.strokeStyle = s.color; ctx.lineWidth = 1.75; ctx.lineJoin = 'round';
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
        ctx.globalAlpha = series.length === 1 ? 0.14 : 0.06; ctx.fillStyle = s.color; ctx.fill(); ctx.globalAlpha = 1;
      });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [series, freq, range, normalize, themeKey]);

  return <canvas ref={ref} className="chart-canvas" />;
}
