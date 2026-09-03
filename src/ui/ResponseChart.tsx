import { useEffect, useRef } from 'react';
import type { SimResult } from '../engine/analysis';
import { responseAt } from '../engine/analysis';

interface Props {
  result: SimResult | null;
  angles: number[];
  fMin?: number;
  fMax?: number;
}

const COLORS = ['#d33', '#e58a1f', '#2a9d8f', '#3a6fd8', '#7b3fbf'];

/** Frequency response (dB vs log f) for several probe angles. */
export function ResponseChart({ result, angles, fMin = 200, fMax = 20000 }: Props) {
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

    // Determine y range from data.
    let yMax = -Infinity, yMin = Infinity;
    const series: { color: string; ys: Float32Array; label: string }[] = [];
    if (result) {
      angles.forEach((a, k) => {
        const ys = responseAt(result, a);
        series.push({ color: COLORS[k % COLORS.length], ys, label: `${a}°` });
        for (let i = 0; i < ys.length; i++) {
          const f = result.freqs[i];
          if (f < fMin || f > fMax) continue;
          if (ys[i] > yMax) yMax = ys[i];
          if (ys[i] < yMin) yMin = ys[i];
        }
      });
    }
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

    if (!result) return;
    series.forEach((s, k) => {
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < s.ys.length; i++) {
        const f = result.freqs[i];
        if (f < fMin || f > fMax) continue;
        const x = lx(f), y = ly(s.ys[i]);
        started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        started = true;
      }
      ctx.stroke();
      ctx.fillStyle = s.color;
      ctx.fillText(s.label, L + W - 30, T + 12 + k * 12);
    });
  }, [result, angles, fMin, fMax]);

  return <canvas ref={ref} className="chart-canvas" />;
}
