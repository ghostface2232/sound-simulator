import { useEffect, useRef, useState } from 'react';
import type { SimResult } from '../engine/analysis';
import { responseAt } from '../engine/analysis';
import { readCanvasTheme } from './theme';

export interface ResponseSeries {
  result: SimResult;
  /** Probe angle (deg from +z). */
  angle: number;
  color: string;
  label: string;
}

interface Props {
  series: ResponseSeries[];
  fMin?: number;
  fMax?: number;
  themeKey?: string;
}

export const SERIES_COLORS = ['#ff7a45', '#f5b53f', '#3fc7dd', '#4c8dff', '#a879ff', '#ff5c9e', '#7ccb5a', '#c99a6e'];

/** Frequency response (dB vs log f) for one or more series, with a hover readout. */
export function ResponseChart({ series, fMin = 200, fMax = 20000, themeKey }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);

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

      const L = 30, Rm = 8, Tp = 8, B = 18;
      const W = rect.width - L - Rm, H = rect.height - Tp - B;
      const lf0 = Math.log10(fMin), lf1 = Math.log10(fMax);
      const lx = (f: number) => L + (W * (Math.log10(f) - lf0)) / (lf1 - lf0);
      const fx = (x: number) => 10 ** (lf0 + ((x - L) / W) * (lf1 - lf0));

      let yMax = -Infinity, yMin = Infinity;
      const lines = series.map((s) => {
        const ys = responseAt(s.result, s.angle);
        for (let i = 0; i < ys.length; i++) {
          const f = s.result.freqs[i];
          if (f < fMin || f > fMax) continue;
          if (ys[i] > yMax) yMax = ys[i];
          if (ys[i] < yMin) yMin = ys[i];
        }
        return { s, ys };
      });
      if (!isFinite(yMax)) { yMax = 0; yMin = -40; }
      yMax = Math.ceil(yMax / 10) * 10 + 5;
      yMin = Math.max(yMax - 60, Math.floor(yMin / 10) * 10 - 5);
      const ly = (v: number) => Tp + (H * (yMax - v)) / (yMax - yMin);

      ctx.font = '9.5px "JetBrainsMono", monospace'; ctx.lineWidth = 1; ctx.textBaseline = 'middle';
      ctx.strokeStyle = T.chartGrid; ctx.fillStyle = T.chartText;
      ctx.textAlign = 'center';
      for (const f of [100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
        if (f < fMin || f > fMax) continue;
        ctx.beginPath(); ctx.moveTo(lx(f), Tp); ctx.lineTo(lx(f), Tp + H); ctx.stroke();
        ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, lx(f), Tp + H + 9);
      }
      ctx.textAlign = 'right';
      for (let v = yMin; v <= yMax; v += 10) {
        ctx.beginPath(); ctx.moveTo(L, ly(v)); ctx.lineTo(L + W, ly(v)); ctx.stroke();
        ctx.fillText(`${v}`, L - 5, ly(v));
      }

      lines.forEach(({ s, ys }) => {
        ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < ys.length; i++) {
          const f = s.result.freqs[i];
          if (f < fMin || f > fMax) continue;
          const x = lx(f), y = ly(ys[i]);
          started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          started = true;
        }
        ctx.stroke();
      });

      // Hover readout: vertical cursor plus one value per series.
      if (hoverX !== null && lines.length > 0 && hoverX >= L && hoverX <= L + W) {
        const f = fx(hoverX);
        ctx.strokeStyle = T.axis; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(hoverX, Tp); ctx.lineTo(hoverX, Tp + H); ctx.stroke(); ctx.setLineDash([]);
        const rows = lines.map(({ s, ys }) => {
          let k = 0, best = Infinity;
          for (let i = 0; i < s.result.freqs.length; i++) { const d = Math.abs(s.result.freqs[i] - f); if (d < best) { best = d; k = i; } }
          ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(lx(s.result.freqs[k]), ly(ys[k]), 2.5, 0, Math.PI * 2); ctx.fill();
          return { color: s.color, label: s.label, v: ys[k] };
        });
        const boxW = 96, lineH = 13, boxH = 8 + lineH * (rows.length + 1);
        const bx = hoverX + 10 + boxW > L + W ? hoverX - 10 - boxW : hoverX + 10;
        const by = Tp + 4;
        ctx.fillStyle = T.bg; ctx.globalAlpha = 0.92; ctx.beginPath(); ctx.roundRect(bx, by, boxW, boxH, 5); ctx.fill(); ctx.globalAlpha = 1;
        ctx.strokeStyle = T.domainLine; ctx.stroke();
        ctx.textAlign = 'left'; ctx.fillStyle = T.text; ctx.font = '600 9.5px "JetBrainsMono", monospace';
        ctx.fillText(f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${Math.round(f)} Hz`, bx + 7, by + 4 + lineH / 2);
        ctx.font = '9.5px "JetBrainsMono", monospace';
        rows.forEach((r, i) => {
          const y = by + 4 + lineH * (i + 1) + lineH / 2;
          ctx.fillStyle = r.color; ctx.beginPath(); ctx.arc(bx + 10, y, 2.5, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = T.chartText; ctx.fillText(r.label.slice(0, 7), bx + 17, y);
          ctx.textAlign = 'right'; ctx.fillStyle = T.text; ctx.fillText(`${r.v.toFixed(1)}`, bx + boxW - 7, y); ctx.textAlign = 'left';
        });
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [series, fMin, fMax, themeKey, hoverX]);

  return (
    <canvas ref={ref} className="chart-canvas"
      onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHoverX(e.clientX - r.left); }}
      onPointerLeave={() => setHoverX(null)} />
  );
}
