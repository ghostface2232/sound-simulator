import { useEffect, useRef, useState } from 'react';
import type { Scene, Driver, ShapeRole, Material, PathNode } from '../engine/scene';
import { cornerNode, driverBodyShape, isSmoothNode, materialForRole, shapeToPath, smoothNode, type Pt } from '../engine/geometry';
import { validateScene } from '../engine/checks';
import { sceneToSvg, svgToShapes } from '../engine/svg';
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
  const [svgError, setSvgError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const importReplaceRef = useRef(true);

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
      const shapes = svgToShapes(await file.text());
      if (shapes.length === 0) throw new Error('SVG 에서 path/rect/polygon 을 찾지 못했습니다.');
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
      ? { kind: 'piston', z: zTop + 10, r: [0, 20], dir: '+z', label: `driver ${scene.drivers.length + 1}` }
      : { kind: 'radial', r: 20, z: [zTop, zTop + 20], dir: '+r', label: `driver ${scene.drivers.length + 1}` };
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

  const toolBtn = (t: Tool, name: string, hint: string) => (
    <button className={p.tool === t ? 'active' : ''} onClick={() => p.setTool(t)} title={hint} disabled={!p.editable}>{name}</button>
  );

  let props: React.ReactNode;
  if (selection?.kind === 'shape' && scene.shapes[selection.index]) {
    const s = shapeToPath(scene.shapes[selection.index]);
    const nodes = s.nodes;
    const role = s.role ?? 'housing';
    const vi = selection.vertex;
    const node = vi !== undefined ? nodes[vi] : undefined;
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
        <p className="muted small">앵커 {nodes.length}개{curved ? ', 곡선 포함' : ''}. 앵커 드래그 이동 · 앵커 더블클릭 코너↔곡선 · 선 더블클릭 앵커 삽입 · 핸들 드래그(Alt 로 비대칭) · Delete 로 핸들/앵커/형상 삭제.</p>
        <div className="row">
          <button onClick={() => setNodes(nodes.map((_, i) => smoothNode(nodes, i)))} title="모든 앵커에 접선 핸들을 만들어 부드럽게">모두 곡선</button>
          <button onClick={() => setNodes(nodes.map(cornerNode))} title="모든 핸들 제거">모두 직선</button>
        </div>
        {node && vi !== undefined && (
          <>
            <div className="grid2">
              <Num label={`앵커 ${vi + 1} r`} value={node.p[0]} onChange={(v) => { const ns = nodes.map((n) => ({ ...n })); const dr = Math.max(0, v) - node.p[0]; ns[vi] = { p: [node.p[0] + dr, node.p[1]], ...(node.hIn ? { hIn: [node.hIn[0] + dr, node.hIn[1]] as Pt } : {}), ...(node.hOut ? { hOut: [node.hOut[0] + dr, node.hOut[1]] as Pt } : {}) }; setNodes(ns); }} />
              <Num label={`앵커 ${vi + 1} z`} value={node.p[1]} onChange={(v) => { const ns = nodes.map((n) => ({ ...n })); const dz = v - node.p[1]; ns[vi] = { p: [node.p[0], node.p[1] + dz], ...(node.hIn ? { hIn: [node.hIn[0], node.hIn[1] + dz] as Pt } : {}), ...(node.hOut ? { hOut: [node.hOut[0], node.hOut[1] + dz] as Pt } : {}) }; setNodes(ns); }} />
              {node.hIn && <Num label="핸들 in r" value={node.hIn[0]} step={0.1} onChange={(v) => { const ns = nodes.map((n) => ({ ...n })); ns[vi] = { ...node, hIn: [Math.max(0, v), node.hIn![1]] }; setNodes(ns); }} />}
              {node.hIn && <Num label="핸들 in z" value={node.hIn[1]} step={0.1} onChange={(v) => { const ns = nodes.map((n) => ({ ...n })); ns[vi] = { ...node, hIn: [node.hIn![0], v] }; setNodes(ns); }} />}
              {node.hOut && <Num label="핸들 out r" value={node.hOut[0]} step={0.1} onChange={(v) => { const ns = nodes.map((n) => ({ ...n })); ns[vi] = { ...node, hOut: [Math.max(0, v), node.hOut![1]] }; setNodes(ns); }} />}
              {node.hOut && <Num label="핸들 out z" value={node.hOut[1]} step={0.1} onChange={(v) => { const ns = nodes.map((n) => ({ ...n })); ns[vi] = { ...node, hOut: [node.hOut![0], v] }; setNodes(ns); }} />}
            </div>
            <div className="row">
              <span className="muted small">앵커 유형: {node.hIn || node.hOut ? (isSmoothNode(node) ? '곡선(대칭)' : '곡선(비대칭)') : '코너'}</span>
              <button className="mini" onClick={() => { const ns = nodes.map((n) => ({ ...n })); ns[vi] = node.hIn || node.hOut ? cornerNode(node) : smoothNode(nodes, vi); setNodes(ns); }}>
                {node.hIn || node.hOut ? '코너로' : '곡선으로'}
              </button>
            </div>
          </>
        )}
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
        {toolBtn('pen', '펜', '클릭 = 코너 앵커, 클릭-드래그 = 곡선 앵커, 시작점 클릭 또는 Enter 로 닫기 (P)')}
        {toolBtn('rect', '사각형', '드래그로 사각형 추가 (R), Shift = 정사각형')}
        {toolBtn('ellipse', '원', '드래그로 타원 추가 (E), Shift = 원')}
        <button onClick={() => addDriver('piston')} disabled={!p.editable} title="피스톤 드라이버 추가">+피스톤</button>
        <button onClick={() => addDriver('radial')} disabled={!p.editable} title="방사형 드라이버 추가">+방사</button>
        <button onClick={addDriverBody} disabled={!p.editable || scene.drivers.length === 0} title="선택한(또는 첫) 드라이버 뒤에 바스켓·마그넷 몸체를 추가. 이후 자유롭게 편집">+드라이버 몸체</button>
      </div>
      <div className="toolbar">
        <button onClick={p.onUndo} disabled={!p.canUndo} title="Ctrl+Z">↶</button>
        <button onClick={p.onRedo} disabled={!p.canRedo} title="Ctrl+Y">↷</button>
        <button onClick={p.onFitDevice}>기기 맞춤</button>
        <button onClick={p.onFitDomain}>전체 도메인</button>
        <label className="inline"><input type="checkbox" checked={p.showGrid} onChange={(e) => p.setShowGrid(e.target.checked)} /> 격자 마스크</label>
      </div>
      <div className="toolbar">
        <button onClick={exportSvg} title="단면을 SVG 로 저장 (1 unit = 1 mm). Figma/Illustrator 에서 열 수 있습니다.">SVG 내보내기</button>
        <button onClick={() => { importReplaceRef.current = true; fileRef.current?.click(); }} disabled={!p.editable} title="SVG 를 불러와 형상을 교체 (1 unit = 1 mm, y 아래 = -z)">SVG 가져오기</button>
        <button onClick={() => { importReplaceRef.current = false; fileRef.current?.click(); }} disabled={!p.editable} title="SVG 의 형상을 현재 씬에 추가">SVG 추가</button>
        <input ref={fileRef} type="file" accept=".svg,image/svg+xml" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) importSvg(f, importReplaceRef.current); e.target.value = ''; }} />
      </div>
      {svgError && <p className="error">{svgError}</p>}

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
