import { useEffect, useRef } from 'react';

export interface GridInfo {
  Nr: number; Nz: number; dx: number; zMin: number;
  solid: Uint8Array; sigma: Float32Array;
  probes: { fr: number; fz: number; angleDeg: number }[];
}

interface Props {
  grid: GridInfo | null;
  frame: Float32Array | null;
  /** Colour scale: pressure value mapped to full red/blue. */
  scale: number;
}

/**
 * Draws the r-z pressure field mirrored about the axis so it reads like a
 * full cross-section. z is up on screen.
 */
export function FieldView({ grid, frame, scale }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufRef = useRef<{ canvas: HTMLCanvasElement; img: ImageData } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !grid) return;
    const { Nr, Nz, solid, sigma } = grid;
    const W = 2 * Nr - 1, H = Nz;

    if (!bufRef.current || bufRef.current.canvas.width !== W || bufRef.current.canvas.height !== H) {
      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      bufRef.current = { canvas: off, img: off.getContext('2d')!.createImageData(W, H) };
    }
    const { canvas: off, img } = bufRef.current;
    const data = img.data;
    const inv = 1 / Math.max(scale, 1e-12);

    for (let j = 0; j < Nz; j++) {
      const y = Nz - 1 - j;
      for (let i = 0; i < Nr; i++) {
        const c = j * Nr + i;
        let R = 245, G = 245, B = 245;
        if (solid[c]) { R = 60; G = 64; B = 72; }
        else {
          if (frame) {
            let v = frame[c] * inv;
            v = Math.max(-1, Math.min(1, v));
            const m = Math.sign(v) * Math.sqrt(Math.abs(v));
            if (m > 0) { R = 245; G = 245 - 200 * m; B = 245 - 220 * m; }
            else { R = 245 + 210 * m; G = 245 + 150 * m; B = 245; }
          }
          if (sigma[c] > 0) { R = (R + 200) / 2; G = (G + 160) / 2; B = (B + 90) / 2; }
        }
        for (const x of [Nr - 1 + i, Nr - 1 - i]) {
          const o = (y * W + x) * 4;
          data[o] = R; data[o + 1] = G; data[o + 2] = B; data[o + 3] = 255;
        }
      }
    }
    off.getContext('2d')!.putImageData(img, 0, 0);

    const ctx = canvas.getContext('2d')!;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = Math.min(rect.width / W, rect.height / H);
    const ox = (rect.width - W * s) / 2, oy = (rect.height - H * s) / 2;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.drawImage(off, ox, oy, W * s, H * s);

    // Measurement arc.
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    grid.probes.forEach((p, k) => {
      const x = ox + (Nr - 1 + p.fr) * s, y = oy + (Nz - 1 - p.fz) * s;
      k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.beginPath();
    grid.probes.forEach((p, k) => {
      const x = ox + (Nr - 1 - p.fr) * s, y = oy + (Nz - 1 - p.fz) * s;
      k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // Scale bar: 20 mm.
    const barPx = (20 / grid.dx) * s;
    ctx.strokeStyle = '#222'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ox + 10, oy + H * s - 12); ctx.lineTo(ox + 10 + barPx, oy + H * s - 12); ctx.stroke();
    ctx.fillStyle = '#222'; ctx.font = '11px system-ui';
    ctx.fillText('20 mm', ox + 10, oy + H * s - 16);
  }, [grid, frame, scale]);

  return <canvas ref={canvasRef} className="field-canvas" />;
}
