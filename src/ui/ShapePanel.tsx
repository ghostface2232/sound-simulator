import { useEffect, useRef, useState } from 'react';
import type { Scene, Driver, ShapeRole, Material, PathNode } from '../engine/scene';
import { bandNodes, bandOf, cornerNode, defaultFabric, defaultSlot, driverBodyShape, materialForRole, maxAngleAboveFloor, rigidZRange, shapeToPath, smoothNode, type BandPlace, type Pt } from '../engine/geometry';
import { validateScene } from '../engine/checks';
import { sceneToSvg, svgToShapes } from '../engine/svg';
import { ROLE_COLORS, roleOf, type Selection } from './SectionCanvas';

interface Props {
  scene: Scene;
  onChange: (scene: Scene) => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
  autoMeasure: boolean;
  onAutoMeasureChange: (enabled: boolean) => void;
  onFitMeasure: () => void;
  editable: boolean;
}

const Num = ({ label, value, step = 0.5, onChange }: { label: string; value: number; step?: number; onChange: (v: number) => void }) => (
  <label>{label}
    <input type="number" step={step} value={Number.isFinite(value) ? value : ''} onChange={(e) => { const v = +e.target.value; if (Number.isFinite(v)) onChange(v); }} />
  </label>
);

export function ShapePanel(p: Props) {
  const { scene, selection } = p;
  const [jsonText, setJsonText] = useState('');
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [svgError, setSvgError] = useState<string | null>(null);
  const [svgPlacement, setSvgPlacement] = useState<'original' | 'zero' | 'device'>('original');
  const fileRef = useRef<HTMLInputElement>(null);
  const importReplaceRef = useRef(true);
  const [bandWhere, setBandWhere] = useState<BandPlace>('side');

  useEffect(() => { if (jsonOpen) setJsonText(JSON.stringify(scene, null, 2)); }, [scene, jsonOpen]);

  const applyJson = () => {
    try {
      const s = JSON.parse(jsonText) as unknown;
      const errs = validateScene(s).filter((d) => d.severity === 'error');
      if (errs.length) { setJsonError(errs.map((e) => e.message).join('\n')); return; }
      setJsonError(null);
      p.onChange(s as Scene);
      p.onSelect(null);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : String(err));
    }
  };

  const exportSvg = () => {
    const blob = new Blob([sceneToSvg(scene)], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${scene.name || 'section'}.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const importSvg = async (file: File, replace: boolean) => {
    try {
      let shapes = svgToShapes(await file.text()).map(shapeToPath);
      if (shapes.length === 0) throw new Error('SVG 에서 path/rect/polygon 을 찾지 못했습니다.');
      if (svgPlacement !== 'original') {
        const zs = shapes.flatMap((s) => s.nodes.map((n) => n.p[1]));
        const importedCenter = (Math.min(...zs) + Math.max(...zs)) / 2;
        const device = rigidZRange(scene);
        const dz = svgPlacement === 'zero' ? -Math.min(...zs) : (device.z0 + device.z1) / 2 - importedCenter;
        shapes = shapes.map((s) => ({
          ...s,
          nodes: s.nodes.map((n) => ({
            p: [n.p[0], n.p[1] + dz] as Pt,
            ...(n.hIn ? { hIn: [n.hIn[0], n.hIn[1] + dz] as Pt } : {}),
            ...(n.hOut ? { hOut: [n.hOut[0], n.hOut[1] + dz] as Pt } : {}),
          })),
        }));
      }
      setSvgError(null);
      p.onChange({ ...scene, shapes: replace ? shapes : [...scene.shapes, ...shapes] });
      p.onSelect(null);
    } catch (err) {
      setSvgError(err instanceof Error ? err.message : String(err));
    }
  };

  const setShape = (index: number, patch: Partial<{ role: ShapeRole; material: Material; label: string; sigma: number; nodes: PathNode[] }>) => {
    const shapes = scene.shapes.slice();
    const s = shapeToPath(shapes[index]);
    const role = patch.role ?? s.role ?? 'housing';
    const material = patch.material ?? (patch.role ? materialForRole(patch.role, s.material) : s.material);
    shapes[index] = {
      kind: 'path', nodes: patch.nodes ?? s.nodes, material, role,
      label: patch.label ?? s.label,
      ...(material === 'fabric' ? { sigma: patch.sigma ?? s.sigma ?? 2e5 } : {}),
    };
    p.onChange({ ...scene, shapes });
  };

  const setDriver = (index: number, d: Driver) => {
    const drivers = scene.drivers.slice();
    drivers[index] = d;
    p.onChange({ ...scene, drivers });
  };

  const addDriver = (kind: 'piston' | 'radial') => {
    const zTop = Math.max(0, ...scene.shapes.flatMap((s) => shapeToPath(s).nodes.map((n) => n.p[1])));
    const d: Driver = kind === 'piston'
      ? { kind: 'piston', z: zTop + 10, r: [0, 20], dir: '+z', label: `드라이버 ${scene.drivers.length + 1}` }
      : { kind: 'radial', r: 20, z: [zTop, zTop + 20], dir: '+r', label: `드라이버 ${scene.drivers.length + 1}` };
    p.onChange({ ...scene, drivers: [...scene.drivers, d] });
    p.onSelect({ kind: 'driver', index: scene.drivers.length });
  };

  const addDriverBody = () => {
    const di = selection?.kind === 'driver' ? selection.index : 0;
    const d = scene.drivers[di];
    if (!d) return;
    p.onChange({ ...scene, shapes: [...scene.shapes, driverBodyShape(d)] });
    p.onSelect({ kind: 'shape', index: scene.shapes.length });
  };

  let props: React.ReactNode;
  const selBand = selection?.kind === 'shape' && scene.shapes[selection.index] ? bandOf(scene.shapes[selection.index]) : null;
  if (selection?.kind === 'shapes') {
    const indices = selection.indices.filter((index) => !!scene.shapes[index]);
    props = (
      <>
        <h3>형상 {indices.length}개 선택</h3>
        <div className="multi-selection-summary">
          {indices.map((index) => {
            const shape = scene.shapes[index];
            const role = roleOf(shape);
            return <span key={index}><i className="dot" style={{ background: ROLE_COLORS[role].fill, borderColor: ROLE_COLORS[role].stroke }} />{shape.label || `형상 ${index + 1}`}</span>;
          })}
        </div>
        <div className="row">
          <button onClick={() => {
            const selected = new Set(indices);
            p.onChange({ ...scene, shapes: scene.shapes.filter((_, index) => !selected.has(index)) });
            p.onSelect(null);
          }}>선택 삭제</button>
        </div>
      </>
    );
  } else if (selection?.kind === 'shape' && selBand) {
    const s = shapeToPath(scene.shapes[selection.index]);
    const i = selection.index;
    const role = s.role ?? 'slot';
    const b = selBand;
    const setBand = (nb: Partial<typeof b>) => setShape(i, { nodes: bandNodes({ ...b, ...nb }) });
    props = (
      <>
        <h3><i className="dot" style={{ background: ROLE_COLORS[role].fill, borderColor: ROLE_COLORS[role].stroke }} />{ROLE_COLORS[role].name} {i + 1}{s.label ? ` · ${s.label}` : ''}</h3>
        <div className="grid2">
          {b.axis === 'z' ? (
            <>
              <Num label="시작 z (mm)" value={b.z0} onChange={(v) => setBand({ z0: v, z1: v + (b.z1 - b.z0) })} />
              <Num label={role === 'slot' ? '길이 (mm)' : '높이 (mm)'} value={b.z1 - b.z0} onChange={(v) => setBand({ z1: b.z0 + Math.max(0.5, v) })} />
              {role === 'fabric' ? (
                <>
                  <Num label="안쪽 r (mm)" value={b.r0} onChange={(v) => setBand({ r0: Math.max(0, v), r1: Math.max(0, v) + (b.r1 - b.r0) })} />
                  <Num label="두께 (mm)" value={b.r1 - b.r0} step={0.25} onChange={(v) => setBand({ r1: b.r0 + Math.max(0.25, v) })} />
                </>
              ) : (
                <>
                  <Num label="절단 안쪽 r (mm)" value={b.r0} onChange={(v) => setBand({ r0: Math.max(0, v) })} />
                  <Num label="절단 바깥 r (mm)" value={b.r1} onChange={(v) => setBand({ r1: v })} />
                </>
              )}
            </>
          ) : (
            <>
              <Num label="시작 r (mm)" value={b.r0} onChange={(v) => setBand({ r0: Math.max(0, v), r1: Math.max(0, v) + (b.r1 - b.r0) })} />
              <Num label="길이 (mm)" value={b.r1 - b.r0} onChange={(v) => setBand({ r1: b.r0 + Math.max(0.5, v) })} />
              {role === 'fabric' ? (
                <>
                  <Num label="아래 z (mm)" value={b.z0} onChange={(v) => setBand({ z0: v, z1: v + (b.z1 - b.z0) })} />
                  <Num label="두께 (mm)" value={b.z1 - b.z0} step={0.25} onChange={(v) => setBand({ z1: b.z0 + Math.max(0.25, v) })} />
                </>
              ) : (
                <>
                  <Num label="절단 아래 z (mm)" value={b.z0} onChange={(v) => setBand({ z0: v })} />
                  <Num label="절단 위 z (mm)" value={b.z1} onChange={(v) => setBand({ z1: v })} />
                </>
              )}
            </>
          )}
          {role === 'fabric' && <Num label="흐름저항 σ (Pa·s/m²)" value={s.sigma ?? 2e5} step={10000} onChange={(v) => setShape(i, { sigma: v })} />}
          <label>방향
            <select value={b.axis} onChange={(e) => { const shapes = scene.shapes.slice(); shapes[i] = { ...s, axis: e.target.value as 'z' | 'r' }; p.onChange({ ...scene, shapes }); }}>
              <option value="z">옆면 (z 방향)</option>
              <option value="r">윗면/아랫면 (r 방향)</option>
            </select>
          </label>
          <label>이름<input value={s.label ?? ''} onChange={(e) => setShape(i, { label: e.target.value })} /></label>
        </div>
        {role === 'slot' && <p className="muted small">절단 범위는 판을 완전히 통과해야 합니다.</p>}
        <div className="row">
          <button onClick={() => setShape(i, { role: 'other' })} title="띠 편집을 벗어나 앵커 4개를 자유롭게 편집">자유 형상으로 전환</button>
          <button onClick={() => { p.onChange({ ...scene, shapes: scene.shapes.filter((_, k) => k !== i) }); p.onSelect(null); }}>삭제</button>
        </div>
      </>
    );
  } else if (selection?.kind === 'shape' && scene.shapes[selection.index]) {
    const s = shapeToPath(scene.shapes[selection.index]);
    const nodes = s.nodes;
    const role = s.role ?? 'housing';
    const curved = nodes.some((n) => n.hIn || n.hOut);
    const setNodes = (ns: PathNode[]) => setShape(selection.index, { nodes: ns });
    props = (
      <>
        <h3><i className="dot" style={{ background: ROLE_COLORS[role].fill, borderColor: ROLE_COLORS[role].stroke }} />형상 {selection.index + 1}{s.label ? ` · ${s.label}` : ''}</h3>
        <div className="grid2">
          <label>역할
            <select value={role} onChange={(e) => setShape(selection.index, { role: e.target.value as ShapeRole })}>
              {(Object.keys(ROLE_COLORS) as ShapeRole[]).map((r) => <option key={r} value={r}>{ROLE_COLORS[r].name}</option>)}
            </select>
          </label>
          <label>재질
            <select value={s.material} onChange={(e) => setShape(selection.index, { material: e.target.value as Material })} disabled={role !== 'other'}>
              <option value="rigid">rigid (강체)</option>
              <option value="air">air (절단)</option>
              <option value="fabric">fabric (저항층)</option>
            </select>
          </label>
          <label>이름<input value={s.label ?? ''} onChange={(e) => setShape(selection.index, { label: e.target.value })} /></label>
          {s.material === 'fabric' && <Num label="흐름저항 σ (Pa·s/m²)" value={s.sigma ?? 2e5} step={10000} onChange={(v) => setShape(selection.index, { sigma: v })} />}
        </div>
        <details className="inline-disclosure shape-help">
          <summary><span>곡선 조작</span><span>{nodes.length}개 앵커{curved ? ' · 곡선 포함' : ''}</span></summary>
          <p className="muted small disclosure-content">더블클릭: 코너↔곡선/앵커 추가 · Alt+드래그: 핸들 분리 · Delete: 선택 삭제</p>
        </details>
        <div className="row">
          <button onClick={() => setNodes(nodes.map((_, i) => smoothNode(nodes, i)))} title="모든 앵커에 접선 핸들을 만들어 부드럽게">모두 곡선</button>
          <button onClick={() => setNodes(nodes.map(cornerNode))} title="모든 핸들 제거">모두 직선</button>
        </div>
        <div className="row">
          <button onClick={() => { p.onChange({ ...scene, shapes: [...scene.shapes, { ...s, nodes: nodes.map((n) => ({ p: [n.p[0] + 5, n.p[1] + 5] as Pt, ...(n.hIn ? { hIn: [n.hIn[0] + 5, n.hIn[1] + 5] as Pt } : {}), ...(n.hOut ? { hOut: [n.hOut[0] + 5, n.hOut[1] + 5] as Pt } : {}) })), label: `${s.label ?? 'shape'} copy` }] }); p.onSelect({ kind: 'shape', index: scene.shapes.length }); }}>복제</button>
          <button onClick={() => { p.onChange({ ...scene, shapes: scene.shapes.filter((_, i) => i !== selection.index) }); p.onSelect(null); }}>삭제</button>
        </div>
      </>
    );
  } else if (selection?.kind === 'driver' && scene.drivers[selection.index]) {
    const d = scene.drivers[selection.index];
    const i = selection.index;
    props = (
      <>
        <h3><i className="dot" style={{ background: '#e0245e', borderColor: '#e0245e' }} />드라이버 {i + 1}{d.label ? ` · ${d.label}` : ''}</h3>
        <div className="grid2">
          <label>종류
            <select value={d.kind} onChange={(e) => {
              const kind = e.target.value as Driver['kind'];
              const nd: Driver = kind === 'piston'
                ? { kind: 'piston', z: d.kind === 'piston' ? d.z : d.z[0], r: d.kind === 'piston' ? d.r : [0, 20], dir: '+z', label: d.label }
                : { kind: 'radial', r: d.kind === 'radial' ? d.r : 20, z: d.kind === 'radial' ? d.z : [d.z, d.z + 20], dir: '+r', label: d.label };
              setDriver(i, nd);
            }}>
              <option value="piston">피스톤 (축 방향)</option>
              <option value="radial">방사형 (반경 방향)</option>
            </select>
          </label>
          <label>방향
            {d.kind === 'piston'
              ? <select value={d.dir} onChange={(e) => setDriver(i, { ...d, dir: e.target.value as '+z' | '-z' })}><option value="+z">+z (위)</option><option value="-z">-z (아래)</option></select>
              : <select value={d.dir} onChange={(e) => setDriver(i, { ...d, dir: e.target.value as '+r' | '-r' })}><option value="+r">+r (바깥)</option><option value="-r">-r (안쪽)</option></select>}
          </label>
          {d.kind === 'piston' ? (
            <>
              <Num label="높이 z (mm)" value={d.z} onChange={(v) => setDriver(i, { ...d, z: v })} />
              <Num label="안쪽 반경 r₀" value={Math.min(...d.r)} onChange={(v) => setDriver(i, { ...d, r: [Math.max(0, v), Math.max(...d.r)] })} />
              <Num label="바깥 반경 r₁" value={Math.max(...d.r)} onChange={(v) => setDriver(i, { ...d, r: [Math.min(...d.r), v] })} />
            </>
          ) : (
            <>
              <Num label="반경 r (mm)" value={d.r} onChange={(v) => setDriver(i, { ...d, r: Math.max(0.5, v) })} />
              <Num label="z 시작" value={Math.min(...d.z)} onChange={(v) => setDriver(i, { ...d, z: [v, Math.max(...d.z)] })} />
              <Num label="z 끝" value={Math.max(...d.z)} onChange={(v) => setDriver(i, { ...d, z: [Math.min(...d.z), v] })} />
            </>
          )}
          <label>이름<input value={d.label ?? ''} onChange={(e) => setDriver(i, { ...d, label: e.target.value })} /></label>
        </div>
        <div className="row"><button onClick={() => { p.onChange({ ...scene, drivers: scene.drivers.filter((_, k) => k !== i) }); p.onSelect(null); }}>삭제</button></div>
      </>
    );
  } else if (selection?.kind === 'measure') {
    const m = scene.measure;
    props = (
      <>
        <h3><i className="dot" style={{ background: 'transparent', borderColor: '#2e9e5b' }} />측정 원호</h3>
        <div className="measure-auto-row">
          <label className="inline"><input type="checkbox" checked={p.autoMeasure} onChange={(e) => p.onAutoMeasureChange(e.target.checked)} /> 측정·해석 공간 자동 맞춤</label>
          <button className="mini" onClick={p.onFitMeasure}>지금 맞춤</button>
        </div>
        <div className="grid2">
          <Num label="반경 (mm)" value={m.radius} step={5} onChange={(v) => p.onChange({ ...scene, measure: { ...m, radius: Math.max(5, v) } })} />
          <Num label="중심 z (mm)" value={m.zCenter} onChange={(v) => p.onChange({ ...scene, measure: { ...m, zCenter: v } })} />
          <Num label="각도 간격 (°)" value={m.angleStep} step={1} onChange={(v) => p.onChange({ ...scene, measure: { ...m, angleStep: Math.min(180, Math.max(1, v)) } })} />
          <Num label="최대 각도 (°)" value={m.angleMax ?? 180} step={5} onChange={(v) => p.onChange({ ...scene, measure: { ...m, angleMax: Math.min(180, Math.max(5, v)) } })} />
        </div>
      </>
    );
  } else {
    const d = scene.domain;
    props = (
      <details className="domain-disclosure">
        <summary><span>측정 환경</span><span className="summary-value">{d.rMax} × {d.zMax - d.zMin} mm</span></summary>
        <div className="domain-settings disclosure-content">
          <h3>해석 영역</h3>
          <div className="grid3 domain-grid">
            <Num label="rMax (mm)" value={d.rMax} step={10} onChange={(v) => p.onChange({ ...scene, domain: { ...d, rMax: Math.max(20, v) } })} />
            <Num label="zMin (mm)" value={d.zMin} step={10} onChange={(v) => p.onChange({ ...scene, domain: { ...d, zMin: v } })} />
            <Num label="zMax (mm)" value={d.zMax} step={10} onChange={(v) => p.onChange({ ...scene, domain: { ...d, zMax: v } })} />
          </div>
          <h3>바닥</h3>
          <div className="floor-controls">
            <label className="inline floor-toggle"><input type="checkbox" checked={!!scene.floor?.enabled} onChange={(e) => {
              const z = scene.floor?.z ?? rigidZRange(scene).z0;
              const next: Scene = { ...scene, floor: { enabled: e.target.checked, z } };
              if (e.target.checked) next.measure = { ...next.measure, angleMax: Math.min(next.measure.angleMax ?? 180, maxAngleAboveFloor(next)) };
              p.onChange(next);
            }} /> 바닥</label>
            <Num label="바닥 z (mm)" value={scene.floor?.z ?? rigidZRange(scene).z0} onChange={(v) => {
              const next: Scene = { ...scene, floor: { enabled: scene.floor?.enabled ?? false, z: v } };
              if (next.floor!.enabled) next.measure = { ...next.measure, angleMax: Math.min(next.measure.angleMax ?? 180, maxAngleAboveFloor(next)) };
              p.onChange(next);
            }} />
          </div>
        </div>
      </details>
    );
  }

  const sourceActions = (
    <section className="source-actions" aria-label="새 설계 또는 SVG 가져오기">
      <div className="subsection-heading"><span>설계 소스</span></div>
      <label>SVG 첫 배치
        <select value={svgPlacement} onChange={(e) => setSvgPlacement(e.target.value as typeof svgPlacement)}>
          <option value="original">원래 좌표 유지</option>
          <option value="zero">형상 아래를 z = 0에</option>
          <option value="device">현재 기기 높이에 맞춤</option>
        </select>
      </label>
      <div className="source-primary-actions">
        <button className="primary" onClick={() => { importReplaceRef.current = true; fileRef.current?.click(); }} disabled={!p.editable}>SVG 불러오기</button>
        <button onClick={() => { importReplaceRef.current = false; fileRef.current?.click(); }} disabled={!p.editable}>현재 설계에 추가</button>
      </div>
      <div className="source-secondary-actions">
        <button onClick={() => { p.onChange({ ...scene, name: 'untitled', description: '', shapes: [], drivers: [] }); p.onSelect(null); }} disabled={!p.editable}>빈 설계로 시작</button>
        <button onClick={exportSvg}>SVG 내보내기</button>
      </div>
      <input ref={fileRef} type="file" accept=".svg,image/svg+xml" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) importSvg(f, importReplaceRef.current); e.target.value = ''; }} />
      {svgError && <p className="error">{svgError}</p>}
    </section>
  );

  return (
    <div className="shape-panel">
      {!selection && sourceActions}
      <div className={`props ${selection ? '' : 'props-collapsed'}`}>{props}</div>
      {selection && sourceActions}

      <section className="part-library" aria-label="요소 추가">
        <div className="subsection-heading"><span>요소 추가</span></div>
        <div className="add-grid">
          <button onClick={() => addDriver('piston')} disabled={!p.editable}>피스톤 드라이버</button>
          <button onClick={() => addDriver('radial')} disabled={!p.editable}>방사형 드라이버</button>
          <label>부착 면
            <select value={bandWhere} onChange={(e) => setBandWhere(e.target.value as BandPlace)}>
              <option value="side">옆면</option>
              <option value="top">윗면</option>
              <option value="bottom">아랫면</option>
            </select>
          </label>
          <div className="row add-band-actions">
            <button onClick={() => { p.onChange({ ...scene, shapes: [...scene.shapes, defaultSlot(scene, bandWhere)] }); p.onSelect({ kind: 'shape', index: scene.shapes.length }); }} disabled={!p.editable}>슬롯</button>
            <button onClick={() => { p.onChange({ ...scene, shapes: [...scene.shapes, defaultFabric(scene, bandWhere)] }); p.onSelect({ kind: 'shape', index: scene.shapes.length }); }} disabled={!p.editable}>패브릭</button>
          </div>
        </div>
        <button className="wide-secondary" onClick={addDriverBody} disabled={!p.editable || scene.drivers.length === 0}>드라이버 몸체 추가</button>
      </section>

      <details className="inline-disclosure" open={jsonOpen} onToggle={(e) => setJsonOpen((e.target as HTMLDetailsElement).open)}>
        <summary>씬 JSON (고급)</summary>
        <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} />
        <div className="row"><button onClick={applyJson}>JSON 적용</button></div>
        {jsonError && <p className="error">{jsonError}</p>}
      </details>
    </div>
  );
}
