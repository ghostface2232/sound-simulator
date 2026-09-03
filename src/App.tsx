import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_PARAMS, type Scene, type SimParams } from './engine/scene';
import { PRESETS, pistonBaffleScene } from './engine/presets';
import { diagnose, type ParityReport } from './engine/runner';
import type { SimResult } from './engine/analysis';
import { hasErrors, type Diagnostic } from './engine/checks';
import { expandDomainToFit, fitMeasurementArc, normalizeScene } from './engine/geometry';
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
import {
  ActivityIcon, AlertIcon, CheckIcon, CompareIcon, DesignIcon, InfoIcon,
  EllipseIcon, FitIcon, GridIcon, OptimizeIcon, PenIcon, PlayIcon, RectangleIcon,
  RedoIcon, SaveIcon, SelectIcon, StopIcon, UndoIcon, WaveIcon,
} from './ui/Icons';

type Status = 'idle' | 'running' | 'done' | 'error';
type Mode = 'sim' | 'opt' | 'cmp';

const MODE_META: Record<Mode, { eyebrow: string; title: string }> = {
  sim: { eyebrow: 'Model', title: '모델 설계' },
  opt: { eyebrow: 'Explore', title: '설계 탐색' },
  cmp: { eyebrow: 'Compare', title: '비교' },
};

const VARIANTS_KEY = 'speaker-sim.variants.v1';
const formatFrequency = (hz: number) => hz >= 1000
  ? `${Number((hz / 1000).toFixed(hz >= 10000 ? 0 : 1))} kHz`
  : `${Math.round(hz)} Hz`;

function withFittedMeasurement(scene: Scene, params: SimParams): Scene {
  const expanded = expandDomainToFit(scene, params.spongeCells * params.dx);
  return { ...expanded, measure: fitMeasurementArc(expanded, params.spongeCells * params.dx) };
}

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
          <span className="diag-icon">{d.severity === 'error' || d.severity === 'warning' ? <AlertIcon /> : <InfoIcon />}</span>
          <span><span className="diag-code">{d.severity === 'error' ? '오류' : d.severity === 'warning' ? '확인' : '정보'}</span>{d.message}</span>
        </li>
      ))}
    </ul>
  );
}

const HISTORY_MAX = 100;

export default function App() {
  const [mode, setMode] = useState<Mode>('sim');
  const [presetKey, setPresetKey] = useState<string>('side-radial');
  const [scene, setSceneState] = useState<Scene>(() => withFittedMeasurement(normalizeScene(PRESETS['side-radial']()), DEFAULT_PARAMS));
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
  const [autoMeasure, setAutoMeasure] = useState(true);
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
  const [savePulse, setSavePulse] = useState(false);
  const variantsRef = useRef(variants); variantsRef.current = variants;
  const saveNoticeTimerRef = useRef<number | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const modelRef = useRef(model); modelRef.current = model;
  const peakRef = useRef(0);
  const mountedRef = useRef(false);
  useEffect(() => { mountedRef.current = true; }, []);

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
  const updateEditedScene = useCallback((next: Scene, commit = true) => {
    const fitted = autoMeasure && commit && selection?.kind !== 'measure' ? withFittedMeasurement(next, params) : next;
    updateScene(fitted, commit);
  }, [autoMeasure, params, selection, updateScene]);
  const fitMeasureNow = useCallback(() => {
    updateScene(withFittedMeasurement(scene, params), true);
  }, [scene, params, updateScene]);
  const changeAutoMeasure = useCallback((enabled: boolean) => {
    setAutoMeasure(enabled);
    if (enabled) updateScene(withFittedMeasurement(scene, params), true);
  }, [scene, params, updateScene]);
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
    return () => {
      w.terminate();
      if (saveNoticeTimerRef.current !== null) window.clearTimeout(saveNoticeTimerRef.current);
    };
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
    setSavePulse(true);
    if (saveNoticeTimerRef.current !== null) window.clearTimeout(saveNoticeTimerRef.current);
    saveNoticeTimerRef.current = window.setTimeout(() => setSavePulse(false), 1400);
  }, [scene]);
  const evaluateVariants = useCallback((ids?: string[]) => {
    if (!workerRef.current) return;
    const items = variantsRef.current.filter((v) => !ids || ids.includes(v.id)).map((v) => ({ id: v.id, scene: v.scene }));
    if (items.length === 0) return;
    setCmpRunning(true); setMessage(''); setResult(null); setFrame(null); setGrid(null);
    workerRef.current.postMessage({ type: 'evaluate', items, params } satisfies WorkerIn);
  }, [params]);
  const loadVariant = useCallback((v: Variant) => {
    const next = autoMeasure ? withFittedMeasurement(normalizeScene(v.scene), params) : normalizeScene(v.scene);
    resetScene(next); setOptBase(next); setMode('sim'); setTimeout(() => canvasRef.current?.fitDevice(), 0);
  }, [autoMeasure, params, resetScene]);
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
    const next = normalizeScene(PRESETS[key]());
    updateScene(autoMeasure ? withFittedMeasurement(next, params) : next, true);
    setSelection(null);
    setTimeout(() => canvasRef.current?.fitDevice(), 0);
  }, [autoMeasure, params, updateScene]);

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
    let s = normalizeScene(model.build(c.params));
    s.description = `${(s.description ?? '').replace(/ \[최적화 후보[^\]]*\]/g, '')} [최적화 후보 #${c.id}, 점수 ${c.score.toFixed(2)}]`;
    if (autoMeasure) s = withFittedMeasurement(s, params);
    if (model.id !== SCENE_MODEL_ID) setPresetKey('side-radial');
    resetScene(s);
    // The applied candidate becomes the next baseline, so edit -> optimise -> apply can be repeated.
    setOptBase(s);
    setMode('sim');
    setMessage(`후보 #${c.id}을 설계에 적용했습니다. 정밀 해석으로 최종 확인하세요.`);
    setTimeout(() => canvasRef.current?.fitDevice(), 0);
  }, [autoMeasure, model, params, resetScene]);

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
    ? (result ? [{ result, color: '#ff6547', label: '' }] : [])
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
  const meta = MODE_META[mode];
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const warningCount = diagnostics.filter((d) => d.severity === 'warning').length;
  const actionableDiagnostics = diagnostics.filter((d) => d.severity !== 'info');
  const hasChartData = polarSeries.length > 0 || responseSeries.length > 0;
  const previewedVariant = mode === 'cmp' && cmpScene ? variants.find((v) => v.scene === cmpScene) : undefined;
  const visibleSceneName = mode === 'cmp' && cmpScene ? (previewedVariant?.name ?? '저장된 설계안') : mode === 'opt' && optScene ? '탐색 후보 미리보기' : scene.name;
  const canvasHint = mode === 'sim' && tool === 'pen'
          ? '클릭으로 앵커 추가 · 드래그로 곡선 생성 · Enter로 닫기'
          : null;

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="brand" aria-label="Speaker Sim">
          <span className="brand-mark"><WaveIcon /></span>
          <span className="brand-copy"><strong>Speaker Sim</strong></span>
        </div>

        <nav className="workflow-tabs" aria-label="작업 공간">
          <button aria-pressed={mode === 'sim'} className={mode === 'sim' ? 'active' : ''} onClick={() => enterMode('sim')}>
            <DesignIcon /><span>설계</span>
          </button>
          <button aria-pressed={mode === 'opt'} className={mode === 'opt' ? 'active' : ''} onClick={() => enterMode('opt')}>
            <OptimizeIcon /><span>탐색</span>
          </button>
          <button aria-pressed={mode === 'cmp'} className={mode === 'cmp' ? 'active' : ''} onClick={() => enterMode('cmp')}>
            <CompareIcon /><span>비교</span>{variants.length > 0 && <b className="nav-count">{variants.length}</b>}
          </button>
        </nav>

        <div className="topbar-actions">
          <span className={`health-pill ${errorCount ? 'error' : warningCount ? 'warning' : 'ready'}`}>
            {errorCount ? <AlertIcon /> : <CheckIcon />}
            {errorCount ? `오류 ${errorCount}` : warningCount ? `확인 ${warningCount}` : '준비'}
          </span>
          {mode === 'sim' && (status === 'running' ? (
            <button className="run-button stop" onClick={stop}><StopIcon /> 중단</button>
          ) : (
            <button className="run-button" onClick={run} disabled={busy || blocked} title={blocked ? '오류를 먼저 해결하세요' : undefined}>
              <PlayIcon /> 해석 실행
            </button>
          ))}
        </div>
        <div className="app-progress" aria-hidden="true"><span style={{ transform: `scaleX(${status === 'running' ? progress : 0})` }} /></div>
      </header>

      <div className="workspace">
        <aside className="inspector" aria-label={`${meta.title} 도구`}>
          <div className="panel-heading">
            <span className="eyebrow">{meta.eyebrow}</span>
            <h1>{meta.title}</h1>
          </div>

          <div className="panel-scroll">
            <div className={`panel-view ${mountedRef.current ? '' : 'initial'}`} key={mode}>
              {mode === 'sim' ? (
              <>
                <section className="editor-tools">
                  <ShapePanel
                    scene={scene} onChange={(s) => updateEditedScene(s, true)}
                    selection={selection} onSelect={setSelection}
                    autoMeasure={autoMeasure} onAutoMeasureChange={changeAutoMeasure} onFitMeasure={fitMeasureNow}
                    editable={!busy}
                  />
                </section>

                <details className="disclosure-card preset-card">
                  <summary><span>예제 형상에서 시작</span><span className="summary-value">{presetKey}</span></summary>
                  <div className="disclosure-content">
                    <label className="field-label" htmlFor="preset-select">예제 선택</label>
                    <select id="preset-select" value={presetKey} onChange={(e) => loadPreset(e.target.value)}>
                      {Object.keys(PRESETS).map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                    {scene.description && <p className="desc">{scene.description}</p>}
                  </div>
                </details>

                <details className="disclosure-card">
                  <summary><span>해석 설정</span><span className="summary-value">dx {params.dx} mm · {params.durationMs} ms</span></summary>
                  <div className="grid2 disclosure-content">
                    <label>격자 간격 (mm)<input type="number" step="0.25" min="0.25" max="4" value={params.dx} onChange={setNum('dx')} /></label>
                    <label>해석 시간 (ms)<input type="number" step="1" min="1" max="40" value={params.durationMs} onChange={setNum('durationMs')} /></label>
                    <label>최저 주파수 (Hz)<input type="number" step="50" min="20" max="5000" value={params.fMin} onChange={setNum('fMin')} /></label>
                    <label>최고 주파수 (Hz)<input type="number" step="1000" min="2000" max="40000" value={params.fMax} onChange={setNum('fMax')} /></label>
                    <label>흡수층 (cells)<input type="number" step="10" min="10" max="150" value={params.spongeCells} onChange={setNum('spongeCells')} /></label>
                    <label>연산 장치
                      <select value={params.backend ?? 'auto'} onChange={(e) => setParams({ ...params, backend: e.target.value as SimParams['backend'] })}>
                        <option value="auto">자동 · WebGPU 우선</option><option value="gpu">WebGPU</option><option value="cpu">CPU</option>
                      </select>
                    </label>
                  </div>
                </details>

                {actionableDiagnostics.length > 0 && <section className="diagnostic-card"><div className="section-heading"><span>실행 전 확인</span><span className="section-meta">{actionableDiagnostics.length}</span></div><DiagnosticList items={actionableDiagnostics} /></section>}

                <details className="disclosure-card utility-card">
                  <summary><span>정밀도 검증</span><span className="summary-value">CPU ↔ GPU</span></summary>
                  <div className="disclosure-content stack">
                    <button onClick={runParity} disabled={busy}>일치 검사 실행</button>
                    {parityBusy && <p className="status">두 백엔드를 비교하고 있습니다…</p>}
                    {parity && <p className="muted small">시계열 차이 {(parity.maxRelDiff * 100).toExponential(2)}%, 스펙트럼 차이 {parity.maxDbDiff.toFixed(3)} dB · CPU {(parity.cpuMs / 1000).toFixed(1)} s / GPU {(parity.gpuMs / 1000).toFixed(1)} s</p>}
                  </div>
                </details>
              </>
            ) : mode === 'cmp' ? (
              <section className="workflow-panel">
                <VariantPanel
                  variants={variants} objective={optSettings.objective} paramsSignature={paramsSig}
                  running={cmpRunning} runningId={cmpRunningId} selected={cmpSelected}
                  onSave={saveVariant} onEvaluate={evaluateVariants} onStop={stop}
                  onLoad={loadVariant} onUpdateFromEditor={updateVariantFromEditor} onRename={renameVariant} onDelete={deleteVariant}
                  onToggle={toggleCmp} onPreview={(v) => setCmpScene(v.scene)} colorFor={colorForVariant} setObjective={setObjective}
                />
              </section>
            ) : (
              <section className="workflow-panel">
                <details className="inline-disclosure model-source">
                  <summary><span>탐색 기준</span><span>{modelId === SCENE_MODEL_ID ? '현재 형상' : model.name}</span></summary>
                  <label className="model-select disclosure-content">
                    <select aria-label="탐색 기준" value={modelId} onChange={(e) => changeModel(e.target.value)} disabled={optRunning}>
                      <option value={SCENE_MODEL_ID}>현재 형상</option>
                      {Object.values(MODELS).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </label>
                </details>
                <OptimizePanel
                  model={model} variables={variables} setVariables={setVariables}
                  settings={optSettings} setSettings={setOptSettings}
                  running={optRunning} progress={optProgress} elapsedMs={optElapsed}
                  onStart={startOptimize} onStop={stop} selected={selected} toggleSelected={toggleSelected}
                  onApply={applyCandidate} colorFor={colorFor} onPreview={previewCandidate}
                  onRefreshBase={modelId === SCENE_MODEL_ID ? refreshBase : undefined}
                  baseStale={modelId === SCENE_MODEL_ID && scene !== optBase}
                />
                {status === 'error' && message && <p className="error">{message}</p>}
              </section>
              )}
            </div>
          </div>
        </aside>

        <main className="canvas-stage">
          <div className="canvas-card">
            <div className="canvas-context">
              <span className="canvas-mode">{meta.eyebrow}</span>
              <strong>{visibleSceneName || 'Untitled section'}</strong>
            </div>
            <div className="canvas-top-actions">
              {mode === 'sim' && (
                <button className={`save-variant-button ${savePulse ? 'saved' : ''}`} onClick={saveVariant} disabled={busy}>
                  {savePulse ? <CheckIcon /> : <SaveIcon />}
                  <span>{savePulse ? '안에 저장됨' : '비교할 안 저장'}</span>
                </button>
              )}
              <div className="canvas-state">
                <ActivityIcon />
                <span>{status === 'running' ? `${(progress * 100).toFixed(0)}% 계산 중` : mode === 'sim' ? '편집' : '미리보기'}</span>
              </div>
            </div>
            <SectionCanvas
              ref={canvasRef}
              scene={mode === 'opt' && optScene ? optScene : mode === 'cmp' && cmpScene ? cmpScene : scene}
              onChange={updateEditedScene} selection={selection} onSelect={setSelection}
              tool={tool} onToolDone={() => setTool('select')}
              field={{ grid, frame, scale: colorScale }} gridMask={gridMask} diagnostics={diagnostics}
              spongeMm={params.spongeCells * params.dx} editable={mode === 'sim' && !busy} snap={0.5}
            />
            {mode === 'sim' && (
              <div className="canvas-tools" role="toolbar" aria-label="캔버스 편집 도구">
                <button className={tool === 'select' ? 'active' : ''} aria-label="선택 도구" title="선택 · V" onClick={() => setTool('select')} disabled={busy}><SelectIcon /></button>
                <button className={tool === 'pen' ? 'active' : ''} aria-label="펜 도구" title="펜 · P" onClick={() => setTool('pen')} disabled={busy}><PenIcon /></button>
                <button className={tool === 'rect' ? 'active' : ''} aria-label="사각형 도구" title="사각형 · R" onClick={() => setTool('rect')} disabled={busy}><RectangleIcon /></button>
                <button className={tool === 'ellipse' ? 'active' : ''} aria-label="원 도구" title="원 · E" onClick={() => setTool('ellipse')} disabled={busy}><EllipseIcon /></button>
                <span className="tool-divider" />
                <button aria-label="실행 취소" title="실행 취소 · Ctrl+Z" onClick={undo} disabled={!h.past.length || busy}><UndoIcon /></button>
                <button aria-label="다시 실행" title="다시 실행 · Ctrl+Y" onClick={redo} disabled={!h.future.length || busy}><RedoIcon /></button>
                <span className="tool-divider" />
                <button aria-label="기기에 맞춤" title="기기에 맞춤" onClick={() => canvasRef.current?.fitDevice()}><FitIcon /></button>
                <button className={showGrid ? 'active' : ''} aria-pressed={showGrid} aria-label="격자 마스크" title="격자 마스크" onClick={() => setShowGrid((v) => !v)}><GridIcon /></button>
              </div>
            )}
            {canvasHint && <div className="canvas-hint">{canvasHint}</div>}
            <div className="canvas-metrics numeric">{cells > 0 ? `${grid!.Nr} × ${grid!.Nz} · ${cells.toLocaleString()} cells` : 'r–z 단면'}</div>
          </div>
        </main>

        <aside className="results-panel" aria-label="음향 분석 결과">
          <div className="results-heading">
            <div><span className="eyebrow">Live analysis</span><h2>음향 응답</h2></div>
            <span className={`result-status ${hasChartData ? 'ready' : ''}`}>{hasChartData ? '결과 표시 중' : '해석 대기'}</span>
          </div>

          <section className="chart-card polar-card">
            <div className="chart-heading">
              <div><span>지향성</span><strong>{formatFrequency(polarFreq)}</strong></div>
              {mode !== 'sim' && <span className="comparison-label">공통 기준</span>}
            </div>
            <label className="frequency-control" htmlFor="polar-frequency"><span>{formatFrequency(chartFMin)}</span>
              <input id="polar-frequency" aria-label="지향성 주파수" type="range" min={Math.log10(chartFMin)} max={Math.log10(chartFMax)} step={0.01}
                value={Math.log10(Math.min(Math.max(polarFreq, chartFMin), chartFMax))}
                onChange={(e) => setPolarFreq(Math.round(10 ** +e.target.value / 50) * 50)} />
              <span>{formatFrequency(chartFMax)}</span>
            </label>
            <div className="chart polar"><PolarChart series={polarSeries} freq={polarFreq} normalize={mode !== 'sim' ? 'shared' : 'each'} /></div>
            {!hasChartData && <div className="chart-empty"><WaveIcon /><strong>결과 없음</strong></div>}
          </section>

          <section className="chart-card response-card">
            <div className="chart-heading">
              <div><span>주파수 응답</span><strong>{mode === 'sim' ? '5개 방향' : `${sideAngle}° 측면`}</strong></div>
              <span className="comparison-label">상대 dB</span>
            </div>
            <div className="chart response"><ResponseChart series={responseSeries} fMin={chartFMin} fMax={chartFMax} /></div>
            {!hasChartData && <div className="response-empty">응답 없음</div>}
          </section>

          {status === 'done' && runWarnings.length > 0 && <section className="diagnostic-card results-diagnostics"><DiagnosticList items={runWarnings} /></section>}
          {message && <div className={`run-message ${status}`}><span>{status === 'done' ? <CheckIcon /> : status === 'error' ? <AlertIcon /> : <ActivityIcon />}</span><p>{message}</p></div>}

          <details className="technical-note">
            <summary>그래프 읽는 법</summary>
            <p>0°는 위, 90°는 측면, 180°는 아래입니다. 현재 결과는 드라이버 절대 감도가 없는 상대 dB입니다.{mode !== 'sim' && ' 체크한 항목은 같은 최대값을 기준으로 겹쳐 표시합니다.'}</p>
          </details>
        </aside>
      </div>
    </div>
  );
}
