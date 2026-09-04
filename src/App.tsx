import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_PARAMS, type Scene, type SimParams } from './engine/scene';
import { PRESETS, pistonBaffleScene } from './engine/presets';
import { diagnose, type ParityReport } from './engine/runner';
import type { SimResult } from './engine/analysis';
import { hasErrors, type Diagnostic } from './engine/checks';
import { expandDomainToFit, fitMeasurementArc, normalizeScene } from './engine/geometry';
import { buildGrid } from './engine/rasterize';
import {
  DEFAULT_OPTIMIZE, MODELS, SCENE_MODEL_ID, makeSceneModel, scoreResult,
  type Candidate, type DesignVariable, type ObjectiveSettings, type OptimizeProgress, type OptimizeSettings, type ParametricModel,
} from './engine/optimize';
import type { WorkerIn, WorkerOut } from './worker/sim.worker';
import { DRIVER_COLOR, MEASURE_COLOR, ROLE_COLORS, SectionCanvas, type GridInfo, type SectionCanvasHandle, type Selection, type Tool } from './ui/SectionCanvas';
import { LayersPanel } from './ui/LayersPanel';
import { LibraryPanel } from './ui/LibraryPanel';
import { Inspector } from './ui/Inspector';
import { ResultsDock } from './ui/ResultsDock';
import type { PolarSeries } from './ui/PolarChart';
import { SERIES_COLORS, type ResponseSeries } from './ui/ResponseChart';
import { OptimizePanel } from './ui/OptimizePanel';
import { VariantPanel, type Variant } from './ui/VariantPanel';
import { DiagnosticList, useDismiss } from './ui/fields';
import { applyTheme, invalidateCanvasTheme, loadTheme, type ThemeName } from './ui/theme';
import {
  AlertIcon, CheckIcon, EllipseIcon, ExploreIcon, FitIcon, FrameIcon, GridIcon, KeyboardIcon, LayersIcon, LibraryIcon, MoonIcon, PenIcon,
  PlayIcon, RectangleIcon, RedoIcon, SelectIcon, SidebarIcon, StopIcon, SunIcon, UndoIcon, VariantsIcon, WaveIcon, ZoomInIcon, ZoomOutIcon,
} from './ui/Icons';

type Status = 'idle' | 'running' | 'done' | 'error';
type Activity = 'layers' | 'library' | 'explore' | 'variants';

const VARIANTS_KEY = 'speaker-sim.variants.v1';
const UI_KEY = 'speaker-sim.ui.v1';
const HISTORY_MAX = 100;

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

interface UiPrefs { dockHeight: number; dockCollapsed: boolean; sideCollapsed: boolean }
function loadUi(): UiPrefs {
  try { return { dockHeight: 264, dockCollapsed: false, sideCollapsed: false, ...JSON.parse(localStorage.getItem(UI_KEY) ?? '{}') }; } catch { return { dockHeight: 264, dockCollapsed: false, sideCollapsed: false }; }
}

export default function App() {
  const [activity, setActivity] = useState<Activity>('layers');
  const [theme, setTheme] = useState<ThemeName>(loadTheme);
  const [ui, setUi] = useState<UiPrefs>(loadUi);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const shortcutsRef = useRef<HTMLDivElement>(null);
  const diagRef = useRef<HTMLDivElement>(null);
  useDismiss(shortcutsRef, shortcutsOpen, useCallback(() => setShortcutsOpen(false), []));
  useDismiss(diagRef, diagOpen, useCallback(() => setDiagOpen(false), []));
  useEffect(() => { applyTheme(theme); invalidateCanvasTheme(); }, [theme]);
  useEffect(() => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* storage unavailable */ } }, [ui]);

  const [presetKey, setPresetKey] = useState<string>('side-radial');
  const [scene, setSceneState] = useState<Scene>(() => withFittedMeasurement(normalizeScene(PRESETS['side-radial']()), DEFAULT_PARAMS));
  const [params, setParams] = useState<SimParams>(DEFAULT_PARAMS);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState<string>('');
  const [grid, setGrid] = useState<GridInfo | null>(null);
  const [frame, setFrame] = useState<Float32Array | null>(null);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<SimResult | null>(null);
  const [runMeta, setRunMeta] = useState<{ backend?: string; elapsedMs?: number }>({});
  const [runWarnings, setRunWarnings] = useState<Diagnostic[]>([]);
  const [parity, setParity] = useState<ParityReport | null>(null);
  const [parityBusy, setParityBusy] = useState(false);
  const [polarFreq, setPolarFreq] = useState(5000);
  const [colorScale, setColorScale] = useState(0.05);
  const [zoom, setZoom] = useState(4);
  const [viewportH, setViewportH] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const dockHeight = Math.min(ui.dockHeight, Math.max(180, Math.floor(viewportH * 0.42)));

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
  const [optBase, setOptBase] = useState<Scene>(scene);
  const model = useMemo<ParametricModel>(() => (modelId === SCENE_MODEL_ID ? makeSceneModel(optBase) : MODELS[modelId]), [modelId, optBase]);
  const [variables, setVariables] = useState<DesignVariable[]>(() => makeSceneModel(scene).variables.map((v) => ({ ...v })));
  const [optSettings, setOptSettings] = useState<OptimizeSettings>(DEFAULT_OPTIMIZE);
  const [optRunning, setOptRunning] = useState(false);
  const [optProgress, setOptProgress] = useState<OptimizeProgress | null>(null);
  const [optElapsed, setOptElapsed] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [optPreview, setOptPreview] = useState<{ scene: Scene; id: number | null; label: string } | null>(null);

  // Saved variants.
  const [variants, setVariants] = useState<Variant[]>(loadVariants);
  const [cmpRunning, setCmpRunning] = useState(false);
  const [cmpRunningId, setCmpRunningId] = useState<string | null>(null);
  const [cmpSelected, setCmpSelected] = useState<Set<string>>(new Set());
  const [cmpPreview, setCmpPreview] = useState<{ scene: Scene; id: string | null; label: string } | null>(null);
  const [savePulse, setSavePulse] = useState(false);
  const variantsRef = useRef(variants); variantsRef.current = variants;
  const saveNoticeTimerRef = useRef<number | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const modelRef = useRef(model); modelRef.current = model;
  const peakRef = useRef(0);

  // ---- history ---------------------------------------------------------------
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
  const fitMeasureNow = useCallback(() => updateScene(withFittedMeasurement(scene, params), true), [scene, params, updateScene]);
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

  // ---- worker ----------------------------------------------------------------
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
          setRunMeta({ backend: m.backend.toUpperCase(), elapsedMs: m.elapsedMs });
          setStatus('done'); setProgress(1);
          setMessage(`완료 · ${m.backend.toUpperCase()} · ${(m.elapsedMs / 1000).toFixed(1)} s`);
          break;
        case 'parity-result':
          setParity(m.report); setParityBusy(false);
          break;
        case 'opt-eval':
          setOptPreview({ scene: normalizeScene(modelRef.current.build(m.candidate.params)), id: m.candidate.id, label: `후보 #${m.candidate.id} 평가 중` });
          break;
        case 'opt-progress':
          setOptProgress(m.progress);
          break;
        case 'opt-done':
          setOptProgress((prev) => ({ done: prev?.total ?? m.ranked.length, total: prev?.total ?? m.ranked.length, best: m.ranked[0] ?? null, ranked: m.ranked }));
          setOptElapsed(m.elapsedMs); setOptRunning(false);
          if (m.ranked[0]) setOptPreview({ scene: normalizeScene(modelRef.current.build(m.ranked[0].params)), id: m.ranked[0].id, label: `후보 #${m.ranked[0].id} · 최고 점수` });
          setSelected(new Set(m.ranked.filter((c, i) => i === 0 || c.origin === 'baseline').map((c) => c.id)));
          break;
        case 'eval-start': {
          setCmpRunningId(m.id);
          const v = variantsRef.current.find((x) => x.id === m.id);
          if (v) setCmpPreview({ scene: v.scene, id: v.id, label: `${v.name} 평가 중` });
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

  const paramsSig = useMemo(() => JSON.stringify({ dx: params.dx, t: params.durationMs, f0: params.fMin, f1: params.fMax, sp: params.spongeCells }), [params]);
  const paramsSigRef = useRef(paramsSig); paramsSigRef.current = paramsSig;
  const objectiveRef = useRef(optSettings.objective); objectiveRef.current = optSettings.objective;

  useEffect(() => {
    try { localStorage.setItem(VARIANTS_KEY, JSON.stringify(variants.map((v) => ({ id: v.id, name: v.name, scene: v.scene })))); } catch { /* storage unavailable */ }
  }, [variants]);
  useEffect(() => {
    setVariants((prev) => prev.map((v) => (v.result ? { ...v, breakdown: scoreResult(v.result, optSettings.objective) } : v)));
  }, [optSettings.objective]);

  // ---- variants --------------------------------------------------------------
  const saveVariant = useCallback(() => {
    const id = `v${Date.now().toString(36)}`;
    setVariants((prev) => [...prev, { id, name: `안 ${prev.length + 1}`, scene }]);
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
    resetScene(next); setOptBase(next); setCmpPreview(null); setActivity('layers'); setTimeout(() => canvasRef.current?.fitDevice(), 0);
  }, [autoMeasure, params, resetScene]);
  const updateVariantFromEditor = useCallback((v: Variant) => {
    setVariants((prev) => prev.map((x) => x.id === v.id ? { id: x.id, name: x.name, scene } : x));
    setCmpPreview({ scene, id: v.id, label: v.name });
  }, [scene]);
  const renameVariant = useCallback((v: Variant, name: string) => setVariants((prev) => prev.map((x) => x.id === v.id ? { ...x, name } : x)), []);
  const deleteVariant = useCallback((v: Variant) => {
    setVariants((prev) => prev.filter((x) => x.id !== v.id));
    setCmpSelected((prev) => { const n = new Set(prev); n.delete(v.id); return n; });
    setCmpPreview((prev) => (prev?.id === v.id ? null : prev));
  }, []);
  const toggleCmp = useCallback((id: string) => setCmpSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  const setObjective = useCallback((o: ObjectiveSettings) => setOptSettings((s) => ({ ...s, objective: o })), []);

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

  // ---- runs ------------------------------------------------------------------
  const run = useCallback(() => {
    if (blocked || !workerRef.current || busy) return;
    setStatus('running'); setMessage(''); setResult(null); setProgress(0); setRunWarnings([]); setRunMeta({});
    workerRef.current.postMessage({ type: 'run', scene, params, frameEvery: 25 } satisfies WorkerIn);
  }, [blocked, busy, scene, params]);
  const runParity = useCallback(() => {
    if (!workerRef.current) return;
    setParity(null); setParityBusy(true);
    workerRef.current.postMessage({ type: 'parity', scene: pistonBaffleScene(20, 320, 150), params: { ...params, dx: 2, durationMs: 3, fMax: 10000, spongeCells: 50 } } satisfies WorkerIn);
  }, [params]);
  const stop = useCallback(() => { workerRef.current?.postMessage({ type: 'stop' } satisfies WorkerIn); }, []);

  // ---- optimisation ----------------------------------------------------------
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
    setOptProgress(null); setSelected(new Set()); setOptElapsed(null); setOptPreview(null);
  }, [scene]);
  const refreshBase = useCallback(() => {
    setOptBase(scene);
    if (modelId === SCENE_MODEL_ID) adoptVariables(makeSceneModel(scene));
    setOptProgress(null); setSelected(new Set()); setOptElapsed(null); setOptPreview(null);
  }, [scene, modelId, adoptVariables]);
  const enterActivity = useCallback((a: Activity) => {
    if (a === 'explore' && !optRunning && scene !== optBase) refreshBase();
    setActivity(a);
    setUi((u) => (u.sideCollapsed ? { ...u, sideCollapsed: false } : u));
  }, [optRunning, scene, optBase, refreshBase]);
  const startOptimize = useCallback(() => {
    if (!workerRef.current) return;
    setOptRunning(true); setOptProgress(null); setOptElapsed(null); setSelected(new Set()); setMessage('');
    setResult(null); setFrame(null); setGrid(null);
    workerRef.current.postMessage({
      type: 'optimize', modelId: model.id, baseScene: model.id === SCENE_MODEL_ID ? optBase : undefined,
      variables, settings: optSettings, backend: params.backend ?? 'auto',
    } satisfies WorkerIn);
  }, [model, optBase, variables, optSettings, params.backend]);
  const previewCandidate = useCallback((c: Candidate) => {
    setOptPreview({ scene: normalizeScene(model.build(c.params)), id: c.id, label: `후보 #${c.id} · 점수 ${Number.isFinite(c.score) ? c.score.toFixed(2) : '—'}` });
  }, [model]);
  const toggleSelected = useCallback((id: number) => {
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }, []);
  const applyCandidate = useCallback((c: Candidate) => {
    let s = normalizeScene(model.build(c.params));
    s.description = `${(s.description ?? '').replace(/ \[최적화 후보[^\]]*\]/g, '')} [최적화 후보 #${c.id}, 점수 ${Number.isFinite(c.score) ? c.score.toFixed(2) : '—'}]`;
    if (autoMeasure) s = withFittedMeasurement(s, params);
    if (model.id !== SCENE_MODEL_ID) setPresetKey('side-radial');
    resetScene(s);
    setOptBase(s);
    setOptPreview(null);
    setActivity('layers');
    setMessage(`후보 #${c.id}을 설계에 적용했습니다. 해석 실행으로 최종 확인하세요.`);
    setTimeout(() => canvasRef.current?.fitDevice(), 0);
  }, [autoMeasure, model, params, resetScene]);

  // ---- preview / derived -----------------------------------------------------
  const preview = activity === 'explore' ? optPreview : activity === 'variants' ? cmpPreview : null;
  const clearPreview = useCallback(() => { if (activity === 'explore') setOptPreview(null); else if (activity === 'variants') setCmpPreview(null); }, [activity]);
  const editable = !busy && !preview;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if (mod && e.key === 'Enter') { e.preventDefault(); if (status === 'running') stop(); else run(); }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveVariant(); }
      else if (e.key === 'Escape' && preview) { clearPreview(); }
      else if (!mod && e.key.toLowerCase() === 'v') setTool('select');
      else if (!mod && e.key.toLowerCase() === 'p') setTool('pen');
      else if (!mod && e.key.toLowerCase() === 'r') setTool('rect');
      else if (!mod && e.key.toLowerCase() === 'e') setTool('ellipse');
      else if (!mod && e.key === '1') enterActivity('layers');
      else if (!mod && e.key === '2') enterActivity('library');
      else if (!mod && e.key === '3') enterActivity('explore');
      else if (!mod && e.key === '4') enterActivity('variants');
      else if (e.key === '?') setShortcutsOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, run, stop, status, saveVariant, preview, clearPreview, enterActivity]);

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
  const chartMode: 'sim' | 'opt' | 'cmp' = activity === 'explore' && compared.length > 0 ? 'opt' : activity === 'variants' && comparedVariants.length > 0 ? 'cmp' : 'sim';
  const polarSeries: PolarSeries[] = chartMode === 'sim'
    ? (result ? [{ result, color: SERIES_COLORS[0], label: scene.name }] : [])
    : chartMode === 'opt'
      ? compared.map((c, i) => ({ result: c.result!, color: SERIES_COLORS[i % SERIES_COLORS.length], label: `#${c.id} ${c.score.toFixed(2)}` }))
      : comparedVariants.map((v, i) => ({ result: v.result!, color: SERIES_COLORS[i % SERIES_COLORS.length], label: `${v.name} ${v.breakdown ? v.breakdown.score.toFixed(2) : ''}` }));
  const responseSeries: ResponseSeries[] = chartMode === 'sim'
    ? (result ? [0, 45, 90, 135, 180].map((a, i) => ({ result, angle: a, color: SERIES_COLORS[i], label: `${a}°` })) : [])
    : chartMode === 'opt'
      ? compared.map((c, i) => ({ result: c.result!, angle: sideAngle, color: SERIES_COLORS[i % SERIES_COLORS.length], label: `#${c.id}` }))
      : comparedVariants.map((v, i) => ({ result: v.result!, angle: sideAngle, color: SERIES_COLORS[i % SERIES_COLORS.length], label: v.name }));
  const legend = chartMode === 'sim'
    ? responseSeries.map((s) => ({ color: s.color, label: s.label }))
    : polarSeries.map((s) => ({ color: s.color, label: s.label }));
  const chartFMin = chartMode === 'sim' ? (result ? result.freqs[0] : params.fMin)
    : chartMode === 'opt' ? (compared[0]?.result?.freqs[0] ?? optSettings.fMin)
      : (comparedVariants[0]?.result?.freqs[0] ?? params.fMin);
  const chartFMax = chartMode === 'opt' ? optSettings.fMax : params.fMax;

  const cells = grid ? grid.Nr * grid.Nz : 0;
  const h = historyRef.current;
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const warningCount = diagnostics.filter((d) => d.severity === 'warning').length;
  const actionable = diagnostics.filter((d) => d.severity !== 'info');
  const canvasScene = preview ? preview.scene : scene;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" aria-label="Speaker Sim">
          <span className="brand-mark"><WaveIcon /></span>
          <strong>Speaker Sim</strong>
        </div>
        <div className="doc">
          <span className="sep">/</span>
          <input className="doc-name" aria-label="설계 이름" value={scene.name} onChange={(e) => updateScene({ ...scene, name: e.target.value }, true)} size={Math.max(6, Math.min(32, scene.name.length + 1))} disabled={!!preview} />
          <div ref={diagRef} style={{ position: 'relative' }}>
            <button className="status-btn" aria-expanded={diagOpen} aria-label="실행 전 확인 목록" onClick={() => setDiagOpen((v) => !v)}>
              <span className={`chip ${errorCount ? 'error' : warningCount ? 'warning' : 'ready'}`}>
                {errorCount ? <AlertIcon /> : <CheckIcon />}
                {errorCount ? `오류 ${errorCount}` : warningCount ? `확인 ${warningCount}` : '실행 가능'}
              </span>
            </button>
            {diagOpen && (
              <div className="popover diag-popover" role="dialog" aria-label="실행 전 확인">
                <div className="head"><span>실행 전 확인</span><span className="num">{actionable.length}건</span></div>
                {actionable.length === 0 ? <p className="help" style={{ padding: '0 4px 6px' }}>형상과 수치 설정이 실행 가능한 상태입니다.</p> : <DiagnosticList items={actionable} />}
              </div>
            )}
          </div>
          {preview && <span className="chip accent dot">{preview.label}</span>}
          {savePulse && <span className="chip ready"><CheckIcon />안에 저장됨</span>}
        </div>
        <div className="topbar-actions">
          <button className="btn ghost icon" aria-label={theme === 'dark' ? '라이트 테마' : '다크 테마'} title={theme === 'dark' ? '라이트 테마' : '다크 테마'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <SunIcon /> : <MoonIcon />}</button>
          <button className="btn ghost icon" aria-label="사이드 패널" aria-pressed={!ui.sideCollapsed} title="사이드 패널 접기/펼치기" onClick={() => setUi((u) => ({ ...u, sideCollapsed: !u.sideCollapsed }))}><SidebarIcon /></button>
          {status === 'running' ? (
            <button className="btn run-btn stop" onClick={stop}><StopIcon />중단 <span className="num" style={{ opacity: .75 }}>{Math.round(progress * 100)}%</span></button>
          ) : (
            <button className="btn primary run-btn" onClick={run} disabled={busy || blocked} title={blocked ? '오류를 먼저 해결하세요' : '해석 실행 · Ctrl+Enter'}><PlayIcon />해석 실행</button>
          )}
        </div>
        <div className="topbar-progress" aria-hidden="true"><span style={{ transform: `scaleX(${status === 'running' ? progress : 0})` }} /></div>
      </header>

      <div className={`workbench ${ui.sideCollapsed ? 'side-collapsed' : ''}`}>
        <nav className="rail" aria-label="작업 공간">
          <button className="rail-btn" aria-pressed={activity === 'layers' && !ui.sideCollapsed} title="레이어 · 1" onClick={() => enterActivity('layers')}><LayersIcon /></button>
          <button className="rail-btn" aria-pressed={activity === 'library' && !ui.sideCollapsed} title="라이브러리 · 2" onClick={() => enterActivity('library')}><LibraryIcon /></button>
          <button className="rail-btn" aria-pressed={activity === 'explore' && !ui.sideCollapsed} title="설계 탐색 · 3" onClick={() => enterActivity('explore')}><ExploreIcon />{optRunning && <span className="count">…</span>}</button>
          <button className="rail-btn" aria-pressed={activity === 'variants' && !ui.sideCollapsed} title="설계안 비교 · 4" onClick={() => enterActivity('variants')}><VariantsIcon />{variants.length > 0 && <span className="count">{variants.length}</span>}</button>
          <span className="spacer" />
          <div ref={shortcutsRef} style={{ position: 'relative' }}>
            <button className="rail-btn" aria-pressed={shortcutsOpen} title="단축키 · ?" onClick={() => setShortcutsOpen((v) => !v)}><KeyboardIcon /></button>
            {shortcutsOpen && (
              <div className="popover shortcuts" role="dialog" aria-label="단축키">
                <div className="head">단축키</div>
                <dl>
                  <dt><kbd>V</kbd></dt><dd>선택</dd>
                  <dt><kbd>P</kbd></dt><dd>펜 · 클릭 코너, 드래그 곡선</dd>
                  <dt><kbd>R</kbd> <kbd>E</kbd></dt><dd>사각형 · 원 (Shift 정형)</dd>
                  <dt><kbd>Shift</kbd>+드래그</dt><dd>수직/수평 고정</dd>
                  <dt><kbd>Alt</kbd>+핸들</dt><dd>비대칭 핸들</dd>
                  <dt><kbd>Del</kbd></dt><dd>핸들 → 앵커 → 형상 삭제</dd>
                  <dt><kbd>Ctrl</kbd><kbd>Z</kbd> / <kbd>Y</kbd></dt><dd>실행 취소 · 다시 실행</dd>
                  <dt><kbd>Ctrl</kbd><kbd>Enter</kbd></dt><dd>해석 실행 · 중단</dd>
                  <dt><kbd>Ctrl</kbd><kbd>S</kbd></dt><dd>현재 설계를 안으로 저장</dd>
                  <dt><kbd>1</kbd>-<kbd>4</kbd></dt><dd>레이어 · 라이브러리 · 탐색 · 설계안</dd>
                  <dt><kbd>Esc</kbd></dt><dd>미리보기 종료 · 선택 해제</dd>
                </dl>
              </div>
            )}
          </div>
        </nav>

        <aside className="panel activity" aria-label="사이드 패널">
          {activity === 'layers' && (
            <LayersPanel scene={scene} onChange={(s) => updateEditedScene(s, true)} selection={selection} onSelect={setSelection} editable={editable} diagnostics={diagnostics} onTool={setTool} />
          )}
          {activity === 'library' && (
            <LibraryPanel scene={scene} presetKey={presetKey} onPreset={loadPreset} onChange={(s) => updateEditedScene(s, true)} onSelect={setSelection} editable={editable} />
          )}
          {activity === 'explore' && (
            <OptimizePanel
              modelId={modelId} onModelChange={changeModel}
              model={model} variables={variables} setVariables={setVariables}
              settings={optSettings} setSettings={setOptSettings}
              running={optRunning} progress={optProgress} elapsedMs={optElapsed}
              onStart={startOptimize} onStop={stop} selected={selected} toggleSelected={toggleSelected}
              onApply={applyCandidate} colorFor={colorFor} onPreview={previewCandidate} previewedId={optPreview?.id ?? null}
              onRefreshBase={modelId === SCENE_MODEL_ID ? refreshBase : undefined}
              baseStale={modelId === SCENE_MODEL_ID && scene !== optBase}
              busy={busy}
            />
          )}
          {activity === 'variants' && (
            <VariantPanel
              variants={variants} objective={optSettings.objective} paramsSignature={paramsSig}
              running={cmpRunning} runningId={cmpRunningId} selected={cmpSelected} previewedId={cmpPreview?.id ?? null}
              onSave={saveVariant} onEvaluate={evaluateVariants} onStop={stop}
              onLoad={loadVariant} onUpdateFromEditor={updateVariantFromEditor} onRename={renameVariant} onDelete={deleteVariant}
              onToggle={toggleCmp} onPreview={(v) => setCmpPreview({ scene: v.scene, id: v.id, label: v.name })} colorFor={colorForVariant} setObjective={setObjective}
              busy={busy}
            />
          )}
        </aside>

        <main className="stage">
          <div className={`viewport ${preview ? 'readonly' : ''}`}>
            <SectionCanvas
              ref={canvasRef}
              scene={canvasScene}
              onChange={updateEditedScene} selection={preview ? null : selection} onSelect={setSelection}
              tool={tool} onToolDone={() => setTool('select')}
              field={{ grid, frame, scale: colorScale }} gridMask={gridMask} diagnostics={preview ? [] : diagnostics}
              spongeMm={params.spongeCells * params.dx} editable={editable} snap={0.5}
              themeKey={theme} onZoom={setZoom}
            />
            <div className={`hud state ${status === 'running' ? 'running' : status === 'done' && result ? 'done' : ''}`}>
              <span className="dot" />
              <span>{status === 'running' ? `압력장 계산 중 ${Math.round(progress * 100)}%` : preview ? '미리보기' : busy ? '계산 중' : '편집'}</span>
              {cells > 0 && <span className="num faint">{grid!.Nr}×{grid!.Nz}</span>}
            </div>
            {preview && (
              <div className="hud pill preview">
                <span>{preview.label}</span>
                <button className="btn sm" onClick={clearPreview}>편집으로 돌아가기 <kbd>Esc</kbd></button>
              </div>
            )}
            <div className="hud view" role="toolbar" aria-label="보기">
              <button className="btn" aria-label="축소" title="축소" onClick={() => canvasRef.current?.zoomBy(1 / 1.25)}><ZoomOutIcon /></button>
              <span className="zoom" title="px / mm">{zoom >= 10 ? Math.round(zoom) : zoom.toFixed(1)}×</span>
              <button className="btn" aria-label="확대" title="확대" onClick={() => canvasRef.current?.zoomBy(1.25)}><ZoomInIcon /></button>
              <span className="sep" />
              <button className="btn" aria-label="기기에 맞춤" title="기기에 맞춤" onClick={() => canvasRef.current?.fitDevice()}><FitIcon /></button>
              <button className="btn" aria-label="해석 영역 전체" title="해석 영역 전체" onClick={() => canvasRef.current?.fitDomain()}><FrameIcon /></button>
              <span className="sep" />
              <button className="btn" aria-pressed={showGrid} aria-label="격자 마스크" title="솔버가 보는 격자 마스크" onClick={() => setShowGrid((v) => !v)}><GridIcon /></button>
            </div>
            {!preview && (
              <div className="hud tools" role="toolbar" aria-label="편집 도구">
                <button className="btn" aria-pressed={tool === 'select'} aria-label="선택 도구" title="선택 · V" onClick={() => setTool('select')} disabled={busy}><SelectIcon /></button>
                <button className="btn" aria-pressed={tool === 'pen'} aria-label="펜 도구" title="펜 · P" onClick={() => setTool('pen')} disabled={busy}><PenIcon /></button>
                <button className="btn" aria-pressed={tool === 'rect'} aria-label="사각형 도구" title="사각형 · R" onClick={() => setTool('rect')} disabled={busy}><RectangleIcon /></button>
                <button className="btn" aria-pressed={tool === 'ellipse'} aria-label="원 도구" title="원 · E" onClick={() => setTool('ellipse')} disabled={busy}><EllipseIcon /></button>
                <span className="sep" />
                <button className="btn" aria-label="실행 취소" title="실행 취소 · Ctrl+Z" onClick={undo} disabled={!h.past.length || busy}><UndoIcon /></button>
                <button className="btn" aria-label="다시 실행" title="다시 실행 · Ctrl+Y" onClick={redo} disabled={!h.future.length || busy}><RedoIcon /></button>
              </div>
            )}
            <div className="legend" aria-hidden="true">
              {(['housing', 'reflector', 'slot', 'fabric', 'driver'] as const).map((r) => (
                <span key={r}><i style={{ background: ROLE_COLORS[r].fill, borderColor: ROLE_COLORS[r].stroke }} />{ROLE_COLORS[r].name}</span>
              ))}
              <span><i style={{ background: DRIVER_COLOR, borderColor: DRIVER_COLOR }} />드라이버</span>
              <span><i style={{ background: 'transparent', borderColor: MEASURE_COLOR, borderStyle: 'dashed' }} />측정 원호</span>
            </div>
          </div>

          <ResultsDock
            polarSeries={polarSeries} responseSeries={responseSeries} legend={legend}
            polarFreq={polarFreq} setPolarFreq={setPolarFreq} fMin={chartFMin} fMax={chartFMax}
            normalize={chartMode === 'sim' ? 'each' : 'shared'}
            responseTitle={chartMode === 'sim' ? '방향별' : `${sideAngle}° 측면 · 공통 기준`}
            contextLabel={chartMode === 'sim' ? '최근 해석' : chartMode === 'opt' ? `후보 ${compared.length}개 비교` : `안 ${comparedVariants.length}개 비교`}
            run={{ status, message, progress, result, warnings: runWarnings, backend: runMeta.backend, elapsedMs: runMeta.elapsedMs, cells, gridLabel: cells > 0 ? `${grid!.Nr} × ${grid!.Nz} · ${cells.toLocaleString()} cells` : undefined }}
            collapsed={ui.dockCollapsed} onToggle={() => setUi((u) => ({ ...u, dockCollapsed: !u.dockCollapsed }))}
            height={dockHeight} onResize={(h) => setUi((u) => ({ ...u, dockHeight: h }))}
            themeKey={theme}
          />
        </main>

        <Inspector
          scene={scene} onChange={(s) => updateEditedScene(s, true)}
          selection={preview ? null : selection} onSelect={setSelection}
          params={params} setParams={setParams} diagnostics={diagnostics}
          autoMeasure={autoMeasure} onAutoMeasureChange={changeAutoMeasure} onFitMeasure={fitMeasureNow}
          editable={editable} previewing={!!preview}
          parity={parity} parityBusy={parityBusy} onRunParity={runParity} busy={busy}
        />
      </div>
    </div>
  );
}
