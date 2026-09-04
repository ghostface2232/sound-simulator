import type { Scene, Driver, ShapeRole, Material, PathNode, SimParams } from '../engine/scene';
import type { Diagnostic } from '../engine/checks';
import type { ParityReport } from '../engine/runner';
import { bandNodes, bandOf, cornerNode, materialForRole, maxAngleAboveFloor, rigidZRange, shapeToPath, shapeToPolygon, smoothNode, type Pt } from '../engine/geometry';
import { ROLE_COLORS, roleOf, type Selection } from './SectionCanvas';
import { DiagnosticList, NumField, Section, SelectField, TextField } from './fields';
import { CopyIcon, DomainIcon, DriverIcon, InfoIcon, LayersIcon, MeasureIcon, RadialDriverIcon, TrashIcon } from './Icons';

interface Props {
  scene: Scene;
  onChange: (scene: Scene) => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
  params: SimParams;
  setParams: (p: SimParams) => void;
  diagnostics: Diagnostic[];
  autoMeasure: boolean;
  onAutoMeasureChange: (enabled: boolean) => void;
  onFitMeasure: () => void;
  editable: boolean;
  previewing: boolean;
  parity: ParityReport | null;
  parityBusy: boolean;
  onRunParity: () => void;
  busy: boolean;
}

const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

export function Inspector(p: Props) {
  const { scene, selection, params } = p;
  const changeScene = (next: Scene) => { if (p.editable) p.onChange(next); };
  const setShape = (index: number, patch: Partial<{ role: ShapeRole; material: Material; label: string; sigma: number; nodes: PathNode[] }>) => {
    if (!p.editable) return;
    const shapes = scene.shapes.slice();
    const s = shapeToPath(shapes[index]);
    const role = patch.role ?? s.role ?? 'housing';
    const material = patch.material ?? (patch.role ? materialForRole(patch.role, s.material) : s.material);
    shapes[index] = {
      kind: 'path', nodes: patch.nodes ?? s.nodes, material, role,
      label: patch.label ?? s.label,
      ...(s.axis ? { axis: s.axis } : {}),
      ...(material === 'fabric' ? { sigma: patch.sigma ?? s.sigma ?? 2e5 } : {}),
    };
    changeScene({ ...scene, shapes });
  };
  const setDriver = (index: number, d: Driver) => {
    if (!p.editable) return;
    const drivers = scene.drivers.slice();
    drivers[index] = d;
    changeScene({ ...scene, drivers });
  };
  const setParam = (key: keyof SimParams, v: number) => { if (p.editable) p.setParams({ ...params, [key]: v }); };

  let head: React.ReactNode;
  let body: React.ReactNode;
  const selBand = selection?.kind === 'shape' && scene.shapes[selection.index] ? bandOf(scene.shapes[selection.index]) : null;

  if (selection?.kind === 'shapes') {
    const indices = selection.indices.filter((index) => !!scene.shapes[index]);
    head = <Head glyph={<LayersIcon />} title={`형상 ${indices.length}개 선택`} sub="Shift+클릭으로 선택을 더하거나 뺍니다" />;
    body = (
      <Section title="선택 항목">
        <div className="multi-list">
          {indices.map((index) => {
            const shape = scene.shapes[index];
            const role = roleOf(shape);
            return <span key={index}><i style={{ background: ROLE_COLORS[role].fill, borderColor: ROLE_COLORS[role].stroke }} />{shape.label || `${ROLE_COLORS[role].name} ${index + 1}`}</span>;
          })}
        </div>
        <button className="btn danger" onClick={() => { const set = new Set(indices); changeScene({ ...scene, shapes: scene.shapes.filter((_, i) => !set.has(i)) }); p.onSelect(null); }} disabled={!p.editable}><TrashIcon />선택 삭제</button>
      </Section>
    );
  } else if (selection?.kind === 'shape' && selBand) {
    const i = selection.index;
    const s = shapeToPath(scene.shapes[i]);
    const role = s.role ?? 'slot';
    const b = selBand;
    const setBand = (nb: Partial<typeof b>) => setShape(i, { nodes: bandNodes({ ...b, ...nb }) });
    head = <Head swatch={role} title={s.label || `${ROLE_COLORS[role].name} ${i + 1}`} sub={`${ROLE_COLORS[role].name} 띠 · ${b.axis === 'z' ? '옆면' : '윗면/아랫면'}`} />;
    body = (
      <>
        <Section title="띠">
          <div className="prop-grid">
            <TextField label="이름" value={s.label ?? ''} onChange={(v) => setShape(i, { label: v })} disabled={!p.editable} />
            <SelectField label="방향" value={b.axis} onChange={(v) => { const shapes = scene.shapes.slice(); shapes[i] = { ...s, axis: v }; changeScene({ ...scene, shapes }); }} disabled={!p.editable}
              options={[{ value: 'z', label: '옆면 (z 방향)' }, { value: 'r', label: '윗면/아랫면 (r 방향)' }]} />
            {b.axis === 'z' ? (
              <>
                <NumField label="시작 z" unit="mm" value={b.z0} onChange={(v) => setBand({ z0: v, z1: v + (b.z1 - b.z0) })} disabled={!p.editable} />
                <NumField label={role === 'slot' ? '길이' : '높이'} unit="mm" value={b.z1 - b.z0} onChange={(v) => setBand({ z1: b.z0 + Math.max(0.5, v) })} disabled={!p.editable} />
                {role === 'fabric' ? (
                  <>
                    <NumField label="안쪽 r" unit="mm" value={b.r0} onChange={(v) => setBand({ r0: Math.max(0, v), r1: Math.max(0, v) + (b.r1 - b.r0) })} disabled={!p.editable} />
                    <NumField label="두께" unit="mm" step={0.25} value={b.r1 - b.r0} onChange={(v) => setBand({ r1: b.r0 + Math.max(0.25, v) })} disabled={!p.editable} />
                  </>
                ) : (
                  <>
                    <NumField label="절단 안쪽 r" unit="mm" value={b.r0} onChange={(v) => setBand({ r0: Math.max(0, v) })} disabled={!p.editable} />
                    <NumField label="절단 바깥 r" unit="mm" value={b.r1} onChange={(v) => setBand({ r1: v })} disabled={!p.editable} />
                  </>
                )}
              </>
            ) : (
              <>
                <NumField label="시작 r" unit="mm" value={b.r0} onChange={(v) => setBand({ r0: Math.max(0, v), r1: Math.max(0, v) + (b.r1 - b.r0) })} disabled={!p.editable} />
                <NumField label="길이" unit="mm" value={b.r1 - b.r0} onChange={(v) => setBand({ r1: b.r0 + Math.max(0.5, v) })} disabled={!p.editable} />
                {role === 'fabric' ? (
                  <>
                    <NumField label="아래 z" unit="mm" value={b.z0} onChange={(v) => setBand({ z0: v, z1: v + (b.z1 - b.z0) })} disabled={!p.editable} />
                    <NumField label="두께" unit="mm" step={0.25} value={b.z1 - b.z0} onChange={(v) => setBand({ z1: b.z0 + Math.max(0.25, v) })} disabled={!p.editable} />
                  </>
                ) : (
                  <>
                    <NumField label="절단 아래 z" unit="mm" value={b.z0} onChange={(v) => setBand({ z0: v })} disabled={!p.editable} />
                    <NumField label="절단 위 z" unit="mm" value={b.z1} onChange={(v) => setBand({ z1: v })} disabled={!p.editable} />
                  </>
                )}
              </>
            )}
            {role === 'fabric' && <NumField label="흐름저항 σ" unit="Pa·s/m²" step={10000} value={s.sigma ?? 2e5} onChange={(v) => setShape(i, { sigma: v })} disabled={!p.editable} />}
          </div>
          {role === 'slot' && <p className="help">절단 범위는 판 두께를 완전히 통과해야 합니다.</p>}
        </Section>
        <Section title="작업" open={false}>
          <div className="action-row">
            <button className="btn" onClick={() => setShape(i, { role: 'other' })} title="띠 편집을 벗어나 앵커 4개를 자유롭게 편집" disabled={!p.editable}>자유 형상으로 전환</button>
            <button className="btn danger" onClick={() => { changeScene({ ...scene, shapes: scene.shapes.filter((_, k) => k !== i) }); p.onSelect(null); }} disabled={!p.editable}><TrashIcon />삭제</button>
          </div>
        </Section>
      </>
    );
  } else if (selection?.kind === 'shape' && scene.shapes[selection.index]) {
    const i = selection.index;
    const s = shapeToPath(scene.shapes[i]);
    const nodes = s.nodes;
    const role = s.role ?? 'housing';
    const curved = nodes.some((n) => n.hIn || n.hOut);
    const setNodes = (ns: PathNode[]) => setShape(i, { nodes: ns });
    const poly = shapeToPolygon(scene.shapes[i]);
    const rs = poly.map((q) => q[0]), zs = poly.map((q) => q[1]);
    head = (
      <Head swatch={role} title={s.label || `${ROLE_COLORS[role].name} ${i + 1}`} sub={`${ROLE_COLORS[role].name} · 앵커 ${nodes.length}개${curved ? ' · 곡선' : ''}`}
        actions={<>
          <button className="btn icon sm ghost" title="복제" aria-label="복제" disabled={!p.editable} onClick={() => { changeScene({ ...scene, shapes: [...scene.shapes, { ...s, nodes: nodes.map((n) => ({ p: [n.p[0] + 5, n.p[1] + 5] as Pt, ...(n.hIn ? { hIn: [n.hIn[0] + 5, n.hIn[1] + 5] as Pt } : {}), ...(n.hOut ? { hOut: [n.hOut[0] + 5, n.hOut[1] + 5] as Pt } : {}) })), label: `${s.label ?? 'shape'} copy` }] }); p.onSelect({ kind: 'shape', index: scene.shapes.length }); }}><CopyIcon /></button>
          <button className="btn icon sm ghost danger" title="삭제" aria-label="삭제" disabled={!p.editable} onClick={() => { changeScene({ ...scene, shapes: scene.shapes.filter((_, k) => k !== i) }); p.onSelect(null); }}><TrashIcon /></button>
        </>} />
    );
    body = (
      <>
        <Section title="형상">
          <div className="prop-grid">
            <TextField label="이름" value={s.label ?? ''} onChange={(v) => setShape(i, { label: v })} disabled={!p.editable} />
            <SelectField label="역할" value={role} onChange={(v) => setShape(i, { role: v })}
              options={(Object.keys(ROLE_COLORS) as ShapeRole[]).map((r) => ({ value: r, label: ROLE_COLORS[r].name }))} disabled={!p.editable} />
            <SelectField label="재질" value={s.material} onChange={(v) => setShape(i, { material: v })} disabled={!p.editable || role !== 'other'}
              options={[{ value: 'rigid', label: '강체 (rigid)' }, { value: 'air', label: '절단 (air)' }, { value: 'fabric', label: '저항층 (fabric)' }]} />
            {s.material === 'fabric' && <NumField label="흐름저항 σ" unit="Pa·s/m²" step={10000} value={s.sigma ?? 2e5} onChange={(v) => setShape(i, { sigma: v })} disabled={!p.editable} />}
          </div>
        </Section>
        <Section title="치수" meta={`r ${num(Math.min(...rs))}-${num(Math.max(...rs))} · z ${num(Math.min(...zs))}-${num(Math.max(...zs))}`}>
          <div className="stat-grid">
            <div className="stat"><span>반경 r</span><b>{num(Math.min(...rs))} - {num(Math.max(...rs))} mm</b></div>
            <div className="stat"><span>높이 z</span><b>{num(Math.min(...zs))} - {num(Math.max(...zs))} mm</b></div>
          </div>
        </Section>
        <Section title="곡선" meta={curved ? '곡선 포함' : '직선'}>
          <div className="action-row">
            <button className="btn" onClick={() => setNodes(nodes.map((_, k) => smoothNode(nodes, k)))} title="모든 앵커에 접선 핸들을 만들어 부드럽게" disabled={!p.editable}>모두 곡선</button>
            <button className="btn" onClick={() => setNodes(nodes.map(cornerNode))} title="모든 핸들 제거" disabled={!p.editable}>모두 직선</button>
          </div>
        </Section>
      </>
    );
  } else if (selection?.kind === 'driver' && scene.drivers[selection.index]) {
    const i = selection.index;
    const d = scene.drivers[i];
    head = (
      <Head glyph={d.kind === 'piston' ? <DriverIcon /> : <RadialDriverIcon />} color="var(--role-driver)" title={d.label || `드라이버 ${i + 1}`} sub={d.kind === 'piston' ? '피스톤 · 축 방향 진동판' : '방사형 · 원통 진동면'}
        actions={<button className="btn icon sm ghost danger" title="삭제" aria-label="삭제" disabled={!p.editable} onClick={() => { changeScene({ ...scene, drivers: scene.drivers.filter((_, k) => k !== i) }); p.onSelect(null); }}><TrashIcon /></button>} />
    );
    body = (
      <Section title="드라이버">
        <div className="prop-grid">
          <TextField label="이름" value={d.label ?? ''} onChange={(v) => setDriver(i, { ...d, label: v })} disabled={!p.editable} />
          <SelectField label="종류" value={d.kind} onChange={(kind) => {
            const nd: Driver = kind === 'piston'
              ? { kind: 'piston', z: d.kind === 'piston' ? d.z : d.z[0], r: d.kind === 'piston' ? d.r : [0, 20], dir: '+z', label: d.label }
              : { kind: 'radial', r: d.kind === 'radial' ? d.r : 20, z: d.kind === 'radial' ? d.z : [d.z, d.z + 20], dir: '+r', label: d.label };
            setDriver(i, nd);
          }} options={[{ value: 'piston', label: '피스톤 (축 방향)' }, { value: 'radial', label: '방사형 (반경 방향)' }]} disabled={!p.editable} />
          {d.kind === 'piston'
            ? <SelectField label="방사 방향" value={d.dir} onChange={(v) => setDriver(i, { ...d, dir: v })} options={[{ value: '+z', label: '+z (위)' }, { value: '-z', label: '-z (아래)' }]} disabled={!p.editable} />
            : <SelectField label="방사 방향" value={d.dir} onChange={(v) => setDriver(i, { ...d, dir: v })} options={[{ value: '+r', label: '+r (바깥)' }, { value: '-r', label: '-r (안쪽)' }]} disabled={!p.editable} />}
          {d.kind === 'piston' ? (
            <>
              <NumField label="높이 z" unit="mm" value={d.z} onChange={(v) => setDriver(i, { ...d, z: v })} disabled={!p.editable} />
              <NumField label="안쪽 반경" unit="mm" value={Math.min(...d.r)} onChange={(v) => setDriver(i, { ...d, r: [Math.max(0, v), Math.max(...d.r)] })} disabled={!p.editable} />
              <NumField label="바깥 반경" unit="mm" value={Math.max(...d.r)} onChange={(v) => setDriver(i, { ...d, r: [Math.min(...d.r), v] })} disabled={!p.editable} />
            </>
          ) : (
            <>
              <NumField label="반경 r" unit="mm" value={d.r} onChange={(v) => setDriver(i, { ...d, r: Math.max(0.5, v) })} disabled={!p.editable} />
              <NumField label="z 시작" unit="mm" value={Math.min(...d.z)} onChange={(v) => setDriver(i, { ...d, z: [v, Math.max(...d.z)] })} disabled={!p.editable} />
              <NumField label="z 끝" unit="mm" value={Math.max(...d.z)} onChange={(v) => setDriver(i, { ...d, z: [Math.min(...d.z), v] })} disabled={!p.editable} />
            </>
          )}
        </div>
      </Section>
    );
  } else if (selection?.kind === 'measure') {
    const m = scene.measure;
    head = <Head glyph={<MeasureIcon />} color="var(--role-measure)" title="측정 원호" sub={`반경 ${num(m.radius)} mm · ${m.angleStep}° 간격`} />;
    body = (
      <>
        <Section title="원호">
          <div className="prop-grid">
            <NumField label="반경" unit="mm" step={5} value={m.radius} onChange={(v) => changeScene({ ...scene, measure: { ...m, radius: Math.max(5, v) } })} disabled={!p.editable} />
            <NumField label="중심 z" unit="mm" value={m.zCenter} onChange={(v) => changeScene({ ...scene, measure: { ...m, zCenter: v } })} disabled={!p.editable} />
            <NumField label="각도 간격" unit="°" step={1} value={m.angleStep} onChange={(v) => changeScene({ ...scene, measure: { ...m, angleStep: Math.min(180, Math.max(1, v)) } })} disabled={!p.editable} />
            <NumField label="최대 각도" unit="°" step={5} value={m.angleMax ?? 180} onChange={(v) => changeScene({ ...scene, measure: { ...m, angleMax: Math.min(180, Math.max(5, v)) } })} disabled={!p.editable} />
          </div>
        </Section>
        <Section title="자동 맞춤">
          <div className="row between">
            <span className="muted">형상에 맞춰 원호·해석 영역 조정</span>
            <button className="switch" role="switch" aria-checked={p.autoMeasure} aria-label="측정·해석 공간 자동 맞춤" onClick={() => { if (p.editable) p.onAutoMeasureChange(!p.autoMeasure); }} disabled={!p.editable} />
          </div>
          <button className="btn" onClick={p.onFitMeasure} disabled={!p.editable}>지금 맞춤</button>
        </Section>
      </>
    );
  } else {
    const d = scene.domain;
    const errors = p.diagnostics.filter((x) => x.severity !== 'info');
    const cost = p.diagnostics.find((x) => x.code === 'cost');
    head = <Head glyph={<DomainIcon />} title={scene.name || 'untitled'} sub={p.previewing ? '미리보기 중 · 편집으로 돌아가면 수정할 수 있습니다' : '씬 설정 · 아무것도 선택하지 않음'} />;
    body = (
      <>
        <Section title="실행 전 확인" meta={errors.length === 0 ? '이상 없음' : `${errors.length}`} open={errors.length > 0}>
          {errors.length === 0 ? <p className="help">이상 없음</p> : <DiagnosticList items={errors} />}
        </Section>
        <Section title="해석 설정" meta={p.editable ? `dx ${params.dx} · ${params.durationMs} ms` : '계산 중 잠김'}>
          <div className="prop-grid">
            <NumField label="격자 간격" unit="mm" step={0.25} min={0.25} max={4} value={params.dx} onChange={(v) => setParam('dx', v)} disabled={!p.editable} />
            <NumField label="해석 시간" unit="ms" step={1} min={1} max={40} value={params.durationMs} onChange={(v) => setParam('durationMs', v)} disabled={!p.editable} />
            <NumField label="최저 주파수" unit="Hz" step={50} min={20} max={5000} value={params.fMin} onChange={(v) => setParam('fMin', v)} disabled={!p.editable} />
            <NumField label="최고 주파수" unit="Hz" step={1000} min={2000} max={40000} value={params.fMax} onChange={(v) => setParam('fMax', v)} disabled={!p.editable} />
            <NumField label="흡수층" unit="cells" step={10} min={10} max={150} value={params.spongeCells} onChange={(v) => setParam('spongeCells', v)} disabled={!p.editable} />
            <SelectField label="연산 장치" value={params.backend ?? 'auto'} onChange={(v) => { if (p.editable) p.setParams({ ...params, backend: v }); }} disabled={!p.editable}
              options={[{ value: 'auto', label: '자동 · WebGPU 우선' }, { value: 'gpu', label: 'WebGPU' }, { value: 'cpu', label: 'CPU' }]} />
          </div>
          {cost && <div className="cost-note"><InfoIcon />{cost.message}</div>}
        </Section>
        <Section title="해석 영역" meta={`${d.rMax} × ${d.zMax - d.zMin} mm`} open={false}>
          <div className="prop-grid">
            <NumField label="rMax" unit="mm" step={10} value={d.rMax} onChange={(v) => changeScene({ ...scene, domain: { ...d, rMax: Math.max(20, v) } })} disabled={!p.editable} />
            <NumField label="zMin" unit="mm" step={10} value={d.zMin} onChange={(v) => changeScene({ ...scene, domain: { ...d, zMin: v } })} disabled={!p.editable} />
            <NumField label="zMax" unit="mm" step={10} value={d.zMax} onChange={(v) => changeScene({ ...scene, domain: { ...d, zMax: v } })} disabled={!p.editable} />
          </div>
        </Section>
        <Section title="바닥" meta={scene.floor?.enabled ? `z = ${num(scene.floor.z)}` : '없음'} open={!!scene.floor?.enabled}>
          <div className="row between">
            <span className="muted">책상·바닥 반사 (무한 강체 평면)</span>
            <button className="switch" role="switch" aria-checked={!!scene.floor?.enabled} aria-label="바닥 사용" disabled={!p.editable} onClick={() => {
              const enabled = !scene.floor?.enabled;
              const z = scene.floor?.z ?? rigidZRange(scene).z0;
              const next: Scene = { ...scene, floor: { enabled, z } };
              if (enabled) next.measure = { ...next.measure, angleMax: Math.min(next.measure.angleMax ?? 180, maxAngleAboveFloor(next)) };
              changeScene(next);
            }} />
          </div>
          <div className="prop-grid">
            <NumField label="바닥 z" unit="mm" value={scene.floor?.z ?? rigidZRange(scene).z0} disabled={!p.editable || !scene.floor?.enabled} onChange={(v) => {
              const next: Scene = { ...scene, floor: { enabled: scene.floor?.enabled ?? false, z: v } };
              if (next.floor!.enabled) next.measure = { ...next.measure, angleMax: Math.min(next.measure.angleMax ?? 180, maxAngleAboveFloor(next)) };
              changeScene(next);
            }} />
          </div>
        </Section>
        <Section title="설명" open={false}>
          <textarea className="input" style={{ minHeight: 72, fontFamily: 'var(--font-sans)', fontSize: 11.5 }} value={scene.description ?? ''} placeholder="이 설계에 대한 메모" onChange={(e) => changeScene({ ...scene, description: e.target.value })} disabled={!p.editable} />
        </Section>
        <Section title="정밀도 검증" meta="CPU ↔ GPU" open={false}>
          <p className="help">배플 피스톤 씬을 두 백엔드로 계산해 차이를 비교합니다.</p>
          <button className="btn" onClick={p.onRunParity} disabled={!p.editable || p.busy}>일치 검사 실행</button>
          {p.parityBusy && <p className="help">두 백엔드를 비교하고 있습니다…</p>}
          {p.parity && <div className="stat-grid">
            <div className="stat"><span>시계열 차이</span><b>{(p.parity.maxRelDiff * 100).toExponential(2)} %</b></div>
            <div className="stat"><span>스펙트럼 차이</span><b>{p.parity.maxDbDiff.toFixed(3)} dB</b></div>
            <div className="stat"><span>CPU</span><b>{(p.parity.cpuMs / 1000).toFixed(1)} s</b></div>
            <div className="stat"><span>GPU</span><b>{(p.parity.gpuMs / 1000).toFixed(1)} s</b></div>
          </div>}
        </Section>
      </>
    );
  }

  return (
    <aside className="panel inspector" aria-label="속성">
      {head}
      <div className="panel-body">{body}</div>
    </aside>
  );
}

function Head({ glyph, swatch, color, title, sub, actions }: { glyph?: React.ReactNode; swatch?: ShapeRole; color?: string; title: string; sub: string; actions?: React.ReactNode }) {
  return (
    <div className="insp-head">
      <span className="insp-glyph" style={color ? { color } : undefined}>
        {swatch ? <i className="swatch" style={{ background: ROLE_COLORS[swatch].fill, borderColor: ROLE_COLORS[swatch].stroke }} /> : glyph}
      </span>
      <div className="insp-title"><strong>{title}</strong><span>{sub}</span></div>
      <div className="insp-actions">{actions}</div>
    </div>
  );
}
