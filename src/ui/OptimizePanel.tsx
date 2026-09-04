import type { Candidate, DesignVariable, OptimizeProgress, OptimizeSettings, ParametricModel } from '../engine/optimize';
import { MODELS, SCENE_MODEL_ID } from '../engine/optimize';
import { Section, fmt } from './fields';
import { AlertIcon, PlayIcon, RefreshIcon, StopIcon } from './Icons';

interface Props {
  modelId: string;
  onModelChange: (id: string) => void;
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
  onPreview: (c: Candidate) => void;
  previewedId: number | null;
  onRefreshBase?: () => void;
  baseStale?: boolean;
  busy: boolean;
}

const OBJECTIVE_PRESETS = {
  balanced: { label: '균형 · 측면 출력과 고른 확산', band: [1000, 8000] as [number, number], weights: { level: 1, uniformity: 1, flatness: 0.5, leakage: 0.5 } },
  diffuse: { label: '넓은 확산 · 각도별 편차 최소화', band: [1000, 8000] as [number, number], weights: { level: 0.7, uniformity: 1.6, flatness: 0.5, leakage: 0.8 } },
  flat: { label: '평탄 응답 · 대역 내 변화 최소화', band: [800, 10000] as [number, number], weights: { level: 0.7, uniformity: 0.7, flatness: 1.6, leakage: 0.5 } },
};

export function OptimizePanel(p: Props) {
  const { variables, settings, progress } = p;
  const setVar = (key: string, patch: Partial<DesignVariable>) => p.setVariables(variables.map((v) => (v.key === key ? { ...v, ...patch } : v)));
  const setNum = (key: keyof OptimizeSettings) => (e: React.ChangeEvent<HTMLInputElement>) => p.setSettings({ ...settings, [key]: +e.target.value });
  const setWeight = (key: keyof OptimizeSettings['objective']['weights']) => (e: React.ChangeEvent<HTMLInputElement>) =>
    p.setSettings({ ...settings, objective: { ...settings.objective, weights: { ...settings.objective.weights, [key]: +e.target.value } } });
  const setBand = (i: 0 | 1) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const band: [number, number] = [...settings.objective.band] as [number, number];
    band[i] = +e.target.value;
    p.setSettings({ ...settings, objective: { ...settings.objective, band } });
  };

  const ranked = progress?.ranked ?? [];
  const activeCount = variables.filter((v) => v.enabled).length;
  const problems: string[] = [];
  if (!(settings.dx > 0)) problems.push('격자 간격은 양수여야 합니다.');
  if (!(settings.durationMs > 0)) problems.push('해석 시간은 양수여야 합니다.');
  if (!(settings.fMax > settings.fMin)) problems.push(`최고 주파수는 ${settings.fMin} Hz 보다 커야 합니다.`);
  if (!(settings.nSamples >= 1)) problems.push('탐색 샘플은 1 이상이어야 합니다.');
  if (!(settings.objective.band[1] > settings.objective.band[0])) problems.push('목적함수 대역의 끝이 시작보다 커야 합니다.');
  for (const v of variables) if (v.enabled && !(v.max >= v.min)) problems.push(`${v.label}: 최대가 최소보다 작습니다.`);
  const canStart = !p.busy && activeCount > 0 && problems.length === 0;
  const objectivePreset = (Object.entries(OBJECTIVE_PRESETS).find(([, preset]) =>
    preset.band[0] === settings.objective.band[0] && preset.band[1] === settings.objective.band[1]
    && Object.entries(preset.weights).every(([key, value]) => settings.objective.weights[key as keyof typeof preset.weights] === value))?.[0] ?? 'custom');

  return (
    <>
      <div className="panel-head">
        <h2>설계 탐색</h2>
        {p.running && <span className="chip accent dot">탐색 중</span>}
        <span className="spacer" />
        {p.running
          ? <button className="btn sm" onClick={p.onStop}><StopIcon />중단</button>
          : <button className="btn sm primary" onClick={p.onStart} disabled={!canStart} title={activeCount === 0 ? '변형할 항목을 하나 이상 켜세요' : problems[0]}><PlayIcon />탐색 실행</button>}
      </div>
      <div className="panel-body">
        <Section title="기준과 목표">
          <div className="prop-grid">
            <label>탐색 기준</label>
            <select className="select" value={p.modelId} onChange={(e) => p.onModelChange(e.target.value)} disabled={p.running}>
              <option value={SCENE_MODEL_ID}>현재 형상</option>
              {Object.values(MODELS).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <label>목표</label>
            <select className="select" value={objectivePreset} onChange={(e) => {
              const preset = OBJECTIVE_PRESETS[e.target.value as keyof typeof OBJECTIVE_PRESETS];
              if (preset) p.setSettings({ ...settings, objective: { ...settings.objective, band: preset.band, weights: preset.weights } });
            }}>
              <option value="custom" disabled>직접 설정한 목표</option>
              {Object.entries(OBJECTIVE_PRESETS).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}
            </select>
          </div>
          {problems.length > 0 && <div className="notice error"><AlertIcon /><span className="grow">{problems[0]}</span></div>}
          {p.onRefreshBase && p.baseStale && (
            <div className="notice warning"><AlertIcon /><span className="msg grow">편집기의 형상이 탐색 기준과 다릅니다.</span>
              <button className="btn sm" onClick={p.onRefreshBase} disabled={p.running}><RefreshIcon />갱신</button></div>
          )}
          {(progress || p.elapsedMs !== null) && (
            <div className="stack" style={{ gap: 5 }}>
              <div className="progress"><div style={{ transform: `scaleX(${progress ? progress.done / progress.total : 0})` }} /></div>
              <p className="help num">
                {progress ? `${progress.done}/${progress.total} 평가` : `${activeCount}개 변수 준비`}
                {progress?.best && ` · 최고 ${fmt(progress.best.score, 2)} (#${progress.best.id})`}
                {p.elapsedMs !== null && !p.running && ` · ${(p.elapsedMs / 1000).toFixed(1)} s`}
              </p>
            </div>
          )}
        </Section>

        <Section title="변형할 항목" meta={`${activeCount} / ${variables.length}`}>
          {variables.length === 0 && <p className="help">리플렉터·슬롯·드라이버가 있어야 설계변수가 생깁니다.</p>}
          {variables.map((v) => (
            <div key={v.key} className={`var-row ${v.enabled ? '' : 'off'}`}>
              <input className="check" type="checkbox" checked={v.enabled} onChange={(e) => setVar(v.key, { enabled: e.target.checked })} />
              <div className="name"><span title={v.label}>{v.label}</span><small>{v.unit || '배율'}</small></div>
              {v.enabled && (
                <div className="triple">
                  <label className="field"><span>최소</span><input className="input" type="number" step="0.5" value={v.min} onChange={(e) => setVar(v.key, { min: +e.target.value })} /></label>
                  <label className="field"><span>기준</span><input className="input" type="number" step="0.5" value={v.value} onChange={(e) => setVar(v.key, { value: +e.target.value })} /></label>
                  <label className="field"><span>최대</span><input className="input" type="number" step="0.5" value={v.max} onChange={(e) => setVar(v.key, { max: +e.target.value })} /></label>
                </div>
              )}
            </div>
          ))}
        </Section>

        <Section title="탐색 예산과 정밀도" meta={`${settings.nSamples + settings.nRefine}회 · dx ${settings.dx}`} open={false}>
          <div className="prop-grid">
            <label>탐색 방식</label>
            <select className="select" value={settings.explore} onChange={(e) => p.setSettings({ ...settings, explore: e.target.value as OptimizeSettings['explore'] })}>
              <option value="local">국소 · 기준 근처</option>
              <option value="global">전역 · 범위 전체</option>
            </select>
            <label>국소 폭</label><input className="input" type="number" step="0.05" min="0.02" max="1" value={settings.localSigma} onChange={setNum('localSigma')} disabled={settings.explore !== 'local'} />
            <label>탐색 샘플</label><input className="input" type="number" min="1" max="200" value={settings.nSamples} onChange={setNum('nSamples')} />
            <label>정련 평가</label><input className="input" type="number" min="0" max="400" value={settings.nRefine} onChange={setNum('nRefine')} />
            <label>격자 간격</label><div className="num-wrap"><input className="input" type="number" step="0.25" min="0.5" max="4" value={settings.dx} onChange={setNum('dx')} /><span className="unit">mm</span></div>
            <label>해석 시간</label><div className="num-wrap"><input className="input" type="number" min="2" max="40" value={settings.durationMs} onChange={setNum('durationMs')} /><span className="unit">ms</span></div>
            <label>최고 주파수</label><div className="num-wrap"><input className="input" type="number" step="1000" min="2000" value={settings.fMax} onChange={setNum('fMax')} /><span className="unit">Hz</span></div>
            <label>재현 시드</label><input className="input" type="number" min="0" value={settings.seed} onChange={setNum('seed')} />
          </div>
          <p className="help">거친 격자로 순위를 매기므로 적용 후 해석 실행으로 재확인.</p>
        </Section>

        <Section title="목적함수" meta={`${settings.objective.band[0]}-${settings.objective.band[1]} Hz`} open={false}>
          <div className="prop-grid">
            <label>대역 시작</label><div className="num-wrap"><input className="input" type="number" step="100" value={settings.objective.band[0]} onChange={setBand(0)} /><span className="unit">Hz</span></div>
            <label>대역 끝</label><div className="num-wrap"><input className="input" type="number" step="100" value={settings.objective.band[1]} onChange={setBand(1)} /><span className="unit">Hz</span></div>
            <label>측면 각도</label><div className="num-wrap"><input className="input" type="number" step="5" value={settings.objective.sideAngle} onChange={(e) => p.setSettings({ ...settings, objective: { ...settings.objective, sideAngle: +e.target.value } })} /><span className="unit">°</span></div>
            <label>w 측면 레벨</label><input className="input" type="number" step="0.1" value={settings.objective.weights.level} onChange={setWeight('level')} />
            <label>w 수평 균일</label><input className="input" type="number" step="0.1" value={settings.objective.weights.uniformity} onChange={setWeight('uniformity')} />
            <label>w 응답 평탄</label><input className="input" type="number" step="0.1" value={settings.objective.weights.flatness} onChange={setWeight('flatness')} />
            <label>w 상하 누설</label><input className="input" type="number" step="0.1" value={settings.objective.weights.leakage} onChange={setWeight('leakage')} />
          </div>
          <p className="help">점수 = w₁·측면 레벨 − w₂·수평 ±{settings.objective.spread}° 편차 − w₃·측면 응답 편차 − w₄·(상하 최대 − 측면). 높을수록 좋습니다.</p>
        </Section>

        {ranked.length > 0 && (
          <Section title="상위 후보" meta={`${Math.min(12, ranked.length)}개`}>
            {ranked.slice(0, 12).map((c, rank) => {
              const color = p.colorFor(c.id);
              return (
                <article key={c.id} className={`cand ${rank === 0 ? 'best' : ''} ${p.previewedId === c.id ? 'previewed' : ''}`} onClick={() => p.onPreview(c)} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onPreview(c); } }}>
                  <span className="compare-box" onClick={(e) => e.stopPropagation()} title="결과 도크에서 비교">
                    <input className="check" type="checkbox" checked={p.selected.has(c.id)} onChange={() => p.toggleSelected(c.id)} disabled={!c.result} />
                  </span>
                  <div className="title">{color && <span className="swatch-dot" style={{ background: color }} />}<span>#{c.id}</span><span className="sub">{c.origin === 'baseline' ? '기준 형상' : rank === 0 ? '현재 최고' : c.origin}</span></div>
                  <div className="score">{fmt(c.score, 2)}<small>점수</small></div>
                  <dl className="metrics">
                    <div><dt>레벨</dt><dd>{fmt(c.breakdown?.level)}</dd></div>
                    <div><dt>균일</dt><dd>{fmt(c.breakdown?.uniformity)}</dd></div>
                    <div><dt>평탄</dt><dd>{fmt(c.breakdown?.flatness)}</dd></div>
                    <div><dt>누설</dt><dd>{fmt(c.breakdown?.leakage)}</dd></div>
                  </dl>
                  <div className="foot"><button className="btn sm primary" onClick={(e) => { e.stopPropagation(); p.onApply(c); }} disabled={p.running}>설계에 적용</button></div>
                </article>
              );
            })}
          </Section>
        )}
      </div>
    </>
  );
}
