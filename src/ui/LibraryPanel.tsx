import { useMemo, useRef, useState } from 'react';
import type { Scene } from '../engine/scene';
import { PRESETS } from '../engine/presets';
import { rigidZRange, shapeToPath, type Pt } from '../engine/geometry';
import { validateScene } from '../engine/checks';
import { sceneToSvg, svgToShapes } from '../engine/svg';
import { ScenePreview } from './ScenePreview';
import { Section } from './fields';
import { DownloadIcon, FileIcon, UploadIcon } from './Icons';
import type { Selection } from './SectionCanvas';

interface Props {
  scene: Scene;
  presetKey: string;
  onPreset: (key: string) => void;
  onChange: (scene: Scene) => void;
  onSelect: (s: Selection) => void;
  editable: boolean;
}

const PRESET_LABELS: Record<string, string> = {
  'side-radial': '측면 방사형',
  'front-firing': '정면 방사형',
  'up-firing-360': '상향 360°',
  'piston-baffle': '배플 피스톤 (검증)',
};

export function LibraryPanel({ scene, presetKey, onPreset, onChange, onSelect, editable }: Props) {
  const presets = useMemo(() => Object.keys(PRESETS).map((key) => ({ key, scene: PRESETS[key]() })), []);
  const [svgPlacement, setSvgPlacement] = useState<'original' | 'zero' | 'device'>('original');
  const [svgError, setSvgError] = useState<string | null>(null);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef(true);

  const exportSvg = () => {
    const blob = new Blob([sceneToSvg(scene)], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${scene.name || 'section'}.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(scene, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${scene.name || 'scene'}.json`;
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
      onChange({ ...scene, shapes: replace ? shapes : [...scene.shapes, ...shapes] });
      onSelect(null);
    } catch (err) {
      setSvgError(err instanceof Error ? err.message : String(err));
    }
  };

  const applyJson = () => {
    try {
      const s = JSON.parse(jsonText) as unknown;
      const errs = validateScene(s).filter((d) => d.severity === 'error');
      if (errs.length) { setJsonError(errs.map((e) => e.message).join('\n')); return; }
      setJsonError(null);
      onChange(s as Scene);
      onSelect(null);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <div className="panel-head"><h2>라이브러리</h2></div>
      <div className="panel-body">
        <Section title="예제 형상" meta={`${presets.length}`}>
          <div className="preset-grid">
            {presets.map((p) => (
              <button key={p.key} className="preset-card" aria-pressed={presetKey === p.key} onClick={() => onPreset(p.key)} disabled={!editable} title={p.scene.description}>
                <span className="thumb"><ScenePreview scene={p.scene} /></span>
                <strong>{PRESET_LABELS[p.key] ?? p.key}</strong>
                <span>{p.scene.description}</span>
              </button>
            ))}
          </div>
        </Section>

        <Section title="SVG 가져오기 / 내보내기">
          <p className="help">1 unit = 1 mm, x = r, y = −z. 역할은 data-role 또는 채움색으로 복원.</p>
          <div className="prop-grid">
            <label>배치</label>
            <select className="select" value={svgPlacement} onChange={(e) => setSvgPlacement(e.target.value as typeof svgPlacement)}>
              <option value="original">원래 좌표 유지</option>
              <option value="zero">형상 아래를 z = 0에</option>
              <option value="device">현재 기기 높이에 맞춤</option>
            </select>
          </div>
          <div className="action-row">
            <button className="btn primary" onClick={() => { replaceRef.current = true; fileRef.current?.click(); }} disabled={!editable}><UploadIcon />SVG 불러오기</button>
            <button className="btn" onClick={() => { replaceRef.current = false; fileRef.current?.click(); }} disabled={!editable}>현재 설계에 추가</button>
          </div>
          <div className="action-row">
            <button className="btn" onClick={exportSvg}><DownloadIcon />SVG 내보내기</button>
            <button className="btn" onClick={exportJson}><FileIcon />JSON 내보내기</button>
          </div>
          <input ref={fileRef} type="file" accept=".svg,image/svg+xml" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) importSvg(f, replaceRef.current); e.target.value = ''; }} />
          {svgError && <div className="notice error">{svgError}</div>}
        </Section>

        <Section title="새 설계" open={false}>
          <button className="btn block" onClick={() => { onChange({ ...scene, name: 'untitled', description: '', shapes: [], drivers: [] }); onSelect(null); }} disabled={!editable}>빈 설계로 시작</button>
        </Section>

        <Section title="씬 JSON (고급)" open={false}>
          <textarea className="input" value={jsonText} spellCheck={false} placeholder="현재 씬을 불러오려면 아래 버튼을 누르세요" onChange={(e) => setJsonText(e.target.value)} />
          <div className="action-row">
            <button className="btn" onClick={() => setJsonText(JSON.stringify(scene, null, 2))}>현재 씬 불러오기</button>
            <button className="btn primary" onClick={applyJson} disabled={!editable || !jsonText.trim()}>JSON 적용</button>
          </div>
          {jsonError && <div className="notice error" style={{ whiteSpace: 'pre-wrap' }}>{jsonError}</div>}
        </Section>
      </div>
    </>
  );
}
