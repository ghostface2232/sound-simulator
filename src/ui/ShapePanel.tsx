import { useEffect, useState } from 'react';
import type { Scene, Driver, ShapeRole, Material } from '../engine/scene';
import { materialForRole, shapeToPolygon, type Pt } from '../engine/geometry';
import { validateScene } from '../engine/checks';
import { ROLE_COLORS, type Selection, type Tool } from './SectionCanvas';

interface Props {
  scene: Scene;
  onChange: (scene: Scene) => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
  tool: Tool;
  setTool: (t: Tool) => void;
  showGrid: boolean;
  setShowGrid: (v: boolean) => void;
  onFitDevice: () => void;
  onFitDomain: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
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

  const setShape = (index: number, patch: Partial<{ role: ShapeRole; material: Material; label: string; sigma: number; points: Pt[] }>) => {
    const shapes = scene.shapes.slice();
    const s = shapes[index];
    const pts = patch.points ?? shapeToPolygon(s);
    const role = patch.role ?? s.role ?? (s.material === 'rigid' ? 'housing' : s.material === 'fabric' ? 'fabric' : 'slot');
    const material = patch.material ?? (patch.role ? materialForRole(patch.role, s.material) : s.material);
    shapes[index] = {
      kind: 'polygon', points: pts, material, role,
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
    const b = scene.shapes.length ? shapeToPolygon(scene.shapes[0]) : [[0, 0] as Pt];
    const zTop = Math.max(...b.map((q) => q[1]), 0);
    const d: Driver = kind === 'piston'
      ? { kind: 'piston', z: zTop + 10, r: [0, 20], dir: '+z', label: `driver ${scene.drivers.length + 1}` }
      : { kind: 'radial', r: 20, z: [zTop, zTop + 20], dir: '+r', label: `driver ${scene.drivers.length + 1}` };
    p.onChange({ ...scene, drivers: [...scene.drivers, d] });
    p.onSelect({ kind: 'driver', index: scene.drivers.length });
  };

  const toolBtn = (t: Tool, name: string, hint: string) => (
    <button className={p.tool === t ? 'active' : ''} onClick={() => p.setTool(t)} title={hint} disabled={!p.editable}>{name}</button>
  );

  let props: React.ReactNode;
  if (selection?.kind === 'shape' && scene.shapes[selection.index]) {
    const s = scene.shapes[selection.index];
    const pts = shapeToPolygon(s);
    const role = s.role ?? (s.material === 'rigid' ? 'housing' : s.material === 'fabric' ? 'fabric' : 'slot');
    const vi = selection.vertex;
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
        <p className="muted small">정점 {pts.length}개. 정점을 드래그해 이동, 선을 더블클릭해 정점 추가, Delete 로 정점/형상 삭제.</p>
        {vi !== undefined && pts[vi] && (
          <div className="grid2">
            <Num label={`정점 ${vi + 1} r (mm)`} value={pts[vi][0]} onChange={(v) => { const q = pts.map((x) => [x[0], x[1]] as Pt); q[vi] = [Math.max(0, v), q[vi][1]]; setShape(selection.index, { points: q }); }} />
            <Num label={`정점 ${vi + 1} z (mm)`} value={pts[vi][1]} onChange={(v) => { const q = pts.map((x) => [x[0], x[1]] as Pt); q[vi] = [q[vi][0], v]; setShape(selection.index, { points: q }); }} />
          </div>
        )}
        <div className="row">
          <button onClick={() => { p.onChange({ ...scene, shapes: [...scene.shapes, { ...s, kind: 'polygon', points: pts.map((q) => [q[0] + 5, q[1] + 5] as Pt), label: `${s.label ?? 'shape'} copy` }] }); p.onSelect({ kind: 'shape', index: scene.shapes.length }); }}>복제</button>
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
        <p className="muted small">끝점을 드래그해 크기를, 선을 드래그해 위치를 바꿉니다. 진동판 뒤 2 mm 는 고체로 취급됩니다.</p>
        <div className="row"><button onClick={() => { p.onChange({ ...scene, drivers: scene.drivers.filter((_, k) => k !== i) }); p.onSelect(null); }}>삭제</button></div>
      </>
    );
  } else if (selection?.kind === 'measure') {
    const m = scene.measure;
    props = (
      <>
        <h3><i className="dot" style={{ background: 'transparent', borderColor: '#2e9e5b' }} />측정 원호</h3>
        <div className="grid2">
          <Num label="반경 (mm)" value={m.radius} step={5} onChange={(v) => p.onChange({ ...scene, measure: { ...m, radius: Math.max(5, v) } })} />
          <Num label="중심 z (mm)" value={m.zCenter} onChange={(v) => p.onChange({ ...scene, measure: { ...m, zCenter: v } })} />
          <Num label="각도 간격 (°)" value={m.angleStep} step={1} onChange={(v) => p.onChange({ ...scene, measure: { ...m, angleStep: Math.min(180, Math.max(1, v)) } })} />
          <Num label="최대 각도 (°)" value={m.angleMax ?? 180} step={5} onChange={(v) => p.onChange({ ...scene, measure: { ...m, angleMax: Math.min(180, Math.max(5, v)) } })} />
        </div>
        <p className="muted small">위쪽 핸들로 반경, 중심 핸들로 높이를 바꿉니다. 0° = +z, 90° = 측면.</p>
      </>
    );
  } else {
    const d = scene.domain;
    props = (
      <>
        <h3>도메인</h3>
        <div className="grid3">
          <Num label="rMax (mm)" value={d.rMax} step={10} onChange={(v) => p.onChange({ ...scene, domain: { ...d, rMax: Math.max(20, v) } })} />
          <Num label="zMin (mm)" value={d.zMin} step={10} onChange={(v) => p.onChange({ ...scene, domain: { ...d, zMin: v } })} />
          <Num label="zMax (mm)" value={d.zMax} step={10} onChange={(v) => p.onChange({ ...scene, domain: { ...d, zMax: v } })} />
        </div>
        <p className="muted small">요소를 클릭하면 속성이 여기에 나타납니다. 빈 곳 드래그로 이동, 휠로 확대. 회색 띠는 흡수층입니다.</p>
      </>
    );
  }

  return (
    <div className="shape-panel">
      <div className="toolbar">
        {toolBtn('select', '선택', '클릭·드래그로 요소 편집 (V)')}
        {toolBtn('pen', '펜', '클릭으로 정점 추가, 시작점 클릭 또는 Enter 로 닫기')}
        {toolBtn('rect', '사각형', '드래그로 사각형 추가')}
        <button onClick={() => addDriver('piston')} disabled={!p.editable} title="피스톤 드라이버 추가">+피스톤</button>
        <button onClick={() => addDriver('radial')} disabled={!p.editable} title="방사형 드라이버 추가">+방사</button>
      </div>
      <div className="toolbar">
        <button onClick={p.onUndo} disabled={!p.canUndo} title="Ctrl+Z">↶ 실행취소</button>
        <button onClick={p.onRedo} disabled={!p.canRedo} title="Ctrl+Y">↷ 다시실행</button>
        <button onClick={p.onFitDevice}>기기 맞춤</button>
        <button onClick={p.onFitDomain}>전체 도메인</button>
        <label className="inline"><input type="checkbox" checked={p.showGrid} onChange={(e) => p.setShowGrid(e.target.checked)} /> 격자 마스크</label>
      </div>

      <div className="props">{props}</div>

      <details open={jsonOpen} onToggle={(e) => setJsonOpen((e.target as HTMLDetailsElement).open)}>
        <summary>씬 JSON (고급)</summary>
        <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} />
        <div className="row"><button onClick={applyJson}>JSON 적용</button></div>
        {jsonError && <p className="error">{jsonError}</p>}
      </details>
    </div>
  );
}
