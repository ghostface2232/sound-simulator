import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_PARAMS, type Scene, type SimParams } from './engine/scene';
import { PRESETS } from './engine/presets';
import type { SimResult } from './engine/analysis';
import type { WorkerIn, WorkerOut } from './worker/sim.worker';
import { FieldView, type GridInfo } from './ui/FieldView';
import { PolarChart } from './ui/PolarChart';
import { ResponseChart } from './ui/ResponseChart';

type Status = 'idle' | 'running' | 'done' | 'error';

export default function App() {
  const [presetKey, setPresetKey] = useState<string>('side-radial');
  const [sceneText, setSceneText] = useState<string>(() => JSON.stringify(PRESETS['side-radial'](), null, 2));
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [params, setParams] = useState<SimParams>(DEFAULT_PARAMS);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState<string>('');
  const [grid, setGrid] = useState<GridInfo | null>(null);
  const [frame, setFrame] = useState<Float32Array | null>(null);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<SimResult | null>(null);
  const [polarFreq, setPolarFreq] = useState(5000);
  const [colorScale, setColorScale] = useState(0.05);

  const workerRef = useRef<Worker | null>(null);
  const peakRef = useRef(0);

  useEffect(() => {
    const w = new Worker(new URL('./worker/sim.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      switch (m.type) {
        case 'grid':
          setGrid({ Nr: m.Nr, Nz: m.Nz, dx: m.dx, zMin: m.zMin, solid: m.solid, sigma: m.sigma, probes: m.probes });
          setFrame(null); peakRef.current = 0;
          break;
        case 'frame': {
          let mx = 0;
          for (let i = 0; i < m.p.length; i += 7) { const v = Math.abs(m.p[i]); if (v > mx) mx = v; }
          peakRef.current = Math.max(mx, peakRef.current * 0.97);
          setColorScale(Math.max(peakRef.current * 0.6, 1e-6));
          setFrame(m.p); setProgress(m.step / m.nSteps);
          break;
        }
        case 'done':
          setResult({ freqs: m.freqs, angles: m.angles, db: m.db, dt: m.dt, nSteps: m.nSteps });
          setStatus('done'); setProgress(1);
          setMessage(`완료: ${m.nSteps} 스텝, ${(m.elapsedMs / 1000).toFixed(1)} s`);
          break;
        case 'stopped':
          setStatus('idle'); setMessage('중단됨');
          break;
        case 'error':
          setStatus('error'); setMessage(m.message);
          break;
      }
    };
    workerRef.current = w;
    return () => w.terminate();
  }, []);

  const parsedScene = useMemo<Scene | null>(() => {
    try {
      const s = JSON.parse(sceneText) as Scene;
      setSceneError(null);
      return s;
    } catch (err) {
      setSceneError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [sceneText]);

  const loadPreset = useCallback((key: string) => {
    setPresetKey(key);
    setSceneText(JSON.stringify(PRESETS[key](), null, 2));
    setResult(null); setFrame(null); setGrid(null);
  }, []);

  const run = useCallback(() => {
    if (!parsedScene || !workerRef.current) return;
    setStatus('running'); setMessage(''); setResult(null); setProgress(0);
    const msg: WorkerIn = { type: 'run', scene: parsedScene, params, frameEvery: 25 };
    workerRef.current.postMessage(msg);
  }, [parsedScene, params]);

  const stop = useCallback(() => {
    workerRef.current?.postMessage({ type: 'stop' } satisfies WorkerIn);
  }, []);

  const cells = grid ? grid.Nr * grid.Nz : 0;

  return (
    <div className="app">
      <aside className="panel left">
        <h1>Speaker Sim <span className="sub">axisymmetric FDTD</span></h1>

        <label>프리셋
          <select value={presetKey} onChange={(e) => loadPreset(e.target.value)}>
            {Object.keys(PRESETS).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        {parsedScene?.description && <p className="desc">{parsedScene.description}</p>}

        <div className="grid2">
          <label>dx (mm)
            <input type="number" step="0.25" min="0.25" max="4" value={params.dx}
              onChange={(e) => setParams({ ...params, dx: +e.target.value })} />
          </label>
          <label>시간 (ms)
            <input type="number" step="1" min="1" max="40" value={params.durationMs}
              onChange={(e) => setParams({ ...params, durationMs: +e.target.value })} />
          </label>
          <label>fMax (Hz)
            <input type="number" step="1000" min="2000" max="40000" value={params.fMax}
              onChange={(e) => setParams({ ...params, fMax: +e.target.value })} />
          </label>
          <label>흡수층 (cells)
            <input type="number" step="10" min="10" max="150" value={params.spongeCells}
              onChange={(e) => setParams({ ...params, spongeCells: +e.target.value })} />
          </label>
        </div>

        <div className="row">
          <button className="primary" onClick={run} disabled={status === 'running' || !parsedScene}>실행</button>
          <button onClick={stop} disabled={status !== 'running'}>중단</button>
        </div>
        <div className="progress"><div style={{ width: `${progress * 100}%` }} /></div>
        <p className="status">
          {status === 'running' ? `계산 중 ${(progress * 100).toFixed(0)}%` : message}
          {cells > 0 && <span className="muted"> · {grid!.Nr}×{grid!.Nz} = {cells.toLocaleString()} cells</span>}
        </p>

        <label className="grow">씬 JSON (mm, r-z 단면)
          <textarea value={sceneText} onChange={(e) => setSceneText(e.target.value)} spellCheck={false} />
        </label>
        {sceneError && <p className="error">{sceneError}</p>}
      </aside>

      <main className="center">
        <FieldView grid={grid} frame={frame} scale={colorScale} />
      </main>

      <aside className="panel right">
        <h2>지향성 <span className="sub">{polarFreq >= 1000 ? `${polarFreq / 1000} kHz` : `${polarFreq} Hz`}</span></h2>
        <input type="range" min={Math.log10(200)} max={Math.log10(params.fMax)} step={0.01}
          value={Math.log10(polarFreq)}
          onChange={(e) => setPolarFreq(Math.round(10 ** +e.target.value / 50) * 50)} />
        <div className="chart polar"><PolarChart result={result} freq={polarFreq} /></div>

        <h2>주파수 응답 <span className="sub">dB, 상대값</span></h2>
        <div className="chart response"><ResponseChart result={result} angles={[0, 45, 90, 135, 180]} fMin={200} fMax={params.fMax} /></div>
        <p className="muted small">
          0° = +z(위), 90° = 측면, 180° = 아래. 절대 SPL은 드라이버 데이터가 있어야 하므로 지금은 상대 dB입니다.
        </p>
      </aside>
    </div>
  );
}
