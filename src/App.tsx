import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_PARAMS, type Scene, type SimParams } from './engine/scene';
import { PRESETS, pistonBaffleScene } from './engine/presets';
import { diagnose, type ParityReport } from './engine/runner';
import type { SimResult } from './engine/analysis';
import { hasErrors, type Diagnostic } from './engine/checks';
import { normalizeScene } from './engine/geometry';
import { buildGrid } from './engine/rasterize';
import {
  DEFAULT_OPTIMIZE, MODELS, SCENE_MODEL_ID, makeSceneModel,
  type Candidate, type DesignVariable, type OptimizeProgress, type OptimizeSettings, type ParametricModel,
} from './engine/optimize';
import type { WorkerIn, WorkerOut } from './worker/sim.worker';
import { SectionCanvas, type GridInfo, type SectionCanvasHandle, type Selection, type Tool } from './ui/SectionCanvas';
import { ShapePanel } from './ui/ShapePanel';
import { PolarChart, type PolarSeries } from './ui/PolarChart';
import { ResponseChart, SERIES_COLORS, type ResponseSeries } from './ui/ResponseChart';
import { OptimizePanel } from './ui/OptimizePanel';
import { VariantPanel, type Variant } from './ui/VariantPanel';
import { scoreResult, type ObjectiveSettings } from './engine/optimize';

type Status = 'idle' | 'running' | 'done' | 'error';
type Mode = 'sim' | 'opt' | 'cmp';

const VARIANTS_KEY = 'speaker-sim.variants.v1';

function loadVariants(): Variant[] {
  try {
    const raw = localStorage.getItem(VARIANTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as { id: string; name: string; scene: Scene }[];
    return arr.map((v) => ({ id: v.id, name: v.name, scene: normalizeScene(v.scene) }));
  } catch { return []; }
}

function DiagnosticList({ items }: { items: Diagnostic[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="diag">
      {items.map((d, i) => (
        <li key={`${d.code}-${i}`} className={`diag-${d.severity}`}>
          <span className="diag-code">{d.severity === 'error' ? '오류' : d.severity === 'warning' ? '경고' : '정보'}</span>
          {d.message}
        </li>
      ))}
    </ul>
  );
}

const HISTORY_MAX = 100;

export default function App() {
  const [mode, setMode] = useState<Mode>('sim');
  const [presetKey, setPresetKey] = useState<string>('side-radial');
  const [scene, setSceneState] = useState<Scene>(() => normalizeScene(PRESETS['side-radial']()));
  const [params, setParams] = useState<SimParams>(DEFAULT_PARAMS);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState<string>('');
  const [grid, setGrid] = useState<GridInfo | null>(null);
  const [frame, setFrame] = useState<Float32Array | null>(null);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<SimResult | null>(null);
  const [runWarnings, setRunWarnings] = useState<Diagnostic[]>([]);
  const [parity, setParity] = useState<ParityReport | null>(null);
  const [parityBusy, setParityBusy] = useState(false);
  const [polarFreq, setPolarFreq] = useState(5000);
  const [colorScale, setColorScale] = useState(0.05);

  // Editor state.
  const [selection, setSelection] = useState<Selection>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [showGrid, setShowGrid] = useState(false);
  const canvasRef = useRef<SectionCanvasHandle>(null);
  const historyRef = useRef<{ past: Scene[]; future: Scene[]; committed: Scene }>({ past: [], future: [], committed: scene });
  const [historyTick, setHistoryTick] = useState(0);

  // Optimisation state.
  const [modelId, setModelId] = useState<string>(SCENE_MODEL_ID);
  /** Scene the optimisation starts from: captured from the editor when entering the tab or on refresh. */
  const [optBase, setOptBase] = useState<Scene>(scene);
  const model = useMemo<ParametricModel>(() => (modelId === SCENE_MODEL_ID ? makeSceneModel(optBase) : MODELS[modelId]), [modelId, optBase]);
  const [variables, setVariables] = useState<DesignVariable[]>(() => makeSceneModel(scene).variables.map((v) => ({ ...v })));
  const [optSettings, setOptSettings] = useState<OptimizeSettings>(DEFAULT_OPTIMIZE);
  const [optRunning, setOptRunning] = useState(false);
  const [optProgress, setOptProgress] = useState<OptimizeProgress | null>(null);
  const [optElapsed, setOptElapsed] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /** Geometry shown on the canvas while optimising: the candidate being evaluated, then the best one. */
  const [optScene, setOptScene] = useState<Scene | null>(null);

  // Saved variants for side-by-side comparison.
  const [variants, setVariants] = useState<Variant[]>(loadVariants);
  const [cmpRunning, setCmpRunning] = useState(false);
  const [cmpRunningId, setCmpRunningId] = useState<string | null>(null);
  const [cmpSelected, setCmpSelected] = useState<Set<string>>(new Set());
  const [cmpScene, setCmpScene] = useState<Scene | null>(null);
  const variantsRef = useRef(variants); variantsRef.current = variants;

  const workerRef = useRef<Worker | null>(null);
  const modelRef = useRef(model); modelRef.current = model;
  const peakRef = useRef(0);

  /** Scene updates: commit=true records an undo step. */
  const updateScene = useCallback((next: Scene, commit = true) => {
    setSceneState(next);
    if (commit) {
      const h = historyRef.current;
      if (h.committed !== next) {
        h.past.push(h.committed);
        if (h.past.length > HISTORY_MAX) h.past.shift();
        h.future = [];
        h.committed = next;
        setHistoryTick((t) => t + 1);
      }
    }
    setResult(null); setFrame(null); setGrid(null); setRunWarnings([]);
  }, []);
  const resetScene = useCallback((next: Scene) => {
    historyRef.current = { past: [], future: [], committed: next };
    setHistoryTick((t) => t + 1);
    setSceneState(next);
    setSelection(null);
    setResult(null); setFrame(null); setGrid(null); setRunWarnings([]);
  }, []);
  const undo = useCallback(() => {
    const h = historyRef.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future.push(h.committed); h.committed = prev;
    setSceneState(prev); setSelection(null); setHistoryTick((t) => t + 1);
  }, []);
  const redo = useCallback(() => {
    const h = historyRef.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push(h.committed); h.committed = next;
    setSceneState(next); setSelection(null); setHistoryTick((t) => t + 1);
  }, []);
  void historyTick;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if (e.key === 'v' || e.key === 'V') setTool('select');
      else if (e.key === 'p' || e.key === 'P') setTool('pen');
      else if (e.key === 'r' || e.key === 'R') setTool('rect');
      else if (e.key === 'e' || e.key === 'E') setTool('ellipse');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

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
          setResult({ freqs: m.freqs, angles: m.angles, db: m.db, dt: m.dt, nSteps: m.nSteps, fMinReliable: m.fMinReliable });
          setRunWarnings(m.warnings);
          setStatus('done'); setProgress(1);
          setMessage(`완료 (${m.backend.toUpperCase()}): ${m.nSteps} 스텝, ${(m.elapsedMs / 1000).toFixed(1)} s · 표시 대역 ${Math.round(m.fMinReliable)} Hz 이상`);
          break;
        case 'parity-result':
          setParity(m.report); setParityBusy(false);
          break;
        case 'opt-eval':
          setOptScene(normalizeScene(modelRef.current.build(m.candidate.params)));
          break;
        case 'opt-progress':
          setOptProgress(m.progress);
          break;
        case 'opt-done':
          setOptProgress((prev) => ({ done: prev?.total ?? m.ranked.length, total: prev?.total ?? m.ranked.length, best: m.ranked[0] ?? null, ranked: m.ranked }));
          setOptElapsed(m.elapsedMs); setOptRunning(false);
          if (m.ranked[0]) setOptScene(normalizeScene(modelRef.current.build(m.ranked[0].params)));
          setSelected(new Set(m.ranked.filter((c, i) => i === 0 || c.origin === 'baseline').map((c) => c.id)));
          break;
        case 'eval-start': {
          setCmpRunningId(m.id);
          const v = variantsRef.current.find((x) => x.id === m.id);
          if (v) setCmpScene(v.scene);
          break;
        }
        case 'eval-result': {
          const objective = objectiveRef.current;
          setVariants((prev) => prev.map((v) => v.id !== m.id ? v : {
            ...v,
            result: m.result ? { ...m.result } : undefined,
            breakdown: m.result ? scoreResult({ ...m.result }, objective) : undefined,
            warnings: m.warnings, error: m.error, elapsedMs: m.elapsedMs, evaluatedWith: paramsSigRef.current,
          }));
          if (m.result) setCmpSelected((prev) => new Set([...prev, m.id]));
          break;
        }
        case 'eval-done':
          setCmpRunning(false); setCmpRunningId(null);
          break;
        case 'stopped':
          setStatus('idle'); setMessage('중단됨'); setOptRunning(false); setCmpRunning(false); setCmpRunningId(null);
          break;
        case 'error':
          setStatus('error'); setMessage(m.message); setParityBusy(false); setOptRunning(false); setCmpRunning(false);
          break;
      }
    };
    workerRef.current = w;
    return () => w.terminate();
  }, []);

  const diagnostics = useMemo<Diagnostic[]>(() => diagnose(scene, params), [scene, params]);
  const blocked = hasErrors(diagnostics);
  const busy = status === 'running' || optRunning || parityBusy || cmpRunning;

  // Signature of the simulation settings a variant result was computed with.
  const paramsSig = useMemo(() => JSON.stringify({ dx: params.dx, t: params.durationMs, f0: params.fMin, f1: params.fMax, sp: params.spongeCells }), [params]);
  const paramsSigRef = useRef(paramsSig); paramsSigRef.current = paramsSig;
  const objectiveRef = useRef(optSettings.objective); objectiveRef.current = optSettings.objective;

  // Persist variants (scenes only) and re-score them when the objective changes.
  useEffect(() => {
    try { localStorage.setItem(VARIANTS_KEY, JSON.stringify(variants.map((v) => ({ id: v.id, name: v.name, scene: v.scene })))); } catch { /* storage unavailable */ }
  }, [variants]);
  useEffect(() => {
    setVariants((prev) => prev.map((v) => (v.result ? { ...v, breakdown: scoreResult(v.result, optSettings.objective) } : v)));
  }, [optSettings.objective]);

  const saveVariant = useCallback(() => {
    const id = `v${Date.now().toString(36)}`;
    setVariants((prev) => [...prev, { id, name: `안 ${prev.length + 1}`, scene }]);
    setCmpScene(scene);
  }, [scene]);
  const evaluateVariants = useCallback((ids?: string[]) => {
    if (!workerRef.current) return;
    const items = variantsRef.current.filter((v) => !ids || ids.includes(v.id)).map((v) => ({ id: v.id, scene: v.scene }));
    if (items.length === 0) return;
    setCmpRunning(true); setMessage(''); setResult(null); setFrame(null); setGrid(null);
    workerRef.current.postMessage({ type: 'evaluate', items, params } satisfies WorkerIn);
  }, [params]);
  const loadVariant = useCallback((v: Variant) => { resetScene(normalizeScene(v.scene)); setOptBase(v.scene); setMode('sim'); setTimeout(() => canvasRef.current?.fitDevice(), 0); }, [resetScene]);
  const updateVariantFromEditor = useCallback((v: Variant) => {
    setVariants((prev) => prev.map((x) => x.id === v.id ? { id: x.id, name: x.name, scene } : x));
    setCmpScene(scene);
  }, [scene]);
  const renameVariant = useCallback((v: Variant, name: string) => setVariants((prev) => prev.map((x) => x.id === v.id ? { ...x, name } : x)), []);
  const deleteVariant = useCallback((v: Variant) => { setVariants((prev) => prev.filter((x) => x.id !== v.id)); setCmpSelected((prev) => { const n = new Set(prev); n.delete(v.id); return n; }); }, []);
  const toggleCmp = useCallback((id: string) => setCmpSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  const setObjective = useCallback((o: ObjectiveSettings) => setOptSettings((s) => ({ ...s, objective: o })), []);

  // "What the solver sees": rasterised mask at the current dx (only when requested).
  const gridMask = useMemo<GridInfo | null>(() => {
    if (!showGrid || blocked) return null;
    try {
      const g = buildGrid(scene, params.dx);
      return { Nr: g.Nr, Nz: g.Nz, dx: g.dx, zMin: g.zMin, solid: g.solid, sigma: g.sigma, probes: g.probes };
    } catch { return null; }
  }, [showGrid, blocked, scene, params.dx]);

  const loadPreset = useCallback((key: string) => {
    setPresetKey(key);
    resetScene(normalizeScene(PRESETS[key]()));
    setTimeout(() => canvasRef.current?.fitDevice(), 0);
  }, [resetScene]);

  const run = useCallback(() => {
    if (blocked || !workerRef.current) return;
    setStatus('running'); setMessage(''); setResult(null); setProgress(0); setRunWarnings([]);
    const msg: WorkerIn = { type: 'run', scene, params, frameEvery: 25 };
    workerRef.current.postMessage(msg);
  }, [blocked, scene, params]);

  const runParity = useCallback(() => {
    if (!workerRef.current) return;
    setParity(null); setParityBusy(true);
    const msg: WorkerIn = { type: 'parity', scene: pistonBaffleScene(20, 320, 150), params: { ...params, dx: 2, durationMs: 3, fMax: 10000, spongeCells: 50 } };
    workerRef.current.postMessage(msg);
  }, [params]);

  const stop = useCallback(() => {
    workerRef.current?.postMessage({ type: 'stop' } satisfies WorkerIn);
  }, []);

  /** Rebuild the variable table from a model, keeping ranges the user already edited for matching keys. */
  const adoptVariables = useCallback((m: ParametricModel) => {
    setVariables((prev) => m.variables.map((v) => {
      const old = prev.find((o) => o.key === v.key);
      return old ? { ...v, min: old.min, max: old.max, enabled: old.enabled } : { ...v };
    }));
  }, []);

  const changeModel = useCallback((id: string) => {
    setModelId(id);
    const m = id === SCENE_MODEL_ID ? makeSceneModel(scene) : MODELS[id];
    if (id === SCENE_MODEL_ID) setOptBase(scene);
    setVariables(m.variables.map((v) => ({ ...v })));
    setOptSettings((s) => ({ ...s, explore: id === SCENE_MODEL_ID ? 'local' : 'global' }));
    setOptProgress(null); setSelected(new Set()); setOptElapsed(null); setOptScene(null);
  }, [scene]);

  /** Take the editor scene as the new optimisation baseline. */
  const refreshBase = useCallback(() => {
    setOptBase(scene);
    if (modelId === SCENE_MODEL_ID) adoptVariables(makeSceneModel(scene));
    setOptProgress(null); setSelected(new Set()); setOptElapsed(null); setOptScene(null);
  }, [scene, modelId, adoptVariables]);

  const enterMode = useCallback((m: Mode) => {
    if (m === 'opt' && !optRunning && scene !== optBase) refreshBase();
    setMode(m);
  }, [optRunning, scene, optBase, refreshBase]);

  const startOptimize = useCallback(() => {
    if (!workerRef.current) return;
    setOptRunning(true); setOptProgress(null); setOptElapsed(null); setSelected(new Set()); setMessage('');
    setResult(null); setFrame(null); setGrid(null);
    const msg: WorkerIn = {
      type: 'optimize', modelId: model.id, baseScene: model.id === SCENE_MODEL_ID ? optBase : undefined,
      variables, settings: optSettings, backend: params.backend ?? 'auto',
    };
    workerRef.current.postMessage(msg);
  }, [model, optBase, variables, optSettings, params.backend]);

  const previewCandidate = useCallback((c: Candidate) => {
    setOptScene(normalizeScene(model.build(c.params)));
  }, [model]);

  const toggleSelected = useCallback((id: number) => {
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }, []);

  const applyCandidate = useCallback((c: Candidate) => {
    const s = normalizeScene(model.build(c.params));
    s.description = `${(s.description ?? '').replace(/ \[최적화 후보[^\]]*\]/g, '')} [최적화 후보 #${c.id}, 점수 ${c.score.toFixed(2)}]`;
    if (model.id !== SCENE_MODEL_ID) setPresetKey('side-radial');
    resetScene(s);
    // The applied candidate becomes the next baseline, so edit -> optimise -> apply can be repeated.
    setOptBase(s);
    setMode('sim');
    setTimeout(() => canvasRef.current?.fitDevice(), 0);
  }, [model, resetScene]);

  const setNum = (key: keyof SimParams) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setParams({ ...params, [key]: +e.target.value });

  const rankedTop = optProgress?.ranked ?? [];
  const compared = rankedTop.filter((c) => selected.has(c.id) && c.result);
  const colorFor = useCallback((id: number) => {
    const i = compared.findIndex((c) => c.id === id);
    return i < 0 ? null : SERIES_COLORS[i % SERIES_COLORS.length];
  }, [compared]);
  const comparedVariants = variants.filter((v) => cmpSelected.has(v.id) && v.result);
  const colorForVariant = useCallback((id: string) => {
    const i = comparedVariants.findIndex((v) => v.id === id);
    return i < 0 ? null : SERIES_COLORS[i % SERIES_COLORS.length];
  }, [comparedVariants]);

  const sideAngle = optSettings.objective.sideAngle;
  const polarSeries: PolarSeries[] = mode === 'sim'
    ? (result ? [{ result, color: '#d33', label: '' }] : [])
    : mode === 'opt'
      ? compared.map((c, i) => ({ result: c.result!, color: SERIES_COLORS[i % SERIES_COLORS.length], label: `#${c.id} ${c.score.toFixed(2)}` }))
      : comparedVariants.map((v, i) => ({ result: v.result!, color: SERIES_COLORS[i % SERIES_COLORS.length], label: `${v.name} ${v.breakdown ? v.breakdown.score.toFixed(2) : ''}` }));
  const responseSeries: ResponseSeries[] = mode === 'sim'
    ? (result ? [0, 45, 90, 135, 180].map((a, i) => ({ result, angle: a, color: SERIES_COLORS[i], label: `${a}°` })) : [])
    : mode === 'opt'
      ? compared.map((c, i) => ({ result: c.result!, angle: sideAngle, color: SERIES_COLORS[i % SERIES_COLORS.length], label: `#${c.id}` }))
      : comparedVariants.map((v, i) => ({ result: v.result!, angle: sideAngle, color: SERIES_COLORS[i % SERIES_COLORS.length], label: v.name }));

  const cells = grid ? grid.Nr * grid.Nz : 0;
  const chartFMin = mode === 'sim' ? (result ? result.freqs[0] : params.fMin)
    : mode === 'opt' ? (compared[0]?.result?.freqs[0] ?? optSettings.fMin)
      : (comparedVariants[0]?.result?.freqs[0] ?? params.fMin);
  const chartFMax = mode === 'opt' ? optSettings.fMax : params.fMax;
  const h = historyRef.current;

  return (
    <div className="app">
      <aside className="panel left">
        <h1>Speaker Sim <span className="sub">axisymmetric FDTD</span></h1>
        <div className="modes">
          <button className={mode === 'sim' ? 'active' : ''} onClick={() => enterMode('sim')}>시뮬레이션</button>
          <button className={mode === 'opt' ? 'active' : ''} onClick={() => enterMode('opt')}>리플렉터 최적화</button>
          <button className={mode === 'cmp' ? 'active' : ''} onClick={() => enterMode('cmp')}>형상 비교</button>
        </div>

        {mode === 'sim' ? (
          <>
            <label>프리셋
              <select value={presetKey} onChange={(e) => loadPreset(e.target.value)}>
                {Object.keys(PRESETS).map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            {scene.description && <p className="desc">{scene.description}</p>}

            <ShapePanel
              scene={scene} onChange={(s) => updateScene(s, true)}
              selection={selection} onSelect={setSelection}
              tool={tool} setTool={setTool}
              showGrid={showGrid} setShowGrid={setShowGrid}
              onFitDevice={() => canvasRef.current?.fitDevice()} onFitDomain={() => canvasRef.current?.fitDomain()}
              onUndo={undo} onRedo={redo} canUndo={h.past.length > 0} canRedo={h.future.length > 0}
              editable={!busy}
            />

            <div className="grid2">
              <label>dx (mm)
                <input type="number" step="0.25" min="0.25" max="4" value={params.dx} onChange={setNum('dx')} />
              </label>
              <label>시간 (ms)
                <input type="number" step="1" min="1" max="40" value={params.durationMs} onChange={setNum('durationMs')} />
              </label>
              <label>fMin (Hz)
                <input type="number" step="50" min="20" max="5000" value={params.fMin} onChange={setNum('fMin')} />
              </label>
              <label>fMax (Hz)
                <input type="number" step="1000" min="2000" max="40000" value={params.fMax} onChange={setNum('fMax')} />
              </label>
              <label>흡수층 (cells)
                <input type="number" step="10" min="10" max="150" value={params.spongeCells} onChange={setNum('spongeCells')} />
              </label>
              <label>백엔드
                <select value={params.backend ?? 'auto'} onChange={(e) => setParams({ ...params, backend: e.target.value as SimParams['backend'] })}>
                  <option value="auto">auto (WebGPU 우선)</option>
                  <option value="gpu">WebGPU</option>
                  <option value="cpu">CPU</option>
                </select>
              </label>
            </div>

            <DiagnosticList items={diagnostics} />

            <div className="row">
              <button className="primary" onClick={run} disabled={busy || blocked}
                title={blocked ? '오류를 먼저 해결하세요' : undefined}>실행</button>
              <button onClick={stop} disabled={status !== 'running'}>중단</button>
            </div>
            <div className="progress"><div style={{ width: `${progress * 100}%` }} /></div>
            <p className="status">
              {status === 'running' ? `계산 중 ${(progress * 100).toFixed(0)}%` : message}
              {cells > 0 && <span className="muted"> · {grid!.Nr}×{grid!.Nz} = {cells.toLocaleString()} cells</span>}
            </p>
            {status === 'done' && <DiagnosticList items={runWarnings} />}

            <div className="row">
              <button onClick={runParity} disabled={busy}>CPU/GPU 일치 검사</button>
              {parityBusy && <span className="muted">검사 중…</span>}
            </div>
            {parity && (
              <p className="muted small">
                배플 피스톤 dx 2 mm, {parity.nSteps} 스텝: 시계열 최대 상대 차이 {(parity.maxRelDiff * 100).toExponential(2)} %,
                스펙트럼 최대 차이 {parity.maxDbDiff.toFixed(3)} dB · CPU {(parity.cpuMs / 1000).toFixed(1)} s / GPU {(parity.gpuMs / 1000).toFixed(1)} s
              </p>
            )}
          </>
        ) : mode === 'cmp' ? (
          <VariantPanel
            variants={variants} objective={optSettings.objective} paramsSignature={paramsSig}
            running={cmpRunning} runningId={cmpRunningId} selected={cmpSelected}
            onSave={saveVariant} onEvaluate={evaluateVariants} onStop={stop}
            onLoad={loadVariant} onUpdateFromEditor={updateVariantFromEditor} onRename={renameVariant} onDelete={deleteVariant}
            onToggle={toggleCmp} onPreview={(v) => setCmpScene(v.scene)} colorFor={colorForVariant} setObjective={setObjective}
          />
        ) : (
          <>
            <label>모델
              <select value={modelId} onChange={(e) => changeModel(e.target.value)} disabled={optRunning}>
                <option value={SCENE_MODEL_ID}>현재 형상 (편집한 씬을 기준으로 변형)</option>
                {Object.values(MODELS).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </label>
            <OptimizePanel
              model={model}
              variables={variables} setVariables={setVariables}
              settings={optSettings} setSettings={setOptSettings}
              running={optRunning} progress={optProgress} elapsedMs={optElapsed}
              onStart={startOptimize} onStop={stop}
              selected={selected} toggleSelected={toggleSelected}
              onApply={applyCandidate} colorFor={colorFor} onPreview={previewCandidate}
              onRefreshBase={modelId === SCENE_MODEL_ID ? refreshBase : undefined}
              baseStale={modelId === SCENE_MODEL_ID && scene !== optBase}
            />
            {status === 'error' && message && <p className="error">{message}</p>}
            <p className="muted small">평가 백엔드: {(params.backend ?? 'auto').toUpperCase()} (시뮬레이션 탭에서 변경). 탐색은 지정한 dx 로 빠르게 순위를 매기므로, 최종 후보는 "적용" 후 dx 1 mm 로 다시 실행해 확인하세요.</p>
          </>
        )}
      </aside>

      <main className="center">
        <SectionCanvas
          ref={canvasRef}
          scene={mode === 'opt' && optScene ? optScene : mode === 'cmp' && cmpScene ? cmpScene : scene}
          onChange={updateScene}
          selection={selection} onSelect={setSelection}
          tool={tool} onToolDone={() => setTool('select')}
          field={{ grid, frame, scale: colorScale }}
          gridMask={gridMask}
          diagnostics={diagnostics}
          spongeMm={params.spongeCells * params.dx}
          editable={mode === 'sim' && !busy}
          snap={0.5}
        />
      </main>

      <aside className="panel right">
        <h2>지향성 <span className="sub">{polarFreq >= 1000 ? `${polarFreq / 1000} kHz` : `${polarFreq} Hz`}{mode !== 'sim' && ' · 공통 기준'}</span></h2>
        <input type="range" min={Math.log10(chartFMin)} max={Math.log10(chartFMax)} step={0.01}
          value={Math.log10(Math.min(Math.max(polarFreq, chartFMin), chartFMax))}
          onChange={(e) => setPolarFreq(Math.round(10 ** +e.target.value / 50) * 50)} />
        <div className="chart polar"><PolarChart series={polarSeries} freq={polarFreq} normalize={mode !== 'sim' ? 'shared' : 'each'} /></div>

        <h2>주파수 응답 <span className="sub">dB, 상대값{mode !== 'sim' && ` · ${sideAngle}° 방향`}</span></h2>
        <div className="chart response">
          <ResponseChart series={responseSeries} fMin={chartFMin} fMax={chartFMax} />
        </div>
        <p className="muted small">
          0° = +z(위), 90° = 측면, 180° = 아래. 절대 SPL은 드라이버 데이터가 있어야 하므로 지금은 상대 dB입니다.
          {mode === 'sim' && result && ` 표시 하한 ${Math.round(result.fMinReliable)} Hz는 해석 시간으로 결정됩니다.`}
          {mode !== 'sim' && ' 비교 모드에서는 체크한 항목들을 같은 기준(전체 최대 = 0 dB)으로 겹쳐 그립니다.'}
        </p>
      </aside>
    </div>
  );
}
