import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import type { Scene, Driver, ShapeRole } from '../engine/scene';
import type { Diagnostic } from '../engine/checks';
import { bandOf, defaultFabric, defaultSlot, driverBodyShape, rigidZRange, maxAngleAboveFloor, shapeToPath, type BandPlace } from '../engine/geometry';
import { ROLE_COLORS, roleOf, selectedShapeIndices, shapeSelection, type Selection, type Tool } from './SectionCanvas';
import { useDismiss } from './fields';
import {
  ArrowDownIcon, ArrowUpIcon, DomainIcon, DriverIcon, EllipseIcon, FabricIcon, FloorIcon, MeasureIcon, PenIcon, PlusIcon,
  RadialDriverIcon, RectangleIcon, SlotIcon, TrashIcon,
} from './Icons';

interface Props {
  scene: Scene;
  onChange: (scene: Scene) => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
  editable: boolean;
  diagnostics: Diagnostic[];
  onTool: (t: Tool) => void;
}

const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

export function LayersPanel({ scene, onChange, selection, onSelect, editable, diagnostics, onTool }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [bandWhere, setBandWhere] = useState<BandPlace>('side');
  const [renaming, setRenaming] = useState<{ kind: 'shape' | 'driver'; index: number; value: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useDismiss(menuRef, menuOpen, closeMenu);

  const flaggedShapes = new Set(diagnostics.filter((d) => d.severity === 'error' && d.target?.kind === 'shape').map((d) => d.target!.index));
  const flaggedDrivers = new Set(diagnostics.filter((d) => d.severity === 'error' && d.target?.kind === 'driver').map((d) => d.target!.index));
  const measureFlagged = diagnostics.some((d) => d.severity === 'error' && d.target?.kind === 'measure');
  const selectedShapes = new Set(selectedShapeIndices(selection));

  // ---- mutations -------------------------------------------------------------
  const setShapes = (shapes: Scene['shapes']) => onChange({ ...scene, shapes });
  const deleteShape = (i: number) => { setShapes(scene.shapes.filter((_, k) => k !== i)); onSelect(null); };
  const deleteDriver = (i: number) => { onChange({ ...scene, drivers: scene.drivers.filter((_, k) => k !== i) }); onSelect(null); };
  const moveShape = (i: number, dir: 1 | -1) => {
    const j = i + dir;
    if (j < 0 || j >= scene.shapes.length) return;
    const shapes = scene.shapes.slice();
    [shapes[i], shapes[j]] = [shapes[j], shapes[i]];
    setShapes(shapes);
    onSelect({ kind: 'shape', index: j });
  };
  const renameShape = (i: number, label: string) => {
    const shapes = scene.shapes.slice();
    shapes[i] = { ...shapes[i], label };
    setShapes(shapes);
  };
  const renameDriver = (i: number, label: string) => {
    const drivers = scene.drivers.slice();
    drivers[i] = { ...drivers[i], label };
    onChange({ ...scene, drivers });
  };
  const addDriver = (kind: 'piston' | 'radial') => {
    const zTop = Math.max(0, ...scene.shapes.flatMap((s) => shapeToPath(s).nodes.map((n) => n.p[1])));
    const d: Driver = kind === 'piston'
      ? { kind: 'piston', z: zTop + 10, r: [0, 20], dir: '+z', label: `드라이버 ${scene.drivers.length + 1}` }
      : { kind: 'radial', r: 20, z: [zTop, zTop + 20], dir: '+r', label: `드라이버 ${scene.drivers.length + 1}` };
    onChange({ ...scene, drivers: [...scene.drivers, d] });
    onSelect({ kind: 'driver', index: scene.drivers.length });
    closeMenu();
  };
  const addDriverBody = () => {
    const di = selection?.kind === 'driver' ? selection.index : 0;
    const d = scene.drivers[di];
    if (!d) return;
    setShapes([...scene.shapes, driverBodyShape(d)]);
    onSelect({ kind: 'shape', index: scene.shapes.length });
    closeMenu();
  };
  const addBand = (kind: 'slot' | 'fabric') => {
    setShapes([...scene.shapes, kind === 'slot' ? defaultSlot(scene, bandWhere) : defaultFabric(scene, bandWhere)]);
    onSelect({ kind: 'shape', index: scene.shapes.length });
    closeMenu();
  };
  const pickTool = (t: Tool) => { onTool(t); closeMenu(); };
  const toggleFloor = (enabled: boolean) => {
    const z = scene.floor?.z ?? rigidZRange(scene).z0;
    const next: Scene = { ...scene, floor: { enabled, z } };
    if (enabled) next.measure = { ...next.measure, angleMax: Math.min(next.measure.angleMax ?? 180, maxAngleAboveFloor(next)) };
    onChange(next);
  };

  // ---- rows ------------------------------------------------------------------
  const selectShape = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      const cur = [...selectedShapes];
      onSelect(shapeSelection(cur.includes(i) ? cur.filter((k) => k !== i) : [...cur, i]));
    } else onSelect({ kind: 'shape', index: i });
  };
  const onRowKey = (e: KeyboardEvent, del: () => void) => {
    if (!editable) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); del(); }
  };
  const commitRename = () => {
    if (!renaming) return;
    if (renaming.kind === 'shape') renameShape(renaming.index, renaming.value.trim()); else renameDriver(renaming.index, renaming.value.trim());
    setRenaming(null);
  };
  const renameInput = (kind: 'shape' | 'driver', index: number, current: string) => (
    <input autoFocus className="row-rename" value={renaming?.value ?? current}
      onChange={(e) => setRenaming({ kind, index, value: e.target.value })}
      onBlur={commitRename}
      onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') setRenaming(null); e.stopPropagation(); }}
      onClick={(e) => e.stopPropagation()} />
  );

  const shapeRows = scene.shapes.map((s, i) => ({ s, i })).reverse();

  return (
    <>
      <div className="panel-head">
        <h2>레이어</h2>
        <span className="chip">{scene.shapes.length + scene.drivers.length}</span>
        <span className="spacer" />
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button className="btn icon sm ghost" aria-label="요소 추가" aria-expanded={menuOpen} title="요소 추가" onClick={() => setMenuOpen((v) => !v)} disabled={!editable}><PlusIcon /></button>
          {menuOpen && (
            <div className="popover right" role="menu" style={{ right: 0, top: 30, width: 236 }}>
              <div className="menu-section">그리기</div>
              <button className="menu-item" onClick={() => pickTool('pen')}><PenIcon /><span className="grow">펜으로 자유 형상</span><kbd>P</kbd></button>
              <button className="menu-item" onClick={() => pickTool('rect')}><RectangleIcon /><span className="grow">사각형</span><kbd>R</kbd></button>
              <button className="menu-item" onClick={() => pickTool('ellipse')}><EllipseIcon /><span className="grow">원</span><kbd>E</kbd></button>
              <div className="menu-sep" />
              <div className="menu-section">드라이버</div>
              <button className="menu-item" onClick={() => addDriver('piston')}><DriverIcon /><span className="grow">피스톤 드라이버</span><span className="faint small">축 방향</span></button>
              <button className="menu-item" onClick={() => addDriver('radial')}><RadialDriverIcon /><span className="grow">방사형 드라이버</span><span className="faint small">반경 방향</span></button>
              <button className="menu-item" onClick={addDriverBody} disabled={scene.drivers.length === 0}><DriverIcon /><span className="grow">드라이버 몸체</span><span className="faint small">바스켓·마그넷</span></button>
              <div className="menu-sep" />
              <div className="menu-section">벽에 붙이는 띠</div>
              <div className="menu-inline">
                <div className="seg block" role="radiogroup" aria-label="부착 면">
                  {(['side', 'top', 'bottom'] as BandPlace[]).map((w) => (
                    <button key={w} role="radio" aria-pressed={bandWhere === w} aria-checked={bandWhere === w} onClick={() => setBandWhere(w)}>{w === 'side' ? '옆면' : w === 'top' ? '윗면' : '아랫면'}</button>
                  ))}
                </div>
              </div>
              <button className="menu-item" onClick={() => addBand('slot')}><SlotIcon /><span className="grow">슬롯 (절단)</span></button>
              <button className="menu-item" onClick={() => addBand('fabric')}><FabricIcon /><span className="grow">패브릭 (저항층)</span></button>
            </div>
          )}
        </div>
      </div>

      <div className="panel-body">
        <div className="tree" role="tree" aria-label="씬 구조">
          <div className="tree-group">
            <header><span>드라이버</span><span className="meta">{scene.drivers.length}</span></header>
            {scene.drivers.length === 0 && <div className="tree-empty">드라이버 없음</div>}
            {scene.drivers.map((d, i) => {
              const selected = selection?.kind === 'driver' && selection.index === i;
              const name = d.label || `드라이버 ${i + 1}`;
              const tag = d.kind === 'piston' ? `피스톤 · z ${num(d.z)} · r ${num(Math.min(...d.r))}-${num(Math.max(...d.r))}` : `방사형 · r ${num(d.r)} · z ${num(Math.min(...d.z))}-${num(Math.max(...d.z))}`;
              return (
                <div key={i} role="treeitem" tabIndex={0} aria-selected={selected} className={`tree-row ${flaggedDrivers.has(i) ? 'flagged' : ''}`}
                  onClick={() => onSelect({ kind: 'driver', index: i })} onDoubleClick={() => editable && setRenaming({ kind: 'driver', index: i, value: d.label ?? '' })}
                  onKeyDown={(e) => onRowKey(e, () => deleteDriver(i))}>
                  <span className="row-glyph" style={{ color: 'var(--role-driver)' }}>{d.kind === 'piston' ? <DriverIcon /> : <RadialDriverIcon />}</span>
                  {renaming?.kind === 'driver' && renaming.index === i
                    ? renameInput('driver', i, d.label ?? '')
                    : <span className="row-name"><span>{name}</span><span className="row-tag">{tag}</span></span>}
                  <span className="row-actions">
                    <button className="btn ghost danger" aria-label="삭제" title="삭제" onClick={(e) => { e.stopPropagation(); deleteDriver(i); }} disabled={!editable}><TrashIcon /></button>
                  </span>
                </div>
              );
            })}
          </div>

          <div className="tree-group">
            <header><span>형상</span><span className="meta">{scene.shapes.length}</span></header>
            {scene.shapes.length === 0 && <div className="tree-empty">형상 없음</div>}
            {shapeRows.map(({ s, i }) => {
              const role = roleOf(s) as ShapeRole;
              const band = bandOf(s);
              const selected = selectedShapes.has(i);
              const name = s.label || `${ROLE_COLORS[role].name} ${i + 1}`;
              const tag = band ? `${ROLE_COLORS[role].name} · ${band.axis === 'z' ? `z ${num(band.z0)}-${num(band.z1)}` : `r ${num(band.r0)}-${num(band.r1)}`}` : ROLE_COLORS[role].name;
              return (
                <div key={i} role="treeitem" tabIndex={0} aria-selected={selected} className={`tree-row ${flaggedShapes.has(i) ? 'flagged' : ''}`}
                  onClick={(e) => selectShape(i, e)} onDoubleClick={() => editable && setRenaming({ kind: 'shape', index: i, value: s.label ?? '' })}
                  onKeyDown={(e) => onRowKey(e, () => deleteShape(i))}>
                  <span className="row-glyph"><i className="swatch" style={{ background: ROLE_COLORS[role].fill, borderColor: ROLE_COLORS[role].stroke }} /></span>
                  {renaming?.kind === 'shape' && renaming.index === i
                    ? renameInput('shape', i, s.label ?? '')
                    : <span className="row-name"><span>{name}</span><span className="row-tag">{tag}</span></span>}
                  <span className="row-actions">
                    <button className="btn ghost" aria-label="위로" title="나중에 적용 (위로)" onClick={(e) => { e.stopPropagation(); moveShape(i, 1); }} disabled={!editable || i === scene.shapes.length - 1}><ArrowUpIcon /></button>
                    <button className="btn ghost" aria-label="아래로" title="먼저 적용 (아래로)" onClick={(e) => { e.stopPropagation(); moveShape(i, -1); }} disabled={!editable || i === 0}><ArrowDownIcon /></button>
                    <button className="btn ghost danger" aria-label="삭제" title="삭제" onClick={(e) => { e.stopPropagation(); deleteShape(i); }} disabled={!editable}><TrashIcon /></button>
                  </span>
                </div>
              );
            })}
          </div>

          <div className="tree-group">
            <header><span>환경</span></header>
            <div role="treeitem" tabIndex={0} aria-selected={selection?.kind === 'measure'} className={`tree-row ${measureFlagged ? 'flagged' : ''}`} onClick={() => onSelect({ kind: 'measure' })}>
              <span className="row-glyph" style={{ color: 'var(--role-measure)' }}><MeasureIcon /></span>
              <span className="row-name"><span>측정 원호</span><span className="row-tag">R {num(scene.measure.radius)} · 0-{scene.measure.angleMax ?? 180}°</span></span>
              <span />
            </div>
            <div role="treeitem" tabIndex={0} aria-selected={false} className={`tree-row ${scene.floor?.enabled ? '' : 'disabled'}`} onClick={() => onSelect(null)}>
              <span className="row-glyph" style={{ color: 'var(--canvas-floor-line)' }}><FloorIcon /></span>
              <span className="row-name"><span>바닥</span><span className="row-tag">{scene.floor?.enabled ? `z = ${num(scene.floor.z)}` : '없음'}</span></span>
              <span className="row-side" onClick={(e) => e.stopPropagation()}>
                <button className="switch" role="switch" aria-checked={!!scene.floor?.enabled} aria-label="바닥 사용" onClick={() => toggleFloor(!scene.floor?.enabled)} disabled={!editable} />
              </span>
            </div>
            <div role="treeitem" tabIndex={0} aria-selected={selection === null} className="tree-row" onClick={() => onSelect(null)}>
              <span className="row-glyph" style={{ color: 'var(--ink-3)' }}><DomainIcon /></span>
              <span className="row-name"><span>해석 영역</span><span className="row-tag">{scene.domain.rMax} × {scene.domain.zMax - scene.domain.zMin} mm</span></span>
              <span />
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
