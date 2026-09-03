import type { Candidate, DesignVariable, OptimizeProgress, OptimizeSettings, ParametricModel } from '../engine/optimize';

interface Props {
  model: ParametricModel;
  variables: DesignVariable[];
  setVariables: (v: DesignVariable[]) => void;
  settings: OptimizeSettings;
  setSettings: (s: OptimizeSettings) => void;
  running: boolean;
  progress: OptimizeProgress | null;
  elapsedMs: number | null;
  onStart: () => void;
  onStop: () => void;
  selected: Set<number>;
  toggleSelected: (id: number) => void;
  onApply: (c: Candidate) => void;
  colorFor: (id: number) => string | null;
  /** Show this candidate's geometry on the canvas. */
  onPreview: (c: Candidate) => void;
}

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

export function OptimizePanel(p: Props) {
  const { variables, settings, progress } = p;
  const setVar = (key: string, patch: Partial<DesignVariable>) =>
    p.setVariables(variables.map((v) => (v.key === key ? { ...v, ...patch } : v)));
  const setNum = (key: keyof OptimizeSettings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    p.setSettings({ ...settings, [key]: +e.target.value });
  const setWeight = (key: keyof OptimizeSettings['objective']['weights']) => (e: React.ChangeEvent<HTMLInputElement>) =>
    p.setSettings({ ...settings, objective: { ...settings.objective, weights: { ...settings.objective.weights, [key]: +e.target.value } } });
  const setBand = (i: 0 | 1) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const band: [number, number] = [...settings.objective.band] as [number, number];
    band[i] = +e.target.value;
    p.setSettings({ ...settings, objective: { ...settings.objective, band } });
  };

  const ranked = progress?.ranked ?? [];
  const activeCount = variables.filter((v) => v.enabled).length;

  return (
    <>
      <p className="desc">{p.model.name}. 설계변수 범위를 정하고 실행하면 라틴 하이퍼큐브 탐색 후 상위 후보를 국소 정련합니다. 같은 시드와 설정이면 결과가 동일합니다.</p>

      <table className="vars">
        <thead><tr><th></th><th>변수</th><th>최소</th><th>최대</th><th>기준</th></tr></thead>
        <tbody>
          {variables.map((v) => (
            <tr key={v.key} className={v.enabled ? '' : 'off'}>
              <td><input type="checkbox" checked={v.enabled} onChange={(e) => setVar(v.key, { enabled: e.target.checked })} /></td>
              <td>{v.label}<span className="muted"> {v.unit}</span></td>
              <td><input type="number" step="0.5" value={v.min} onChange={(e) => setVar(v.key, { min: +e.target.value })} /></td>
              <td><input type="number" step="0.5" value={v.max} onChange={(e) => setVar(v.key, { max: +e.target.value })} /></td>
              <td><input type="number" step="0.5" value={v.value} onChange={(e) => setVar(v.key, { value: +e.target.value })} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="grid3">
        <label>탐색 샘플<input type="number" min="1" max="200" value={settings.nSamples} onChange={setNum('nSamples')} /></label>
        <label>정련 횟수<input type="number" min="0" max="200" value={settings.nRefine} onChange={setNum('nRefine')} /></label>
        <label>시드<input type="number" min="0" value={settings.seed} onChange={setNum('seed')} /></label>
        <label>dx (mm)<input type="number" step="0.25" min="0.5" max="4" value={settings.dx} onChange={setNum('dx')} /></label>
        <label>시간 (ms)<input type="number" min="2" max="40" value={settings.durationMs} onChange={setNum('durationMs')} /></label>
        <label>fMax (Hz)<input type="number" step="1000" min="2000" value={settings.fMax} onChange={setNum('fMax')} /></label>
      </div>

      <details>
        <summary>목적함수 (높을수록 좋음)</summary>
        <div className="grid3">
          <label>대역 시작 (Hz)<input type="number" step="100" value={settings.objective.band[0]} onChange={setBand(0)} /></label>
          <label>대역 끝 (Hz)<input type="number" step="100" value={settings.objective.band[1]} onChange={setBand(1)} /></label>
          <label>측면 각도 (°)<input type="number" step="5" value={settings.objective.sideAngle}
            onChange={(e) => p.setSettings({ ...settings, objective: { ...settings.objective, sideAngle: +e.target.value } })} /></label>
          <label>w 측면 레벨<input type="number" step="0.1" value={settings.objective.weights.level} onChange={setWeight('level')} /></label>
          <label>w 수평 균일도<input type="number" step="0.1" value={settings.objective.weights.uniformity} onChange={setWeight('uniformity')} /></label>
          <label>w 응답 평탄도<input type="number" step="0.1" value={settings.objective.weights.flatness} onChange={setWeight('flatness')} /></label>
          <label>w 상하 누설<input type="number" step="0.1" value={settings.objective.weights.leakage} onChange={setWeight('leakage')} /></label>
        </div>
        <p className="muted small">점수 = w₁·측면 레벨(dB) − w₂·수평 ±{settings.objective.spread}° 편차 − w₃·측면 응답 편차 − w₄·(상하 최대 − 측면). 모두 {settings.objective.band[0]}~{settings.objective.band[1]} Hz 평균.</p>
      </details>

      <div className="row">
        <button className="primary" onClick={p.onStart} disabled={p.running || activeCount === 0}>최적화 실행</button>
        <button onClick={p.onStop} disabled={!p.running}>중단</button>
      </div>
      <div className="progress"><div style={{ width: `${progress ? (100 * progress.done) / progress.total : 0}%` }} /></div>
      <p className="status">
        {progress ? `${progress.done}/${progress.total} 평가` : '대기'}
        {progress?.best && ` · 현재 최고 ${fmt(progress.best.score, 2)} (#${progress.best.id} ${progress.best.origin})`}
        {p.elapsedMs !== null && !p.running && ` · ${(p.elapsedMs / 1000).toFixed(1)} s`}
      </p>

      {ranked.length > 0 && (
        <table className="cands">
          <thead>
            <tr><th>비교</th><th>#</th><th>점수</th><th>레벨</th><th>균일</th><th>평탄</th><th>누설</th>
              {variables.filter((v) => v.enabled).map((v) => <th key={v.key} title={v.label}>{v.key}</th>)}<th></th></tr>
          </thead>
          <tbody>
            {ranked.slice(0, 12).map((c, rank) => {
              const color = p.colorFor(c.id);
              return (
                <tr key={c.id} className={rank === 0 ? 'best' : ''} onClick={() => p.onPreview(c)} title="클릭: 캔버스에 이 후보 형상 표시">
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={p.selected.has(c.id)} onChange={() => p.toggleSelected(c.id)} />
                    {color && <span className="swatch" style={{ background: color }} />}</td>
                  <td title={c.origin}>{c.id}{c.origin === 'baseline' ? '*' : ''}</td>
                  <td><b>{fmt(c.score, 2)}</b></td>
                  <td>{fmt(c.breakdown?.level ?? NaN)}</td>
                  <td>{fmt(c.breakdown?.uniformity ?? NaN)}</td>
                  <td>{fmt(c.breakdown?.flatness ?? NaN)}</td>
                  <td>{fmt(c.breakdown?.leakage ?? NaN)}</td>
                  {variables.filter((v) => v.enabled).map((v) => <td key={v.key}>{fmt(c.params[v.key])}</td>)}
                  <td><button className="mini" onClick={(e) => { e.stopPropagation(); p.onApply(c); }} disabled={p.running}>적용</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {ranked.length > 0 && <p className="muted small">* 기준 형상. 체크한 후보는 오른쪽에서 polar와 측면 응답을 겹쳐 비교합니다. "적용"은 후보 형상을 시뮬레이션 탭의 씬으로 보냅니다.</p>}
    </>
  );
}
