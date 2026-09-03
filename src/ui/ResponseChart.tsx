import { useEffect, useRef } from 'react';
import type { SimResult } from '../engine/analysis';
import { responseAt } from '../engine/analysis';

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
}

export const SERIES_COLORS = ['#d33', '#e58a1f', '#2a9d8f', '#3a6fd8', '#7b3fbf', '#b5179e', '#6a994e', '#7f5539'];

/** Frequency response (dB vs log f) for one or more series. */
export function ResponseChart({ series, fMin = 200, fMax = 20000 }: Props) {
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

    const L = 36, Rm = 10, T = 10, B = 24;
    const W = rect.width - L - Rm, H = rect.height - T - B;
    const lx = (f: number) => L + (W * (Math.log10(f) - Math.log10(fMin))) / (Math.log10(fMax) - Math.log10(fMin));

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
    const ly = (v: number) => T + (H * (yMax - v)) / (yMax - yMin);

    ctx.strokeStyle = '#ddd'; ctx.fillStyle = '#666'; ctx.font = '10px system-ui'; ctx.lineWidth = 1;
    for (const f of [200, 500, 1000, 2000, 5000, 10000, 20000]) {
      if (f < fMin || f > fMax) continue;
      ctx.beginPath(); ctx.moveTo(lx(f), T); ctx.lineTo(lx(f), T + H); ctx.stroke();
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, lx(f) - 8, T + H + 14);
    }
    for (let v = yMin; v <= yMax; v += 10) {
      ctx.beginPath(); ctx.moveTo(L, ly(v)); ctx.lineTo(L + W, ly(v)); ctx.stroke();
      ctx.fillText(`${v}`, 4, ly(v) + 3);
    }

    lines.forEach(({ s, ys }, k) => {
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.5;
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
      ctx.fillStyle = s.color;
      ctx.fillText(s.label, L + W - 60, T + 12 + k * 12);
    });
  }, [series, fMin, fMax]);

  return <canvas ref={ref} className="chart-canvas" />;
}
