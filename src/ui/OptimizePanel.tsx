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
  /** Scene model only: re-capture the editor scene as the baseline. */
  onRefreshBase?: () => void;
  baseStale?: boolean;
}

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

const OBJECTIVE_PRESETS = {
  balanced: { label: '균형 · 측면 출력과 고른 확산', band: [1000, 8000] as [number, number], weights: { level: 1, uniformity: 1, flatness: 0.5, leakage: 0.5 } },
  diffuse: { label: '넓은 확산 · 각도별 편차 최소화', band: [1000, 8000] as [number, number], weights: { level: 0.7, uniformity: 1.6, flatness: 0.5, leakage: 0.8 } },
  flat: { label: '평탄 응답 · 대역 내 변화 최소화', band: [800, 10000] as [number, number], weights: { level: 0.7, uniformity: 0.7, flatness: 1.6, leakage: 0.5 } },
};

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
  const objectivePreset = (Object.entries(OBJECTIVE_PRESETS).find(([, preset]) =>
    preset.band[0] === settings.objective.band[0]
    && preset.band[1] === settings.objective.band[1]
    && Object.entries(preset.weights).every(([key, value]) => settings.objective.weights[key as keyof typeof preset.weights] === value))?.[0] ?? 'custom');

  return (
    <>
      <label className="objective-preset">탐색 목표
        <select value={objectivePreset} onChange={(e) => {
          const preset = OBJECTIVE_PRESETS[e.target.value as keyof typeof OBJECTIVE_PRESETS];
          if (preset) p.setSettings({ ...settings, objective: { ...settings.objective, band: preset.band, weights: preset.weights } });
        }}>
          <option value="custom" disabled>직접 설정한 목표</option>
          {Object.entries(OBJECTIVE_PRESETS).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}
        </select>
      </label>
      {p.onRefreshBase && p.baseStale && (
        <div className="row">
          <button onClick={p.onRefreshBase} disabled={p.running}>편집본으로 기준 갱신</button>
          {p.baseStale && <span className="muted small">편집기 형상이 기준과 다릅니다</span>}
        </div>
      )}

      <div className="opt-run-block">
        <div className="row">
          <button className="primary" onClick={p.onStart} disabled={p.running || activeCount === 0}>탐색 실행</button>
          {p.running && <button onClick={p.onStop}>중단</button>}
        </div>
        <div className="progress"><div style={{ transform: `scaleX(${progress ? progress.done / progress.total : 0})` }} /></div>
        {(progress || p.elapsedMs !== null) && <p className="status">
          {progress ? `${progress.done}/${progress.total} 평가` : `${activeCount}개 변수를 기준으로 준비됨`}
          {progress?.best && ` · 현재 최고 ${fmt(progress.best.score, 2)} (#${progress.best.id} ${progress.best.origin})`}
          {p.elapsedMs !== null && !p.running && ` · ${(p.elapsedMs / 1000).toFixed(1)} s`}
        </p>}
      </div>

      <div className="variable-list">
        <div className="subsection-heading"><span>변형할 항목</span><span>{activeCount}개 사용</span></div>
        {variables.map((v) => (
          <section key={v.key} className={`variable-card ${v.enabled ? '' : 'off'}`}>
            <label className="variable-toggle"><input type="checkbox" checked={v.enabled} onChange={(e) => setVar(v.key, { enabled: e.target.checked })} />
              <span><strong>{v.label}</strong><small>{v.unit || '값'}</small></span>
            </label>
            {v.enabled && (
              <div className="variable-range-grid">
                <label>최소<input type="number" step="0.5" value={v.min} onChange={(e) => setVar(v.key, { min: +e.target.value })} /></label>
                <label>기준<input type="number" step="0.5" value={v.value} onChange={(e) => setVar(v.key, { value: +e.target.value })} /></label>
                <label>최대<input type="number" step="0.5" value={v.max} onChange={(e) => setVar(v.key, { max: +e.target.value })} /></label>
              </div>
            )}
          </section>
        ))}
      </div>

      <details className="inline-disclosure search-settings">
        <summary><span>탐색 예산과 정밀도</span><span>{settings.nSamples + settings.nRefine}회 · dx {settings.dx} mm</span></summary>
        <div className="grid2 disclosure-content">
          <label>탐색 방식
            <select value={settings.explore} onChange={(e) => p.setSettings({ ...settings, explore: e.target.value as OptimizeSettings['explore'] })}>
              <option value="local">국소 · 기준 근처</option>
              <option value="global">전역 · 범위 전체</option>
            </select>
          </label>
          <label>국소 폭<input type="number" step="0.05" min="0.02" max="1" value={settings.localSigma} onChange={setNum('localSigma')} disabled={settings.explore !== 'local'} /></label>
          <label>탐색 샘플<input type="number" min="1" max="200" value={settings.nSamples} onChange={setNum('nSamples')} /></label>
          <label>정련 평가<input type="number" min="0" max="400" value={settings.nRefine} onChange={setNum('nRefine')} /></label>
          <label>격자 간격 (mm)<input type="number" step="0.25" min="0.5" max="4" value={settings.dx} onChange={setNum('dx')} /></label>
          <label>해석 시간 (ms)<input type="number" min="2" max="40" value={settings.durationMs} onChange={setNum('durationMs')} /></label>
          <label>최고 주파수 (Hz)<input type="number" step="1000" min="2000" value={settings.fMax} onChange={setNum('fMax')} /></label>
          <label>재현 시드<input type="number" min="0" value={settings.seed} onChange={setNum('seed')} /></label>
        </div>
      </details>

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

      {ranked.length > 0 && (
        <div className="candidate-list">
          <div className="subsection-heading"><span>상위 후보</span><span>빠른 평가 · 정밀 확인 필요</span></div>
          {ranked.slice(0, 12).map((c, rank) => {
            const color = p.colorFor(c.id);
            return (
              <article key={c.id} className={`candidate-card ${rank === 0 ? 'best' : ''}`} onClick={() => p.onPreview(c)}>
                <header>
                  <label className="compare-toggle" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={p.selected.has(c.id)} onChange={() => p.toggleSelected(c.id)} />
                    {color && <span className="swatch" style={{ background: color }} />}</label>
                  <div><strong>후보 #{c.id}</strong><span>{c.origin === 'baseline' ? '기준 형상' : rank === 0 ? '현재 최고' : c.origin}</span></div>
                  <div className="variant-score"><span>점수</span><strong>{fmt(c.score, 2)}</strong></div>
                </header>
                <dl className="metric-grid">
                  <div><dt>레벨</dt><dd>{fmt(c.breakdown?.level ?? NaN)}</dd></div>
                  <div><dt>균일</dt><dd>{fmt(c.breakdown?.uniformity ?? NaN)}</dd></div>
                  <div><dt>평탄</dt><dd>{fmt(c.breakdown?.flatness ?? NaN)}</dd></div>
                  <div><dt>누설</dt><dd>{fmt(c.breakdown?.leakage ?? NaN)}</dd></div>
                </dl>
                <footer><button className="mini primary" onClick={(e) => { e.stopPropagation(); p.onApply(c); }} disabled={p.running}>설계에 적용</button></footer>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
